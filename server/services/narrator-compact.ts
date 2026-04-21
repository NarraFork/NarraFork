import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorContext } from "./narrator-context";
import { narratorService } from "./narrator-service";
import { activeNarrators, compactLocks, pruneLocks } from "./narrator-session-state";

/** Compact operation timeout in milliseconds (5 minutes). */
const COMPACT_TIMEOUT_MS = 5 * 60 * 1000;
const COMPACT_FAILURE_TEXT = "[Compact Failed]";

/**
 * Minimum prunedPercent required before compact is allowed at the compactStart
 * threshold.
 */
export const COMPACT_PRUNE_THRESHOLD_PCT = 80;

/** Check whether a compact operation is already running for the given narrator. */
export function isCompactInProgress(narratorId: string): boolean {
	return compactLocks.has(narratorId);
}

// Re-export locks so narrator-session can access them
export { compactLocks, pruneLocks };

/**
 * Trigger a mid-turn compact: eagerly reserve the lock, find the boundary, and run compact.
 */
export function triggerMidTurnCompact(
	narratorId: string,
	locale: Locale,
	onCompactDone?: () => void,
): void {
	const placeholder = Promise.resolve();
	compactLocks.set(narratorId, placeholder);

	logger.info("Context usage high, triggering compact (mid-turn)", { narratorId });
	narratorService
		.getCompactBoundaryMessage(narratorId)
		.then((boundaryMessageId) => {
			if (!boundaryMessageId) {
				logger.debug("No compact boundary found, aborting mid-turn compact", { narratorId });
				if (compactLocks.get(narratorId) === placeholder) {
					compactLocks.delete(narratorId);
				}
				return;
			}
			if (compactLocks.get(narratorId) === placeholder) {
				compactLocks.delete(narratorId);
			}
			logger.info("Starting runCustomCompact", {
				narratorId,
				boundaryMessageId,
				hasLock: compactLocks.has(narratorId),
			});
			runCustomCompact(narratorId, locale, boundaryMessageId)
				.then(() => {
					onCompactDone?.();
				})
				.catch((err) => {
					logger.error("Auto-compact failed (mid-turn)", {
						narratorId,
						error: String(err),
					});
				});
		})
		.catch(() => {
			if (compactLocks.get(narratorId) === placeholder) {
				compactLocks.delete(narratorId);
			}
		});
}

/**
 * Run custom compact with concurrency protection.
 */
export async function runCustomCompact(
	narratorId: string,
	locale: Locale,
	beforeMessageId?: string,
): Promise<void> {
	const existing = compactLocks.get(narratorId);
	if (existing) {
		logger.info("Compact already in progress, waiting for it to finish", { narratorId });
		await existing.catch(() => {});
		broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
		return;
	}

	let compactTimer: ReturnType<typeof setTimeout>;
	const compactPromise = Promise.race([
		doRunCustomCompact(narratorId, locale, beforeMessageId),
		new Promise<void>((_, reject) => {
			compactTimer = setTimeout(
				() => reject(new Error("Compact operation timed out after 5 minutes")),
				COMPACT_TIMEOUT_MS,
			);
		}),
	]);
	compactLocks.set(narratorId, compactPromise);
	try {
		await compactPromise;
	} catch (err) {
		logger.error("Compact operation failed or timed out", {
			narratorId,
			error: String(err),
		});
		throw err;
	} finally {
		// biome-ignore lint/style/noNonNullAssertion: timer is always assigned before race settles
		clearTimeout(compactTimer!);
		compactLocks.delete(narratorId);
	}
}

async function doRunCustomCompact(
	narratorId: string,
	locale: Locale,
	beforeMessageId?: string,
): Promise<void> {
	logger.info("Starting custom compact", { narratorId, beforeMessageId });

	const messages = beforeMessageId
		? await narratorService.getMessagesBefore(narratorId, beforeMessageId)
		: undefined;

	if (beforeMessageId && (!messages || messages.length === 0)) {
		logger.info("No messages to compact before target", { narratorId, beforeMessageId });
		return;
	}

	const compactingMsg = await narratorService.persistCompactingMessage(narratorId, beforeMessageId);
	broadcastToNarrator(narratorId, { type: "message", narratorId, message: compactingMsg });
	broadcastToNarrator(narratorId, { type: "compacting", narratorId });

	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { pruneBoundaryMessageId: true },
	});
	const pruneBoundaryMessageId = narrator?.pruneBoundaryMessageId ?? null;

	try {
		const { summary, contextPercent } = await narratorContext.generateCompactSummary(
			narratorId,
			locale,
			messages,
			pruneBoundaryMessageId,
		);

		const compactedMsg = await narratorService.finalizeCompactingMessage(
			compactingMsg.id,
			narratorId,
			summary,
			contextPercent,
		);

		if (compactedMsg) {
			broadcastToNarrator(narratorId, { type: "message", narratorId, message: compactedMsg });
		}
		await narratorService.clearPruneBoundary(narratorId);

		const transitioned = await narratorService.compareAndSetStatus(narratorId, "done", "idle");
		if (!transitioned) {
			logger.info("Skipping idle transition after compact — narrator already moved on", {
				narratorId,
			});
		}

		logger.info("Custom compact completed", { narratorId, summaryLength: summary.length });
		broadcastToNarrator(narratorId, {
			type: "compact_done",
			narratorId,
			contextPercentAfter: contextPercent,
		});
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.error("Custom compact failed after retries", {
			narratorId,
			messageId: compactingMsg.id,
			error: errorMsg,
		});

		const failedSummary = `${COMPACT_FAILURE_TEXT}\n${errorMsg}`;
		const failedMsg = await narratorService
			.finalizeCompactingMessage(compactingMsg.id, narratorId, failedSummary, undefined, {
				status: "failed",
				error: errorMsg,
			})
			.catch((e) => {
				logger.error("Failed to finalize failed compact marker", {
					narratorId,
					messageId: compactingMsg.id,
					error: String(e),
				});
				return null;
			});

		if (failedMsg) {
			broadcastToNarrator(narratorId, { type: "message", narratorId, message: failedMsg });
		}

		await narratorService.clearPruneBoundary(narratorId).catch(() => {});
		await narratorService.updateStatus(narratorId, "error", `Compact failed: ${errorMsg}`);
		const active = activeNarrators.get(narratorId);
		if (active?.alive) {
			active.abortController.abort();
		}
		broadcastToNarrator(narratorId, {
			type: "compact_failed",
			narratorId,
			messageId: compactingMsg.id,
		});
		throw err;
	}
}

// === Segment compact ===

export async function runSegmentCompact(
	narratorId: string,
	locale: Locale,
	messageIds: string[],
): Promise<void> {
	const existing = compactLocks.get(narratorId);
	if (existing) {
		await existing.catch(() => {});
		broadcastToNarrator(narratorId, { type: "compact_done", narratorId, isSegment: true });
		return;
	}

	let timer: ReturnType<typeof setTimeout>;
	const promise = Promise.race([
		doRunSegmentCompact(narratorId, locale, messageIds),
		new Promise<void>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Segment compact timed out after 5 minutes")),
				COMPACT_TIMEOUT_MS,
			);
		}),
	]);
	compactLocks.set(narratorId, promise);
	try {
		await promise;
	} catch (err) {
		logger.error("Segment compact failed or timed out", {
			narratorId,
			error: String(err),
		});
		throw err;
	} finally {
		// biome-ignore lint/style/noNonNullAssertion: timer is always assigned before race settles
		clearTimeout(timer!);
		compactLocks.delete(narratorId);
	}
}

async function doRunSegmentCompact(
	narratorId: string,
	locale: Locale,
	messageIds: string[],
): Promise<void> {
	logger.info("Starting segment compact", { narratorId, messageCount: messageIds.length });

	const { message: markerMsg, hiddenMessageIds } =
		await narratorService.persistSegmentCompactMarker(narratorId, messageIds);
	broadcastToNarrator(narratorId, { type: "message", narratorId, message: markerMsg });
	broadcastToNarrator(narratorId, {
		type: "segment_compact_hide",
		narratorId,
		hiddenMessageIds,
	});
	broadcastToNarrator(narratorId, { type: "compacting", narratorId });

	try {
		const messages = await narratorService.getMessagesForSegmentCompact(narratorId, messageIds);

		if (messages.length === 0) {
			await narratorService.deleteSegmentCompact(narratorId, markerMsg.id);
			broadcastToNarrator(narratorId, { type: "compact_done", narratorId, isSegment: true });
			return;
		}

		const { summary, contextPercent } = await narratorContext.generateCompactSummary(
			narratorId,
			locale,
			messages,
			null,
		);

		const finalizedMsg = await narratorService.finalizeSegmentCompact(
			markerMsg.id,
			narratorId,
			summary,
			contextPercent,
		);

		if (finalizedMsg) {
			broadcastToNarrator(narratorId, { type: "message", narratorId, message: finalizedMsg });
		}

		logger.info("Segment compact completed", {
			narratorId,
			messageCount: messageIds.length,
			summaryLength: summary.length,
		});
		broadcastToNarrator(narratorId, {
			type: "compact_done",
			narratorId,
			isSegment: true,
		});
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.error("Segment compact failed", {
			narratorId,
			messageId: markerMsg.id,
			error: errorMsg,
		});

		const failedSummary = `${COMPACT_FAILURE_TEXT}\n${errorMsg}`;
		const failedMsg = await narratorService
			.finalizeSegmentCompact(markerMsg.id, narratorId, failedSummary, undefined, {
				status: "failed",
				error: errorMsg,
			})
			.catch((e) => {
				logger.error("Failed to finalize failed segment compact marker", {
					narratorId,
					messageId: markerMsg.id,
					error: String(e),
				});
				return null;
			});

		if (failedMsg) {
			broadcastToNarrator(narratorId, { type: "message", narratorId, message: failedMsg });
		}

		broadcastToNarrator(narratorId, {
			type: "compact_failed",
			narratorId,
			messageId: markerMsg.id,
		});
		throw err;
	}
}

// === shouldFinalizeAbortBeforeRecovery ===

export function shouldFinalizeAbortBeforeRecovery(
	aborted: boolean | undefined,
	signalAborted: boolean,
	planApprovedContinue?: "continue" | "compact",
): boolean {
	return (aborted || signalAborted) && planApprovedContinue == null;
}

// === pruneToolCalls ===

/** Tool names whose tool_use + tool_result pairs should survive pruning. */
const PRUNE_PROTECTED_TOOLS = new Set(["ExitPlanMode", "Skill"]);

export function pruneToolCalls(
	dbMessages: import("../lib/agent/provider").DbMessage[],
	boundaryMessageId: string,
): void {
	const boundaryIdx = dbMessages.findIndex((m) => m.id === boundaryMessageId);
	if (boundaryIdx < 0) return;

	const pruneIds = new Set(dbMessages.slice(0, boundaryIdx + 1).map((m) => m.id));

	for (const msg of dbMessages) {
		if (!pruneIds.has(msg.id)) continue;

		const keptToolCalls = msg.toolCalls?.length
			? msg.toolCalls.filter((tc) => PRUNE_PROTECTED_TOOLS.has(tc.toolName))
			: [];
		msg.toolCalls = keptToolCalls.length > 0 ? keptToolCalls : [];

		let hasProtectedToolContext = keptToolCalls.length > 0;
		if (Array.isArray(msg.contentJson)) {
			let mutated = false;
			const keptToolUseIds = new Set(
				keptToolCalls
					.map((tc) => tc.toolUseId)
					.filter((toolUseId): toolUseId is string => typeof toolUseId === "string"),
			);
			const blocks = msg.contentJson.filter((block) => {
				if (!block || typeof block !== "object") return true;
				const toolBlock = block as { type?: string; id?: string; name?: string };
				if (toolBlock.type !== "tool_use") return true;
				const keep =
					(typeof toolBlock.id === "string" && keptToolUseIds.has(toolBlock.id)) ||
					(typeof toolBlock.name === "string" && PRUNE_PROTECTED_TOOLS.has(toolBlock.name));
				if (keep) hasProtectedToolContext = true;
				if (!keep) mutated = true;
				return keep;
			});
			if (mutated) {
				msg.contentJson = blocks;
			}

			if (!hasProtectedToolContext) {
				let reasoningMutated = false;
				const prunedBlocks = msg.contentJson as Array<{ type: string; providerMetadata?: unknown }>;
				for (const block of prunedBlocks) {
					if (block.type === "reasoning" && block.providerMetadata) {
						block.providerMetadata = undefined;
						reasoningMutated = true;
					}
				}
				if (reasoningMutated) {
					msg.contentJson = [...prunedBlocks];
				}
			}
		}
	}
}

// === computeLineDiff ===

/**
 * Compute a simple line-level unified diff between two strings.
 * Returns a compact diff string showing only changed lines with context,
 * or null if the texts are identical.
 */
export function computeLineDiff(oldText: string, newText: string): string | null {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const CONTEXT = 2;

	const m = oldLines.length;
	const n = newLines.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			if (oldLines[i] === newLines[j]) {
				dp[i][j] = dp[i + 1][j + 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
	}

	const diffLines: Array<{ type: "keep" | "del" | "add"; text: string }> = [];
	let i = 0;
	let j = 0;
	while (i < m || j < n) {
		if (i < m && j < n && oldLines[i] === newLines[j]) {
			diffLines.push({ type: "keep", text: oldLines[i] });
			i++;
			j++;
		} else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
			diffLines.push({ type: "add", text: newLines[j] });
			j++;
		} else {
			diffLines.push({ type: "del", text: oldLines[i] });
			i++;
		}
	}

	if (!diffLines.some((l) => l.type !== "keep")) return null;

	const changeIndices: number[] = [];
	for (let k = 0; k < diffLines.length; k++) {
		if (diffLines[k].type !== "keep") changeIndices.push(k);
	}

	const hunks: string[] = [];
	let hunkStart = Math.max(0, changeIndices[0] - CONTEXT);
	let hunkEnd = Math.min(diffLines.length - 1, changeIndices[0] + CONTEXT);

	for (let ci = 1; ci < changeIndices.length; ci++) {
		const nextStart = Math.max(0, changeIndices[ci] - CONTEXT);
		const nextEnd = Math.min(diffLines.length - 1, changeIndices[ci] + CONTEXT);
		if (nextStart <= hunkEnd + 1) {
			hunkEnd = nextEnd;
		} else {
			const lines: string[] = [];
			for (let h = hunkStart; h <= hunkEnd; h++) {
				const d = diffLines[h];
				if (d.type === "keep") lines.push(`  ${d.text}`);
				else if (d.type === "del") lines.push(`- ${d.text}`);
				else lines.push(`+ ${d.text}`);
			}
			hunks.push(lines.join("\n"));
			hunkStart = nextStart;
			hunkEnd = nextEnd;
		}
	}
	const lines: string[] = [];
	for (let h = hunkStart; h <= hunkEnd; h++) {
		const d = diffLines[h];
		if (d.type === "keep") lines.push(`  ${d.text}`);
		else if (d.type === "del") lines.push(`- ${d.text}`);
		else lines.push(`+ ${d.text}`);
	}
	hunks.push(lines.join("\n"));

	return hunks.join("\n...\n");
}

/**
 * Run a plan compact: persist the plan text as a compact message and clear prune boundary.
 */
export async function runPlanCompact(narratorId: string, planText: string): Promise<void> {
	logger.info("Starting plan compact", { narratorId, planLength: planText.length });

	// persistPlanMessage atomically inserts the message, sets isCompact=1,
	// and updates narrator's contextSummary + clears apiConversationId.
	const compactMsg = await narratorService.persistPlanMessage(narratorId, planText);
	if (compactMsg) {
		broadcastToNarrator(narratorId, { type: "message", narratorId, message: compactMsg });
	}

	await narratorService.clearPruneBoundary(narratorId);
	logger.info("Plan compact completed", { narratorId, summaryLength: planText.length });
}
