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
 *    `toolCalls[]` row AND on the enriched `tool_use` block in `contentJson`
 *    (the backend's `enrichToolUseBlocks` copies the row onto the block). The
 *    layout adapter reads the BLOCK FIRST (`segment-adapter.mergeSource`), so
 *    patching only the row leaves the adapter seeing the stale status and the
 *    fix silently does nothing. The shared tree helpers reused below already
 *    write both (`syncContentJsonFields`), which is precisely why they are
 *    reused rather than reimplemented.
 * 2. NO-OP MUST BE REFERENTIALLY DETECTABLE. When nothing matched we return the
 *    original array reference and `changed: false`, so the caller can skip the
 *    rebuild entirely (a narrator with no loaded occurrence of the toolUseId
 *    must not pay for a layout pass on every event).
 *
 * Reuse note: the tree walkers come from `../message-tree-utils`, the same pure
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
	ACTIVE_REFLECTION_STATUSES,
	getPermissionReflectionSuggestion,
} from "@shared/pretext-layout/reflection";
import {
	getNewestReflectionToolOccurrenceInTree,
	mergeFieldsIntoNewestToolOccurrenceInTree,
	mergeToolCallFieldsInTree,
	replaceSubagentActivitySnapshot,
	updateSubagentActivityInMessages,
	upsertSubagentToolCallHeader,
} from "../message-tree-utils";
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

function isTerminalToolStatus(status: unknown): boolean {
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
		if (msg.children?.length) {
			const nested = newestToolStatus(msg.children, toolUseId);
			if (nested !== undefined) return nested;
		}
		const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
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
 * shared tree helpers: `upsertSubagentToolCallHeader`'s `preventTerminalRegression`
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
 * permission decisions / background-task terminals), mirroring the chunked
 * path's `mergeFieldsByIndex`.
 *
 * All-occurrence semantics match the chunked path: a duplicate provider
 * toolUseId collapses to one `tool-<id>` vlist row anyway, so writing every
 * occurrence cannot make two rows disagree.
 */
export function patchToolCallFields(
	messages: readonly TreeMessage[],
	toolUseId: string,
	fields: Record<string, unknown>,
): LivePatchResult {
	if (!toolUseId || !Array.isArray(messages) || messages.length === 0) return unchanged(messages);
	if (Object.keys(fields).length === 0) return unchanged(messages);
	const safeFields = withoutTerminalRegression(messages, toolUseId, fields);
	if (Object.keys(safeFields).length === 0) return unchanged(messages);
	const result = mergeToolCallFieldsInTree(messages as TreeMessage[], toolUseId, safeFields);
	return result.changed ? result : unchanged(messages);
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
	const occurrence = getNewestReflectionToolOccurrenceInTree(
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
	const result = mergeFieldsIntoNewestToolOccurrenceInTree(
		messages as TreeMessage[],
		toolUseId,
		safeFields,
	);
	return result.changed ? result : unchanged(messages);
}

/**
 * Upsert one child tool-call header into a parent Agent/Task/Send card's
 * `_subagentActivity` summary (the "recent calls" rows on a subagent card).
 * Mirrors the chunked path's `applySubagentToolActivity`.
 */
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
		(current) => {
			const next = upsertSubagentToolCallHeader(current, header);
			// Same "never erase a known value" rule as the model: a tool event that
			// omits the tier must keep the one the card already shows.
			const reasoningEffort =
				normalizeModel(meta?.reasoningEffort) ??
				normalizeModel(current?.reasoningEffort) ??
				normalizeModel(next.reasoningEffort);
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

/**
 * Attach the child narrator id / model to a parent card WITHOUT recording a tool
 * call. `subagent_started` announces which narrator a card now owns before that
 * child has run anything, so synthesizing a header here would invent a phantom
 * "recent call" row. Mirrors the chunked path's `updateSubagentActivityInCache`
 * identity-only update.
 */
export function patchSubagentIdentity(
	messages: readonly TreeMessage[],
	parentToolUseId: string,
	identity: {
		subagentNarratorId?: string | null;
		model?: string | null;
		reasoningEffort?: string | null;
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
		(current) => {
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
				normalizeModel(current.reasoningEffort) === resolvedReasoningEffort
			) {
				return current;
			}
			return {
				...(current ?? { latestToolCalls: [] }),
				subagentNarratorId: resolvedNarratorId,
				model: resolvedModel,
				...(resolvedReasoningEffort ? { reasoningEffort: resolvedReasoningEffort } : {}),
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
		let localChanged = false;
		const nextContent = (message.contentJson ?? []).map((block) => {
			if (block.type !== "tool_use") return block;
			const record = block as unknown as Record<string, unknown>;
			if (!ownsSubagent(record, subagentNarratorId)) return block;
			const patched = withTakenOverEntry(record, takenOver);
			if (patched === record) return block;
			localChanged = true;
			return patched as unknown as typeof block;
		});
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
			next = { ...message, contentJson: nextContent, toolCalls: nextCalls };
		}
		if (next.children?.length) {
			const child = markTakenOverForNarrator(next.children, subagentNarratorId, takenOver);
			if (child.changed) {
				changed = true;
				next = { ...next, children: child.messages as TreeMessage[] };
			}
		}
		return next;
	});
	return { messages: changed ? updated : messages, changed };
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
export class LivePatchQueue {
	private queue: LivePatch[] = [];
	private queuedFor: string | undefined;
	private handle = 0;

	constructor(private host: LivePatchQueueHost) {}

	enqueue(patch: LivePatch | null): void {
		if (!patch) return;
		const narratorId = this.host.currentNarratorId();
		// A queue stamped for another narrator can only be a leftover from the switch;
		// drop it rather than mixing two documents' patches into one batch.
		if (this.queuedFor !== narratorId) {
			this.queue = [];
			this.queuedFor = narratorId;
		}
		this.queue.push(patch);
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
		this.host.apply(composeLivePatches(queued));
	}

	/** Discard everything pending (unmount / narrator switch). */
	dispose(): void {
		if (this.handle) this.host.cancel(this.handle);
		this.handle = 0;
		this.queue = [];
		this.queuedFor = undefined;
	}
}
