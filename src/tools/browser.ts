// Tools only the browser server has: console/error log and viewport emulation of its own headless Chromium.
import type { ConsoleLog } from "../console.ts";
import { dropEmpty, ok, ToolError, type Tool } from "../mcp.ts";
import { arr, bool, int, num, obj, out, type PageCtx, receipt, str } from "./base.ts";

const tabParam = str("Tab id from tabs");

export function browserTools(ctx: PageCtx, log: ConsoleLog): Tool[] {
	return [
		{
			name: "console",
			kind: "read",
			description: `A tab's console output, uncaught exceptions, browser log entries (deprecations, CSP, …) and failed requests (network errors and HTTP status >= 400), collected since the tab was opened or attached; the last ${log.max} per tab are kept. Pass since = the previous result's cursor to get only newer entries (missed=true: some of those were dropped by the limit). errorsOnly keeps level "error". clear empties the tab's buffer after this read.`,
			inputSchema: obj({ tab: tabParam, since: int("cursor from an earlier console result", { minimum: 0 }), errorsOnly: bool(), clear: bool() }, ["tab"]),
			outputSchema: out(
				{
					entries: arr(out({ seq: int(), time: int("ms since epoch"), source: str("console | exception | log | network"), level: str("error, warning, info, log, debug, …"), text: str(), url: str(), line: int(), status: int() })),
					cursor: int("pass as since next time"),
					missed: bool(),
				},
				["entries", "cursor", "missed"],
			),
			async run(raw) {
				const a = raw as { tab: string; since?: number; errorsOnly?: boolean; clear?: boolean };
				const r = log.read(a.tab, a);
				if (!r) throw new ToolError("NOT_ATTACHED", `no console is collected for tab ${a.tab}; open it (or attach to it) with tabs first`);
				const lines = r.entries.map((e) => `#${e.seq} ${e.level} [${e.source}] ${e.text.slice(0, 500)}${e.url && e.source !== "network" ? ` (${e.url}${e.line ? `:${e.line}` : ""})` : ""}`);
				const head = `${r.entries.length} entries${r.missed ? " (older ones were dropped)" : ""}, cursor ${r.cursor}`;
				return ok(r, [head, ...lines].join("\n").slice(0, 20_000));
			},
		},
		{
			name: "viewport",
			kind: "action",
			description: "Emulate a screen size for a tab: width, height (CSS px), deviceScaleFactor (default 1), mobile (default false: mobile also means a meta-viewport layout and overlay scrollbars), userAgent (optional). Stays in effect for the tab, across navigations; reset=true restores the default. Earlier page_screenshot captureIds stop working.",
			inputSchema: obj({ tab: tabParam, width: int(undefined, { minimum: 1, maximum: 10000 }), height: int(undefined, { minimum: 1, maximum: 10000 }), deviceScaleFactor: num(undefined, { minimum: 0.1, maximum: 5 }), mobile: bool(), userAgent: str(), reset: bool() }, ["tab"]),
			outputSchema: receipt({ viewport: out({ width: int(), height: int() }, ["width", "height"]), devicePixelRatio: num(), userAgent: str() }),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const a = dropEmpty(raw, ["userAgent"]) as { tab: string; width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean; userAgent?: string; reset?: boolean };
					if (!a.reset && (!a.width || !a.height)) throw new ToolError("BAD_ARGS", "give width and height, or reset=true");
					const tab = await ctx.browser.tab(a.tab);
					for (const [id, c] of ctx.pageCaptures) if (c.targetId === tab.targetId) ctx.pageCaptures.delete(id);
					if (a.reset) {
						await tab.send("Emulation.clearDeviceMetricsOverride");
						await tab.send("Emulation.setUserAgentOverride", { userAgent: "" });
					} else {
						await tab.send("Emulation.setDeviceMetricsOverride", { width: a.width, height: a.height, deviceScaleFactor: a.deviceScaleFactor ?? 1, mobile: a.mobile ?? false });
						if (a.userAgent) await tab.send("Emulation.setUserAgentOverride", { userAgent: a.userAgent });
					}
					const now = (await tab.eval("({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio, ua: navigator.userAgent })")) as { width: number; height: number; dpr: number; ua: string };
					const data = { outcome: "delivered", route: "cdp-page", viewport: { width: now.width, height: now.height }, devicePixelRatio: now.dpr, userAgent: now.ua };
					return ok(data, `page sees ${now.width}x${now.height} @${now.dpr}x${a.reset ? " (reset)" : ""}; UA ${now.ua}`);
				}),
		},
	];
}
