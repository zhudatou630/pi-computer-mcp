import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, dropEmpty, type Tool } from "../src/mcp.ts";

const echo: Tool = {
	name: "echo",
	description: "echo",
	inputSchema: { type: "object" },
	annotations: { readOnlyHint: true },
	run: async (args) => ({ content: [{ type: "text", text: String(args.text) }] }),
};
const boom: Tool = { name: "boom", description: "fails", inputSchema: { type: "object" }, run: async () => { throw new Error("nope"); } };
const slow: Tool = {
	name: "slow",
	description: "waits until cancelled",
	inputSchema: { type: "object" },
	run: (_args, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")))),
};
const server = createServer({ name: "t", version: "1", instructions: "hi", tools: [echo, boom, slow] });

test("initialize echoes the client's protocol version and offers tools", async () => {
	const r: any = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
	assert.equal(r.result.protocolVersion, "2025-03-26");
	assert.deepEqual(r.result.capabilities, { tools: {} });
	assert.equal(r.result.instructions, "hi");
});

test("notifications get no reply; unknown methods get -32601", async () => {
	assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
	const r: any = await server.handle({ jsonrpc: "2.0", id: 2, method: "resources/list" });
	assert.equal(r.error.code, -32601);
});

test("tools/list and tools/call", async () => {
	const list: any = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
	assert.deepEqual(list.result.tools.map((t: any) => t.name), ["echo", "boom", "slow"]);
	assert.deepEqual(list.result.tools[0].annotations, { readOnlyHint: true });
	const call: any = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { text: "x" } } });
	assert.deepEqual(call.result, { content: [{ type: "text", text: "x" }] });
});

test("a failing tool is a tool error, an unknown tool a protocol error", async () => {
	const failed: any = await server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "boom" } });
	assert.equal(failed.result.isError, true);
	assert.equal(failed.result.content[0].text, "nope");
	const unknown: any = await server.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } });
	assert.equal(unknown.error.code, -32602);
});

test("notifications/cancelled aborts the running call", async () => {
	const pending = server.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "slow" } });
	await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
	const r: any = await pending;
	assert.equal(r.result.isError, true);
	assert.equal(r.result.content[0].text, "cancelled");
});

test("dropEmpty clears placeholders only for listed optional keys", () => {
	assert.deepEqual(dropEmpty({ target: "web", query: "", ref: null, text: "" }, ["query", "ref"]), { target: "web", text: "" });
	assert.deepEqual(dropEmpty({ args: [] }, ["args"]), {});
});
