// One UI tree format for web pages (CDP) and desktop apps (AT-SPI): `ref role "name" [value] @x,y wxh`.

export type UiNode = {
	ref: string;
	role: string;
	name: string;
	depth: number;
	value?: string;
	box?: readonly [number, number, number, number];
	flags?: string[]; // e.g. focused, checked, disabled
};

export const MAX_TREE_LINES = 400;

export function formatNode(n: UiNode): string {
	const name = n.name.trim() ? ` ${JSON.stringify(n.name.trim().slice(0, 200))}` : "";
	const value = n.value?.trim() ? ` =${JSON.stringify(n.value.trim().slice(0, 200))}` : "";
	const box = n.box ? ` @${n.box[0]},${n.box[1]} ${n.box[2]}x${n.box[3]}` : "";
	const flags = n.flags?.length ? ` [${n.flags.join(",")}]` : "";
	return `${"  ".repeat(Math.min(n.depth, 10))}${n.ref} ${n.role}${name}${value}${box}${flags}`;
}

/** Format a tree; `query` keeps only matching lines (case-insensitive). */
export function formatTree(nodes: UiNode[], options: { query?: string; maxLines?: number } = {}): string[] {
	const max = options.maxLines ?? MAX_TREE_LINES;
	let lines = nodes.map(formatNode);
	if (options.query) {
		const q = options.query.toLowerCase();
		lines = lines.filter((l) => l.toLowerCase().includes(q)).map((l) => l.trimStart());
	}
	if (lines.length > max) lines = [...lines.slice(0, max), `… ${lines.length - max} more lines (use query to filter)`];
	return lines;
}

/**
 * What changed between two formatted trees, as `+ line` / `- line`. Refs are stable across snapshots, so a line diff
 * is meaningful. Falls back to the whole new tree when that is shorter than the diff.
 */
export function diffTree(before: readonly string[] | undefined, after: readonly string[]): string {
	if (!before) return after.join("\n");
	const old = new Set(before);
	const now = new Set(after);
	const removed = before.filter((l) => !now.has(l)).map((l) => `- ${l.trimStart()}`);
	const added = after.filter((l) => !old.has(l)).map((l) => `+ ${l.trimStart()}`);
	if (!removed.length && !added.length) return "(no visible change in the tree)";
	const diff = [...removed, ...added];
	return diff.length >= after.length ? after.join("\n") : `changes:\n${diff.join("\n")}`;
}
