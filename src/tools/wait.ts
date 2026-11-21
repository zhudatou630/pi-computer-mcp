// Waiting happens here because codemode scripts have no timers. Waits never hold the input queue.
import { isInteractive } from "../atspi.ts";
import { dropEmpty, ToolError, type Tool } from "../mcp.ts";
import { filterNodes, isFiltered } from "../tree.ts";
import * as x11 from "../x11.ts";
import { arr, bool, type Ctx, enm, int, obj, rootForWindow, str } from "./common.ts";
import { PAGE_WAIT_DOC, pageProbe, type PageWaitArgs, runWait, WAIT_INTRO, waitOutput } from "./wait-page.ts";

type Args = PageWaitArgs & {
	condition: "time" | "window" | "element" | "page";
	timeoutMs?: number;
	ms?: number;
	// window
	title?: string;
	class?: string;
	pid?: number;
	id?: string;
	exclude?: string[];
	// element
	window?: string;
	app?: string;
	ref?: string;
	role?: string;
	name?: string;
	query?: string;
	states?: string[];
};

export function waitTool(ctx: Ctx): Tool {
	async function elementProbe(a: Args) {
		if (a.text) throw new ToolError("BAD_ARGS", "element waits filter with query (substring of role, name or value) or name (exact), not text");
		const onlyRef = a.ref && !isFiltered(a);
		if (onlyRef) {
			// The element itself: alive or gone. An unknown ref (never observed by this process) was not read at all, so it
			// is an error, not "gone"; APP_BUSY is handled by the caller like any element wait.
			const alive = await ctx.atspi.check(a.ref!).then(
				() => true,
				(e) => (e instanceof ToolError && e.code === "STALE_REF" && e.details.reason !== "unknown" ? false : Promise.reject(e)),
			);
			return { matched: a.gone ? !alive : alive, value: { alive, complete: true } };
		}
		const limits = { maxDepth: 32, maxNodes: 2000, keep: "onScreen" as const };
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
		const matches = filterNodes(result.nodes, a, isInteractive);
		const complete = result.coverage.complete;
		// Absence only counts when the whole scope was read.
		const matched = a.gone ? matches.length === 0 && complete : matches.length > 0;
		return { matched, value: { matches: matches.slice(0, 20), complete } };
	}

	async function windowProbe(a: Args) {
		const { windows } = await x11.listWindows();
		const id = a.id ? x11.normId(a.id) : undefined;
		const exclude = new Set((a.exclude ?? []).map(x11.normId));
		const matches = windows.filter(
			(w) =>
				!exclude.has(w.id) &&
				(!id || w.id === id) &&
				(!a.pid || w.pid === a.pid) &&
				(!a.title || w.title.toLowerCase().includes(a.title.toLowerCase())) &&
				(!a.class || `${w.class} ${w.instance}`.toLowerCase().includes(a.class.toLowerCase())),
		);
		return { matched: a.gone ? matches.length === 0 : matches.length > 0, value: { matches } };
	}

	return {
		name: "wait",
		kind: "read",
		description: [
			WAIT_INTRO,
			"time: ms. window: a window with title/class (substring), pid or id appears, ignoring exclude ids (pass launch's existingWindows); gone=true: none left.",
			"element: within window | app | ref, an on-screen node with role/name (exact)/query (substring of role, name or value)/states appears (gone=true: disappears; only counted when the scope was read completely). query sees the first 500 characters of a field's value. With only ref: that element stays alive (gone=true: it goes away). A busy app or failed read never counts as gone.",
			PAGE_WAIT_DOC,
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
				exclude: arr(str(), "window ids to ignore, e.g. launch's existingWindows"),
				window: str("element scope: X window id"),
				app: str("element scope: app name"),
				ref: str("element scope, or the element itself"),
				role: str(),
				name: str("element: exact name"),
				query: str("element: substring of role, name or value"),
				text: str("page: text in the body"),
				states: arr(str()),
				tab: str(),
				selector: str(),
				url: str(),
				load: bool(),
			},
			["condition"],
		),
		outputSchema: waitOutput,
		async run(raw, signal) {
			const a = dropEmpty(raw, ["title", "class", "id", "exclude", "window", "app", "ref", "role", "name", "query", "text", "states", "tab", "selector", "url"]) as Args;
			const busyElement = (x: Args) =>
				elementProbe(x).catch((e) => (e instanceof ToolError && e.code === "APP_BUSY" ? { matched: false, value: { busy: true, complete: false } } : Promise.reject(e)));
			const probe = a.condition === "window" ? windowProbe : a.condition === "element" ? busyElement : a.condition === "page" ? (x: Args) => pageProbe(ctx.browser, x) : undefined;
			return runWait(a, probe && (() => probe(a)), signal, a.condition === "element" ? 300 : 200);
		},
	};
}
