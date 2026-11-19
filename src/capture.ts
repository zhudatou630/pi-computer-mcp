// Screenshots with a recorded coordinate contract: image pixels map back to screen pixels through the capture,
// and a capture refuses to map once the screen size (or its window's geometry) has changed.
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolError } from "./mcp.ts";
import { run, type Rect, type Size } from "./x11.ts";

/** Below every model's resize limit (Claude 1568, pi's default 2000), so the model sees exactly these pixels. */
export const DEFAULT_MAX_EDGE = 1280;
const KEEP = 32;

export type Capture = { id: string; screen: Size; source: Rect; image: Size; window?: { id: string; rect: Rect } };

/** Clip `source` to the screen and pick the output size (never upscaled). */
export function plan(screen: Size, source: Rect, maxEdge = DEFAULT_MAX_EDGE): { source: Rect; image: Size } {
	const x = Math.max(0, Math.round(source.x));
	const y = Math.max(0, Math.round(source.y));
	const width = Math.min(Math.round(source.x + source.width), screen.width) - x;
	const height = Math.min(Math.round(source.y + source.height), screen.height) - y;
	if (width < 1 || height < 1) throw new ToolError("BAD_ARGS", "the region is outside the screen");
	const scale = Math.min(1, maxEdge / Math.max(width, height));
	return { source: { x, y, width, height }, image: { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) } };
}

/** Image pixel -> screen pixel. */
export function toScreen(c: Pick<Capture, "source" | "image">, x: number, y: number): { x: number; y: number } {
	if (x < 0 || y < 0 || x >= c.image.width || y >= c.image.height) throw new ToolError("BAD_ARGS", `point ${x},${y} is outside the ${c.image.width}x${c.image.height} image`);
	return { x: Math.round(c.source.x + ((x + 0.5) * c.source.width) / c.image.width - 0.5), y: Math.round(c.source.y + ((y + 0.5) * c.source.height) / c.image.height - 0.5) };
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Throws CAPTURE_STALE when the coordinates of `c` no longer mean the same place on screen. */
export function checkFresh(c: Capture, screen: Size, window?: Rect) {
	if (screen.width !== c.screen.width || screen.height !== c.screen.height)
		throw new ToolError("CAPTURE_STALE", `the screen is now ${screen.width}x${screen.height} (was ${c.screen.width}x${c.screen.height}); take a new screenshot`);
	if (c.window && window && !sameRect(window, c.window.rect)) throw new ToolError("CAPTURE_STALE", `window ${c.window.id} moved or resized since ${c.id}; take a new screenshot`);
}

export class Captures {
	#n = 0;
	#gen: string;
	#items = new Map<string, Capture>();
	#dir = mkdtempSync(join(tmpdir(), "pi-computer-"));

	constructor(gen: string) {
		this.#gen = gen;
	}

	get(id: string): Capture {
		const c = this.#items.get(id);
		if (!c) throw new ToolError("CAPTURE_STALE", `unknown capture ${id} (too old, or from a previous server process); take a new screenshot`);
		return c;
	}

	/** Grab `source` from the screen as JPEG. Pixels are what is visible: overlapping windows are included. */
	async grab(screen: Size, source: Rect, maxEdge: number | undefined, window?: Capture["window"]): Promise<{ capture: Capture; data: string }> {
		const p = plan(screen, source, maxEdge);
		const file = join(this.#dir, `shot-${++this.#n}.jpg`);
		const scaled = p.image.width !== p.source.width || p.image.height !== p.source.height;
		const args = ["-o", "-q", "75", "-a", `${p.source.x},${p.source.y},${p.source.width},${p.source.height}`];
		if (scaled) args.push("-t", `${p.image.width}x${p.image.height}`);
		await run("scrot", [...args, file]);
		const out = scaled ? file.replace(/\.jpg$/, "-thumb.jpg") : file;
		try {
			const data = (await readFile(out)).toString("base64");
			const capture: Capture = { id: `c${this.#n}.${this.#gen}`, screen, ...p, ...(window ? { window } : {}) };
			this.#items.set(capture.id, capture);
			if (this.#items.size > KEEP) this.#items.delete(this.#items.keys().next().value!);
			return { capture, data };
		} finally {
			rmSync(file, { force: true });
			rmSync(out, { force: true });
		}
	}

	close() {
		rmSync(this.#dir, { recursive: true, force: true });
	}
}
