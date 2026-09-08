/**
 * subagent-file-changes-outlets.guard.test.ts — every subagent result outlet must
 * carry the file-change summary.
 *
 * WHY A SOURCE-LEVEL GUARD
 * ------------------------
 * A subagent result reaches its parent through five separate code paths (normal
 * completion, crash, background replay, detach, background finalization). Each one
 * builds its own string, and a path that forgets the summary fails SILENTLY: the
 * result still arrives, still reads sensibly, and simply omits the fact that files
 * changed. No behavioural test of one path can notice that a DIFFERENT path is
 * missing it, and there is no shared chokepoint to assert on — that is exactly the
 * shape of drift a source guard is for.
 *
 * The marker is `agentResultTag`, the one call every outlet already makes to prefix a
 * result. So the invariant is: wherever that tag is applied, the summary is appended.
 * A new outlet added later will trip this test rather than quietly ship without the
 * summary.
 *
 * Comment lines are stripped before matching, so prose mentioning either name (this
 * file's own reasoning included) cannot satisfy or break the count.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICES_DIR = join(import.meta.dir, "..");

/** Files that build a subagent result string for a parent. */
const OUTLET_FILES = ["subagent-runner.ts", "subagent-detach.ts", "narrator-session.ts"] as const;

/** Source with comment-only lines and import lines removed. */
function executableSource(fileName: string): string {
	return readFileSync(join(SERVICES_DIR, fileName), "utf-8")
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
				return false;
			}
			// An import of either symbol is not a use of it.
			return !trimmed.startsWith("import ");
		})
		.join("\n");
}

function countOccurrences(source: string, needle: string): number {
	let count = 0;
	let index = source.indexOf(needle);
	while (index !== -1) {
		count++;
		index = source.indexOf(needle, index + needle.length);
	}
	return count;
}

describe("subagent result outlets carry the file-change summary", () => {
	for (const fileName of OUTLET_FILES) {
		test(`${fileName}: every agentResultTag site appends the summary`, () => {
			const source = executableSource(fileName);
			const tagged = countOccurrences(source, "agentResultTag(");
			const summarized = countOccurrences(source, "appendSubagentFileChanges(");
			// Premise: this file is still an outlet. If a refactor moved the tag elsewhere,
			// the guard must fail loudly rather than pass by matching zero against zero.
			expect(tagged).toBeGreaterThan(0);
			expect(summarized).toBe(tagged);
			const childScoped =
				source.match(
					/appendSubagentFileChanges\(\s*\{\s*parentNarratorId,\s*childNarratorId:\s*subagentId,\s*scope:\s*\{/g,
				) ?? [];
			expect(childScoped.length).toBe(summarized);
			const executionBoundary =
				source.match(/scope:\s*\{\s*sourceToolUseId:\s*toolUseId,\s*startedAt:/g) ?? [];
			expect(executionBoundary.length).toBe(summarized);
		});
	}

	test("the five known outlets are all still accounted for", () => {
		// A count, so splitting or merging an outlet is a deliberate decision that has to
		// come here rather than silently changing coverage.
		const total = OUTLET_FILES.reduce(
			(sum, fileName) => sum + countOccurrences(executableSource(fileName), "agentResultTag("),
			0,
		);
		expect(total).toBe(5);
	});

	test("single-result append cannot regress to the whole-team query or load payloads", () => {
		const source = executableSource("subagent-file-changes.ts");
		const append = source.slice(source.indexOf("export async function appendSubagentFileChanges("));
		expect(append).toContain("getChildSubagentFileChanges(options)");
		expect(append).not.toContain("getSubagentFileChanges(");
		expect(append).not.toContain("getTeamSubagentFileChanges(");
		for (const field of [
			"inputJson",
			"outputJson",
			"contentJson",
			"input_json",
			"output_json",
			"content_json",
		])
			expect(source).not.toContain(field);
	});

	test("the executor preserves a runner window instead of using replay time", () => {
		const executor = executableSource("subagent-executor.ts");
		expect(executor).toContain("turnStartedAt: opts.fileChangeStartedAt");
		const runner = executableSource("subagent-runner.ts");
		expect(runner).toContain("startedAt: original.turnStartedAt ?? null");
		expect(runner).toContain("completedAt: original.backgroundCompletedAt ?? null");
	});

	test("the crash outlet is one of them", () => {
		// Called out separately because it is the one most likely to be treated as an
		// exception ("it is only an error path"). A subagent that crashed partway has very
		// likely already written files, and that is precisely when the parent would
		// otherwise proceed against a stale view of the disk.
		//
		// Anchored on `runLoop().catch(` rather than on the error TEXT: the runner has two
		// sites building a "Subagent error:" string, and only this one publishes a result
		// itself. The other assigns `finalText` inside the loop's try/catch and falls
		// through to the normal completion outlet, which is already summarized — matching
		// the error text would have tested the wrong site.
		const source = executableSource("subagent-runner.ts");
		const crashIndex = source.indexOf("runLoop().catch(");
		expect(crashIndex).toBeGreaterThan(-1);
		const handlerTail = source.slice(crashIndex, crashIndex + 800);
		expect(handlerTail).toContain("Subagent error:");
		expect(handlerTail).toContain("appendSubagentFileChanges(");
	});
});
