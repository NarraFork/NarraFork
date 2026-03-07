/**
 * Built-in routines registry.
 *
 * Routines are pre-defined commands and skills that ship with NarraFork.
 * When enabled, they are materialized into the file system (skills → SKILL.md)
 * or user/project command lists, so the existing command/skill infrastructure
 * picks them up without any special-casing.
 */

export interface BuiltinCommandDef {
	name: string;
	prompt: string;
	descriptionEn: string;
	descriptionZh: string;
	params?: Array<{
		name: string;
		description?: string;
		required?: boolean;
		defaultValue?: string;
	}>;
}

export interface BuiltinSkillDef {
	name: string;
	descriptionEn: string;
	descriptionZh: string;
	/** The markdown body of the SKILL.md (everything after the frontmatter). */
	content: string;
}

export interface BuiltinRoutine {
	/** Unique stable identifier, e.g. "review", "tdd". */
	id: string;
	type: "command" | "skill";
	category: string;
	command?: BuiltinCommandDef;
	skill?: BuiltinSkillDef;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const BUILTIN_ROUTINES: BuiltinRoutine[] = [
	// ── Commands ──────────────────────────────────────────────────────────
	{
		id: "review",
		type: "command",
		category: "code-quality",
		command: {
			name: "review",
			descriptionEn: "Code review for the given file or recent changes",
			descriptionZh: "对指定文件或最近变更进行代码审查",
			prompt:
				"Please review the following code or recent changes. Focus on correctness, readability, potential bugs, and suggest improvements.\n\n{{input}}",
		},
	},
	{
		id: "refactor",
		type: "command",
		category: "code-quality",
		command: {
			name: "refactor",
			descriptionEn: "Suggest refactoring for the given code",
			descriptionZh: "对指定代码提出重构建议",
			prompt:
				"Please analyze the following code and suggest refactoring improvements. Focus on reducing complexity, improving naming, extracting reusable pieces, and following SOLID principles.\n\n{{input}}",
		},
	},
	{
		id: "test",
		type: "command",
		category: "testing",
		command: {
			name: "test",
			descriptionEn: "Generate tests for the given code or module",
			descriptionZh: "为指定代码或模块生成测试",
			prompt:
				"Please generate comprehensive tests for the following code or module. Include edge cases, error scenarios, and use the project's existing test framework and conventions.\n\n{{input}}",
		},
	},
	{
		id: "explain",
		type: "command",
		category: "workflow",
		command: {
			name: "explain",
			descriptionEn: "Explain how the given code works",
			descriptionZh: "解释指定代码的工作原理",
			prompt:
				"Please explain how the following code works in detail. Cover the overall architecture, key data flows, and any non-obvious design decisions.\n\n{{input}}",
		},
	},
	{
		id: "fix",
		type: "command",
		category: "code-quality",
		command: {
			name: "fix",
			descriptionEn: "Fix the described bug or error",
			descriptionZh: "修复描述的 bug 或错误",
			prompt:
				"Please investigate and fix the following bug or error. Explain the root cause and verify the fix doesn't introduce regressions.\n\n{{input}}",
		},
	},
	{
		id: "doc",
		type: "command",
		category: "workflow",
		command: {
			name: "doc",
			descriptionEn: "Generate or improve documentation",
			descriptionZh: "生成或改进文档",
			prompt:
				"Please generate or improve documentation for the following code. Include JSDoc/TSDoc comments, README sections, or API documentation as appropriate.\n\n{{input}}",
		},
	},

	// ── Skills ────────────────────────────────────────────────────────────
	{
		id: "security-check",
		type: "skill",
		category: "code-quality",
		skill: {
			name: "security-check",
			descriptionEn: "Security audit checklist for code changes",
			descriptionZh: "代码变更的安全审计检查清单",
			content: `When loaded, apply the following security checklist to the code or changes in context:

1. **Input Validation** — Are all user inputs validated and sanitized?
2. **Authentication & Authorization** — Are auth checks in place for protected resources?
3. **SQL Injection** — Are queries parameterized? No string concatenation with user input?
4. **XSS** — Is output properly escaped in HTML/JSX contexts?
5. **Path Traversal** — Are file paths validated against directory traversal?
6. **Secrets** — No hardcoded API keys, passwords, or tokens?
7. **Dependencies** — Any known vulnerable dependencies?
8. **Error Handling** — Do error messages avoid leaking internal details?
9. **CORS/CSRF** — Are cross-origin policies properly configured?
10. **Rate Limiting** — Are sensitive endpoints rate-limited?

Report findings with severity (Critical/High/Medium/Low) and suggest fixes.`,
		},
	},
	{
		id: "performance",
		type: "skill",
		category: "code-quality",
		skill: {
			name: "performance",
			descriptionEn: "Performance optimization analysis",
			descriptionZh: "性能优化分析",
			content: `When loaded, analyze the code in context for performance issues:

1. **N+1 Queries** — Database queries inside loops?
2. **Unnecessary Re-renders** — React components re-rendering without prop changes?
3. **Memory Leaks** — Uncleared intervals, event listeners, or subscriptions?
4. **Bundle Size** — Large imports that could be tree-shaken or lazy-loaded?
5. **Caching** — Opportunities for memoization or HTTP caching?
6. **Async Patterns** — Sequential awaits that could be parallelized?
7. **Algorithm Complexity** — O(n²) or worse that could be optimized?
8. **Resource Loading** — Images, fonts, or scripts blocking the critical path?

Provide specific recommendations with expected impact.`,
		},
	},
	{
		id: "tdd",
		type: "skill",
		category: "testing",
		skill: {
			name: "tdd",
			descriptionEn: "Test-Driven Development workflow guide",
			descriptionZh: "测试驱动开发工作流指南",
			content: `When loaded, follow the TDD workflow for the requested feature or change:

1. **Red** — Write a failing test first that describes the expected behavior.
2. **Green** — Write the minimum code to make the test pass.
3. **Refactor** — Clean up the code while keeping tests green.

Rules:
- Never write production code without a failing test.
- Each cycle should be small and focused (one behavior at a time).
- Run tests after each step to verify the cycle.
- Use descriptive test names that document the behavior.
- Commit after each green-refactor cycle.`,
		},
	},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getBuiltinRoutine(id: string): BuiltinRoutine | undefined {
	return BUILTIN_ROUTINES.find((r) => r.id === id);
}

export function getAllBuiltinRoutines(): BuiltinRoutine[] {
	return BUILTIN_ROUTINES;
}

export function getBuiltinCommandRoutines(): BuiltinRoutine[] {
	return BUILTIN_ROUTINES.filter((r) => r.type === "command");
}

export function getBuiltinSkillRoutines(): BuiltinRoutine[] {
	return BUILTIN_ROUTINES.filter((r) => r.type === "skill");
}

/** Get all unique categories. */
export function getBuiltinCategories(): string[] {
	return [...new Set(BUILTIN_ROUTINES.map((r) => r.category))];
}
