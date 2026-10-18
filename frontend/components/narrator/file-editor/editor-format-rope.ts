export type EditorEolTag = 1 | 2 | 3;
/** Persistent AVL of compact tag blocks; uniform subtrees need no per-newline storage. */
export type EolRoot =
	| {
			readonly kind: "uniform";
			readonly tag: EditorEolTag;
			readonly count: number;
			readonly height: 1;
	  }
	| { readonly kind: "tags"; readonly tags: Uint8Array; readonly count: number; readonly height: 1 }
	| {
			readonly kind: "branch";
			readonly left: EolRoot;
			readonly right: EolRoot;
			readonly count: number;
			readonly height: number;
	  };
export const uniformEols = (tag: EditorEolTag, count: number): EolRoot => ({
	kind: "uniform",
	tag,
	count,
	height: 1,
});
const node = (left: EolRoot, right: EolRoot): EolRoot => {
	if (!left.count) return right;
	if (!right.count) return left;
	return {
		kind: "branch",
		left,
		right,
		count: left.count + right.count,
		height: Math.max(left.height, right.height) + 1,
	};
};
function balanced(left: EolRoot, right: EolRoot): EolRoot {
	if (left.height > right.height + 1 && left.kind === "branch") {
		if (left.left.height >= left.right.height) return node(left.left, node(left.right, right));
		const middle = left.right;
		if (middle.kind === "branch")
			return node(node(left.left, middle.left), node(middle.right, right));
	}
	if (right.height > left.height + 1 && right.kind === "branch") {
		if (right.right.height >= right.left.height) return node(node(left, right.left), right.right);
		const middle = right.left;
		if (middle.kind === "branch")
			return node(node(left, middle.left), node(middle.right, right.right));
	}
	return node(left, right);
}
export function joinEols(left: EolRoot, right: EolRoot): EolRoot {
	if (!left.count) return right;
	if (!right.count) return left;
	if (left.kind === "uniform" && right.kind === "uniform" && left.tag === right.tag)
		return uniformEols(left.tag, left.count + right.count);
	if (left.height > right.height + 1 && left.kind === "branch")
		return balanced(left.left, joinEols(left.right, right));
	if (right.height > left.height + 1 && right.kind === "branch")
		return balanced(joinEols(left, right.left), right.right);
	return node(left, right);
}
export function tagBlock(tags: Uint8Array): EolRoot {
	for (const tag of tags) if (tag < 1 || tag > 3) throw new Error("EDITOR_FORMAT_INVALID");
	if (!tags.length || tags.every((tag) => tag === tags[0]))
		return uniformEols((tags[0] ?? 1) as EditorEolTag, tags.length);
	if (tags.length > 1024) {
		const half = Math.floor(tags.length / 2);
		return joinEols(tagBlock(tags.subarray(0, half)), tagBlock(tags.subarray(half)));
	}
	return { kind: "tags", tags: tags.slice(), count: tags.length, height: 1 };
}
export function splitEols(root: EolRoot, at: number): [EolRoot, EolRoot] {
	if (at <= 0) return [uniformEols(1, 0), root];
	if (at >= root.count) return [root, uniformEols(1, 0)];
	if (root.kind === "uniform")
		return [uniformEols(root.tag, at), uniformEols(root.tag, root.count - at)];
	if (root.kind === "tags")
		return [tagBlock(root.tags.subarray(0, at)), tagBlock(root.tags.subarray(at))];
	if (at < root.left.count) {
		const [a, b] = splitEols(root.left, at);
		return [a, joinEols(b, root.right)];
	}
	const [a, b] = splitEols(root.right, at - root.left.count);
	return [joinEols(root.left, a), b];
}
export function spliceEols(
	root: EolRoot,
	start: number,
	removed: number,
	count: number,
	tag: EditorEolTag,
): EolRoot {
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(removed) ||
		start < 0 ||
		removed < 0 ||
		start + removed > root.count
	)
		throw new Error("EDITOR_FORMAT_RANGE");
	if ((!removed && !count) || (root.kind === "uniform" && root.tag === tag && removed === count))
		return root;
	const [left, tail] = splitEols(root, start);
	const [, right] = splitEols(tail, removed);
	return joinEols(joinEols(left, uniformEols(tag, count)), right);
}
export function* eolBlocks(root: EolRoot): Generator<EolRoot & { kind: "uniform" | "tags" }> {
	if (root.kind === "branch") {
		yield* eolBlocks(root.left);
		yield* eolBlocks(root.right);
	} else yield root;
}
export function* eolTags(root: EolRoot): Generator<EditorEolTag> {
	for (const block of eolBlocks(root))
		for (let i = 0; i < block.count; i++)
			yield (block.kind === "uniform" ? block.tag : block.tags[i]) as EditorEolTag;
}
/** Account unique reachable nodes (shared roots are not charged repeatedly). */
export function eolBytes(root: EolRoot, seen = new Set<EolRoot>()): number {
	if (seen.has(root)) return 0;
	seen.add(root);
	return (
		64 +
		(root.kind === "tags"
			? root.tags.byteLength
			: root.kind === "branch"
				? eolBytes(root.left, seen) + eolBytes(root.right, seen)
				: 0)
	);
}
