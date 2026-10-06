/**
 * SWE-bench evaluator with Docker (Podman) isolation.
 *
 * Flow:
 *   1. Before agent runs: container is created with repo cloned + deps installed
 *      (done by benchmark-service, not here)
 *   2. Agent works in bind-mounted workDir on the host
 *   3. After agent finishes, this evaluator:
 *      a. Collects the agent's diff inside the container
 *      b. Resets test files to base_commit
 *      c. Applies the gold test_patch
 *      d. Runs FAIL_TO_PASS plus a PASS_TO_PASS sample
 *      e. Parses output to check fixed tests and sampled regressions
 */

import { execInContainer, execScript } from "../benchmark-container";
import type { BenchmarkEvaluator, BenchmarkTask, EvalResult } from "./types";

export type TestStatus = "PASSED" | "FAILED" | "ERROR";

export interface SweBenchResolutionSummary {
	resolution: "FULL" | "PARTIAL" | "NO" | "UNVERIFIED";
	passed: boolean;
	score: number;
	f2pPassed: number;
	f2pTotal: number;
	p2pPassed: number;
	p2pTotal: number;
	p2pTotalAvailable: number;
	p2pChecked: boolean;
	p2pSampled: boolean;
	f2pDetails: string[];
	p2pDetails: string[];
}

/** Parse pytest-style output to extract test results. */
export function parsePytestOutput(output: string): Map<string, TestStatus> {
	const results = new Map<string, TestStatus>();
	for (const line of output.split("\n")) {
		const m = line.match(/^(PASSED|FAILED|ERROR)\s+(.+)/);
		if (m) {
			results.set(m[2].trim(), m[1] as TestStatus);
			continue;
		}
		// Alternative format: "test_file.py::test_name PASSED"
		const m2 = line.match(/^(\S+::\S+)\s+(PASSED|FAILED|ERROR)/);
		if (m2) {
			results.set(m2[1], m2[2] as TestStatus);
			continue;
		}
		// Django format: "test_name (module) ... ok" or "test_name (module) ... FAIL"
		if (line.includes("... ok")) {
			const testName = line.split(" ... ")[0].trim();
			if (testName) results.set(testName, "PASSED");
		} else if (line.includes("... FAIL") || line.includes("... ERROR")) {
			const testName = line.split(" ... ")[0].trim();
			if (testName) results.set(testName, line.includes("FAIL") ? "FAILED" : "ERROR");
		}
	}
	return results;
}

/** Check if a test ID matches any entry in the results map. */
function findTestResult(testId: string, results: Map<string, TestStatus>): TestStatus | null {
	// Exact match
	const exact = results.get(testId);
	if (exact) return exact;
	// Partial match (test ID might be a substring)
	for (const [key, val] of results) {
		if (key.includes(testId) || testId.includes(key)) return val;
	}
	return null;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toTestTarget(testId: string): string {
	const parts = testId.split("::");
	return parts.length > 1 ? testId : parts[0];
}

export function summarizeSweBenchTestResults(input: {
	failToPass: string[];
	passToPass: string[];
	testResults: Map<string, TestStatus>;
	p2pSampleSize?: number;
}): SweBenchResolutionSummary {
	const p2pSampleSize = input.p2pSampleSize ?? 20;
	const failToPass = input.failToPass;
	const p2pSample = input.passToPass.slice(0, p2pSampleSize);

	let f2pPassed = 0;
	const f2pDetails: string[] = [];
	for (const testId of failToPass) {
		const result = findTestResult(testId, input.testResults);
		if (result === "PASSED") {
			f2pPassed++;
			f2pDetails.push(`  PASS ${testId}`);
		} else {
			f2pDetails.push(`  FAIL ${testId} (${result ?? "NOT FOUND"})`);
		}
	}

	let p2pPassed = 0;
	let p2pObserved = 0;
	const p2pDetails: string[] = [];
	for (const testId of p2pSample) {
		const result = findTestResult(testId, input.testResults);
		if (result === "PASSED") {
			p2pPassed++;
			p2pObserved++;
		} else if (result) {
			p2pObserved++;
			p2pDetails.push(`  REGRESSION ${testId} (${result})`);
		} else {
			p2pDetails.push(`  NOT RUN ${testId}`);
		}
	}

	const f2pTotal = failToPass.length;
	const p2pTotal = p2pSample.length;
	const f2pRate = f2pTotal > 0 ? f2pPassed / f2pTotal : 1;
	const p2pRate = p2pTotal > 0 ? p2pPassed / p2pTotal : 1;
	const p2pChecked = p2pObserved === p2pTotal;
	const p2pSampled = input.passToPass.length > p2pTotal;

	let resolution: SweBenchResolutionSummary["resolution"] = "NO";
	let score = 0;
	if (f2pTotal > 0 && f2pRate === 1 && p2pRate === 1 && p2pChecked) {
		resolution = "FULL";
		score = 1;
	} else if (f2pTotal > 0 && f2pRate === 1 && p2pTotal > 0 && !p2pChecked) {
		resolution = "UNVERIFIED";
		score = 0.8;
	} else if (f2pTotal > 0 && f2pRate > 0 && p2pRate === 1) {
		resolution = "PARTIAL";
		score = f2pRate * 0.8;
	}

	return {
		resolution,
		passed: resolution === "FULL",
		score: Math.round(score * 10000) / 10000,
		f2pPassed,
		f2pTotal,
		p2pPassed,
		p2pTotal,
		p2pTotalAvailable: input.passToPass.length,
		p2pChecked,
		p2pSampled,
		f2pDetails,
		p2pDetails,
	};
}

export const swebenchEvaluator: BenchmarkEvaluator = {
	name: "swe-bench",

	async evaluate(task: BenchmarkTask, _agentOutput: string, _workDir: string): Promise<EvalResult> {
		const meta = (task.metadata ?? {}) as {
			containerId?: string;
			repo?: string;
			baseCommit?: string;
			testPatch?: string;
			testCmd?: string;
			testFiles?: string[];
			failToPass?: string[];
			passToPass?: string[];
			evalCommands?: string[];
		};

		const containerId = meta.containerId;
		if (!containerId) {
			return {
				passed: false,
				score: 0,
				maxScore: 1,
				details: "No container ID — SWE-bench evaluation requires Docker isolation",
			};
		}

		const failToPass = meta.failToPass ?? [];
		const passToPass = meta.passToPass ?? [];
		const p2pSample = passToPass.slice(0, 20);
		const testFiles = meta.testFiles ?? [];
		const baseCommit = meta.baseCommit ?? "";
		const testPatch = meta.testPatch ?? "";
		const testCmd = meta.testCmd ?? "pytest -rA --tb=no";
		const evalCommands = meta.evalCommands ?? [];

		// 1. Collect agent's diff
		const diffResult = await execInContainer(containerId, "cd /testbed && git diff", 30_000);
		let agentDiff = diffResult.stdout;

		if (!agentDiff.trim()) {
			// Also check staged
			const stagedResult = await execInContainer(
				containerId,
				"cd /testbed && git diff --cached",
				10_000,
			);
			agentDiff = stagedResult.stdout;
			if (!agentDiff.trim()) {
				return {
					passed: false,
					score: 0,
					maxScore: 1,
					details: "Agent made no changes to the repository",
					metadata: { containerId },
				};
			}
		}

		const testTargets = [...failToPass, ...p2pSample].map(toTestTarget);
		const testArgs = testTargets.map(shellQuote).join(" ");
		const quotedTestFiles = testFiles.map(shellQuote).join(" ");
		const quotedBaseCommit = baseCommit ? shellQuote(baseCommit) : "";

		// 2. Build evaluation script (mirrors SWE-bench official eval_script where practical)
		const evalScript = [
			"#!/bin/bash",
			"set -uxo pipefail",
			"cd /testbed",
			"",
			// Eval commands (locale setup etc.)
			...evalCommands,
			"",
			// Reset test files to base_commit state
			...(testFiles.length > 0 && baseCommit
				? [`git checkout ${quotedBaseCommit} -- ${quotedTestFiles}`]
				: []),
			"",
			// Apply gold test_patch
			...(testPatch
				? [
						"cat > /tmp/test_patch.diff << 'ENDOFPATCH'",
						testPatch,
						"ENDOFPATCH",
						"git apply -v /tmp/test_patch.diff || git apply -v --reject /tmp/test_patch.diff || patch --batch --fuzz=5 -p1 -i /tmp/test_patch.diff",
					]
				: []),
			"",
			"echo '>>>>> Start Test Output'",
			`${testCmd}${testArgs ? ` ${testArgs}` : ""} 2>&1`,
			"TEST_EXIT=$?",
			"echo '>>>>> End Test Output'",
			"",
			// Restore test files
			...(testFiles.length > 0 && baseCommit
				? [`git checkout ${quotedBaseCommit} -- ${quotedTestFiles} 2>/dev/null || true`]
				: []),
			"",
			"exit $TEST_EXIT",
		].join("\n");

		// 3. Execute evaluation
		const evalResult = await execScript(containerId, evalScript, 300_000); // 5 min timeout

		// 4. Parse test output
		const fullOutput = `${evalResult.stdout}\n${evalResult.stderr}`;

		// Extract between markers
		const startMarker = ">>>>> Start Test Output";
		const endMarker = ">>>>> End Test Output";
		const startIdx = fullOutput.indexOf(startMarker);
		const endIdx = fullOutput.indexOf(endMarker);
		const testOutput =
			startIdx >= 0 && endIdx > startIdx
				? fullOutput.slice(startIdx + startMarker.length, endIdx)
				: fullOutput;

		const testResults = parsePytestOutput(testOutput);
		const summary = summarizeSweBenchTestResults({ failToPass, passToPass, testResults });

		const details = [
			`Resolution: ${summary.resolution}`,
			`FAIL_TO_PASS: ${summary.f2pPassed}/${summary.f2pTotal} fixed`,
			...summary.f2pDetails,
			`PASS_TO_PASS sample: ${summary.p2pPassed}/${summary.p2pTotal} maintained${summary.p2pSampled ? ` (sampled from ${summary.p2pTotalAvailable})` : ""}`,
			`PASS_TO_PASS checked: ${summary.p2pChecked}`,
			...summary.p2pDetails,
			`Test exit code: ${evalResult.exitCode}`,
		].join("\n");

		return {
			passed: summary.passed,
			score: summary.score,
			maxScore: 1,
			details,
			metadata: {
				containerId,
				resolution: summary.resolution,
				f2pPassed: summary.f2pPassed,
				f2pTotal: summary.f2pTotal,
				p2pPassed: summary.p2pPassed,
				p2pTotal: summary.p2pTotal,
				p2pTotalAvailable: summary.p2pTotalAvailable,
				p2pChecked: summary.p2pChecked,
				p2pSampled: summary.p2pSampled,
				agentDiff: agentDiff.slice(0, 10000),
				testExitCode: evalResult.exitCode,
				testOutput: testOutput.slice(0, 10000),
			},
		};
	},
};
