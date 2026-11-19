// Waiting happens here because codemode scripts have no timers. Waits never hold the input queue.
import { isInteractive } from "../atspi.ts";
import { dropEmpty, ok, ToolError, type Tool } from "../mcp.ts";
import { poll, sleep } from "../queue.ts";
import { filterNodes, type UiNode } from "../tree.ts";
import * as x11 from "../x11.ts";
import { arr, bool, type Ctx, enm, int, obj, out, rootForWindow, str } from "./common.ts";

type Args = {
	condition: "time" | "window" | "element" | "page";
	timeoutMs?: number;
	ms?: number;
	gone?: boolean;
	// window
	title?: string;
	class?: string;
	pid?: number;
	id?: string;
	// element
	window?: string;
	app?: string;
	ref?: string;
	role?: string;
	name?: string;
	text?: string;
	states?: string[];
	// page
	tab?: string;
	selector?: string;
	url?: string;
	load?: boolean;
};

const nameMatches = (n: UiNode, a: Args) => (!a.name || n.name === a.name) && (!a.text || `${n.name} ${n.value ?? ""}`.toLowerCase().includes(a.text.toLowerCase()));

export function waitTool(ctx: Ctx): Tool {
	async function elementProbe(a: Args) {
		const onlyRef = a.ref && !a.role && !a.name && !a.text && !a.states?.length;
		if (onlyRef) {
			// The element itself: alive or gone.
			const alive = await ctx.atspi.check(a.ref!).then(() => true, (e) => (e instanceof ToolError && e.code === "STALE_REF" ? false : Promise.reject(e)));
			return { matched: a.gone ? !alive : alive, value: { alive, complete: true } };
		}
		const limits = { maxDepth: 32, maxNodes: 2000 };
		let result;
		if (a.window) {
			const r = await rootForWindow(ctx, a.window).catch((e) => (a.gone && e.code === "WINDOW_GONE" ? undefined : Promise.reject(e)));
			if (!r) return { matched: true, value: { matches: [], complete: true } }; // the whole window went away
			result = await ctx.atspi.observeRef(r.root.ref, limits);
		} else if (a.app) {
			const app = await ctx.atspi.appObj(a.app).catch((e) => (a.gone && e.code === "NOT_FOUND" ? undefined : Promise.reject(e)));
			if (!app) return { matched: true, value: { matches: [], complete: true } };
			result = await ctx.atspi.observe(app.o, limits);
		} else if (a.ref) {
			result = await ctx.atspi.observeRef(a.ref, limits);
		} else throw new ToolError("BAD_ARGS", "element waits need window, app or ref as the scope");
		const matches = filterNodes(result.nodes, { role: a.role, states: a.states }, isInteractive).filter((n) => nameMatches(n, a));
		const complete = result.coverage.complete;
		// Absence only counts when the whole scope was read.
		const matched = a.gone ? matches.length === 0 && complete : matches.length > 0;
		return { matched, value: { matches: matches.slice(0, 20), complete } };
	}

	async function windowProbe(a: Args) {
		const { windows } = await x11.listWindows();
		const id = a.id ? x11.normId(a.id) : undefined;
		const matches = windows.filter(
			(w) =>
				(!id || w.id === id) &&
				(!a.pid || w.pid === a.pid) &&
				(!a.title || w.title.toLowerCase().includes(a.title.toLowerCase())) &&
				(!a.class || `${w.class} ${w.instance}`.toLowerCase().includes(a.class.toLowerCase())),
		);
		return { matched: a.gone ? matches.length === 0 : matches.length > 0, value: { matches } };
	}

	async function pageProbe(a: Args) {
		if (!a.tab) throw new ToolError("BAD_ARGS", "page waits need tab");
		const tab = await ctx.browser.tab(a.tab);
		const check = `(() => ({
			url: location.href,
			ready: document.readyState,
			text: ${a.text ? `(document.body?.innerText ?? "").includes(${JSON.stringify(a.text)})` : "null"},
			selector: ${a.selector ? `!!document.querySelector(${JSON.stringify(a.selector)})` : "null"},
		}))()`;
		const s = (await tab.eval(check).catch(() => ({ url: "", ready: "loading", text: false, selector: false }))) as { url: string; ready: string; text: boolean | null; selector: boolean | null };
		const conds: boolean[] = [];
		if (a.text) conds.push(a.gone ? !s.text : !!s.text);
		if (a.selector) conds.push(a.gone ? !s.selector : !!s.selector);
		if (a.url) conds.push(s.url.includes(a.url));
		if (a.load) conds.push(s.ready === "complete");
		return { matched: conds.every(Boolean), value: { url: s.url, ready: s.ready } };
	}

	return {
		name: "wait",
		kind: "read",
		description: [
			"Wait (polling, default timeout 10 s, max 60 s) until a condition holds; matched=false on timeout is a normal result, not an error.",
			"time: ms. window: a window with title/class (substring), pid or id appears (gone=true: none left).",
			"element: within window | app | ref, a node with role/name (exact)/text (substring of name or value)/states appears (gone=true: disappears; only counted when the scope was read completely). With only ref: that element stays alive (gone=true: it goes away).",
			"page: in tab, text (in body text) / selector appears (gone=true: disappears), url contains, load (readyState complete); all given parts must hold.",
		].join("\n"),
		inputSchema: obj(
			{
				condition: enm(["time", "window", "element", "page"]),
				timeoutMs: int(undefined, { minimum: 0, maximum: 60000 }),
				ms: int("for time", { minimum: 0, maximum: 60000 }),
				gone: bool("wait for the thing to disappear instead"),
				title: str(),
				class: str(),
				pid: int(),
				id: str("X window id"),
				window: str("element scope: X window id"),
				app: str("element scope: app name"),
				ref: str("element scope, or the element itself"),
				role: str(),
				name: str(),
				text: str(),
				states: arr(str()),
				tab: str(),
				selector: str(),
				url: str(),
				load: bool(),
			},
			["condition"],
		),
		outputSchema: out({ matched: bool(), elapsedMs: int(), result: {} }, ["matched", "elapsedMs"]),
		async run(raw, signal) {
			const a = dropEmpty(raw, ["title", "class", "id", "window", "app", "ref", "role", "name", "text", "states", "tab", "selector", "url"]) as Args;
			if (a.condition === "time") {
				const ms = Math.min(a.ms ?? 0, 60_000);
				await sleep(ms, signal);
				return ok({ matched: true, elapsedMs: ms }, `waited ${ms} ms`);
			}
			const probe = a.condition === "window" ? windowProbe : a.condition === "element" ? elementProbe : a.condition === "page" ? pageProbe : undefined;
			if (!probe) throw new ToolError("BAD_ARGS", `unknown condition ${a.condition}`);
			const r = await poll<unknown>(() => probe(a), { timeoutMs: Math.min(a.timeoutMs ?? 10_000, 60_000), intervalMs: a.condition === "element" ? 300 : 200, signal });
			return ok({ matched: r.matched, elapsedMs: r.elapsedMs, result: r.value }, `${r.matched ? "matched" : "timed out"} after ${r.elapsedMs} ms: ${JSON.stringify(r.value).slice(0, 1500)}`);
		},
	};
}
