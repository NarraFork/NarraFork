/** Shared types for benchmark evaluators. */

export interface BenchmarkTask {
	id: string;
	name: string;
	prompt: string;
	/** Language for code tasks (e.g. "python", "typescript") */
	language?: string;
	/** Expected output or canonical solution (for reference) */
	expectedOutput?: string;
	/** Test code to run against agent output */
	testCode?: string;
	/** Rubric criteria for LLM-as-judge evaluation */
	rubric?: RubricCriterion[];
	/** Task-specific metadata */
	metadata?: Record<string, unknown>;
	/** Timeout in ms (overrides run-level default) */
	timeoutMs?: number;
}

export interface RubricCriterion {
	name: string;
	description: string;
	maxPoints: number;
}

export interface EvalResult {
	passed: boolean;
	score: number;
	maxScore: number;
	details: string;
	metadata?: Record<string, unknown>;
}

export interface BenchmarkEvaluator {
	/** Unique evaluator name (matches suite name). */
	name: string;
	/** Evaluate agent output for a single task. */
	evaluate(task: BenchmarkTask, agentOutput: string, workDir: string): Promise<EvalResult>;
}
