import { agentGenerateWithHistory, withAuxiliaryRetry } from "@server/lib/agent";
import { getToolMessage, type Locale } from "@server/lib/prompt-i18n";
import { createThrottledProgressReporter, type ProgressSnapshot } from "@shared/progress-phase";
import {
	type AskQuestionInput,
	type AskQuestionOption,
	coerceAskQuestions,
} from "./ask-user-question-coerce";
import { narratorService } from "./narrator-service";

export type { AskQuestionInput, AskQuestionOption };
// Re-export the pure coercion module's public API so existing import paths
// (`./ask-user-question-reflection`) keep working. The coercion logic itself
// now lives in `ask-user-question-coerce.ts`, which has no side-effect imports
// so unit tests can exercise it without booting the db/agent stack.
export { coerceAskQuestions };

const MAX_CONVERSATION_CONTEXT_CHARS = 24_000;
const DEFAULT_FREE_TEXT_ANSWER: Record<Locale, string> = {
	en: "No special preference; please use your best judgment.",
	"zh-CN": "无特别偏好，请按最佳判断执行。",
};

function trimFromEnd(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return value.slice(value.length - maxChars);
}

async function buildConversationContext(narratorId: string): Promise<string> {
	const dbMessages = await narratorService.getModelHistorySinceLastCompact(narratorId);
	const conversationLines: string[] = [];
	let totalChars = 0;
	for (let i = dbMessages.length - 1; i >= 0; i--) {
		const message = dbMessages[i];
		if (message.parentToolUseId) continue;
		const text = message.contentText ?? "";
		if (!text.trim()) continue;
		const role =
			message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System";
		const line = `[${role}]: ${text}`;
		conversationLines.push(line);
		totalChars += line.length;
		if (totalChars >= MAX_CONVERSATION_CONTEXT_CHARS) break;
	}
	return trimFromEnd(conversationLines.reverse().join("\n\n"), MAX_CONVERSATION_CONTEXT_CHARS);
}

function buildQuestionsText(questions: AskQuestionInput[]): string {
	return questions
		.map((q) => {
			const opts = q.options.length
				? `\nOptions: ${q.options.map((o) => `${o.header} — ${o.description ?? ""}`).join("; ")}`
				: "\n(free-text, no predefined options)";
			// header = short title; description = full prompt. Answers are keyed by header.
			return `Title: ${q.header}\nQuestion: ${q.description || q.header}${opts}`;
		})
		.join("\n\n");
}

function parseAnswerObject(raw: string): Record<string, unknown> {
	const cleaned = raw
		.replace(/```(?:json)?\s*/g, "")
		.replace(/```\s*/g, "")
		.trim();
	try {
		const parsed = JSON.parse(cleaned) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Fall through to caller fallback.
	}
	return {};
}

function normalizeAnswerValue(
	question: AskQuestionInput,
	rawValue: unknown,
	locale: Locale,
): string {
	const headers = question.options.map((option) => option.header);
	const fallback = headers[0] ?? DEFAULT_FREE_TEXT_ANSWER[locale] ?? DEFAULT_FREE_TEXT_ANSWER.en;
	if (rawValue == null) return fallback;

	const rawParts = Array.isArray(rawValue) ? rawValue : [rawValue];
	const stringParts = rawParts
		.flatMap((part) => (typeof part === "string" ? part.split(",") : [String(part)]))
		.map((part) => part.trim())
		.filter(Boolean);

	if (stringParts.length === 0) return fallback;
	if (!headers.length) return stringParts.join(", ");

	if (question.multiSelect) {
		const matched = stringParts.filter((part) => headers.includes(part));
		return matched.length > 0 ? matched.join(", ") : stringParts.join(", ");
	}

	const exact = stringParts.find((part) => headers.includes(part));
	return exact ?? stringParts[0] ?? fallback;
}

export async function generateAskUserQuestionAnswers(
	narratorId: string,
	questions: AskQuestionInput[],
	options: {
		locale?: Locale;
		model?: string | null;
		mode?: "suggest" | "reflection";
		signal?: AbortSignal;
		/**
		 * Live two-phase progress while the model works. Unlike the other three
		 * gates this one does not run through `runReflectionLoop`, so the caller
		 * injects its own throttled reporter here (see `@shared/progress-phase`).
		 */
		onProgress?: (snapshot: ProgressSnapshot) => void;
	} = {},
): Promise<Record<string, string>> {
	const locale = options.locale ?? "en";
	const mode = options.mode ?? "reflection";
	const conversationContext = await buildConversationContext(narratorId);
	const questionsText = buildQuestionsText(questions);
	const userMessage = conversationContext
		? `<conversation>\n${conversationContext}\n</conversation>\n\n<questions>\n${questionsText}\n</questions>`
		: questionsText;
	const systemPrompt = getToolMessage(
		mode === "suggest" ? "suggestAnswerSystem" : "questionReflectionSystem",
		locale,
	);
	const progress = createThrottledProgressReporter(options.onProgress);
	let raw: string;
	try {
		raw = await withAuxiliaryRetry(
			() =>
				agentGenerateWithHistory(systemPrompt, userMessage, options.model ?? undefined, locale, {
					reasoningEffort: "none",
					...(options.signal ? { signal: options.signal } : {}),
					...(options.onProgress
						? {
								onTextDelta: progress.addOutput,
								onReasoningDelta: progress.addThinking,
							}
						: {}),
				}),
			{ signal: options.signal, label: `AskUserQuestion ${mode}` },
		);
	} finally {
		progress.finish();
	}
	const parsed = parseAnswerObject(raw);
	const answers: Record<string, string> = {};
	for (const question of questions) {
		// Model-facing key is the uniquified question header. Internal id still
		// accepted for older reflection prompts / stored drafts.
		const rawValue = parsed[question.header] ?? parsed[question.id];
		answers[question.header] = normalizeAnswerValue(question, rawValue, locale);
	}
	return answers;
}
