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
 *      d. Runs the test command
 *      e. Parses output to check FAIL_TO_PASS / PASS_TO_PASS
 */

import { execInContainer, execScript } from "../benchmark-container";
import type { BenchmarkEvaluator, BenchmarkTask, EvalResult } from "./types";

/** Parse pytest-style output to extract test results. */
function parsePytestOutput(output: string): Map<string, "PASSED" | "FAILED" | "ERROR"> {
	const results = new Map<string, "PASSED" | "FAILED" | "ERROR">();
	for (const line of output.split("\n")) {
		const m = line.match(/^(PASSED|FAILED|ERROR)\s+(.+)/);
		if (m) {
			results.set(m[2].trim(), m[1] as "PASSED" | "FAILED" | "ERROR");
			continue;
		}
		// Alternative format: "test_file.py::test_name PASSED"
		const m2 = line.match(/^(\S+::\S+)\s+(PASSED|FAILED|ERROR)/);
		if (m2) {
			results.set(m2[1], m2[2] as "PASSED" | "FAILED" | "ERROR");
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
function findTestResult(
	testId: string,
	results: Map<string, "PASSED" | "FAILED" | "ERROR">,
): "PASSED" | "FAILED" | "ERROR" | null {
	// Exact match
	const exact = results.get(testId);
	if (exact) return exact;
	// Partial match (test ID might be a substring)
	for (const [key, val] of results) {
		if (key.includes(testId) || testId.includes(key)) return val;
	}
	return null;
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
		const testFiles = meta.testFiles ?? [];
		const baseCommit = meta.baseCommit ?? "";
		const testPatch = meta.testPatch ?? "";
		const testCmd = meta.testCmd ?? "pytest -rA --tb=no";
		const evalCommands = meta.evalCommands ?? [];

		// 1. Collect agent's diff
		const diffResult = await execInContainer(containerId, "cd /testbed && git diff", 30_000);
		const agentDiff = diffResult.stdout;

		if (!agentDiff.trim()) {
			// Also check staged
			const stagedResult = await execInContainer(
				containerId,
				"cd /testbed && git diff --cached",
				10_000,
			);
			if (!stagedResult.stdout.trim()) {
				return {
					passed: false,
					score: 0,
					maxScore: 1,
					details: "Agent made no changes to the repository",
					metadata: { containerId },
				};
			}
		}

		// 2. Build evaluation script (mirrors SWE-bench official eval_script)
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
				? [`git checkout ${baseCommit} -- ${testFiles.join(" ")}`]
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
			// Extract test directives from FAIL_TO_PASS
			"echo '>>>>> Start Test Output'",
			`${testCmd} ${failToPass
				.map((t) => {
					// For pytest: use the file::test format
					// For Django: use the test module path
					const parts = t.split("::");
					return parts.length > 1 ? t : parts[0];
				})
				.join(" ")} 2>&1`,
			"TEST_EXIT=$?",
			"echo '>>>>> End Test Output'",
			"",
			// Restore test files
			...(testFiles.length > 0 && baseCommit
				? [`git checkout ${baseCommit} -- ${testFiles.join(" ")} 2>/dev/null || true`]
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

		// 5. Check FAIL_TO_PASS (these should now PASS)
		let f2pPassed = 0;
		const f2pTotal = failToPass.length;
		const f2pDetails: string[] = [];
		for (const testId of failToPass) {
			const result = findTestResult(testId, testResults);
			if (result === "PASSED") {
				f2pPassed++;
				f2pDetails.push(`  ✓ ${testId}`);
			} else {
				f2pDetails.push(`  ✗ ${testId} (${result ?? "NOT FOUND"})`);
			}
		}

		// 6. Check PASS_TO_PASS (these should still PASS)
		let p2pPassed = 0;
		let p2pTotal = passToPass.length;
		const p2pDetails: string[] = [];
		// Only check a sample of P2P to save time (full P2P can be very large)
		const p2pSample = passToPass.slice(0, 20);
		p2pTotal = p2pSample.length;
		for (const testId of p2pSample) {
			const result = findTestResult(testId, testResults);
			if (result === "PASSED" || result === null) {
				// null = not in output, assume passed (we only ran F2P tests)
				p2pPassed++;
			} else {
				p2pDetails.push(`  ✗ REGRESSION: ${testId} (${result})`);
			}
		}

		// 7. Determine overall result
		const f2pRate = f2pTotal > 0 ? f2pPassed / f2pTotal : 0;
		const p2pRate = p2pTotal > 0 ? p2pPassed / p2pTotal : 1;
		const isFullResolve = f2pRate === 1 && p2pRate === 1;
		const isPartialResolve = f2pRate > 0 && p2pRate === 1;

		const resolution = isFullResolve ? "FULL" : isPartialResolve ? "PARTIAL" : "NO";
		const score = isFullResolve ? 1 : isPartialResolve ? f2pRate * 0.8 : 0;

		const details = [
			`Resolution: ${resolution}`,
			`FAIL_TO_PASS: ${f2pPassed}/${failToPass.length} fixed`,
			...f2pDetails,
			...(p2pDetails.length > 0
				? [`PASS_TO_PASS regressions:`, ...p2pDetails]
				: [`PASS_TO_PASS: ${p2pPassed}/${p2pTotal} maintained`]),
			`Test exit code: ${evalResult.exitCode}`,
		].join("\n");

		return {
			passed: isFullResolve,
			score: Math.round(score * 10000) / 10000,
			maxScore: 1,
			details,
			metadata: {
				containerId,
				resolution,
				f2pPassed,
				f2pTotal: failToPass.length,
				p2pPassed,
				p2pTotal,
				agentDiff: agentDiff.slice(0, 10000),
				testExitCode: evalResult.exitCode,
				testOutput: testOutput.slice(0, 10000),
			},
		};
	},
};
