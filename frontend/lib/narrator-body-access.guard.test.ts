/**
 * narrator-body-access.guard.test.ts — nothing on the frontend holds a message body in a
 * `contentJson` field (docs/BLOCK_STORAGE-DESIGN.md, P3d).
 *
 * A row holds its body as blocks (`blocks`). Readers take it through the accessors in
 * `shared/narrator-blocks/message-blocks.ts` (`messageBody` for the elements,
 * `messageBlocks` for the blocks), and code that rewrites a row's body goes through the
 * helpers next to them (`mapRowElements`, `filterRowElements`, `rowWithElements`).
 *
 * `BODY_FIELD_USES` counts the field's remaining uses per file: only the accessor, which
 * hands a client-built row's elements to the server's envelope splitter under that name.
 * The counts only go down:
 *   - a use in an unlisted file, or more than its count, fails — read through
 *     `messageBody` / `messageBlocks`, or rewrite through the helpers;
 *   - fewer than its count fails too — lower it (drop the entry at zero).
 *
 * The scan is lexical over comment-stripped source. A floor, not a proof.
 *
 * Rows do not nest either: a row nested under another one is a row of its own, after
 * its parent, naming it (`parentMessageId`). `TreeMessage` has no `children`, which the
 * type check holds below.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { TreeMessage } from "./api/types";

const ROOT = join(import.meta.dir, "..", "..");

/** Direct uses of the body field per file, and why they are there. */
const BODY_FIELD_USES: Record<string, { count: number; why: string }> = {
	"shared/narrator-blocks/message-blocks.ts": {
		count: 1,
		why: "splitRowBlocks feeds the server's envelope splitter",
	},
};

const SCANNED = ["frontend", "shared/pretext-layout", "shared/narrator-blocks/message-blocks.ts"];

function isExempt(path: string): boolean {
	return (
		/\.test\.tsx?$/.test(path) ||
		path.includes("/__tests__/") ||
		path.includes("/mock/") ||
		path.endsWith("routeTree.gen.ts")
	);
}

/** Line comments and block comments out, string contents kept. */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
		.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

export function bodyFieldUses(code: string): number {
	return (code.match(/\bcontentJson\b/g) ?? []).length;
}

function sourceFiles(path: string, out: string[]): string[] {
	const absolute = join(ROOT, path);
	if (statSync(absolute).isFile()) {
		out.push(path);
		return out;
	}
	for (const name of readdirSync(absolute)) {
		if (name === "node_modules") continue;
		const child = join(absolute, name);
		const rel = relative(ROOT, child).split(sep).join("/");
		if (statSync(child).isDirectory()) sourceFiles(rel, out);
		else if (/\.tsx?$/.test(name)) out.push(rel);
	}
	return out;
}

describe("narrator body access", () => {
	test("rows are flat: TreeMessage has no children", () => {
		// @ts-expect-error A nested row names its parent instead (`message/nested-rows.ts`).
		const children: TreeMessage["children"] = undefined;
		expect(children).toBeUndefined();
	});

	test("bodyFieldUses counts the field, not comments or other names", () => {
		expect(bodyFieldUses(stripComments("// contentJson\nconst a = row.contentJson;"))).toBe(1);
		expect(bodyFieldUses("const contentJsonBytes = 1; originalContentJson;")).toBe(0);
	});

	test("readers take the body through the accessors; the counts only go down", () => {
		const counts = new Map<string, number>();
		for (const path of SCANNED.flatMap((root) => sourceFiles(root, []))) {
			if (isExempt(path)) continue;
			const uses = bodyFieldUses(stripComments(readFileSync(join(ROOT, path), "utf8")));
			if (uses > 0) counts.set(path, uses);
		}
		const problems: string[] = [];
		for (const [path, uses] of counts) {
			const allowed = BODY_FIELD_USES[path]?.count ?? 0;
			if (uses > allowed)
				problems.push(
					`${path}: ${uses} uses of contentJson, ${allowed} allowed — read through messageBody / messageBlocks`,
				);
		}
		for (const [path, { count }] of Object.entries(BODY_FIELD_USES)) {
			const uses = counts.get(path) ?? 0;
			if (uses < count)
				problems.push(`${path}: ${uses} uses of contentJson, listed as ${count} — lower it`);
		}
		expect(problems).toEqual([]);
	});
});
