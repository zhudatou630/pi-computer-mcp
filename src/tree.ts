// One compact tree format for desktop (AT-SPI) and page (CDP) elements: `ref role "name" =value @x,y wxh [flags]`.

export type UiNode = {
	ref: string;
	role: string;
	name: string;
	depth: number;
	value?: string;
	box?: readonly [number, number, number, number];
	states: string[]; // e.g. focused, checked, selected, disabled
	actions?: string[];
};

export const MAX_TREE_LINES = 400;
const SHOWN_STATES = new Set(["focused", "checked", "selected", "expanded", "disabled", "editable", "modal", "pressed", "indeterminate"]);

export function formatNode(n: UiNode, indent = true): string {
	const name = n.name.trim() ? ` ${JSON.stringify(n.name.trim().slice(0, 200))}` : "";
	const value = n.value?.trim() ? ` =${JSON.stringify(n.value.trim().slice(0, 200))}` : "";
	const box = n.box ? ` @${n.box[0]},${n.box[1]} ${n.box[2]}x${n.box[3]}` : "";
	const flags = n.states.filter((s) => SHOWN_STATES.has(s));
	return `${indent ? "  ".repeat(Math.min(n.depth, 12)) : ""}${n.ref} ${n.role}${name}${value}${box}${flags.length ? ` [${flags.join(",")}]` : ""}`;
}

export type Filter = { query?: string; role?: string; name?: string; states?: string[]; interactiveOnly?: boolean };

/** Keep nodes matching every given condition. `interactive` decides what counts as interactive for the source. */
export const isFiltered = (f: Filter) => !!(f.query || f.role || f.name || f.states?.length || f.interactiveOnly);

export function filterNodes(nodes: UiNode[], f: Filter, interactive: (n: UiNode) => boolean): UiNode[] {
	const q = f.query?.toLowerCase();
	return nodes.filter(
		(n) =>
			(!f.role || n.role === f.role) &&
			(!f.name || n.name === f.name) &&
			(!q || `${n.role} ${n.name} ${n.value ?? ""}`.toLowerCase().includes(q)) &&
			(!f.states?.length || f.states.every((s) => n.states.includes(s))) &&
			(!f.interactiveOnly || interactive(n)),
	);
}

/** Lines for the model; a filtered list is flat (its depths no longer form a tree). */
export function formatTree(nodes: UiNode[], options: { flat?: boolean; maxLines?: number } = {}): string {
	const max = options.maxLines ?? MAX_TREE_LINES;
	const lines = nodes.slice(0, max).map((n) => formatNode(n, !options.flat));
	if (nodes.length > max) lines.push(`… ${nodes.length - max} more nodes (see structuredContent, or filter)`);
	return lines.join("\n");
}
