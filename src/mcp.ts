// A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0): initialize, ping, tools/list, tools/call and
// cancellation. Only the tools capability is offered, so this is all a client needs.
import { createInterface } from "node:readline";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };
export type Tool = {
	name: string;
	description: string;
	inputSchema: object;
	outputSchema?: object;
	/** "action" tools change the desktop; an unexpected failure then means the input may have been sent. */
	kind: "action" | "read";
	run(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
};
export type ServerInfo = { name: string; version: string; instructions?: string; tools: Tool[] };

/** Default long edge of screenshots: below every model's resize limit (Claude 1568, pi's default 2000), so the model sees exactly these pixels. */
export const DEFAULT_MAX_EDGE = 1280;

/** How an action ended: refused = certainly not sent; unknown = may have been (partly) sent, do not blindly retry. */
export type Outcome = "delivered" | "refused" | "unknown";

/** An expected failure with a stable code that scripts can branch on. */
export class ToolError extends Error {
	readonly code: string;
	readonly outcome: Outcome;
	readonly details: Record<string, unknown>;
	constructor(code: string, message: string, options: { outcome?: Outcome; details?: Record<string, unknown> } = {}) {
		super(message);
		this.code = code;
		this.outcome = options.outcome ?? "refused";
		this.details = options.details ?? {};
	}
}

/** A successful result: data for scripts (structuredContent) plus a short text and optional image for the model. */
export function ok(data: Record<string, unknown>, text?: string, image?: { data: string; mimeType: string }): ToolResult {
	const content: Content[] = [{ type: "text", text: text ?? JSON.stringify(data) }];
	if (image) content.push({ type: "image", ...image });
	return { content, structuredContent: data };
}

export function errorResult(tool: Pick<Tool, "kind">, e: unknown): ToolResult {
	const err =
		e instanceof ToolError
			? e
			: new ToolError("BACKEND_ERROR", (e as Error)?.message ?? String(e), { outcome: tool.kind === "action" ? "unknown" : "refused" });
	const data = { outcome: err.outcome, code: err.code, message: err.message, ...err.details };
	return { content: [{ type: "text", text: `${err.code} (${err.outcome}): ${err.message}` }], structuredContent: data, isError: true };
}

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
	let stopped = false;

	/** The response to one message, or undefined for notifications and responses. */
	async function handle(msg: Message): Promise<object | undefined> {
		const { id, method, params } = msg;
		if (method === "notifications/cancelled") {
			running.get(params?.requestId)?.abort();
			return undefined;
		}
		if (id === undefined || id === null || !method) return undefined; // other notifications, or a client response
		const reply = (result: object) => ({ jsonrpc: "2.0", id, result });
		const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
		switch (method) {
			case "initialize":
				return reply({
					// Echo the client's version: this server uses nothing that differs between protocol versions.
					protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : LATEST_PROTOCOL,
					capabilities: { tools: {} },
					serverInfo: { name: info.name, version: info.version },
					...(info.instructions ? { instructions: info.instructions } : {}),
				});
			case "ping":
				return reply({});
			case "tools/list":
				return reply({
					tools: info.tools.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: t.inputSchema,
						...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
						annotations: t.kind === "read" ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
					})),
				});
			case "tools/call": {
				const tool = tools.get(params?.name);
				if (!tool) return fail(-32602, `unknown tool: ${params?.name}`);
				if (stopped) return reply(errorResult(tool, new ToolError("SHUTTING_DOWN", "the server is shutting down")));
				const controller = new AbortController();
				running.set(id, controller);
				try {
					return reply(await tool.run(params?.arguments ?? {}, controller.signal));
				} catch (e) {
					return reply(errorResult(tool, e));
				} finally {
					running.delete(id);
				}
			}
			default:
				return fail(-32601, `method not found: ${method}`);
		}
	}

	/** Refuse new calls and cancel running ones (on shutdown, so gestures release their buttons and keys). */
	const stop = () => {
		stopped = true;
		for (const c of running.values()) c.abort();
	};

	return { handle, stop };
}

/** Serve on stdin/stdout. Requests run concurrently; input tools serialize themselves through the input queue. */
export function serveStdio(server: ReturnType<typeof createServer>, onClose: () => void) {
	// stdout carries the protocol only: anything a library logs goes to stderr.
	console.log = console.info = console.debug = console.error;
	// The client may close the pipe first (it exits): stop writing and shut down, instead of dying on EPIPE mid-gesture.
	let broken = false;
	process.stdout.on("error", () => {
		broken = true;
		onClose();
	});
	const send = (msg: object) => !broken && process.stdout.write(`${JSON.stringify(msg)}\n`);
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
