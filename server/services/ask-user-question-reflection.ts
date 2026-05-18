import { agentGenerateWithHistory } from "@server/lib/agent";
import { getToolMessage, type Locale } from "@server/lib/prompt-i18n";
import { narratorService } from "./narrator-service";

export interface AskQuestionOption {
	label: string;
	description: string;
	preview?: string;
}

export interface AskQuestionInput {
	question: string;
	header: string;
	options: AskQuestionOption[];
	multiSelect?: boolean;
}

const MAX_CONVERSATION_CONTEXT_CHARS = 24_000;
const DEFAULT_FREE_TEXT_ANSWER: Record<Locale, string> = {
	en: "No special preference; please use your best judgment.",
	"zh-CN": "无特别偏好，请按最佳判断执行。",
};

export function coerceAskQuestions(raw: unknown): AskQuestionInput[] {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(value)) return [];
	const questions: AskQuestionInput[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (typeof record.question !== "string" || typeof record.header !== "string") continue;
		const rawOptions = Array.isArray(record.options) ? record.options : [];
		const options = rawOptions
			.map((option) => {
				if (!option || typeof option !== "object") return null;
				const optionRecord = option as Record<string, unknown>;
				if (typeof optionRecord.label !== "string") return null;
				return {
					label: optionRecord.label,
					description: typeof optionRecord.description === "string" ? optionRecord.description : "",
					...(typeof optionRecord.preview === "string" ? { preview: optionRecord.preview } : {}),
				};
			})
			.filter((option): option is AskQuestionOption => option !== null);
		questions.push({
			question: record.question,
			header: record.header,
			options,
			multiSelect: record.multiSelect === true,
		});
	}
	return questions;
}

function trimFromEnd(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return value.slice(value.length - maxChars);
}

async function buildConversationContext(narratorId: string): Promise<string> {
	const dbMessages = await narratorService.getMessagesSinceLastCompact(narratorId);
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
				? `\nOptions: ${q.options.map((o) => `${o.label} — ${o.description}`).join("; ")}`
				: "\n(free-text, no predefined options)";
			return `Key: "${q.question}"\nQuestion: ${q.header}${opts}`;
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
	const labels = question.options.map((option) => option.label);
	const fallback = labels[0] ?? DEFAULT_FREE_TEXT_ANSWER[locale] ?? DEFAULT_FREE_TEXT_ANSWER.en;
	if (rawValue == null) return fallback;

	const rawParts = Array.isArray(rawValue) ? rawValue : [rawValue];
	const stringParts = rawParts
		.flatMap((part) => (typeof part === "string" ? part.split(",") : [String(part)]))
		.map((part) => part.trim())
		.filter(Boolean);

	if (stringParts.length === 0) return fallback;
	if (!labels.length) return stringParts.join(", ");

	if (question.multiSelect) {
		const matched = stringParts.filter((part) => labels.includes(part));
		return matched.length > 0 ? matched.join(", ") : stringParts.join(", ");
	}

	const exact = stringParts.find((part) => labels.includes(part));
	return exact ?? stringParts[0] ?? fallback;
}

export async function generateAskUserQuestionAnswers(
	narratorId: string,
	questions: AskQuestionInput[],
	options: {
		locale?: Locale;
		model?: string | null;
		mode?: "suggest" | "reflection";
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
	const raw = await agentGenerateWithHistory(
		systemPrompt,
		userMessage,
		options.model ?? undefined,
		locale,
		{
			reasoningEffort: "none",
		},
	);
	const parsed = parseAnswerObject(raw);
	const answers: Record<string, string> = {};
	for (const question of questions) {
		answers[question.question] = normalizeAnswerValue(question, parsed[question.question], locale);
	}
	return answers;
}
