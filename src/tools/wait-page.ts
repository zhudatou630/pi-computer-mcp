// The desktop-free part of wait (time and page conditions), shared by the computer and browser servers.
import type { Browser } from "../cdp.ts";
import { dropEmpty, ok, ToolError, type Tool, type ToolResult } from "../mcp.ts";
import { poll, sleep } from "../queue.ts";
import { bool, enm, int, obj, out, type PageCtx, str } from "./base.ts";

export type PageWaitArgs = { gone?: boolean; text?: string; tab?: string; selector?: string; url?: string; load?: boolean };
type Probe = () => Promise<{ matched: boolean; value: unknown }>;

export const WAIT_INTRO = "Wait (polling, default timeout 10 s, max 60 s) until a condition holds; matched=false on timeout is a normal result, not an error.";
export const PAGE_WAIT_DOC = "page: in tab, text (in body text) / selector appears (gone=true: disappears), url contains, load (readyState complete); all given parts must hold. A failed read (mid-navigation) counts as no match.";
export const waitOutput = out({ matched: bool(), elapsedMs: int(), result: {} }, ["matched", "elapsedMs"]);

export async function pageProbe(browser: Browser, a: PageWaitArgs) {
	if (!a.tab) throw new ToolError("BAD_ARGS", "page waits need tab");
	if (!a.text && !a.selector && !a.url && !a.load) throw new ToolError("BAD_ARGS", "page waits need text, selector, url or load");
	const tab = await browser.tab(a.tab);
	const check = `(() => {
		let selector = null;
		if (${JSON.stringify(a.selector ?? null)} !== null) {
			try { selector = !!document.querySelector(${JSON.stringify(a.selector ?? "")}) } catch { return { badSelector: true } }
		}
		return { url: location.href, ready: document.readyState, selector, text: ${a.text ? `(document.body?.innerText ?? "").includes(${JSON.stringify(a.text)})` : "null"} };
	})()`;
	// A failed read (e.g. mid-navigation) proves nothing either way: no match, keep polling.
	const s = (await tab.eval(check).catch(() => undefined)) as { url: string; ready: string; text: boolean | null; selector: boolean | null; badSelector?: true } | undefined;
	if (s?.badSelector) throw new ToolError("BAD_ARGS", `bad selector ${a.selector}`);
	if (!s) return { matched: false, value: { url: "", ready: "unknown" } };
	const conds: boolean[] = [];
	if (a.text) conds.push(a.gone ? !s.text : !!s.text);
	if (a.selector) conds.push(a.gone ? !s.selector : !!s.selector);
	if (a.url) conds.push(s.url.includes(a.url));
	if (a.load) conds.push(s.ready === "complete");
	return { matched: conds.every(Boolean), value: { url: s.url, ready: s.ready } };
}

/** time sleeps; anything else polls `probe` (undefined: an unknown condition). */
export async function runWait(a: { condition: string; ms?: number; timeoutMs?: number }, probe: Probe | undefined, signal: AbortSignal, intervalMs = 200): Promise<ToolResult> {
	if (a.condition === "time") {
		const ms = Math.min(a.ms ?? 0, 60_000);
		await sleep(ms, signal);
		return ok({ matched: true, elapsedMs: ms }, `waited ${ms} ms`);
	}
	if (!probe) throw new ToolError("BAD_ARGS", `unknown condition ${a.condition}`);
	const r = await poll<unknown>(probe, { timeoutMs: Math.min(a.timeoutMs ?? 10_000, 60_000), intervalMs, signal });
	return ok({ matched: r.matched, elapsedMs: r.elapsedMs, result: r.value }, `${r.matched ? "matched" : "timed out"} after ${r.elapsedMs} ms: ${JSON.stringify(r.value).slice(0, 1500)}`);
}

export const NETWORK_QUIET_MS = 500;

/** Network idle: nothing in flight and no request activity for NETWORK_QUIET_MS, counted from the wait's start at the earliest. */
export function isNetworkIdle(n: { inflight: number; last: number }, waitStart: number, now: number) {
	return n.inflight === 0 && now - Math.max(n.last, waitStart) >= NETWORK_QUIET_MS;
}

/**
 * The browser server's wait: time and page conditions only. With `network` (requests per tab) page waits also take
 * networkIdle.
 */
export function pageWaitTool(ctx: Pick<PageCtx, "browser">, network: (tab: string) => { inflight: number; last: number } | undefined): Tool {
	async function probe(a: PageWaitArgs & { networkIdle?: boolean }, start: number) {
		if (!a.networkIdle) return pageProbe(ctx.browser, a);
		if (!a.tab) throw new ToolError("BAD_ARGS", "page waits need tab");
		const n = network(a.tab);
		if (!n) throw new ToolError("NOT_ATTACHED", `tab ${a.tab} is not one of yours; open it (or attach to it) with tabs first`);
		const page = a.text || a.selector || a.url || a.load ? await pageProbe(ctx.browser, a) : { matched: true, value: {} };
		return { matched: page.matched && isNetworkIdle(n, start, Date.now()), value: { ...page.value, inflight: n.inflight } };
	}
	return {
		name: "wait",
		kind: "read",
		description: [
			WAIT_INTRO,
			"time: ms.",
			PAGE_WAIT_DOC,
			`networkIdle (page): no request in flight for ${NETWORK_QUIET_MS} ms (WebSockets do not count; a page with a long-lived request such as SSE or long polling never gets there). Alone or with the other page parts; e.g. after a click that loads data.`,
		].join("\n"),
		inputSchema: obj(
			{
				condition: enm(["time", "page"]),
				timeoutMs: int(undefined, { minimum: 0, maximum: 60000 }),
				ms: int("for time", { minimum: 0, maximum: 60000 }),
				gone: bool("wait for the thing to disappear instead"),
				text: str("page: text in the body"),
				tab: str(),
				selector: str(),
				url: str(),
				load: bool(),
				networkIdle: bool(),
			},
			["condition"],
		),
		outputSchema: waitOutput,
		run(raw, signal) {
			const a = dropEmpty(raw, ["text", "tab", "selector", "url"]) as PageWaitArgs & { condition: string; networkIdle?: boolean };
			const start = Date.now();
			return runWait(a, a.condition === "page" ? () => probe(a, start) : undefined, signal);
		},
	};
}
