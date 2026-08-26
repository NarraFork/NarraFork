import { describe, expect, test } from "bun:test";
import {
	createWorkspaceSchema,
	updateWorkspaceSchema,
	WORKSPACE_TREE_MAX_BYTES,
	WORKSPACE_TREE_MAX_CHARS_FOR_TEST,
	workspaceTreeByteLength,
} from "../workspaces";

/** A tree string whose UTF-8 byte length is exactly `bytes`, using ASCII. */
function asciiTreeOfBytes(bytes: number): string {
	return "x".repeat(bytes);
}

/**
 * A tree string that is WITHIN the character budget but OVER the byte budget.
 *
 * Each CJK code point is one UTF-16 unit and three UTF-8 bytes, so this is the
 * shape that a character-counted limit waves through while it writes ~3x the
 * stated size into the row.
 */
function cjkTreeOverByteBudget(): string {
	const chars = Math.floor(WORKSPACE_TREE_MAX_BYTES / 3) + 1;
	return "界".repeat(chars);
}

describe("the character pre-check", () => {
	test("never rejects a payload the byte ceiling would accept", () => {
		// The pre-check exists only to avoid encoding a hostile multi-megabyte string
		// just to measure it, so it must be a strict superset of the real limit. If it
		// ever drops below, the schema starts refusing valid layouts and the error
		// message still quotes the byte ceiling — a 400 that contradicts itself.
		expect(WORKSPACE_TREE_MAX_CHARS_FOR_TEST).toBeGreaterThanOrEqual(WORKSPACE_TREE_MAX_BYTES);
	});
});

describe("workspaceTreeByteLength", () => {
	test("counts UTF-8 bytes, not UTF-16 code units", () => {
		expect(workspaceTreeByteLength("abc")).toBe(3);
		// Three bytes per CJK code point.
		expect(workspaceTreeByteLength("界")).toBe(3);
		// Astral plane: 2 UTF-16 units, 4 UTF-8 bytes.
		expect(workspaceTreeByteLength("𝄞")).toBe(4);
	});
});

describe("workspace tree size limit", () => {
	test("accepts a tree exactly at the byte ceiling", () => {
		const tree = asciiTreeOfBytes(WORKSPACE_TREE_MAX_BYTES);
		expect(workspaceTreeByteLength(tree)).toBe(WORKSPACE_TREE_MAX_BYTES);
		expect(createWorkspaceSchema.safeParse({ tree }).success).toBe(true);
	});

	test("rejects a tree one byte past the ceiling", () => {
		const tree = asciiTreeOfBytes(WORKSPACE_TREE_MAX_BYTES + 1);
		expect(createWorkspaceSchema.safeParse({ tree }).success).toBe(false);
	});

	// The regression this limit was rewritten for: the previous rule was
	// `z.string().max(500_000)`, which counts UTF-16 units. A layout full of CJK
	// panel titles therefore passed a "500 KB" check while putting ~1.5 MB into
	// the row — the stated bound and the enforced bound were different units.
	test("rejects a CJK tree that is under the character budget but over the byte budget", () => {
		const tree = cjkTreeOverByteBudget();
		expect(tree.length).toBeLessThanOrEqual(WORKSPACE_TREE_MAX_BYTES);
		expect(workspaceTreeByteLength(tree)).toBeGreaterThan(WORKSPACE_TREE_MAX_BYTES);
		expect(createWorkspaceSchema.safeParse({ tree }).success).toBe(false);
	});

	test("the raised ceiling admits a layout of plugin panels that the old 500 KB limit refused", () => {
		// ~30 plugin panels each carrying the maximum 16 KiB of viewState is a
		// legitimate workspace, and it lands just past 500 KB. That it was rejected
		// is why this limit was raised rather than merely re-unitized.
		const previousLimit = 500_000;
		const tree = asciiTreeOfBytes(previousLimit + 1);
		expect(createWorkspaceSchema.safeParse({ tree }).success).toBe(true);
	});

	test("update applies the same rule and keeps tree optional", () => {
		expect(updateWorkspaceSchema.safeParse({ title: "renamed" }).success).toBe(true);
		expect(
			updateWorkspaceSchema.safeParse({ tree: asciiTreeOfBytes(WORKSPACE_TREE_MAX_BYTES) }).success,
		).toBe(true);
		expect(
			updateWorkspaceSchema.safeParse({ tree: asciiTreeOfBytes(WORKSPACE_TREE_MAX_BYTES + 1) })
				.success,
		).toBe(false);
		expect(updateWorkspaceSchema.safeParse({ tree: cjkTreeOverByteBudget() }).success).toBe(false);
	});

	test("still rejects a tree too short to be JSON", () => {
		expect(createWorkspaceSchema.safeParse({ tree: "" }).success).toBe(false);
		expect(createWorkspaceSchema.safeParse({ tree: "{" }).success).toBe(false);
		expect(createWorkspaceSchema.safeParse({ tree: "{}" }).success).toBe(true);
	});
});
