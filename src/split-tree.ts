const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;

export type SplitDirection = "row" | "column";

export type TerminalTab = {
	id: string;
	root: SplitNode;
};

export type SplitNode =
	| { type: "surface"; surfaceId: string }
	| {
		type: "split";
		id: string;
		direction: SplitDirection;
		ratio: number;
		first: SplitNode;
		second: SplitNode;
	};

export function clampRatio(ratio: number): number {
	if (!Number.isFinite(ratio)) {
		return 0.5;
	}
	return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

export function replaceSurfaceNode(node: SplitNode, surfaceId: string, replacement: SplitNode): SplitNode {
	if (node.type === "surface") {
		return node.surfaceId === surfaceId ? replacement : node;
	}
	return {
		...node,
		first: replaceSurfaceNode(node.first, surfaceId, replacement),
		second: replaceSurfaceNode(node.second, surfaceId, replacement)
	};
}

export function removeSurfaceNode(node: SplitNode, surfaceId: string): SplitNode | null {
	if (node.type === "surface") {
		return node.surfaceId === surfaceId ? null : node;
	}
	const first = removeSurfaceNode(node.first, surfaceId);
	const second = removeSurfaceNode(node.second, surfaceId);
	if (first && second) {
		return { ...node, first, second };
	}
	return first ?? second;
}

export function firstSurfaceId(node: SplitNode): string | null {
	if (node.type === "surface") {
		return node.surfaceId;
	}
	return firstSurfaceId(node.first) ?? firstSurfaceId(node.second);
}

export function containsSurfaceNode(node: SplitNode, surfaceId: string): boolean {
	if (node.type === "surface") {
		return node.surfaceId === surfaceId;
	}
	return containsSurfaceNode(node.first, surfaceId) || containsSurfaceNode(node.second, surfaceId);
}
