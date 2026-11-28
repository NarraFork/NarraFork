/**
 * vlist-live-patch.ts — Pure, in-place patches of the LOADED exact-document
 * message list for live tool / reflection / subagent lifecycle events.
 *
 * Why this exists
 * ---------------
 * The exact vlist treats its document as an immutable snapshot that is only
 * replaced when the STRUCTURE changes (a message is added / edited / deleted).
 * But a tool call's status and a reflection gate's state evolve *inside* an
 * already-loaded message, and the server never re-broadcasts the owning message
 * for those transitions — it emits `tool_completed` / `*_reflection_resolved`
 * and (for tools only) bumps `messageVersion`. With no subscription and no
 * message re-broadcast, a finished tool kept rendering as "running" and a
 * resolved reflection kept rendering as "reflecting" forever.
 *
 * This module supplies the missing update channel: given the loaded message
 * list, return a NEW list with the affected fields merged. The coordinator then
 * commits an anchor-preserving rebuild, so only the touched card re-measures and
 * the viewport does not move (see PretextLayoutCoordinator.applyLivePatch).
 *
 * Two invariants this module exists to uphold
 * -------------------------------------------
 * 1. BOTH SIDES MUST BE WRITTEN. A tool's facts live twice: on the
 *    `toolCalls[]` row AND on the enriched `tool_use` element of the message body
 *    (the backend's `enrichToolUseBlocks` copies the row onto the block). The
 *    layout adapter reads the BLOCK FIRST (`segment-adapter.mergeSource`), so
 *    patching only the row leaves the adapter seeing the stale status and the
 *    fix silently does nothing. The shared row helpers reused below already
 *    write both (`syncToolElementFields`), which is precisely why they are
 *    reused rather than reimplemented.
 * 2. NO-OP MUST BE REFERENTIALLY DETECTABLE. When nothing matched we return the
 *    original array reference and `changed: false`, so the caller can skip the
 *    rebuild entirely (a narrator with no loaded occurrence of the toolUseId
 *    must not pay for a layout pass on every event).
 *
 * Reuse note: the row walkers come from `../message-tree-utils`, the same pure
 * (DOM-free, React-free) helpers the chunked path uses. Sharing them is
 * deliberate — a second implementation would be free to drift from the chunked
 * path's semantics, which is the class of bug this whole module is fixing. The
 * vlist isolation guard only forbids the reverse direction (outside → vlist).
 *
 * Zero DOM, zero React: data in, data out.
 */

import type {
	SubagentActivitySummary,
	SubagentToolCallHeader,
	TreeMessage,
} from "@frontend/lib/api";
import {
	isCommunicationTool,
	knownSendDeliveryTargets,
	mergeSendDeliveryTargetCount,
	mergeSendDeliveryTargets,
	type SendDeliveryReceipt,
	type SendDeliveryTarget,
} from "@shared/communication-tool";
import type { SubagentModelInheritance } from "@shared/model-inheritance";
import { mapRowElements, messageBlocks, messageBody } from "@shared/narrator-blocks/message-blocks";
import {
	ACTIVE_REFLECTION_STATUSES,
	getPermissionReflectionSuggestion,
} from "@shared/pretext-layout/reflection";
import type { SubagentNestedSummary } from "@shared/subagent-nested";
import { normalizeSubagentToolInputSummary } from "@shared/subagent-tool-summary";
import {
	activityForSubagent,
	getNewestReflectionToolOccurrence,
	mergeFieldsIntoNewestToolOccurrence,
	mergeToolCallFieldsInRows,
	replaceSubagentActivitySnapshot,
	subagentToolCallOrder,
	updateSubagentActivityInMessages,
	upsertSubagentToolCallHeader,
} from "../message/message-tree-utils";
import { isLiveToolStatusRegression } from "./streaming-tool-chunks";

/** Result of one patch attempt over the loaded document. */
export interface LivePatchResult {
	/**
	 * The patched list. READONLY: when `changed` is false this is the coordinator's
	 * own input array, so a caller that mutated it would be writing straight into
	 * the loaded document behind the coordinator's back (the whole channel is
	 * built on immutable rebuilds).
	 */
	messages: readonly TreeMessage[];
	/** False ⇒ `messages` is the ORIGINAL reference; the caller must skip the rebuild. */
	changed: boolean;
}

/** A patch is a pure function over the loaded list (what the coordinator accepts). */
export type LivePatch = (messages: readonly TreeMessage[]) => LivePatchResult;

function unchanged(messages: readonly TreeMessage[]): LivePatchResult {
	return { messages, changed: false };
}

/**
 * Terminal tool statuses. Same set as `message-tree-utils`'s private
 * `isTerminalToolStatus` (the helper behind `upsertSubagentToolCallHeader`'s
 * `preventTerminalRegression`), duplicated here only because that one is not
 * exported.
 */
const TERMINAL_TOOL_STATUSES = new Set([
	"success",
	"completed",
	"denied",
	"error",
	"fail",
	"failed",
	"cancelled",
	"canceled",
	"aborted",
	"timeout",
]);

export function isTerminalToolStatus(status: unknown): boolean {
	return typeof status === "string" && TERMINAL_TOOL_STATUSES.has(status.toLowerCase());
}

/**
 * Current status of the NEWEST loaded occurrence of `toolUseId`, read from the
 * enriched `tool_use` block first (the side the layout adapter reads) and falling
 * back to the `toolCalls[]` row.
 */
function newestToolStatus(messages: readonly TreeMessage[], toolUseId: string): unknown {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;
		const blocks = messageBody(msg);
		for (let b = blocks.length - 1; b >= 0; b--) {
			const block = blocks[b];
			if (block?.type === "tool_use" && block.id === toolUseId) {
				return (block as { status?: unknown }).status;
			}
		}
		const rows = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
		for (let r = rows.length - 1; r >= 0; r--) {
			const row = rows[r];
			if (row?.toolUseId === toolUseId) return row.status;
		}
	}
	return undefined;
}

/**
 * Strip a status REGRESSION out of a field set: a card that already reached a
 * terminal status must not be pushed back to `running` / `pending`.
 *
 * Why this channel needs the guard: WS delivery order is only guaranteed while
 * the socket stays up. On a reconnect the catch-up replay can hand us a
 * `permission_resolved` (or a `tool_started`) AFTER the `tool_completed` that
 * superseded it, and both write their status unconditionally. The card then flips
 * from `success` back to `running` with a fresh `startedAt` and spins forever,
 * because nothing will ever complete it a second time.
 *
 * `startedAt` goes with the status: it is only written to start the header's live
 * timer, so keeping it while dropping the status would restart a finished card's
 * elapsed counter.
 *
 * ACTIVE `permissionSuggestions` go with it too, and for the same reason: a
 * reflection notice carries its OWN lifecycle position in `suggestion.status`, so
 * letting a `running` / `awaiting_user` entry through would mount a "still
 * deliberating" notice on a card that already finished — the exact regression the
 * status guard exists to prevent, just expressed in a different field. A suggestion
 * array whose reflection entry is already resolved is kept: that is the late
 * decision arriving, which is legitimate history for a finished card.
 *
 * The rest of the fields are kept. A late permission decision still records its
 * reason/deny message on the finished card; only the lifecycle position is pinned.
 *
 * Divergence from the chunked path (deliberate): `useNarratorChunksWS` has the
 * same unguarded writes and can regress a card the same way. That is a separate
 * bug in a separate channel — this one is new code, so it starts out correct
 * rather than bug-compatible. The precedent for the guard already exists in the
 * shared row helpers: `upsertSubagentToolCallHeader`'s `preventTerminalRegression`
 * protects the activity header's status this same way, just not the main one.
 */
function withoutTerminalRegression(
	messages: readonly TreeMessage[],
	toolUseId: string,
	fields: Record<string, unknown>,
): Record<string, unknown> {
	if (!("status" in fields) || isTerminalToolStatus(fields.status)) return fields;
	const newest = newestToolStatus(messages, toolUseId);
	// A NON-terminal regression, e.g. `running` → `initializing`. The server yields
	// `tool_call` after starting eager execution (loop.ts:3514-3538), so for most tools
	// `tool_executing` lands FIRST and the later `tool_started` would otherwise demote a
	// card that is demonstrably executing back to the pre-permission phase. Only the
	// lifecycle position is dropped; the frame's input / timestamps still merge, because
	// `tool_started` is the sole carrier of the resolved input.
	if (!isTerminalToolStatus(newest) && isLiveToolStatusRegression(newest, fields.status)) {
		const { status: _demoted, ...keptFields } = fields;
		return keptFields;
	}
	if (!isTerminalToolStatus(newest)) return fields;
	const { status: _status, startedAt: _startedAt, ...rest } = fields;
	if (hasActiveReflectionSuggestion(rest.permissionSuggestions)) {
		const { permissionSuggestions: _suggestions, ...withoutSuggestions } = rest;
		return withoutSuggestions;
	}
	return rest;
}

/**
 * Whether a `permissionSuggestions` value carries a reflection entry that is still
 * in flight. Reuses the shared parser so "active" means exactly what the notice
 * renderer and `measure-cache`'s `reflectionRevision` mean by it.
 */
function hasActiveReflectionSuggestion(suggestions: unknown): boolean {
	if (!Array.isArray(suggestions)) return false;
	return ACTIVE_REFLECTION_STATUSES.has(
		// getPermissionReflectionSuggestion normalizes unknown statuses to "running",
		// so an unparseable entry fails closed (treated as active) rather than slipping
		// a phantom notice onto a finished card.
		(getPermissionReflectionSuggestion({ permissionSuggestions: suggestions })?.status ??
			"confirmed") as never,
	);
}

/**
 * Merge `fields` into EVERY loaded occurrence of `toolUseId` (row + enriched
 * block). Used for the plain tool lifecycle (`tool_started` / `tool_completed` /
 * permission decisions / background-task terminals).
 *
 * A duplicate provider toolUseId collapses to one `tool-<id>` vlist row anyway,
 * so writing every occurrence cannot make two rows disagree.
 */
/** Navigation seeds only the newest attempt; consumed receipts may enrich an exact finished attempt. */
export function patchSendDeliveryTargets(
	messages: readonly TreeMessage[],
	toolUseId: string,
	targets: SendDeliveryReceipt[],
	toolCallBinding?: { toolCallId: string; attempt: number },
	targetCount?: number,
): LivePatchResult {
	if (!toolUseId || !Array.isArray(targets)) return unchanged(messages);
	const incoming = targets.filter(
		(target) => typeof target?.deliveryMessageId === "string" && !!target.deliveryMessageId.trim(),
	);
	const unboundConsumption =
		!toolCallBinding && incoming.some((target) => target.injectionConsumedAt !== undefined);
	let sawNewest = false;
	function patch(rows: readonly TreeMessage[]): LivePatchResult {
		for (let i = rows.length - 1; i >= 0; i--) {
			const row = rows[i];
			const block = [...messageBody(row)]
				.reverse()
				.find((value) => value.type === "tool_use" && value.id === toolUseId);
			const tc = [...(row.toolCalls ?? [])]
				.reverse()
				.find((value) => value.toolUseId === toolUseId);
			if (!block && !tc) continue;
			const isNewest = !sawNewest;
			sawNewest = true;
			const current = { ...tc, ...block } as Record<string, unknown>;
			if (
				!isCommunicationTool({
					toolName: String(current.name ?? current.toolName ?? ""),
					inputJson: current.inputJson ?? current.input,
				})
			)
				continue;
			const knownId = block?.tcId ?? tc?.id;
			const knownAttempt = current.executionAttempt;
			const matchesBinding =
				!!toolCallBinding &&
				knownId === toolCallBinding.toolCallId &&
				knownAttempt === toolCallBinding.attempt;
			if (
				toolCallBinding &&
				((knownId != null && knownId !== toolCallBinding.toolCallId) ||
					(typeof knownAttempt === "number" && knownAttempt !== toolCallBinding.attempt))
			)
				continue;
			const terminal = isTerminalToolStatus(current.status) || current.outputJson != null;
			// Never seed old rows or infer finished-attempt identity from a reused toolUseId.
			if ((!isNewest && !terminal) || (terminal && !matchesBinding)) continue;
			const prior = knownSendDeliveryTargets({
				_metadata: current._metadata,
				outputJson: current.outputJson,
				_sendDeliveryTargets: mergeSendDeliveryTargets(
					tc?._sendDeliveryTargets ?? [],
					Array.isArray(current._sendDeliveryTargets)
						? (current._sendDeliveryTargets as SendDeliveryTarget[])
						: [],
				),
			});
			const matchingReceiptsOnly = terminal || unboundConsumption;
			if (
				matchingReceiptsOnly &&
				!incoming.some((target) =>
					prior.some(
						(value) =>
							value.id === target.id && value.deliveryMessageId === target.deliveryMessageId,
					),
				)
			)
				continue;
			const next = mergeSendDeliveryTargets(prior, incoming, matchingReceiptsOnly);
			const count = mergeSendDeliveryTargetCount(
				current._sendDeliveryTargetCount as number | undefined,
				unboundConsumption ? undefined : targetCount,
			);
			if (
				(!next.length && count === undefined) ||
				(JSON.stringify(next) === JSON.stringify(current._sendDeliveryTargets ?? []) &&
					count === current._sendDeliveryTargetCount)
			)
				return unchanged(rows);
			const fields = {
				_sendDeliveryTargets: next,
				...(count !== undefined ? { _sendDeliveryTargetCount: count } : {}),
				...(toolCallBinding
					? { tcId: toolCallBinding.toolCallId, executionAttempt: toolCallBinding.attempt }
					: {}),
			};
			// Scope the shared row/block writer to this exact message.
			const result = mergeFieldsIntoNewestToolOccurrence([row], toolUseId, fields);
			const updated = [...rows];
			updated[i] = result.messages[0];
			return { messages: updated, changed: true };
		}
		return unchanged(rows);
	}
	return patch(messages);
}

export function patchToolCallFields(
	messages: readonly TreeMessage[],
	toolUseId: string,
	fields: Record<string, unknown>,
	/**
	 * The tool block the event is about (block-keyed protocol): the patch then writes only
	 * the row holding that block. Without it, or when no loaded row holds it, every
	 * occurrence of `toolUseId` is written as before.
	 */
	blockId?: string | null,
): LivePatchResult {
	if (!toolUseId || !Array.isArray(messages) || messages.length === 0) return unchanged(messages);
	if (Object.keys(fields).length === 0) return unchanged(messages);
	const safeFields = withoutTerminalRegression(messages, toolUseId, fields);
	if (Object.keys(safeFields).length === 0) return unchanged(messages);
	if (blockId) {
		const exact = patchRowHoldingBlock(messages, blockId, (row) =>
			mergeToolCallFieldsInRows([row], toolUseId, safeFields),
		);
		if (exact) return exact.changed ? exact : unchanged(messages);
	}
	const result = mergeToolCallFieldsInRows(messages as TreeMessage[], toolUseId, safeFields);
	return result.changed ? result : unchanged(messages);
}

/**
 * Live stdout / determinate progress of a tool that is STILL EXECUTING on an
 * already-persisted card.
 *
 * The assistant message carrying a `tool_use` is persisted just before the tool
 * starts executing, which retires the synthetic streaming card; from then on the
 * committed card is the only place this tool is drawn. These are the same fields
 * the streaming tail writes (`_streamingOutput` / `_structuredProgress`, lifted
 * into the classifier's metadata by the adapter), so the committed card measures
 * and paints them through the identical path, and the detail body's text
 * signature already re-keys the cache (CONTRACT.md §4.5 约束 3).
 *
 * Refused once the newest occurrence is terminal (or absent): a frame that lands
 * after `tool_completed` must not paint a stale live body over the final output.
 * Callers coalesce; this is a pure merge.
 */
export function patchToolLiveOutput(
	messages: readonly TreeMessage[],
	toolUseId: string,
	live: { output?: string; progress?: unknown },
): LivePatchResult {
	if (!toolUseId || !Array.isArray(messages) || messages.length === 0) return unchanged(messages);
	const status = newestToolStatus(messages, toolUseId);
	if (status === undefined || isTerminalToolStatus(status)) return unchanged(messages);
	const fields: Record<string, unknown> = {
		...(live.output !== undefined ? { _streamingOutput: live.output } : {}),
		...(live.progress !== undefined ? { _structuredProgress: live.progress } : {}),
	};
	if (Object.keys(fields).length === 0) return unchanged(messages);
	const result = mergeToolCallFieldsInRows(messages as TreeMessage[], toolUseId, fields);
	return result.changed ? result : unchanged(messages);
}

/**
 * Apply `patch` to the one loaded row whose blocks include `blockId`. Undefined when no
 * loaded row holds the block.
 */
function patchRowHoldingBlock(
	rows: readonly TreeMessage[],
	blockId: string,
	patch: (row: TreeMessage) => { messages: TreeMessage[]; changed: boolean },
): LivePatchResult | undefined {
	for (let i = rows.length - 1; i >= 0; i--) {
		const row = rows[i];
		if (messageBlocks(row).some((block) => block.named && block.id === blockId)) {
			const result = patch(row);
			if (!result.changed) return { messages: rows as TreeMessage[], changed: false };
			const updated = [...rows];
			updated[i] = result.messages[0];
			return { messages: updated, changed: true };
		}
	}
	return undefined;
}

/**
 * Reflection-gate patch with request-id phase gating — a 1:1 mirror of the
 * chunked path's `applyChunkReflection` (useNarratorChunksWS.ts:161).
 *
 * The gating is what keeps two overlapping gates from overwriting each other:
 * - `started`  accepts when the newest occurrence carries NO request id yet, or
 *   already carries this one (a duplicate/late start is then idempotent).
 * - `terminal` accepts ONLY the request id that is currently on the card, so a
 *   late `resolved` for a superseded gate cannot clobber the live one.
 *
 * Unlike {@link patchToolCallFields} this writes only the NEWEST occurrence:
 * reflection identity is per-occurrence, and an older reused toolUseId must not
 * inherit a newer gate's state.
 */
export function patchReflection(
	messages: readonly TreeMessage[],
	toolUseId: string,
	requestId: string,
	reflectionType: string,
	phase: "started" | "terminal",
	fields: Record<string, unknown>,
): LivePatchResult {
	if (!toolUseId || !Array.isArray(messages) || messages.length === 0) return unchanged(messages);
	const occurrence = getNewestReflectionToolOccurrence(
		messages as TreeMessage[],
		toolUseId,
		reflectionType,
	);
	if (!occurrence.found) return unchanged(messages);
	const accepts =
		phase === "started"
			? occurrence.requestId == null || occurrence.requestId === requestId
			: occurrence.requestId === requestId;
	if (!accepts) return unchanged(messages);
	// Same terminal guard as the plain path: a replayed gate event must not push a
	// finished tool back to `pending` / `running`. The request-id gating above makes
	// this rare, not impossible (a reconnect can replay the gate that is still the
	// newest one on a card the completion already finished).
	const safeFields = withoutTerminalRegression(messages, toolUseId, fields);
	if (Object.keys(safeFields).length === 0) return unchanged(messages);
	const result = mergeFieldsIntoNewestToolOccurrence(
		messages as TreeMessage[],
		toolUseId,
		safeFields,
	);
	return result.changed ? result : unchanged(messages);
}

/** Drop discarded pre-receipt argument rows only for their identified child. */
export function patchDiscardedSubagentTools(
	messages: readonly TreeMessage[],
	parentToolUseId: string,
	toolUseIds: readonly string[],
	subagentNarratorId: string | undefined,
): LivePatchResult {
	if (!subagentNarratorId || toolUseIds.length === 0) return unchanged(messages);
	return updateSubagentActivityInMessages(
		messages as TreeMessage[],
		parentToolUseId,
		(activity) => {
			if (activity?.subagentNarratorId !== subagentNarratorId) return activity;
			const latestToolCalls = activity.latestToolCalls.filter(
				(header) =>
					header.status !== "streaming" ||
					header.toolCallId != null ||
					header.executionAttempt != null ||
					!toolUseIds.includes(header.toolUseId),
			);
			return latestToolCalls.length === activity.latestToolCalls.length
				? activity
				: { ...activity, latestToolCalls };
		},
	);
}

export interface SubagentActivityUpdate {
	parentToolUseId: string;
	header: SubagentToolCallHeader;
	meta?: {
		subagentNarratorId?: string | null;
		model?: string | null;
		reasoningEffort?: string | null;
	};
}

const PENDING_SUBAGENT_CALL_LIMIT = 128;
const PENDING_SUBAGENT_CHAR_LIMIT = 512_000;
const SUBAGENT_HEADER_TIMING_KEYS = [
	"startedAt",
	"streamStartedAt",
	"streamCompletedAt",
	"permissionStartedAt",
	"executionStartedAt",
	"completedAt",
	"durationMs",
] as const;

function samePendingSubagentCall(a: SubagentToolCallHeader, b: SubagentToolCallHeader): boolean {
	return (
		a.toolUseId === b.toolUseId && (!a.toolCallId || !b.toolCallId || a.toolCallId === b.toolCallId)
	);
}

/** Own only projected fields, never a raw WS object, input, output or closure. */
function projectPendingSubagentUpdate(
	update: SubagentActivityUpdate,
): SubagentActivityUpdate | null {
	const { header, meta } = update;
	if (
		typeof update.parentToolUseId !== "string" ||
		!update.parentToolUseId ||
		typeof header.toolUseId !== "string" ||
		!header.toolUseId
	)
		return null;
	const timing: NonNullable<SubagentToolCallHeader["timing"]> = {};
	for (const key of SUBAGENT_HEADER_TIMING_KEYS) {
		const value = header.timing?.[key];
		if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))
			Object.assign(timing, { [key]: value });
	}
	return {
		parentToolUseId: update.parentToolUseId,
		header: {
			toolCallId: typeof header.toolCallId === "string" ? header.toolCallId : null,
			...(Number.isSafeInteger(header.executionAttempt) && (header.executionAttempt ?? -1) >= 0
				? { executionAttempt: header.executionAttempt }
				: {}),
			toolUseId: header.toolUseId,
			toolName: typeof header.toolName === "string" ? header.toolName : "Tool",
			status: typeof header.status === "string" ? header.status : "initializing",
			createdAt:
				typeof header.createdAt === "string" ||
				(typeof header.createdAt === "number" && Number.isFinite(header.createdAt))
					? header.createdAt
					: null,
			timing: Object.keys(timing).length ? timing : null,
			...(header.inputSummary !== undefined
				? { inputSummary: normalizeSubagentToolInputSummary(header.inputSummary) }
				: {}),
		},
		meta: {
			subagentNarratorId:
				typeof meta?.subagentNarratorId === "string" ? meta.subagentNarratorId : null,
			model: normalizeModel(meta?.model),
			reasoningEffort: normalizeModel(meta?.reasoningEffort),
		},
	};
}

interface PendingSubagentActivityEntry {
	update: SubagentActivityUpdate;
	order: number;
	waiting: boolean;
	chars: number;
}

/** Missing-parent compensation; a loaded duplicate/rejected target is never retained. */
export class SubagentActivityPatchStore {
	private narratorId: string | undefined;
	private entries = new Map<string, PendingSubagentActivityEntry>();
	private retainedChars = 0;
	private nextOrder = 0;

	get size(): number {
		return this.entries.size;
	}

	get chars(): number {
		return this.retainedChars;
	}

	clear(): void {
		this.entries.clear();
		this.retainedChars = 0;
		this.nextOrder = 0;
		this.narratorId = undefined;
	}

	private forget(key: string, expected?: PendingSubagentActivityEntry): void {
		const entry = this.entries.get(key);
		if (!entry || (expected && expected !== entry)) return;
		this.retainedChars -= entry.chars;
		this.entries.delete(key);
	}

	/** False requests one coalesced authoritative reload instead of retaining an overflow. */
	remember(narratorId: string | undefined, raw: SubagentActivityUpdate): boolean {
		if (this.narratorId !== narratorId) {
			this.clear();
			this.narratorId = narratorId;
		}
		const update = projectPendingSubagentUpdate(raw);
		if (!update) return true;
		const group = [...this.entries]
			.filter(
				([, entry]) =>
					entry.update.parentToolUseId === update.parentToolUseId &&
					entry.update.meta?.subagentNarratorId === update.meta?.subagentNarratorId,
			)
			.sort(([, a], [, b]) => a.order - b.order);
		const previous = group.find(([, entry]) =>
			samePendingSubagentCall(entry.update.header, update.header),
		);
		if (previous) {
			const old = previous[1].update;
			if (
				old.header.executionAttempt != null &&
				(update.header.executionAttempt == null ||
					update.header.executionAttempt < old.header.executionAttempt)
			)
				return true;
			update.header = upsertSubagentToolCallHeader(
				{ subagentNarratorId: null, model: null, latestToolCalls: [old.header] },
				update.header,
			).latestToolCalls[0];
			update.meta = {
				...update.meta,
				model: update.meta?.model ?? old.meta?.model,
				reasoningEffort: update.meta?.reasoningEffort ?? old.meta?.reasoningEffort,
			};
		}
		// Check actual retained strings before JSON encoding; no raw input/output is visited.
		const strings = [
			narratorId,
			update.parentToolUseId,
			update.header.toolUseId,
			update.header.toolCallId,
			update.header.toolName,
			update.header.status,
			update.header.createdAt,
			...Object.values(update.header.timing ?? {}),
			...Object.values(update.header.inputSummary ?? {}),
			...Object.values(update.meta ?? {}),
		];
		if (
			strings.reduce<number>(
				(sum, value) => sum + (typeof value === "string" ? value.length : 0),
				0,
			) > PENDING_SUBAGENT_CHAR_LIMIT
		)
			return false;
		const key = JSON.stringify([
			narratorId,
			update.parentToolUseId,
			update.meta?.subagentNarratorId,
			update.header.toolUseId,
			update.header.toolCallId,
			update.header.executionAttempt,
		]);
		const order = previous?.[1].order ?? ++this.nextOrder;
		// Reserve the maximum counter width too, so bookkeeping is inside the cap.
		const entry = {
			update,
			order,
			waiting: previous?.[1].waiting ?? false,
			chars:
				key.length +
				JSON.stringify({ update, order, waiting: false, chars: PENDING_SUBAGENT_CHAR_LIMIT })
					.length,
		};
		let recent: SubagentActivitySummary | undefined;
		for (const [, item] of group) recent = upsertSubagentToolCallHeader(recent, item.update.header);
		recent = upsertSubagentToolCallHeader(recent, update.header);
		const removed = group.filter(
			([oldKey, item]) =>
				oldKey === previous?.[0] ||
				!recent.latestToolCalls.some((header) =>
					samePendingSubagentCall(header, item.update.header),
				),
		);
		if (!recent.latestToolCalls.some((header) => samePendingSubagentCall(header, update.header)))
			return true;
		const nextCount = this.entries.size - removed.length + 1;
		const nextChars =
			this.retainedChars - removed.reduce((sum, [, item]) => sum + item.chars, 0) + entry.chars;
		if (nextCount > PENDING_SUBAGENT_CALL_LIMIT || nextChars > PENDING_SUBAGENT_CHAR_LIMIT)
			return false;
		for (const [oldKey] of removed) this.forget(oldKey);
		this.entries.set(key, entry);
		this.retainedChars = nextChars;
		return true;
	}

	/** Identity channels supersede child headers, even before the parent card is loaded. */
	identify(parentToolUseId: string, subagentNarratorId: string): void {
		for (const [key, entry] of this.entries) {
			if (
				entry.update.parentToolUseId === parentToolUseId &&
				entry.update.meta?.subagentNarratorId !== subagentNarratorId
			)
				this.forget(key, entry);
		}
	}

	discard(parentToolUseId: string, toolUseIds: readonly string[], child: string | undefined): void {
		if (!child) return;
		for (const [key, entry] of this.entries) {
			const { header, meta } = entry.update;
			if (
				entry.update.parentToolUseId === parentToolUseId &&
				meta?.subagentNarratorId === child &&
				toolUseIds.includes(header.toolUseId) &&
				header.status === "streaming" &&
				header.toolCallId == null &&
				header.executionAttempt == null
			)
				this.forget(key, entry);
		}
	}

	rememberSnapshot(
		narratorId: string | undefined,
		parentToolUseId: string,
		activity: SubagentActivitySummary,
	): boolean {
		if (this.narratorId !== narratorId) {
			this.clear();
			this.narratorId = narratorId;
		}
		if (activity.subagentNarratorId) this.identify(parentToolUseId, activity.subagentNarratorId);
		const previousHeaders = [...this.entries.values()]
			.filter(
				(entry) =>
					entry.update.parentToolUseId === parentToolUseId &&
					entry.update.meta?.subagentNarratorId === activity.subagentNarratorId,
			)
			.sort((a, b) => a.order - b.order)
			.map((entry) => entry.update.header);
		activity = replaceSubagentActivitySnapshot(activity, {
			subagentNarratorId: activity.subagentNarratorId,
			model: null,
			latestToolCalls: previousHeaders,
		});
		for (const [key, entry] of this.entries) {
			if (
				entry.update.parentToolUseId === parentToolUseId &&
				entry.update.meta?.subagentNarratorId === activity.subagentNarratorId &&
				!activity.latestToolCalls.some((header) =>
					samePendingSubagentCall(header, entry.update.header),
				)
			)
				this.forget(key, entry);
		}
		let retained = true;
		for (const header of activity.latestToolCalls) {
			if (!this.remember(narratorId, { parentToolUseId, header, meta: activity })) retained = false;
		}
		return retained;
	}

	apply(messages: readonly TreeMessage[], narratorId: string | undefined): LivePatchResult {
		if (narratorId !== this.narratorId) return unchanged(messages);
		let current = messages;
		let changed = false;
		for (const [key, entry] of [...this.entries].sort(([, a], [, b]) => a.order - b.order)) {
			const { parentToolUseId, header, meta } = entry.update;
			const targetExists = current.some(
				(message) =>
					messageBody(message).some(
						(block) => block.type === "tool_use" && block.id === parentToolUseId,
					) || message.toolCalls?.some((call) => call.toolUseId === parentToolUseId),
			);
			if (!targetExists) {
				entry.waiting = true;
				continue;
			}
			// An old replay without comparable timestamps cannot evict a full,
			// newer authoritative window. Fresh live calls still append normally.
			const authoritative = entry.waiting
				? current.flatMap((message) => {
						const block = messageBody(message).find(
							(item) => item.type === "tool_use" && item.id === parentToolUseId,
						);
						const call = message.toolCalls?.find((item) => item.toolUseId === parentToolUseId);
						return (block?._subagentActivity ?? call?._subagentActivity)?.latestToolCalls ?? [];
					})
				: [];
			if (
				authoritative.length >= 3 &&
				!authoritative.some((call) => samePendingSubagentCall(call, header)) &&
				(subagentToolCallOrder(header) == null ||
					authoritative.some((call) => subagentToolCallOrder(call) == null))
			) {
				this.forget(key, entry);
				continue;
			}
			const result = patchSubagentActivity(current, parentToolUseId, header, meta);
			// A duplicate, stale attempt, or replaced child is a consumed event, not a miss.
			this.forget(key, entry);
			if (!result.changed) continue;
			current = result.messages;
			changed = true;
		}
		return changed ? { messages: current, changed } : unchanged(messages);
	}
}

/** Upsert one bounded child header into the parent card's recent activity. */
export function patchSubagentActivity(
	messages: readonly TreeMessage[],
	parentToolUseId: string,
	header: SubagentToolCallHeader,
	meta?: {
		subagentNarratorId?: string | null;
		model?: string | null;
		reasoningEffort?: string | null;
	},
): LivePatchResult {
	if (!parentToolUseId || !Array.isArray(messages) || messages.length === 0)
		return unchanged(messages);
	const result = updateSubagentActivityInMessages(
		messages as TreeMessage[],
		parentToolUseId,
		(existing) => {
			// Ownership comes from the persisted/identity channel. A late child tool
			// frame may enrich an unassigned card, never switch an assigned child.
			if (
				existing?.subagentNarratorId &&
				meta?.subagentNarratorId &&
				existing.subagentNarratorId !== meta.subagentNarratorId
			)
				return existing;
			const current = activityForSubagent(existing, meta?.subagentNarratorId);
			const next = upsertSubagentToolCallHeader(current, header);
			// Same "never erase a known value" rule as the model: a tool event that
			// omits the tier must keep the one the card already shows.
			const reasoningEffort =
				normalizeModel(meta?.reasoningEffort) ??
				normalizeModel(current?.reasoningEffort) ??
				normalizeModel(next.reasoningEffort);
			if (
				next === existing &&
				(meta?.subagentNarratorId ?? next.subagentNarratorId) === next.subagentNarratorId &&
				(normalizeModel(meta?.model) ?? next.model) === next.model &&
				reasoningEffort === normalizeModel(next.reasoningEffort)
			)
				return existing;
			return {
				...next,
				subagentNarratorId:
					meta?.subagentNarratorId ?? current?.subagentNarratorId ?? next.subagentNarratorId,
				// An absent/blank incoming model must never erase a known one.
				model: normalizeModel(meta?.model) ?? normalizeModel(current?.model) ?? next.model,
				...(reasoningEffort ? { reasoningEffort } : {}),
			};
		},
	);
	return result.changed ? result : unchanged(messages);
}

function sameModelInheritance(
	a: SubagentModelInheritance | undefined,
	b: SubagentModelInheritance,
): boolean {
	return (
		!!a &&
		a.source === b.source &&
		a.model === b.model &&
		a.parentModel === b.parentModel &&
		a.poolKey === b.poolKey
	);
}

/**
 * Attach the child narrator id / model to a parent card WITHOUT recording a tool
 * call. `subagent_started` announces which narrator a card now owns before that
 * child has run anything, so synthesizing a header here would invent a phantom
 * "recent call" row: an identity-only update.
 */
export function patchSubagentIdentity(
	messages: readonly TreeMessage[],
	parentToolUseId: string,
	identity: {
		subagentNarratorId?: string | null;
		model?: string | null;
		reasoningEffort?: string | null;
		modelInheritance?: SubagentModelInheritance;
	},
): LivePatchResult {
	if (!parentToolUseId || !Array.isArray(messages) || messages.length === 0)
		return unchanged(messages);
	const nextNarratorId = identity.subagentNarratorId ?? null;
	const nextModel = normalizeModel(identity.model);
	const nextReasoningEffort = normalizeModel(identity.reasoningEffort);
	const result = updateSubagentActivityInMessages(
		messages as TreeMessage[],
		parentToolUseId,
		(existing) => {
			const current = activityForSubagent(existing, nextNarratorId);
			const resolvedNarratorId = nextNarratorId ?? current?.subagentNarratorId ?? null;
			const resolvedModel = nextModel ?? normalizeModel(current?.model);
			const resolvedReasoningEffort =
				nextReasoningEffort ?? normalizeModel(current?.reasoningEffort);
			// Returning the SAME reference tells the walker nothing changed, which keeps
			// a duplicate event from forcing a pointless rebuild.
			if (
				current &&
				current.subagentNarratorId === resolvedNarratorId &&
				normalizeModel(current.model) === resolvedModel &&
				normalizeModel(current.reasoningEffort) === resolvedReasoningEffort &&
				(!identity.modelInheritance ||
					sameModelInheritance(current.modelInheritance, identity.modelInheritance))
			) {
				return current;
			}
			return {
				...(current ?? { latestToolCalls: [] }),
				subagentNarratorId: resolvedNarratorId,
				model: resolvedModel,
				...(resolvedReasoningEffort ? { reasoningEffort: resolvedReasoningEffort } : {}),
				...((identity.modelInheritance ?? current?.modelInheritance)
					? { modelInheritance: identity.modelInheritance ?? current?.modelInheritance }
					: {}),
				latestToolCalls: current?.latestToolCalls ?? [],
			};
		},
	);
	return result.changed ? result : unchanged(messages);
}

/**
 * Set (or clear) a card's takeover state by the id of the tool call that spawned
 * the child.
 *
 * ⚠️ WRITES BOTH SOURCES, and that is the entire reason this function exists
 * rather than a bare `patchToolCallFields(… { _takenOver })`. The adapter reads
 * the flag as an OR over two channels (`resolveTakenOver` in segment-adapter.ts):
 *
 *   tc._takenOver                  ← message load + this live patch
 *   tc._subagentActivity.takenOver ← message load + the reconnect catch-up snapshot
 *
 * Writing only the first one cannot RELEASE a badge: the server stamps
 * `activity.takenOver` whenever a page is loaded mid-takeover, and
 * `upsertSubagentToolCallHeader` deliberately carries it across every child tool
 * event, so the summary keeps asserting `true` while the block says `false` and
 * the OR keeps the badge lit until an unrelated full reload. That is precisely
 * the "user already stopped the takeover, the card still says taken over" stall,
 * and it is invisible in the release direction only — taking over works fine,
 * which is what makes it easy to miss.
 *
 * The summary is corrected only when it EXISTS: an absent one is not a
 * disagreement, and synthesizing a partial summary here would erase the
 * card's known model / recent calls.
 */
export function patchSubagentTakeover(
	messages: readonly TreeMessage[],
	toolUseId: string,
	takenOver: boolean,
): LivePatchResult {
	if (!toolUseId || !Array.isArray(messages) || messages.length === 0) return unchanged(messages);
	const flagged = patchToolCallFields(messages, toolUseId, { _takenOver: takenOver });
	const synced = syncActivityTakenOver(flagged.messages, toolUseId, takenOver);
	if (!flagged.changed && !synced.changed) return unchanged(messages);
	return { messages: synced.messages, changed: true };
}

/** Bring an existing `_subagentActivity.takenOver` in line with the block flag. */
function syncActivityTakenOver(
	messages: readonly TreeMessage[],
	toolUseId: string,
	takenOver: boolean,
): LivePatchResult {
	const result = updateSubagentActivityInMessages(
		messages as TreeMessage[],
		toolUseId,
		(current) => {
			if (!current) return current;
			if ((current.takenOver === true) === takenOver) return current;
			return withActivityTakenOver(current, takenOver);
		},
	);
	return result.changed ? result : unchanged(messages);
}

/**
 * `takenOver` is OMITTED rather than written as `false` when released, matching
 * how the server builds the snapshot (`...(isTakenOver(id) ? { takenOver: true } : {})`)
 * so both producers yield the same shape and no reader has to treat the two
 * spellings of "not taken over" differently.
 */
function withActivityTakenOver(
	activity: SubagentActivitySummary,
	takenOver: boolean,
): SubagentActivitySummary {
	if (takenOver) return { ...activity, takenOver: true };
	const { takenOver: _released, ...rest } = activity;
	return rest;
}

/**
 * Mark every loaded card that waits on `subagentNarratorId` as taken over (or
 * released), WITHOUT knowing the parent tool use id.
 *
 * The takeover frame's `toolUseId` is best-effort: the spawning `tool_use` is
 * resolved from the child's first user message, which a corrupted or
 * partially-written history can leave unresolvable. Falling back to matching by
 * CHILD NARRATOR id keeps the indicator working there, and both routes exist on
 * a card already:
 *
 *   - Agent/Task/Send → `_subagentActivity.subagentNarratorId`
 *   - running Await    → `_awaitAgentNarratorId` (server-resolved selector)
 *
 * Writes the same TWO fields {@link patchSubagentTakeover} writes (block flag +
 * an existing activity summary), so the two paths cannot disagree about what the
 * card reads — and, more importantly, neither can leave a released card with a
 * summary still asserting `takenOver: true`, which the adapter's OR would keep
 * painting.
 */
export function patchSubagentTakeoverByNarrator(
	messages: readonly TreeMessage[],
	subagentNarratorId: string,
	takenOver: boolean,
): LivePatchResult {
	if (!subagentNarratorId || !Array.isArray(messages) || messages.length === 0)
		return unchanged(messages);
	const result = markTakenOverForNarrator(messages as TreeMessage[], subagentNarratorId, takenOver);
	return result.changed ? result : unchanged(messages);
}

/**
 * Apply the takeover fact to ONE block/row, covering both fields the adapter ORs
 * together. Returns the SAME reference when nothing changed, so the walker's
 * `changed` flag stays exact.
 */
function withTakenOverEntry(
	entry: Record<string, unknown>,
	takenOver: boolean,
): Record<string, unknown> {
	const activity = entry._subagentActivity as SubagentActivitySummary | null | undefined;
	const activityStale = !!activity && (activity.takenOver === true) !== takenOver;
	if (entry._takenOver === takenOver && !activityStale) return entry;
	return {
		...entry,
		_takenOver: takenOver,
		...(activityStale && activity
			? { _subagentActivity: withActivityTakenOver(activity, takenOver) }
			: {}),
	};
}

/** Whether this tool block/row points at `subagentNarratorId`. */
function ownsSubagent(entry: Record<string, unknown>, subagentNarratorId: string): boolean {
	const activity = entry._subagentActivity as { subagentNarratorId?: unknown } | null | undefined;
	if (activity?.subagentNarratorId === subagentNarratorId) return true;
	return entry._awaitAgentNarratorId === subagentNarratorId;
}

function markTakenOverForNarrator(
	messages: TreeMessage[],
	subagentNarratorId: string,
	takenOver: boolean,
): { messages: readonly TreeMessage[]; changed: boolean } {
	let changed = false;
	const updated = messages.map((message) => {
		let next = message;
		const withContent = mapRowElements(message, (block) => {
			if (block.type !== "tool_use") return block;
			const record = block as unknown as Record<string, unknown>;
			if (!ownsSubagent(record, subagentNarratorId)) return block;
			const patched = withTakenOverEntry(record, takenOver);
			if (patched === record) return block;
			return patched as unknown as typeof block;
		});
		let localChanged = withContent !== message;
		const nextCalls = (message.toolCalls ?? []).map((call) => {
			const record = call as unknown as Record<string, unknown>;
			if (!ownsSubagent(record, subagentNarratorId)) return call;
			const patched = withTakenOverEntry(record, takenOver);
			if (patched === record) return call;
			localChanged = true;
			return patched as unknown as typeof call;
		});
		if (localChanged) {
			changed = true;
			next = { ...withContent, toolCalls: nextCalls };
		}
		return next;
	});
	return { messages: changed ? updated : messages, changed };
}

/**
 * `subagent_nested_changed` → replace the card's nested helper rows (the helpers its
 * child launched). HEIGHT-AFFECTING (one row each), keyed in `subagentRevision` through
 * the card's `nestedAgents`. A card without an activity summary yet gets a minimal one
 * naming its child, like the first live activity event would.
 */
export function patchSubagentNested(
	messages: readonly TreeMessage[],
	toolUseId: string,
	subagentNarratorId: string,
	nested: SubagentNestedSummary,
): LivePatchResult {
	if (!toolUseId || !Array.isArray(messages) || messages.length === 0) return unchanged(messages);
	const result = updateSubagentActivityInMessages(
		messages as TreeMessage[],
		toolUseId,
		(current) => {
			const base: SubagentActivitySummary = current ?? {
				subagentNarratorId,
				model: null,
				latestToolCalls: [],
			};
			if (base.subagentNarratorId && base.subagentNarratorId !== subagentNarratorId) return current;
			if (nested.total === 0) {
				if (!base.nested) return current;
				const { nested: _gone, ...rest } = base;
				return rest;
			}
			return { ...base, nested };
		},
	);
	return result.changed ? result : unchanged(messages);
}

/**
 * Replace a parent card's activity summary with the server-authoritative
 * snapshot delivered by reconnect catch-up. Mirrors the chunked path's
 * `applySubagentActivitySnapshots`.
 */
export function patchSubagentActivitySnapshots(
	messages: readonly TreeMessage[],
	snapshots: readonly { parentToolUseId: string; activity: SubagentActivitySummary }[],
): LivePatchResult {
	if (!Array.isArray(messages) || messages.length === 0 || snapshots.length === 0)
		return unchanged(messages);
	let current: readonly TreeMessage[] = messages;
	let changed = false;
	for (const snapshot of snapshots) {
		if (!snapshot?.parentToolUseId || !snapshot.activity) continue;
		const result = updateSubagentActivityInMessages(
			current as TreeMessage[],
			snapshot.parentToolUseId,
			(existing) => replaceSubagentActivitySnapshot(snapshot.activity, existing),
		);
		if (!result.changed) continue;
		current = result.messages;
		changed = true;
	}
	return changed ? { messages: current, changed: true } : unchanged(messages);
}

function normalizeModel(value: unknown): string | null {
	if (typeof value !== "string") return null;
	return value.trim() || null;
}

/**
 * Compose several patches into one, so a batch of events coalesced within a
 * single frame produces exactly ONE document rebuild. Threads the intermediate
 * list through each patch and reports `changed` if any of them applied.
 */
export function composeLivePatches(patches: readonly LivePatch[]): LivePatch {
	return (messages) => {
		let current: readonly TreeMessage[] = messages;
		let changed = false;
		for (const patch of patches) {
			const result = patch(current);
			if (!result.changed) continue;
			current = result.messages;
			changed = true;
		}
		return changed ? { messages: current, changed: true } : unchanged(messages);
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame-coalesced, narrator-scoped patch queue
// ─────────────────────────────────────────────────────────────────────────────

/** Host hooks the queue needs from its React shell (all injectable for tests). */
export interface LivePatchQueueHost {
	/** Narrator the queue currently belongs to; read fresh on enqueue AND on flush. */
	currentNarratorId: () => string | undefined;
	/** Commit one composed patch to the loaded document. */
	apply: (patch: LivePatch) => boolean;
	/** Schedule the drain (raf in the browser, a timer where raf is absent). */
	schedule: (drain: () => void) => number;
	/** Cancel a scheduled drain. */
	cancel: (handle: number) => void;
}

/**
 * Coalescing queue for live patches: many events in one frame, ONE document
 * rebuild. Extracted from the hook so both invariants it carries are testable
 * without React or a WebSocket.
 *
 * 1. COALESCING. A turn finishing several tools at once must not rebuild the
 *    document once per event.
 * 2. NARRATOR SCOPING. Every patch is stamped with the narrator it was queued for
 *    and re-checked at flush time. React runs the new render — which has already
 *    swapped in the new narrator's apply function — BEFORE the previous effect's
 *    cleanup, so a drain firing in that gap would otherwise hand the previous
 *    narrator's patches to the new narrator's document. Usually a no-op (no
 *    matching toolUseId) but a provider toolUseId can legitimately recur across
 *    narrators, which is the same reuse `patchReflection` already guards against.
 */
interface QueuedLivePatch {
	patch: LivePatch;
	onMiss?: () => void;
}

export class LivePatchQueue {
	private queue: QueuedLivePatch[] = [];
	private queuedFor: string | undefined;
	private handle = 0;

	constructor(private host: LivePatchQueueHost) {}

	enqueue(patch: LivePatch | null, onMiss?: () => void): void {
		if (!patch) return;
		const narratorId = this.host.currentNarratorId();
		// A queue stamped for another narrator can only be a leftover from the switch;
		// drop it rather than mixing two documents' patches into one batch.
		if (this.queuedFor !== narratorId) {
			this.queue = [];
			this.queuedFor = narratorId;
		}
		this.queue.push({ patch, onMiss });
		if (this.handle) return;
		this.handle = this.host.schedule(() => this.flush());
	}

	flush(): void {
		this.handle = 0;
		const queued = this.queue;
		const queuedFor = this.queuedFor;
		this.queue = [];
		this.queuedFor = undefined;
		if (queued.length === 0) return;
		if (queuedFor !== this.host.currentNarratorId()) return;
		const missed = new Set<() => void>();
		const applied = this.host.apply(
			composeLivePatches(
				queued.map((entry) => (messages) => {
					const result = entry.patch(messages);
					if (!result.changed && entry.onMiss) missed.add(entry.onMiss);
					return result;
				}),
			),
		);
		// A host can reject the whole commit without evaluating the patches (e.g.
		// before its document loads). Otherwise notify each missed entry even when
		// a sibling patch succeeded. Notifications run after apply, once per callback.
		if (!applied) {
			for (const entry of queued) if (entry.onMiss) missed.add(entry.onMiss);
		}
		if (queuedFor !== this.host.currentNarratorId()) return;
		for (const onMiss of missed) onMiss();
	}

	/** Discard everything pending (unmount / narrator switch). */
	dispose(): void {
		if (this.handle) this.host.cancel(this.handle);
		this.handle = 0;
		this.queue = [];
		this.queuedFor = undefined;
	}
}
