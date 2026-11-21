// A private headless Chromium for the browser server: started on first use with a throwaway profile, killed (and the
// profile deleted) on exit. Never touches any other Chromium.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolError } from "./mcp.ts";
import { sleep } from "./queue.ts";

/** DevToolsActivePort holds the port, then the browser's WebSocket path. undefined while it is missing or half-written. */
export function parseActivePort(text: string): { port: number; path: string } | undefined {
	const [port, path] = text.split("\n").map((s) => s.trim());
	const n = Number(port);
	if (!/^\d+$/.test(port ?? "") || n < 1 || n > 65535 || !path?.startsWith("/devtools/browser/")) return undefined;
	return { port: n, path };
}

const START_TIMEOUT_MS = 15_000;

export class Chromium {
	readonly binary: string;
	#proc?: ChildProcess;
	#dir = "";
	#url?: Promise<string>;
	#stderr = "";
	#closing = false;
	#stopping?: Promise<void>;
	/** Unexpected exits of a running browser so far, and the last one's description. */
	crashes = 0;
	lastCrash = "";
	/** A crash not yet reported to any call. */
	unreported = false;

	constructor(binary: string) {
		this.binary = binary;
	}

	/** The last stderr lines, without the D-Bus noise of a session that has no bus. */
	#tail() {
		return this.#stderr.split("\n").filter((l) => l.trim() && !/dbus|^DevTools listening/i.test(l)).slice(-8).join("\n");
	}

	/** The DevTools HTTP URL, starting Chromium if it is not running. */
	url(): Promise<string> {
		if (this.#closing) return Promise.reject(new ToolError("SHUTTING_DOWN", "the server is shutting down"));
		if (this.unreported) {
			this.unreported = false;
			return Promise.reject(new ToolError("BROWSER_DOWN", `${this.lastCrash}; its tabs are gone. Call again to start a new browser`));
		}
		this.#url ??= this.#start().catch((e) => {
			this.#url = undefined;
			throw e;
		});
		return this.#url;
	}

	async #start(): Promise<string> {
		let dir: string;
		try {
			dir = mkdtempSync(join(tmpdir(), "pi-browser-"));
		} catch (e) {
			throw new ToolError("BROWSER_DOWN", `cannot create a Chromium profile directory: ${(e as Error).message}`);
		}
		const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-startup-window", "--window-size=1280,800", "--no-first-run", "--no-default-browser-check"];
		const proc = spawn(this.binary, args, { stdio: ["ignore", "ignore", "pipe"] });
		this.#proc = proc;
		this.#dir = dir;
		this.#stderr = "";
		let ready = false;
		let ended: string | undefined;
		proc.stderr!.on("data", (d) => (this.#stderr = (this.#stderr + d).slice(-8000)));
		// Chromium's child processes can write to the profile for a moment after the browser process died: retry, never throw.
		const cleanup = (tries = 10) => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				if (tries > 1) setTimeout(() => cleanup(tries - 1), 300).unref();
			}
		};
		proc.once("error", (e) => {
			ended ??= e.message;
			if (proc.pid === undefined) cleanup(); // never started: no exit event follows
		});
		proc.once("exit", (code, signal) => {
			ended ??= signal ? `killed by ${signal}` : `exit code ${code}`;
			cleanup();
			if (this.#proc !== proc) return;
			this.#proc = undefined;
			this.#url = undefined;
			if (ready && !this.#closing) {
				this.crashes++;
				this.lastCrash = `Chromium exited unexpectedly (${ended})${this.#tail() ? `: ${this.#tail()}` : ""}`;
				this.unreported = true;
			}
		});
		const end = Date.now() + START_TIMEOUT_MS;
		while (Date.now() < end) {
			if (ended) throw new ToolError("BROWSER_DOWN", `Chromium (${this.binary}) failed to start (${ended})${this.#tail() ? `: ${this.#tail()}` : ""}`);
			let text = "";
			try {
				text = readFileSync(join(dir, "DevToolsActivePort"), "utf8");
			} catch {}
			const found = parseActivePort(text);
			if (found) {
				ready = true;
				return `http://127.0.0.1:${found.port}`;
			}
			await sleep(100);
		}
		proc.kill("SIGKILL");
		throw new ToolError("BROWSER_DOWN", `Chromium did not report a DevTools port within ${START_TIMEOUT_MS / 1000} s${this.#tail() ? `: ${this.#tail()}` : ""}`);
	}

	/** Stop Chromium for good (server exit). */
	async close() {
		this.#closing = true;
		await this.#stopping; // an idle stop in progress
		await this.stop();
	}

	/** Stop Chromium (SIGTERM, then SIGKILL), wait for it and for its profile to be deleted; url() starts a new one. */
	stop() {
		this.#stopping = this.#stop();
		return this.#stopping;
	}

	async #stop() {
		const p = this.#proc;
		const dir = this.#dir;
		// Forgotten first, so its exit is not taken for a crash.
		this.#proc = undefined;
		this.#url = undefined;
		if (p && p.exitCode === null && p.signalCode === null) {
			const exited = new Promise((r) => p.once("exit", r));
			p.kill("SIGTERM");
			if (!(await Promise.race([exited.then(() => true), sleep(3000).then(() => false)]))) {
				p.kill("SIGKILL");
				await Promise.race([exited, sleep(1000)]);
			}
		}
		for (let i = 0; i < 15 && dir && existsSync(dir); i++) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
			await sleep(200);
		}
	}

	/** Last resort on process exit (nothing can be awaited): kill and delete without waiting for the exit. */
	killNow() {
		if (!this.#proc) return;
		this.#proc.kill("SIGKILL");
		try {
			rmSync(this.#dir, { recursive: true, force: true });
		} catch {}
	}
}
