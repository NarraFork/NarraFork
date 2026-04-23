/**
 * AgencyBench evaluator.
 *
 * Original AgencyBench uses eval_task.py (1000+ line Python scripts) with
 * Docker sandboxes, vision-based judges, and LLM-as-judge for evaluation.
 *
 * This evaluator implements a simplified but honest approach:
 *   1. Check if the agent produced deliverable files
 *   2. Try to run any executable deliverables (Python scripts, etc.)
 *   3. Parse rubric text for numeric thresholds and check against output
 *   4. Fall back to file-count heuristic for criteria we can't auto-evaluate
 *
 * Rubric criteria from the original dataset are natural-language descriptions
 * embedded in subtask text, not structured checkFiles/checkCmd.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkEvaluator, BenchmarkTask, EvalResult, RubricCriterion } from "./types";
import { runCommand } from "./util";

/** Try to evaluate a rubric criterion. */
async function evaluateRubricRule(
	criterion: RubricCriterion,
	workDir: string,
	_agentOutput: string,
): Promise<{ score: number; detail: string }> {
	const desc = criterion.description.toLowerCase();

	// Try to extract numeric threshold from rubric description
	// e.g. "Score = 0 if loss >= 5e-2, Score = 10 if loss <= 1e-3"
	const thresholdMatch = desc.match(/loss\s*[<>=]+\s*([\d.e-]+)/);

	// Check if there are deliverable files mentioned in the description
	const filePatterns: string[] = [];
	const fileMatch = criterion.description.match(/`([^`]+\.\w+)`/g);
	if (fileMatch) {
		for (const m of fileMatch) {
			filePatterns.push(m.replace(/`/g, ""));
		}
	}

	// Check deliverable files
	if (filePatterns.length > 0) {
		let found = 0;
		for (const pattern of filePatterns) {
			// Check both exact path and just filename
			if (existsSync(join(workDir, pattern))) {
				found++;
			} else {
				// Search recursively
				try {
					const allFiles = await readdir(workDir, { recursive: true });
					if (allFiles.some((f) => String(f).endsWith(pattern) || String(f) === pattern)) {
						found++;
					}
				} catch {
					// ignore
				}
			}
		}
		const ratio = found / filePatterns.length;
		const score = Math.round(ratio * criterion.maxPoints * 10) / 10;
		return {
			score,
			detail:
				ratio === 1
					? `All deliverables found: ${filePatterns.join(", ")}`
					: `Found ${found}/${filePatterns.length} deliverables: ${filePatterns.join(", ")}`,
		};
	}

	// Try to run Python scripts the agent created
	try {
		const allFiles = await readdir(workDir, { recursive: true });
		const pyFiles = allFiles.filter(
			(f) => String(f).endsWith(".py") && !String(f).startsWith("_") && !String(f).startsWith("."),
		);

		if (pyFiles.length > 0) {
			// SECURITY: Executes agent-generated scripts without sandboxing.
			// Only safe in isolated benchmark environments (containers / temp dirs).
			const mainPy = pyFiles.find((f) => String(f).includes("main")) ?? pyFiles[0];
			const result = await runCommand(["python3", String(mainPy)], workDir, 30_000);

			if (result.exitCode === 0 && result.stdout.trim().length > 0) {
				// Check for numeric output that might match threshold
				if (thresholdMatch) {
					const threshold = Number.parseFloat(thresholdMatch[1]);
					const numMatch = result.stdout.match(/([\d.e-]+)/g);
					if (numMatch) {
						const lastNum = Number.parseFloat(numMatch[numMatch.length - 1]);
						if (!Number.isNaN(lastNum) && lastNum <= threshold) {
							return {
								score: criterion.maxPoints,
								detail: `Script output (${lastNum}) meets threshold (${threshold})`,
							};
						}
					}
				}

				return {
					score: Math.round(criterion.maxPoints * 0.7 * 10) / 10,
					detail: `Script executed successfully: ${result.stdout.slice(0, 200)}`,
				};
			}

			// Script exists but failed
			return {
				score: Math.round(criterion.maxPoints * 0.3 * 10) / 10,
				detail: `Script exists but execution failed: ${(result.stderr || result.stdout).slice(0, 200)}`,
			};
		}
	} catch {
		// ignore
	}

	// Fallback: check if agent produced any files at all
	try {
		const files = await readdir(workDir, { recursive: true });
		const nonHidden = files.filter((f) => !String(f).startsWith(".") && !String(f).startsWith("_"));
		if (nonHidden.length > 2) {
			return {
				score: Math.round(criterion.maxPoints * 0.3 * 10) / 10,
				detail: `Agent produced ${nonHidden.length} files (partial credit, no auto-eval possible)`,
			};
		}
	} catch {
		// ignore
	}

	return { score: 0, detail: "No deliverables found and no auto-evaluation possible" };
}

export const agencybenchEvaluator: BenchmarkEvaluator = {
	name: "agencybench",

	async evaluate(task: BenchmarkTask, agentOutput: string, workDir: string): Promise<EvalResult> {
		const rubric = task.rubric ?? [];

		// List what the agent produced
		let agentFiles: string[] = [];
		try {
			const entries = await readdir(workDir, { recursive: true });
			agentFiles = entries.map(String).filter((f) => !f.startsWith(".") && !f.startsWith("_"));
		} catch {
			// ignore
		}

		if (!rubric.length) {
			// No rubric — heuristic evaluation
			const hasOutput = agentOutput.trim().length > 50;
			if (agentFiles.length > 2 || hasOutput) {
				return {
					passed: true,
					score: 0.5,
					maxScore: 1,
					details: `Agent produced output (${agentFiles.length} files) but no rubric to evaluate against`,
					metadata: { agentFiles },
				};
			}
			return {
				passed: false,
				score: 0,
				maxScore: 1,
				details: "No rubric defined and agent produced no meaningful output",
				metadata: { agentFiles },
			};
		}

		let totalScore = 0;
		let totalMax = 0;
		const criterionResults: Array<{ name: string; score: number; max: number; detail: string }> =
			[];

		for (const criterion of rubric) {
			const { score, detail } = await evaluateRubricRule(criterion, workDir, agentOutput);
			totalScore += score;
			totalMax += criterion.maxPoints;
			criterionResults.push({ name: criterion.name, score, max: criterion.maxPoints, detail });
		}

		const normalizedScore = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) / 100 : 0;
		const passed = normalizedScore >= 0.3; // Lower threshold since auto-eval is approximate

		const detailLines = criterionResults.map(
			(r) => `  [${r.score}/${r.max}] ${r.name}: ${r.detail}`,
		);

		return {
			passed,
			score: normalizedScore,
			maxScore: 1,
			details: `Score: ${totalScore}/${totalMax} (${Math.round(normalizedScore * 100)}%)\n${detailLines.join("\n")}`,
			metadata: { criterionResults, agentFiles },
		};
	},
};
