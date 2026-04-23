/**
 * SWE-bench evaluator.
 *
 * Strategy: the agent works in a cloned repo directory.
 * After the agent finishes, we generate a diff of its changes,
 * then run the specified test commands to check if the issue is fixed.
 */
import type { BenchmarkEvaluator, BenchmarkTask, EvalResult } from "./types";
import { runBash, runCommand } from "./util";

export const swebenchEvaluator: BenchmarkEvaluator = {
	name: "swe-bench",

	async evaluate(task: BenchmarkTask, _agentOutput: string, workDir: string): Promise<EvalResult> {
		// Verify workDir is a git repository — the service layer must prepare it
		const gitCheck = await runCommand(["git", "rev-parse", "--git-dir"], workDir, 5_000);
		if (gitCheck.exitCode !== 0) {
			return {
				passed: false,
				score: 0,
				maxScore: 1,
				details:
					"workDir is not a git repository. The benchmark service must clone/checkout " +
					"the target repo into workDir before running the SWE-bench evaluator.",
			};
		}

		const meta = (task.metadata ?? {}) as {
			testCmd?: string;
			failToPass?: string[];
		};

		const testCmd = meta.testCmd;
		if (!testCmd) {
			return {
				passed: false,
				score: 0,
				maxScore: 1,
				details: "No test command specified in task metadata",
			};
		}

		// Capture the diff the agent produced
		let diff = "";
		const diffResult = await runCommand(["git", "diff"], workDir, 10_000);
		diff = diffResult.stdout;
		if (!diff.trim()) {
			const stagedResult = await runCommand(["git", "diff", "--cached"], workDir, 10_000);
			diff = stagedResult.stdout;
		}

		if (!diff.trim()) {
			return {
				passed: false,
				score: 0,
				maxScore: 1,
				details: "Agent made no changes to the repository",
				metadata: { diff: "" },
			};
		}

		// Run the test command
		const result = await runBash(testCmd, workDir, 120_000);
		const passed = result.exitCode === 0;

		// For SWE-bench, also check fail_to_pass tests specifically
		let failToPassOk = true;
		if (meta.failToPass?.length) {
			for (const testId of meta.failToPass) {
				if (
					result.stdout.includes(testId) &&
					(result.stdout.includes("FAILED") || result.stderr.includes("FAILED"))
				) {
					failToPassOk = false;
					break;
				}
			}
		}

		const finalPassed = passed && failToPassOk;

		return {
			passed: finalPassed,
			score: finalPassed ? 1 : 0,
			maxScore: 1,
			details: finalPassed
				? "All tests passed after applying agent changes"
				: `Tests failed (exit ${result.exitCode}):\n${result.stderr.slice(0, 2000)}`,
			metadata: {
				diff: diff.slice(0, 10000),
				exitCode: result.exitCode,
				stdout: result.stdout.slice(0, 5000),
				stderr: result.stderr.slice(0, 5000),
			},
		};
	},
};
