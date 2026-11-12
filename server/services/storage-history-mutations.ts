/** Atomic, non-interrupting retention writes. No refs or execution receipts are deleted. */

import { redactToolPayloadElement } from "@shared/narrator-blocks/retention";
import {
	clearedToolOutput,
	historyClearedText,
	isHistoryClearedContent,
	retainsStorageReplayInput,
	type StorageHistoryCandidate,
	type StorageHistoryMutationResult,
	type StorageRetentionTarget,
} from "@shared/storage-retention";
import { eq } from "drizzle-orm";
import * as database from "../db";
import { getDbPath } from "../db/connection";
import { removeBlockIndexText } from "../db/fts";
import { narratorMessages } from "../db/schema";
import { measureMessageCharacters, queueContextCharacterRefresh } from "../lib/context-characters";
import { runEphemeralReadTask, runReadTask, WorkersUnavailableError } from "../lib/db-worker/pool";
import type { StorageHistoryBodyParams, StorageHistoryBodyResult } from "../lib/db-worker/protocol";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { CLEARED_TOOL_OUTPUT_SQL, isEnvelopeHistoryCleared } from "./narrator-block-sync";
import { writeEnvelopeBody } from "./narrator-body-writes";
import { withIdleNarratorCleanupAdmission } from "./narrator-session-state";
import { toolInputStreamSource } from "./tool-input-stream-source";

const RETAINED = { cleared: false, retained: true } as const;
const UNCHANGED = { cleared: false, retained: false } as const;
const MAX_HOLDERS = 512;
const MAX_BLOCKS = 1024;
const MAX_BYTES = 4 * 1024 * 1024;
const warnings = hotSafe(
	"storage-history:mutation-warnings",
	() => new Map<string, { at: number; suppressed: number }>(),
);
function warn(kind: string, message: string, fields: Record<string, unknown>): void {
	const now = Date.now();
	const previous = warnings.get(kind);
	if (previous && now - previous.at < 60_000) {
		previous.suppressed++;
		return;
	}
	warnings.set(kind, { at: now, suppressed: 0 });
	logger.warn(message, { ...fields, suppressed: previous?.suppressed ?? 0 });
}

type Raw = Record<string, unknown>;
function record(value: unknown): Raw | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Raw)
		: null;
}

function blocked(ids: string[]): boolean {
	const sqlite = database.sqlite;
	for (const id of ids) {
		if (
			sqlite
				.query(`SELECT 1 FROM narrators WHERE id = ? AND
			(status IN ('working', 'waiting') OR instr(substatus, 'compacting') > 0)`)
				.get(id)
		)
			return true;
	}
	return false;
}

/** O(1) fence over writes made here and by any other connection while a worker prepares. */
function writeFence(): string {
	const own = database.sqlite
		.query<{ changes: number }, []>("SELECT total_changes() AS changes")
		.get();
	const external = database.sqlite.query<{ data_version: number }, []>("PRAGMA data_version").get();
	return `${own?.changes}:${external?.data_version}`;
}

/** Keep control/epoch identity, but erase summaries and diagnostic copies of provider text. */
function compactTombstone(first: Raw, at: string): Raw {
	const clean: Raw = { historyClearVersion: 1, historyClearedAt: at };
	for (const [key, value] of Object.entries(first)) {
		if (["summary", "text", "output", "thinking", "error", "translatedText"].includes(key))
			continue;
		if (key === "attempts" && Array.isArray(value)) {
			clean.attempts = value.map((attempt) => {
				const row = record(attempt);
				if (!row) return {};
				return Object.fromEntries(
					Object.entries(row).filter(
						([name]) =>
							!["summary", "text", "output", "thinking", "error", "translatedText"].includes(name),
					),
				);
			});
		} else clean[key] = value;
	}
	return { ...clean, summary: historyClearedText(at).text };
}

function clearToolElement(value: unknown, toolUseId: string): unknown {
	return redactToolPayloadElement(value, new Set([toolUseId]));
}

function invalidate(ids: string[], clearedAt: string): void {
	const statement = database.sqlite.prepare(`UPDATE narrators SET
		message_version = message_version + 1, model_history_revision = model_history_revision + 1,
		api_conversation_id = NULL, context_usage_snapshot_json = NULL,
		context_char_cache_json = NULL, updated_at = ? WHERE id = ?`);
	for (const id of ids) statement.run(clearedAt, id);
}

/** A worker snapshot is always rechecked inside the short write transaction. */
export async function clearStorageHistoryCandidate(input: {
	target: StorageRetentionTarget;
	candidate: StorageHistoryCandidate;
	cutoffAt: string;
	clearedAt: string;
	signal?: AbortSignal;
	/** Synchronous live policy/cancellation fence; checked again after worker awaits. */
	canClear?: () => boolean;
}): Promise<StorageHistoryMutationResult> {
	input.signal?.throwIfAborted();
	if (input.canClear?.() === false) return RETAINED;
	if (database.activeDatabaseBackend !== "sqlite") return RETAINED;
	const { target, candidate, clearedAt, cutoffAt } = input;
	const messageId = target === "messageHistory" ? candidate.id : candidate.messageId;
	if (!messageId) return UNCHANGED;
	if (target === "messageHistory" && isEnvelopeHistoryCleared(messageId)) return UNCHANGED;
	if (
		target === "toolCallPayloads" &&
		database.sqlite
			.query(`SELECT 1 FROM narrator_tool_calls
		WHERE id = ? AND ${CLEARED_TOOL_OUTPUT_SQL}`)
			.get(candidate.id)
	)
		return UNCHANGED;
	const expectedFence = writeFence();
	const params: StorageHistoryBodyParams = {
		kind: "storageHistoryBody",
		messageId,
		maxBytes: MAX_BYTES,
		maxBlocks: MAX_BLOCKS,
	};
	// No inline fallback: a disabled read pool must never turn retention into a main-thread scan.
	let body: StorageHistoryBodyResult | null;
	try {
		const path = database.sqlite.filename || getDbPath();
		const options = { timeoutMs: 15_000, signal: input.signal };
		try {
			body = await runReadTask<StorageHistoryBodyResult | null>(path, params, options);
		} catch (error) {
			if (!(error instanceof WorkersUnavailableError) || error.reason === "pool_shutdown")
				throw error;
			body = await runEphemeralReadTask<StorageHistoryBodyResult | null>(path, params, options);
		}
	} catch (error) {
		input.signal?.throwIfAborted();
		warn("prepare", "History retention body preparation deferred", {
			messageId,
			error: String(error).slice(0, 500),
		});
		return RETAINED;
	}
	if (!body) {
		warn("budget", "History retention body exceeded preparation budget", {
			messageId,
			maxBytes: MAX_BYTES,
			maxBlocks: MAX_BLOCKS,
		});
		return RETAINED;
	}
	input.signal?.throwIfAborted();
	if (body.blocked || input.canClear?.() === false || writeFence() !== expectedFence)
		return RETAINED;
	const ids = body.holderIds;
	if (!ids || ids.length > MAX_HOLDERS || blocked(ids)) return RETAINED;
	const started = performance.now();
	let clearedAttempt: number | null = null;
	const result = await withIdleNarratorCleanupAdmission(ids, async () => {
		input.signal?.throwIfAborted();
		if (input.canClear?.() === false || writeFence() !== expectedFence) return RETAINED;
		return database.db.transaction(
			(tx): StorageHistoryMutationResult => {
				if (input.canClear?.() === false || writeFence() !== expectedFence) return RETAINED;
				// The global write fence makes the worker's bounded holder/protection
				// snapshot current; no holder/history scan belongs on the main thread.
				const currentIds = ids;
				if (blocked(currentIds)) return RETAINED;
				const message = database.sqlite
					.query<
						{
							revision: number;
							createdAt: string;
							role: string;
							format: number;
							rowsOnly: number;
						},
						[string]
					>(`SELECT body_revision AS revision, created_at AS createdAt, role,
				body_format AS format, body_rows_only AS rowsOnly FROM narrator_messages WHERE id = ?`)
					.get(messageId);
				if (!message || message.revision !== body.revision) return RETAINED;
				if (target === "messageHistory") {
					if (message.revision !== candidate.revision || message.createdAt >= cutoffAt)
						return RETAINED;
					if (isHistoryClearedContent(body.content)) return UNCHANGED;
					const first = record(body.content[0]);
					const compact = first?.type === "compact" || first?.type === "segment_compact";
					if (
						compact &&
						(first.status === "compacting" ||
							first.status === "running" ||
							(Array.isArray(first.attempts) &&
								first.attempts.some((attempt) => record(attempt)?.status === "running")))
					)
						return RETAINED;
					const content = compact
						? [compactTombstone(first, clearedAt)]
						: [historyClearedText(clearedAt)];
					// Drop original rows so no original_payload, credentials or state-only translation
					// can survive block matching. Ledger receipts remain (their block FK becomes null).
					if (input.canClear?.() === false) return RETAINED;
					database.sqlite.query("DELETE FROM narrator_blocks WHERE message_id = ?").run(messageId);
					writeEnvelopeBody(tx, messageId, content, {
						allowHistoryRewrite: true,
						retentionClear: true,
						set: {
							contentText: historyClearedText(clearedAt).text,
							originalContentJson: null,
							composerDocument: null,
							commandText: null,
							providerResponseId: null,
							messageUuid: null,
							contextCharsJson: measureMessageCharacters(
								message.role,
								content,
								historyClearedText(clearedAt).text,
							),
						},
					});
					if (compact && first.type === "compact") {
						// Resolve the latest *effective* boundary, including refs the lazy holder
						// still borrows. A newer local compact must keep its unrelated summary.
						const clearSummary =
							database.sqlite.prepare(`WITH RECURSIVE lenders(id, ceiling, depth) AS (
							SELECT ?, 9223372036854775807, 0 UNION ALL
							SELECT n.refs_inherited_from, min(l.ceiling, n.refs_backfill_cursor), l.depth + 1
							FROM narrators n JOIN lenders l ON n.id = l.id
							WHERE n.refs_inherited_from IS NOT NULL AND n.refs_backfill_cursor IS NOT NULL AND l.depth < ${MAX_HOLDERS}
						), boundaries AS (SELECT
							(SELECT r.message_id FROM narrator_message_refs r WHERE r.narrator_id = l.id
							 AND r.seq < l.ceiling AND r.is_compact = 1 ORDER BY r.seq DESC LIMIT 1) AS message_id,
							(SELECT r.seq FROM narrator_message_refs r WHERE r.narrator_id = l.id
							 AND r.seq < l.ceiling AND r.is_compact = 1 ORDER BY r.seq DESC LIMIT 1) AS seq
							FROM lenders l)
						UPDATE narrators SET context_summary = ?, context_summary_chars = ? WHERE id = ? AND
							(SELECT message_id FROM boundaries ORDER BY seq DESC LIMIT 1) = ?`);
						for (const id of currentIds)
							clearSummary.run(
								id,
								historyClearedText(clearedAt).text,
								historyClearedText(clearedAt).text.length,
								id,
								messageId,
							);
					}
				} else {
					const call = database.sqlite
						.query<
							{
								revision: number;
								createdAt: string;
								toolUseId: string;
								toolName: string;
								attempt: number;
								status: string;
								checkpoint: number;
							},
							[string, string]
						>(`SELECT model_revision AS revision, created_at AS createdAt,
					tool_use_id AS toolUseId, tool_name AS toolName, execution_attempt AS attempt, status, is_file_history_checkpoint AS checkpoint
					FROM narrator_tool_calls WHERE id = ? AND message_id = ?`)
						.get(candidate.id, messageId);
					if (
						!call ||
						call.revision !== candidate.revision ||
						call.createdAt >= cutoffAt ||
						call.checkpoint ||
						!["success", "fail"].includes(call.status)
					)
						return RETAINED;
					const adopted = database.sqlite
						.query<{ id: string }, [string, string]>(`SELECT id FROM narrator_tool_calls
					WHERE message_id = ? AND tool_use_id = ? AND is_internal = 0
					ORDER BY execution_attempt DESC, created_at DESC, id DESC LIMIT 1`)
						.get(messageId, call.toolUseId);
					if (
						adopted?.id === candidate.id &&
						message.format === 2 &&
						!body.blocks.length &&
						!isEnvelopeHistoryCleared(messageId)
					)
						return RETAINED;
					if (input.canClear?.() === false) return RETAINED;
					clearedAttempt = call.attempt;
					const output = clearedToolOutput(clearedAt);
					database.sqlite
						.query(`UPDATE narrator_tool_calls SET input_json = CASE WHEN ? THEN input_json ELSE NULL END, output_json = ?,
					input_chars = 0, output_chars = ?, error_message = NULL WHERE id = ?`)
						.run(
							retainsStorageReplayInput(call.toolName) ? 1 : 0,
							JSON.stringify(output),
							output._text.length,
							candidate.id,
						);
					if (adopted?.id === candidate.id && !isHistoryClearedContent(body.content)) {
						const content = body.content.map((raw) => clearToolElement(raw, call.toolUseId));
						// Do not call whole-envelope sync: it would read unrelated tool outputs on
						// the main thread. Only this adopted block's payload was prepared by the worker.
						tx.update(narratorMessages)
							.set({
								bodyRevision: message.revision + 1,
								contentJson: message.rowsOnly ? [] : content,
								originalContentJson:
									body.originalContent?.map((element) =>
										clearToolElement(element, call.toolUseId),
									) ?? null,
								contextCharsJson: measureMessageCharacters(message.role, content, body.contentText),
							})
							.where(eq(narratorMessages.id, messageId))
							.run();
						const revision = database.sqlite
							.query<{ revision: number }, [string]>(
								"SELECT model_revision AS revision FROM narrator_tool_calls WHERE id = ?",
							)
							.get(candidate.id)?.revision;
						for (const block of body.blocks) {
							const payload = record(block.payload);
							if (!payload || !Array.isArray(payload.raw)) continue;
							const raw = payload.raw.map((element: unknown) =>
								clearToolElement(element, call.toolUseId),
							);
							if (
								raw.every(
									(element: unknown, index: number) =>
										element === (payload.raw as unknown[])[index],
								)
							)
								continue;
							const encoded = JSON.stringify({ raw });
							database.sqlite
								.query(`UPDATE narrator_blocks SET payload = ?, state = NULL,
							provider_meta = NULL, original_payload = NULL, model_chars = 0, byte_size = ?,
							revision = revision + 1, ledger_revision = ? WHERE id = ? AND revision = ?`)
								.run(
									encoded,
									Buffer.byteLength(encoded),
									`${candidate.id}:${revision}`,
									block.id,
									block.revision,
								);
							removeBlockIndexText(database.sqlite, block.id);
							database.sqlite
								.query("DELETE FROM narrator_block_index_queue WHERE block_id = ?")
								.run(block.id);
							database.sqlite
								.query("DELETE FROM narrator_block_assets WHERE block_id = ?")
								.run(block.id);
						}
						// A content-column hash is intentionally unknown until ordinary sync catches up.
						database.sqlite
							.query(`UPDATE narrator_messages SET blocks_content_hash = NULL,
						body_bytes = (SELECT coalesce(sum(byte_size), 0) FROM narrator_blocks WHERE message_id = ?)
						WHERE id = ?`)
							.run(messageId, messageId);
					}
					// We have updated the adopted columns ourselves, so no queued stale ledger
					// sync should read unrelated output copies before the next genuine write.
					database.sqlite
						.query("DELETE FROM narrator_block_sync_queue WHERE message_id = ?")
						.run(messageId);
				}
				invalidate(currentIds, clearedAt);
				return { cleared: true, retained: false };
			},
			{ behavior: "immediate" },
		);
	});
	if (performance.now() - started > 50)
		warn("slow", "Slow history retention mutation", {
			target,
			messageId,
			elapsedMs: Math.round(performance.now() - started),
		});
	if (result?.cleared && target === "toolCallPayloads") {
		const call = clearedAttempt === null ? null : { attempt: clearedAttempt };
		if (call) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				// Revocation happens synchronously; stalled filesystem deletion may finish
				// later, but must not hold the retention job forever.
				const removal = toolInputStreamSource.clearRetainedToolPayload({
					toolCallId: candidate.id,
					messageId,
					executionAttempt: call.attempt,
				});
				await Promise.race([
					removal,
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error("Retained input spill removal timed out")),
							10_000,
						);
					}),
				]);
			} catch (error) {
				warn("spill", "Retained tool input spill removal failed", {
					toolCallId: candidate.id,
					error: String(error).slice(0, 500),
				});
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
	}
	if (result?.cleared)
		for (const id of ids) {
			queueContextCharacterRefresh(id, messageId);
			broadcastToNarrator(id, { type: "full_reload", narratorId: id });
		}
	return result ?? RETAINED;
}
