/**
 * subagent-file-changes-outlets.guard.test.ts — every subagent result outlet must
 * carry the file-change summary.
 *
 * WHY A SOURCE-LEVEL GUARD
 * ------------------------
 * A delegated run's result reaches the tool call it delivers to through two outlets:
 * the single run finalizer (`renderResult` in agent-runtime/run.ts, used for normal,
 * failed, crashed, timed-out and detached terminals alike) and the conclusion rewrite
 * (`updateToolCallConclusion` in narrator-session.ts, used for held/manual results).
 * Each one builds its own string, and a path that forgets the summary fails SILENTLY: the
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
const OUTLET_FILES = ["agent-runtime/run.ts", "narrator-session.ts"] as const;

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

function assertOutletAttribution(site: string, fileName: (typeof OUTLET_FILES)[number]): void {
	if (fileName === "agent-runtime/run.ts") {
		expect(site).toMatch(/parentNarratorId:\s*deliverTo\.narratorId,/);
		expect(site).toMatch(/childNarratorId:\s*id,/);
		expect(site).toMatch(
			/executionBoundary:\s*await boundary\.readSubagentExecutionBoundary\(\s*id,\s*publicationRun\.logicalRunId,?\s*\)/,
		);
		expect(site).toMatch(/scope:\s*\{\s*sourceToolUseId:\s*deliverTo\.toolUseId,/);
	} else {
		expect(site).toMatch(/parentNarratorId,/);
		expect(site).toMatch(/childNarratorId:\s*subagentId,/);
		expect(site).toMatch(/executionBoundary:\s*await readSubagentExecutionBoundary\(subagentId\)/);
		expect(site).toMatch(/scope:\s*\{\s*sourceToolUseId:\s*toolUseId,/);
	}
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
			// Every summary is scoped to this child, its verified execution boundary and
			// the destination tool call's window.
			let from = source.indexOf("appendSubagentFileChanges(");
			while (from !== -1) {
				const site = source.slice(from, from + 600);
				assertOutletAttribution(site, fileName);
				from = source.indexOf("appendSubagentFileChanges(", from + 1);
			}
		});
	}

	test("the guard rejects wrong child, run and destination ownership in either host", () => {
		for (const fileName of OUTLET_FILES) {
			const source = executableSource(fileName);
			const from = source.indexOf("appendSubagentFileChanges(");
			const site = source.slice(from, from + 600);
			const mutations =
				fileName === "agent-runtime/run.ts"
					? [
							["childNarratorId: id,", "childNarratorId: parentNarratorId,"],
							["publicationRun.logicalRunId", "unrelatedRun.logicalRunId"],
							["sourceToolUseId: deliverTo.toolUseId,", "sourceToolUseId: unrelated.toolUseId,"],
						]
					: [
							["childNarratorId: subagentId,", "childNarratorId: parentNarratorId,"],
							[
								"readSubagentExecutionBoundary(subagentId)",
								"readSubagentExecutionBoundary(parentNarratorId)",
							],
							["sourceToolUseId: toolUseId,", "sourceToolUseId: unrelatedToolUseId,"],
						];
			for (const [original, wrong] of mutations) {
				expect(site).toContain(original);
				expect(() => assertOutletAttribution(site.replace(original, wrong), fileName)).toThrow();
			}
		}
	});

	test("the two known outlets are all still accounted for", () => {
		// A count, so splitting or merging an outlet is a deliberate decision that has to
		// come here rather than silently changing coverage.
		const total = OUTLET_FILES.reduce(
			(sum, fileName) => sum + countOccurrences(executableSource(fileName), "agentResultTag("),
			0,
		);
		expect(total).toBe(2);
	});

	test("single-result append cannot regress to the whole-team query or load payloads", () => {
		const source = executableSource("subagent-file-changes.ts");
		const append = source.slice(source.indexOf("export async function appendSubagentFileChanges("));
		expect(append).toContain("getChildSubagentFileChanges(options)");
		expect(source).toContain("options.executionBoundary ?? null");
		expect(source).toContain("getCurrentSubagentFileChangeOptions");
		expect(source).toContain("fileChangeEffects.id");
		expect(source).not.toContain("entry.exactKeys.has(key)");
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

	test("a recovered run keeps its attribution window instead of using replay time", () => {
		const run = executableSource("agent-runtime/run.ts");
		const render = run.slice(run.indexOf("async function renderResult("));
		expect(render).toContain("startedAt: turn?.turnStartedAt ?? null");
		// Only a NEW run opens a new window; recovery of an executed run keeps the old one.
		const reset = run.indexOf(".set({ turnStartedAt: new Date().toISOString() })");
		expect(reset).toBeGreaterThan(-1);
		expect(run.slice(Math.max(0, reset - 120), reset)).toContain("if (!req.recovered)");
	});

	test("the crash outlet is one of them", () => {
		// Called out separately because it is the one most likely to be treated as an
		// exception ("it is only an error path"). A run that crashed partway has very
		// likely already written files, and that is precisely when the parent would
		// otherwise proceed against a stale view of the disk. A throwing run must reach
		// the same finalizer (and so the same summarized renderResult) as a normal one.
		const source = executableSource("agent-runtime/run.ts");
		const execute = source.slice(source.indexOf("async function executeRun("));
		const crashIndex = execute.indexOf("} catch (error) {");
		expect(crashIndex).toBeGreaterThan(-1);
		const crashEnd = execute.indexOf("\n\t} finally {", crashIndex);
		expect(crashEnd).toBeGreaterThan(crashIndex);
		const handlerTail = execute.slice(crashIndex, crashEnd);
		expect(handlerTail).toContain("await finishRun(");
		expect(handlerTail).toContain("hasError: true");
		const finish = source.slice(source.indexOf("async function finishRun("));
		expect(finish.slice(0, finish.indexOf("\n}\n"))).toContain("await renderResult(");
	});
});
