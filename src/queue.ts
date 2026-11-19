// One pointer and one keyboard: every input runs alone, in arrival order. Waiting is not input and never queues.
import { ToolError } from "./mcp.ts";

export class InputQueue {
	#tail: Promise<unknown> = Promise.resolve();

	/** Run `fn` when the previous inputs are done. Cancelled while queued: refused, nothing is sent. */
	run<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
		const start = () => {
			if (signal?.aborted) throw new ToolError("CANCELLED", "cancelled before it was sent");
			return fn();
		};
		const next = this.#tail.then(start, start);
		this.#tail = next.catch(() => {});
		return next;
	}
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new ToolError("CANCELLED", "cancelled"));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new ToolError("CANCELLED", "cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Check `probe` until it returns a value or the timeout passes. A probe that throws ends the wait with that error.
 * Returns the last value and whether it matched.
 */
export async function poll<T>(
	probe: () => Promise<{ matched: boolean; value: T }>,
	options: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal },
): Promise<{ matched: boolean; value: T; elapsedMs: number }> {
	const start = Date.now();
	for (;;) {
		const { matched, value } = await probe();
		const elapsedMs = Date.now() - start;
		if (matched || elapsedMs >= options.timeoutMs) return { matched, value, elapsedMs };
		await sleep(Math.min(options.intervalMs ?? 200, options.timeoutMs - elapsedMs), options.signal);
	}
}
