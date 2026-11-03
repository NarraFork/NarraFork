/**
 * One prompt-optimization run, shared by every surface that offers the button.
 *
 * The composer's optimize button and the "new narrator" dialog's draft box ask the
 * same question ("rewrite this text in style X") and must answer it the same way:
 * same style instructions, same schema-constrained output, same refusal to hand a
 * truncated envelope back as prompt text. Keeping that in one place is what stops
 * the two call sites from drifting — the vendor-envelope handling below is subtle
 * enough that a second hand-rolled copy would eventually disagree with this one.
 *
 * The only difference between the call sites is CONTEXT. A narrator composer can
 * attach recent conversation, a not-yet-created narrator has none, so `contextText`
 * stays an input rather than something this module loads: loading it requires a
 * narrator id, which is exactly what the draft surface does not have.
 */

import type { Locale } from "@shared/i18n-locales";
import { summaryGenerate } from "../agent";
import { generateWithFirstTokenTimeout } from "../agent/generate-first-token-timeout";
import type { ResponseFormat } from "../agent/provider";
import { ValidationError } from "../errors";
import { logger } from "../logger";
import { resolveEffectiveModel, settings } from "../settings";
import {
	getOptimizeOutputSchema,
	getPromptOptimizeInstruction,
	OPTIMIZE_OUTPUT_SCHEMA_NAME,
	OPTIMIZE_SUMMARY_FIELD,
	type PromptOptimizeStyle,
	readOptimizeResult,
} from "./prompt-optimize";
import { normalizeOptimizedPrompt } from "./prompt-optimize-output";

export interface PromptOptimizeRunInput {
	text: string;
	style: PromptOptimizeStyle;
	locale: Locale;
	/** Recent conversation, already formatted and bounded by the caller. Empty = none. */
	contextText?: string;
	/** Null for a draft prompt that has no session yet; only used for attribution. */
	narratorId?: string | null;
	/** Initiating user, for request accounting. */
	userId?: string | null;
	/** Cancels the model call when the client goes away. */
	signal: AbortSignal;
}

export interface PromptOptimizeRunResult {
	text: string;
	model: string;
	reasoningSummary?: string;
}

export async function runPromptOptimize(
	input: PromptOptimizeRunInput,
): Promise<PromptOptimizeRunResult> {
	const { text, style, locale, contextText = "", narratorId, userId, signal } = input;

	const systemInstruction = buildSystemInstruction(style, locale, text);

	// Tag the user's text to prevent prompt injection.
	const taggedContent = contextText
		? `${contextText}\n\n---\n\n<prompt>\n${text}\n</prompt>`
		: `<prompt>\n${text}\n</prompt>`;

	// Resolve the model (default follows summaryModel via __summary__)
	const model = resolveEffectiveModel(settings.agent.promptOptimizeModel);

	// Ask for the optimized text as a schema-constrained object when the resolved
	// adapter can express one. `responseFormatDegraded` reports adapters that
	// cannot (they must not silently ignore it), and the text path below is then
	// the only source of truth.
	const responseFormat: ResponseFormat = {
		type: "json_schema",
		name: OPTIMIZE_OUTPUT_SCHEMA_NAME,
		schema: getOptimizeOutputSchema(),
		strict: true,
		// Lets the provider layer lift the rationale without knowing field names.
		summaryField: OPTIMIZE_SUMMARY_FIELD,
	};

	// Follow the configured first-token budget; output clears the timer. Request
	// cancellation remains connected to the provider throughout generation.
	const generated = await generateWithFirstTokenTimeout(
		(options) =>
			summaryGenerate(
				taggedContent,
				systemInstruction,
				{ ...(userId ? { userId } : {}), narratorId: narratorId ?? null, kind: "optimize" },
				options.signal,
				options.onTextDelta,
				model,
				undefined,
				false,
				options.onReasoningDelta,
				undefined,
				undefined,
				{ responseFormat, onGenerationProgress: options.onGenerationProgress },
			),
		settings.agent.firstTokenTimeoutMs,
		signal,
	).catch((err: unknown) => {
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new ValidationError(err.message);
		}
		throw err;
	});

	if (generated.responseFormatDegraded) {
		// Log loss of native schema enforcement; validated fields remain usable.
		logger.warn("Prompt optimize fell back to text parsing", {
			narratorId: narratorId ?? null,
			model,
			reason: generated.responseFormatDegraded,
		});
	}

	const structured = readOptimizeResult(generated.structured);
	// Failed or incomplete schema output is not prompt text. Keep the draft rather
	// than leaking the raw JSON envelope (or a partial rewrite) into the caller.
	if (generated.outputTruncated || (generated.structured !== undefined && !structured)) {
		return { text, model };
	}
	// The validated field is already the payload; only plaintext fallback needs
	// wrapper removal. Its examples, headings and literal thinking tags are content.
	const result = structured?.optimizedPrompt ?? normalizeOptimizedPrompt(generated.text, text);
	if (!structured && result.startsWith("{")) return { text, model };
	const reasoningSummary = structured?.reasoningSummary ?? generated.reasoningSummary;

	return { text: result, model, ...(reasoningSummary ? { reasoningSummary } : {}) };
}

/** Style instruction, plus the marker rules a multi-segment draft requires. */
function buildSystemInstruction(style: PromptOptimizeStyle, locale: Locale, text: string): string {
	let systemInstruction = getPromptOptimizeInstruction(style, locale);
	// Multi-segment drafts wrap each segment in <<<NF_..._n>>> ... <<<NF_..._n_END>>> markers
	// that the client uses to put results back; the model must echo them verbatim.
	if (/<<<NF_[^>\n]+>>>/.test(text)) {
		systemInstruction +=
			"\n\nSEGMENT MARKERS: The draft contains several segments delimited by marker lines like <<<NF_xxx_0>>> and <<<NF_xxx_0_END>>>. Optimize each segment's content separately, and output every marker line EXACTLY as given, in the original order, each on its own line, with each segment's result between its start and end markers. Never merge, drop, reorder or alter markers, and add nothing outside them. This overrides the instruction to output only the prompt text.";
	}
	return systemInstruction;
}
