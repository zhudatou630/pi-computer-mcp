// Desktop apps over AT-SPI (pure-JS D-Bus), plus X11 input and screenshots via xdotool/scrot from the computer image.
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import dbus from "dbus-next";
import type { UiNode } from "./tree.ts";

const run = promisify(execFile);
const ACC = "org.a11y.atspi.Accessible";
const ACT = "org.a11y.atspi.Action";
const TEXT = "org.a11y.atspi.Text";
const EDIT = "org.a11y.atspi.EditableText";
const COMP = "org.a11y.atspi.Component";
const PROP = "org.freedesktop.DBus.Properties";
const CALL_MS = 3000; // a single hung call can stall the whole accessibility bus, so every call is bounded
const MAX_NODES = 600;
const MAX_DEPTH = 32;
const PARALLEL = 16;
const STATE = { focused: 12, checked: 4, selected: 23, editable: 7, sensitive: 24 } as const;
const INTERACTIVE = new Set(["push button", "toggle button", "check box", "radio button", "menu item", "menu", "text", "entry", "password text", "combo box", "slider", "spin button", "link", "page tab", "tree item", "list item", "icon"]);

const SELECTABLE = new Set(["table cell", "list item", "tree item", "icon"]);

type Obj = { dest: string; path: string };
const unwrap = (v: any) => (v && typeof v === "object" && "signature" in v && "value" in v ? v.value : v);

export class Desktop {
	#bus?: Promise<any>;
	#refs = new Map<string, Obj>(); // ref -> object
	#keys = new Map<string, string>(); // dest+path -> ref, so a ref stays the same across snapshots
	#lock: Promise<unknown> = Promise.resolve();
	readonly display: string;

	constructor(display: string) {
		this.display = display;
	}

	/** Serialize desktop input: there is one pointer and one keyboard focus. */
	exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.#lock.then(fn, fn);
		this.#lock = next.catch(() => {});
		return next;
	}

	async #connect() {
		if (!this.#bus) {
			this.#bus = (async () => {
				const session = dbus.sessionBus();
				session.on("error", () => {}); // an unhandled "error" event would crash the server; the call below fails instead
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

	async #raw(bus: any, o: Obj, iface: string, member: string, signature = "", body: unknown[] = [], ms = CALL_MS): Promise<any[]> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`AT-SPI ${member} timed out`)), ms)));
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

	#ref(o: Obj) {
		const key = `${o.dest}${o.path}`;
		let ref = this.#keys.get(key);
		if (!ref) {
			ref = `d${this.#keys.size + 1}`;
			this.#keys.set(key, ref);
			this.#refs.set(ref, o);
		}
		return ref;
	}

	#obj(ref: string): Obj {
		const o = this.#refs.get(ref);
		if (!o) throw new Error(`unknown desktop ref ${ref}; look at the app again`);
		return o;
	}

	async apps(): Promise<{ name: string; obj: Obj }[]> {
		const [kids] = await this.#call({ dest: "org.a11y.atspi.Registry", path: "/org/a11y/atspi/accessible/root" }, ACC, "GetChildren");
		const apps = await Promise.all(kids.map(async ([dest, path]: [string, string]) => {
			const name = await this.#call({ dest, path }, PROP, "Get", "ss", [ACC, "Name"]).then((r) => String(unwrap(r[0])), () => "");
			return { name, obj: { dest, path } };
		}));
		return apps.filter((a) => a.name);
	}

	/** Window titles per app (top-level frames and dialogs). */
	async windows(): Promise<{ app: string; title: string; ref: string }[]> {
		const out: { app: string; title: string; ref: string }[] = [];
		for (const app of await this.apps()) {
			const [kids] = await this.#call(app.obj, ACC, "GetChildren").catch(() => [[]]);
			for (const [dest, path] of kids) {
				const o = { dest, path };
				const name = await this.#call(o, PROP, "Get", "ss", [ACC, "Name"]).then((r) => String(unwrap(r[0])), () => "");
				const role = await this.#call(o, ACC, "GetRoleName").then((r) => r[0], () => "");
				if (["frame", "dialog", "window", "alert", "file chooser"].includes(role)) out.push({ app: app.name, title: name, ref: this.#ref(o) });
			}
		}
		return out;
	}

	async #node(o: Obj, depth: number) {
		const [name, role, ifaces, state] = await Promise.all([
			this.#call(o, PROP, "Get", "ss", [ACC, "Name"]).then((r) => String(unwrap(r[0]) ?? "")),
			this.#call(o, ACC, "GetRoleName").then((r) => String(r[0])),
			this.#call(o, ACC, "GetInterfaces").then((r) => r[0] as string[], () => [] as string[]),
			this.#call(o, ACC, "GetState").then((r) => r[0] as number[], () => [0, 0]),
		]);
		const [box, actions, value, kids] = await Promise.all([
			ifaces.includes(COMP) ? this.#call(o, COMP, "GetExtents", "u", [0]).then((r) => r[0] as [number, number, number, number], () => undefined) : undefined,
			ifaces.includes(ACT) ? this.#call(o, ACT, "GetActions").then((r) => (r[0] as any[]).map((a) => String(Array.isArray(a) ? a[0] : a)), () => []) : [],
			ifaces.includes(TEXT) && ifaces.includes(EDIT) ? this.#text(o).catch(() => undefined) : undefined,
			this.#call(o, ACC, "GetChildren").then((r) => r[0] as [string, string][], () => []),
		]);
		const bits = Number(state[0] ?? 0);
		const has = (bit: number) => (bits & (1 << bit)) !== 0;
		return { o, depth, name, role, box, actions, value, kids, editable: ifaces.includes(EDIT), flags: (["focused", "checked", "selected"] as const).filter((f) => has(STATE[f])) as string[], sensitive: has(STATE.sensitive) };
	}

	async #text(o: Obj) {
		const n = Number(unwrap((await this.#call(o, PROP, "Get", "ss", [TEXT, "CharacterCount"]))[0]) || 0);
		return String((await this.#call(o, TEXT, "GetText", "ii", [0, Math.min(n, 2000)]))[0]);
	}

	/** Compact tree of an app (by name substring). Keeps nodes with a real on-screen box that are named or interactive. */
	async snapshot(appName: string): Promise<{ nodes: UiNode[]; truncated: boolean }> {
		const needle = appName.toLowerCase();
		const app = (await this.apps()).find((a) => a.name.toLowerCase().includes(needle));
		if (!app) throw new Error(`no running app matching "${appName}"; start it with the launch tool or call windows`);
		const out: UiNode[] = [];
		let level: { o: Obj; depth: number }[] = [{ o: app.obj, depth: 0 }];
		let visited = 0;
		let truncated = false;
		while (level.length) {
			const next: { o: Obj; depth: number }[] = [];
			for (let i = 0; i < level.length; i += PARALLEL) {
				const read = await Promise.all(level.slice(i, i + PARALLEL).map((x) => this.#node(x.o, x.depth).catch(() => undefined)));
				for (const n of read) {
					if (!n) continue;
					visited++;
					// GTK often leaves SHOWING unset on visible widgets; a real box is the reliable signal.
					const onScreen = n.box !== undefined && n.box[2] > 1 && n.box[3] > 1 && n.box[0] > -10_000;
					const interactive = n.editable || n.actions.length > 0 || INTERACTIVE.has(n.role);
					const unnamedCell = n.role === "table cell" && !n.name.trim();
					if (n.depth <= 1 || (onScreen && (n.name.trim() || interactive) && !unnamedCell)) {
						if (interactive && !n.sensitive) n.flags.push("disabled");
						out.push({ ref: this.#ref(n.o), role: n.role, name: n.name, depth: n.depth, ...(n.value ? { value: n.value } : {}), ...(n.box && onScreen ? { box: n.box } : {}), ...(n.flags.length ? { flags: n.flags } : {}) });
					}
					// Walk into off-screen containers too: GTK keeps real buttons inside 1x1 boxes.
					if (n.depth < MAX_DEPTH) for (const [dest, path] of n.kids.slice(0, 200)) next.push({ o: { dest, path }, depth: n.depth + 1 });
					else truncated = true;
				}
				if (visited + next.length > MAX_NODES) {
					truncated = true;
					break;
				}
			}
			level = truncated ? [] : next;
		}
		return { nodes: out, truncated };
	}

	/**
	 * Click an element: buttons and menus use their own AT-SPI action (no pointer needed); items in lists, tables and
	 * trees get a real pointer click, because their actions open/activate instead of selecting.
	 */
	async click(ref: string) {
		const o = this.#obj(ref);
		const role = String((await this.#call(o, ACC, "GetRoleName"))[0]);
		const actions = SELECTABLE.has(role) ? [] : await this.#call(o, ACT, "GetActions").then((r) => (r[0] as any[]).map((a) => String(Array.isArray(a) ? a[0] : a).toLowerCase()), () => [] as string[]);
		const index = ["click", "press", "activate", "toggle", "jump"].map((a) => actions.indexOf(a)).find((i) => i >= 0);
		if (index !== undefined) {
			await this.#call(o, ACT, "DoAction", "i", [index]);
			return "action";
		}
		const [x, y, w, h] = (await this.#call(o, COMP, "GetExtents", "u", [0]))[0] as number[];
		// no --sync: it waits for the pointer to move and hangs when it is already there
		await this.xdotool("mousemove", String(Math.round(x + w / 2)), String(Math.round(y + h / 2)), "click", "1");
		return "pointer";
	}

	/** Replace an editable field's text (works for any language, unlike synthesized keystrokes). Returns the text read back. */
	async setText(ref: string, text: string) {
		const o = this.#obj(ref);
		const [ok] = await this.#call(o, EDIT, "SetTextContents", "s", [text]).catch(() => {
			throw new Error(`${ref} is not an editable text field`);
		});
		if (!ok) throw new Error(`setting text on ${ref} failed`);
		return this.#text(o);
	}

	/** The app's newest visible X window (dialogs come last). */
	async #window(appName: string) {
		const needle = appName.toLowerCase();
		const app = (await this.apps()).find((a) => a.name.toLowerCase().includes(needle));
		if (!app) throw new Error(`no running app matching "${appName}"`);
		const [pid] = await this.#call({ dest: "org.freedesktop.DBus", path: "/org/freedesktop/DBus" }, "org.freedesktop.DBus", "GetConnectionUnixProcessID", "s", [app.obj.dest]);
		const { stdout } = await this.xdotool("search", "--onlyvisible", "--pid", String(pid)).catch(() => ({ stdout: "" }));
		const win = stdout.trim().split("\n").filter(Boolean).at(-1);
		if (!win) throw new Error(`"${appName}" has no visible window`);
		return win;
	}

	/** Raise the app's newest window so keystrokes reach it. */
	async activate(appName: string) {
		await this.xdotool("windowactivate", "--sync", await this.#window(appName));
	}

	/** Close the app's newest window the way the user would; the process (often shared, e.g. a daemon) keeps running. */
	async closeWindow(appName: string) {
		await this.xdotool("windowclose", await this.#window(appName));
	}

	async focus(ref: string) {
		await this.#call(this.#obj(ref), COMP, "GrabFocus").catch(() => {});
	}

	xdotool(...args: string[]) {
		return run("xdotool", args, { env: { ...process.env, DISPLAY: this.display }, timeout: 10_000 });
	}

	/** JPEG of the screen: a fraction of a PNG's size, and screenshots stay in the transcript for good. */
	async screenshot(): Promise<string> {
		const file = join(tmpdir(), `pi-bot-shot-${process.pid}-${Date.now()}.jpg`);
		await run("scrot", ["-o", "-q", "70", file], { env: { ...process.env, DISPLAY: this.display }, timeout: 10_000 });
		try {
			return (await readFile(file)).toString("base64");
		} finally {
			await rm(file, { force: true });
		}
	}

	close() {
		void this.#bus?.then((b) => b.disconnect()).catch(() => {});
	}
}
