// pi-computer MCP server: the pi-desktop computer as tools for codemode scripts. Must run as the desktop user inside
// its session (DISPLAY, D-Bus session bus): `sudo -u pi-desktop pi-desktop-session-exec node src/server.ts`.
import { Atspi } from "./atspi.ts";
import { Captures } from "./capture.ts";
import { Browser } from "./cdp.ts";
import { createServer, serveStdio } from "./mcp.ts";
import { InputQueue } from "./queue.ts";
import type { Ctx } from "./tools/common.ts";
import { desktopTools } from "./tools/desktop.ts";
import { inputTools } from "./tools/input.ts";
import { pageTools } from "./tools/page.ts";
import { waitTool } from "./tools/wait.ts";

// Every ref and capture id carries this, so ids from an earlier server process are refused instead of misread.
const gen = Date.now().toString(36).slice(-4);
const ctx: Ctx = {
	gen,
	atspi: new Atspi(gen),
	browser: new Browser(process.env.PI_COMPUTER_CDP_URL ?? "http://127.0.0.1:9222", gen),
	captures: new Captures(gen),
	pageCaptures: new Map(),
	queue: new InputQueue(),
};

const instructions = `The pi-desktop computer: an XFCE desktop on X display ${process.env.DISPLAY ?? ":6"} (the person may watch or take over in VNC; the screen size can change) and a shared, logged-in Chromium.

Layers (pick per task; nothing falls back silently):
- windows / window / launch: X windows by id ("0x…"). Start GUI apps with launch, never bash (bash is another user; its windows are invisible here).
- observe / inspect / invoke / set_text: accessibility (AT-SPI) elements by ref (a…). Exact and cheap; works for GTK/Qt apps started after AT-SPI. Electron apps and the XFCE panel have no tree: use pixels.
- screenshot / click / move / drag / scroll / key / hold / type: pixels and physical input, at a ref, a screenshot point (captureId + image x,y) or a screen point.
- tabs / page_observe / page_act / page_eval / page_screenshot: pages in your own tab via CDP (refs p…). The browser's address bar and dialogs are desktop windows.
- wait: the only way to wait (scripts have no timers): time, window, element, page conditions.

Contract:
- Results: data in structuredContent; content[0] is a short text, content[1] the image (show it with image(r.content[1])). Check r.isError: failures resolve with structuredContent {outcome, code, message}. Arguments that break a tool's schema (unknown or missing fields) make the call throw instead.
- outcome: delivered (sent, effect not implied), refused (the action was not sent: STALE_REF, CAPTURE_STALE, FOCUS_CHANGED, POINTER_ELSEWHERE, OCCLUDED, NOT_ASCII, AMBIGUOUS, APP_BUSY, …; the window check may have moved the pointer), unknown (may have been sent: look before retrying). verified appears only when the effect was checked.
- Actions do not re-read the screen or wait for effects, with these exceptions: window confirms its op (up to 2 s, verified); page navigate/back/forward/reload wait for the page to load (loaded); page scroll waits for the scroll to settle. Follow actions with wait or observe when the next step depends on the result.
- Refs and captureIds belong to this server process; keep them across scripts with store(). A stale ref is refused, never re-bound to a look-alike.
- Pass window to pointer/key tools to refuse input when another app window would get it (menus and popups are allowed). Input is queued: one action at a time (page_eval and reads are not queued).
- set_text does not move keyboard focus: pass focus=true before pressing keys (e.g. Return) in that field.
- Chinese and other non-ASCII text: set_text (desktop) or page_act fill/type (page); type is ASCII only.
- Logins, passwords, 2FA, CAPTCHA: stop and ask the person. Never kill processes you did not start; close windows you opened (window op=close) and tabs you opened (tabs op=close).

Example (codemode):
const c = "mcp__computer__";
const l = await tools[c+"launch"]({ command: "mousepad" });
const w = await tools[c+"wait"]({ condition: "window", class: "mousepad", exclude: l.structuredContent.existingWindows, timeoutMs: 8000 });
if (!w.structuredContent.matched) return "no new window (a running instance may have opened a tab instead)";
const win = w.structuredContent.result.matches[0].id;
const o = await tools[c+"observe"]({ window: win, role: "text" });
if (o.isError) return o.structuredContent;
const r = await tools[c+"set_text"]({ ref: o.structuredContent.nodes[0].ref, text: "你好" });
return r.structuredContent;`;

const server = createServer({ name: "pi-computer", version: "0.3.0", instructions, tools: [...desktopTools(ctx), ...inputTools(ctx), ...pageTools(ctx), waitTool(ctx)] });

let closing = false;
async function shutdown() {
	if (closing) return;
	closing = true;
	// Cancel running input first: a drag or hold cut off by process.exit would leave a button or key pressed.
	server.stop();
	await Promise.race([ctx.queue.idle(), new Promise((r) => setTimeout(r, 1500))]);
	await Promise.race([ctx.browser.closeAll(), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
	ctx.atspi.close();
	ctx.captures.close();
	process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
serveStdio(server, shutdown);
