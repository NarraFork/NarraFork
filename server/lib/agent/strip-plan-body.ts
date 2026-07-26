import type { DbMessage, DbToolCall } from "./provider";

/**
 * Build the short path-reference text that replaces a file-based plan body in
 * model history. Kept in English on purpose: this is model-facing text (mirrors
 * the existing tool-result message style) and must not drift with UI locale.
 */
function buildPlanReference(planFile: string, status: string): string {
	const prefix = status === "fail" ? "The plan was not approved." : "The plan was approved.";
	return (
		`${prefix} Its full content is saved in the plan file: ${planFile}. ` +
		"Re-read that file with the Read tool if you need the plan details."
	);
}

/**
 * Distinctive fragments of the reference sentence above. Kept adjacent to the
 * builder so the detector below can never drift from what we actually emit.
 */
const PLAN_REFERENCE_MARKERS = [
	"its full content is saved in the plan file",
	"re-read that file with the read tool",
];

/** How much of a candidate string is scanned for the markers (see below). */
const PLAN_REFERENCE_SCAN_CHARS = 400;

/**
 * Is this text OUR model-facing plan reference rather than a real plan body?
 *
 * The reference is model-only by design (the DB keeps the full plan for the UI),
 * but a model can echo the sentence it saw in its own stripped history back as a
 * new ExitPlanMode plan. Left unchecked, that reference gets accepted as a
 * complete inline plan — which both hides the real plan from the user and stops
 * the server from re-reading the plan file.
 *
 * Only a bounded prefix is scanned: the reference is short and always leads the
 * string, so a window both bounds the cost for megabyte-sized plans and avoids
 * flagging a genuine plan that merely quotes the phrase somewhere in its body.
 */
export function isModelPlanReference(text: string): boolean {
	if (!text) return false;
	const window = text.slice(0, PLAN_REFERENCE_SCAN_CHARS).toLowerCase();
	return PLAN_REFERENCE_MARKERS.some((marker) => window.includes(marker));
}

/**
 * Replace the (potentially large) plan body of file-based ExitPlanMode tool
 * calls with a short path reference, so the model history does not carry the
 * full plan text on every rebuilt turn.
 *
 * This returns a structurally copied message list and is invoked from
 * `buildHistory` right before delegating to the provider adapter. It never writes
 * to the DB — the persisted `narratorToolCalls.inputJson` / contentJson keep the
 * full plan snapshot so the UI can still render it.
 *
 * Detection signal: the persisted `_planFile` marker on the tool call's input.
 * It is set only when the plan was resolved from the designated plan file
 * (see resolveExitPlanModeInput). Inline plans (no `_planFile`) and legacy rows
 * are left untouched, because their full content lives nowhere but the history.
 *
 * Both the `narratorToolCalls.inputJson` (read by every provider's buildHistory)
 * and the matching contentJson `tool_use` block input are rewritten: the OpenAI
 * Responses path falls back to `block.input` when `inputJson` is missing, so
 * leaving the block untouched could re-leak the full plan.
 */
export function stripPlanBodyForModel(dbMessages: DbMessage[]): DbMessage[] {
	return dbMessages.map((msg) => {
		if (!msg.toolCalls?.length) return msg;

		// Build a new message instead of mutating the DB-backed objects. The same
		// message objects can still be held by the UI/cache, so mutating inputJson
		// here made a denied plan render the model-only "The plan was approved..."
		// reference in place of the original plan.
		let rewrittenToolCalls: DbToolCall[] | undefined;
		let references: Map<string, string> | undefined;

		for (const tc of msg.toolCalls) {
			if (tc.toolName !== "ExitPlanMode") continue;
			const input = tc.inputJson;
			if (!input || typeof input !== "object" || Array.isArray(input)) continue;
			const record = input as Record<string, unknown>;
			const planFile = record._planFile;
			if (typeof planFile !== "string" || !planFile.trim()) continue;
			const plan = record.plan;
			if (typeof plan !== "string" || !plan.trim()) continue;

			const reference = buildPlanReference(planFile, tc.status);
			if (!rewrittenToolCalls) rewrittenToolCalls = msg.toolCalls.slice();
			const index = msg.toolCalls.indexOf(tc);
			rewrittenToolCalls[index] = { ...tc, inputJson: { plan: reference, _planFile: planFile } };
			if (!references) references = new Map();
			references.set(tc.toolUseId, reference);
		}

		if (!rewrittenToolCalls || !references) return msg;

		let contentJson = msg.contentJson;
		if (Array.isArray(msg.contentJson)) {
			let mutated = false;
			const blocks = (msg.contentJson as Array<Record<string, unknown>>).map((block) => {
				if (!block || block.type !== "tool_use") return block;
				const id = block.id;
				if (typeof id !== "string") return block;
				const reference = references?.get(id);
				if (!reference) return block;
				const existingInput =
					block.input && typeof block.input === "object" && !Array.isArray(block.input)
						? (block.input as Record<string, unknown>)
						: {};
				const planFile = existingInput._planFile;
				mutated = true;
				return {
					...block,
					input: {
						plan: reference,
						...(typeof planFile === "string" ? { _planFile: planFile } : {}),
					},
				};
			});
			if (mutated) contentJson = blocks;
		}

		return { ...msg, toolCalls: rewrittenToolCalls, contentJson };
	});
}
