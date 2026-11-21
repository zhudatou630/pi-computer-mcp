// Console output, uncaught exceptions, browser log entries and failed requests, per tab, for the browser server.
// Fed with raw CDP events; holds a bounded buffer per tab.

export type LogEntry = { seq: number; time: number; source: "console" | "exception" | "log" | "network"; level: string; text: string; url?: string; line?: number; status?: number };
type NewEntry = Omit<LogEntry, "seq" | "time">;

const MAX_TEXT = 2000;
const MAX_REQUESTS = 2000;

/** Ring buffers per tab with one sequence across all tabs, so `since` is a cursor that never repeats. */
export class ConsoleLog {
	readonly max: number;
	#seq = 0;
	#tabs = new Map<string, { entries: LogEntry[]; lost: number }>();

	constructor(max = 500) {
		this.max = max;
	}

	/** Start collecting for a tab (reads of unknown tabs are refused). */
	watch(tab: string) {
		if (!this.#tabs.has(tab)) this.#tabs.set(tab, { entries: [], lost: 0 });
	}

	add(tab: string, e: NewEntry, time = Date.now()) {
		const buf = this.#tabs.get(tab);
		if (!buf) return;
		buf.entries.push({ seq: ++this.#seq, time, ...e, text: e.text.slice(0, MAX_TEXT) });
		if (buf.entries.length > this.max) buf.lost = buf.entries.shift()!.seq;
	}

	/**
	 * Entries after `since`; cursor is the value to pass as `since` next time. missed: entries after `since` were dropped
	 * by the size limit. clear empties the tab's buffer after reading.
	 */
	read(tab: string, o: { since?: number; errorsOnly?: boolean; clear?: boolean } = {}) {
		const buf = this.#tabs.get(tab);
		if (!buf) return undefined;
		const since = o.since ?? 0;
		const entries = buf.entries.filter((e) => e.seq > since && (!o.errorsOnly || e.level === "error"));
		const missed = buf.lost > since;
		if (o.clear) buf.entries = [];
		return { entries, cursor: this.#seq, missed };
	}
}

/** A RemoteObject (console argument) as short text. */
function argText(a: any): string {
	if (a.type === "string") return a.value;
	if (a.unserializableValue) return a.unserializableValue;
	if (a.value !== undefined) return JSON.stringify(a.value);
	if (a.preview?.properties) {
		const props = a.preview.properties.map((p: any) => (a.subtype === "array" ? p.value : `${p.name}: ${p.value}`)).join(", ");
		return `${a.description ?? a.className ?? ""} ${a.subtype === "array" ? `[${props}]` : `{${props}}`}${a.preview.overflow ? " …" : ""}`;
	}
	return a.description ?? a.type;
}

/** Routes CDP events from watched sessions into a ConsoleLog, and counts each tab's requests in flight. */
export class ConsoleCollector {
	readonly log: ConsoleLog;
	#sessions = new Map<string, string>();
	#requests = new Map<string, { url: string; method: string; tab: string }>();
	/** When each tab last started or ended a request (or was first watched). */
	#lastNet = new Map<string, number>();

	constructor(log = new ConsoleLog()) {
		this.log = log;
	}

	watch(sessionId: string, tab: string) {
		this.#sessions.set(sessionId, tab);
		this.log.watch(tab);
		this.#lastNet.set(tab, Date.now());
	}

	/** Requests in flight and the time of the last request activity; undefined for a tab never watched. */
	network(tab: string) {
		const last = this.#lastNet.get(tab);
		if (last === undefined) return undefined;
		let inflight = 0;
		for (const r of this.#requests.values()) if (r.tab === tab) inflight++;
		return { inflight, last };
	}

	event(method: string, p: any, sessionId?: string) {
		const tab = sessionId && this.#sessions.get(sessionId);
		if (!tab) return;
		const add = (e: NewEntry) => this.log.add(tab, e);
		const key = `${sessionId}:${p?.requestId}`;
		if (method.startsWith("Network.")) this.#lastNet.set(tab, Date.now());
		switch (method) {
			case "Runtime.consoleAPICalled": {
				const frame = p.stackTrace?.callFrames?.[0];
				const level = p.type === "error" || p.type === "assert" ? "error" : p.type === "warning" ? "warning" : p.type;
				add({ source: "console", level, text: (p.args ?? []).map(argText).join(" "), ...(frame?.url ? { url: frame.url, line: frame.lineNumber + 1 } : {}) });
				return;
			}
			case "Runtime.exceptionThrown": {
				const d = p.exceptionDetails ?? {};
				add({ source: "exception", level: "error", text: d.exception?.description ?? d.text ?? "exception", ...(d.url ? { url: d.url, line: d.lineNumber + 1 } : {}) });
				return;
			}
			case "Log.entryAdded": {
				const e = p.entry ?? {};
				// Failed loads also arrive as Network events, with the URL and method; other network entries (e.g. a failed
				// WebSocket handshake) only come here.
				if (e.source === "network" && e.text?.startsWith("Failed to load resource")) return;
				add({ source: "log", level: e.level === "verbose" ? "debug" : e.level, text: e.text ?? "", ...(e.url ? { url: e.url, ...(e.lineNumber !== undefined ? { line: e.lineNumber + 1 } : {}) } : {}) });
				return;
			}
			case "Network.requestWillBeSent":
				this.#requests.set(key, { url: p.request.url, method: p.request.method, tab });
				if (this.#requests.size > MAX_REQUESTS) this.#requests.delete(this.#requests.keys().next().value!);
				return;
			case "Network.responseReceived": {
				const r = p.response;
				if (r.status >= 400) add({ source: "network", level: "error", status: r.status, url: r.url, text: `${r.status} ${r.statusText || ""} ${this.#requests.get(key)?.method ?? "GET"} ${r.url} (${p.type})`.replace(/ +/g, " ") });
				return;
			}
			case "Network.loadingFailed": {
				const r = this.#requests.get(key);
				this.#requests.delete(key);
				const why = p.blockedReason ? ` (blocked: ${p.blockedReason})` : p.corsErrorStatus ? ` (CORS: ${p.corsErrorStatus.corsError})` : "";
				// A cancelled load is usually the page navigating away, not a fault.
				add({ source: "network", level: p.canceled ? "warning" : "error", text: `${p.errorText}${why} ${r?.method ?? ""} ${r?.url ?? `request ${p.requestId}`} (${p.type})`.replace(/ +/g, " "), ...(r ? { url: r.url } : {}) });
				return;
			}
			case "Network.loadingFinished":
				this.#requests.delete(key);
				return;
		}
	}
}
