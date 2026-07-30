import { buildPlanReference, isModelPlanReference } from "@shared/plan-reference";
import type { DbMessage, DbToolCall } from "./provider";

// The reference builder + detector live in `shared/` because the render layers
// need the same detection: a card whose persisted input holds the reference must
// fall back to the authoritative plan body rather than show the sentence as the
// plan. Re-exported here so existing server-side imports keep working.
export { isModelPlanReference };

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
