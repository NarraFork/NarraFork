import { eq } from "drizzle-orm";
import { db } from "../db";
import { userPreferences } from "../db/schema";

export type Locale = "en" | "zh-CN";
export type PromptKey = "title" | "summary" | "conflictResolution";

const prompts: Record<PromptKey, Record<Locale, string>> = {
	title: {
		en: `Based on the following conversation opening, generate a short descriptive title (max 50 characters). Use the same language as the conversation. Reply with ONLY the title text, no quotes, no punctuation wrapping, no explanation.

Conversation:
`,
		"zh-CN": `根据以下对话开头，生成一个简短的描述性标题（最多50个字符）。使用与对话相同的语言。只回复标题文本，不要引号、标点包裹或解释。

对话内容：
`,
	},
	summary: {
		en: `You are a context summarizer. Analyze the conversation history below and produce a concise summary focusing on:
1. Key decisions made
2. Current state of the code/project
3. Outstanding TODOs and next steps
4. Important context that a new session would need

Respond in the same language as the original conversation. Be concise but thorough.

Conversation history:
`,
		"zh-CN": `你是一个上下文总结器。分析以下对话历史，生成一个简洁的总结，重点关注：
1. 已做出的关键决策
2. 代码/项目的当前状态
3. 待办事项和下一步计划
4. 新会话需要了解的重要上下文

使用与原始对话相同的语言回复。简洁但全面。

对话历史：
`,
	},
	conflictResolution: {
		en: `A git merge from branch "{sourceBranch}" into "{targetBranch}" has produced conflicts in the following files:

{fileList}

Please resolve all merge conflicts in these files. The conflict markers (<<<<<<< HEAD, =======, >>>>>>>) are already present in the working directory. For each file:
1. Read the file to understand both sides of the conflict
2. Edit the file to produce the correct merged result, removing all conflict markers
3. Make sure the resolved code compiles and makes sense

Do NOT run git add or git commit — just resolve the conflicts in the files.`,
		"zh-CN": `从分支 "{sourceBranch}" 合并到 "{targetBranch}" 时，以下文件产生了冲突：

{fileList}

请解决这些文件中的所有合并冲突。冲突标记（<<<<<<< HEAD、=======、>>>>>>>）已存在于工作目录中。对于每个文件：
1. 读取文件以理解冲突双方的内容
2. 编辑文件以生成正确的合并结果，移除所有冲突标记
3. 确保解决后的代码可以编译且逻辑正确

不要运行 git add 或 git commit —— 只需解决文件中的冲突。`,
	},
};

/**
 * Get a localized prompt template by key and locale.
 * Falls back to English if the locale is not found.
 */
export function getPrompt(key: PromptKey, locale: Locale = "en"): string {
	return prompts[key][locale] ?? prompts[key].en;
}

/**
 * Get the language preference for a user from the database.
 * Returns "en" as default if no preference is set.
 */
export async function getUserLanguage(userId: string): Promise<Locale> {
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
		columns: { language: true },
	});
	return (pref?.language as Locale) ?? "en";
}
