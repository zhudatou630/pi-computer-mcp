// Shared by all tool groups: the server context, JSON-schema shorthands and target resolution.
import type { Atspi } from "../atspi.ts";
import { matchRoots } from "../atspi.ts";
import type { Browser, PageCapture } from "../cdp.ts";
import { type Captures, checkFresh, toScreen } from "../capture.ts";
import { ToolError } from "../mcp.ts";
import type { InputQueue } from "../queue.ts";
import * as x11 from "../x11.ts";

export type Ctx = { gen: string; atspi: Atspi; browser: Browser; captures: Captures; pageCaptures: Map<string, PageCapture>; queue: InputQueue };

// ---- schema shorthands ----
type S = Record<string, unknown>;
export const str = (description?: string, extra: S = {}): S => ({ type: "string", ...(description ? { description } : {}), ...extra });
export const num = (description?: string, extra: S = {}): S => ({ type: "number", ...(description ? { description } : {}), ...extra });
export const int = (description?: string, extra: S = {}): S => ({ type: "integer", ...(description ? { description } : {}), ...extra });
export const bool = (description?: string): S => ({ type: "boolean", ...(description ? { description } : {}) });
export const arr = (items: S, description?: string, extra: S = {}): S => ({ type: "array", items, ...(description ? { description } : {}), ...extra });
export const enm = (values: string[], description?: string): S => ({ type: "string", enum: values, ...(description ? { description } : {}) });
export const obj = (properties: Record<string, S>, required: string[] = []): S => ({ type: "object", properties, required, additionalProperties: false });
/** Output schemas describe the main fields; results may carry more. */
export const out = (properties: Record<string, S>, required: string[] = []): S => ({ type: "object", properties, required, additionalProperties: true });

export const rect = obj({ x: num(), y: num(), width: num(), height: num() }, ["x", "y", "width", "height"]);
export const RECEIPT = {
	outcome: enm(["delivered", "refused", "unknown"], "delivered = sent; refused = certainly not sent; unknown = may have been sent, do not blindly retry"),
	route: str("how it was sent: xtest, atspi-action, atspi-text, wm, spawn, cdp-input, cdp-dom, cdp-page"),
	verified: bool("present only when the effect was checked afterwards"),
	code: str("error code when not delivered"),
	message: str(),
};
export const receipt = (extra: Record<string, S> = {}) => out({ ...RECEIPT, ...extra }, ["outcome"]);

export const windowParam = str('X window id ("0x…") from windows. Pointer actions (not move) then refuse if another app window is under the pointer (menus and popups are allowed); key/type refuse unless it is the active window.');

// ---- targets ----

/** The AT-SPI root for an X window, refusing to guess between look-alike windows. */
export async function rootForWindow(ctx: Ctx, id: string) {
	const [{ windows }, { roots, unreadablePids }] = await Promise.all([x11.listWindows(), ctx.atspi.roots()]);
	const win = windows.find((w) => w.id === x11.normId(id));
	if (!win) throw new ToolError("WINDOW_GONE", `window ${id} no longer exists; call windows`);
	const m = matchRoots([win, ...windows.filter((w) => w.id !== win.id && w.pid === win.pid)], roots).get(win.id)!;
	if (!m.root) {
		const candidates = m.candidates.map((r) => ({ ref: r.ref, role: r.role, name: r.name }));
		if (candidates.length)
			throw new ToolError("AMBIGUOUS", `window ${win.id} cannot be told apart from its app's other windows (same title and place); activate it or move it (window op=activate/move), then observe again`, { details: { candidates } });
		if (win.pid && unreadablePids.includes(win.pid)) throw new ToolError("APP_BUSY", `the app of window ${win.id} did not answer; try again`);
		throw new ToolError("NO_ACCESSIBLE_ROOT", `window ${win.id} (${win.class}) has no accessibility tree (app started before AT-SPI, Electron, or no a11y support); use screenshot + pointer input`);
	}
	ctx.atspi.bindWindow(m.root.ref, win.id);
	return { root: m.root, window: win };
}

export type PointArgs = { ref?: string; x?: number; y?: number; captureId?: string; window?: string };

/** A screen point from a desktop ref, a capture's image coordinates, or screen coordinates. */
export async function resolvePoint(ctx: Ctx, a: PointArgs): Promise<{ x: number; y: number; window?: string }> {
	const window = a.window ? x11.normId(a.window) : undefined;
	if (a.ref) {
		const [x, y, w, h] = await ctx.atspi.box(a.ref);
		return { x: Math.round(x + w / 2), y: Math.round(y + h / 2), window: window ?? ctx.atspi.windowOf(a.ref) };
	}
	if (a.x === undefined || a.y === undefined) throw new ToolError("BAD_ARGS", "give ref, or x and y");
	if (a.captureId) {
		const c = ctx.captures.get(a.captureId);
		const [screen, win] = await Promise.all([x11.screenSize(), c.window ? x11.getWindow(c.window.id) : undefined]);
		checkFresh(c, screen, win);
		return { ...toScreen(c, a.x, a.y), window: window ?? c.window?.id };
	}
	const screen = await x11.screenSize();
	if (a.x < 0 || a.y < 0 || a.x >= screen.width || a.y >= screen.height) throw new ToolError("BAD_ARGS", `${a.x},${a.y} is outside the ${screen.width}x${screen.height} screen`);
	return { x: Math.round(a.x), y: Math.round(a.y), window };
}

/**
 * Move there and make sure no other managed window is under the pointer (menus and popups are not managed). A refusal
 * means the click/scroll was not sent; the pointer itself has moved.
 */
export async function checkLanding(p: { x: number; y: number; window?: string }) {
	if (!p.window) return;
	await x11.moveTo(p.x, p.y);
	await checkPointerOver(p.window);
}

/** Refuse when another managed window is under the pointer where it is now (menus and popups are not managed). */
export async function checkPointerOver(window: string) {
	const [{ x, y, window: under }, managed] = await Promise.all([x11.pointer(), x11.managedIds()]);
	if (under && managed.has(under) && under !== window)
		throw new ToolError("POINTER_ELSEWHERE", `window ${under} is under ${x},${y}, not ${window}; activate the window or take a new screenshot`, { details: { pointerWindow: under } });
}

export async function checkActive(window: string | undefined) {
	if (!window) return;
	const id = x11.normId(window);
	// Both: a closing window leaves the WM's list a few hundred ms before _NET_ACTIVE_WINDOW moves on.
	const [active, managed] = await Promise.all([x11.activeWindow(), x11.managedIds()]);
	if (!managed.has(id)) throw new ToolError("WINDOW_GONE", `window ${window} no longer exists; call windows`);
	if (active === id) return;
	throw new ToolError("FOCUS_CHANGED", `the active window is ${active ?? "none"}, not ${window}; activate it first`, { details: { active } });
}
