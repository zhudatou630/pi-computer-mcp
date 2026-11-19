// Web pages in the shared Chromium over CDP: only tabs this process opened or was told to attach to.
import { DEFAULT_MAX_EDGE } from "../capture.ts";
import { isPageInteractive, axToNodes, parseKey, type Tab } from "../cdp.ts";
import { dropEmpty, ok, ToolError, type Tool } from "../mcp.ts";
import { filterNodes, formatTree, isFiltered } from "../tree.ts";
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
			if (a.x < 0 || a.y < 0 || a.x >= c.image.width || a.y >= c.image.height) throw new ToolError("BAD_ARGS", `point ${a.x},${a.y} is outside the ${c.image.width}x${c.image.height} image`);
			const [v, loaderId] = await Promise.all([tab.viewport(), tab.loaderId()]);
			if (loaderId !== c.loaderId) throw new ToolError("CAPTURE_STALE", "the page navigated since that screenshot; take a new one");
			if (v.scrollX !== c.scrollX || v.scrollY !== c.scrollY || v.width !== c.width || v.height !== c.height) throw new ToolError("CAPTURE_STALE", "the page scrolled or resized since that screenshot; take a new one");
			return { x: a.x / c.scale, y: a.y / c.scale };
		}
		return { x: a.x, y: a.y };
	}

	return [
		{
			name: "tabs",
			kind: "action",
			description: "Browser tabs. list: every page in the shared Chromium (others' tabs are listed, never touched). open(url?): a new tab of yours, in its own browser window (opened without taking focus; a page_act click later activates and raises that window, as a real click would). attach(tab): work in a tab the person names (only when asked). close(tab): close a tab you opened. detach(tab): stop using an attached tab. Your opened tabs close when this server exits.",
			inputSchema: obj({ op: enm(["list", "open", "attach", "close", "detach"]), tab: str(), url: str() }, ["op"]),
			outputSchema: out({ tabs: arr(tabOut), tab: tabOut, outcome: str() }),
			async run(raw, signal) {
				const a = dropEmpty(raw, ["tab", "url"]) as { op: string; tab?: string; url?: string };
				if (a.op === "list") {
					const tabs = await ctx.browser.targets();
					return ok({ tabs }, tabs.map((t) => `${t.tab} ${t.mine ? (t.owned ? "[yours]" : "[attached]") : "[other]"} ${JSON.stringify(t.title)} ${t.url}`).join("\n"));
				}
				return ctx.queue.run(signal, async () => {
					const need = () => {
						if (!a.tab) throw new ToolError("BAD_ARGS", `${a.op} needs tab`);
						return a.tab;
					};
					const describe = async (t: Tab) => ({ tab: t.targetId, ...(await t.info()), mine: true, owned: t.owned });
					if (a.op === "open") {
						const opened = await ctx.browser.open(a.url);
						// The tab exists now: a failure to describe it must not lose its id.
						const t = await describe(opened).catch(() => ({ tab: opened.targetId, url: "", title: "", mine: true, owned: true }));
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
				});
			},
		},
		{
			name: "page_observe",
			kind: "read",
			description: "A page's accessibility tree as `ref role \"name\" =value [states]` (refs p…). Filters return a flat list. Refs stay valid until the element leaves the DOM or the page navigates. For data, page_eval is often cheaper.",
			inputSchema: obj({ tab: tabParam, query: str("Keep nodes whose role, name or value contains this"), role: str('e.g. "button", "link", "textbox"'), name: str("exact name"), states: arr(str()), interactiveOnly: bool(), maxNodes: int("default 600", { minimum: 10, maximum: 5000 }) }, ["tab"]),
			outputSchema: out({ url: str(), title: str(), nodes: arr(out({ ref: str(), role: str(), name: str(), value: str(), depth: int(), states: arr(str()) })), truncated: bool() }, ["url", "title", "nodes"]),
			async run(raw) {
				const a = dropEmpty(raw, ["query", "role", "name", "states"]) as any;
				const tab = await ctx.browser.tab(a.tab);
				const [{ url, title }, loaderId, ax] = await Promise.all([tab.info(), tab.loaderId(), tab.send("Accessibility.getFullAXTree", {}, 30_000)]);
				let nodes = axToNodes(ax, (id) => ctx.browser.ref(tab.targetId, loaderId, id));
				const filtered = isFiltered(a);
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
				"fill(target, text) replaces a field's text (any language; text \"\" clears it), verified by reading the value back. type(text) inserts at the focus. press(keys) e.g. [\"Enter\"], [\"Control+a\"]; xdotool names (Return, ctrl+a, Down) work too. All keys are checked before any is sent.",
				"select(target, value) picks an <option> by value or label. scroll(target?, dx?, dy?) in CSS px: with a target, wheel there and report the scroll position of the element that scrolls; without one, scroll the document.",
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
			outputSchema: receipt({ at: out({ x: num(), y: num() }), loaded: bool(), value: str("field value read back (fill/select)"), scroll: out({ x: num(), y: num() }), scroller: enm(["document", "element"], "what scroll reports on") }),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const a = dropEmpty(raw, ["ref", "selector", "captureId", "url", "keys", "button", "modifiers"]) as any;
					const tab = await ctx.browser.tab(a.tab);
					const done = (extra: Record<string, unknown>, text: string) => ok({ outcome: "delivered", route: "cdp-input", ...extra }, text);
					switch (a.op) {
						case "navigate": {
							if (!a.url) throw new ToolError("BAD_ARGS", "navigate needs url");
							const loaded = await tab.navigate(a.url);
							return done({ route: "cdp-page", loaded }, `navigated to ${a.url}${loaded ? "" : " (still loading)"}`);
						}
						case "back":
						case "forward": {
							const r = await tab.history(a.op === "back" ? -1 : 1);
							return done({ route: "cdp-page", loaded: r.loaded }, `${a.op}: ${r.url}${r.loaded ? "" : " (still loading)"}`);
						}
						case "reload": {
							const loaded = await tab.reload();
							return done({ route: "cdp-page", loaded }, `reloaded${loaded ? "" : " (still loading)"}`);
						}
						case "click":
						case "hover": {
							const p = await target(tab, a);
							await tab.mouse(p.x, p.y, { button: a.button, count: a.count ?? 1, modifiers: modBits(a.modifiers), move: a.op === "hover" });
							return done({ at: { x: p.x, y: p.y } }, `${a.op} at ${Math.round(p.x)},${Math.round(p.y)}`);
						}
						case "fill": {
							if (!a.ref && !a.selector) throw new ToolError("BAD_ARGS", "fill needs ref or selector");
							if (typeof a.text !== "string") throw new ToolError("BAD_ARGS", 'fill needs text (text "" clears the field)');
							const p = await target(tab, a);
							const id = await tab.objectId(p.backend!, a.ref ?? a.selector);
							await tab.callOn(id, "function(){ this.focus(); if (this.select) this.select(); else { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }");
							const text: string = a.text;
							if (text) await tab.send("Input.insertText", { text });
							else await tab.key(parseKey("Backspace"));
							const value = String(await tab.callOn(id, "function(){ return this.value ?? this.innerText }"));
							return done({ route: "cdp-input", verified: value === text, value: value.slice(0, 2000) }, `field is now ${JSON.stringify(value.slice(0, 200))}`);
						}
						case "type":
							if (!a.text) throw new ToolError("BAD_ARGS", "type needs text");
							await tab.send("Input.insertText", { text: a.text });
							return done({}, `inserted ${a.text.length} chars`);
						case "press": {
							const keys: string[] = a.keys ?? [];
							if (!keys.length) throw new ToolError("BAD_ARGS", "press needs keys");
							const parsed = keys.map(parseKey); // all valid before the first is sent
							for (const k of parsed) await tab.key(k);
							return done({}, `pressed ${keys.join(" ")}`);
						}
						case "select": {
							if (typeof a.value !== "string") throw new ToolError("BAD_ARGS", "select needs value");
							const backend = a.ref ? await ctx.browser.node(tab, a.ref) : a.selector ? await tab.select(a.selector) : undefined;
							if (!backend) throw new ToolError("BAD_ARGS", "select needs ref or selector");
							const id = await tab.objectId(backend, a.ref ?? a.selector);
							// Checks come back as {error} before anything changes; a failure after that is not a refusal.
							const r = await tab.callOn(
								id,
								`function(v){ if (this.tagName !== "SELECT") return { error: "not a <select>" }; const o = [...this.options].find(o => o.value === v) ?? [...this.options].find(o => o.label.trim() === v); if (!o) return { error: "no option " + JSON.stringify(v) }; const wanted = o.index; this.selectedIndex = wanted; this.dispatchEvent(new Event("input", {bubbles: true})); this.dispatchEvent(new Event("change", {bubbles: true})); return { wanted, index: this.selectedIndex, value: this.value } }`,
								[a.value],
							);
							if (r.error) throw new ToolError("BAD_ARGS", r.error);
							// By index: options can share a value, and setting .value picks the first of them.
							const verified = r.index === r.wanted;
							return done({ route: "cdp-dom", verified, value: r.value }, `selected ${r.value}${verified ? "" : " (a different option is selected now: a change handler reset it?)"}`);
						}
						case "scroll": {
							if (!a.dx && !a.dy) throw new ToolError("BAD_ARGS", "give dx and/or dy");
							const dx = Number(a.dx ?? 0);
							const dy = Number(a.dy ?? 0);
							if (!(a.ref || a.selector || a.x !== undefined)) {
								const pos = (await tab.eval(`(() => { scrollBy({ left: ${dx}, top: ${dy}, behavior: "instant" }); return [scrollX, scrollY] })()`)) as [number, number];
								return done({ route: "cdp-dom", scroll: { x: pos[0], y: pos[1] }, scroller: "document" }, `document scrolled to ${pos[0]},${pos[1]}`);
							}
							const p = await target(tab, a);
							// Scroll chaining means any scrollable ancestor of the point (or the document) may move: watch them all and
							// report the one that did.
							const found = await tab.send("Runtime.evaluate", {
								// Same descent as the hit test: into open shadow roots, then up the composed ancestors (slots, hosts).
								expression: `(() => {
									const x = ${p.x}, y = ${p.y}, doc = document.scrollingElement, out = [];
									let hit = document.elementFromPoint(x, y);
									while (hit && hit.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
									for (let n = hit; n; n = n.assignedSlot || n.parentNode || n.host) {
										if (n.nodeType !== 1 || n === doc) continue;
										const s = getComputedStyle(n);
										if (/(auto|scroll|overlay)/.test(s.overflowX + s.overflowY) && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) out.push(n);
									}
									if (doc) out.push(doc);
									return out;
								})()`,
							});
							const chain = found.result.objectId as string;
							const read = async () => (await tab.callOn(chain, "function(){ return this.map(e => [e.scrollLeft, e.scrollTop]) }")) as [number, number][];
							const same = (x: [number, number][], y: [number, number][]) => x.every((v, i) => v[0] === y[i][0] && v[1] === y[i][1]);
							const before = await read();
							await tab.wheel(p.x, p.y, dx, dy);
							// Wheel scrolling animates: report where it settles (or the last position after ~1 s).
							let last = before;
							for (let i = 0; i < 10; i++) {
								await new Promise((r) => setTimeout(r, 100));
								const now = await read();
								if (same(now, last) && (i > 1 || !same(now, before))) break;
								last = now;
							}
							const movedAt = last.findIndex((v, i) => v[0] !== before[i][0] || v[1] !== before[i][1]);
							const at = movedAt >= 0 ? movedAt : 0;
							const scroller = at === last.length - 1 ? "document" : "element";
							const scroll = { x: last[at][0], y: last[at][1] };
							const moved = movedAt >= 0;
							return done({ at: { x: p.x, y: p.y }, scroll, scroller, verified: moved }, `${scroller} scrolled to ${scroll.x},${scroll.y}${moved ? "" : " (nothing moved: at its edge?)"}`);
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
				// The capture is only valid for the document it shows: refuse to issue an id if the page changed meanwhile.
				const loaderId = await tab.loaderId();
				const shot = await tab.screenshot((raw.maxEdge as number) || DEFAULT_MAX_EDGE);
				if ((await tab.loaderId()) !== loaderId) throw new ToolError("PAGE_CHANGED", "the page navigated while the screenshot was taken; take it again");
				const id = `s${++pageShots}.${ctx.gen}`;
				if (ctx.pageCaptures.size >= 32) ctx.pageCaptures.delete(ctx.pageCaptures.keys().next().value!);
				ctx.pageCaptures.set(id, { id, targetId: tab.targetId, loaderId, scale: shot.scale, image: shot.image, scrollX: shot.scrollX, scrollY: shot.scrollY, width: shot.width, height: shot.height });
				const viewport = { width: shot.width, height: shot.height, scrollX: shot.scrollX, scrollY: shot.scrollY };
				return ok({ captureId: id, scale: shot.scale, viewport }, `${id}: viewport ${shot.width}x${shot.height} at scale ${shot.scale.toFixed(3)}`, { data: shot.data, mimeType: "image/jpeg" });
			},
		},
	];
}
