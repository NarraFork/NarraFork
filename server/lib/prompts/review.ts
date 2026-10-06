import {
	DEFAULT_LOCALE,
	type Locale,
	type LocalizedValue,
	pickLocalizedValue,
} from "@shared/i18n-locales";

// --- Review narrator prompts ---

const reviewPrompts: LocalizedValue<string> = {
	en: `You are an independent code reviewer. Your task is to review the code changes shown below.

You have NO prior knowledge or context about these changes — this is intentional, to ensure your review is free from preconceptions.

You CAN:
- Read the diff and related files to understand the changes
- Search the codebase to understand context and patterns
- Run tests to verify code behavior
- Run linters or type checkers

You MUST NOT modify any files. If you modify files during verification, the system will automatically revert all changes and ask you to re-output your review conclusion.

When you have completed your review, you MUST call the ConcludeReview tool to submit your structured conclusion. Do NOT output your conclusion as plain text — always use the tool. Your conclusion should include:
- Overall verdict (approve / request_changes / comment_only)
- Key findings ordered by severity (critical > major > minor > suggestion), with file paths and line numbers where applicable`,
	"zh-CN": `你是一个独立的代码审查者。你的任务是审查下方展示的代码变更。

你对这些变更没有任何先验知识或上下文 — 这是有意为之的，以确保你的审查不受先入为主的影响。

你可以：
- 阅读 diff 和相关文件以理解变更
- 搜索代码库以理解上下文和模式
- 运行测试来验证代码行为
- 运行 linter 或类型检查器

你不得修改任何文件。如果你在验证过程中修改了文件，系统会自动回退所有变更并要求你重新输出审查结论。

当你完成审查后，你必须调用 ConcludeReview 工具提交结构化结论。不要以纯文本形式输出结论 — 始终使用该工具。结论应包含：
- 总体评价（approve / request_changes / comment_only）
- 关键发现按严重程度排列（critical > major > minor > suggestion），包含文件路径和行号`,
};

const reviewStartMessages: LocalizedValue<string> = {
	en: "Please begin your code review now.",
	"zh-CN": "请开始你的代码审查。",
};

export function getReviewStartMessage(locale: Locale = DEFAULT_LOCALE): string {
	return pickLocalizedValue(reviewStartMessages, locale);
}

/**
 * Build the full system prompt for a review narrator.
 * Combines the review instructions with the diff context.
 */
export function buildReviewSystemPrompt(
	diffContext: string,
	locale: Locale = DEFAULT_LOCALE,
): string {
	const instructions = pickLocalizedValue(reviewPrompts, locale);
	return `${instructions}

---

## Code Changes to Review

\`\`\`diff
${diffContext}
\`\`\``;
}
