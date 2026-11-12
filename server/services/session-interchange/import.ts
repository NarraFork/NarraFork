/**
 * Write an {@link InterchangeSession} into NarraFork as a new standalone narrator.
 *
 * The rows are inserted directly rather than through `narratorPersistence`'s
 * per-message helpers. Those exist for live streaming: each one broadcasts, bumps
 * the message version and creates execution evidence for a call that is about to
 * run. An import writes history that already happened, so it wants none of that —
 * and replaying hundreds of broadcasts would stall every open client.
 *
 * Shape of what is written, matching what the live path would have produced:
 *  - user rows: `role:"user"`, text + `{type:"image", imageId}` blocks;
 *  - assistant rows: text / reasoning / tool_use blocks in original order, plus one
 *    `narrator_tool_calls` row per tool_use carrying the result;
 *  - compaction: a `role:"system"` compact marker whose ref is `isCompact=1`, so
 *    the model sees only what follows it, exactly as after a live compact;
 *  - subagents: a `type:"subagent"` narrator whose origin is the parent's Agent
 *    call row, and whose own rows hang under that call's `tool_use` id.
 *
 * Imported tool calls are marked as history, not executions
 * (`executionIdentityVersion: 0`, `executionAttempt: 0`): no file-change evidence
 * exists for them, so revert and attribution treat them as untracked legacy rows
 * instead of trusting a boundary that was never captured. The one exception is an
 * Agent call that owns an imported subagent, which must be a verified attempt-1 row
 * for the message tree to resolve its child (see `assistantRow`).
 *
 * Main-thread budget: rows are inserted in small transactions with the event loop
 * yielded between them, and the whole import is bounded by the caller's input limit.
 */

import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import {
	type InterchangeAssistantMessage,
	type InterchangeMessage,
	type InterchangeSession,
	type InterchangeToolResultMessage,
	type InterchangeUserBlock,
	type InterchangeWarning,
	toolResultText,
	WarningCollector,
	withFreshToolUseIds,
} from "@shared/session-interchange/model";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { IMPORTED_TRAIT, subagentVariant } from "../../lib/narrator-utils";
import { type RuntimePolicyTrait, withRuntimePolicyTrait } from "../../lib/runtime-policy-trait";
import { imageRefToContentBlock, saveUploadedImage } from "../../lib/uploads";
import {
	delegationRegistration,
	parseRuntimeRegistration,
} from "../../lib/validators/runtime-registration";
import { backgroundOccupancyStore } from "../background-occupancy-store";
import { compileDelegationCeiling } from "../custom-subagent-service";
import { bumpNarratorMessageVersion } from "../narrator-persistence";
import { dbTransactionWithSeqFloor } from "../narrator-refs/seq-floor-tx";
import { claimNextRefSeq } from "../narrator-refs/seq-store";
import { narratorService } from "../narrator-service";

/** Messages per insert transaction. Small enough that one batch never stalls the loop. */
export const IMPORT_BATCH_MESSAGES = 200;

/**
 * Serialized bytes per insert transaction. The message count alone does not bound
 * a batch: a few rows carrying multi-megabyte text would still be one long
 * synchronous transaction (JSON encoding plus FTS indexing of every row).
 */
export const IMPORT_BATCH_BYTES = 4 * 1024 * 1024;

/** Upper bound on one imported tool result, matching what live tools persist. */
export const IMPORT_TOOL_OUTPUT_MAX_CHARS = 512 * 1024;

/**
 * Upper bound on one text block or one tool input. Real rows peak around 200 KB;
 * anything past this is clamped (and reported) so no single row can dominate a
 * batch. Tool inputs are stored twice (in the content block and on the call row).
 */
export const IMPORT_BLOCK_MAX_CHARS = 1024 * 1024;

export interface ImportSessionOptions {
	ownerUserId: string;
	/** Overrides the session's own cwd. */
	cwd?: string;
	/** NarraFork model id for continuing the conversation; defaults to the instance default. */
	model?: string;
	/** Overrides the session's own title. */
	title?: string;
	/**
	 * Where the session came from, for the default title and the import log. Not
	 * persisted: an imported narrator is marked only by the `imported` trait, and
	 * importing the same session twice deliberately yields two narrators.
	 */
	source: { format: "claude-code" | "codex"; location?: string };
	/**
	 * Stops the import between batches; whatever was written is rolled back.
	 * Checked only between transactions, so a batch is never half-written.
	 */
	signal?: AbortSignal;
}

export interface ImportSessionResult {
	narratorId: string;
	subagentIds: string[];
	messageCount: number;
	warnings: InterchangeWarning[];
}

type Insertable = {
	message: typeof narratorMessages.$inferInsert;
	toolCalls: Array<typeof narratorToolCalls.$inferInsert>;
	isCompact: boolean;
};

/** Yield to the event loop between batches so an import never looks like a hang. */
function yieldToLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function textOf(blocks: Array<{ type: string; text?: string }>): string {
	return blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

function clampOutput(value: string, warnings: WarningCollector): string {
	if (value.length <= IMPORT_TOOL_OUTPUT_MAX_CHARS) return value;
	warnings.add("truncated_output");
	return `${value.slice(0, IMPORT_TOOL_OUTPUT_MAX_CHARS)}\n\n[truncated on import]`;
}

function clampText(value: string, warnings: WarningCollector): string {
	if (value.length <= IMPORT_BLOCK_MAX_CHARS) return value;
	warnings.add("truncated_output");
	return `${value.slice(0, IMPORT_BLOCK_MAX_CHARS)}\n\n[truncated on import]`;
}

/**
 * A tool input that serializes past the block limit is replaced by a marker
 * object. Its original shape cannot be kept safely (a clamped JSON document does
 * not parse), and a readable excerpt is worth more than a broken one.
 */
function clampInput(
	input: Record<string, unknown>,
	warnings: WarningCollector,
): Record<string, unknown> {
	const serialized = JSON.stringify(input);
	if (serialized.length <= IMPORT_BLOCK_MAX_CHARS) return input;
	warnings.add("truncated_output");
	return {
		_truncatedOnImport: true,
		excerpt: serialized.slice(0, IMPORT_BLOCK_MAX_CHARS / 4),
	};
}

/** Serialized size used to split batches; an estimate is enough to keep them small. */
function rowBytes(row: Insertable): number {
	let bytes = JSON.stringify(row.message.contentJson ?? null).length;
	for (const call of row.toolCalls) {
		bytes += JSON.stringify(call.inputJson ?? null).length;
		bytes += typeof call.outputJson === "string" ? call.outputJson.length : 0;
	}
	return bytes;
}

/**
 * A strictly increasing clock seeded from the source timestamps, so rows keep their
 * original order and time even when the source recorded two in the same millisecond.
 */
class ImportClock {
	private last = 0;

	next(source: string | undefined): string {
		const parsed = source ? Date.parse(source) : Number.NaN;
		const candidate = Number.isFinite(parsed) ? parsed : this.last + 1;
		this.last = Math.max(candidate, this.last + 1);
		return new Date(this.last).toISOString();
	}
}

async function userContentBlocks(
	blocks: InterchangeUserBlock[],
	narratorId: string,
	warnings: WarningCollector,
): Promise<Array<Record<string, unknown>>> {
	const content: Array<Record<string, unknown>> = [];
	for (const block of blocks) {
		if (block.type === "text") {
			content.push({ type: "text", text: clampText(block.text, warnings) });
			continue;
		}
		try {
			// Same validation as a browser upload: size, type sniffing, decode.
			const bytes = Buffer.from(block.data, "base64");
			const file = new File([bytes], `imported.${block.mediaType.split("/")[1] ?? "png"}`, {
				type: block.mediaType,
			});
			const ref = await saveUploadedImage(narratorId, file);
			content.push(imageRefToContentBlock(ref, narratorId));
		} catch (error) {
			warnings.add(
				"dropped_unsupported_block",
				`image: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return content;
}

interface BuildContext {
	narratorId: string;
	parentToolUseId: string | null;
	clock: ImportClock;
	warnings: WarningCollector;
	/** Filled with each subagent-spawning call's tool-call row id, by tool_use id. */
	agentCallRowIds: Map<string, string>;
	subagentToolUseIds: Set<string>;
}

async function buildRows(messages: InterchangeMessage[], ctx: BuildContext): Promise<Insertable[]> {
	const results = new Map<string, InterchangeToolResultMessage>();
	for (const message of messages) {
		if (message.role === "tool_result") results.set(message.toolUseId, message);
	}
	const rows: Insertable[] = [];
	for (const message of messages) {
		if (message.role === "tool_result") continue;
		const createdAt = ctx.clock.next(message.timestamp);
		const id = generateId();
		const base = {
			id,
			narratorId: ctx.narratorId,
			parentToolUseId: ctx.parentToolUseId,
			createdAt,
		};

		if (message.role === "user") {
			const content = await userContentBlocks(message.blocks, ctx.narratorId, ctx.warnings);
			if (content.length === 0) continue;
			rows.push({
				message: {
					...base,
					role: "user",
					contentJson: content,
					contentText: textOf(content as Array<{ type: string; text?: string }>) || null,
					origin: "user",
					originLabel: "Imported",
				},
				toolCalls: [],
				isCompact: false,
			});
			continue;
		}

		if (message.role === "compact") {
			rows.push({
				message: {
					...base,
					role: "system",
					contentJson: [
						{ type: "compact", status: "compacted", trigger: "imported", summary: message.summary },
					],
					contentText: `[Compact] ${message.summary.slice(0, 200)}...`,
				},
				toolCalls: [],
				isCompact: true,
			});
			continue;
		}

		rows.push(assistantRow(message, base, results, ctx));
	}
	return rows;
}

function assistantRow(
	message: InterchangeAssistantMessage,
	base: { id: string; narratorId: string; parentToolUseId: string | null; createdAt: string },
	results: Map<string, InterchangeToolResultMessage>,
	ctx: BuildContext,
): Insertable {
	const content: Array<Record<string, unknown>> = [];
	const toolCalls: Array<typeof narratorToolCalls.$inferInsert> = [];
	for (const block of message.blocks) {
		if (block.type === "text") {
			content.push({ type: "text", text: clampText(block.text, ctx.warnings) });
		} else if (block.type === "reasoning") {
			// No signatureSource: the history builder then refuses to replay the
			// signature to any strict upstream, and keeps only the text for relays.
			// `importedOfficialAnthropic` is only read by the session exporter, so a
			// Claude Code signature can go back to Claude Code on a round trip.
			content.push({
				type: "reasoning",
				text: clampText(block.text, ctx.warnings),
				...(block.signature?.provider === "anthropic"
					? {
							providerMetadata: {
								anthropic: { signature: block.signature.value },
								...(block.signature.officialAnthropic ? { importedOfficialAnthropic: true } : {}),
							},
						}
					: {}),
			});
		} else {
			const input = clampInput(block.input, ctx.warnings);
			content.push({ type: "tool_use", id: block.id, name: block.name, input });
			const result = results.get(block.id);
			const callRowId = generateId();
			if (ctx.subagentToolUseIds.has(block.id)) ctx.agentCallRowIds.set(block.id, callRowId);
			const output = result
				? clampOutput(
						typeof result.output === "string" ? result.output : toolResultText(result.output),
						ctx.warnings,
					)
				: null;
			if (!result) ctx.warnings.add("unpaired_tool_use", block.id);
			// A call that owns an imported subagent is the one row written as a verified
			// first attempt: the message tree only resolves a child through an Agent row
			// with identity version 1, and revert requires attempt 1 on any row that
			// owns children. It still carries no file-change evidence, which is what
			// version 0 protects on every other imported call.
			const ownsSubagent = ctx.subagentToolUseIds.has(block.id);
			toolCalls.push({
				id: callRowId,
				narratorId: base.narratorId,
				messageId: base.id,
				toolUseId: block.id,
				toolName: block.name,
				inputJson: input,
				outputJson: output,
				status: result && !result.isError ? "success" : "fail",
				errorMessage: result ? (result.isError ? output : null) : "Imported without a result",
				executionAttempt: ownsSubagent ? 1 : 0,
				executionIdentityVersion: ownsSubagent ? 1 : 0,
				completedAt: result ? ctx.clock.next(result.timestamp) : base.createdAt,
				createdAt: base.createdAt,
			});
		}
	}
	return {
		message: {
			...base,
			role: "assistant",
			contentJson: content,
			contentText: textOf(content as Array<{ type: string; text?: string }>) || null,
			model: message.model ?? null,
		},
		toolCalls,
		isCompact: false,
	};
}

/**
 * Batches of at most {@link IMPORT_BATCH_MESSAGES} rows AND about
 * {@link IMPORT_BATCH_BYTES}, whichever is hit first. A single row larger than the
 * byte budget still goes alone; the per-block clamps keep that bounded.
 */
function* batches(rows: Insertable[]): Generator<Insertable[]> {
	let batch: Insertable[] = [];
	let bytes = 0;
	for (const row of rows) {
		const size = rowBytes(row);
		if (
			batch.length > 0 &&
			(batch.length >= IMPORT_BATCH_MESSAGES || bytes + size > IMPORT_BATCH_BYTES)
		) {
			yield batch;
			batch = [];
			bytes = 0;
		}
		batch.push(row);
		bytes += size;
	}
	if (batch.length > 0) yield batch;
}

async function insertRows(
	narratorId: string,
	rows: Insertable[],
	signal: AbortSignal | undefined,
): Promise<void> {
	for (const batch of batches(rows)) {
		signal?.throwIfAborted();
		dbTransactionWithSeqFloor(narratorId, (tx) => {
			for (const row of batch) {
				tx.insert(narratorMessages).values(row.message).run();
				tx.insert(narratorMessageRefs)
					.values({
						id: generateId(),
						narratorId,
						messageId: row.message.id,
						seq: claimNextRefSeq(tx, narratorId),
						isCompact: row.isCompact ? 1 : 0,
					})
					.run();
				for (const call of row.toolCalls) tx.insert(narratorToolCalls).values(call).run();
			}
		});
		await yieldToLoop();
	}
}

/** Stats and the last compact summary, written once after all rows exist. */
function finalizeNarrator(narratorId: string, rows: Insertable[]): void {
	const lastCompact = rows.findLast((row) => row.isCompact);
	const summary = lastCompact
		? ((lastCompact.message.contentJson as Array<{ summary?: string }>)[0]?.summary ?? null)
		: null;
	const last = rows.at(-1)?.message.createdAt ?? null;
	db.update(narrators)
		.set({
			messageCount: sql`(SELECT count(*) FROM ${narratorMessageRefs} WHERE ${narratorMessageRefs.narratorId} = ${narratorId})`,
			lastMessageAt: last,
			...(summary ? { contextSummary: summary } : {}),
			updatedAt: new Date().toISOString(),
		})
		.where(eq(narrators.id, narratorId))
		.run();
}

function importTitle(session: InterchangeSession, options: ImportSessionOptions): string {
	const title = options.title?.trim() || session.title?.trim();
	if (title) return title;
	return options.source.format === "claude-code"
		? "Imported Claude Code session"
		: "Imported Codex session";
}

/** Insert the subagent narrator row directly: `createSubagent` requires a live, running Agent call. */
function createImportedSubagent(input: {
	parent: typeof narrators.$inferSelect;
	originToolCallId: string;
	historyToolUseId: string;
	subagentType: string;
	/** Compiled template ceiling (`compileDelegationCeiling`), stored like a live delegation's. */
	ceiling: RuntimePolicyTrait;
	title: string | undefined;
}): string {
	const id = generateId();
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({
			id,
			type: "subagent",
			subagentType: input.subagentType,
			variant: subagentVariant(input.subagentType),
			traits: withRuntimePolicyTrait(["standalone", IMPORTED_TRAIT], input.ceiling),
			title: input.title ?? null,
			// Same as a live subagent: follow the parent's model rather than freezing it.
			model: FOLLOW_PARENT_MODEL,
			permissionMode: input.parent.permissionMode ?? "default",
			parentNarratorId: input.parent.id,
			// Same relationships a live delegation registers: the parent is source + controller.
			policySourceNarratorId: input.parent.id,
			runtimeRegistrationJson: parseRuntimeRegistration({
				...delegationRegistration(input.parent.id, input.subagentType),
				historyPlacement: { toolUseId: input.historyToolUseId },
			}),
			originToolCallId: input.originToolCallId,
			subagentOriginKind: "tool",
			cwd: input.parent.cwd,
			// Its session's task backend (D31), as for a live subagent.
			taskBackend: input.parent.taskBackend,
			// A resumed child must run where its parent does, not fall back to the server.
			defaultDeviceId: input.parent.defaultDeviceId ?? null,
			// Access is delegated to the root, exactly as for a live subagent.
			aclRootNarratorId: input.parent.aclRootNarratorId ?? input.parent.id,
			ownerUserId: input.parent.ownerUserId,
			visibility: "private",
			writeAudience: "owner",
			inheritMode: "fresh",
			status: "idle",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	backgroundOccupancyStore.refreshNarrator(id);
	return id;
}

/** NarraFork's subagent types are lower-case words; external ones vary. */
function normalizeSubagentType(value: string | undefined): string {
	const raw = (value ?? "").trim().toLowerCase();
	if (!raw || raw === "general-purpose") return "general";
	return raw.replace(/[^a-z0-9_-]+/g, "-").slice(0, 64) || "general";
}

export async function importInterchangeSession(
	input: InterchangeSession,
	options: ImportSessionOptions,
): Promise<ImportSessionResult> {
	if (input.messages.length === 0) {
		throw new AppError("The session contains no messages to import", 422, "SESSION_IMPORT_EMPTY");
	}
	// Every tool_use id is replaced before anything is written: the source's ids are
	// only unique within that one conversation, and NarraFork resolves subagent
	// messages by `parentToolUseId` across narrators (see `withFreshToolUseIds`).
	const session = withFreshToolUseIds(input, () => `toolu_nfimp_${generateId()}`);
	const warnings = new WarningCollector();
	warnings.merge(session.warnings);

	const narrator = await narratorService.create({
		ownerUserId: options.ownerUserId,
		title: importTitle(session, options),
		...(options.cwd || session.cwd ? { cwd: options.cwd || session.cwd } : {}),
		...(options.model ? { model: options.model } : {}),
		extraTraits: [IMPORTED_TRAIT],
	});
	const createdIds = [narrator.id];

	try {
		const subagentToolUseIds = new Set(session.subagents.map((sub) => sub.parentToolUseId));
		const agentCallRowIds = new Map<string, string>();
		const clock = new ImportClock();
		const rows = await buildRows(session.messages, {
			narratorId: narrator.id,
			parentToolUseId: null,
			clock,
			warnings,
			agentCallRowIds,
			subagentToolUseIds,
		});
		await insertRows(narrator.id, rows, options.signal);
		finalizeNarrator(narrator.id, rows);

		let messageCount = rows.length;
		const subagentIds: string[] = [];
		for (const sub of session.subagents) {
			const originToolCallId = agentCallRowIds.get(sub.parentToolUseId);
			if (!originToolCallId) {
				warnings.add("missing_subagent", sub.ref);
				continue;
			}
			const subagentType = normalizeSubagentType(sub.subagentType);
			const subagentId = createImportedSubagent({
				parent: narrator,
				originToolCallId,
				historyToolUseId: sub.parentToolUseId,
				subagentType,
				ceiling: await compileDelegationCeiling(subagentType, {
					outlineSession: narrator.taskBackend === "outline",
				}),
				title: sub.title,
			});
			createdIds.push(subagentId);
			subagentIds.push(subagentId);
			const subRows = await buildRows(sub.messages, {
				narratorId: subagentId,
				parentToolUseId: sub.parentToolUseId,
				clock: new ImportClock(),
				warnings,
				agentCallRowIds: new Map(),
				subagentToolUseIds: new Set(),
			});
			await insertRows(subagentId, subRows, options.signal);
			finalizeNarrator(subagentId, subRows);
			messageCount += subRows.length;
		}

		await bumpNarratorMessageVersion(narrator.id);
		logger.info("Session imported", {
			narratorId: narrator.id,
			format: options.source.format,
			externalId: session.externalId,
			messages: messageCount,
			subagents: subagentIds.length,
		});
		return { narratorId: narrator.id, subagentIds, messageCount, warnings: warnings.list() };
	} catch (error) {
		// Never leave a half-imported narrator behind. `remove` also deletes children.
		await narratorService.remove(narrator.id).catch((cleanupError) => {
			logger.error("Failed to roll back a partial session import", {
				narratorId: narrator.id,
				createdIds,
				error: String(cleanupError),
			});
		});
		throw error;
	}
}
