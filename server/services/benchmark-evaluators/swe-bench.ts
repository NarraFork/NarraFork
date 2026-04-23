/**
 * SWE-bench evaluator.
 *
 * IMPORTANT: True SWE-bench evaluation requires:
 *   1. Cloning the target repo at the correct base_commit
 *   2. Installing the repo's dependencies in an isolated environment
 *   3. Applying the agent's patch
 *   4. Running the repo's test suite
 *
 * Since we run agents in bare temp directories (no pre-cloned repos),
 * this evaluator uses a simplified approach:
 *   - Check if the agent produced any Python files or patches
 *   - If the agent wrote files, try to run the test command from metadata
 *   - Score based on whether tests pass
 *
 * For full SWE-bench fidelity, the benchmark service would need to
 * pre-clone repos into workDir before agent execution.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkEvaluator, BenchmarkTask, EvalResult } from "./types";
import { runBash, runCommand } from "./util";

export const swebenchEvaluator: BenchmarkEvaluator = {
	name: "swe-bench",

	async evaluate(task: BenchmarkTask, agentOutput: string, workDir: string): Promise<EvalResult> {
		const meta = (task.metadata ?? {}) as {
			testCmd?: string;
			failToPass?: string[];
			repo?: string;
			goldPatch?: string;
		};

		// Check what the agent produced
		let agentFiles: string[] = [];
		try {
			const entries = await readdir(workDir, { recursive: true });
			agentFiles = entries
				.map(String)
				.filter((f) => !f.startsWith(".") && !f.startsWith("_"));
		} catch {
			// ignore
		}

		// Check for git repo (if service pre-cloned)
		const isGitRepo =
			existsSync(join(workDir, ".git")) ||
			(await runCommand(["git", "rev-parse", "--git-dir"], workDir, 5_000)).exitCode === 0;

		// Collect diff if in a git repo
		let diff = "";
		if (isGitRepo) {
			const diffResult = await runCommand(["git", "diff"], workDir, 10_000);
			diff = diffResult.stdout;
			if (!diff.trim()) {
				const stagedResult = await runCommand(["git", "diff", "--cached"], workDir, 10_000);
				diff = stagedResult.stdout;
			}
		}

		// Check for .patch or .diff files the agent may have written
		let patchContent = "";
		for (const f of agentFiles) {
			if (f.endsWith(".patch") || f.endsWith(".diff")) {
				try {
					patchContent = await readFile(join(workDir, f), "utf-8");
					break;
				} catch {
					// ignore
				}
			}
		}

		// Determine if agent produced meaningful output
		const hasChanges = diff.trim().length > 0 || patchContent.trim().length > 0;
		const hasPyFiles = agentFiles.some((f) => f.endsWith(".py"));
		const hasAnyOutput = agentOutput.trim().length > 100;

		if (!hasChanges && !hasPyFiles && !hasAnyOutput) {
			return {
				passed: false,
				score: 0,
				maxScore: 1,
				details: "Agent produced no meaningful output (no code changes, no files, no patch)",
				metadata: { agentFiles },
			};
		}

		// Try running test command if available and we're in a git repo
		if (meta.testCmd && isGitRepo) {
			const result = await runBash(meta.testCmd, workDir, 120_000);
			const passed = result.exitCode === 0;

			return {
				passed,
				score: passed ? 1 : 0,
				maxScore: 1,
				details: passed
					? "All tests passed after applying agent changes"
					: `Tests failed (exit ${result.exitCode}):\n${result.stderr.slice(0, 2000)}`,
				metadata: {
					diff: diff.slice(0, 10000),
					patchContent: patchContent.slice(0, 10000),
					exitCode: result.exitCode,
					agentFiles,
				},
			};
		}

		// Without a git repo, we can only do heuristic evaluation:
		// Check if the agent's output contains a plausible patch/fix
		const outputLower = agentOutput.toLowerCase();
		const hasPatchInOutput =
			outputLower.includes("diff --git") ||
			outputLower.includes("--- a/") ||
			outputLower.includes("+++ b/");
		const hasCodeFix =
			agentOutput.includes("```") && (agentOutput.includes("def ") || agentOutput.includes("class "));

		let score = 0;
		const details: string[] = [];

		if (hasChanges) {
			score += 0.4;
			details.push("Agent produced code changes (diff/patch)");
		}
		if (hasPyFiles) {
			score += 0.2;
			details.push(`Agent created Python files: ${agentFiles.filter((f) => f.endsWith(".py")).join(", ")}`);
		}
		if (hasPatchInOutput) {
			score += 0.2;
			details.push("Agent output contains a patch/diff");
		}
		if (hasCodeFix) {
			score += 0.1;
			details.push("Agent output contains code blocks");
		}
		if (hasAnyOutput) {
			score += 0.1;
			details.push("Agent provided analysis/explanation");
		}

		score = Math.min(score, 1);

		return {
			passed: score >= 0.5,
			score: Math.round(score * 100) / 100,
			maxScore: 1,
			details: `Heuristic evaluation (no git repo for test execution):\n${details.join("\n")}`,
			metadata: {
				diff: diff.slice(0, 10000),
				patchContent: patchContent.slice(0, 10000),
				agentFiles,
				isGitRepo,
				note: "Full SWE-bench evaluation requires pre-cloned repos with test infrastructure",
			},
		};
	},
};
