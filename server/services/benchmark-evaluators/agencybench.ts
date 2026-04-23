/**
 * AgencyBench evaluator.
 *
 * Strategy: uses rubric-based scoring.
 * For each rubric criterion, we check rule-based conditions first,
 * then fall back to heuristic scoring.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkEvaluator, BenchmarkTask, EvalResult, RubricCriterion } from "./types";
import { runBash } from "./util";

/** Check if specific files exist in the work directory. */
function checkFileExists(workDir: string, patterns: string[]): { found: string[]; missing: string[] } {
	const found: string[] = [];
	const missing: string[] = [];
	for (const p of patterns) {
		if (existsSync(join(workDir, p))) {
			found.push(p);
		} else {
			missing.push(p);
		}
	}
	return { found, missing };
}

/** Simple rule-based rubric evaluation. */
async function evaluateRubricRule(
	criterion: RubricCriterion & { checkFiles?: string[]; checkCmd?: string },
	workDir: string,
): Promise<{ score: number; detail: string }> {
	// File existence check
	if (criterion.checkFiles?.length) {
		const { found, missing } = checkFileExists(workDir, criterion.checkFiles);
		const ratio = found.length / criterion.checkFiles.length;
		const score = Math.round(ratio * criterion.maxPoints * 10) / 10;
		return {
			score,
			detail: missing.length
				? `Files found: ${found.join(", ")}; Missing: ${missing.join(", ")}`
				: `All required files present: ${found.join(", ")}`,
		};
	}

	// Command check
	if (criterion.checkCmd) {
		const result = await runBash(criterion.checkCmd, workDir, 60_000);
		return {
			score: result.exitCode === 0 ? criterion.maxPoints : 0,
			detail:
				result.exitCode === 0
					? `Command passed: ${criterion.checkCmd.slice(0, 80)}`
					: `Command failed: ${(result.stderr || result.stdout).slice(0, 500)}`,
		};
	}

	// Fallback: check if workDir has any files (agent did something)
	try {
		const files = await readdir(workDir, { recursive: true });
		const nonHidden = files.filter((f) => !String(f).startsWith("."));
		if (nonHidden.length > 2) {
			return {
				score: Math.round(criterion.maxPoints * 0.5 * 10) / 10,
				detail: `Agent produced ${nonHidden.length} files (partial credit)`,
			};
		}
	} catch {
		// ignore
	}

	return { score: 0, detail: "Could not evaluate criterion automatically" };
}

export const agencybenchEvaluator: BenchmarkEvaluator = {
	name: "agencybench",

	async evaluate(task: BenchmarkTask, agentOutput: string, workDir: string): Promise<EvalResult> {
		const rubric = task.rubric ?? [];
		if (!rubric.length) {
			// No rubric — binary check: did the agent produce any meaningful output?
			const hasOutput = agentOutput.trim().length > 50;
			try {
				const files = await readdir(workDir, { recursive: true });
				const produced = files.filter((f) => !String(f).startsWith(".")).length;
				if (produced > 2 || hasOutput) {
					return {
						passed: true,
						score: 0.5,
						maxScore: 1,
						details: `Agent produced output (${produced} files) but no rubric to evaluate against`,
					};
				}
			} catch {
				// ignore
			}
			return {
				passed: false,
				score: 0,
				maxScore: 1,
				details: "No rubric defined and agent produced no meaningful output",
			};
		}

		let totalScore = 0;
		let totalMax = 0;
		const criterionResults: Array<{ name: string; score: number; max: number; detail: string }> = [];

		for (const criterion of rubric) {
			const { score, detail } = await evaluateRubricRule(
				criterion as RubricCriterion & { checkFiles?: string[]; checkCmd?: string },
				workDir,
			);
			totalScore += score;
			totalMax += criterion.maxPoints;
			criterionResults.push({ name: criterion.name, score, max: criterion.maxPoints, detail });
		}

		const normalizedScore = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) / 100 : 0;
		const passed = normalizedScore >= 0.5;

		const detailLines = criterionResults.map(
			(r) => `  [${r.score}/${r.max}] ${r.name}: ${r.detail}`,
		);

		return {
			passed,
			score: normalizedScore,
			maxScore: 1,
			details: `Score: ${totalScore}/${totalMax} (${Math.round(normalizedScore * 100)}%)\n${detailLines.join("\n")}`,
			metadata: { criterionResults },
		};
	},
};
