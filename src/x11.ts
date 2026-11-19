// X11 through the stock CLI tools: windows (xprop/xwininfo/wmctrl), input (xdotool), screenshots (scrot).
import { execFile } from "node:child_process";
import { ToolError } from "./mcp.ts";

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
export type XWindow = Rect & {
	id: string; // "0x…" lowercase, as xprop prints it
	pid?: number;
	title: string;
	class: string;
	instance: string;
	type: string; // normal, dialog, dock, desktop, …
	active: boolean;
	hidden: boolean; // minimized or unmapped
	maximized: boolean;
	desktop?: number;
};

const ENV = { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };

/** Run a command; `input` goes to stdin. Rejects with the command's stderr on failure. */
export function run(cmd: string, args: string[], options: { input?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, { env: ENV, timeout: options.timeoutMs ?? 15_000, signal: options.signal, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`${cmd} ${args[0] ?? ""} failed: ${(stderr || err.message).trim()}`));
			else resolve({ stdout, stderr });
		});
		if (options.input !== undefined) {
			// The command can exit before reading stdin; the callback above reports that, an unhandled EPIPE would crash.
			child.stdin?.on("error", () => {});
			child.stdin?.end(options.input);
		}
	});
}

export const normId = (id: string | number): string => {
	const n = typeof id === "number" ? id : Number(id); // Number() parses both "0x…" and decimal
	if (!Number.isInteger(n) || n <= 0) throw new ToolError("BAD_ARGS", `not a window id: ${id}`);
	return `0x${n.toString(16)}`;
};

/** Decode an xprop string value: "…" with C escapes, where \ooo octal bytes form UTF-8. */
export function xpropString(raw: string): string {
	const s = raw.trim().replace(/^"|"$/g, "");
	const bytes: number[] = [];
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\\" && /[0-7]{3}/.test(s.slice(i + 1, i + 4))) {
			bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
			i += 3;
		} else if (s[i] === "\\" && i + 1 < s.length) {
			bytes.push(...Buffer.from(s[++i]));
		} else {
			bytes.push(...Buffer.from(s[i]));
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

const LIST_SCRIPT = `
xdotool getdisplaygeometry
xprop -root -notype _NET_ACTIVE_WINDOW _NET_CLIENT_LIST_STACKING
ids=$(xprop -root -notype _NET_CLIENT_LIST_STACKING | sed 's/.*# //; s/,/ /g')
for w in $ids; do
	echo "@@ $w"
	xprop -id "$w" -notype _NET_WM_PID _NET_WM_NAME WM_NAME WM_CLASS _NET_WM_STATE _NET_WM_WINDOW_TYPE _NET_WM_DESKTOP 2>/dev/null
	xwininfo -id "$w" 2>/dev/null | grep -E 'Absolute upper-left|Width:|Height:|Map State:'
done`;

/** Parse LIST_SCRIPT output. Windows come topmost first. */
export function parseWindows(text: string): { screen: Size; active?: string; windows: XWindow[] } {
	const [head, ...blocks] = text.split(/^@@ /m);
	const [w, h] = head.trim().split(/\s+/).map(Number);
	const activeRaw = /_NET_ACTIVE_WINDOW: window id # (0x[0-9a-f]+)/i.exec(head)?.[1];
	const active = activeRaw && activeRaw !== "0x0" ? normId(activeRaw) : undefined;
	const windows: XWindow[] = [];
	for (const block of blocks) {
		const [idLine, ...lines] = block.split("\n");
		// A missing property prints "NAME:  not found." (or "no such atom on any window."): that is no value.
		const prop = (name: string) => lines.find((l) => l.startsWith(`${name} = `) || (l.startsWith(`${name}:`) && !/:\s+(not found\.|no such atom)/.test(l)))?.replace(/^[^=:]+[=:]\s*/, "");
		const num = (label: string) => Number(new RegExp(`${label}\\s*(-?\\d+)`).exec(block)?.[1] ?? NaN);
		const id = normId(idLine.trim());
		const cls = prop("WM_CLASS")?.match(/"((?:[^"\\]|\\.)*)"/g)?.map(xpropString) ?? [];
		const state = prop("_NET_WM_STATE") ?? "";
		const title = prop("_NET_WM_NAME") ?? prop("WM_NAME");
		const pid = Number(prop("_NET_WM_PID"));
		const desktop = Number(prop("_NET_WM_DESKTOP"));
		windows.push({
			id,
			...(Number.isFinite(pid) && pid > 0 ? { pid } : {}),
			title: title && title.startsWith('"') ? xpropString(title) : "",
			instance: cls[0] ?? "",
			class: cls[1] ?? "",
			type: (prop("_NET_WM_WINDOW_TYPE") ?? "").split(",")[0].replace("_NET_WM_WINDOW_TYPE_", "").trim().toLowerCase() || "normal",
			x: num("Absolute upper-left X:"),
			y: num("Absolute upper-left Y:"),
			width: num("Width:"),
			height: num("Height:"),
			active: id === active,
			hidden: state.includes("_NET_WM_STATE_HIDDEN") || /Map State:\s*IsUnMapped/.test(block),
			maximized: state.includes("MAXIMIZED_HORZ") && state.includes("MAXIMIZED_VERT"),
			...(Number.isFinite(desktop) && desktop >= 0 && desktop < 0xffffffff ? { desktop } : {}),
		});
	}
	return { screen: { width: w, height: h }, active, windows: windows.reverse() };
}

export async function listWindows() {
	return parseWindows((await run("sh", ["-c", LIST_SCRIPT])).stdout);
}

export async function getWindow(id: string): Promise<XWindow> {
	const win = (await listWindows()).windows.find((w) => w.id === normId(id));
	if (!win) throw new ToolError("WINDOW_GONE", `window ${id} no longer exists; call windows`);
	return win;
}

export async function screenSize(): Promise<Size> {
	const [width, height] = (await run("xdotool", ["getdisplaygeometry"])).stdout.trim().split(/\s+/).map(Number);
	return { width, height };
}

export async function activeWindow(): Promise<string | undefined> {
	const raw = /# (0x[0-9a-f]+)/i.exec((await run("xprop", ["-root", "-notype", "_NET_ACTIVE_WINDOW"])).stdout)?.[1];
	return raw && raw !== "0x0" ? normId(raw) : undefined;
}

export async function managedIds(): Promise<Set<string>> {
	const out = (await run("xprop", ["-root", "-notype", "_NET_CLIENT_LIST"])).stdout;
	return new Set([...out.matchAll(/0x[0-9a-f]+/gi)].map((m) => normId(m[0])));
}

/** The client window under the pointer, as xdotool reports it (it descends to the window with WM_STATE). */
export async function pointer(): Promise<{ x: number; y: number; window?: string }> {
	const out = (await run("xdotool", ["getmouselocation", "--shell"])).stdout;
	const get = (k: string) => Number(new RegExp(`^${k}=(\\d+)`, "m").exec(out)?.[1]);
	const win = get("WINDOW");
	return { x: get("X"), y: get("Y"), ...(win > 0 ? { window: normId(win) } : {}) };
}

// ---- window management (wmctrl talks EWMH to the window manager, so close is a polite WM_DELETE_WINDOW) ----

/** Decoration widths around the client area (left, right, top, bottom); zero when the WM does not say. */
export async function frameExtents(id: string): Promise<{ left: number; right: number; top: number; bottom: number }> {
	const out = (await run("xprop", ["-id", id, "-notype", "_NET_FRAME_EXTENTS"])).stdout;
	const [left = 0, right = 0, top = 0, bottom = 0] = /=\s*(.*)/.exec(out)?.[1].split(",").map(Number) ?? [];
	return { left, right, top, bottom };
}

export async function windowOp(id: string, op: string, geometry: Partial<Rect> = {}) {
	const win = await getWindow(id);
	switch (op) {
		case "activate":
			await run("wmctrl", ["-i", "-a", win.id]);
			return;
		case "close":
			await run("wmctrl", ["-i", "-c", win.id]);
			return;
		case "minimize":
			await run("xdotool", ["windowminimize", win.id]);
			return;
		case "maximize":
			await run("wmctrl", ["-i", "-r", win.id, "-b", "add,maximized_vert,maximized_horz"]);
			return;
		case "restore":
			await run("wmctrl", ["-i", "-r", win.id, "-b", "remove,maximized_vert,maximized_horz"]);
			if (win.hidden) await run("wmctrl", ["-i", "-a", win.id]);
			return;
		case "move": {
			if (geometry.x === undefined || geometry.y === undefined) throw new ToolError("BAD_ARGS", "move needs x and y");
			// windowmove places the frame; x,y here mean the client area, like everywhere else in this server.
			const { left, top } = await frameExtents(win.id);
			await run("xdotool", ["windowmove", win.id, String(Math.round(geometry.x - left)), String(Math.round(geometry.y - top))]);
			return;
		}
		case "resize":
			if (!geometry.width || !geometry.height) throw new ToolError("BAD_ARGS", "resize needs width and height");
			await run("xdotool", ["windowsize", win.id, String(Math.round(geometry.width)), String(Math.round(geometry.height))]);
			return;
		default:
			throw new ToolError("BAD_ARGS", `unknown window op ${op}`);
	}
}

// ---- input ----

export type Button = "left" | "middle" | "right";
const BUTTON: Record<Button, string> = { left: "1", middle: "2", right: "3" };
const MODIFIER: Record<string, string> = { ctrl: "ctrl", control: "ctrl", shift: "shift", alt: "alt", super: "super", meta: "super" };

export function modifierKeys(mods: readonly string[] = []): string[] {
	return mods.map((m) => {
		const k = MODIFIER[m.toLowerCase()];
		if (!k) throw new ToolError("BAD_ARGS", `unknown modifier ${m}; use ctrl, shift, alt or super`);
		return k;
	});
}

const r = (n: number) => String(Math.round(n));

/** xdotool reports unknown key names on stderr but still exits 0. */
function checkKeys(stderr: string) {
	const bad = /\(symbol\) No such key name '([^']*)'/.exec(stderr) ?? /Invalid key sequence '([^']*)'/.exec(stderr);
	if (bad) throw new ToolError("BAD_KEY", `unknown key name "${bad[1]}" (use xdotool/X keysym names like Return, ctrl+s, F2)`, { outcome: "unknown" });
}

/**
 * Run an input gesture. Modifiers and buttons pressed here are released in `finally`, also on failure or cancel.
 * A failure after the gesture started is "unknown": part of it may have reached the desktop.
 */
async function gesture(signal: AbortSignal | undefined, mods: string[], pressed: string[], args: string[], input?: string) {
	try {
		if (mods.length) await run("xdotool", ["keydown", ...mods]);
		const { stderr } = await run("xdotool", args, { signal, input, timeoutMs: 70_000 });
		checkKeys(stderr);
	} catch (e) {
		if (e instanceof ToolError) throw e;
		throw new ToolError(signal?.aborted ? "CANCELLED" : "INPUT_FAILED", `input interrupted: ${(e as Error).message}`, { outcome: "unknown" });
	} finally {
		const release = [...pressed.map((b) => ["mouseup", b]), ...(mods.length ? [["keyup", ...mods]] : [])];
		for (const cmd of release) await run("xdotool", cmd).catch(() => {});
	}
}

export async function moveTo(x: number, y: number) {
	await run("xdotool", ["mousemove", r(x), r(y)]);
}

export async function click(x: number, y: number, o: { button?: Button; count?: number; modifiers?: string[]; signal?: AbortSignal } = {}) {
	const button = BUTTON[o.button ?? "left"];
	await gesture(o.signal, modifierKeys(o.modifiers), [], ["mousemove", r(x), r(y), "click", "--repeat", String(o.count ?? 1), "--delay", "80", button]);
}

/** Points along a path, at most `step` px apart, so apps see a real drag rather than a jump. */
export function interpolate(path: { x: number; y: number }[], step = 24): { x: number; y: number }[] {
	const out = [path[0]];
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1];
		const b = path[i];
		const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
		for (let k = 1; k <= n; k++) out.push({ x: Math.round(a.x + ((b.x - a.x) * k) / n), y: Math.round(a.y + ((b.y - a.y) * k) / n) });
	}
	return out;
}

export async function drag(path: { x: number; y: number }[], o: { button?: Button; durationMs?: number; modifiers?: string[]; signal?: AbortSignal } = {}) {
	const button = BUTTON[o.button ?? "left"];
	const points = interpolate(path);
	const pause = ((o.durationMs ?? 400) / points.length / 1000).toFixed(3);
	const args = ["mousemove", r(points[0].x), r(points[0].y), "mousedown", button, "sleep", "0.05"];
	for (const p of points.slice(1)) args.push("mousemove", r(p.x), r(p.y), "sleep", pause);
	args.push("sleep", "0.05", "mouseup", button);
	await gesture(o.signal, modifierKeys(o.modifiers), [button], args);
}

/** Wheel clicks: dy > 0 scrolls down, dx > 0 scrolls right. */
export async function scroll(at: { x: number; y: number } | undefined, dx: number, dy: number, o: { modifiers?: string[]; signal?: AbortSignal } = {}) {
	const args = at ? ["mousemove", r(at.x), r(at.y)] : [];
	if (dy) args.push("click", "--repeat", String(Math.abs(Math.round(dy))), "--delay", "40", dy > 0 ? "5" : "4");
	if (dx) args.push("click", "--repeat", String(Math.abs(Math.round(dx))), "--delay", "40", dx > 0 ? "7" : "6");
	await gesture(o.signal, modifierKeys(o.modifiers), [], args);
}

export async function keys(chords: string[], repeat = 1, signal?: AbortSignal) {
	const seq = Array.from({ length: repeat }, () => chords).flat();
	await gesture(signal, [], [], ["key", "--clearmodifiers", "--delay", "40", ...seq]);
}

export async function hold(chord: string, ms: number, signal?: AbortSignal) {
	try {
		await gesture(signal, [], [], ["keydown", chord, "sleep", (ms / 1000).toFixed(3), "keyup", chord]);
	} finally {
		await run("xdotool", ["keyup", chord]).catch(() => {});
	}
}

export const isTypeable = (text: string) => /^[\x20-\x7E\n\t]*$/.test(text);

/** `beforeLine` runs before each line after a Return (which may have moved focus); it can stop the typing by throwing. */
export async function type(text: string, signal?: AbortSignal, beforeLine?: () => Promise<void>) {
	// xdotool types "\n" as Linefeed, which GTK ignores: send Return between lines instead.
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (i) {
			await gesture(signal, [], [], ["key", "--clearmodifiers", "Return"]);
			if (lines[i] && beforeLine) await beforeLine();
		}
		// via stdin: text starting with "-" would otherwise be parsed as an option
		if (lines[i]) await gesture(signal, [], [], ["type", "--clearmodifiers", "--delay", "12", "--file", "-"], lines[i]);
	}
}
