// The shared Chrome over CDP (Node's built-in WebSocket). Each Bot works in its own background tab.
import type { UiNode } from "./tree.ts";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class CdpConnection {
	#ws: WebSocket;
	#next = 0;
	#pending = new Map<number, Pending>();
	closed = false;

	constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (ev) => {
			const msg = JSON.parse(String(ev.data));
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
		throw new Error(`Chrome is not reachable at ${httpUrl} (${e.message})`);
	});
	const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
	const ws = new WebSocket(webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => (ws.close(), reject(new Error("CDP WebSocket did not open in 5 s"))), 5_000);
		ws.addEventListener("open", () => (clearTimeout(timer), resolve(undefined)), { once: true });
		ws.addEventListener("error", () => (clearTimeout(timer), reject(new Error("CDP WebSocket failed to open"))), { once: true });
	});
	return new CdpConnection(ws);
}

const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "slider", "tab", "menuitem", "option", "switch", "spinbutton"]);
const NOISE = new Set(["InlineTextBox", "LineBreak", "none", "generic", "presentation"]);

const axValue = (v: any) => (v && typeof v === "object" ? v.value : v);

/** Compact a CDP AX tree. Refs are `w<backendDOMNodeId>`, stable for the life of the DOM node. */
export function axToNodes(ax: { nodes: any[] }): UiNode[] {
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
			const flags = ["focused", "checked", "disabled", "expanded", "selected"].filter((f) => props[f] === true || props[f] === "true");
			const value = axValue(n.value);
			out.push({
				ref: `w${n.backendDOMNodeId}`,
				role,
				name,
				depth,
				...(typeof value === "string" && value ? { value } : {}),
				...(role === "link" && props.url ? { value: String(props.url) } : {}),
				...(flags.length ? { flags } : {}),
			});
		}
		for (const child of n.childIds ?? []) walk(child, keep ? depth + 1 : depth, keep ? name : parentName);
	};
	if (ax.nodes[0]) walk(ax.nodes[0].nodeId, 0, "");
	return out;
}

/** One Bot's tab. */
export class Tab {
	readonly cdp: CdpConnection;
	readonly targetId: string;
	readonly sessionId: string;
	constructor(cdp: CdpConnection, targetId: string, sessionId: string) {
		this.cdp = cdp;
		this.targetId = targetId;
		this.sessionId = sessionId;
	}

	send<T = any>(method: string, params: object = {}, timeoutMs?: number) {
		return this.cdp.send<T>(method, params, this.sessionId, timeoutMs);
	}

	async info() {
		const { targetInfo } = await this.cdp.send("Target.getTargetInfo", { targetId: this.targetId });
		return { url: targetInfo.url as string, title: targetInfo.title as string };
	}

	async waitForLoad(timeoutMs = 10_000) {
		const end = Date.now() + timeoutMs;
		await new Promise((r) => setTimeout(r, 300));
		while (Date.now() < end) {
			const state = await this.eval("document.readyState").catch(() => "loading");
			if (state === "complete") return;
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	async navigate(url: string) {
		const result = await this.send("Page.navigate", { url });
		if (result.errorText) throw new Error(`navigation failed: ${result.errorText}`);
		await this.waitForLoad();
	}

	async snapshot(): Promise<UiNode[]> {
		return axToNodes(await this.send("Accessibility.getFullAXTree", {}, 30_000));
	}

	async eval(expression: string): Promise<unknown> {
		const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	}

	async #call(ref: string, fn: string, args: unknown[] = []) {
		const backendNodeId = Number(/^w(\d+)$/.exec(ref)?.[1]);
		if (!backendNodeId) throw new Error(`not a web ref: ${ref}`);
		const { object } = await this.send("DOM.resolveNode", { backendNodeId }).catch(() => {
			throw new Error(`ref ${ref} is gone from the page; look again`);
		});
		const r = await this.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	}

	async click(ref: string) {
		await this.#call(ref, "function(){ this.scrollIntoView({block:'center'}); this.click(); }");
		await this.waitForLoad(5_000);
	}

	/** Replace a field's text the way typing would (works with framework-controlled inputs). */
	async setText(ref: string, text: string) {
		await this.#call(ref, "function(){ this.scrollIntoView({block:'center'}); this.focus(); if (this.select) this.select(); else document.execCommand('selectAll'); }");
		await this.send("Input.insertText", { text });
	}

	async key(key: string) {
		const named: Record<string, [string, number]> = { Enter: ["\r", 13], Tab: ["\t", 9], Escape: ["", 27], Backspace: ["", 8], ArrowDown: ["", 40], ArrowUp: ["", 38], PageDown: ["", 34], PageUp: ["", 33] };
		const [text, code] = named[key] ?? [key.length === 1 ? key : "", 0];
		await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, text, windowsVirtualKeyCode: code });
		await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code });
		await this.waitForLoad(5_000);
	}

	/** JPEG: a fraction of a PNG's size, and screenshots stay in the transcript for good. */
	async screenshot(): Promise<string> {
		return (await this.send("Page.captureScreenshot", { format: "jpeg", quality: 70 })).data;
	}
}

/** Lazily connected browser; tabs are created on first use and re-found by id after a server restart. */
export class Browser {
	#cdp?: Promise<CdpConnection>;
	#tabs = new Map<string, Promise<Tab>>();
	readonly httpUrl: string;
	constructor(httpUrl: string) {
		this.httpUrl = httpUrl;
	}

	async #connection() {
		const existing = this.#cdp && (await this.#cdp.catch(() => undefined));
		if (!existing || existing.closed) {
			this.#cdp = connect(this.httpUrl);
			this.#tabs.clear();
		}
		return this.#cdp!;
	}

	/** The tab for `owner`; `remembered`/`remember` persist its target id so a restart reuses the same tab. */
	async tab(owner: string, remembered: string | undefined, remember: (targetId: string) => void): Promise<Tab> {
		const cdp = await this.#connection();
		let tab = this.#tabs.get(owner);
		const cached = tab && (await tab.catch(() => undefined));
		if (cached) {
			// The person (or a crash) may have closed the tab while the connection stayed up: then attach afresh.
			const { targetInfos } = await cdp.send("Target.getTargets");
			if (!targetInfos.some((t: any) => t.targetId === cached.targetId)) {
				this.#tabs.delete(owner);
				tab = undefined;
				remembered = undefined;
			}
		}
		if (!tab) {
			tab = (async () => {
				const { targetInfos } = await cdp.send("Target.getTargets");
				let targetId = targetInfos.some((t: any) => t.targetId === remembered && t.type === "page") ? remembered : undefined;
				if (!targetId) {
					// background: never steal the tab the person is looking at in the shared browser
					targetId = (await cdp.send("Target.createTarget", { url: "about:blank", background: true })).targetId as string;
					remember(targetId);
				}
				const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
				const t = new Tab(cdp, targetId, sessionId);
				await t.send("Page.enable");
				return t;
			})();
			this.#tabs.set(owner, tab);
			tab.catch(() => this.#tabs.delete(owner));
		}
		return tab;
	}

	/** Close `owner`'s tab: the one in memory, or the remembered one when the server restarted since. */
	async closeTab(owner: string, remembered: string | undefined) {
		const tab = await this.#tabs.get(owner)?.catch(() => undefined);
		this.#tabs.delete(owner);
		const targetId = tab?.targetId ?? remembered;
		if (targetId) await (await this.#connection()).send("Target.closeTarget", { targetId }).catch(() => {});
	}

	close() {
		void this.#cdp?.then((c) => c.close()).catch(() => {});
	}
}
