/**
 * HumanEval evaluator.
 *
 * The agent writes solution.py. We concatenate it with the original test harness
 * from openai/human-eval and execute via python3.
 *
 * The testCode field contains the original `check(candidate)` function definition
 * followed by `check(<entry_point>)` call.
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkEvaluator, BenchmarkTask, EvalResult } from "./types";
import { runCommand } from "./util";

/**
 * Try to find the solution the agent produced.
 * Priority: solution.py in workDir > code fences in agentOutput.
 */
async function extractSolution(agentOutput: string, workDir: string): Promise<string> {
	const solutionPath = join(workDir, "solution.py");
	if (existsSync(solutionPath)) {
		return readFile(solutionPath, "utf-8");
	}

	// Also check for any .py file the agent may have created
	try {
		const pyFiles = readdirSync(workDir).filter((f) => f.endsWith(".py") && !f.startsWith("_"));
		if (pyFiles.length === 1) {
			return readFile(join(workDir, pyFiles[0]), "utf-8");
		}
	} catch {
		// ignore
	}

	// Extract from markdown code fence
	const fenceRe = /```(?:python)?\s*\n([\s\S]*?)```/g;
	let best = "";
	let m: RegExpExecArray | null;
	while ((m = fenceRe.exec(agentOutput)) !== null) {
		if (m[1].length > best.length) best = m[1];
	}
	if (best) return best;

	// Fallback: treat entire output as code
	return agentOutput;
}

export const humanevalEvaluator: BenchmarkEvaluator = {
	name: "humaneval",

	async evaluate(task: BenchmarkTask, agentOutput: string, workDir: string): Promise<EvalResult> {
		const solution = await extractSolution(agentOutput, workDir);
		if (!solution.trim()) {
			return { passed: false, score: 0, maxScore: 1, details: "No solution produced" };
		}

		const testCode = task.testCode ?? "";
		if (!testCode) {
			return {
				passed: false,
				score: 0,
				maxScore: 1,
				details: "No test code available for this task",
			};
		}

		// Build combined script: solution + original test harness
		// testCode already includes:
		//   1. METADATA dict (harmless)
		//   2. def check(candidate): ... (the test function)
		//   3. check(<entry_point>)  (the call added by prepare script)
		const script = [solution, "", testCode].join("\n");

		const scriptPath = join(workDir, "_eval_test.py");
		await writeFile(scriptPath, script, "utf-8");

		const result = await runCommand(["python3", scriptPath], workDir, 30_000);
		const passed = result.exitCode === 0;
		return {
			passed,
			score: passed ? 1 : 0,
			maxScore: 1,
			details: passed
				? "All tests passed"
				: `Tests failed (exit ${result.exitCode}):\n${result.stderr.slice(0, 2000)}`,
		};
	},
};
