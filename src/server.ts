// The pi-desktop computer as MCP tools: look, act, windows, launch. Must run as the desktop user inside its session
// (DISPLAY, D-Bus session bus), e.g. `sudo -u pi-desktop pi-desktop-session-exec node src/server.ts`.
import { spawn } from "node:child_process";
import { Desktop } from "./computer/atspi.ts";
import { Browser, type Tab } from "./computer/cdp.ts";
import { diffTree, formatTree } from "./computer/tree.ts";
import { createServer, dropEmpty, serveStdio, type Content, type Tool, type ToolResult } from "./mcp.ts";

const CDP_URL = process.env.PI_COMPUTER_CDP_URL ?? "http://127.0.0.1:9222";
const DISPLAY = process.env.DISPLAY ?? ":6";
const MAX_EVAL_CHARS = 8000;
const OWNER = `mcp-${process.pid}`;

const out = (text: string, image?: string): ToolResult => ({
	content: [{ type: "text", text } as Content, ...(image ? [{ type: "image", data: image, mimeType: "image/jpeg" } as Content] : [])],
});

const str = (v: unknown, what: string): string => {
	if (typeof v !== "string" || v === "") throw new Error(`${what} is required`);
	return v;
};

const browser = new Browser(CDP_URL);
const desktop = new Desktop(DISPLAY);
const lastTree = new Map<string, string[]>(); // target -> last formatted tree, for diffs
// shortcut: the tab lives as long as this process (one per client session); an orphan tab is left behind only on a crash.
let tabId: string | undefined;
const tab = (): Promise<Tab> => browser.tab(OWNER, tabId, (id) => (tabId = id));

async function webTree(t: Tab, query?: string) {
	const { url, title } = await t.info();
	const lines = formatTree(await t.snapshot(), { query });
	if (!query) lastTree.set("web", lines);
	return { header: `${title} — ${url}`, lines };
}

async function appTree(app: string, remember: boolean, query?: string) {
	const { nodes, truncated } = await desktop.snapshot(app);
	const lines = formatTree(nodes, { query });
	if (truncated) lines.push("… tree truncated (too many nodes); use query or a screenshot");
	if (!query && remember) lastTree.set(app, lines);
	return lines;
}

// One pointer, one keyboard, one tab: acts run one at a time, in the order they arrive.
let actQueue: Promise<unknown> = Promise.resolve();
const sequential = <T,>(fn: () => Promise<T>): Promise<T> => {
	const next = actQueue.then(fn, fn);
	actQueue = next.catch(() => {});
	return next;
};

const target = { type: "string", description: `"web" for your browser tab, an app name (e.g. "thunar") for a desktop app, or "screen"` };

const look: Tool = {
	name: "look",
	description: "See a target as a compact UI tree with refs: your browser tab (\"web\"), a desktop app by name, or \"screen\" (screenshot + window list). Tree lines are `ref role \"name\" =value @x,y wxh [flags]`.",
	inputSchema: {
		type: "object",
		properties: {
			target,
			query: { type: "string", description: "Only lines containing this text" },
			screenshot: { type: "boolean", description: "Also attach a screenshot (expensive; ~1.5k tokens)" },
		},
		required: ["target"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: true },
	async run(raw) {
		const args = dropEmpty(raw, ["query"]);
		const name = str(args.target, "target");
		const query = args.query as string | undefined;
		if (name === "screen") {
			const windows = await desktop.windows().catch((e) => [{ app: "?", title: e.message, ref: "" }]);
			return out(`windows:\n${windows.map((w) => `${w.ref} ${w.app}: ${w.title}`).join("\n")}`, await desktop.screenshot());
		}
		if (name === "web") {
			const t = await tab();
			const { header, lines } = await webTree(t, query);
			return out(`${header}\n${lines.join("\n")}`, args.screenshot ? await t.screenshot() : undefined);
		}
		const lines = await appTree(name, true, query);
		return out(lines.join("\n"), args.screenshot ? await desktop.screenshot() : undefined);
	},
};

const act: Tool = {
	name: "act",
	description: [
		"Do one thing on a target and get back what changed.",
		"web: navigate(text=url) | click(ref) | set(ref,text) replaces a field's text | key(text=Enter/Tab/Escape/…) | eval(text=JS expression, returns JSON) | close (closes your tab).",
		"app: click(ref, or x,y) | set(ref,text) | key(text=xdotool keys, e.g. F2, ctrl+s, Return) | type(text, ASCII only; use set for other text) | close (closes its newest window).",
	].join("\n"),
	inputSchema: {
		type: "object",
		properties: {
			target,
			op: { type: "string", enum: ["navigate", "click", "set", "key", "type", "eval", "close"] },
			ref: { type: "string" },
			text: { type: "string" },
			x: { type: "number" },
			y: { type: "number" },
		},
		required: ["target", "op"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: true },
	run: (raw, signal) =>
		sequential(async () => {
			signal.throwIfAborted(); // cancelled while queued: do nothing
			// `text` is not cleaned: "" is a real value for set (clear the field).
			const args = dropEmpty(raw, ["ref"]);
			const name = str(args.target, "target");
			const op = str(args.op, "op");
			const ref = args.ref as string | undefined;
			const text = args.text as string | undefined;
			let x = args.x as number | undefined;
			let y = args.y as number | undefined;
			// A ref wins over coordinates, and 0,0 is a placeholder, not a click in the screen corner.
			if (ref !== undefined || (x === 0 && y === 0)) x = y = undefined;
			const need = <T,>(v: T | undefined, what: string): T => {
				if (v === undefined || v === "") throw new Error(`op ${op} needs ${what}`);
				return v;
			};

			if (name === "web") {
				if (op === "close") {
					await browser.closeTab(OWNER, tabId);
					tabId = undefined;
					lastTree.delete("web");
					return out("Closed your tab.");
				}
				const t = await tab();
				if (op === "eval") {
					const value = JSON.stringify(await t.eval(need(text, "text (a JS expression)"))) ?? "undefined";
					return out(value.length > MAX_EVAL_CHARS ? `${value.slice(0, MAX_EVAL_CHARS)}… (${value.length} chars, truncated)` : value);
				}
				if (op === "navigate") await t.navigate(need(text, "text (a URL)"));
				else if (op === "click") await t.click(need(ref, "ref"));
				else if (op === "set") await t.setText(need(ref, "ref"), text ?? "");
				else if (op === "key") await t.key(need(text, "text (a key name)"));
				else throw new Error(`op ${op} is not supported on web`);
				const before = op === "navigate" ? undefined : lastTree.get("web");
				const { header, lines } = await webTree(t);
				return out(`${header}\n${diffTree(before, lines)}`);
			}

			if (name === "screen") throw new Error(`act on "screen" is not supported; act on an app by name (click accepts x,y)`);
			// The lock covers acting, settling and reading back, so nothing moves focus in between.
			const { how, lines } = await desktop.exclusive(async () => {
				signal.throwIfAborted();
				const how = await (async () => {
					if (op === "click") {
						await desktop.activate(name).catch(() => {}); // a pointer click lands on whatever window is on top
						if (x !== undefined && y !== undefined) {
							await desktop.xdotool("mousemove", String(Math.round(x)), String(Math.round(y)), "click", "1");
							return "clicked at point";
						}
						return `clicked (${await desktop.click(need(ref, "ref or x,y"))})`;
					}
					if (op === "close") {
						await desktop.closeWindow(name);
						return "window closed";
					}
					if (op === "set") return `text is now ${JSON.stringify(await desktop.setText(need(ref, "ref"), text ?? ""))}`;
					if (op === "key" || op === "type") {
						await desktop.activate(name);
						if (ref) await desktop.focus(ref);
						if (op === "key") await desktop.xdotool("key", "--clearmodifiers", ...need(text, "text").split(/\s+/));
						else await desktop.xdotool("type", "--delay", "20", need(text, "text"));
						return op === "key" ? "keys sent" : "typed";
					}
					throw new Error(`op ${op} is not supported on desktop apps`);
				})();
				await new Promise((r) => setTimeout(r, 400)); // let the UI settle
				const lines = await appTree(name, false).catch((e) => [`(could not read the app after acting: ${e.message})`]);
				return { how, lines };
			});
			const before = lastTree.get(name);
			lastTree.set(name, lines);
			return out(`${how}\n${diffTree(before, lines)}`);
		}),
};

const windows: Tool = {
	name: "windows",
	description: "List desktop windows and dialogs (app, title, ref) and which one is active.",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
	annotations: { readOnlyHint: true },
	async run() {
		const list = await desktop.windows();
		const active = await desktop.xdotool("getactivewindow", "getwindowname").then((r) => r.stdout.trim(), () => "?");
		return out(`active: ${active}\n${list.map((w) => `${w.ref} ${w.app}: ${w.title}`).join("\n")}`);
	},
};

const launch: Tool = {
	name: "launch",
	description: "Start a GUI app on the desktop as the desktop user, detached (e.g. command \"thunar\", args [\"/tmp\"]). Then look at it by name; it may take a second to appear.",
	inputSchema: {
		type: "object",
		properties: {
			command: { type: "string", description: "Executable name or path" },
			args: { type: "array", items: { type: "string" } },
		},
		required: ["command"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false },
	async run(raw) {
		const args = dropEmpty(raw, ["args"]);
		const command = str(args.command, "command");
		const argv = (args.args as string[] | undefined) ?? [];
		const child = spawn(command, argv, { detached: true, stdio: "ignore" });
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", (e) => reject(new Error(`could not start ${command}: ${e.message}`)));
		});
		child.unref();
		return out(`started ${command} (pid ${child.pid}); close its windows with act op=close when done`);
	},
};

const instructions = [
	`A Linux desktop (X display ${DISPLAY}, XFCE) with a shared, logged-in Chromium; the person can watch and take over in VNC.`,
	`Cheapest first: look at "web" (your own browser tab) or a desktop app by name; screenshots (look screenshot=true or target "screen") only when the tree cannot show what you need.`,
	`Start GUI apps with launch, not bash: bash runs as another user, so its windows are invisible to these tools. Refs (w…/d…) come from look; act on them.`,
	`To read data from a page, prefer act op=eval with a small JS expression that returns just what you need.`,
	`If a site needs a login, password, 2FA or CAPTCHA: stop and ask the person to do it in the shared browser. Never type passwords.`,
	`The browser is shared: use only your own tab and close it when done (act web op=close); close the windows you opened (act <app> op=close). Never kill processes you did not start.`,
].join("\n");

const server = createServer({ name: "pi-computer", version: "0.1.0", instructions, tools: [look, act, windows, launch] });

let closing = false;
async function shutdown() {
	if (closing) return;
	closing = true;
	await Promise.race([browser.closeTab(OWNER, tabId), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
	browser.close();
	desktop.close();
	process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
serveStdio(server, shutdown);
