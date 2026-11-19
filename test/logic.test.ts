import assert from "node:assert/strict";
import { test } from "node:test";
import { matchRoots, stateNames, type Root } from "../src/atspi.ts";
import { checkFresh, plan, toScreen, type Capture } from "../src/capture.ts";
import { axToNodes, parseKey } from "../src/cdp.ts";
import { InputQueue, poll } from "../src/queue.ts";
import { filterNodes, formatTree, type UiNode } from "../src/tree.ts";
import { interpolate, isTypeable, parseWindows, xpropString } from "../src/x11.ts";

test("parseWindows reads xprop/xwininfo output, topmost first", () => {
	const text = `1920 1080
_NET_ACTIVE_WINDOW: window id # 0xa00002, 0x0
_NET_CLIENT_LIST_STACKING: window id # 0xe0002c, 0xa00002
@@ 0xe0002c
_NET_WM_PID = 42
_NET_WM_NAME = "\\346\\265\\213\\350\\257\\225 - Thunar"
WM_CLASS = "thunar", "Thunar"
_NET_WM_STATE = _NET_WM_STATE_HIDDEN
_NET_WM_WINDOW_TYPE = _NET_WM_WINDOW_TYPE_NORMAL
  Absolute upper-left X:  10
  Absolute upper-left Y:  20
  Width: 300
  Height: 200
  Map State: IsViewable
@@ 0xa00002
_NET_WM_PID = 7
_NET_WM_NAME = "Say \\"hi\\" - Chromium"
WM_CLASS = "chromium (/x)", "Chromium"
_NET_WM_STATE = _NET_WM_STATE_MAXIMIZED_HORZ, _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_FOCUSED
  Absolute upper-left X:  0
  Absolute upper-left Y:  27
  Width: 1920
  Height: 1053
  Map State: IsViewable
`;
	const r = parseWindows(text);
	assert.deepEqual(r.screen, { width: 1920, height: 1080 });
	assert.equal(r.active, "0xa00002");
	assert.equal(r.windows[0].id, "0xa00002");
	assert.equal(r.windows[0].title, 'Say "hi" - Chromium');
	assert.equal(r.windows[0].maximized, true);
	assert.equal(r.windows[0].active, true);
	assert.equal(r.windows[1].title, "测试 - Thunar");
	assert.equal(r.windows[1].class, "Thunar");
	assert.equal(r.windows[1].hidden, true);
	assert.deepEqual([r.windows[1].x, r.windows[1].y, r.windows[1].width, r.windows[1].height], [10, 20, 300, 200]);
	assert.equal(xpropString('"a\\\\b"'), "a\\b");
});

test("capture plan clips to the screen, scales down only, and maps back", () => {
	const p = plan({ width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 });
	assert.deepEqual(p.image, { width: 1280, height: 720 });
	assert.deepEqual(toScreen(p, 640, 360), { x: 960, y: 540 });
	assert.deepEqual(toScreen(p, 0, 0), { x: 0, y: 0 });
	const region = plan({ width: 1920, height: 1080 }, { x: 1800, y: 1000, width: 400, height: 200 });
	assert.deepEqual(region.source, { x: 1800, y: 1000, width: 120, height: 80 });
	assert.deepEqual(region.image, { width: 120, height: 80 });
	assert.deepEqual(toScreen(region, 10, 5), { x: 1810, y: 1005 });
	assert.throws(() => toScreen(p, 1280, 0), /outside/);
	assert.throws(() => plan({ width: 100, height: 100 }, { x: 200, y: 0, width: 10, height: 10 }), /outside/);
});

test("a capture goes stale when the screen or its window changes", () => {
	const c: Capture = { id: "c1", screen: { width: 1920, height: 1080 }, source: { x: 0, y: 0, width: 10, height: 10 }, image: { width: 10, height: 10 }, window: { id: "0x1", rect: { x: 0, y: 0, width: 10, height: 10 } } };
	checkFresh(c, { width: 1920, height: 1080 }, { x: 0, y: 0, width: 10, height: 10 });
	assert.throws(() => checkFresh(c, { width: 1440, height: 900 }), (e: any) => e.code === "CAPTURE_STALE");
	assert.throws(() => checkFresh(c, { width: 1920, height: 1080 }, { x: 5, y: 0, width: 10, height: 10 }), (e: any) => e.code === "CAPTURE_STALE");
});

test("matchRoots pairs by pid, then title and geometry, and refuses ties", () => {
	const win = (id: string, pid: number, title: string, x = 0) => ({ id, pid, title, x, y: 0, width: 100, height: 100 });
	const root = (ref: string, pid: number, name: string, x = 0): Root => ({ ref, app: "a", pid, role: "frame", name, box: [x, 0, 100, 100], states: [] });
	// sole window of a process: paired even without a title match
	assert.equal(matchRoots([win("0x1", 1, "A")], [root("r1", 1, "")]).get("0x1")!.root?.ref, "r1");
	// two windows, two roots: titles decide
	const m = matchRoots([win("0x1", 2, "Doc A"), win("0x2", 2, "Doc B")], [root("ra", 2, "Doc A"), root("rb", 2, "Doc B")]);
	assert.equal(m.get("0x1")!.root?.ref, "ra");
	assert.equal(m.get("0x2")!.root?.ref, "rb");
	// same title, geometry decides
	const g = matchRoots([win("0x1", 3, "X", 0), win("0x2", 3, "X", 500)], [root("r0", 3, "X", 0), root("r5", 3, "X", 500)]);
	assert.equal(g.get("0x2")!.root?.ref, "r5");
	// indistinguishable: no guess, candidates offered
	const t = matchRoots([win("0x1", 4, "X"), win("0x2", 4, "X")], [root("r1", 4, "X"), root("r2", 4, "X")]);
	assert.equal(t.get("0x1")!.root, undefined);
	assert.equal(t.get("0x1")!.candidates.length, 2);
	// another process's root never matches
	assert.equal(matchRoots([win("0x1", 5, "A")], [root("r1", 6, "A")]).get("0x1")!.root, undefined);
});

test("stateNames decodes both 32-bit words", () => {
	assert.deepEqual(stateNames([(1 << 12) | (1 << 24), 1 << (42 - 32)]), ["focused", "sensitive", "has_popup"]);
	assert.deepEqual(stateNames([1 << 6, 0]), ["defunct"]);
});

test("input queue runs one at a time and drops cancelled entries", async () => {
	const q = new InputQueue();
	const order: string[] = [];
	let release!: () => void;
	const first = q.run(undefined, () => new Promise<void>((r) => (release = () => (order.push("a"), r()))));
	const ctl = new AbortController();
	const second = q.run(ctl.signal, async () => void order.push("b"));
	const third = q.run(undefined, async () => void order.push("c"));
	ctl.abort();
	await new Promise((r) => setImmediate(r)); // the first entry starts on a microtask
	release();
	await first;
	await assert.rejects(second, (e: any) => e.code === "CANCELLED");
	await third;
	assert.deepEqual(order, ["a", "c"]);
});

test("poll returns the last value on timeout", async () => {
	let n = 0;
	const r = await poll(async () => ({ matched: ++n === 3, value: n }), { timeoutMs: 1000, intervalMs: 1 });
	assert.deepEqual([r.matched, r.value], [true, 3]);
	const t = await poll(async () => ({ matched: false, value: "x" }), { timeoutMs: 20, intervalMs: 5 });
	assert.deepEqual([t.matched, t.value], [false, "x"]);
});

test("drag paths are interpolated; typing is ASCII only", () => {
	const pts = interpolate([{ x: 0, y: 0 }, { x: 100, y: 0 }], 25);
	assert.deepEqual(pts.map((p) => p.x), [0, 25, 50, 75, 100]);
	assert.equal(isTypeable("hello\tworld\n"), true);
	assert.equal(isTypeable("你好"), false);
});

test("parseKey builds CDP key events", () => {
	assert.deepEqual(parseKey("Enter"), { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" });
	const sel = parseKey("Control+a");
	assert.equal(sel.modifiers, 2);
	assert.equal("text" in sel, false);
	assert.deepEqual((sel as any).commands, ["selectAll"]);
	assert.equal(parseKey("A").text, "A");
	assert.throws(() => parseKey("Hyper+a"), /modifier/);
	assert.throws(() => parseKey("Enterr"), /unknown key/);
});

test("axToNodes keeps named and interactive nodes and drops repeated text", () => {
	const ax = {
		nodes: [
			{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" }, backendDOMNodeId: 1, childIds: ["2", "4"] },
			{ nodeId: "2", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 2, childIds: ["3"], properties: [{ name: "focused", value: { value: true } }] },
			{ nodeId: "3", role: { value: "StaticText" }, name: { value: "Save" }, backendDOMNodeId: 3 },
			{ nodeId: "4", role: { value: "generic" }, backendDOMNodeId: 4, childIds: ["5"] },
			{ nodeId: "5", role: { value: "textbox" }, name: { value: "" }, value: { value: "hi" }, backendDOMNodeId: 5 },
		],
	};
	const nodes = axToNodes(ax, (id) => `p${id}`);
	assert.deepEqual(nodes.map((n) => [n.ref, n.role, n.depth]), [["p1", "RootWebArea", 0], ["p2", "button", 1], ["p5", "textbox", 1]]);
	assert.deepEqual(nodes[1].states, ["focused"]);
	assert.equal(nodes[2].value, "hi");
});

test("filterNodes and formatTree", () => {
	const nodes: UiNode[] = [
		{ ref: "a1", role: "frame", name: "Win", depth: 0, states: [] },
		{ ref: "a2", role: "push button", name: "OK", depth: 2, states: ["focused", "sensitive"], box: [1, 2, 3, 4] },
		{ ref: "a3", role: "label", name: "Name", depth: 2, states: [] },
	];
	assert.deepEqual(filterNodes(nodes, { role: "push button" }, () => true).map((n) => n.ref), ["a2"]);
	assert.deepEqual(filterNodes(nodes, { query: "nam" }, () => true).map((n) => n.ref), ["a3"]);
	assert.deepEqual(filterNodes(nodes, { states: ["focused"] }, () => true).map((n) => n.ref), ["a2"]);
	assert.equal(formatTree(nodes.slice(1, 2), { flat: true }), 'a2 push button "OK" @1,2 3x4 [focused]');
	assert.match(formatTree(nodes, { maxLines: 1 }), /2 more nodes/);
});
