import assert from "node:assert/strict";
import { test } from "node:test";
import { axToNodes } from "../src/computer/cdp.ts";
import { diffTree, formatTree, type UiNode } from "../src/computer/tree.ts";

const node = (ref: string, role: string, name: string, depth: number, extra: Partial<UiNode> = {}): UiNode => ({ ref, role, name, depth, ...extra });

test("formatTree renders one line per node and filters by query", () => {
	const nodes = [node("d1", "frame", "ws - Thunar", 0, { box: [0, 27, 1920, 1053] }), node("d2", "text", "", 1, { value: "hn.md", flags: ["focused"] })];
	assert.deepEqual(formatTree(nodes), ['d1 frame "ws - Thunar" @0,27 1920x1053', '  d2 text ="hn.md" [focused]']);
	assert.deepEqual(formatTree(nodes, { query: "HN.MD" }), ['d2 text ="hn.md" [focused]']);
	const many = Array.from({ length: 5 }, (_, i) => node(`d${i}`, "label", `x${i}`, 0));
	assert.equal(formatTree(many, { maxLines: 2 }).at(-1), "… 3 more lines (use query to filter)");
});

test("diffTree reports changed lines, or the whole tree when that is shorter", () => {
	const before = ["d1 frame", "  d2 cell \"a\"", "  d3 cell \"b\"", "  d4 cell \"c\""];
	const after = ["d1 frame", "  d2 cell \"a\" [selected]", "  d3 cell \"b\"", "  d4 cell \"c\""];
	assert.equal(diffTree(before, after), 'changes:\n- d2 cell "a"\n+ d2 cell "a" [selected]');
	assert.equal(diffTree(before, before), "(no visible change in the tree)");
	assert.equal(diffTree(undefined, after), after.join("\n"));
	assert.equal(diffTree(["x"], ["y", "z"]), "y\nz");
});

test("axToNodes keeps named/interactive nodes, link urls, and drops repeated text", () => {
	const v = (value: unknown) => ({ value });
	const ax = {
		nodes: [
			{ nodeId: "1", role: v("RootWebArea"), name: v("Page"), backendDOMNodeId: 1, childIds: ["2", "5", "6"] },
			{ nodeId: "2", role: v("button"), name: v("Go"), backendDOMNodeId: 2, childIds: ["3"] },
			{ nodeId: "3", role: v("StaticText"), name: v("Go"), backendDOMNodeId: 3, childIds: ["4"] },
			{ nodeId: "4", role: v("InlineTextBox"), name: v("Go"), backendDOMNodeId: 4 },
			{ nodeId: "5", role: v("link"), name: v("Docs"), backendDOMNodeId: 5, properties: [{ name: "url", value: v("https://x.test/docs") }] },
			{ nodeId: "6", role: v("generic"), name: v(""), ignored: true, backendDOMNodeId: 6, childIds: ["7"] },
			{ nodeId: "7", role: v("textbox"), name: v("Search"), backendDOMNodeId: 7, value: v("pi"), properties: [{ name: "focused", value: v(true) }] },
		],
	};
	assert.deepEqual(formatTree(axToNodes(ax)), [
		'w1 RootWebArea "Page"',
		'  w2 button "Go"',
		'  w5 link "Docs" ="https://x.test/docs"',
		'  w7 textbox "Search" ="pi" [focused]',
	]);
});
