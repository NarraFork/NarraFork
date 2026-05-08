import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agencybenchEvaluator } from "../benchmark-evaluators/agencybench";
import { summarizeSweBenchTestResults } from "../benchmark-evaluators/swe-bench";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "nf-benchmark-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("SWE-bench result summarization", () => {
	test("does not grant full pass when FAIL_TO_PASS is empty", () => {
		const summary = summarizeSweBenchTestResults({
			failToPass: [],
			passToPass: [],
			testResults: new Map(),
		});

		expect(summary.f2pTotal).toBe(0);
		expect(summary.resolution).toBe("NO");
		expect(summary.passed).toBe(false);
		expect(summary.score).toBe(0);
	});

	test("does not grant full pass when PASS_TO_PASS sample was not observed", () => {
		const summary = summarizeSweBenchTestResults({
			failToPass: ["tests/test_bug.py::test_fix"],
			passToPass: ["tests/test_regression.py::test_existing"],
			testResults: new Map([["tests/test_bug.py::test_fix", "PASSED"]]),
		});

		expect(summary.f2pPassed).toBe(1);
		expect(summary.p2pChecked).toBe(false);
		expect(summary.resolution).toBe("UNVERIFIED");
		expect(summary.passed).toBe(false);
		expect(summary.score).toBeLessThan(1);
	});

	test("fails when a PASS_TO_PASS regression is observed", () => {
		const summary = summarizeSweBenchTestResults({
			failToPass: ["tests/test_bug.py::test_fix"],
			passToPass: ["tests/test_regression.py::test_existing"],
			testResults: new Map([
				["tests/test_bug.py::test_fix", "PASSED"],
				["tests/test_regression.py::test_existing", "FAILED"],
			]),
		});

		expect(summary.p2pChecked).toBe(true);
		expect(summary.p2pPassed).toBe(0);
		expect(summary.resolution).toBe("NO");
		expect(summary.passed).toBe(false);
	});
});

describe("AgencyBench heuristic evaluator", () => {
	test("marks results as heuristic-lite and not official-comparable", async () => {
		const workDir = makeTempDir();
		const result = await agencybenchEvaluator.evaluate(
			{
				id: "agency_backend_scenario1",
				name: "Agency task",
				prompt: "Create the requested deliverable.",
				metadata: {},
			},
			"This answer is long enough to count as meaningful task output for the lite evaluator.",
			workDir,
		);

		expect(result.details).toContain("Heuristic-lite evaluation");
		expect(result.metadata?.evaluationMode).toBe("heuristic-lite");
		expect(result.metadata?.officialComparable).toBe(false);
	});
});
