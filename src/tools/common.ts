// Shared by the computer server's tool groups: the desktop context and target resolution.
import type { Atspi } from "../atspi.ts";
import { matchRoots } from "../atspi.ts";
import { type Captures, checkFresh, toScreen } from "../capture.ts";
import { ToolError } from "../mcp.ts";
import * as x11 from "../x11.ts";
import { type PageCtx, str } from "./base.ts";

export * from "./base.ts";

export type Ctx = PageCtx & { atspi: Atspi; captures: Captures };

export const windowParam = str('X window id ("0x…") from windows. Pointer actions (not move) then refuse if another app window is under the pointer (menus and popups are allowed); key/type refuse unless it is the active window.');

// ---- targets ----

/** The AT-SPI root for an X window, refusing to guess between look-alike windows. */
export async function rootForWindow(ctx: Ctx, id: string) {
	const [{ windows }, { roots, unreadablePids }] = await Promise.all([x11.listWindows(), ctx.atspi.roots()]);
	const win = windows.find((w) => w.id === x11.normId(id));
	if (!win) throw new ToolError("WINDOW_GONE", `window ${id} no longer exists; call windows`);
	// With part of the app's roots unread, the missing one may be the right match: no pairing is trustworthy yet.
	if (win.pid && unreadablePids.includes(win.pid)) throw new ToolError("APP_BUSY", `the accessibility tree of window ${win.id}'s app could not be fully read (busy, or more than 50 top-level windows); try again`);
	const m = matchRoots([win, ...windows.filter((w) => w.id !== win.id && w.pid === win.pid)], roots).get(win.id)!;
	if (!m.root) {
		const candidates = m.candidates.map((r) => ({ ref: r.ref, role: r.role, name: r.name }));
		if (candidates.length)
			throw new ToolError("AMBIGUOUS", `window ${win.id} cannot be told apart from its app's other windows (same title and place); activate it or move it (window op=activate/move), then observe again`, { details: { candidates } });
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
