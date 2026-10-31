/**
 * Canonical narrator blocks (docs/BLOCK_STORAGE-DESIGN.md §3).
 *
 * A message row is an envelope: one assistant step, or one input. Its content is an
 * ordered list of blocks; a block is the smallest unit any of persistence, editing,
 * display or request assembly addresses on its own. Finer structure (attachments,
 * reasoning segments, the output_text parts of one item) are parts of a block.
 *
 * Until blocks get their own table, they are decoded from `content_json`
 * (`decodeLegacyContent`) and the derived envelope columns are rebuilt from them
 * (`deriveEnvelope`). Every consumer reads this one shape.
 *
 * Pure types: no server imports, so clients and plugins can share them.
 */

import type { TextCitation } from "../citations";
import type { FileReference } from "../file-reference";
import type { MessageOrigin } from "../message-origin";
import type { ContextUpdate } from "../prefix-context";

export type { ContextUpdate } from "../prefix-context";

/** Who wrote a block and how it came to be (§3.3). */
export type BlockKind = "input" | "output" | "reasoning" | "tool" | "context";

/**
 * Lifecycle shared by every kind (§3.5).
 *
 * - `open`: still in progress (item streaming, tool awaiting its result, compact running)
 * - `done`: completed normally
 * - `aborted`: interrupted; produced content is kept (output / reasoning only)
 * - `failed`: completed but void (broken tool call, failed compact)
 */
export type BlockPhase = "open" | "done" | "aborted" | "failed";

// === Parts ===

export interface TextPart {
	type: "text";
	text: string;
	/** Citations in the coordinates of `text`. */
	citations?: TextCitation[];
	/** Reasoning only: which channel of the item the segment came from. */
	segment?: "summary" | "content";
}

/**
 * An image owned by the narrator's upload store. Until assets get a table, the id is
 * the existing upload `imageId`; `uploadNarratorId` names the store when it is not
 * the envelope owner's.
 */
export interface ImagePart {
	type: "image";
	assetId: string;
	mediaType?: string;
	name?: string;
	size?: number;
	sourceMimeType?: string;
	width?: number;
	height?: number;
	sha256?: string;
	uploadNarratorId?: string;
	/**
	 * Base64 bytes of an image that only lives in memory: a loop's own rows
	 * (`loop-transcript.ts`), which have no upload store. Stored rows never carry it.
	 */
	data?: string;
}

/** A text file attached by the user (`text_file`). */
export interface FilePart {
	type: "file";
	name: string;
	size?: number;
	/** Where the attachment was saved; legacy rows hold a path relative to the workspace. */
	filePath?: string;
	fileId?: string;
}

/** A workspace file captured when the input was accepted (`file_reference`). */
export interface FileRefPart {
	type: "file_ref";
	reference: FileReference;
	snapshotText: string;
	snapshotHash: string;
	capturedAt: string;
}

export type BlockPart = TextPart | ImagePart | FilePart | FileRefPart;

// === Provider metadata (§3.4) ===

/**
 * Origin and upstream skeleton of an assistant block.
 *
 * `wire` is the upstream item with model-visible text replaced by `{"$part": i}`
 * references; replaying it to the same source yields the original item byte for
 * byte. Decoded legacy rows carry the legacy credential fields instead.
 */
export interface ProviderMeta {
	/** The upstream that produced the block (the legacy `signatureSource`). */
	source?: string;
	wire?: Record<string, unknown>;
	/** Provider-executed tools only: the result item skeleton. */
	result?: Record<string, unknown>;
}

// === Kind payloads ===

export interface InputPayload {
	parts: BlockPart[];
	/** Composer document, when the input came from the rich composer. */
	doc?: unknown;
}

export interface OutputPayload {
	parts: BlockPart[];
}

export interface ReasoningPayload {
	/** Empty for redacted reasoning. */
	parts: TextPart[];
	redacted?: boolean;
}

/** The adopted result of a tool block (§3.7). */
export interface ToolResult {
	/** Adopted ledger attempt; absent for provider-executed tools. */
	toolCallId?: string;
	isError?: boolean;
	/** Images returned by the tool. */
	parts?: ImagePart[];
	/** Text that belongs to this result beyond the tool output. */
	appendix?: string;
}

export interface ToolPayload {
	/** The input replayed to the model: the one that was executed (D2). */
	input: unknown;
	executor: "local" | "provider";
	issuer: "model" | "user";
	result?: ToolResult;
}

export interface ContextPayload {
	/** Reader-facing structured body (cards, injection companions). */
	body?: Record<string, unknown>;
}

interface BlockBase {
	id: string;
	/** Root of the copy-on-write lineage; absent on originals. */
	originBlockId?: string;
	/** Order within the envelope. */
	ordinal: number;
	phase: BlockPhase;
	/** Non model-visible mutable metadata (§3.4). */
	state?: Record<string, unknown>;
	/** Provider attempt that produced an assistant block (§3.2). */
	attemptId?: string;
}

export interface InputBlock extends BlockBase {
	kind: "input";
	subtype?: "bash_command";
	payload: InputPayload;
	/** Frozen model-visible text: user text plus attachment hints (§3.4). */
	modelText: string | null;
}

export interface OutputBlock extends BlockBase {
	kind: "output";
	payload: OutputPayload;
	providerMeta?: ProviderMeta;
}

export interface ReasoningBlock extends BlockBase {
	kind: "reasoning";
	payload: ReasoningPayload;
	providerMeta?: ProviderMeta;
}

export interface ToolBlock extends BlockBase {
	kind: "tool";
	/** Tool name. */
	subtype: string;
	/** Call id on the wire (§3.2). */
	wireId: string;
	payload: ToolPayload;
	providerMeta?: ProviderMeta;
}

export interface ContextBlock extends BlockBase {
	kind: "context";
	subtype: string;
	payload: ContextPayload;
	modelText: string | null;
	/**
	 * View only: the protocol-native tool change a `tool_loaded` / `tool_unloaded` notice
	 * carries for the current tool loading strategy (see server tool-loading).
	 */
	toolChange?: ToolChange;
	/** Typed host update; its frozen model text is stored separately, exactly once. */
	contextUpdate?: ContextUpdate;
}

/** Tools surfaced or withdrawn at one history position. */
export interface ToolChange {
	mode: string;
	additions: ReadonlyArray<{ name: string; definition?: unknown }>;
	removals: readonly string[];
}

export type CanonicalBlock = InputBlock | OutputBlock | ReasoningBlock | ToolBlock | ContextBlock;

// === Envelope ===

export type EnvelopeRole = "user" | "assistant" | "sys" | "system" | "disp";

/** One message row as the canonical model sees it. */
export interface CanonicalEnvelope {
	id: string;
	/** Owner narrator of the row. */
	narratorId?: string;
	role: EnvelopeRole;
	origin?: MessageOrigin | null;
	parentToolUseId: string | null;
	/** Provider prefix of the step, when the row records one. */
	provider?: string | null;
	/** Upstream message id of an assistant step. */
	upstreamMessageId?: string | null;
	blocks: CanonicalBlock[];
	/**
	 * View only: the adopted ledger outputs of this envelope's tool blocks, by wire id.
	 * Tool output text stays in the ledger (D1); a history view joins it here.
	 */
	toolOutputs?: Record<string, ToolOutput>;
}

/** The adopted ledger attempt of a tool block, as the model sees it. */
export interface ToolOutput {
	status: "success" | "fail";
	output: unknown;
}

/** Whether a block may reach the model at all (§3.5); carry policy decides the rest. */
export function isModelVisible(block: CanonicalBlock): boolean {
	switch (block.kind) {
		case "output":
			return block.phase === "done" || block.phase === "aborted";
		case "reasoning":
		case "tool":
			return block.phase === "done";
		case "input":
			return (
				block.phase === "done" &&
				(!!block.modelText || block.payload.parts.some((part) => part.type === "image"))
			);
		case "context":
			return block.phase === "done" && !!block.modelText;
	}
}
