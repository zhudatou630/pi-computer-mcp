// Windows (X11/EWMH) and desktop elements (AT-SPI).
import { spawn } from "node:child_process";
import { isInteractive, matchRoots } from "../atspi.ts";
import { dropEmpty, ok, ToolError, type Tool } from "../mcp.ts";
import { poll } from "../queue.ts";
import { filterNodes, formatTree, isFiltered, type UiNode } from "../tree.ts";
import * as x11 from "../x11.ts";
import { arr, bool, type Ctx, enm, int, num, obj, out, receipt, rootForWindow, str } from "./common.ts";

const windowOut = out({ id: str(), pid: int(), title: str(), class: str(), instance: str(), type: str(), x: num(), y: num(), width: num(), height: num(), active: bool(), hidden: bool(), maximized: bool() });
const nodeOut = out({ ref: str(), role: str(), name: str(), depth: int(), value: str(), box: arr(num(), "[x, y, width, height] in screen px"), states: arr(str()), actions: arr(str()) });
const coverageOut = out({ complete: bool("false: the walk stopped early or reads failed, so a missing element may still exist"), visited: int(), errors: int(), truncatedBy: enm(["maxNodes", "maxDepth"]) });

export function desktopTools(ctx: Ctx): Tool[] {
	return [
		{
			name: "windows",
			kind: "read",
			description: "List top-level windows (topmost first) with id, pid, class, title, geometry and state, plus the screen size and active window. accessible=true also pairs each window with its AT-SPI root ref (or says why not).",
			inputSchema: obj({
				query: str("Only windows whose title or class contains this (case-insensitive)"),
				includeHidden: bool("Include minimized/unmapped windows (default true)"),
				accessible: bool("Pair windows with AT-SPI roots (slower)"),
			}),
			outputSchema: out({ screen: out({ width: int(), height: int() }), active: str(), windows: arr(windowOut) }, ["screen", "windows"]),
			async run(raw) {
				const a = dropEmpty(raw, ["query"]);
				const { screen, active, windows } = await x11.listWindows();
				const q = (a.query as string | undefined)?.toLowerCase();
				let list = windows.filter((w) => (a.includeHidden ?? true) || !w.hidden).filter((w) => !q || `${w.title} ${w.class} ${w.instance}`.toLowerCase().includes(q));
				if (a.accessible) {
					const pairs = matchRoots(windows, await ctx.atspi.roots());
					list = list.map((w) => {
						const m = pairs.get(w.id)!;
						if (m.root) ctx.atspi.bindWindow(m.root.ref, w.id);
						return { ...w, accessible: m.root ? m.root.ref : m.candidates.length ? "ambiguous" : "none" };
					});
				}
				const text = [`screen ${screen.width}x${screen.height}, active ${active ?? "none"}`, ...list.map((w) => `${w.id} ${w.class || w.instance} ${JSON.stringify(w.title)} @${w.x},${w.y} ${w.width}x${w.height}${w.active ? " [active]" : ""}${w.hidden ? " [hidden]" : ""}${"accessible" in w ? ` a11y=${(w as any).accessible}` : ""}`)].join("\n");
				return ok({ screen, ...(active ? { active } : {}), windows: list }, text);
			},
		},
		{
			name: "window",
			kind: "action",
			description: "Manage a window: activate (raise + focus), close (polite, the app may ask to save), minimize, maximize, restore, move (x,y of the client area, as windows reports it), resize (width,height of the client area). verified tells whether the requested state or geometry was seen afterwards (apps may round sizes; maximized windows ignore resize).",
			inputSchema: obj(
				{
					window: str('X window id ("0x…")'),
					op: enm(["activate", "close", "minimize", "maximize", "restore", "move", "resize"]),
					x: num(),
					y: num(),
					width: num(),
					height: num(),
				},
				["window", "op"],
			),
			outputSchema: receipt({ window: windowOut }),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const a = dropEmpty(raw, []) as { window: string; op: string; x?: number; y?: number; width?: number; height?: number };
					const id = x11.normId(a.window);
					await x11.windowOp(id, a.op, a);
					const round = (n?: number) => (n === undefined ? undefined : Math.round(n));
					const check = async () => {
						const w = (await x11.listWindows()).windows.find((v) => v.id === id);
						const done =
							a.op === "close" ? !w
							: !w ? false
							: a.op === "activate" ? w.active
							: a.op === "minimize" ? w.hidden
							: a.op === "maximize" ? w.maximized
							: a.op === "restore" ? !w.maximized && !w.hidden
							: a.op === "move" ? w.x === round(a.x) && w.y === round(a.y)
							: w.width === round(a.width) && w.height === round(a.height);
						return { matched: done, value: w };
					};
					// The op was sent: a cancel while confirming it must not turn the receipt into "refused".
					const r = await poll(check, { timeoutMs: a.op === "close" ? 2000 : 1500, intervalMs: 100, signal }).catch((e) => {
						if (e instanceof ToolError && e.code === "CANCELLED") return undefined;
						throw e;
					});
					if (!r) return ok({ outcome: "delivered", route: "wm" }, `${a.op} ${id}: delivered (cancelled before it was confirmed)`);
					const data = { outcome: "delivered", route: "wm", verified: r.matched, ...(r.value ? { window: r.value } : {}) };
					const note = r.matched ? "" : a.op === "close" ? " (still open: it may be asking to save)" : " (not confirmed)";
					return ok(data, `${a.op} ${id}: delivered${note}`);
				}),
		},
		{
			name: "launch",
			kind: "action",
			description: "Start a GUI program on the desktop as the desktop user, detached. Returns at once with the ids of the windows that already existed: pass them as exclude to wait condition=window so an old window does not count. Single-instance apps (mousepad, thunar) may hand off to a running instance: then the window pid differs, or no new window appears at all (mousepad opens a tab).",
			inputSchema: obj({ command: str("Executable name or path"), args: arr(str()), cwd: str() }, ["command"]),
			outputSchema: receipt({ pid: int(), existingWindows: arr(str(), "window ids present before the launch") }),
			async run(raw) {
				const a = dropEmpty(raw, ["args", "cwd"]) as { command: string; args?: string[]; cwd?: string };
				const existingWindows = [...(await x11.managedIds())];
				const child = spawn(a.command, a.args ?? [], { detached: true, stdio: "ignore", ...(a.cwd ? { cwd: a.cwd } : {}) });
				await new Promise<void>((resolve, reject) => {
					child.once("spawn", resolve);
					child.once("error", (e) => reject(new ToolError("LAUNCH_FAILED", `could not start ${a.command}: ${e.message}`)));
				});
				child.unref();
				return ok({ outcome: "delivered", route: "spawn", pid: child.pid, existingWindows }, `started ${a.command} (pid ${child.pid})`);
			},
		},
		{
			name: "observe",
			kind: "read",
			description: [
				"Read an accessibility tree: of a window (X id), an app (by name), or the subtree under a ref. Nodes are `ref role \"name\" =value @x,y wxh [states]`, boxes in screen px.",
				"Without filters: on-screen elements that are named or interactive. Filters (query, role, name, states, interactiveOnly) search every element with an on-screen box (unnamed containers too) and return a flat list. coverage.complete=false means the walk was cut short or reads failed, so absence proves nothing; raise maxNodes for big lists.",
				"Refs stay valid across observations for the same element until it disappears.",
			].join(" "),
			inputSchema: obj({
				window: str('X window id ("0x…")'),
				app: str("App name as AT-SPI reports it (exact, else unique substring)"),
				ref: str("Observe the subtree under this element"),
				query: str("Keep nodes whose role, name or value contains this (case-insensitive)"),
				role: str('Keep nodes with exactly this AT-SPI role name, e.g. "button", "toggle button", "menu item", "table cell", "text", "label"'),
				name: str("Keep nodes with exactly this name"),
				states: arr(str(), 'Keep nodes having all these states, e.g. ["focused"], ["selected"]'),
				interactiveOnly: bool(),
				maxDepth: int("default 32", { minimum: 1, maximum: 64 }),
				maxNodes: int("elements to read, default 800", { minimum: 10, maximum: 4000 }),
			}),
			outputSchema: out({ root: out({ ref: str(), role: str(), name: str(), window: str() }), nodes: arr(nodeOut), coverage: coverageOut }, ["nodes", "coverage"]),
			async run(raw) {
				const a = dropEmpty(raw, ["window", "app", "ref", "query", "role", "name", "states"]) as any;
				const filtered = isFiltered(a);
				const limits = { maxDepth: a.maxDepth ?? 32, maxNodes: a.maxNodes ?? 800, keep: filtered ? ("onScreen" as const) : ("default" as const) };
				const scopes = ["window", "app", "ref"].filter((k) => a[k] !== undefined);
				if (scopes.length !== 1) throw new ToolError("BAD_ARGS", "give exactly one of window, app, ref");
				let root: { ref: string; role: string; name: string; window?: string };
				let result;
				if (a.window) {
					const r = await rootForWindow(ctx, a.window);
					root = { ref: r.root.ref, role: r.root.role, name: r.root.name, window: r.window.id };
					result = await ctx.atspi.observeRef(r.root.ref, limits);
				} else if (a.app) {
					const app = await ctx.atspi.appObj(a.app);
					root = { ref: app.ref, role: "application", name: app.name };
					result = await ctx.atspi.observe(app.o, limits);
				} else {
					result = await ctx.atspi.observeRef(a.ref, limits);
					const top = result.nodes[0];
					root = { ref: a.ref, role: top?.role ?? "", name: top?.name ?? "", ...(ctx.atspi.windowOf(a.ref) ? { window: ctx.atspi.windowOf(a.ref) } : {}) };
				}
				const nodes: UiNode[] = filtered ? filterNodes(result.nodes, a, isInteractive) : result.nodes;
				const cov = result.coverage;
				const head = `${root.ref} ${root.role} ${JSON.stringify(root.name)}${root.window ? ` window ${root.window}` : ""} — ${nodes.length} nodes${cov.complete ? "" : ` (incomplete: ${cov.truncatedBy ?? `${cov.errors} read errors`})`}`;
				return ok({ root, nodes, coverage: cov }, `${head}\n${formatTree(nodes, { flat: !!filtered })}`);
			},
		},
		{
			name: "inspect",
			kind: "read",
			description: "Everything about one element: role, name, description, all states, action names, interfaces, box, full text (up to maxText chars, with textTruncated), caret, numeric value/min/max.",
			inputSchema: obj({ ref: str(), maxText: int("default 20000", { minimum: 1, maximum: 200000 }) }, ["ref"]),
			outputSchema: out({ ref: str(), role: str(), name: str(), description: str(), states: arr(str()), actions: arr(str()), interfaces: arr(str()), box: arr(num()), text: str(), textLength: int(), textTruncated: bool(), caret: int(), value: out({ current: num(), min: num(), max: num() }), childCount: int(), window: str() }, ["ref", "role", "name", "states"]),
			async run(raw) {
				const data = await ctx.atspi.inspect(String(raw.ref), (raw.maxText as number) || undefined);
				return ok(data, JSON.stringify(data).slice(0, 4000));
			},
		},
		{
			name: "invoke",
			kind: "action",
			description: "Run an element's own accessibility action (no pointer, works on covered windows): its default (click/press/activate/toggle/…) or a named one from inspect. Note: on list/table/tree items the default usually opens rather than selects; use click with the ref to select.",
			inputSchema: obj({ ref: str(), action: str("Action name; default picks click, press, activate, toggle, jump or open") }, ["ref"]),
			outputSchema: receipt({ action: str() }),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const action = await ctx.atspi.invoke(String(raw.ref), (dropEmpty(raw, ["action"]).action as string) || undefined);
					return ok({ outcome: "delivered", route: "atspi-action", action }, `${action} on ${raw.ref}: delivered`);
				}),
		},
		{
			name: "set_text",
			kind: "action",
			description: "Write text into an editable element through AT-SPI (any language, no keyboard or input method involved): replace its whole text, or insert at the caret. It does not move keyboard focus unless focus=true, so a following key (e.g. Return) goes to whatever had focus. Reads the text back; verified=true when it is exactly the expected text.",
			inputSchema: obj({ ref: str(), text: str(), mode: enm(["replace", "insert"], "default replace"), focus: bool("give the element keyboard focus first (e.g. to press Return in it afterwards)") }, ["ref", "text"]),
			outputSchema: receipt({ text: str("the field's text read back (first 2000 chars)"), focused: bool("present with focus=true: the app accepted the focus request") }),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const text = String(raw.text ?? "");
					const mode = raw.mode === "insert" ? "insert" : "replace";
					const r = await ctx.atspi.setText(String(raw.ref), text, mode, raw.focus === true);
					const verified = r.expected === undefined ? undefined : r.text === r.expected;
					const note = verified === false ? " (does not match: the app may have reformatted or rejected it)" : "";
					return ok(
						{ outcome: "delivered", route: "atspi-text", ...(verified !== undefined ? { verified } : {}), text: r.text.slice(0, 2000), ...(r.focused !== undefined ? { focused: r.focused } : {}) },
						`text is now ${JSON.stringify(r.text.slice(0, 300))}${note}${r.focused === false ? " (focus request declined)" : ""}`,
					);
				}),
		},
	];
}


