/**
 * Extract a subagent session into an independent primary narrator.
 *
 * This is NOT the removed `forkSubagent` (clone another delegated worker) and NOT
 * ordinary narrator fork (which refuses subagent sources). The product intent is:
 *
 *   freeze this exploration's context into a session the human owns, under the
 *   full primary control plane (AskUserQuestion, Agent, plan mode, …).
 *
 * Fixed v1 semantics (see plan):
 * - History is a materialized copy: new message rows + own refs, `parentToolUseId` cleared.
 * - Source subagent is never mutated; parent tool-call binding is untouched.
 * - `parentNarratorId = null` so parent/source deletion cannot cascade onto the extract.
 * - `narrator_tool_calls` are intentionally not copied (tool_use blocks remain in contentJson).
 * - `aclRootNarratorId = null` — primary narrators are judged on their own columns.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { narratorMessageRefs, narratorMessages, narrators } from "../db/schema";
import { normalizeBooleanOverride } from "../lib/boolean-override";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { legacyFastModeMirror } from "../lib/fast-mode";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { isSubagentVariant, parseTraits } from "../lib/narrator-utils";
import { resolveInitialRelaxedPlan } from "../lib/permission-modes";
import type { Locale } from "../lib/prompt-i18n";
import { FOLLOW_DEFAULT_MODEL } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import {
	claimNextRefSeq,
	initializeRefSeqFloor,
	withSeqFloorRaiseScope,
} from "./narrator-refs/seq-store";

/** Soft cap: above this, full materialization falls back to compressed context. */
export const EXTRACT_FULL_MAX_MESSAGES = 2000;

export interface ExtractSubagentToPrimaryOpts {
	title?: string;
	/** Defaults to `"full"`. Overridden to `"compressed"` when history exceeds the soft cap. */
	inheritMode?: "full" | "compressed";
	locale?: Locale;
	/** Test seam: lower the full-copy soft cap. */
	maxFullMessages?: number;
}

type Visibility = "private" | "project" | "public";
type WriteAudience = "owner" | "project" | "public";

/**
 * Resolve visibility/writeAudience for the extract.
 * Prefer the parent primary's audiences; clamp standalone extracts away from
 * "project" visibility (no chapterId means project resolution has nothing to
 * read). Missing parent → private/owner.
 */
async function resolveExtractAudiences(source: {
	parentNarratorId: string | null;
}): Promise<{ visibility: Visibility; writeAudience: WriteAudience }> {
	let visibility: Visibility = "private";
	let writeAudience: WriteAudience = "owner";
	if (source.parentNarratorId) {
		const parent = await db.query.narrators.findFirst({
			where: eq(narrators.id, source.parentNarratorId),
			columns: { visibility: true, writeAudience: true },
		});
		if (parent?.visibility) visibility = parent.visibility as Visibility;
		if (parent?.writeAudience) writeAudience = parent.writeAudience as WriteAudience;
	}
	// Extract is always standalone in v1; project-visible without a chapter is a trap.
	if (visibility === "project") visibility = "private";
	if (writeAudience === "project") writeAudience = "owner";
	return { visibility, writeAudience };
}

function defaultExtractTitle(
	sourceTitle: string | null,
	subagentType: string | null,
	locale: Locale,
) {
	const base = sourceTitle?.trim() || subagentType || "Subagent";
	return locale === "zh-CN" ? `${base} — 主会话` : `${base} — primary`;
}

export async function extractSubagentToPrimary(
	sourceId: string,
	opts?: ExtractSubagentToPrimaryOpts,
) {
	const source = await db.query.narrators.findFirst({
		where: eq(narrators.id, sourceId),
	});

	if (!source) {
		throw new ValidationError("Subagent not found");
	}
	if (!isSubagentVariant(source.variant)) {
		throw new ValidationError("Only subagent narrators can be extracted to a primary narrator");
	}
	if (source.status === "archived") {
		throw new ValidationError("Archived subagents cannot be extracted");
	}

	const locale = (opts?.locale ?? "en") as Locale;
	const subagentType = source.subagentType ?? null;
	const maxFull = opts?.maxFullMessages ?? EXTRACT_FULL_MAX_MESSAGES;

	const sourceRefs = await db
		.select({
			messageId: narratorMessageRefs.messageId,
			seq: narratorMessageRefs.seq,
		})
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.narratorId, sourceId))
		.orderBy(asc(narratorMessageRefs.seq));

	let inheritMode = opts?.inheritMode ?? "full";
	if (inheritMode === "full" && sourceRefs.length > maxFull) {
		logger.warn("Extract full history exceeds soft cap; falling back to compressed", {
			sourceId,
			messageCount: sourceRefs.length,
			maxFull,
		});
		inheritMode = "compressed";
	}

	let contextSummary: string | null = null;
	if (inheritMode === "compressed") {
		const { narratorContext } = await import("./narrator-context");
		contextSummary = await narratorContext.generateContextSummary(sourceId, locale);
	}

	// Load source messages in ref-seq order for full materialization.
	// Batched by id — never per-ref findFirst (N+1 on soft-cap histories).
	const orderedSourceMessages: Array<typeof narratorMessages.$inferSelect> = [];
	if (inheritMode === "full" && sourceRefs.length > 0) {
		const CHUNK = 500;
		const byId = new Map<string, typeof narratorMessages.$inferSelect>();
		for (let i = 0; i < sourceRefs.length; i += CHUNK) {
			const chunk = sourceRefs.slice(i, i + CHUNK).map((row) => row.messageId);
			const rows = await db
				.select()
				.from(narratorMessages)
				.where(inArray(narratorMessages.id, chunk));
			for (const msg of rows) byId.set(msg.id, msg);
		}
		for (const row of sourceRefs) {
			const msg = byId.get(row.messageId);
			if (msg) orderedSourceMessages.push(msg);
		}
	}

	const audiences = await resolveExtractAudiences(source);
	const now = new Date().toISOString();
	const id = generateId();
	const title = opts?.title?.trim() || defaultExtractTitle(source.title, subagentType, locale);

	const newNarrator = withSeqFloorRaiseScope(() =>
		db.transaction((tx) => {
			const created = tx
				.insert(narrators)
				.values({
					id,
					chapterId: null,
					type: "primary",
					variant: "primary",
					subagentType: null,
					traits: ["standalone", "extracted-from-subagent"],
					model: source.model ?? FOLLOW_DEFAULT_MODEL,
					// Never inherit the subagent system prompt — primary control plane.
					systemPrompt: null,
					// Do not inherit explore/plan readOnly lockdown.
					permissionMode: "default",
					reasoningEffort: source.reasoningEffort ?? null,
					fastModeOverride: normalizeBooleanOverride(source.fastModeOverride),
					fastMode: legacyFastModeMirror(source.fastModeOverride),
					relaxedPlan: resolveInitialRelaxedPlan({
						permissionMode: "default",
						explicit: source.relaxedPlan ?? undefined,
						defaultRelaxedPlan: false,
					}),
					planReflectionAutoApproveOverride: source.planReflectionAutoApproveOverride ?? "inherit",
					dangerReflectionOverride: source.dangerReflectionOverride ?? "inherit",
					autoContinuationOverride: source.autoContinuationOverride ?? "inherit",
					behaviorFenceIntervalOverride: source.behaviorFenceIntervalOverride ?? null,
					behaviorFenceAttachOverride: source.behaviorFenceAttachOverride ?? "inherit",
					// Independence: never join the source/parent deletion cascade.
					parentNarratorId: null,
					refsInheritedFrom: null,
					refsBackfillCursor: null,
					originToolCallId: null,
					subagentOriginKind: null,
					// Primary convention: judged on its own columns, not a delegation root.
					aclRootNarratorId: null,
					ownerUserId: source.ownerUserId,
					visibility: audiences.visibility,
					writeAudience: audiences.writeAudience,
					inheritMode,
					apiConversationId: null,
					contextSummary,
					status: "idle",
					title,
					cwd: source.cwd ?? null,
					defaultDeviceId: source.defaultDeviceId ?? null,
					createdAt: now,
					updatedAt: now,
				})
				.returning()
				.get();

			if (inheritMode === "full") {
				for (const msg of orderedSourceMessages) {
					const newMessageId = generateId();
					tx.insert(narratorMessages)
						.values({
							id: newMessageId,
							narratorId: id,
							// Detach from the parent Agent tool-call tree so primary history
							// builders that filter top-level messages keep this exploration.
							parentToolUseId: null,
							// New identity: never reuse the source SDK uuid.
							messageUuid: null,
							role: msg.role,
							contentJson: msg.contentJson,
							contentText: msg.contentText,
							tokensIn: msg.tokensIn,
							costUsd: msg.costUsd,
							costStatus: msg.costStatus,
							costMissingFields: msg.costMissingFields,
							turnUsageJson: msg.turnUsageJson,
							provider: msg.provider,
							credentialId: msg.credentialId,
							model: msg.model,
							outputTokens: msg.outputTokens,
							cachedInputTokens: msg.cachedInputTokens,
							cacheCreationInputTokens: msg.cacheCreationInputTokens,
							cacheCreation5mTokens: msg.cacheCreation5mTokens,
							cacheCreation1hTokens: msg.cacheCreation1hTokens,
							reasoningTokens: msg.reasoningTokens,
							ttftMs: msg.ttftMs,
							durationMs: msg.durationMs,
							contextPercent: msg.contextPercent,
							meterUsage: msg.meterUsage,
							meterUnit: msg.meterUnit,
							commitSha: msg.commitSha,
							treeHashAfter: msg.treeHashAfter,
							snapshotCommitSha: msg.snapshotCommitSha,
							commandText: msg.commandText,
							createdBy: msg.createdBy,
							origin: msg.origin,
							originLabel: msg.originLabel,
							editedAt: msg.editedAt,
							editedBy: msg.editedBy,
							originalContentJson: msg.originalContentJson,
							createdAt: msg.createdAt,
						})
						.run();

					const seq = claimNextRefSeq(tx, id);
					tx.insert(narratorMessageRefs)
						.values({
							id: generateId(),
							narratorId: id,
							messageId: newMessageId,
							seq,
							isCompact: 0,
							segmentCompactId: null,
						})
						.run();
				}
			} else if (contextSummary) {
				const compactMsgId = generateId();
				tx.insert(narratorMessages)
					.values({
						id: compactMsgId,
						narratorId: id,
						parentToolUseId: null,
						role: "system",
						contentJson: [{ type: "compact", status: "compacted", summary: contextSummary }],
						contentText:
							locale === "zh-CN"
								? `[来自子代理的压缩上下文：${source.title ?? sourceId}]`
								: `[Compressed context extracted from subagent ${source.title ?? sourceId}]`,
						origin: "system",
						originLabel: `extractFromSubagent:${sourceId}`,
						createdAt: now,
					})
					.run();
				const seq = claimNextRefSeq(tx, id);
				tx.insert(narratorMessageRefs)
					.values({
						id: generateId(),
						narratorId: id,
						messageId: compactMsgId,
						seq,
						isCompact: 1,
					})
					.run();
			}

			initializeRefSeqFloor(tx, id);
			return created;
		}),
	);

	// Spec namespace fork is best-effort; extract must not fail on it.
	const { specVfsService } = await import("./spec-vfs-service");
	try {
		await specVfsService.forkSpecNamespace(sourceId, id);
	} catch (err) {
		logger.warn("extract: forkSpecNamespace failed (non-fatal)", {
			sourceId,
			newNarratorId: id,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Keep `narrator:forked` so project-db-sync / WS refresh still fire. The DB
	// parent is null (independence); `parentNarratorId` on the event is the SOURCE
	// subagent for provenance, and `extracted: true` marks that distinction.
	eventBus.emit({
		type: "narrator:forked",
		narratorId: id,
		parentNarratorId: sourceId,
		extracted: true,
	});
	broadcastToNarrator(sourceId, {
		type: "narrator_forked",
		narratorId: id,
		parentNarratorId: sourceId,
		extracted: true,
	});
	broadcastToNarrator(id, {
		type: "narrator_forked",
		narratorId: id,
		parentNarratorId: sourceId,
		extracted: true,
	});

	logger.info("Subagent extracted to primary narrator", {
		sourceId,
		newNarratorId: id,
		inheritMode,
		sourceMessageCount: sourceRefs.length,
		traits: parseTraits(newNarrator.traits),
	});

	return newNarrator;
}
