/**
 * tool-io-projection.ts — FIELD-LEVEL truncation of tool call input/output.
 *
 * WHAT CHANGED AND WHY
 *
 * The original projection wrapped the WHOLE value: `JSON.stringify(payload)` was
 * sliced to 2000 chars and replaced by `{_truncated, preview, fullLength}`. That
 * destroyed the object structure, which cost the UI four distinct things:
 *
 *   1. `_metadata` vanished. Tool output is persisted as `{_text, _metadata}`, and
 *      the root wrapper has no `_metadata` sibling — so `enrichToolUseBlocks`
 *      could not forward it. Every structured card (Recall / KnowledgeSearch /
 *      WebSearch / Share / WebFetch screenshot) silently degraded to a generic
 *      JSON dump as soon as its output exceeded the limit.
 *   2. `_text` could not be unwrapped, so the preview a user saw was the literal
 *      `{"_text":"line1\nline2…` — quotes, escapes and all.
 *   3. Header fields (`file_path`, `command`, `pattern`, …) had to be smuggled out
 *      through a hand-maintained `_hints` whitelist plus regex scraping of the
 *      preview JSON — a design where every new tool is one forgotten `case` away
 *      from an empty card header.
 *   4. An `Edit`'s `old_string` and `new_string` shared ONE budget, so a large
 *      first field starved the second entirely.
 *
 * This module truncates STRING LEAVES instead. The wrapper shape is unchanged
 * (`isTruncated` still recognizes it), but it now appears only where the actual
 * bulk is:
 *
 *     { file_path: "/a/b.ts",
 *       old_string: { _truncated: true, preview: "…", fullLength: 20000 },
 *       new_string: { _truncated: true, preview: "…", fullLength: 24000 } }
 *
 * Structure and short fields survive, which removes all four problems at once.
 *
 * BUDGETS ARE THE CALLER'S DECISION
 *
 * There is deliberately no ambient default here: `projectToolIO` takes the leaf
 * budget explicitly. The WS broadcast channels and the exact-layout page want
 * very different numbers (2000 vs 8K), and a function-level default is exactly
 * how a high-frequency channel silently inflates 4x.
 *
 * PURITY: no DOM, no frontend imports, no i18n — this file sits inside the
 * `shared/pretext-layout` boundary enforced by shared-core.guard.test.ts.
 */

/** A truncated string leaf. Structurally identical to the legacy root wrapper. */
export interface TruncatedLeaf {
	_truncated: true;
	preview: string;
	fullLength: number;
}

/**
 * Budgets, calibrated against the measure layer's own bounded-prefix constants
 * so a projected body always contains everything a capped box can reveal.
 */
export const TOOL_IO_BUDGETS = {
	/**
	 * Default per-leaf budget for the exact-layout path (chars).
	 *
	 * Mirrors `DETAIL_MEASURE_PREFIX_MAX_CHARS` in measure-tool-call.ts. Sized for
	 * CONTENT SUFFICIENCY, not height correctness: the largest non-plan cap is
	 * 400px ≈ 26 lines ≈ 2600 chars, so the legacy 2000 could not even fill the
	 * box the card already reserved — the reader saw blank space below the text
	 * with nothing to scroll to. Height correctness comes from the cap clamp
	 * (`textTruncated` → return cap), which is budget-independent.
	 */
	leaf: 8 * 1024,
	/**
	 * Budget for a markdown body whose cap scales with the viewport (chars).
	 *
	 * Only `plan` qualifies: `resolveDetailCap` gives ExitPlanMode plans
	 * `0.85 × viewportHeight` (68+ lines on a tall window) instead of a fixed 400px,
	 * so 8K would clamp a real plan that could have been measured exactly.
	 * Mirrors `DETAIL_MARKDOWN_PREFIX_MAX_CHARS`, the ceiling on how much markdown
	 * the measure layer will parse — this budget has to deliver what that reads.
	 *
	 * Knowledge/skill bodies deliberately do NOT get this: they arrive as the
	 * output's `_text`, a field name with no discriminating power, and their cap is
	 * a fixed 400px that `leaf` already over-serves.
	 */
	markdownLeaf: 32 * 1024,
	/**
	 * Ceiling on the total projected size of ONE payload (chars).
	 *
	 * A payload can hold many leaves that each fit their own budget (a Send with 40
	 * short targets, a metadata array of 200 rows). Without an aggregate bound the
	 * per-leaf budgets multiply, so this caps the sum and re-truncates the largest
	 * leaves until the whole payload fits.
	 */
	total: 256 * 1024,
	/** Max recursion depth. Deeper subtrees are dropped to a truncated marker. */
	maxDepth: 8,
	/** Max array elements visited. The remainder is dropped. */
	maxArrayElements: 200,
	/** Max object keys visited per level. The remainder is dropped. */
	maxObjectKeys: 200,
} as const;

/** Field names that get the larger markdown budget (see `markdownLeaf`). */
const MARKDOWN_FIELDS: ReadonlySet<string> = new Set(["plan"]);

export interface ProjectToolIOOptions {
	/** Per-leaf char budget. Required: the budget is the caller's decision. */
	leafBudget: number;
	/**
	 * Budget for `MARKDOWN_FIELDS` leaves. Defaults to
	 * `max(leafBudget, TOOL_IO_BUDGETS.markdownLeaf)` so a caller that asks for a
	 * SMALL leaf budget (a WS broadcast) does not accidentally get a 32K plan.
	 */
	markdownBudget?: number;
	/** Aggregate ceiling for the whole payload. */
	totalBudget?: number;
}

/** Type guard for a truncated leaf (kept identical to `tool-detail.isTruncated`). */
function isTruncatedLeaf(value: unknown): value is TruncatedLeaf {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { _truncated?: unknown })._truncated === true &&
		typeof (value as { preview?: unknown }).preview === "string"
	);
}

function truncateLeaf(text: string, budget: number): TruncatedLeaf {
	return { _truncated: true, preview: text.slice(0, budget), fullLength: text.length };
}

/**
 * Resolve the effective budgets, clamping every value to a sane range so a
 * caller cannot disable truncation with a negative or absurd number.
 */
function resolveBudgets(options: ProjectToolIOOptions): {
	leaf: number;
	markdown: number;
	total: number;
} {
	const leaf = Math.max(1, Math.trunc(options.leafBudget));
	// A caller asking for a small leaf budget (broadcast) must not silently get a
	// 32K markdown body; the markdown budget only ever RAISES an already-large one.
	const markdown = Math.max(
		leaf,
		Math.trunc(options.markdownBudget ?? Math.max(leaf, TOOL_IO_BUDGETS.markdownLeaf)),
	);
	// The aggregate cap is AUTHORITATIVE: clamping it up to `leaf` would let a
	// caller's explicit total be silently ignored whenever one leaf could fill it.
	const total = Math.max(1, Math.trunc(options.totalBudget ?? TOOL_IO_BUDGETS.total));
	return { leaf, markdown, total };
}

/**
 * Project a tool payload, truncating oversized string leaves in place.
 *
 * Returns the ORIGINAL reference when nothing needed truncating — the common case
 * for the overwhelming majority of payloads, so the normal path allocates
 * nothing. Callers may use identity to detect "was anything projected".
 *
 * Bounded in every dimension: depth, keys per level, array elements, per-leaf
 * chars and total chars. A cyclic structure is safe (visited set).
 */
export function projectToolIO(value: unknown, options: ProjectToolIOOptions): unknown {
	const budgets = resolveBudgets(options);
	// Leaves recorded during the walk so an over-budget payload can be squeezed
	// further without re-walking (see `enforceTotalBudget`).
	const emitted: EmittedLeaf[] = [];
	const projected = walk(value, undefined, 0, budgets, emitted, new WeakSet());
	return enforceTotalBudget(projected, emitted, budgets.total);
}

/** A leaf the walk kept (possibly already truncated), for total-budget squeezing. */
interface EmittedLeaf {
	/** Path from the payload root; `[]` means the payload IS this leaf. */
	path: (string | number)[];
	/** Chars this leaf currently contributes. */
	length: number;
}

/** Marker for a subtree dropped by the depth guard. */
function depthGuardLeaf(): TruncatedLeaf {
	return { _truncated: true, preview: "", fullLength: 0 };
}

function walk(
	value: unknown,
	fieldName: string | undefined,
	depth: number,
	budgets: { leaf: number; markdown: number; total: number },
	emitted: EmittedLeaf[],
	seen: WeakSet<object>,
	path: (string | number)[] = [],
): unknown {
	if (typeof value === "string") {
		const budget =
			fieldName !== undefined && MARKDOWN_FIELDS.has(fieldName) ? budgets.markdown : budgets.leaf;
		if (value.length <= budget) {
			emitted.push({ path: [...path], length: value.length });
			return value;
		}
		emitted.push({ path: [...path], length: budget });
		return truncateLeaf(value, budget);
	}

	if (value === null || typeof value !== "object") return value;

	// An already-truncated leaf (a re-projection of projected data) passes through
	// unchanged: re-slicing it would only lose characters, and `fullLength` must
	// keep describing the ORIGINAL payload, not the preview.
	if (isTruncatedLeaf(value)) {
		emitted.push({ path: [...path], length: value.preview.length });
		return value;
	}

	if (seen.has(value)) return undefined;
	if (depth >= TOOL_IO_BUDGETS.maxDepth) return depthGuardLeaf();
	seen.add(value);
	try {
		return Array.isArray(value)
			? walkArray(value, depth, budgets, emitted, seen, path)
			: walkObject(value as Record<string, unknown>, depth, budgets, emitted, seen, path);
	} finally {
		// Released so a DAG (the same object referenced twice in sibling positions)
		// is projected in both places; only true cycles are cut.
		seen.delete(value);
	}
}

function walkArray(
	value: readonly unknown[],
	depth: number,
	budgets: { leaf: number; markdown: number; total: number },
	emitted: EmittedLeaf[],
	seen: WeakSet<object>,
	path: (string | number)[],
): unknown {
	const limit = Math.min(value.length, TOOL_IO_BUDGETS.maxArrayElements);
	let out: unknown[] | null = value.length > limit ? value.slice(0, limit) : null;
	for (let i = 0; i < limit; i++) {
		const child = walk(value[i], undefined, depth + 1, budgets, emitted, seen, [...path, i]);
		if (!Object.is(child, value[i])) {
			if (!out) out = value.slice(0, limit);
			out[i] = child;
		}
	}
	return out ?? value;
}

function walkObject(
	value: Record<string, unknown>,
	depth: number,
	budgets: { leaf: number; markdown: number; total: number },
	emitted: EmittedLeaf[],
	seen: WeakSet<object>,
	path: (string | number)[],
): unknown {
	const keys = Object.keys(value);
	const limit = Math.min(keys.length, TOOL_IO_BUDGETS.maxObjectKeys);
	let out: Record<string, unknown> | null = null;
	if (keys.length > limit) {
		out = {};
		for (let i = 0; i < limit; i++) {
			const key = keys[i];
			if (key !== undefined) out[key] = value[key];
		}
	}
	for (let i = 0; i < limit; i++) {
		const key = keys[i];
		if (key === undefined) continue;
		const child = walk(value[key], key, depth + 1, budgets, emitted, seen, [...path, key]);
		if (!Object.is(child, value[key])) {
			if (!out) out = { ...value };
			out[key] = child;
		}
	}
	return out ?? value;
}

/**
 * Squeeze the payload further when the SUM of its leaves exceeds `total`.
 *
 * Largest leaves are cut first (they carry the bulk and lose the least meaning
 * per char removed), each down to an equal share of the remaining allowance, until
 * the payload fits. Returns the input untouched in the common under-budget case.
 */
function enforceTotalBudget(value: unknown, emitted: EmittedLeaf[], total: number): unknown {
	let sum = 0;
	for (const leaf of emitted) sum += leaf.length;
	if (sum <= total) return value;

	// Largest first, so the fewest leaves are touched.
	const ordered = [...emitted].sort((a, b) => b.length - a.length);
	const overrides = new Map<string, number>();
	let remaining = total;
	let left = ordered.length;
	for (const leaf of ordered) {
		const share = Math.max(1, Math.floor(remaining / Math.max(1, left)));
		const allowed = Math.min(leaf.length, share);
		overrides.set(pathKey(leaf.path), allowed);
		remaining -= allowed;
		left--;
	}
	return applyOverrides(value, [], overrides);
}

function pathKey(path: readonly (string | number)[]): string {
	return path.join("\u0000");
}

/** Rewrite the leaves named in `overrides` down to their allowed length. */
function applyOverrides(
	value: unknown,
	path: (string | number)[],
	overrides: ReadonlyMap<string, number>,
): unknown {
	if (typeof value === "string") {
		const allowed = overrides.get(pathKey(path));
		if (allowed === undefined || value.length <= allowed) return value;
		return truncateLeaf(value, allowed);
	}
	if (value === null || typeof value !== "object") return value;
	if (isTruncatedLeaf(value)) {
		const allowed = overrides.get(pathKey(path));
		if (allowed === undefined || value.preview.length <= allowed) return value;
		// `fullLength` still describes the original payload; only the preview shrinks.
		return {
			_truncated: true,
			preview: value.preview.slice(0, allowed),
			fullLength: value.fullLength,
		};
	}
	if (Array.isArray(value)) {
		let out: unknown[] | null = null;
		for (let i = 0; i < value.length; i++) {
			const child = applyOverrides(value[i], [...path, i], overrides);
			if (!Object.is(child, value[i])) {
				if (!out) out = [...value];
				out[i] = child;
			}
		}
		return out ?? value;
	}
	const record = value as Record<string, unknown>;
	let out: Record<string, unknown> | null = null;
	for (const key of Object.keys(record)) {
		const child = applyOverrides(record[key], [...path, key], overrides);
		if (!Object.is(child, record[key])) {
			if (!out) out = { ...record };
			out[key] = child;
		}
	}
	return out ?? value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection + reading. These replace every ROOT-level `isTruncated(payload)`
// probe: after field-level projection an object payload's root is a plain object,
// so a root probe silently reports "not truncated" — and because the wrapper
// shape is unchanged, TypeScript cannot catch it.
// ─────────────────────────────────────────────────────────────────────────────

/** True when `value` contains at least one truncated leaf (at any depth). */
export function hasTruncatedLeaf(value: unknown): boolean {
	return findTruncatedLeaf(value, 0, new WeakSet());
}

function findTruncatedLeaf(value: unknown, depth: number, seen: WeakSet<object>): boolean {
	if (value === null || typeof value !== "object") return false;
	if (isTruncatedLeaf(value)) return true;
	if (depth >= TOOL_IO_BUDGETS.maxDepth || seen.has(value)) return false;
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const limit = Math.min(value.length, TOOL_IO_BUDGETS.maxArrayElements);
			for (let i = 0; i < limit; i++) {
				if (findTruncatedLeaf(value[i], depth + 1, seen)) return true;
			}
			return false;
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		const limit = Math.min(keys.length, TOOL_IO_BUDGETS.maxObjectKeys);
		for (let i = 0; i < limit; i++) {
			const key = keys[i];
			if (key === undefined) continue;
			if (findTruncatedLeaf(record[key], depth + 1, seen)) return true;
		}
		return false;
	} finally {
		seen.delete(value);
	}
}

/** One truncated leaf found by {@link collectTruncatedLeaves}. */
export interface TruncatedLeafInfo {
	/** Dotted/indexed path from the payload root; `""` when the payload IS the leaf. */
	path: string;
	/** Original length in chars. */
	fullLength: number;
	/** Chars actually available in the preview. */
	previewLength: number;
}

/**
 * Every truncated leaf in `value`, in document order.
 *
 * Drives the UI's truncation summary row ("2 fields truncated, 45KB total"),
 * which is why it reports sizes rather than just a boolean: after field-level
 * projection a payload can legitimately have several independently cut fields.
 */
export function collectTruncatedLeaves(value: unknown): TruncatedLeafInfo[] {
	const out: TruncatedLeafInfo[] = [];
	collectLeaves(value, [], 0, new WeakSet(), out);
	return out;
}

function collectLeaves(
	value: unknown,
	path: (string | number)[],
	depth: number,
	seen: WeakSet<object>,
	out: TruncatedLeafInfo[],
): void {
	if (value === null || typeof value !== "object") return;
	if (isTruncatedLeaf(value)) {
		out.push({
			path: formatPath(path),
			fullLength: value.fullLength,
			previewLength: value.preview.length,
		});
		return;
	}
	if (depth >= TOOL_IO_BUDGETS.maxDepth || seen.has(value)) return;
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const limit = Math.min(value.length, TOOL_IO_BUDGETS.maxArrayElements);
			for (let i = 0; i < limit; i++) collectLeaves(value[i], [...path, i], depth + 1, seen, out);
			return;
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		const limit = Math.min(keys.length, TOOL_IO_BUDGETS.maxObjectKeys);
		for (let i = 0; i < limit; i++) {
			const key = keys[i];
			if (key === undefined) continue;
			collectLeaves(record[key], [...path, key], depth + 1, seen, out);
		}
	} finally {
		seen.delete(value);
	}
}

function formatPath(path: readonly (string | number)[]): string {
	let out = "";
	for (const segment of path) {
		if (typeof segment === "number") out += `[${segment}]`;
		else out += out.length > 0 ? `.${segment}` : segment;
	}
	return out;
}

/**
 * Read a field that the schema says is a string but the projection may have
 * wrapped.
 *
 * This is the counterpart risk to a stale root probe: dozens of call sites narrow
 * with `typeof x === "string"`, and a wrapped leaf fails that test silently — the
 * field simply disappears from the card. Routing those reads through here keeps
 * the value visible (as its preview) instead.
 */
export function readLeafText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (isTruncatedLeaf(value)) return value.preview;
	return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Display-safe serialization.
// ─────────────────────────────────────────────────────────────────────────────

/** Appended where a truncated leaf's tail was dropped. */
const ELLIPSIS = "…";

/**
 * `JSON.stringify(value, null, 2)` that never leaks a wrapper's structure.
 *
 * Every JSON-dump display path (generic tool detail, the tool-call inspector, the
 * pixi model, copy-to-clipboard) would otherwise print a literal
 * `{"_truncated":true,"preview":"…","fullLength":45000}` in the middle of an
 * otherwise readable object — strictly worse than the old behaviour, which at
 * least showed clean text. Here a wrapper serializes as its preview plus an
 * ellipsis, i.e. as the string it stands for.
 *
 * `maxChars` bounds the RESULT (not the input), so a caller on a render path
 * cannot be handed an unbounded string.
 */
export function stringifyForDisplay(value: unknown, maxChars?: number): string {
	const limit = maxChars != null && maxChars > 0 ? Math.trunc(maxChars) : undefined;
	let text: string;
	try {
		text = JSON.stringify(unwrapForDisplay(value, 0, new WeakSet()), null, 2) ?? String(value);
	} catch {
		text = String(value);
	}
	if (limit != null && text.length > limit) return text.slice(0, limit);
	return text;
}

/**
 * Replace every truncated leaf with `preview + ELLIPSIS` so the result can be
 * handed to `JSON.stringify` and read as ordinary text.
 */
function unwrapForDisplay(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (value === null || typeof value !== "object") return value;
	if (isTruncatedLeaf(value)) return `${value.preview}${ELLIPSIS}`;
	if (depth >= TOOL_IO_BUDGETS.maxDepth || seen.has(value)) return undefined;
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const limit = Math.min(value.length, TOOL_IO_BUDGETS.maxArrayElements);
			const out: unknown[] = [];
			for (let i = 0; i < limit; i++) out.push(unwrapForDisplay(value[i], depth + 1, seen));
			return out;
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		const limit = Math.min(keys.length, TOOL_IO_BUDGETS.maxObjectKeys);
		const out: Record<string, unknown> = {};
		for (let i = 0; i < limit; i++) {
			const key = keys[i];
			if (key === undefined) continue;
			out[key] = unwrapForDisplay(record[key], depth + 1, seen);
		}
		return out;
	} finally {
		seen.delete(value);
	}
}
