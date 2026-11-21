import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { Tab } from "../src/cdp.ts";
import { Chromium, parseActivePort } from "../src/chromium.ts";
import { ConsoleCollector, ConsoleLog } from "../src/console.ts";
import { isNetworkIdle, pageWaitTool } from "../src/tools/wait-page.ts";
import { waitTool } from "../src/tools/wait.ts";

test("parseActivePort reads port and path, and waits for a complete file", () => {
	assert.deepEqual(parseActivePort("41055\n/devtools/browser/d18e-77\n"), { port: 41055, path: "/devtools/browser/d18e-77" });
	assert.equal(parseActivePort(""), undefined);
	assert.equal(parseActivePort("41055"), undefined); // half-written
	assert.equal(parseActivePort("41055\n"), undefined);
	assert.equal(parseActivePort("0\n/devtools/browser/x"), undefined);
	assert.equal(parseActivePort("70000\n/devtools/browser/x"), undefined);
	assert.equal(parseActivePort("12ab\n/devtools/browser/x"), undefined);
});

test("console log keeps the last entries per tab, with a cursor, a missed flag and clear", () => {
	const log = new ConsoleLog(3);
	const e = (text: string, level = "log") => ({ source: "console" as const, level, text });
	log.add("x", e("ignored: not watched"));
	assert.equal(log.read("x"), undefined);
	log.watch("a");
	log.watch("b");
	for (let i = 1; i <= 5; i++) log.add("a", e(`a${i}`, i === 4 ? "error" : "log"));
	log.add("b", e("b1"));
	const all = log.read("a")!;
	assert.deepEqual(all.entries.map((x) => x.text), ["a3", "a4", "a5"]);
	assert.equal(all.cursor, 6); // one sequence across tabs
	assert.equal(all.missed, true); // a1, a2 dropped
	assert.equal(log.read("a", { since: 2 })!.missed, false);
	assert.deepEqual(log.read("a", { since: 4 })!.entries.map((x) => x.text), ["a5"]);
	assert.deepEqual(log.read("a", { errorsOnly: true })!.entries.map((x) => x.text), ["a4"]);
	assert.equal(log.read("a", { since: 6 })!.entries.length, 0);
	assert.equal(log.read("a", { clear: true })!.entries.length, 3);
	assert.equal(log.read("a")!.entries.length, 0);
	assert.deepEqual(log.read("b")!.entries.map((x) => x.text), ["b1"]);
	log.add("a", e("x".repeat(5000)));
	assert.equal(log.read("a")!.entries[0].text.length, 2000);
});

test("console collector turns CDP events of watched sessions into entries", () => {
	const c = new ConsoleCollector();
	c.watch("s1", "T1");
	const frame = { url: "http://h/app.js", lineNumber: 9 };
	c.event("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "bad" }, { type: "number", value: 42 }, { type: "object", subtype: "array", description: "Array(2)", preview: { properties: [{ value: "1" }, { value: "2" }] } }], stackTrace: { callFrames: [frame] } }, "s1");
	c.event("Runtime.consoleAPICalled", { type: "warning", args: [{ type: "object", description: "Object", preview: { properties: [{ name: "n", value: "Ada" }] } }] }, "s1");
	c.event("Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", url: "http://h/app.js", lineNumber: 0, exception: { description: "Error: boom\n    at f" } } }, "s1");
	c.event("Log.entryAdded", { entry: { source: "network", level: "error", text: "Failed to load resource: the server responded with a status of 404" } }, "s1");
	c.event("Log.entryAdded", { entry: { source: "network", level: "error", text: "WebSocket connection to 'ws://h/hmr' failed: 404" } }, "s1");
	c.event("Log.entryAdded", { entry: { source: "deprecation", level: "warning", text: "old API" } }, "s1");
	c.event("Network.requestWillBeSent", { requestId: "r1", request: { url: "http://h/api", method: "POST" } }, "s1");
	c.event("Network.responseReceived", { requestId: "r1", type: "Fetch", response: { url: "http://h/api", status: 500, statusText: "Internal Server Error" } }, "s1");
	c.event("Network.requestWillBeSent", { requestId: "r2", request: { url: "http://h/ok.css", method: "GET" } }, "s1");
	c.event("Network.responseReceived", { requestId: "r2", type: "Stylesheet", response: { url: "http://h/ok.css", status: 200, statusText: "OK" } }, "s1");
	c.event("Network.requestWillBeSent", { requestId: "r3", request: { url: "http://nowhere/x.js", method: "GET" } }, "s1");
	c.event("Network.loadingFailed", { requestId: "r3", type: "Script", errorText: "net::ERR_NAME_NOT_RESOLVED" }, "s1");
	c.event("Network.loadingFailed", { requestId: "r4", type: "Document", errorText: "net::ERR_ABORTED", canceled: true }, "s1");
	c.event("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "other session" }] }, "s2");
	const got = c.log.read("T1")!.entries.map(({ source, level, text, url, line, status }) => ({ source, level, text, url, line, status }));
	const strip = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
	assert.deepEqual(got.map(strip), [
		{ source: "console", level: "error", text: "bad 42 Array(2) [1, 2]", url: "http://h/app.js", line: 10 },
		{ source: "console", level: "warning", text: "Object {n: Ada}" },
		{ source: "exception", level: "error", text: "Error: boom\n    at f", url: "http://h/app.js", line: 1 },
		{ source: "log", level: "error", text: "WebSocket connection to 'ws://h/hmr' failed: 404" },
		{ source: "log", level: "warning", text: "old API" },
		{ source: "network", level: "error", text: "500 Internal Server Error POST http://h/api (Fetch)", url: "http://h/api", status: 500 },
		{ source: "network", level: "error", text: "net::ERR_NAME_NOT_RESOLVED GET http://nowhere/x.js (Script)", url: "http://nowhere/x.js" },
		{ source: "network", level: "warning", text: "net::ERR_ABORTED request r4 (Document)" },
	]);
});

const fakeBrowser = (state: object) => ({ tab: async () => ({ eval: async () => state }) }) as any;
const noSignal = new AbortController().signal;

test("computer wait keeps its contract after the page part moved out", async () => {
	const t = waitTool({ browser: fakeBrowser({}) } as any);
	const { name, kind, description, inputSchema, outputSchema } = t;
	// Hash of the computer wait tool as published before the split; change it only with a deliberate contract change.
	const hash = createHash("sha256").update(JSON.stringify([{ name, kind, description, inputSchema, outputSchema }])).digest("hex");
	assert.equal(hash, "e8ef5a23084212fe4dc941843abbcd94c4c8e8a8714bf68540521ba9dd4cafe4");
	const r = await waitTool({ browser: fakeBrowser({ url: "http://h/done", ready: "complete", selector: true, text: true }) } as any).run({ condition: "page", tab: "T", text: "ok", url: "done" }, noSignal);
	assert.deepEqual(r.structuredContent, { matched: true, elapsedMs: r.structuredContent!.elapsedMs, result: { url: "http://h/done", ready: "complete" } });
	await assert.rejects(t.run({ condition: "nope" }, noSignal), /unknown condition/);
});

test("browser wait offers only time and page", async () => {
	const t = pageWaitTool({ browser: fakeBrowser({ url: "http://h/", ready: "loading", selector: false, text: null }) }, () => undefined);
	assert.deepEqual((t.inputSchema as any).properties.condition.enum, ["time", "page"]);
	await assert.rejects(t.run({ condition: "window", title: "x" }, noSignal), /unknown condition window/);
	await assert.rejects(t.run({ condition: "page", tab: "T" }, noSignal), /need text, selector, url or load/);
	const gone = await t.run({ condition: "page", tab: "T", selector: "#spinner", gone: true }, noSignal);
	assert.equal(gone.structuredContent!.matched, true);
	const late = await t.run({ condition: "page", tab: "T", load: true, timeoutMs: 0 }, noSignal);
	assert.equal(late.structuredContent!.matched, false);
	assert.equal((await t.run({ condition: "time", ms: 1 }, noSignal)).structuredContent!.matched, true);
});

test("network idle: nothing in flight and quiet since the last request and the wait's start", () => {
	assert.equal(isNetworkIdle({ inflight: 1, last: 0 }, 0, 10_000), false);
	assert.equal(isNetworkIdle({ inflight: 0, last: 0 }, 0, 499), false);
	assert.equal(isNetworkIdle({ inflight: 0, last: 0 }, 0, 500), true);
	assert.equal(isNetworkIdle({ inflight: 0, last: 0 }, 9_800, 10_000), false); // the wait just started
	assert.equal(isNetworkIdle({ inflight: 0, last: 9_800 }, 0, 10_000), false); // a request just ended
});

test("the collector counts requests in flight per tab", () => {
	const c = new ConsoleCollector();
	assert.equal(c.network("T1"), undefined);
	c.watch("s1", "T1");
	c.watch("s2", "T2");
	const req = (s: string, id: string) => c.event("Network.requestWillBeSent", { requestId: id, request: { url: "http://h/" + id, method: "GET" } }, s);
	req("s1", "a");
	req("s1", "b");
	req("s2", "a");
	assert.equal(c.network("T1")!.inflight, 2);
	c.event("Network.loadingFinished", { requestId: "a" }, "s1");
	c.event("Network.loadingFailed", { requestId: "b", type: "Fetch", errorText: "net::ERR_FAILED" }, "s1");
	assert.equal(c.network("T1")!.inflight, 0);
	assert.equal(c.network("T2")!.inflight, 1);
});

test("browser wait: networkIdle needs a watched tab and a quiet network", async () => {
	const nets: Record<string, { inflight: number; last: number }> = { busy: { inflight: 1, last: 0 }, quiet: { inflight: 0, last: 0 } };
	const t = pageWaitTool({ browser: fakeBrowser({ url: "http://h/", ready: "complete", selector: true, text: true }) }, (tab) => nets[tab]);
	assert.ok((t.inputSchema as any).properties.networkIdle);
	await assert.rejects(t.run({ condition: "page", tab: "nope", networkIdle: true }, noSignal), (e: any) => e.code === "NOT_ATTACHED");
	const busy = await t.run({ condition: "page", tab: "busy", networkIdle: true, timeoutMs: 700 }, noSignal);
	assert.deepEqual(busy.structuredContent!.result, { inflight: 1 });
	assert.equal(busy.structuredContent!.matched, false);
	const quiet = await t.run({ condition: "page", tab: "quiet", networkIdle: true, text: "ok", timeoutMs: 2000 }, noSignal);
	assert.equal(quiet.structuredContent!.matched, true);
	assert.ok((quiet.structuredContent!.elapsedMs as number) >= 500);
});

test("launcher: lazy start, stop is not a crash, a crash is reported once, profiles are deleted", async () => {
	// A stand-in for Chromium: writes DevToolsActivePort into its --user-data-dir and lives on.
	const bin = mkdtempSync(resolve(tmpdir(), "fake-chromium-"));
	const exe = resolve(bin, "chromium");
	writeFileSync(exe, '#!/bin/sh\nfor a in "$@"; do case "$a" in --user-data-dir=*) d="${a#--user-data-dir=}";; esac; done\necho $$ > "$(dirname "$0")/pid"\nprintf "9222\\n/devtools/browser/x\\n" > "$d/DevToolsActivePort"\nexec sleep 30\n');
	chmodSync(exe, 0o755);
	const profiles = () => readdirSync(tmpdir()).filter((f) => f.startsWith("pi-browser-")).length;
	const before = profiles();
	const c = new Chromium(exe);
	try {
		assert.equal(await c.url(), "http://127.0.0.1:9222");
		assert.equal(await c.url(), "http://127.0.0.1:9222"); // the same browser
		assert.equal(profiles(), before + 1);
		await c.stop();
		assert.equal(profiles(), before);
		assert.equal(c.crashes, 0);
		await c.url(); // started again
		process.kill(Number(readFileSync(resolve(bin, "pid"), "utf8")), "SIGKILL");
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(c.crashes, 1);
		await assert.rejects(c.url(), (e: any) => e.code === "BROWSER_DOWN" && /killed by SIGKILL/.test(e.message));
		await c.url(); // reported once: the next call starts a new one
		await c.close();
		await assert.rejects(c.url(), (e: any) => e.code === "SHUTTING_DOWN");
		assert.equal(profiles(), before);
	} finally {
		c.killNow();
		rmSync(bin, { recursive: true, force: true });
	}
	assert.equal(existsSync(bin), false);
});

test("a load wait ends at once when the CDP connection is gone, instead of timing out", async () => {
	const tab = new Tab({ closed: true, send: () => Promise.reject(new Error("CDP connection closed")) } as any, "t", "s", true);
	const start = Date.now();
	await assert.rejects(tab.waitFor(() => true, 5_000), /connection closed/);
	assert.ok(Date.now() - start < 1000);
});

test("the browser server never loads the desktop modules", () => {
	const seen = new Set<string>();
	const visit = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		for (const [, spec] of readFileSync(file, "utf8").matchAll(/^(?:import|export) [^;]*? from "(\.[^"]+)";/gm)) visit(resolve(dirname(file), spec));
	};
	visit(resolve(import.meta.dirname, "../src/browser-server.ts"));
	const desktop = [...seen].filter((f) => /\/(atspi|x11|capture)\.ts$/.test(f));
	assert.deepEqual(desktop, []);
	assert.ok(seen.size > 5);
});
