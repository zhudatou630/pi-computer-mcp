// Desktop apps over AT-SPI (pure-JS D-Bus). Refs name D-Bus objects and stay the same across observations within
// one server process; before acting, a ref is checked to still be alive and of the same role.
import dbus from "dbus-next";
import { ToolError } from "./mcp.ts";
import type { UiNode } from "./tree.ts";

const ACC = "org.a11y.atspi.Accessible";
const ACT = "org.a11y.atspi.Action";
const TEXT = "org.a11y.atspi.Text";
const EDIT = "org.a11y.atspi.EditableText";
const COMP = "org.a11y.atspi.Component";
const VALUE = "org.a11y.atspi.Value";
const PROP = "org.freedesktop.DBus.Properties";
const CALL_MS = 3000; // a single hung call can stall the whole accessibility bus, so every call is bounded
const PARALLEL = 16;
const TOP_ROLES = new Set(["frame", "dialog", "window", "alert", "file chooser"]);
const INTERACTIVE = new Set(["button", "push button", "toggle button", "check box", "radio button", "menu item", "check menu item", "radio menu item", "menu", "text", "entry", "password text", "combo box", "slider", "spin button", "link", "page tab", "tree item", "list item", "table cell", "icon"]);

// AtspiStateType, in enum order (bit n of the 64-bit state set).
export const STATES = ["invalid", "active", "armed", "busy", "checked", "collapsed", "defunct", "editable", "enabled", "expandable", "expanded", "focusable", "focused", "has_tooltip", "horizontal", "iconified", "modal", "multi_line", "multiselectable", "opaque", "pressed", "resizable", "selectable", "selected", "sensitive", "showing", "single_line", "stale", "transient", "vertical", "visible", "manages_descendants", "indeterminate", "required", "truncated", "animated", "invalid_entry", "supports_autocompletion", "selectable_text", "is_default", "visited", "checkable", "has_popup", "read_only"];

export function stateNames(words: readonly number[]): string[] {
	const out: string[] = [];
	STATES.forEach((name, i) => {
		if ((Number(words[i >> 5] ?? 0) >>> (i & 31)) & 1) out.push(name);
	});
	return out;
}

export const isInteractive = (n: Pick<UiNode, "role" | "actions" | "states">) => INTERACTIVE.has(n.role) || !!n.actions?.length || n.states.includes("editable");

export type Obj = { dest: string; path: string };
export type Root = { ref: string; app: string; pid?: number; role: string; name: string; box?: [number, number, number, number]; states: string[] };
export type Coverage = { complete: boolean; visited: number; errors: number; truncatedBy?: "maxNodes" | "maxDepth" };

const unwrap = (v: any) => (v && typeof v === "object" && "signature" in v && "value" in v ? v.value : v);

/** The app did not answer in time: busy or hung, which is not the same as gone. */
class AtspiTimeout extends Error {}

export type Box = [number, number, number, number];
/** One element as read from the bus. `partial`: some of its reads failed; `statesUnknown`: its states could not be read. */
export type RawNode = { name: string; role: string; states: string[]; box?: Box; actions: string[]; value?: string; kids: Obj[]; partial: boolean; statesUnknown?: boolean };
export type WalkOptions = {
	maxDepth: number;
	/** Elements to read, failed reads included. */
	maxNodes: number;
	/** "default": on-screen elements that are named or interactive. "onScreen": every element with an on-screen box (for filters). */
	keep?: "default" | "onScreen";
};

const onScreen = (box?: Box) => box !== undefined && box[2] > 1 && box[3] > 1 && box[0] > -10_000;

/**
 * Breadth-first walk from `root`, reading at most maxNodes elements; when the budget runs out the elements read so far
 * are kept. GTK often leaves SHOWING unset, so an on-screen box is the visibility signal. The top two levels are always kept.
 */
export async function walk(root: Obj, read: (o: Obj) => Promise<RawNode>, refOf: (o: Obj, role: string) => string, options: WalkOptions): Promise<{ nodes: UiNode[]; coverage: Coverage }> {
	const nodes: UiNode[] = [];
	const coverage: Coverage = { complete: true, visited: 0, errors: 0 };
	let attempted = 0;
	let level = [{ o: root, depth: 0 }];
	while (level.length && coverage.truncatedBy !== "maxNodes") {
		const next: { o: Obj; depth: number }[] = [];
		for (let i = 0; i < level.length; ) {
			const room = options.maxNodes - attempted;
			if (room <= 0) {
				coverage.truncatedBy = "maxNodes";
				break;
			}
			const batch = level.slice(i, i + Math.min(PARALLEL, room));
			i += batch.length;
			attempted += batch.length;
			const results = await Promise.all(batch.map((x) => read(x.o).then((n) => ({ ...n, ...x }), () => undefined)));
			for (const n of results) {
				if (!n) {
					coverage.errors++;
					continue;
				}
				coverage.visited++;
				if (n.partial) coverage.errors++;
				const visible = onScreen(n.box);
				const node: UiNode = { ref: refOf(n.o, n.role), role: n.role, name: n.name, depth: n.depth, states: n.states, ...(n.actions.length ? { actions: n.actions } : {}) };
				if (n.value) node.value = n.value;
				if (visible) node.box = n.box;
				if (isInteractive(node) && !n.statesUnknown && !n.states.includes("sensitive")) node.states = [...node.states, "disabled"];
				const unnamedCell = n.role === "table cell" && !n.name;
				const keep = options.keep === "onScreen" ? visible : visible && (!!n.name || isInteractive(node)) && !unnamedCell;
				if (n.depth <= 1 || keep) nodes.push(node);
				// Walk into off-screen containers too: GTK keeps real buttons inside 1x1 boxes.
				if (n.depth < options.maxDepth) for (const o of n.kids) next.push({ o, depth: n.depth + 1 });
				else if (n.kids.length) coverage.truncatedBy ??= "maxDepth";
			}
		}
		level = next;
	}
	coverage.complete = !coverage.truncatedBy && coverage.errors === 0;
	return { nodes, coverage };
}

export class Atspi {
	#bus?: Promise<any>;
	#gen: string;
	#n = 0;
	#refs = new Map<string, { o: Obj; role: string; window?: string }>();
	#keys = new Map<string, string>(); // dest+path -> ref

	constructor(gen: string) {
		this.#gen = gen;
	}

	async #connect() {
		if (!this.#bus) {
			this.#bus = (async () => {
				const session = dbus.sessionBus();
				session.on("error", () => {}); // an unhandled "error" event would crash the server; the call fails instead
				try {
					const [address] = await this.#raw(session, { dest: "org.a11y.Bus", path: "/org/a11y/bus" }, "org.a11y.Bus", "GetAddress");
					const bus = dbus.sessionBus({ busAddress: address });
					bus.on("error", () => (this.#bus = undefined));
					return bus;
				} finally {
					session.disconnect();
				}
			})();
			this.#bus.catch(() => (this.#bus = undefined));
		}
		return this.#bus;
	}

	async #raw(bus: any, o: Obj, iface: string, member: string, signature = "", body: unknown[] = []): Promise<any[]> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new AtspiTimeout(`AT-SPI ${member} timed out`)), CALL_MS)));
		try {
			const reply = await Promise.race([bus.call(new dbus.Message({ destination: o.dest, path: o.path, interface: iface, member, signature, body })), timeout]);
			return reply.body;
		} finally {
			clearTimeout(timer);
		}
	}

	async #call(o: Obj, iface: string, member: string, signature = "", body: unknown[] = []) {
		return this.#raw(await this.#connect(), o, iface, member, signature, body);
	}

	#prop(o: Obj, iface: string, name: string) {
		return this.#call(o, PROP, "Get", "ss", [iface, name]).then((r) => unwrap(r[0]));
	}

	#ref(o: Obj, role: string, window?: string) {
		const key = `${o.dest}${o.path}`;
		let ref = this.#keys.get(key);
		if (!ref) {
			ref = `a${++this.#n}.${this.#gen}`;
			this.#keys.set(key, ref);
		}
		const prev = this.#refs.get(ref);
		this.#refs.set(ref, { o, role, window: window ?? prev?.window });
		return ref;
	}

	/** The window (X id) a ref was observed under, if known. */
	windowOf(ref: string) {
		return this.#refs.get(ref)?.window;
	}

	/** Resolve a ref and prove it still names the same live element. */
	async check(ref: string) {
		const rec = this.#refs.get(ref);
		if (!rec) {
			const other = /^a\d+\.(.+)$/.exec(ref)?.[1];
			throw new ToolError("STALE_REF", other && other !== this.#gen ? `${ref} is from a previous server process; observe again` : `unknown ref ${ref}; observe first`);
		}
		const [role, state] = await Promise.all([
			this.#call(rec.o, ACC, "GetRoleName").then((r) => String(r[0])),
			this.#call(rec.o, ACC, "GetState").then((r) => stateNames(r[0])),
		]).catch((e) => {
			if (e instanceof AtspiTimeout) throw new ToolError("APP_BUSY", `the app of ${ref} did not answer within ${CALL_MS / 1000} s (busy, or a modal loop); try again`);
			// An error reply (unknown object, service gone) means the element is gone; anything else (the bus itself) does not.
			if (e instanceof dbus.DBusError) throw new ToolError("STALE_REF", `${ref} is gone (its window or app closed or rebuilt it); observe again`);
			throw e;
		});
		if (state.includes("defunct")) throw new ToolError("STALE_REF", `${ref} is defunct; observe again`);
		if (role !== rec.role) throw new ToolError("STALE_REF", `${ref} was a ${rec.role} and is now a ${role}; observe again`);
		return { o: rec.o, role, states: state, window: rec.window };
	}

	/** Apps on the bus, with their process ids. */
	/** `unreadable`: the app did not answer in time, so its name is not known. */
	async apps(): Promise<{ name: string; o: Obj; pid?: number; unreadable?: boolean }[]> {
		const [kids] = await this.#call({ dest: "org.a11y.atspi.Registry", path: "/org/a11y/atspi/accessible/root" }, ACC, "GetChildren");
		const apps = await Promise.all(
			(kids as [string, string][]).map(async ([dest, path]) => {
				const o = { dest, path };
				const [name, pid] = await Promise.all([
					this.#prop(o, ACC, "Name").then(String, (e) => (e instanceof AtspiTimeout ? undefined : "")),
					this.#call({ dest: "org.freedesktop.DBus", path: "/org/freedesktop/DBus" }, "org.freedesktop.DBus", "GetConnectionUnixProcessID", "s", [dest]).then((r) => Number(r[0]), () => undefined),
				]);
				return { name: name ?? "", o, ...(pid ? { pid } : {}), ...(name === undefined ? { unreadable: true } : {}) };
			}),
		);
		return apps.filter((a) => a.name || a.unreadable);
	}

	/** Top-level frames and dialogs of every app. */
	async roots(): Promise<Root[]> {
		const out: Root[] = [];
		await Promise.all(
			(await this.apps()).filter((app) => !app.unreadable).map(async (app) => {
				const [kids] = await this.#call(app.o, ACC, "GetChildren").catch(() => [[]]);
				await Promise.all(
					(kids as [string, string][]).slice(0, 50).map(async ([dest, path]) => {
						const o = { dest, path };
						const [role, name, states, box] = await Promise.all([
							this.#call(o, ACC, "GetRoleName").then((r) => String(r[0]), () => ""),
							this.#prop(o, ACC, "Name").then((v) => String(v).trim(), () => ""),
							this.#call(o, ACC, "GetState").then((r) => stateNames(r[0]), () => [] as string[]),
							this.#call(o, COMP, "GetExtents", "u", [0]).then((r) => r[0] as Box, () => undefined),
						]);
						if (TOP_ROLES.has(role)) out.push({ ref: this.#ref(o, role), app: app.name, ...(app.pid ? { pid: app.pid } : {}), role, name, ...(box ? { box } : {}), states });
					}),
				);
			}),
		);
		return out;
	}

	/** Remember which X window a root (and everything observed under it) belongs to. */
	bindWindow(ref: string, window: string) {
		const rec = this.#refs.get(ref);
		if (rec) rec.window = window;
	}

	async appObj(name: string): Promise<{ ref: string; name: string; o: Obj }> {
		const apps = await this.apps();
		const needle = name.toLowerCase();
		const exact = apps.filter((a) => a.name.toLowerCase() === needle);
		const matches = exact.length ? exact : apps.filter((a) => a.name && a.name.toLowerCase().includes(needle));
		const unreadable = apps.filter((a) => a.unreadable).length;
		if (!matches.length && unreadable) throw new ToolError("APP_BUSY", `no app matching "${name}" among those that answered; ${unreadable} did not answer in time`);
		if (!matches.length) throw new ToolError("NOT_FOUND", `no accessible app matching "${name}"`, { details: { apps: apps.map((a) => a.name) } });
		if (matches.length > 1) throw new ToolError("AMBIGUOUS", `${matches.length} apps match "${name}"`, { details: { candidates: matches.map((a) => a.name) } });
		return { ref: this.#ref(matches[0].o, "application"), name: matches[0].name, o: matches[0].o };
	}

	async #node(o: Obj): Promise<RawNode> {
		let partial = false;
		const soft = <T>(fallback: T) => () => ((partial = true), fallback);
		const [name, role, ifaces, states] = await Promise.all([
			this.#prop(o, ACC, "Name").then((v) => String(v ?? "").trim()),
			this.#call(o, ACC, "GetRoleName").then((r) => String(r[0])),
			this.#call(o, ACC, "GetInterfaces").then((r) => r[0] as string[], soft([] as string[])),
			this.#call(o, ACC, "GetState").then((r) => stateNames(r[0]), () => undefined),
		]);
		if (!states) partial = true;
		// Every read that decides whether a node is kept or matched counts: a gap must not look like absence.
		const [box, actions, value, kids] = await Promise.all([
			ifaces.includes(COMP) ? this.#call(o, COMP, "GetExtents", "u", [0]).then((r) => r[0] as Box, soft(undefined)) : undefined,
			ifaces.includes(ACT) ? this.#actions(o).catch(soft([] as string[])) : [],
			ifaces.includes(TEXT) && ifaces.includes(EDIT) ? this.#text(o, 500).then((t) => t.text, soft(undefined)) : undefined,
			this.#call(o, ACC, "GetChildren").then((r) => (r[0] as [string, string][]).map(([dest, path]) => ({ dest, path })), soft([] as Obj[])),
		]);
		return { name, role, states: states ?? [], box, actions, value, kids, partial, ...(states ? {} : { statesUnknown: true }) };
	}

	async #actions(o: Obj): Promise<string[]> {
		const [list] = await this.#call(o, ACT, "GetActions");
		return (list as any[]).map((a) => String(Array.isArray(a) ? a[0] : a));
	}

	async #text(o: Obj, max: number) {
		const count = Number((await this.#prop(o, TEXT, "CharacterCount")) || 0);
		const [text] = await this.#call(o, TEXT, "GetText", "ii", [0, Math.min(count, max)]);
		return { text: String(text), length: count, truncated: count > max };
	}

	async observe(root: Obj, options: WalkOptions & { window?: string }): Promise<{ nodes: UiNode[]; coverage: Coverage }> {
		return walk(root, (o) => this.#node(o), (o, role) => this.#ref(o, role, options.window), options);
	}

	async observeRef(ref: string, options: WalkOptions) {
		const { o, window } = await this.check(ref);
		return this.observe(o, { ...options, window });
	}

	async inspect(ref: string, maxText = 20_000) {
		const { o, role, states, window } = await this.check(ref);
		const ifaces: string[] = await this.#call(o, ACC, "GetInterfaces").then((r) => r[0], () => []);
		const [name, description, childCount, box, actions, text, value, caret, selection] = await Promise.all([
			this.#prop(o, ACC, "Name").then(String, () => ""),
			this.#prop(o, ACC, "Description").then(String, () => ""),
			this.#prop(o, ACC, "ChildCount").then(Number, () => undefined),
			ifaces.includes(COMP) ? this.#call(o, COMP, "GetExtents", "u", [0]).then((r) => r[0], () => undefined) : undefined,
			ifaces.includes(ACT) ? this.#actions(o).catch(() => []) : [],
			ifaces.includes(TEXT) ? this.#text(o, maxText).catch(() => undefined) : undefined,
			ifaces.includes(VALUE)
				? Promise.all(["CurrentValue", "MinimumValue", "MaximumValue"].map((p) => this.#prop(o, VALUE, p).then(Number, () => undefined))).then(([current, min, max]) => ({ current, min, max }))
				: undefined,
			ifaces.includes(TEXT) ? this.#prop(o, TEXT, "CaretOffset").then(Number, () => undefined) : undefined,
			ifaces.includes(TEXT) ? this.#selection(o) : undefined,
		]);
		return {
			ref,
			role,
			name,
			...(description ? { description } : {}),
			states,
			actions,
			interfaces: ifaces.map((i) => i.replace("org.a11y.atspi.", "")),
			...(box ? { box } : {}),
			...(text ? { text: text.text, textLength: text.length, textTruncated: text.truncated } : {}),
			...(caret !== undefined && caret >= 0 ? { caret } : {}),
			...(selection ? { selection } : {}),
			...(value ? { value } : {}),
			...(childCount !== undefined ? { childCount } : {}),
			...(window ? { window } : {}),
		};
	}

	async #selection(o: Obj) {
		try {
			const [n] = await this.#call(o, TEXT, "GetNSelections");
			if (!Number(n)) return undefined;
			const [start, end] = (await this.#call(o, TEXT, "GetSelection", "i", [0])).map(Number);
			const [text] = await this.#call(o, TEXT, "GetText", "ii", [start, Math.min(end, start + 2000)]);
			return { start, end, text: String(text) };
		} catch {
			return undefined;
		}
	}

	/** Run one of the element's own actions (no pointer). Returns the action name used. */
	async invoke(ref: string, action?: string): Promise<string> {
		const { o } = await this.check(ref);
		const actions = await this.#actions(o).catch(() => [] as string[]);
		const lower = actions.map((a) => a.toLowerCase());
		const index = action
			? lower.indexOf(action.toLowerCase())
			: (["click", "press", "activate", "toggle", "jump", "open"].map((a) => lower.indexOf(a)).find((i) => i >= 0) ?? (actions.length === 1 ? 0 : -1));
		if (index < 0) throw new ToolError("NO_ACTION", action ? `${ref} has no action "${action}"` : `${ref} has no default action`, { details: { actions } });
		const [done] = await this.#call(o, ACT, "DoAction", "i", [index]);
		if (!done) throw new ToolError("ACTION_FAILED", `the app declined action "${actions[index]}" on ${ref}`, { outcome: "unknown", details: { actions } });
		return actions[index];
	}

	/**
	 * Replace the text, or insert at the caret; optionally give the element keyboard focus first. Returns the text read
	 * back (first 20k chars) and, when it could be worked out, the text that was expected.
	 */
	async setText(ref: string, text: string, mode: "replace" | "insert", focus = false): Promise<{ text: string; expected?: string; focused?: boolean }> {
		const { o } = await this.check(ref);
		const ifaces: string[] = await this.#call(o, ACC, "GetInterfaces").then((r) => r[0], () => []);
		if (!ifaces.includes(EDIT)) throw new ToolError("NOT_EDITABLE", `${ref} is not an editable text field`);
		// Focus first: GTK entries select their whole text on focus, which would leave the new text selected.
		const focused = focus ? Boolean((await this.#call(o, COMP, "GrabFocus").catch(() => [false]))[0]) : undefined;
		let done: boolean;
		let expected: string | undefined = text;
		if (mode === "insert") {
			const before = ifaces.includes(TEXT) ? await this.#text(o, 20_000).catch(() => undefined) : undefined;
			const caret = ifaces.includes(TEXT) ? Number(await this.#prop(o, TEXT, "CaretOffset").catch(() => -1)) : -1;
			const at = caret >= 0 ? caret : (before?.length ?? 0);
			// AT-SPI offsets count code points.
			const chars = before && !before.truncated ? [...before.text] : undefined;
			expected = chars && at <= chars.length ? chars.slice(0, at).join("") + text + chars.slice(at).join("") : undefined;
			[done] = await this.#call(o, EDIT, "InsertText", "isi", [at, text, Buffer.byteLength(text)]);
		} else {
			[done] = await this.#call(o, EDIT, "SetTextContents", "s", [text]);
		}
		if (!done) throw new ToolError("ACTION_FAILED", `the app declined the text change on ${ref}`, { outcome: "unknown" });
		const back = await this.#text(o, 20_000);
		return { text: back.text, ...(expected !== undefined && !back.truncated ? { expected } : {}), ...(focused !== undefined ? { focused } : {}) };
	}

	/** Screen box of a live element; refuses elements without a real on-screen box. */
	async box(ref: string): Promise<[number, number, number, number]> {
		const { o } = await this.check(ref);
		const box = (await this.#call(o, COMP, "GetExtents", "u", [0]).catch(() => [undefined]))[0] as [number, number, number, number] | undefined;
		if (!box || box[2] <= 1 || box[3] <= 1 || box[0] < -10_000) throw new ToolError("NOT_VISIBLE", `${ref} has no on-screen box (scroll it into view or observe again)`);
		return box;
	}

	close() {
		void this.#bus?.then((b) => b.disconnect()).catch(() => {});
	}
}

/**
 * Pair X windows with AT-SPI roots. Same process is required; then title and geometry decide. A window whose best
 * candidates tie is ambiguous rather than guessed.
 */
export function matchRoots<W extends { id: string; pid?: number; title: string; x: number; y: number; width: number; height: number; active?: boolean }>(
	windows: W[],
	roots: Root[],
): Map<string, { root?: Root; candidates: Root[] }> {
	const score = (w: W, r: Root) => {
		let s = 0;
		if (r.name && r.name === w.title) s += 4;
		else if (r.name && w.title && (w.title.includes(r.name) || r.name.includes(w.title))) s += 2;
		if (r.box) {
			const d = Math.abs(r.box[0] - w.x) + Math.abs(r.box[1] - w.y) + Math.abs(r.box[2] - w.width) + Math.abs(r.box[3] - w.height);
			if (d <= 8) s += 2;
			else if (d <= 120) s += 1; // client-side decorations and shadows shift GTK frames a little
		}
		// Toolkits mark the focused toplevel "active": this tells apart look-alike windows when one of them is focused.
		if (w.active !== undefined && r.states.includes("active") === w.active) s += 1;
		return s;
	};
	const out = new Map<string, { root?: Root; candidates: Root[] }>();
	for (const w of windows) {
		const same = roots.filter((r) => r.pid !== undefined && r.pid === w.pid);
		const ranked = same.map((r) => ({ r, s: score(w, r) })).sort((a, b) => b.s - a.s);
		const sole = same.length === 1 && windows.filter((x) => x.pid === w.pid).length === 1;
		const best = ranked[0];
		const tie = ranked.length > 1 && ranked[1].s === best.s;
		out.set(w.id, { root: best && (sole || (best.s > 0 && !tie)) ? best.r : undefined, candidates: ranked.map((x) => x.r) });
	}
	// One root, one window: two windows claiming the same root are both ambiguous.
	const claims = new Map<string, number>();
	for (const m of out.values()) if (m.root) claims.set(m.root.ref, (claims.get(m.root.ref) ?? 0) + 1);
	for (const m of out.values()) if (m.root && claims.get(m.root.ref)! > 1) m.root = undefined;
	return out;
}
