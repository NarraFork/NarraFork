/**
 * vlist-tool-meta.ts — Pure, DOM-free derivation of the per-row TOOL metadata the
 * vlist interaction menu needs for its card-specific (command-style) items.
 *
 * The generic message actions (fork / rollback / delete / compact / askInPassing)
 * are built by vlist-row-actions.ts from the panel handlers. This module supplies
 * the extra facts that only the raw tool call carries, and which the pretext spec
 * deliberately does not (the layout spec only keeps height-relevant fields):
 *
 *   - subagent card  → the child narrator id ("open full session"),
 *                      background/terminal state (detach / cancel background)
 *   - tool call      → Await({type:"agent"}) target + resolved narrator id
 *                      ("view subagent session"), file path (copy path /
 *                      view file), Read-ness
 *
 * Mirrors the chunked path's derivations 1:1:
 *   SubagentCard.tsx:237      subagentNarratorId = activity?.subagentNarratorId
 *   SubagentCard.tsx:271      isBackground = input.background || run_in_background
 *   ToolCallCard.tsx:3482     getAwaitAgentTargetId
 *   ToolCallCard.tsx:3494     getAwaitAgentNarratorId
 *   ToolCallCard.tsx:5714     fileMenuPath = FILE_TOOLS.has(name) ? path : ""
 *
 * Keyed by toolUseId, because a vlist row resolves to a `tc-{toolUseId}` /
 * `sa-{toolUseId}` selection blockId (see vlist-block-target.ts) rather than to a
 * (messageId, blockIndex) pair.
 */

import { extractField, isTruncated, resolveDisplayText } from "@shared/pretext-layout/tool-detail";
import type { ContentBlock, NarratorMsg } from "../narrator-panel-types";
import { runningSendTargetNarratorId } from "../trace/trace-row-identity";

/** Tools whose input carries a file path worth offering in the menu. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);

/** Same key order as tool-display.ts's getFilePath (file_path → filePath → path). */
function readFilePath(input: unknown): string {
	return extractField(input, "file_path", "filePath", "path");
}

/** Terminal tool-call statuses (no longer running → no detach/cancel). */
const TERMINAL_STATUSES = new Set(["success", "fail", "error", "cancelled"]);

const SUBAGENT_ID_TAG_RE = /<subagent_id>([^<]+)<\/subagent_id>/;

/** Per-row tool facts consumed by VListRowInteraction's menu gating. */
export interface VListToolMeta {
	/** Raw tool name (e.g. "Read", "Await", "Agent"). */
	toolName?: string;
	/** Subagent card: the child narrator id, when the activity summary knows it. */
	subagentNarratorId?: string;
	/** Active Await({type:"question"}): the inbox question id. */
	awaitQuestionId?: string;
	/** Message seq of the tool_use that owns awaitQuestionId (latest wait wins). */
	awaitQuestionSeq?: number;
	/** Await({type:"agent"}): the requested target id (id | alias | narratorId). */
	awaitAgentTargetId?: string;
	/** Await({type:"agent"}): the resolved child narrator id, when known. */
	awaitAgentNarratorId?: string;
	/** Send: the addressed narrator id, when the call had exactly one target. */
	sendTargetNarratorId?: string;
	/** File-oriented tools: the input file path (copy path / view file). */
	filePath?: string;
	/** Read tool → the file can be previewed inline (modal). */
	isReadTool?: boolean;
	/**
	 * Any file-oriented tool (Read / Write / Edit) with a path → the file can be
	 * opened in a dock panel, which reads the CURRENT on-disk content.
	 */
	isFileTool?: boolean;
	/** Subagent launched in background mode (Agent/Send `background`). */
	isBackground?: boolean;
	/** Tool call reached a terminal status. */
	isTerminal?: boolean;
	/** Result message id — used as the `scrollTo` target when jumping. */
	resultMessageId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !isTruncated(value)
		? (value as Record<string, unknown>)
		: {};
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** Extract `<subagent_id>…</subagent_id>` from a tool result body. */
export function readSubagentIdTag(text: string): string | undefined {
	return nonEmpty(text.match(SUBAGENT_ID_TAG_RE)?.[1]);
}

/**
 * Server-derived child narrator id for a RUNNING Await-agent call.
 *
 * A wait in flight has no output yet, so none of the persisted sources exist; the
 * server resolves the selector and ships the answer in this field (see
 * `AWAIT_AGENT_RESOLVED_FIELD` in server/services/narrator-messages.ts for why it
 * is kept out of `metadata`).
 */
const AWAIT_AGENT_RESOLVED_FIELD = "_awaitAgentNarratorId";

/**
 * The `_metadata` bag a tool call may carry either on its output or on itself.
 * Mirrors ToolCallCard's `toolCall.outputJson?._metadata ?? toolCall._metadata`.
 */
function readMetadata(block: ContentBlock): Record<string, unknown> {
	const record = block as unknown as Record<string, unknown>;
	const output = asRecord(record.output ?? record.outputJson);
	return asRecord(output._metadata ?? record._metadata);
}

/**
 * The Await target id when (and only when) this is an `Await({type:"agent"})`
 * call. Any other await type (bash / task) has no subagent session to open.
 */
export function deriveAwaitAgentTargetId(
	toolName: string | undefined,
	input: unknown,
	metadata: Record<string, unknown>,
): string | undefined {
	if (toolName !== "Await") return undefined;
	const awaitType = extractField(input, "type") || nonEmpty(metadata.awaitType) || "";
	if (awaitType !== "agent") return undefined;
	return nonEmpty(extractField(input, "id") || nonEmpty(metadata.targetId) || "");
}

/**
 * Reserved selectors a subagent uses to address its parent. Mirrors
 * `PARENT_SELECTORS` (server/services/agent-communication.ts).
 *
 * Checked against BOTH fields, because the two carry it in different shapes:
 *
 *  - `id` holds a raw selector only on the mixed-target rejection path, which
 *    echoes the selectors back instead of resolved ids.
 *  - `label` holds it on a SUCCESSFUL parent report: `tryRouteToParent` labels the
 *    target with the selector the model typed while `id` is the parent's real
 *    narrator id. That id is the only reason the label has to be consulted at all
 *    (see `deriveSendTargetNarratorId`).
 */
const RESERVED_SEND_SELECTORS = new Set(["parent", "main", "@parent", "@main"]);

function isReservedSendSelector(value: unknown): boolean {
	return typeof value === "string" && RESERVED_SEND_SELECTORS.has(value.trim().toLowerCase());
}

/**
 * `Send` → the narrator id whose session the card can open.
 *
 * Send's `metadata.targets[]` is the only place this fact lives: a Send does not
 * create child messages, so `_subagentActivity` (a join on `parentToolUseId`) is
 * empty for it — 628 of 649 Send calls in a real database. Without reading the
 * targets, "view session" is hidden on every Send card even though the tool
 * layer deliberately kept the REAL id there for exactly this purpose (see
 * `SendTargetResult.id`).
 *
 * Only a SINGLE-target Send resolves. A fan-out Send addresses several sessions
 * and one menu item cannot say which — the same reason an ambiguous Await
 * selector resolves to nothing rather than guessing (`resolveAgainstRoster`).
 * This also excludes the mixed parent/sibling rejection path, which is the one
 * shape whose `id` holds a raw selector rather than a narrator id (it always has
 * ≥2 targets, since "mixed" requires both kinds).
 *
 * ⚠️ A report to the PARENT resolves to nothing even though its `id` is a perfectly
 * valid narrator id. The affordance this feeds opens a SUBAGENT session panel
 * (`openSubagentPanel` → `SubagentSessionPanelContent`), which titles an untitled
 * narrator "Subagent" and files it under subagent recent tabs. Pointing that at a
 * primary narrator misrepresents what the reader is looking at, and nothing would
 * report the mismatch. The parent's own session is reachable from the subagent
 * panel's own header, which is the honest route.
 */
export function deriveSendTargetNarratorId(
	toolName: string | undefined,
	metadata: Record<string, unknown>,
	input?: unknown,
	resolved?: unknown,
): string | undefined {
	const isTeamSend = toolName === "TeamStatus" && asRecord(input).action === "send";
	if (toolName !== "Send" && !isTeamSend) return undefined;
	const targets = metadata.targets;
	if (targets === undefined) return runningSendTargetNarratorId(input, resolved);
	if (!Array.isArray(targets) || targets.length !== 1) return undefined;
	const target = asRecord(targets[0]);
	if (isReservedSendSelector(target.label)) return undefined;
	const id = nonEmpty(target.id);
	if (!id || isReservedSendSelector(id)) return undefined;
	return id;
}

/**
 * The resolved child narrator id for an Await-agent call, when discoverable.
 *
 * Order matters: the tool's OWN returned metadata is authoritative and wins, then
 * the `<subagent_id>` tag in its output, and only then the server's live
 * resolution of the selector — which is the only source that exists while the wait
 * is still running.
 */
export function deriveAwaitAgentNarratorId(
	block: ContentBlock,
	metadata: Record<string, unknown>,
): string | undefined {
	const fromMetadata = nonEmpty(metadata.subagentId) ?? nonEmpty(metadata.resolvedId);
	if (fromMetadata) return fromMetadata;
	const record = block as unknown as Record<string, unknown>;
	const output = resolveDisplayText(record.output ?? record.outputJson);
	const fromTag = output ? readSubagentIdTag(output) : undefined;
	if (fromTag) return fromTag;
	return nonEmpty(record[AWAIT_AGENT_RESOLVED_FIELD]);
}

/** Derive the tool meta for one `tool_use` content block. */
export function deriveToolMeta(block: ContentBlock): VListToolMeta | null {
	if (block.type !== "tool_use") return null;
	const record = block as unknown as Record<string, unknown>;
	const toolName = nonEmpty(block.name) ?? nonEmpty(record.toolName);
	const input = record.input ?? record.inputJson;
	const inputRecord = asRecord(input);
	const metadata = readMetadata(block);
	const activity = asRecord(record._subagentActivity);

	const filePath = toolName && FILE_TOOLS.has(toolName) ? readFilePath(input) : "";
	const status = nonEmpty(record.status);

	const meta: VListToolMeta = {};
	if (toolName) meta.toolName = toolName;
	if (toolName === "Await" && inputRecord.type === "question" && status === "running") {
		meta.awaitQuestionId = nonEmpty(inputRecord.id);
		const seq = record.seq ?? record.messageSeq;
		if (typeof seq === "number" && Number.isFinite(seq)) meta.awaitQuestionSeq = seq;
	}
	const subagentNarratorId = nonEmpty(activity.subagentNarratorId);
	if (subagentNarratorId) meta.subagentNarratorId = subagentNarratorId;
	const awaitTargetId = deriveAwaitAgentTargetId(toolName, input, metadata);
	if (awaitTargetId) {
		meta.awaitAgentTargetId = awaitTargetId;
		const awaitNarratorId = deriveAwaitAgentNarratorId(block, metadata);
		if (awaitNarratorId) meta.awaitAgentNarratorId = awaitNarratorId;
	}
	const sendTargetNarratorId = deriveSendTargetNarratorId(
		toolName,
		metadata,
		input,
		(record.output ?? record.outputJson) == null ? record[AWAIT_AGENT_RESOLVED_FIELD] : undefined,
	);
	if (sendTargetNarratorId) meta.sendTargetNarratorId = sendTargetNarratorId;
	if (filePath) {
		meta.filePath = filePath;
		meta.isFileTool = true;
		if (toolName === "Read") meta.isReadTool = true;
	}
	if (inputRecord.background === true || inputRecord.run_in_background === true) {
		meta.isBackground = true;
	}
	if (status && TERMINAL_STATUSES.has(status)) meta.isTerminal = true;
	const resultMessageId = nonEmpty(record.resultMessageId);
	if (resultMessageId) meta.resultMessageId = resultMessageId;
	return meta;
}

/**
 * Build the `toolUseId → VListToolMeta` lookup for a flat message list. Rows
 * without a tool call are absent; the interaction layer then renders only the
 * generic message menu (parity with the chunked path).
 */
export function buildToolMetaIndex(messages: readonly NarratorMsg[]): Map<string, VListToolMeta> {
	const index = new Map<string, VListToolMeta>();
	for (const msg of messages) {
		if (!Array.isArray(msg?.contentJson)) continue;
		for (const raw of msg.contentJson as ContentBlock[]) {
			if (!raw || typeof raw !== "object" || raw.type !== "tool_use") continue;
			const toolUseId = typeof raw.id === "string" ? raw.id : undefined;
			if (!toolUseId) continue;
			const meta = deriveToolMeta({
				...raw,
				seq: typeof raw.seq === "number" ? raw.seq : msg.seq,
			} as ContentBlock);
			if (meta) index.set(toolUseId, meta);
		}
	}
	return index;
}
