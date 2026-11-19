import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, dropEmpty, ok, ToolError, type Tool } from "../src/mcp.ts";

const echo: Tool = { name: "echo", kind: "read", description: "echo", inputSchema: { type: "object" }, outputSchema: { type: "object" }, run: async (args) => ok({ text: args.text }, String(args.text)) };
const refuse: Tool = { name: "refuse", kind: "action", description: "", inputSchema: { type: "object" }, run: async () => { throw new ToolError("STALE_REF", "gone", { details: { ref: "a1" } }); } };
const crash: Tool = { name: "crash", kind: "action", description: "", inputSchema: { type: "object" }, run: async () => { throw new Error("boom"); } };
const slow: Tool = {
	name: "slow",
	kind: "read",
	description: "waits until cancelled",
	inputSchema: { type: "object" },
	run: (_args, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new ToolError("CANCELLED", "cancelled")))),
};
const server = createServer({ name: "t", version: "1", instructions: "hi", tools: [echo, refuse, crash, slow] });
const call = (name: string, args = {}, id = 1): Promise<any> => server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) as any;

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

test("tools/list carries output schemas and read/action hints", async () => {
	const r: any = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
	const [e, f] = r.result.tools;
	assert.deepEqual(e.outputSchema, { type: "object" });
	assert.equal(e.annotations.readOnlyHint, true);
	assert.equal(f.annotations.readOnlyHint, false);
	assert.equal(f.outputSchema, undefined);
});

test("results carry structuredContent", async () => {
	const r = await call("echo", { text: "x" });
	assert.deepEqual(r.result.structuredContent, { text: "x" });
	assert.equal(r.result.content[0].text, "x");
});

test("expected failures are refused with a code; unexpected ones in actions are unknown", async () => {
	const refused = await call("refuse");
	assert.equal(refused.result.isError, true);
	assert.deepEqual(refused.result.structuredContent, { outcome: "refused", code: "STALE_REF", message: "gone", ref: "a1" });
	const crashed = await call("crash");
	assert.equal(crashed.result.structuredContent.outcome, "unknown");
	assert.equal(crashed.result.structuredContent.code, "BACKEND_ERROR");
	const unknown: any = await call("nope");
	assert.equal(unknown.error.code, -32602);
});

test("notifications/cancelled aborts the running call", async () => {
	const pending = call("slow", {}, 7);
	await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
	const r = await pending;
	assert.equal(r.result.structuredContent.code, "CANCELLED");
});

test("after stop, running calls are cancelled and new ones refused", async () => {
	const s = createServer({ name: "t", version: "1", tools: [echo, slow] });
	const pending = s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow", arguments: {} } }) as Promise<any>;
	s.stop();
	assert.equal((await pending).result.structuredContent.code, "CANCELLED");
	const later: any = await s.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "x" } } });
	assert.equal(later.result.structuredContent.code, "SHUTTING_DOWN");
});

test("dropEmpty clears placeholders only for listed optional keys", () => {
	assert.deepEqual(dropEmpty({ target: "web", query: "", ref: null, text: "" }, ["query", "ref"]), { target: "web", text: "" });
	assert.deepEqual(dropEmpty({ args: [] }, ["args"]), {});
});
