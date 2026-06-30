import type { DbMessage } from "./provider";

/**
 * Build the short path-reference text that replaces a file-based plan body in
 * model history. Kept in English on purpose: this is model-facing text (mirrors
 * the existing tool-result message style) and must not drift with UI locale.
 */
function buildPlanReference(planFile: string): string {
	return (
		`The plan was approved. Its full content is saved in the plan file: ${planFile}. ` +
		"Re-read that file with the Read tool if you need the plan details."
	);
}

/**
 * Replace the (potentially large) plan body of file-based ExitPlanMode tool
 * calls with a short path reference, so the model history does not carry the
 * full plan text on every rebuilt turn.
 *
 * This mutates the in-memory `dbMessages` array in place (same pattern as
 * pruneToolCalls) and is invoked from `buildHistory` right before delegating to
 * the provider adapter. It never writes to the DB — the persisted
 * `narratorToolCalls.inputJson` / contentJson keep the full plan snapshot so the
 * UI can still render it.
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
export function stripPlanBodyForModel(dbMessages: DbMessage[]): void {
	for (const msg of dbMessages) {
		if (!msg.toolCalls?.length) continue;

		// Map toolUseId → reference text for the calls we rewrite, so we can patch
		// the matching contentJson tool_use blocks in the same pass.
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

			const reference = buildPlanReference(planFile);
			tc.inputJson = { plan: reference, _planFile: planFile };
			if (!references) references = new Map();
			references.set(tc.toolUseId, reference);
		}

		if (!references || !Array.isArray(msg.contentJson)) continue;

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
		if (mutated) {
			msg.contentJson = blocks;
		}
	}
}
