// A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0): initialize, ping, tools/list, tools/call and
// cancellation. Only the tools capability is offered, so this is all a client needs.
import { createInterface } from "node:readline";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: Content[]; isError?: boolean };
export type Tool = {
	name: string;
	description: string;
	inputSchema: object;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
	run(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
};
export type ServerInfo = { name: string; version: string; instructions?: string; tools: Tool[] };

/** Models often fill optional parameters with "", [] or null: treat those as absent, only for the listed keys. */
export function dropEmpty(args: Record<string, unknown>, optional: readonly string[]): Record<string, unknown> {
	const isEmpty = (v: unknown) => v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);
	return Object.fromEntries(Object.entries(args).filter(([k, v]) => v !== undefined && !(optional.includes(k) && isEmpty(v))));
}

const LATEST_PROTOCOL = "2025-06-18";
type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

export function createServer(info: ServerInfo) {
	const tools = new Map(info.tools.map((t) => [t.name, t]));
	const running = new Map<string | number, AbortController>();

	/** The response to one message, or undefined for notifications and responses. */
	async function handle(msg: Message): Promise<object | undefined> {
		const { id, method, params } = msg;
		if (method === "notifications/cancelled") {
			running.get(params?.requestId)?.abort();
			return undefined;
		}
		if (id === undefined || id === null || !method) return undefined; // other notifications, or a client response
		const ok = (result: object) => ({ jsonrpc: "2.0", id, result });
		const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
		switch (method) {
			case "initialize":
				return ok({
					// Echo the client's version: this server uses nothing that differs between protocol versions.
					protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : LATEST_PROTOCOL,
					capabilities: { tools: {} },
					serverInfo: { name: info.name, version: info.version },
					...(info.instructions ? { instructions: info.instructions } : {}),
				});
			case "ping":
				return ok({});
			case "tools/list":
				return ok({ tools: info.tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
			case "tools/call": {
				const tool = tools.get(params?.name);
				if (!tool) return fail(-32602, `unknown tool: ${params?.name}`);
				const controller = new AbortController();
				running.set(id, controller);
				try {
					return ok(await tool.run(params?.arguments ?? {}, controller.signal));
				} catch (e) {
					return ok({ content: [{ type: "text", text: (e as Error).message ?? String(e) }], isError: true });
				} finally {
					running.delete(id);
				}
			}
			default:
				return fail(-32601, `method not found: ${method}`);
		}
	}

	return { handle };
}

/** Serve on stdin/stdout. Requests run concurrently; tools serialize themselves where they must. */
export function serveStdio(server: ReturnType<typeof createServer>, onClose: () => void) {
	// stdout carries the protocol only: anything a library logs goes to stderr.
	console.log = console.info = console.debug = console.error;
	const send = (msg: object) => process.stdout.write(`${JSON.stringify(msg)}\n`);
	const lines = createInterface({ input: process.stdin });
	lines.on("line", (line) => {
		if (!line.trim()) return;
		let msg: Message;
		try {
			msg = JSON.parse(line);
		} catch {
			send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
			return;
		}
		void server.handle(msg).then((reply) => reply && send(reply));
	});
	lines.on("close", onClose);
}
