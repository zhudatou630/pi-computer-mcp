// Web pages in the shared Chromium over CDP: only tabs this process opened or was told to attach to.
import { DEFAULT_MAX_EDGE } from "../capture.ts";
import { isPageInteractive, axToNodes, type Tab } from "../cdp.ts";
import { dropEmpty, ok, ToolError, type Tool } from "../mcp.ts";
import { filterNodes, formatTree } from "../tree.ts";
import { arr, bool, type Ctx, enm, int, num, obj, out, receipt, str } from "./common.ts";

const MAX_EVAL = 20_000;
const tabParam = str("Tab id from tabs (open or attach first)");
const tabOut = out({ tab: str(), url: str(), title: str(), mine: bool("opened or attached by you"), owned: bool("opened by you (close it when done)") });

/** CDP modifier bits from names. */
const modBits = (mods?: string[]) => (mods ?? []).reduce((b, m) => b | ({ alt: 1, ctrl: 2, control: 2, meta: 4, super: 4, shift: 8 }[m.toLowerCase()] ?? 0), 0);

export function pageTools(ctx: Ctx): Tool[] {
	let pageShots = 0;
	/** Target element -> viewport point, refusing when something else would receive the click. */
	async function target(tab: Tab, a: { ref?: string; selector?: string; x?: number; y?: number; captureId?: string }, needElement = true): Promise<{ x: number; y: number; backend?: number }> {
		if (a.ref || a.selector) {
			const label = a.ref ?? a.selector!;
			const backend = a.ref ? await ctx.browser.node(tab, a.ref) : await tab.select(a.selector!);
			const c = await tab.center(backend, label);
			if (!(await tab.hits(c.x, c.y, backend, label))) throw new ToolError("OCCLUDED", `${label} is covered by another element at its centre (a dialog, banner or overlay?)`, { details: { at: c } });
			return { ...c, backend };
		}
		if (a.x === undefined || a.y === undefined) {
			if (needElement) throw new ToolError("BAD_ARGS", "give ref, selector, or x and y");
			const v = await tab.viewport();
			return { x: v.width / 2, y: v.height / 2 };
		}
		if (a.captureId) {
			const c = ctx.pageCaptures.get(a.captureId);
			if (!c || c.targetId !== tab.targetId) throw new ToolError("CAPTURE_STALE", `unknown page capture ${a.captureId} for this tab; take a new page_screenshot`);
			const v = await tab.viewport();
			if (v.scrollX !== c.scrollX || v.scrollY !== c.scrollY || v.width !== c.width || v.height !== c.height) throw new ToolError("CAPTURE_STALE", "the page scrolled or resized since that screenshot; take a new one");
			return { x: a.x / c.scale, y: a.y / c.scale };
		}
		return { x: a.x, y: a.y };
	}

	return [
		{
			name: "tabs",
			kind: "action",
			description: "Browser tabs. list: every page in the shared Chromium (others' tabs are listed, never touched). open(url?): a new tab of yours, in its own browser window (opened without taking focus). attach(tab): work in a tab the person names (only when asked). close(tab): close a tab you opened. detach(tab): stop using an attached tab. Your opened tabs close when this server exits.",
			inputSchema: obj({ op: enm(["list", "open", "attach", "close", "detach"]), tab: str(), url: str() }, ["op"]),
			outputSchema: out({ tabs: arr(tabOut), tab: tabOut, outcome: str() }),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const a = dropEmpty(raw, ["tab", "url"]) as { op: string; tab?: string; url?: string };
					const need = () => {
						if (!a.tab) throw new ToolError("BAD_ARGS", `${a.op} needs tab`);
						return a.tab;
					};
					const describe = async (t: Tab) => ({ tab: t.targetId, ...(await t.info()), mine: true, owned: t.owned });
					if (a.op === "list") {
						const tabs = await ctx.browser.targets();
						return ok({ tabs }, tabs.map((t) => `${t.tab} ${t.mine ? (t.owned ? "[yours]" : "[attached]") : "[other]"} ${JSON.stringify(t.title)} ${t.url}`).join("\n"));
					}
					if (a.op === "open") {
						const t = await describe(await ctx.browser.open(a.url));
						return ok({ outcome: "delivered", tab: t }, `opened ${t.tab} ${t.url}`);
					}
					if (a.op === "attach") {
						const t = await describe(await ctx.browser.attach(need()));
						return ok({ outcome: "delivered", tab: t }, `attached to ${t.tab} ${t.url}`);
					}
					if (a.op === "close") await ctx.browser.close(need());
					else if (a.op === "detach") await ctx.browser.detach(need());
					else throw new ToolError("BAD_ARGS", `unknown op ${a.op}`);
					return ok({ outcome: "delivered" }, `${a.op}d ${a.tab}`);
				}),
		},
		{
			name: "page_observe",
			kind: "read",
			description: "A page's accessibility tree as `ref role \"name\" =value [states]` (refs p…). Filters return a flat list. Refs stay valid until the element leaves the DOM or the page navigates. For data, page_eval is often cheaper.",
			inputSchema: obj({ tab: tabParam, query: str("Keep nodes whose role, name or value contains this"), role: str('e.g. "button", "link", "textbox"'), states: arr(str()), interactiveOnly: bool(), maxNodes: int("default 600", { minimum: 10, maximum: 5000 }) }, ["tab"]),
			outputSchema: out({ url: str(), title: str(), nodes: arr(out({ ref: str(), role: str(), name: str(), value: str(), depth: int(), states: arr(str()) })), truncated: bool() }, ["url", "title", "nodes"]),
			async run(raw) {
				const a = dropEmpty(raw, ["query", "role", "states"]) as any;
				const tab = await ctx.browser.tab(a.tab);
				const [{ url, title }, loaderId, ax] = await Promise.all([tab.info(), tab.loaderId(), tab.send("Accessibility.getFullAXTree", {}, 30_000)]);
				let nodes = axToNodes(ax, (id) => ctx.browser.ref(tab.targetId, loaderId, id));
				const filtered = a.query || a.role || a.states || a.interactiveOnly;
				if (filtered) nodes = filterNodes(nodes, a, isPageInteractive);
				const max = a.maxNodes ?? 600;
				const truncated = nodes.length > max;
				nodes = nodes.slice(0, max);
				return ok({ url, title, nodes, truncated }, `${title} — ${url}\n${formatTree(nodes, { flat: !!filtered })}${truncated ? "\n… truncated" : ""}`);
			},
		},
		{
			name: "page_act",
			kind: "action",
			description: [
				"One action in your tab, with real input events where it matters.",
				"navigate(url) | back | forward | reload — wait for load (loaded=false if it timed out).",
				"click(target, button?, count?, modifiers?) | hover(target) — at the element's centre after scrolling it into view; refused (OCCLUDED) if something covers it.",
				"fill(target, text) replaces a field's text (any language), verified by reading the value back. type(text) inserts at the focus. press(keys) e.g. [\"Enter\"], [\"Control+a\"].",
				"select(target, value) picks an <option> by value or label. scroll(target?, dx?, dy?) wheel in CSS px.",
				"target = ref (from page_observe) | selector (CSS, must match exactly one) | x,y (viewport CSS px, or image px with captureId).",
			].join("\n"),
			inputSchema: obj(
				{
					tab: tabParam,
					op: enm(["navigate", "back", "forward", "reload", "click", "hover", "fill", "type", "press", "select", "scroll"]),
					ref: str(),
					selector: str(),
					x: num(),
					y: num(),
					captureId: str("x,y are pixels of this page_screenshot"),
					url: str(),
					text: str(),
					keys: arr(str()),
					value: str(),
					button: enm(["left", "middle", "right"]),
					count: int(undefined, { minimum: 1, maximum: 3 }),
					modifiers: arr(enm(["ctrl", "shift", "alt", "meta"])),
					dx: num(),
					dy: num(),
				},
				["tab", "op"],
			),
			outputSchema: receipt({ at: out({ x: num(), y: num() }), loaded: bool(), value: str("field value read back (fill/select)"), scroll: out({ x: num(), y: num() }, ) }),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const a = dropEmpty(raw, ["ref", "selector", "captureId", "url", "keys", "value", "button", "modifiers"]) as any;
					const tab = await ctx.browser.tab(a.tab);
					const done = (extra: Record<string, unknown>, text: string) => ok({ outcome: "delivered", route: "cdp-input", ...extra }, text);
					switch (a.op) {
						case "navigate": {
							if (!a.url) throw new ToolError("BAD_ARGS", "navigate needs url");
							const loaded = await tab.navigate(a.url);
							return done({ loaded }, `navigated to ${a.url}${loaded ? "" : " (still loading)"}`);
						}
						case "back":
						case "forward":
						case "reload": {
							if (a.op === "reload") await tab.send("Page.reload");
							else await tab.eval(`history.${a.op}()`);
							const loaded = await tab.waitForLoad();
							return done({ loaded }, `${a.op}: ${(await tab.info()).url}`);
						}
						case "click":
						case "hover": {
							const p = await target(tab, a);
							await tab.mouse(p.x, p.y, { button: a.button, count: a.count ?? 1, modifiers: modBits(a.modifiers), move: a.op === "hover" });
							return done({ at: { x: p.x, y: p.y } }, `${a.op} at ${Math.round(p.x)},${Math.round(p.y)}`);
						}
						case "fill": {
							if (!a.ref && !a.selector) throw new ToolError("BAD_ARGS", "fill needs ref or selector");
							const p = await target(tab, a);
							const id = await tab.objectId(p.backend!, a.ref ?? a.selector);
							await tab.callOn(id, "function(){ this.focus(); if (this.select) this.select(); else { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }");
							const text = String(a.text ?? "");
							if (text) await tab.send("Input.insertText", { text });
							else await tab.key("Backspace");
							const value = String(await tab.callOn(id, "function(){ return this.value ?? this.innerText }"));
							return done({ route: "cdp-input", verified: value === text, value: value.slice(0, 2000) }, `field is now ${JSON.stringify(value.slice(0, 200))}`);
						}
						case "type":
							if (!a.text) throw new ToolError("BAD_ARGS", "type needs text");
							await tab.send("Input.insertText", { text: a.text });
							return done({}, `inserted ${a.text.length} chars`);
						case "press": {
							const keys: string[] = a.keys ?? (a.text ? [a.text] : []);
							if (!keys.length) throw new ToolError("BAD_ARGS", "press needs keys");
							for (const k of keys) await tab.key(k);
							return done({}, `pressed ${keys.join(" ")}`);
						}
						case "select": {
							if (a.value === undefined) throw new ToolError("BAD_ARGS", "select needs value");
							const backend = a.ref ? await ctx.browser.node(tab, a.ref) : a.selector ? await tab.select(a.selector) : undefined;
							if (!backend) throw new ToolError("BAD_ARGS", "select needs ref or selector");
							const id = await tab.objectId(backend, a.ref ?? a.selector);
							const value = await tab.callOn(
								id,
								`function(v){ if (this.tagName !== "SELECT") throw new Error("not a <select>"); const o = [...this.options].find(o => o.value === v) ?? [...this.options].find(o => o.label.trim() === v); if (!o) throw new Error("no option " + v); this.value = o.value; this.dispatchEvent(new Event("input", {bubbles: true})); this.dispatchEvent(new Event("change", {bubbles: true})); return this.value }`,
								[a.value],
							).catch((e: Error) => {
								throw new ToolError("BAD_ARGS", e.message.split("\n")[0]);
							});
							return done({ route: "cdp-dom", verified: true, value }, `selected ${value}`);
						}
						case "scroll": {
							if (!a.dx && !a.dy) throw new ToolError("BAD_ARGS", "give dx and/or dy");
							const p = a.ref || a.selector || a.x !== undefined ? await target(tab, a) : await target(tab, {}, false);
							const before = await tab.viewport();
							await tab.wheel(p.x, p.y, a.dx ?? 0, a.dy ?? 0);
							// Wheel scrolling animates: report where it settles (or the last position after ~1 s).
							let last = before;
							for (let i = 0; i < 10; i++) {
								await new Promise((r) => setTimeout(r, 100));
								const now = await tab.viewport();
								if (now.scrollX === last.scrollX && now.scrollY === last.scrollY && (i > 1 || now.scrollY !== before.scrollY || now.scrollX !== before.scrollX)) break;
								last = now;
							}
							const scroll = { x: last.scrollX, y: last.scrollY };
							const moved = scroll.x !== before.scrollX || scroll.y !== before.scrollY;
							return done({ at: { x: p.x, y: p.y }, scroll, verified: moved }, `scrolled to ${scroll.x},${scroll.y}${moved ? "" : " (did not move: at the edge, or the target does not scroll)"}`);
						}
						default:
							throw new ToolError("BAD_ARGS", `unknown op ${a.op}`);
					}
				}),
		},
		{
			name: "page_eval",
			kind: "action",
			description: `Evaluate a JS expression in your tab's page (awaits promises) and return its JSON value (up to ${MAX_EVAL} chars). Runs as the page, with its login: reading is fine; prefer page_act for user-like changes.`,
			inputSchema: obj({ tab: tabParam, expression: str() }, ["tab", "expression"]),
			outputSchema: out({ value: {}, truncated: bool() }),
			async run(raw) {
				const tab = await ctx.browser.tab(String(raw.tab));
				const value = await tab.eval(String(raw.expression));
				const json = JSON.stringify(value) ?? "undefined";
				if (json.length <= MAX_EVAL) return ok({ value: value ?? null, truncated: false }, json);
				return ok({ value: json.slice(0, MAX_EVAL), truncated: true }, `${json.slice(0, MAX_EVAL)}… (${json.length} chars)`);
			},
		},
		{
			name: "page_screenshot",
			kind: "read",
			description: `JPEG of your tab's viewport, scaled to maxEdge (default ${DEFAULT_MAX_EDGE}). Use captureId with page_act x,y in image pixels.`,
			inputSchema: obj({ tab: tabParam, maxEdge: int(undefined, { minimum: 64, maximum: 2000 }) }, ["tab"]),
			outputSchema: out({ captureId: str(), scale: num("image px per CSS px"), viewport: out({ width: int(), height: int(), scrollX: num(), scrollY: num() }) }, ["captureId", "scale", "viewport"]),
			async run(raw) {
				const tab = await ctx.browser.tab(String(raw.tab));
				const shot = await tab.screenshot((raw.maxEdge as number) || DEFAULT_MAX_EDGE);
				const id = `s${++pageShots}.${ctx.gen}`;
				if (ctx.pageCaptures.size >= 32) ctx.pageCaptures.delete(ctx.pageCaptures.keys().next().value!);
				ctx.pageCaptures.set(id, { id, targetId: tab.targetId, scale: shot.scale, scrollX: shot.scrollX, scrollY: shot.scrollY, width: shot.width, height: shot.height });
				const viewport = { width: shot.width, height: shot.height, scrollX: shot.scrollX, scrollY: shot.scrollY };
				return ok({ captureId: id, scale: shot.scale, viewport }, `${id}: viewport ${shot.width}x${shot.height} at scale ${shot.scale.toFixed(3)}`, { data: shot.data, mimeType: "image/jpeg" });
			},
		},
	];
}
