// Pixels and physical input: screenshots, pointer, keyboard (xdotool/XTEST, scrot).
import { DEFAULT_MAX_EDGE } from "../capture.ts";
import { dropEmpty, ok, ToolError, type Tool } from "../mcp.ts";
import * as x11 from "../x11.ts";
import { arr, checkActive, checkLanding, type Ctx, enm, int, num, obj, out, type PointArgs, receipt, rect, resolvePoint, str, windowParam } from "./common.ts";

const MODS = arr(enm(["ctrl", "shift", "alt", "super"]), "Modifier keys held during the action");
const BUTTON = enm(["left", "middle", "right"], "default left");
const POINT = {
	ref: str("Desktop element ref: acts at the centre of its on-screen box"),
	x: num("Screen px, or image px when captureId is given"),
	y: num(),
	captureId: str("Interpret x,y in this screenshot's image pixels; refused if the screen or window changed since"),
	window: windowParam,
};
const AT = out({ x: int(), y: int() });

const point = (raw: Record<string, unknown>): PointArgs => dropEmpty(raw, ["ref", "captureId", "window"]) as PointArgs;

export function inputTools(ctx: Ctx): Tool[] {
	return [
		{
			name: "screenshot",
			kind: "read",
			description: `JPEG of the screen, a window's area, or a region (screen px), scaled so the long edge is at most maxEdge (default ${DEFAULT_MAX_EDGE}; use a small region with a large maxEdge to read small text). Shows what is visible, including overlapping windows. Pass captureId with image-pixel x,y to pointer tools. Show the image to yourself with image(result.content[1]).`,
			inputSchema: obj({ window: str('X window id ("0x…"): capture its area'), region: rect, maxEdge: int(undefined, { minimum: 64, maximum: 2000 }) }),
			outputSchema: out({ captureId: str(), image: out({ width: int(), height: int() }), source: out({ x: int(), y: int(), width: int(), height: int() }), scale: num("image px per screen px"), screen: out({ width: int(), height: int() }) }, ["captureId", "image", "source", "scale", "screen"]),
			async run(raw) {
				const a = dropEmpty(raw, ["window", "region"]) as { window?: string; region?: x11.Rect; maxEdge?: number };
				const screen = await x11.screenSize();
				let source: x11.Rect = { x: 0, y: 0, ...screen };
				let window;
				if (a.window) {
					const w = await x11.getWindow(a.window);
					if (w.hidden) throw new ToolError("WINDOW_HIDDEN", `window ${w.id} is minimized or unmapped; restore it first`);
					source = { x: w.x, y: w.y, width: w.width, height: w.height };
					window = { id: w.id, rect: source };
				}
				if (a.region) source = a.region;
				const { capture, data } = await ctx.captures.grab(screen, source, a.maxEdge, window);
				const scale = Math.round((capture.image.width / capture.source.width) * 1000) / 1000;
				const info = { captureId: capture.id, image: capture.image, source: capture.source, scale, screen };
				return ok(info, `${capture.id}: ${capture.image.width}x${capture.image.height} image of ${capture.source.width}x${capture.source.height} at ${capture.source.x},${capture.source.y} (screen ${screen.width}x${screen.height})`, { data, mimeType: "image/jpeg" });
			},
		},
		{
			name: "click",
			kind: "action",
			description: "Physical mouse click (left/middle/right, 1-3 clicks, optional modifiers) at a desktop ref's centre, a screenshot point (captureId + image x,y) or screen x,y. Selects list/table items where invoke would open them.",
			inputSchema: obj({ ...POINT, button: BUTTON, count: int("1-3, default 1", { minimum: 1, maximum: 3 }), modifiers: MODS }),
			outputSchema: receipt({ at: AT }),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const p = await resolvePoint(ctx, point(raw));
					await checkLanding(p);
					await x11.click(p.x, p.y, { button: raw.button as x11.Button, count: (raw.count as number) || 1, modifiers: raw.modifiers as string[], signal });
					return ok({ outcome: "delivered", route: "xtest", at: { x: p.x, y: p.y } }, `clicked at ${p.x},${p.y}`);
				}),
		},
		{
			name: "move",
			kind: "action",
			description: "Move the mouse pointer (hover) to a ref, screenshot point or screen point. window is not checked here (moving is what the check itself does); hover can still open menus or tooltips.",
			inputSchema: obj(POINT),
			outputSchema: receipt({ at: AT }),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const p = await resolvePoint(ctx, point(raw));
					await x11.moveTo(p.x, p.y);
					return ok({ outcome: "delivered", route: "xtest", at: { x: p.x, y: p.y } }, `pointer at ${p.x},${p.y}`);
				}),
		},
		{
			name: "drag",
			kind: "action",
			description: "Press, move along a path, release — in one gesture; the button and modifiers are always released, also on failure or cancel. Path points are {x,y} (screen px, or image px with captureId) or {ref}.",
			inputSchema: obj(
				{
					path: arr(obj({ x: num(), y: num(), ref: str() }), "At least 2 points", { minItems: 2, maxItems: 50 }),
					captureId: POINT.captureId,
					window: windowParam,
					button: BUTTON,
					durationMs: int("default 400", { minimum: 0, maximum: 10000 }),
					modifiers: MODS,
				},
				["path"],
			),
			outputSchema: receipt({ path: arr(AT) }),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const a = dropEmpty(raw, ["captureId", "window"]) as any;
					const pts = [];
					for (const p of a.path as PointArgs[]) pts.push(await resolvePoint(ctx, { ...dropEmpty(p as any, ["ref"]), captureId: (p as any).ref ? undefined : a.captureId, window: a.window }));
					await checkLanding({ ...pts[0], window: a.window ?? pts[0].window });
					await x11.drag(pts, { button: a.button, durationMs: a.durationMs, modifiers: a.modifiers, signal });
					return ok({ outcome: "delivered", route: "xtest", path: pts.map(({ x, y }) => ({ x, y })) }, `dragged ${pts.map((p) => `${p.x},${p.y}`).join(" → ")}`);
				}),
		},
		{
			name: "scroll",
			kind: "action",
			description: "Mouse wheel at a point (or wherever the pointer is): dy > 0 scrolls down, dx > 0 right, in wheel clicks (typically ~3 lines each). With window and no point, refused when another window is under the pointer.",
			inputSchema: obj({ ...POINT, dx: int(), dy: int(), modifiers: MODS }),
			outputSchema: receipt({ at: AT }),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const a = point(raw);
					const dx = (raw.dx as number) || 0;
					const dy = (raw.dy as number) || 0;
					if (!dx && !dy) throw new ToolError("BAD_ARGS", "give dx and/or dy");
					const p = a.ref || a.x !== undefined ? await resolvePoint(ctx, a) : undefined;
					if (p) await checkLanding(p);
					else if (a.window) await checkLanding({ ...(await x11.pointer()), window: x11.normId(a.window) });
					await x11.scroll(p, dx, dy, { modifiers: raw.modifiers as string[], signal });
					return ok({ outcome: "delivered", route: "xtest", ...(p ? { at: { x: p.x, y: p.y } } : {}) }, `scrolled ${dx},${dy}`);
				}),
		},
		{
			name: "key",
			kind: "action",
			description: 'Press keys or chords in order to the focused window, xdotool names: "Return", "Tab", "Escape", "F2", "ctrl+s", "ctrl+shift+t", "alt+F4", "Down". repeat repeats the whole sequence.',
			inputSchema: obj({ keys: arr(str(), "Chords pressed in order", { minItems: 1 }), repeat: int("default 1", { minimum: 1, maximum: 100 }), window: windowParam }, ["keys"]),
			outputSchema: receipt(),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const a = dropEmpty(raw, ["window"]) as { keys: string[]; repeat?: number; window?: string };
					await checkActive(a.window);
					await x11.keys(a.keys, a.repeat ?? 1, signal);
					return ok({ outcome: "delivered", route: "xtest" }, `pressed ${a.keys.join(" ")}`);
				}),
		},
		{
			name: "hold",
			kind: "action",
			description: 'Hold a key or chord down for durationMs, then release it (always released, also on cancel). E.g. "shift" while you do nothing else, or "Right" to keep moving.',
			inputSchema: obj({ key: str(), durationMs: int(undefined, { minimum: 1, maximum: 10000 }), window: windowParam }, ["key", "durationMs"]),
			outputSchema: receipt(),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					await checkActive(dropEmpty(raw, ["window"]).window as string | undefined);
					await x11.hold(String(raw.key), Number(raw.durationMs), signal);
					return ok({ outcome: "delivered", route: "xtest" }, `held ${raw.key} for ${raw.durationMs} ms`);
				}),
		},
		{
			name: "type",
			kind: "action",
			description: "Type ASCII text as keystrokes into the focused window (\\n = Enter, \\t = Tab). Other text (Chinese, emoji, accents) is refused before anything is sent: use set_text on the element, or page_act fill/type in a page.",
			inputSchema: obj({ text: str(), window: windowParam }, ["text"]),
			outputSchema: receipt(),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const text = String(raw.text ?? "");
					if (!x11.isTypeable(text)) throw new ToolError("NOT_ASCII", "text has non-ASCII characters; use set_text (desktop) or page_act fill/type (page)");
					await checkActive(dropEmpty(raw, ["window"]).window as string | undefined);
					await x11.type(text, signal);
					return ok({ outcome: "delivered", route: "xtest" }, `typed ${text.length} chars`);
				}),
		},
	];
}
