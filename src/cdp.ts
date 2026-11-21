// Pages in the shared Chromium over CDP (Node's built-in WebSocket). This process touches only the tabs it opened
// or was explicitly told to attach to; attached tabs are detached, never closed.
import { ToolError } from "./mcp.ts";
import type { UiNode } from "./tree.ts";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class CdpConnection {
	#ws: WebSocket;
	#next = 0;
	#pending = new Map<number, Pending>();
	closed = false;
	/** Called when Chromium ends a session (Target.detachedFromTarget), e.g. after its tab crashed. */
	onDetached?: (sessionId: string) => void;
	/** Every CDP event (messages with a method). */
	onEvent?: (method: string, params: any, sessionId?: string) => void;

	constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (ev) => {
			const msg = JSON.parse(String(ev.data));
			if (msg.method === "Target.detachedFromTarget" && msg.params?.sessionId) this.onDetached?.(msg.params.sessionId);
			if (msg.method) this.onEvent?.(msg.method, msg.params, msg.sessionId);
			const p = msg.id !== undefined ? this.#pending.get(msg.id) : undefined;
			if (!p) return;
			this.#pending.delete(msg.id);
			if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
			else p.resolve(msg.result);
		});
		ws.addEventListener("close", () => {
			this.closed = true;
			for (const p of this.#pending.values()) p.reject(new Error("CDP connection closed"));
			this.#pending.clear();
		});
	}

	send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
		const id = ++this.#next;
		this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`CDP ${method} timed out`));
			}, timeoutMs);
			this.#pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
		});
	}

	close() {
		this.#ws.close();
	}
}

async function connect(httpUrl: string): Promise<CdpConnection> {
	const res = await fetch(new URL("/json/version", httpUrl), { signal: AbortSignal.timeout(5_000) }).catch((e) => {
		throw new ToolError("BROWSER_DOWN", `Chromium is not reachable at ${httpUrl} (${e.message})`);
	});
	const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
	const ws = new WebSocket(webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => (ws.close(), reject(new ToolError("BROWSER_DOWN", "CDP WebSocket did not open in 5 s"))), 5_000);
		ws.addEventListener("open", () => (clearTimeout(timer), resolve(undefined)), { once: true });
		ws.addEventListener("error", () => (clearTimeout(timer), reject(new ToolError("BROWSER_DOWN", "CDP WebSocket failed to open"))), { once: true });
	});
	return new CdpConnection(ws);
}

const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "slider", "tab", "menuitem", "option", "switch", "spinbutton", "listbox"]);
const NOISE = new Set(["InlineTextBox", "LineBreak", "none", "generic", "presentation"]);
const axValue = (v: any) => (v && typeof v === "object" ? v.value : v);
export const isPageInteractive = (n: Pick<UiNode, "role">) => INTERACTIVE.has(n.role);

/** Compact a CDP AX tree. `refOf` names a DOM node (by backendDOMNodeId). */
export function axToNodes(ax: { nodes: any[] }, refOf: (backendId: number) => string): UiNode[] {
	const byId = new Map(ax.nodes.map((n) => [n.nodeId, n]));
	const out: UiNode[] = [];
	const walk = (id: string, depth: number, parentName: string) => {
		const n = byId.get(id);
		if (!n) return;
		const role = String(axValue(n.role) ?? "unknown");
		const name = typeof axValue(n.name) === "string" ? axValue(n.name) : "";
		const props = Object.fromEntries((n.properties ?? []).map((p: any) => [p.name, axValue(p.value)]));
		const interactive = INTERACTIVE.has(role);
		// Drop ignored/noise nodes, nodes without a DOM node (no usable ref), and text that only repeats its parent's
		// name; keep their children.
		const keep = !n.ignored && !NOISE.has(role) && n.backendDOMNodeId !== undefined && (interactive || (name.trim() && !(role === "StaticText" && parentName.includes(name.trim()))));
		if (keep) {
			const states = ["focused", "checked", "disabled", "expanded", "selected", "required", "invalid"].filter((f) => props[f] === true || props[f] === "true");
			const value = axValue(n.value);
			out.push({
				ref: refOf(n.backendDOMNodeId),
				role,
				name,
				depth,
				states,
				...(typeof value === "string" && value ? { value } : {}),
				...(role === "link" && props.url ? { value: String(props.url) } : {}),
			});
		}
		for (const child of n.childIds ?? []) walk(child, keep ? depth + 1 : depth, keep ? name : parentName);
	};
	if (ax.nodes[0]) walk(ax.nodes[0].nodeId, 0, "");
	return out;
}

// ---- keys ----

const NAMED: Record<string, [code: string, keyCode: number, text?: string]> = {
	Enter: ["Enter", 13, "\r"], Tab: ["Tab", 9], Escape: ["Escape", 27], Backspace: ["Backspace", 8], Delete: ["Delete", 46],
	ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
	Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34], Space: ["Space", 32, " "], Insert: ["Insert", 45],
	...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, [`F${i + 1}`, 112 + i] as [string, number]])),
};
const MOD_BITS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, super: 4, shift: 8 };
// xdotool/X keysym names, so the same names work for key (desktop) and page_act press.
const ALIAS: Record<string, string> = { Return: "Enter", KP_Enter: "Enter", Esc: "Escape", BackSpace: "Backspace", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", Page_Up: "PageUp", Prior: "PageUp", Page_Down: "PageDown", Next: "PageDown" };
const NAMED_LOWER = new Map<string, string>([...Object.keys(NAMED).map((k) => [k.toLowerCase(), k] as const), ...Object.entries(ALIAS).map(([a, k]) => [a.toLowerCase(), k] as const)]);
const EDIT_COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo", y: "redo" };

export type KeySpec = ReturnType<typeof parseKey>;

/** "Control+Shift+a" (or xdotool style "ctrl+Return") -> one keyDown/keyUp pair for CDP Input.dispatchKeyEvent. */
export function parseKey(spec: string) {
	const parts = spec.split("+");
	let keyName = parts.pop()!;
	let modifiers = 0;
	for (const m of parts) {
		const bit = MOD_BITS[m.toLowerCase()];
		if (!bit) throw new ToolError("BAD_KEY", `unknown modifier "${m}" in "${spec}" (use Control, Shift, Alt, Meta)`);
		modifiers |= bit;
	}
	const canonical = keyName === " " ? "Space" : keyName.length > 1 ? NAMED_LOWER.get(keyName.toLowerCase()) : undefined;
	if (canonical) keyName = canonical;
	if (modifiers & 8 && /^[a-z]$/.test(keyName)) keyName = keyName.toUpperCase(); // Shift+a types "A"
	const named = canonical ? NAMED[canonical] : undefined;
	if (!named && [...keyName].length !== 1) throw new ToolError("BAD_KEY", `unknown key "${keyName}" (use a single character or ${Object.keys(NAMED).slice(0, 8).join(", ")}, …)`);
	const shortcut = (modifiers & ~8) !== 0;
	if (named) {
		const [code, keyCode, text] = named;
		return { key: keyName === "Space" ? " " : keyName, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text && !shortcut ? { text } : {}) };
	}
	const upper = keyName.toUpperCase();
	const code = /[A-Z]/.test(upper) ? `Key${upper}` : /\d/.test(keyName) ? `Digit${keyName}` : "";
	const command = (modifiers & 2 || modifiers & 4) && EDIT_COMMANDS[keyName.toLowerCase()];
	return { key: keyName, code, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers, ...(shortcut ? {} : { text: keyName }), ...(command ? { commands: [command] } : {}) };
}

// ---- tabs ----

/**
 * Page-side helpers, pasted into functions run in the page. deepHit: the element at viewport (x,y) as rendered, descending
 * into open shadow roots and into the closed ones on t's own path (t can reach them; the document cannot).
 * composedParent: the rendered parent (slotted nodes go up through their slot, shadow roots to their host).
 */
export const PAGE_HELPERS = `
	function deepHit(x, y, t) {
		const roots = new Map();
		for (let root = t && t.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) roots.set(root.host, root);
		let hit = document.elementFromPoint(x, y);
		for (;;) {
			const sr = hit && (hit.shadowRoot || roots.get(hit));
			const inner = sr && sr.elementFromPoint(x, y);
			if (!inner || inner === hit) return hit;
			hit = inner;
		}
	}
	function composedParent(n) { return n.assignedSlot || n.parentNode || n.host; }`;

/** A page screenshot's coordinate contract: valid for this document, scroll position and viewport only. */
export type PageCapture = { id: string; targetId: string; loaderId: string; scale: number; image: { width: number; height: number }; scrollX: number; scrollY: number; width: number; height: number };

export class Tab {
	readonly cdp: CdpConnection;
	readonly targetId: string;
	readonly sessionId: string;
	readonly owned: boolean;
	constructor(cdp: CdpConnection, targetId: string, sessionId: string, owned: boolean) {
		this.cdp = cdp;
		this.targetId = targetId;
		this.sessionId = sessionId;
		this.owned = owned;
	}

	send<T = any>(method: string, params: object = {}, timeoutMs?: number) {
		return this.cdp.send<T>(method, params, this.sessionId, timeoutMs);
	}

	async info() {
		const { targetInfo } = await this.cdp.send("Target.getTargetInfo", { targetId: this.targetId });
		return { url: targetInfo.url as string, title: targetInfo.title as string };
	}

	/** Identifies the current document: a navigation (not an SPA route change) gives a new one. */
	async loaderId(): Promise<string> {
		return (await this.send("Page.getFrameTree")).frameTree.frame.loaderId;
	}

	/** The main frame's document, read so that loader and readyState belong together (undefined mid-navigation). */
	async #snapshot(): Promise<{ loaderId: string; ready: string } | undefined> {
		try {
			const loaderId = await this.loaderId();
			const ready = String(await this.eval("document.readyState"));
			return (await this.loaderId()) === loaderId ? { loaderId, ready } : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Poll until the main frame's document is complete and satisfies `done`; false on timeout. `committed` (optional) must
	 * hold before the snapshot is taken and still after, so the snapshot is of the document it vouches for.
	 */
	async waitFor(done: (s: { loaderId: string }) => boolean, timeoutMs = 10_000, committed?: () => Promise<boolean>) {
		const end = Date.now() + timeoutMs;
		while (Date.now() < end) {
			if (!committed || (await committed())) {
				const s = await this.#snapshot();
				if (s?.ready === "complete" && done(s) && (!committed || (await committed()))) return true;
			}
			await new Promise((r) => setTimeout(r, 150));
		}
		return false;
	}

	async navigate(url: string) {
		const result = await this.send("Page.navigate", { url });
		if (result.errorText) throw new ToolError("NAVIGATION_FAILED", `navigation failed: ${result.errorText}`, { outcome: "delivered" });
		// A same-document navigation (only the hash changes) has no new loader.
		return this.waitFor((s) => !result.loaderId || s.loaderId === result.loaderId);
	}

	/** Back (-1) or forward (+1) in this tab's history; loaded when the entry's page is the complete current one. */
	async history(delta: -1 | 1) {
		const h = await this.send("Page.getNavigationHistory");
		const entry = h.entries[h.currentIndex + delta];
		if (!entry) throw new ToolError("NO_HISTORY", `there is no ${delta < 0 ? "previous" : "next"} page in this tab`);
		await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
		// Two entries can share a URL (pushState): the current entry id tells which one is showing.
		const current = async () => {
			const now = await this.send("Page.getNavigationHistory");
			return now.entries[now.currentIndex]?.id === entry.id;
		};
		return { url: entry.url as string, loaded: await this.waitFor(() => true, 10_000, current) };
	}

	async reload() {
		const before = await this.loaderId();
		await this.send("Page.reload");
		return this.waitFor((s) => s.loaderId !== before);
	}

	async eval(expression: string): Promise<unknown> {
		const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, 30_000);
		if (r.exceptionDetails) throw new ToolError("EVAL_ERROR", r.exceptionDetails.exception?.description ?? r.exceptionDetails.text, { outcome: "unknown" });
		return r.result.value;
	}

	async objectId(backendNodeId: number, ref: string): Promise<string> {
		const r = await this.send("DOM.resolveNode", { backendNodeId }).catch(() => undefined);
		if (!r?.object?.objectId) throw new ToolError("STALE_REF", `${ref} is gone from the page; observe again`);
		return r.object.objectId;
	}

	async callOn(objectId: string, fn: string, args: unknown[] = []) {
		const r = await this.send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn, arguments: args.map((a) => (a && typeof a === "object" && "objectId" in a ? a : { value: a })), returnByValue: true, awaitPromise: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	}

	/** The one element matching a CSS selector, as a backend node id. */
	async select(selector: string): Promise<number> {
		const r = await this.send("Runtime.evaluate", { expression: `document.querySelectorAll(${JSON.stringify(selector)})` });
		if (r.exceptionDetails) throw new ToolError("BAD_ARGS", `bad selector ${selector}`);
		const count = await this.callOn(r.result.objectId, "function(){ return this.length }");
		if (count !== 1) throw new ToolError(count ? "AMBIGUOUS" : "NOT_FOUND", `${count} elements match ${selector}; it must match exactly one`, { details: { count } });
		const first = await this.send("Runtime.callFunctionOn", { objectId: r.result.objectId, functionDeclaration: "function(){ return this[0] }" });
		return (await this.send("DOM.describeNode", { objectId: first.result.objectId })).node.backendNodeId;
	}

	/** Scroll the element into view and return its centre in viewport CSS px. */
	async center(backendNodeId: number, ref: string): Promise<{ x: number; y: number }> {
		await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
		const quads = await this.send("DOM.getContentQuads", { backendNodeId }).catch(() => undefined);
		const q = quads?.quads?.[0];
		if (!q) throw new ToolError("NOT_VISIBLE", `${ref} has no box on the page (hidden or detached)`);
		return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
	}

	/** Is the element at (x,y) the target or inside it? Otherwise something covers it. */
	async hits(x: number, y: number, backendNodeId: number, ref: string): Promise<boolean> {
		const target = await this.objectId(backendNodeId, ref);
		// elementFromPoint takes viewport px like Input events (DOM.getNodeForLocation ignores scrolling).
		return this.callOn(
			target,
			`function(x, y){ ${PAGE_HELPERS}
				const t = this.nodeType === 1 ? this : this.parentElement;
				for (let n = deepHit(x, y, t); n; n = composedParent(n)) if (n === t) return true;
				return false;
			}`,
			[x, y],
		);
	}

	async mouse(x: number, y: number, o: { button?: "left" | "middle" | "right"; count?: number; modifiers?: number; move?: boolean } = {}) {
		await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers: o.modifiers ?? 0 });
		if (o.move) return;
		const button = o.button ?? "left";
		for (let i = 1; i <= (o.count ?? 1); i++) {
			await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i, modifiers: o.modifiers ?? 0 });
			await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i, modifiers: o.modifiers ?? 0 });
		}
	}

	async wheel(x: number, y: number, dx: number, dy: number) {
		await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
	}

	async key(k: KeySpec) {
		await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...k });
		await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, modifiers: k.modifiers });
	}

	async viewport() {
		const m = await this.send("Page.getLayoutMetrics");
		const v = m.cssVisualViewport;
		return { scrollX: v.pageX as number, scrollY: v.pageY as number, width: Math.round(v.clientWidth), height: Math.round(v.clientHeight) };
	}

	/** JPEG of the viewport, scaled so the long edge is at most `maxEdge`. */
	async screenshot(maxEdge: number) {
		const [v, dpr] = await Promise.all([this.viewport(), this.eval("devicePixelRatio")]);
		const scale = Math.min(1, maxEdge / Math.max(v.width, v.height));
		// The clip scale multiplies device pixels (emulated deviceScaleFactor, browser zoom), not CSS px.
		const clip = { x: v.scrollX, y: v.scrollY, width: v.width, height: v.height, scale: scale / (Number(dpr) || 1) };
		const shoot = () => this.send("Page.captureScreenshot", { format: "jpeg", quality: 75, clip }, 15_000);
		// A tab that is not on screen (an attached background tab) may sit on a capture until another one asks for a
		// frame: ask again after a moment and take whichever answers first.
		const first = shoot();
		const winner = await Promise.race([first, new Promise((r) => setTimeout(r, 1500)).then(() => undefined)]);
		const { data } = winner ?? (await Promise.any([first, shoot()]));
		return { data: data as string, scale, image: { width: Math.round(v.width * scale), height: Math.round(v.height * scale) }, ...v };
	}
}

/** Extra per-server behaviour: `attached` runs on every new tab session before it is used; `event` sees every CDP event. */
export type BrowserHooks = { attached?: (tab: Tab) => Promise<void>; event?: (method: string, params: any, sessionId?: string) => void };

export class Browser {
	#cdp?: Promise<CdpConnection>;
	/** Live CDP sessions, by target id. They die with the connection. */
	#tabs = new Map<string, Tab>();
	/** Targets this process created. Kept across reconnects, so its own tabs stay closable. */
	#owned = new Set<string>();
	/** Attaches in flight, so parallel calls share one session. */
	#attaching = new Map<string, Promise<Tab>>();
	/** Sessions being set up; Chromium ending one removes it, so the attach does not cache a dead session. */
	#settingUp = new Set<string>();
	#gen: string;
	#n = 0;
	#refs = new Map<string, { targetId: string; loaderId: string; backendId: number }>();
	#keys = new Map<string, string>();
	/** The DevTools HTTP URL, or a function that finds it (e.g. starts a browser) when the first connection is made. */
	readonly endpoint: string | (() => Promise<string>);
	readonly hooks: BrowserHooks;

	constructor(endpoint: string | (() => Promise<string>), gen: string, hooks: BrowserHooks = {}) {
		this.endpoint = endpoint;
		this.#gen = gen;
		this.hooks = hooks;
	}

	async #connection() {
		const current = this.#cdp;
		const existing = current && (await current.catch(() => undefined));
		// Only the first caller to notice a dead connection replaces it.
		if ((!existing || existing.closed) && this.#cdp === current) {
			const e = this.endpoint;
			this.#cdp = (typeof e === "string" ? connect(e) : e().then(connect)).then((c) => {
				c.onEvent = this.hooks.event;
				c.onDetached = (sessionId) => {
					this.#settingUp.delete(sessionId);
					for (const [id, tab] of this.#tabs) if (tab.sessionId === sessionId) this.#tabs.delete(id);
				};
				return c;
			});
			this.#tabs.clear();
		}
		return this.#cdp!;
	}

	async targets() {
		const { targetInfos } = await (await this.#connection()).send("Target.getTargets");
		return (targetInfos as any[])
			.filter((t) => t.type === "page")
			.map((t) => ({ tab: t.targetId as string, url: t.url as string, title: t.title as string, mine: this.#tabs.has(t.targetId) || this.#owned.has(t.targetId), owned: this.#owned.has(t.targetId) }));
	}

	async #exists(targetId: string) {
		const found = (await this.targets()).some((t) => t.tab === targetId);
		if (!found) {
			this.#tabs.delete(targetId);
			this.#owned.delete(targetId);
		}
		return found;
	}

	#attach(targetId: string, owned: boolean): Promise<Tab> {
		const cached = this.#tabs.get(targetId); // another call may have finished attaching meanwhile
		if (cached) return Promise.resolve(cached);
		const pending = this.#attaching.get(targetId);
		if (pending) return pending;
		const p = this.#attachNow(targetId, owned).finally(() => this.#attaching.delete(targetId));
		this.#attaching.set(targetId, p);
		return p;
	}

	async #attachNow(targetId: string, owned: boolean) {
		const cdp = await this.#connection();
		const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
		const tab = new Tab(cdp, targetId, sessionId, owned);
		this.#settingUp.add(sessionId);
		try {
			await tab.send("Page.enable");
			// A background tab is "hidden": Chromium stops rendering it, and input that needs a frame (wheel, hover, link
			// navigation) stalls. Focus emulation makes it render as visible without switching the person's tab.
			await tab.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
			await tab.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
			await this.hooks.attached?.(tab);
		} catch (e) {
			this.#settingUp.delete(sessionId);
			throw e;
		}
		// The connection or the session may have died meanwhile: never cache a dead session.
		const alive = this.#settingUp.delete(sessionId);
		if (cdp.closed) throw new Error("CDP connection closed while attaching");
		if (!alive) throw new Error(`Chromium ended the session for ${targetId} while attaching`);
		this.#tabs.set(targetId, tab);
		return tab;
	}

	/**
	 * A new tab in its own browser window, opened without taking focus. A tab of its own window renders like a visible
	 * page; a background tab in the person's window does not, and its screenshots and wheel input stall.
	 */
	async open(url?: string) {
		const cdp = await this.#connection();
		const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true, background: true });
		this.#owned.add(targetId);
		try {
			const tab = await this.#attach(targetId, true);
			if (url) await tab.navigate(url);
			return tab;
		} catch (e) {
			// The tab exists (so the receipt is never "refused"): say which, so it can be used or closed.
			if (e instanceof ToolError) throw new ToolError(e.code, `${e.message} (tab ${targetId} was opened)`, { outcome: e.outcome === "refused" ? "unknown" : e.outcome, details: { ...e.details, tab: targetId } });
			throw new ToolError("BACKEND_ERROR", `${(e as Error).message} (tab ${targetId} was opened)`, { outcome: "unknown", details: { tab: targetId } });
		}
	}

	/** Work in a tab the person (or someone else) opened, named exactly. */
	async attach(targetId: string) {
		await this.#connection();
		const tab = this.#tabs.get(targetId);
		if (tab) return tab;
		if (!(await this.#exists(targetId))) throw new ToolError("TARGET_GONE", `no page with id ${targetId}; list tabs`);
		return this.#attach(targetId, this.#owned.has(targetId));
	}

	/** One of this process's tabs, still open. */
	async tab(targetId: string): Promise<Tab> {
		await this.#connection();
		const tab = this.#tabs.get(targetId);
		if (!tab && !this.#owned.has(targetId)) throw new ToolError("NOT_ATTACHED", `tab ${targetId} is not one of yours; open a tab, or attach to it explicitly`);
		if (!(await this.#exists(targetId))) throw new ToolError("TARGET_GONE", `tab ${targetId} was closed`);
		// Read the cache again: the session may have ended while the check ran.
		const live = this.#tabs.get(targetId);
		if (live) return live;
		if (!this.#owned.has(targetId)) throw new ToolError("NOT_ATTACHED", `the session for tab ${targetId} ended; attach to it again`);
		// A tab this process opened, after the connection was replaced or its session ended: attach again.
		return this.#attach(targetId, true);
	}

	async close(targetId: string) {
		if (!this.#owned.has(targetId)) {
			if (this.#tabs.has(targetId)) throw new ToolError("NOT_OWNED", `tab ${targetId} was attached, not opened by you; detach it instead`);
			throw new ToolError("NOT_ATTACHED", `tab ${targetId} is not one of yours`);
		}
		const cdp = await this.#connection();
		if (!(await this.#exists(targetId))) throw new ToolError("TARGET_GONE", `tab ${targetId} was already closed`);
		await cdp.send("Target.closeTarget", { targetId });
		this.#tabs.delete(targetId);
		this.#owned.delete(targetId);
	}

	async detach(targetId: string) {
		if (this.#owned.has(targetId)) throw new ToolError("BAD_ARGS", `you opened tab ${targetId}: close it instead`);
		const tab = this.#tabs.get(targetId);
		if (!tab) return;
		this.#tabs.delete(targetId);
		await tab.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
		await tab.cdp.send("Target.detachFromTarget", { sessionId: tab.sessionId }).catch(() => {});
	}

	ref(targetId: string, loaderId: string, backendId: number) {
		const key = `${targetId}:${loaderId}:${backendId}`;
		let ref = this.#keys.get(key);
		if (!ref) {
			ref = `p${++this.#n}.${this.#gen}`;
			this.#keys.set(key, ref);
			this.#refs.set(ref, { targetId, loaderId, backendId });
		}
		return ref;
	}

	/** A page ref -> its DOM node, refusing refs from another tab or an earlier document. */
	async node(tab: Tab, ref: string): Promise<number> {
		const rec = this.#refs.get(ref);
		if (!rec) throw new ToolError("STALE_REF", `unknown page ref ${ref}; page_observe first`);
		if (rec.targetId !== tab.targetId) throw new ToolError("BAD_ARGS", `${ref} belongs to tab ${rec.targetId}`);
		if ((await tab.loaderId()) !== rec.loaderId) throw new ToolError("STALE_REF", `the page navigated since ${ref} was observed; observe again`);
		await tab.objectId(rec.backendId, ref);
		return rec.backendId;
	}

	/** On exit: close the tabs this process opened, detach the ones it borrowed. */
	async closeAll() {
		if (!this.#cdp && !this.#owned.size) return; // never used the browser
		const cdp = await this.#connection().catch(() => undefined);
		if (cdp) {
			for (const targetId of this.#owned) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
			for (const tab of [...this.#tabs.values()]) if (!tab.owned) await this.detach(tab.targetId);
		}
		this.#owned.clear();
		this.#tabs.clear();
		void this.#cdp?.then((c) => c.close()).catch(() => {});
	}
}
