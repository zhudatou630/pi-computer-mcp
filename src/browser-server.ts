// pi-browser MCP server: a private headless Chromium for development checks. Needs no X or D-Bus; run it as a normal
// user so Chromium keeps its sandbox: `sudo -n -u pi-desktop node src/browser-server.ts`.
import { Browser } from "./cdp.ts";
import { Chromium } from "./chromium.ts";
import { ConsoleCollector } from "./console.ts";
import { createServer, serveStdio, type Tool, ToolError } from "./mcp.ts";
import { InputQueue, sleep } from "./queue.ts";
import type { PageCtx } from "./tools/base.ts";
import { browserTools } from "./tools/browser.ts";
import { pageTools } from "./tools/page.ts";
import { pageWaitTool } from "./tools/wait-page.ts";

const gen = Date.now().toString(36).slice(-4);
const chromium = new Chromium(process.env.PI_BROWSER_CHROMIUM ?? "/usr/bin/chromium");
const collector = new ConsoleCollector();
const ctx: PageCtx = {
	gen,
	browser: new Browser(() => chromium.url(), gen, {
		event: (method, params, sessionId) => collector.event(method, params, sessionId),
		// Only this server turns these domains on: Network in particular costs the shared Chromium memory and time.
		async attached(tab) {
			collector.watch(tab.sessionId, tab.targetId);
			await Promise.all([tab.send("Runtime.enable"), tab.send("Log.enable"), tab.send("Network.enable")]);
		},
	}),
	pageCaptures: new Map(),
	queue: new InputQueue(),
};

const TABS_DOC =
	"Tabs of this server's own headless Chromium (nobody else uses it). list: its pages; popups a page opened show as [other]: attach to use them. open(url?): a new tab. close(tab): close a tab you opened. attach(tab) / detach(tab): start / stop using a page you did not open. Everything closes when this server exits.";

/** A call that Chromium crashed during says so, instead of a bare "connection closed" or a timed-out result. */
function guard(t: Tool): Tool {
	return {
		...t,
		...(t.name === "tabs" ? { description: TABS_DOC } : {}),
		async run(args, signal) {
			const crashes = chromium.crashes;
			const crashed = () => {
				chromium.unreported = false;
				return new ToolError("BROWSER_DOWN", `${chromium.lastCrash}; its tabs are gone. Call again to start a new browser`, { outcome: t.kind === "action" ? "unknown" : "refused" });
			};
			let result;
			try {
				result = await t.run(args, signal);
			} catch (e) {
				// The CDP socket can close a moment before the child's exit event arrives.
				if (!(e instanceof ToolError)) await sleep(300);
				if (chromium.crashes !== crashes) throw crashed();
				throw e;
			}
			if (chromium.crashes !== crashes && t.name !== "console") throw crashed();
			return result;
		},
	};
}

const instructions = `A private headless Chromium for development checks: localhost and other local front-ends, reproducing bugs, JS-rendered public pages. It starts on the first call that needs it (a few seconds) with a fresh, empty profile (no logins or cookies; deleted on exit), and nobody can see it.

Use the computer server instead (mcp__computer__) when the page needs the person's login, when the person should see the page or take over, or for desktop apps: its Chromium is shared, logged in and visible in VNC.

Tools:
- tabs / page_observe / page_act / page_eval / page_screenshot: pages in your tabs (refs p…), as in computer.
- console: console output, uncaught exceptions, browser log entries and failed requests (HTTP status >= 400 included) per tab, since the tab was opened; since=cursor returns only newer entries.
- viewport: emulate width/height/deviceScaleFactor/mobile/userAgent for a tab; reset=true undoes it.
- wait: time or page conditions (scripts have no timers).

Contract:
- Results: data in structuredContent; content[0] is a short text, content[1] the image (show it with image(r.content[1])). Check r.isError: failures resolve with structuredContent {outcome, code, message}. Arguments that break a tool's schema (unknown or missing fields) make the call throw instead.
- outcome: delivered (sent, effect not implied), refused (the action was not sent: STALE_REF, CAPTURE_STALE, OCCLUDED, AMBIGUOUS, NOT_FOUND, …), unknown (may have been sent: look before retrying). verified appears only when the effect was checked.
- page_act navigate/back/forward/reload wait for the page to load (loaded); other actions do not wait for their effects: follow them with wait, page_observe or console.
- BROWSER_DOWN: Chromium failed to start or crashed; a crash loses every tab, and the next call starts a new browser.
- Refs and captureIds belong to this server process; keep them across scripts with store(). Close tabs you are done with (tabs op=close).

Example (codemode):
const b = "mcp__browser__";
const t = await tools[b+"tabs"]({ op: "open", url: "http://127.0.0.1:5173/" });
if (t.isError) return t.structuredContent;
const tab = t.structuredContent.tab.tab;
const f = await tools[b+"page_act"]({ tab, op: "fill", selector: "#name", text: "Ada" });
if (f.isError) return f.structuredContent;
await tools[b+"page_act"]({ tab, op: "click", selector: "button[type=submit]" });
await tools[b+"wait"]({ condition: "page", tab, text: "Saved", timeoutMs: 5000 });
const c = await tools[b+"console"]({ tab, errorsOnly: true });
const s = await tools[b+"page_screenshot"]({ tab });
if (!s.isError) image(s.content[1]);
return c.structuredContent;`;

const tools = [...pageTools(ctx), browserTools(ctx, collector.log), pageWaitTool(ctx)].flat().map(guard);
const server = createServer({ name: "pi-browser", version: "0.4.0", instructions, tools });

let closing = false;
async function shutdown() {
	if (closing) return;
	closing = true;
	server.stop();
	await Promise.race([ctx.queue.idle(), sleep(1500)]);
	await chromium.close();
	process.exit(0);
}

process.on("exit", () => chromium.killNow());
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
serveStdio(server, shutdown);
