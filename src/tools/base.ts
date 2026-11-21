// Shared by both servers (computer and browser): the page context and JSON-schema shorthands. Must not import the
// desktop modules (atspi, x11, capture): the browser server runs without X and D-Bus.
import type { Browser, PageCapture } from "../cdp.ts";
import type { InputQueue } from "../queue.ts";

export type PageCtx = { gen: string; browser: Browser; pageCaptures: Map<string, PageCapture>; queue: InputQueue };

// ---- schema shorthands ----
type S = Record<string, unknown>;
export const str = (description?: string, extra: S = {}): S => ({ type: "string", ...(description ? { description } : {}), ...extra });
export const num = (description?: string, extra: S = {}): S => ({ type: "number", ...(description ? { description } : {}), ...extra });
export const int = (description?: string, extra: S = {}): S => ({ type: "integer", ...(description ? { description } : {}), ...extra });
export const bool = (description?: string): S => ({ type: "boolean", ...(description ? { description } : {}) });
export const arr = (items: S, description?: string, extra: S = {}): S => ({ type: "array", items, ...(description ? { description } : {}), ...extra });
export const enm = (values: string[], description?: string): S => ({ type: "string", enum: values, ...(description ? { description } : {}) });
export const obj = (properties: Record<string, S>, required: string[] = []): S => ({ type: "object", properties, required, additionalProperties: false });
/** Output schemas describe the main fields; results may carry more. */
export const out = (properties: Record<string, S>, required: string[] = []): S => ({ type: "object", properties, required, additionalProperties: true });

export const rect = obj({ x: num(), y: num(), width: num(), height: num() }, ["x", "y", "width", "height"]);
export const RECEIPT = {
	outcome: enm(["delivered", "refused", "unknown"], "delivered = sent; refused = certainly not sent; unknown = may have been sent, do not blindly retry"),
	route: str("how it was sent: xtest, atspi-action, atspi-text, wm, spawn, cdp-input, cdp-dom, cdp-page"),
	verified: bool("present only when the effect was checked afterwards"),
	code: str("error code when not delivered"),
	message: str(),
};
export const receipt = (extra: Record<string, S> = {}) => out({ ...RECEIPT, ...extra }, ["outcome"]);
