/**
 * trace-row-identity.ts — Pure, DOM-free identity for ONE folded trace row.
 *
 * At low LOD a tool-run collapses into a trace (a list of single-line rows):
 *   L1 / L2 → ActivityTrace   / `activity-trace`    (reasoning + tool rows merged)
 *
 * Those rows carry no interaction surface of their own, so this module resolves
 * the facts a row needs to join the existing selection / context-menu system:
 * the selection `blockId`, its owning (messageId, blockIndex), and — for tool
 * rows — the tool-specific menu facts.
 *
 * Shared by BOTH render paths on purpose:
 *   - chunked : CollapsibleTrace rows (ActivityTrace)
 *   - vlist   : RenderToolRun rows (via the height-neutral identity passthrough)
 * It therefore lives OUTSIDE vlist/ — the isolation guard forbids non-vlist files
 * from statically importing vlist/, but the reverse direction is allowed.
 *
 * ⚠️ The reasoning run-start mapping below is load-bearing; see
 * `reasoningRunIdentityIndices`.
 */

import { groupReasoningRuns } from "@shared/pretext-layout/reasoning-segments";
import { extractField } from "@shared/pretext-layout/tool-detail";
import { makeMessageBlockSelectionId } from "./MessageSelectionCtx";
import type { ContentBlock } from "./narrator-panel-types";

/** Tools whose input carries a file path worth offering in the row menu. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);

/**
 * Terminal tool-call statuses. A finished subagent can no longer be detached to
 * the background or cancelled, so those items hide. Mirrors ToolCallCard's
 * `isTerminalToolStatus` (SubagentCard.tsx:122) minus the aliases a persisted
 * tool call never carries.
 */
const TERMINAL_STATUSES =
	/^(success|completed|denied|error|fail|failed|cancelled|canceled|aborted|timeout)$/;

const SUBAGENT_ID_TAG_RE = /<subagent_id>([^<]+)<\/subagent_id>/;

/** Tool facts a folded tool row needs for its tool-specific menu items. */
export interface TraceRowToolMeta {
	/** Raw tool name (e.g. "Read", "Await"). */
	toolName: string;
	/** Tool-call id — drives the inspector item (absent → hidden). */
	toolUseId?: string;
	/** File-oriented tools: the input file path (copy path / view file). */
	filePath?: string;
	/** Read tool → the file can be previewed inline (modal). */
	isReadTool?: boolean;
	/**
	 * Any file-oriented tool (Read / Write / Edit) with a path → the file can be
	 * opened in a dock panel. Broader than `isReadTool` on purpose: the panel reads
	 * the file's CURRENT on-disk content, which is just as meaningful after a write
	 * as after a read.
	 */
	isFileTool?: boolean;
	/**
	 * Await({type:"agent"}) → the resolved child narrator id, when the tool call's
	 * EMBEDDED data already knows it (its own returned metadata, the
	 * `<subagent_id>` tag, or — while the wait is still running — the server-derived
	 * `_awaitAgentNarratorId`).
	 *
	 * 【performance invariant】This is derived by a pure function from data already
	 * in hand. A folded trace shows 10+ rows and a page shows several traces, so
	 * the row menu must NEVER replicate ToolCallCard's fallback lookup
	 * (`useQuery(["background-task-target", …])` → api.resolveBackgroundTaskTarget):
	 * that would open one react-query subscription per row. When the id is not
	 * embedded the "view subagent session" item is simply hidden.
	 */
	awaitAgentNarratorId?: string;
	/**
	 * Subagent card (Agent / Task / Send): the child narrator id, read from the
	 * tool call's embedded `_subagentActivity` summary. Drives the same three
	 * items the expanded SubagentCard offers — open full session, detach to
	 * background, cancel background task.
	 *
	 * Like `awaitAgentNarratorId` this is EMBEDDED-only: no per-row query.
	 */
	subagentNarratorId?: string;
	/**
	 * `Send` → the addressed narrator id, when the call had exactly one target.
	 *
	 * Send creates no child messages, so `subagentNarratorId` is empty for it;
	 * the real id lives only in `metadata.targets[]`. See
	 * `traceRowSendTargetNarratorId`.
	 */
	sendTargetNarratorId?: string;
	/** Subagent launched in background mode (`background` / `run_in_background`). */
	isBackground?: boolean;
	/** The tool call reached a terminal status (no detach / cancel). */
	isTerminal?: boolean;
	/** Result message id — the `scrollTo` target when jumping into the child. */
	resultMessageId?: string;
}

/**
 * Everything one folded trace row needs to behave like a selectable block.
 * `tool` is present only for tool rows; reasoning rows omit it.
 */
export interface TraceRowIdentity {
	/** Selection-system blockId: `tc-…` | `sa-…` | `msg-{messageId}-{blockIndex}`. */
	blockId: string;
	/** Owning message id (DOM contract + message-level actions). */
	messageId: string;
	/** Primary block index (rollback target; run START index for reasoning). */
	blockIndex: number;
	/** Every source block index this row represents — delete acts on each. */
	blockIndices?: readonly number[];
	/** Tool-row-only menu facts. */
	tool?: TraceRowToolMeta;
	/** Text the "copy" menu item writes; omitted → no copy item. */
	copyText?: string;
}

/** The minimal tool-call shape this module reads (matches ToolCallData). */
export interface TraceRowToolCallLike {
	toolName: string;
	toolUseId?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic tool JSON
	inputJson?: any;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic tool JSON
	outputJson?: any;
	_metadata?: Record<string, unknown>;
	/** Tool-call status — gates the detach / cancel items. */
	status?: string;
	/** Lightweight subagent activity summary attached by the parent page. */
	_subagentActivity?: { subagentNarratorId?: string | null } | null;
	/** Message id of the tool result — used as the child's `scrollTo` target. */
	resultMessageId?: string | null;
	/**
	 * Server-derived child narrator id of a RUNNING Await-agent call. See
	 * `AWAIT_AGENT_RESOLVED_FIELD` (server/services/narrator-messages.ts): a wait in
	 * flight has no output, so this is the only source available before it returns.
	 */
	_awaitAgentNarratorId?: string | null;
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Same key order as tool-display.ts's getFilePath (file_path → filePath → path). */
function readFilePath(input: unknown): string {
	return extractField(input, "file_path", "filePath", "path");
}

/** Extract `<subagent_id>…</subagent_id>` from a tool result body. */
function readSubagentIdTag(text: string): string | undefined {
	return nonEmpty(SUBAGENT_ID_TAG_RE.exec(text)?.[1]);
}

/**
 * `Await({type:"agent"})` → the resolved child narrator id, from EMBEDDED data
 * only (metadata.subagentId / metadata.resolvedId, else a `<subagent_id>` tag in
 * the output text). Mirrors ToolCallCard's getAwaitAgentNarratorId minus its
 * network fallback — see the performance invariant on `awaitAgentNarratorId`.
 */
export function traceRowAwaitAgentNarratorId(tc: TraceRowToolCallLike): string | undefined {
	if (tc.toolName !== "Await") return undefined;
	const metadata = asRecord(asRecord(tc.outputJson)._metadata ?? tc._metadata);
	const awaitType = extractField(tc.inputJson, "type") || nonEmpty(metadata.awaitType) || "";
	if (awaitType !== "agent") return undefined;
	// An Await-agent call with no target has no session to open.
	if (!nonEmpty(extractField(tc.inputJson, "id") || nonEmpty(metadata.targetId) || "")) {
		return undefined;
	}
	const fromMetadata = nonEmpty(metadata.subagentId) ?? nonEmpty(metadata.resolvedId);
	if (fromMetadata) return fromMetadata;
	const output = tc.outputJson;
	const text =
		typeof output === "string"
			? output
			: (nonEmpty((asRecord(output) as { _text?: unknown })._text as string) ?? "");
	const fromTag = text ? readSubagentIdTag(text) : undefined;
	if (fromTag) return fromTag;
	// Still waiting: fall back to the server's resolution of the selector.
	return nonEmpty(tc._awaitAgentNarratorId);
}

/**
 * Reserved selectors a subagent uses to address its parent. Mirrors
 * `PARENT_SELECTORS` (server/services/agent-communication.ts) and
 * `RESERVED_SEND_SELECTORS` (vlist-tool-meta.ts).
 */
const RESERVED_SEND_SELECTORS = new Set(["parent", "main", "@parent", "@main"]);

function isReservedSendSelector(value: unknown): boolean {
	return typeof value === "string" && RESERVED_SEND_SELECTORS.has(value.trim().toLowerCase());
}

/**
 * `Send` → the narrator id whose session this row can open.
 *
 * Mirrors `deriveSendTargetNarratorId` (vlist-tool-meta.ts) so both render paths
 * navigate identically from the same row; see that function for why only a
 * single-target Send resolves, and why a parent report is excluded even though its
 * `id` is a real narrator id (the affordance opens a SUBAGENT panel).
 */
export function traceRowSendTargetNarratorId(tc: TraceRowToolCallLike): string | undefined {
	if (tc.toolName !== "Send") return undefined;
	const metadata = asRecord(asRecord(tc.outputJson)._metadata ?? tc._metadata);
	const targets = metadata.targets;
	if (!Array.isArray(targets) || targets.length !== 1) return undefined;
	const target = asRecord(targets[0]);
	if (isReservedSendSelector(target.label)) return undefined;
	const id = nonEmpty(target.id);
	if (!id || isReservedSendSelector(id)) return undefined;
	return id;
}

/**
 * Whether a subagent tool was launched in background mode. Mirrors
 * SubagentCard.tsx's `isBackground` (both the Agent `background` flag and the
 * Bash-style `run_in_background` alias).
 */
export function traceRowIsBackground(tc: TraceRowToolCallLike): boolean {
	const input = asRecord(tc.inputJson);
	return input.background === true || input.run_in_background === true;
}

/** Whether the tool call has finished (mirrors SubagentCard's isTerminalToolStatus). */
export function traceRowIsTerminal(tc: TraceRowToolCallLike): boolean {
	return TERMINAL_STATUSES.test(tc.status ?? "");
}

/** Derive the tool-specific menu facts for one folded tool row. */
export function traceRowToolMeta(tc: TraceRowToolCallLike): TraceRowToolMeta {
	const meta: TraceRowToolMeta = { toolName: tc.toolName };
	if (tc.toolUseId) meta.toolUseId = tc.toolUseId;
	if (FILE_TOOLS.has(tc.toolName)) {
		const filePath = readFilePath(tc.inputJson);
		if (filePath) {
			meta.filePath = filePath;
			meta.isFileTool = true;
			if (tc.toolName === "Read") meta.isReadTool = true;
		}
	}
	const awaitAgentNarratorId = traceRowAwaitAgentNarratorId(tc);
	if (awaitAgentNarratorId) meta.awaitAgentNarratorId = awaitAgentNarratorId;
	// Subagent lifecycle facts (open session / detach / cancel). The child id is
	// embedded in the activity summary the parent page already carries, so this
	// stays a pure derivation — never a per-row lookup.
	const subagentNarratorId = nonEmpty(tc._subagentActivity?.subagentNarratorId);
	if (subagentNarratorId) meta.subagentNarratorId = subagentNarratorId;
	const sendTargetNarratorId = traceRowSendTargetNarratorId(tc);
	if (sendTargetNarratorId) meta.sendTargetNarratorId = sendTargetNarratorId;
	if (traceRowIsBackground(tc)) meta.isBackground = true;
	if (traceRowIsTerminal(tc)) meta.isTerminal = true;
	const resultMessageId = nonEmpty(tc.resultMessageId);
	if (resultMessageId) meta.resultMessageId = resultMessageId;
	return meta;
}

/**
 * ⚠️ Whether the selection system files this tool under `sa-` rather than `tc-`.
 *
 * This MUST mirror buildSelectionIndex's `isSubagentTool` exactly — which is
 * narrower than `message-segments`' ToolRunItem.isSubagent (that one also counts
 * Task / Send / _subagentActivity). The distinction is load-bearing, not cosmetic:
 *
 * `byBlockId` registers BOTH aliases, so a lookup succeeds with either prefix —
 * but the selection SET stores whatever blockId we hand to toggleBlock, while
 * `entriesToBlockMeta` / `computeSelectedRange` test `selectedIds.has(entry.blockId)`
 * against the entry's PRIMARY id. Selecting a row as `sa-X` when its primary is
 * `tc-X` would therefore highlight the row yet make the selection toolbar (copy /
 * delete / range) silently skip it.
 *
 * @param toolName  The tool call's name (equals the content block's `name`).
 * @param hasChildren  Whether any child message has this call as its parent tool use.
 */
export function isSelectionSubagentTool(toolName: string, hasChildren: boolean): boolean {
	return toolName === "Agent" || hasChildren;
}

/**
 * Selection blockId for a folded TOOL row: `sa-{toolUseId}` for a subagent tool,
 * `tc-{toolUseId}` otherwise. `isSubagent` must come from
 * `isSelectionSubagentTool` so it matches the entry's primary id.
 *
 * Returns null when the tool call has no id — such a row cannot be selected
 * (there is no selection entry for it either).
 */
export function traceRowToolBlockId(tc: TraceRowToolCallLike, isSubagent: boolean): string | null {
	if (!tc.toolUseId) return null;
	return `${isSubagent ? "sa-" : "tc-"}${tc.toolUseId}`;
}

/** The resolved run a reasoning block belongs to. */
export interface ReasoningRunIndices {
	/** Index of the run's FIRST block — the only index selection registers. */
	startIndex: number;
	/** Every block index in the run (contiguous). */
	indices: readonly number[];
}

/**
 * ⚠️ Map a reasoning block index to the run that OWNS it.
 *
 * This exists because the activity fold and the selection index disagree on
 * granularity, and getting it wrong fails silently:
 *
 *  - `buildSelectionIndex` (vlist-selection.ts) groups ADJACENT reasoning blocks
 *    with `groupReasoningRuns` and registers an entry (plus the
 *    `msg-{id}-{startIndex}` alias) for the run's START index ONLY; absorbed
 *    indices land in `skip` and get no entry at all.
 *  - The activity fold (`splitMessageSegmentForActivity` in render-units.ts, and
 *    `adaptActivityItems` in shared/segment-adapter.ts) walks reasoning blocks
 *    ONE BY ONE, so a message with two adjacent reasoning blocks yields rows for
 *    blockIndex 0 AND 1.
 *
 * Using the row's own blockIndex would therefore mint `msg-{id}-1`, which no
 * selection entry matches — Ctrl/Shift select, range select and the selection
 * toolbar (`entriesToBlockMeta` / `computeSelectedRange` both match by entry)
 * would all silently do nothing.
 *
 * So a reasoning row must identify itself by its run's start index, and carry
 * the run's full index list for delete.
 *
 * Returns `[blockIndex]` as a degenerate run when the block is not part of any
 * reasoning run (defensive; callers only use this for reasoning rows).
 */
export function reasoningRunIndices(
	blocks: readonly ContentBlock[] | null | undefined,
	blockIndex: number,
): ReasoningRunIndices {
	if (!Array.isArray(blocks) || blocks.length === 0) {
		return { startIndex: blockIndex, indices: [blockIndex] };
	}
	const { runs } = groupReasoningRuns(blocks as Parameters<typeof groupReasoningRuns>[0]);
	for (const run of runs) {
		if (run.indices.includes(blockIndex)) {
			return { startIndex: run.startIndex, indices: run.indices };
		}
	}
	return { startIndex: blockIndex, indices: [blockIndex] };
}

/**
 * Build the identity for a folded REASONING row, applying the run-start mapping.
 * `blocks` must be the owning message's full `contentJson` so run adjacency
 * matches what buildSelectionIndex saw.
 */
export function reasoningTraceRowIdentity(
	messageId: string,
	blocks: readonly ContentBlock[] | null | undefined,
	blockIndex: number,
	copyText?: string,
): TraceRowIdentity {
	const run = reasoningRunIndices(blocks, blockIndex);
	return {
		blockId: makeMessageBlockSelectionId(messageId, run.startIndex),
		messageId,
		blockIndex: run.startIndex,
		blockIndices: run.indices,
		...(copyText?.trim() ? { copyText } : {}),
	};
}

/**
 * Build the identity for a folded TOOL row. Returns null when the tool call has
 * no id (no selection entry exists for it, so it cannot be selected).
 */
export function toolTraceRowIdentity(
	messageId: string,
	blockIndex: number,
	tc: TraceRowToolCallLike,
	isSubagent: boolean,
): TraceRowIdentity | null {
	const blockId = traceRowToolBlockId(tc, isSubagent);
	if (!blockId) return null;
	return {
		blockId,
		messageId,
		blockIndex,
		blockIndices: [blockIndex],
		tool: traceRowToolMeta(tc),
	};
}
