/**
 * vlist-permission-match.ts — Pure matching helpers for the permission bridge.
 *
 * Kept free of any heavy component imports (ToolCallCard / AskUserQuestionBanner
 * pull in shiki + markdown machinery) so this logic is unit-testable in isolation.
 * vlist-permission-bridge.tsx re-exports these and adds the React node building.
 */

import type { ReflectionSuggestion } from "../narrator-message-helpers";
import type { AsyncQuestionSlot, PendingPermission } from "../narrator-panel-types";
import { resolveRowReflection, type VListReflectionSource } from "./vlist-reflection-index";
import type { VListToolMeta } from "./vlist-tool-meta";

function isNewerQuestionWait(
	candidate: VListToolMeta,
	current: VListToolMeta | undefined,
): boolean {
	if (!current) return true;
	const candidateSeq = candidate.awaitQuestionSeq;
	const currentSeq = current.awaitQuestionSeq;
	if (typeof candidateSeq === "number" && typeof currentSeq === "number") {
		return candidateSeq >= currentSeq;
	}
	if (typeof candidateSeq === "number") return true;
	if (typeof currentSeq === "number") return false;
	return false;
}

/** Move, rather than copy, the live form to the newest still-running Await. */
export function resolveAsyncQuestionHosts(
	questions: ReadonlyMap<string, AsyncQuestionSlot> | undefined,
	tools: ReadonlyMap<string, VListToolMeta> | undefined,
	hostToolIds: ReadonlySet<string>,
): ReadonlyMap<string, AsyncQuestionSlot> | undefined {
	if (!questions?.size || !tools) return questions;
	const result = new Map(questions);
	const byId = new Map([...questions].map(([host, slot]) => [slot.id, { host, slot }]));
	const newestByQuestion = new Map<string, { toolId: string; meta: VListToolMeta }>();
	for (const [toolId, meta] of tools) {
		if (!hostToolIds.has(toolId) || !meta.awaitQuestionId) continue;
		if (!byId.has(meta.awaitQuestionId)) continue;
		const current = newestByQuestion.get(meta.awaitQuestionId);
		if (isNewerQuestionWait(meta, current?.meta)) {
			newestByQuestion.set(meta.awaitQuestionId, { toolId, meta });
		}
	}
	for (const [questionId, { toolId }] of newestByQuestion) {
		const question = byId.get(questionId);
		if (!question) continue;
		if (question.slot.question?.status && question.slot.question.status !== "open") continue;
		result.set(question.host, { ...question.slot, summaryOnly: true });
		result.set(toolId, question.slot);
	}
	return result;
}

/** Kinds whose card can host a pending-permission form. */
export const PERMISSION_HOST_KINDS: ReadonlySet<string> = new Set(["tool-call", "subagent-card"]);

/**
 * Kinds whose card renders a `ReflectionNotice`. Only the tool card does: the chunked
 * SubagentCard renders `InlinePermission` for its own permission and never a
 * reflection notice (SubagentCard.tsx:696), so including it would exceed parity.
 */
export const REFLECTION_HOST_KINDS: ReadonlySet<string> = new Set(["tool-call"]);

/**
 * Extract the tool_use id a `tool-<id>` / `tool-<id>#dupN` spec.key encodes.
 * Returns null for keys that are not tool-item keys.
 */
export function toolUseIdFromSpecKey(specKey: string): string | null {
	if (!specKey.startsWith("tool-")) return null;
	const rest = specKey.slice("tool-".length);
	// Deduped keys carry a `#dupN` suffix (see pretext-layout-manifest); strip it.
	const hashIndex = rest.indexOf("#");
	return (hashIndex >= 0 ? rest.slice(0, hashIndex) : rest) || null;
}

/**
 * Find the pending permission whose toolUseId matches this row's tool use.
 * The WS-sourced list is authoritative (full untruncated inputJson) — it is the
 * only source available while a permission is actually pending (the narrator is
 * "waiting" with a live socket).
 */
export function findPendingForKey(
	specKey: string,
	pendingPermissions: readonly PendingPermission[],
): PendingPermission | null {
	const toolUseId = toolUseIdFromSpecKey(specKey);
	if (!toolUseId) return null;
	for (const perm of pendingPermissions) {
		if (perm.toolUseId === toolUseId) return perm;
	}
	return null;
}

/**
 * May this row kind host an interactive permission / question form at all?
 *
 * The one owner of that rule. `decidePermissionSlot` is not the only caller any more:
 * the bridge also offers the slot to an open ASYNC question when no permission claimed
 * it, and deriving a tool_use id from the key without re-checking the kind would let a
 * non-hosting row mount a form.
 */
export function isPermissionHostRow(specKind: string): boolean {
	return PERMISSION_HOST_KINDS.has(specKind);
}

/** What (if anything) a row's permission area should host. */
export type PermissionSlotKind = "reflection" | "permission" | "none";

export interface PermissionSlotDecision {
	kind: PermissionSlotKind;
	/** Present when kind === "reflection". */
	reflection?: ReflectionSuggestion;
	/**
	 * The live pending permission, when one matches. Set for kind === "permission"
	 * and possibly also for "reflection" (a running gate keeps a pending row, whose
	 * id/input the notice uses).
	 */
	pending?: PendingPermission;
	/** The row's tool use id, when the key encodes one. */
	toolUseId?: string;
}

const NO_SLOT: PermissionSlotDecision = { kind: "none" };

/**
 * Decide a row's permission area, mirroring the chunked precedence exactly
 * (ToolCallCard.tsx:5419):
 *
 *   1. a reflection that is NOT awaiting_user  → the reflection notice
 *   2. otherwise a live pending permission     → the permission form
 *   3. otherwise nothing
 *
 * `awaiting_user` deliberately falls through to the permission form: the gate has
 * handed the decision back to the user, so the approve/deny controls are correct.
 *
 * A resolved reflection needs NO pending permission and NO permission callbacks:
 * the chunked notice takes no permCb props (it calls api.stopXReflection itself and
 * reads PermEnterHintCtx), and is never passed `readOnly`. So historical reflections
 * render in archived / read-only / capability-limited sessions too.
 */
export function decidePermissionSlot(
	specKind: string,
	specKey: string,
	pendingPermissions: readonly PendingPermission[] | undefined,
	reflections: ReadonlyMap<string, VListReflectionSource> | undefined,
): PermissionSlotDecision {
	if (!isPermissionHostRow(specKind)) return NO_SLOT;
	const toolUseId = toolUseIdFromSpecKey(specKey);
	const pending = pendingPermissions ? findPendingForKey(specKey, pendingPermissions) : null;

	if (REFLECTION_HOST_KINDS.has(specKind) && toolUseId) {
		const reflection = resolveRowReflection(reflections?.get(toolUseId), pending);
		if (reflection && reflection.status !== "awaiting_user") {
			return {
				kind: "reflection",
				reflection,
				...(pending ? { pending } : {}),
				toolUseId,
			};
		}
	}

	if (pending) return { kind: "permission", pending, ...(toolUseId ? { toolUseId } : {}) };
	return NO_SLOT;
}
