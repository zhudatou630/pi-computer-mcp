// Windows (X11/EWMH) and desktop elements (AT-SPI).
import { spawn } from "node:child_process";
import { isInteractive, matchRoots } from "../atspi.ts";
import { dropEmpty, ok, ToolError, type Tool } from "../mcp.ts";
import { poll } from "../queue.ts";
import { filterNodes, formatTree, type UiNode } from "../tree.ts";
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
			description: "Manage a window: activate (raise + focus), close (polite, the app may ask to save), minimize, maximize, restore, move (x,y), resize (width,height). Reports whether the change was seen afterwards.",
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
					const check = async () => {
						const w = (await x11.listWindows()).windows.find((v) => v.id === id);
						const done =
							a.op === "close" ? !w
							: !w ? false
							: a.op === "activate" ? w.active
							: a.op === "minimize" ? w.hidden
							: a.op === "maximize" ? w.maximized
							: a.op === "restore" ? !w.maximized && !w.hidden
							: true;
						return { matched: done, value: w };
					};
					const r = await poll(check, { timeoutMs: a.op === "close" ? 2000 : 1500, intervalMs: 100, signal });
					const data = { outcome: "delivered", route: "wm", verified: r.matched, ...(r.value ? { window: r.value } : {}) };
					const note = r.matched ? "" : a.op === "close" ? " (still open: it may be asking to save)" : " (not confirmed)";
					return ok(data, `${a.op} ${id}: delivered${note}`);
				}),
		},
		{
			name: "launch",
			kind: "action",
			description: "Start a GUI program on the desktop as the desktop user, detached. Returns at once; use wait condition=window to wait for its window. Some apps (e.g. thunar) hand off to a running instance, so the window pid can differ.",
			inputSchema: obj({ command: str("Executable name or path"), args: arr(str()), cwd: str() }, ["command"]),
			outputSchema: receipt({ pid: int() }),
			async run(raw) {
				const a = dropEmpty(raw, ["args", "cwd"]) as { command: string; args?: string[]; cwd?: string };
				const child = spawn(a.command, a.args ?? [], { detached: true, stdio: "ignore", ...(a.cwd ? { cwd: a.cwd } : {}) });
				await new Promise<void>((resolve, reject) => {
					child.once("spawn", resolve);
					child.once("error", (e) => reject(new ToolError("LAUNCH_FAILED", `could not start ${a.command}: ${e.message}`)));
				});
				child.unref();
				return ok({ outcome: "delivered", route: "spawn", pid: child.pid }, `started ${a.command} (pid ${child.pid})`);
			},
		},
		{
			name: "observe",
			kind: "read",
			description: [
				"Read an accessibility tree: of a window (X id), an app (by name), or the subtree under a ref. Nodes are `ref role \"name\" =value @x,y wxh [states]`, boxes in screen px.",
				"Filters (query, role, states, interactiveOnly) return a flat list of matches. coverage.complete=false means the walk was cut short, so absence proves nothing.",
				"Refs stay valid across observations for the same element until it disappears.",
			].join(" "),
			inputSchema: obj({
				window: str('X window id ("0x…")'),
				app: str("App name as AT-SPI reports it (exact, else unique substring)"),
				ref: str("Observe the subtree under this element"),
				query: str("Keep nodes whose role, name or value contains this (case-insensitive)"),
				role: str('Keep nodes with exactly this AT-SPI role name, e.g. "button", "toggle button", "menu item", "table cell", "text", "label"'),
				states: arr(str(), 'Keep nodes having all these states, e.g. ["focused"], ["selected"]'),
				interactiveOnly: bool(),
				maxDepth: int("default 32", { minimum: 1, maximum: 64 }),
				maxNodes: int("nodes to visit, default 800", { minimum: 10, maximum: 4000 }),
			}),
			outputSchema: out({ root: out({ ref: str(), role: str(), name: str(), window: str() }), nodes: arr(nodeOut), coverage: coverageOut }, ["nodes", "coverage"]),
			async run(raw) {
				const a = dropEmpty(raw, ["window", "app", "ref", "query", "role", "states"]) as any;
				const limits = { maxDepth: a.maxDepth ?? 32, maxNodes: a.maxNodes ?? 800 };
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
				const filtered = a.query || a.role || a.states || a.interactiveOnly;
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
			description: "Write text into an editable element through AT-SPI (any language, no keyboard or input method involved): replace its whole text, or insert at the caret. Reads the text back; verified=true when it matches.",
			inputSchema: obj({ ref: str(), text: str(), mode: enm(["replace", "insert"], "default replace") }, ["ref", "text"]),
			outputSchema: receipt({ text: str("the field's text read back (first 2000 chars)") }),
			run: (raw, signal) =>
				ctx.queue.run(signal, async () => {
					const text = String(raw.text ?? "");
					const mode = raw.mode === "insert" ? "insert" : "replace";
					const back = await ctx.atspi.setText(String(raw.ref), text, mode);
					const verified = mode === "replace" ? back === text : back.includes(text);
					return ok({ outcome: "delivered", route: "atspi-text", verified, text: back.slice(0, 2000) }, `text is now ${JSON.stringify(back.slice(0, 300))}${verified ? "" : " (does not match: the app may have reformatted or rejected it)"}`);
				}),
		},
	];
}


