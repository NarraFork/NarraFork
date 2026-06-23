import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	and,
	asc,
	type Column,
	count as countFn,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import {
	chapters,
	containerInstances,
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narratorFileSnapshots,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	projects,
	terminals,
	userPreferences,
	users,
} from "../db/schema";
import { takeOverExitPlanReflection } from "../lib/agent/tools/exit-plan-reflection";
import { narratorTraitsLock } from "../lib/async-mutex";
import {
	BOOLEAN_OVERRIDE_VALUES,
	type BooleanOverride,
	DANGER_REFLECTION_OVERRIDE_VALUES,
	type DangerReflectionOverride,
	normalizeBooleanOverride,
	normalizeDangerReflectionOverride,
} from "../lib/boolean-override";
import {
	click as browserClick,
	screenshot as browserScreenshot,
	scroll as browserScroll,
	type as browserType,
} from "../lib/browser/actions";
import { DEFAULT_VIEWPORT } from "../lib/browser/pool";
import {
	closeSession as closeBrowserSession,
	getSession as getBrowserSession,
	listSessions as listBrowserSessions,
	MAX_SESSION_TTL_MS,
	MIN_SESSION_TTL_MS,
	setSessionTtl as setBrowserSessionTtl,
	stopTracing as stopBrowserTracing,
	touchSessionVisual,
} from "../lib/browser/session";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { extractMentions, hasMention } from "../lib/mentions";
import {
	DISABLED_TOOLS_TRAIT_PREFIX,
	getConfigurableTools,
	getDisabledToolSet,
	getVisibleModelUses,
	normalizeDisabledTools,
	normalizeSubagentModelRestriction,
	parseDisabledToolsTrait,
	parseSubagentModelRestrictionTrait,
	removeEncodedTrait,
	SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX,
	upsertEncodedTrait,
} from "../lib/narrator-custom-traits";
import {
	addTrait,
	hasDraftTrait,
	hasTrait,
	isSubagentVariant,
	parseDraftTrait,
	parseSubstatus,
	parseTraits,
	redactDraftTraits,
	removeTrait,
	upsertDraftTrait,
} from "../lib/narrator-utils";
import { isPermissionMode, PERMISSION_MODES } from "../lib/permission-modes";
import { pathsEqual, resolvePath } from "../lib/platform-path";
import {
	getToolMessage,
	getUserLanguage,
	getUserReplyInLanguage,
	type Locale,
} from "../lib/prompt-i18n";
import { type ImageRef, saveUploadedImage, validateTextFile } from "../lib/uploads";
import {
	askInPassingSchema,
	askInPassingStartSchema,
	browserInteractSchema,
	createBlacklistCmdSchema,
	createBlacklistDirSchema,
	createNarratorSchema,
	createWhitelistCmdSchema,
	createWhitelistDirSchema,
	editAssistantMessageSchema,
	forkNarratorSchema,
	permissionDecisionSchema,
	reorderBufferSchema,
	segmentCompactSchema,
	sendMessageSchema,
	suggestAnswersSchema,
	updateBlacklistCmdSchema,
	updateBlacklistDirSchema,
	updateBufferedMessageSchema,
	updateNarratorCwdSchema,
	updateNarratorDraftSchema,
	updateNarratorHandleSchema,
	updateNarratorModelSchema,
	updateNarratorTitleSchema,
	updateSegmentCompactSummarySchema,
	updateWhitelistCmdSchema,
	updateWhitelistDirSchema,
} from "../lib/validators";
import { generateAskUserQuestionAnswers } from "../services/ask-user-question-reflection";
import { chapterFork } from "../services/chapter-fork";
import { chatGroupService } from "../services/chat-group-service";
import type {
	BashCommandResult,
	GoalCommandResult,
	LoadSkillResult,
	LoadToolNotFound,
	LoadToolResult,
	UnloadToolNotFound,
	UnloadToolResult,
} from "../services/command-service";
import { getSlashMenuItems, resolveCommand } from "../services/command-service";
import {
	applyToolCall,
	getAffectedFiles,
	groupByFile,
	queryOrderedToolCalls,
	rebuildFileState,
	rebuildFileStatesExcluding,
	rebuildFileStatesUpToSeq,
} from "../services/file-state-rebuild";
import { type NarratorGoalStatus, narratorGoalService } from "../services/narrator-goal-service";
import {
	reflectPendingAskUserQuestion,
	stopDangerReflectionLoop,
} from "../services/narrator-permission";
import { enterNarratorPlanMode, exitNarratorPlanMode } from "../services/narrator-plan-mode";
import {
	handleBashCommand,
	handleLoadSkillCommand,
	handleLoadToolCommand,
	handleUnloadToolCommand,
	narratorService,
} from "../services/narrator-service";
import {
	type BufferCreator,
	cancelCompact,
	cancelPendingExitPlanMode,
	clearBufferedMessages,
	closeNarrator,
	continueNarrator,
	editAndRegenerate,
	editAssistantMessage,
	getBufferedMessages,
	interruptNarrator,
	isCompactInProgress,
	isNarratorActive,
	normalizeRollbackBlockIndexForMessage,
	notifyRunningNarratorGoalStateChanged,
	pushBufferedMessage,
	removeBufferedMessage,
	reorderBufferedMessages,
	reprocessAllPendingPermissions,
	requestBufferedMessageSoftStop,
	resolvePermissionOrDangerReflection,
	restoreAssistantMessage,
	retryLastMessage,
	rollbackToBlock,
	runCustomCompact,
	runSegmentCompact,
	sendMessage,
	setTemporaryModelRestore,
	startGoalContinuationIfPossible,
	toBufferSummary,
	updateActiveDisabledTools,
	updateActiveNarratorCwdAndSkillContext,
	updateBufferedMessage,
	updateNarratorModel,
	updateNarratorPermissionMode,
	updateNarratorReasoningEffort,
} from "../services/narrator-session";
import {
	activeNarrators,
	planModeAskedOnce,
	resetActiveUpstreamSession,
} from "../services/narrator-session-state";
import { generateTitle, persistTitle } from "../services/narrator-title";
import { skillService } from "../services/skill-service";
import { resolveNarratorCwd } from "../services/snapshot-revert";
import { usageHistoryService } from "../services/usage-history-service";
import { syncNarratorDraftToRecentTabs } from "../services/user-preferences-service";
import {
	broadcastToNarrator,
	getNarratorIdsWithPresence,
	getNarratorPresenceBatch,
} from "../websocket/narrator-ws";

function parseNewCommand(message: string): { rawCommand: string; initialMessage: string } | null {
	const match = message.trim().match(/^\/new(?:\s+([\s\S]*))?$/);
	if (!match) return null;
	return { rawCommand: message.trim(), initialMessage: match[1]?.trim() ?? "" };
}

/** Parse message request supporting both JSON and multipart/form-data (with images and text files) */
export async function parseMessageRequest(
	c: {
		req: {
			header: (name: string) => string | undefined;
			formData: () => Promise<FormData>;
			json: () => Promise<unknown>;
		};
	},
	narratorId: string,
): Promise<{ message: string; images: ImageRef[]; textFiles: File[]; priority?: boolean }> {
	const contentType = c.req.header("content-type") ?? "";
	if (contentType.includes("multipart/form-data")) {
		const formData = await c.req.formData();
		const message = formData.get("message") as string;
		if (!message?.trim()) throw new ValidationError("message is required");
		const imageFiles = formData.getAll("images") as File[];
		if (imageFiles.length > 10) {
			throw new ValidationError("Maximum 10 images per message");
		}
		const images: ImageRef[] = [];
		for (const file of imageFiles) {
			images.push(await saveUploadedImage(narratorId, file));
		}
		const textFileEntries = formData.getAll("textFiles") as File[];
		if (textFileEntries.length > 10) {
			throw new ValidationError("Maximum 10 text files per message");
		}
		for (const file of textFileEntries) {
			validateTextFile(file);
		}
		const priority = formData.get("priority") === "true";
		return { message, images, textFiles: textFileEntries, priority: priority || undefined };
	}
	const body = await c.req.json();
	const parsed = sendMessageSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return {
		message: parsed.data.message,
		images: [],
		textFiles: [],
		priority: parsed.data.priority,
	};
}

export const narratorRoutes = new Hono();

function parseBooleanOverride(value: unknown, field: string): BooleanOverride {
	if (typeof value === "string" && BOOLEAN_OVERRIDE_VALUES.includes(value as BooleanOverride)) {
		return value as BooleanOverride;
	}
	throw new ValidationError(`${field} must be one of: ${BOOLEAN_OVERRIDE_VALUES.join(", ")}`);
}

function parseDangerReflectionOverride(value: unknown, field: string): DangerReflectionOverride {
	if (
		typeof value === "string" &&
		DANGER_REFLECTION_OVERRIDE_VALUES.includes(value as DangerReflectionOverride)
	) {
		return value as DangerReflectionOverride;
	}
	throw new ValidationError(
		`${field} must be one of: ${DANGER_REFLECTION_OVERRIDE_VALUES.join(", ")}`,
	);
}

function publicNarratorResponse<T extends { traits: unknown; substatus?: unknown }>(narrator: T) {
	return {
		...narrator,
		traits: redactDraftTraits(narrator.traits),
		hasDraft: hasDraftTrait(narrator.traits),
		substatus: parseSubstatus(narrator.substatus),
	};
}

function publicTraitsResponse(traits: unknown): string[] {
	return redactDraftTraits(traits);
}

// List narrators — by chapterId, or standalone (chapterId IS NULL)
narratorRoutes.get("/", async (c) => {
	const chapterId = c.req.query("chapterId");
	const standalone = c.req.query("standalone");

	if (standalone === "true" || standalone === "all") {
		// Paginated session list
		// standalone=true: only standalone (chapterId IS NULL)
		// standalone=all: all sessions (standalone + chapter-bound)
		const status = c.req.query("status");
		const filter = c.req.query("filter"); // "standalone" | "chapter" | undefined (all)
		const rawSortBy = c.req.query("sortBy") ?? "updatedAt";
		const sortOrder = c.req.query("sortOrder") ?? "desc";
		const rawLimit = Number.parseInt(c.req.query("limit") ?? "20", 10);
		const limit = Math.min(Number.isNaN(rawLimit) ? 20 : rawLimit, 100);
		const cursorParam = c.req.query("cursor");

		// Presence-based filters
		const hasTerminals = c.req.query("hasTerminals") === "true";
		const hasContainers = c.req.query("hasContainers") === "true";
		const hasRunningContainers = c.req.query("hasRunningContainers") === "true";
		const hasViewers = c.req.query("hasViewers") === "true";

		// Build base where conditions
		const conditions = [eq(narrators.variant, "primary")];

		if (status === "archived") {
			conditions.push(eq(narrators.status, "archived"));
		} else {
			conditions.push(ne(narrators.status, "archived"));
		}

		// Filter by standalone vs chapter-bound
		if (standalone === "true" || filter === "standalone") {
			conditions.push(isNull(narrators.chapterId));
		} else if (filter === "chapter") {
			conditions.push(isNotNull(narrators.chapterId));
		}
		// standalone=all with no filter: show all

		// Filter: has active terminals
		if (hasTerminals) {
			conditions.push(
				sql`EXISTS (SELECT 1 FROM terminals WHERE terminals.narrator_id = ${narrators.id} AND terminals.status = 'running')`,
			);
		}

		// Filter: has containers (via chapter)
		if (hasContainers) {
			conditions.push(
				sql`EXISTS (SELECT 1 FROM container_instances WHERE container_instances.chapter_id = ${narrators.chapterId})`,
			);
		}

		// Filter: has running containers (via chapter)
		if (hasRunningContainers) {
			conditions.push(
				sql`EXISTS (SELECT 1 FROM container_instances WHERE container_instances.chapter_id = ${narrators.chapterId} AND container_instances.status = 'running')`,
			);
		}

		// Filter: has viewers (in-memory presence)
		if (hasViewers) {
			const viewedIds = getNarratorIdsWithPresence();
			if (viewedIds.size === 0) {
				// No narrators have viewers — return empty result
				return c.json({ items: [], hasMore: false, nextCursor: null, totalCount: 0 });
			}
			conditions.push(sql`${narrators.id} IN ${[...viewedIds]}`);
		}

		const baseWhere = and(...conditions);

		const sortColumnMap: Record<string, Column> = {
			updatedAt: narrators.updatedAt,
			createdAt: narrators.createdAt,
			title: narrators.title,
			messageCount: narrators.messageCount,
		};
		const sortBy = rawSortBy in sortColumnMap ? rawSortBy : "updatedAt";
		const column = sortColumnMap[sortBy];
		const orderFn = sortOrder === "asc" ? asc : desc;
		const cmpFn = sortOrder === "asc" ? gt : lt;

		// Decode cursor: { v: sortValue, id: narratorId }
		let cursorWhere: ReturnType<typeof and> | undefined;
		if (cursorParam) {
			try {
				const decoded = JSON.parse(Buffer.from(cursorParam, "base64url").toString());
				const cursorVal = decoded.v;
				const cursorId = decoded.id;
				cursorWhere = or(
					cmpFn(column, cursorVal),
					and(eq(column, cursorVal), cmpFn(narrators.id, cursorId)),
				);
			} catch {
				// Invalid cursor — ignore, start from beginning
			}
		}

		const whereClause = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

		const [list, countResult] = await Promise.all([
			db.query.narrators.findMany({
				where: whereClause,
				orderBy: [orderFn(column), orderFn(narrators.id)],
				limit: limit + 1,
			}),
			db.select({ count: sql<number>`count(*)` }).from(narrators).where(baseWhere),
		]);
		const totalCount = countResult[0]?.count ?? 0;

		const hasMore = list.length > limit;
		const rawItems = hasMore ? list.slice(0, limit) : list;
		const lastItem = rawItems[rawItems.length - 1];
		const nextCursor =
			hasMore && lastItem
				? Buffer.from(
						JSON.stringify({
							v: (lastItem as Record<string, unknown>)[sortBy] ?? lastItem.updatedAt,
							id: lastItem.id,
						}),
					).toString("base64url")
				: null;

		// Enrich items with chapter info, terminal counts, and viewers
		const narratorIds = rawItems.map((n) => n.id);
		const chapterIds = rawItems.map((n) => n.chapterId).filter(Boolean) as string[];

		// Batch fetch chapter info
		const chapterMap = new Map<
			string,
			{
				id: string;
				title: string;
				projectId: string;
				projectName: string | null;
				status: string;
				role: string;
			}
		>();
		if (chapterIds.length > 0) {
			const chapterRows = await db
				.select({
					id: chapters.id,
					title: chapters.title,
					projectId: chapters.projectId,
					projectName: projects.name,
					status: chapters.status,
					role: chapters.role,
				})
				.from(chapters)
				.leftJoin(projects, eq(chapters.projectId, projects.id))
				.where(sql`${chapters.id} IN ${chapterIds}`);
			for (const row of chapterRows) {
				chapterMap.set(row.id, row);
			}
		}

		// Batch fetch active terminal counts
		const terminalCounts = new Map<string, number>();
		if (narratorIds.length > 0) {
			const termRows = await db
				.select({
					narratorId: terminals.narratorId,
					count: countFn(),
				})
				.from(terminals)
				.where(and(sql`${terminals.narratorId} IN ${narratorIds}`, eq(terminals.status, "running")))
				.groupBy(terminals.narratorId);
			for (const row of termRows) {
				if (row.narratorId) terminalCounts.set(row.narratorId, row.count);
			}
		}

		// Batch fetch container counts per chapter (total + running)
		const containerCounts = new Map<string, { total: number; running: number }>();
		if (chapterIds.length > 0) {
			const containerRows = await db
				.select({
					chapterId: containerInstances.chapterId,
					total: countFn(),
					running: sql<number>`SUM(CASE WHEN ${containerInstances.status} = 'running' THEN 1 ELSE 0 END)`,
				})
				.from(containerInstances)
				.where(sql`${containerInstances.chapterId} IN ${chapterIds}`)
				.groupBy(containerInstances.chapterId);
			for (const row of containerRows) {
				containerCounts.set(row.chapterId, {
					total: row.total,
					running: row.running ?? 0,
				});
			}
		}

		// Batch fetch presence and goal state
		const presenceMap = getNarratorPresenceBatch(narratorIds);
		const activeGoalNarratorIds =
			await narratorGoalService.getNarratorIdsWithActiveGoals(narratorIds);

		const items = rawItems.map((n) => ({
			...publicNarratorResponse(n),
			chapter: n.chapterId ? (chapterMap.get(n.chapterId) ?? null) : null,
			activeTerminalCount: terminalCounts.get(n.id) ?? 0,
			containerCount: n.chapterId ? (containerCounts.get(n.chapterId)?.total ?? 0) : 0,
			runningContainerCount: n.chapterId ? (containerCounts.get(n.chapterId)?.running ?? 0) : 0,
			viewers: presenceMap.get(n.id) ?? [],
			hasActiveGoal: activeGoalNarratorIds.has(n.id),
		}));

		return c.json({ items, hasMore, nextCursor, totalCount });
	}

	if (!chapterId) throw new ValidationError("chapterId or standalone=true is required");
	const list = await narratorService.listByChapter(chapterId);
	return c.json(list.map(publicNarratorResponse));
});

// Create narrator
narratorRoutes.post("/", async (c) => {
	const body = await c.req.json();
	const parsed = createNarratorSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	let input = parsed.data;
	if (input.fastMode === undefined) {
		const userId = c.get("user").sub;
		const pref = await db.query.userPreferences.findFirst({
			where: eq(userPreferences.userId, userId),
			columns: { fastModeDefault: true },
		});
		if (pref?.fastModeDefault) input = { ...input, fastMode: true };
	}

	const narrator = await narratorService.create(input);
	return c.json(publicNarratorResponse(narrator), 201);
});

// Resolve a named narrator by its handle (case-insensitive). Used by @mention.
// Must be registered before "/:id" so "by-handle" is not captured as an id.
narratorRoutes.get("/by-handle/:handle", async (c) => {
	const handle = c.req.param("handle");
	const narrator = await narratorService.getByHandle(handle);
	if (!narrator) throw new NotFoundError("Named narrator", handle);
	return c.json(publicNarratorResponse(narrator));
});

// List all named narrators (handle-based @mention targets).
narratorRoutes.get("/named", async (c) => {
	const named = await narratorService.listNamed();
	return c.json(named.map((n) => publicNarratorResponse(n)));
});

// Get narrator
narratorRoutes.get("/:id", async (c) => {
	const narrator = await narratorService.getById(c.req.param("id"));
	return c.json(publicNarratorResponse(narrator));
});

// List active chat groups a narrator participates in
narratorRoutes.get("/:id/groups", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id); // 404 if missing
	const groups = await chatGroupService.listGroupsForNarrator(id);
	return c.json({ groups });
});

function draftResponse(traits: unknown) {
	const draft = parseDraftTrait(traits);
	return {
		hasDraft: !!draft,
		text: draft?.text ?? "",
		updatedAt: draft?.updatedAt ?? null,
		updatedBy: draft?.updatedBy ?? null,
		sourceId: draft?.sourceId ?? null,
	};
}

narratorRoutes.get("/:id/draft", async (c) => {
	const narrator = await narratorService.getById(c.req.param("id"));
	return c.json(draftResponse(narrator.traits));
});

narratorRoutes.put("/:id/draft", async (c) => {
	const id = c.req.param("id");
	const userId = c.get("user").sub;
	const body = await c.req.json().catch(() => ({}));
	const parsed = updateNarratorDraftSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const update = await narratorTraitsLock.acquire(id, async () => {
		const narrator = await narratorService.getById(id);
		const previousDraft = parseDraftTrait(narrator.traits);
		const now = new Date().toISOString();
		const draft = parsed.data.text.trim()
			? {
					text: parsed.data.text,
					updatedAt: now,
					updatedBy: userId,
					sourceId: parsed.data.sourceId ?? null,
				}
			: null;
		const traits = upsertDraftTrait(narrator.traits, draft);
		await db.update(narrators).set({ traits, updatedAt: now }).where(eq(narrators.id, id));
		return { draft, previousDraft, response: draftResponse(traits), traits };
	});

	broadcastToNarrator(id, {
		type: "draft_changed",
		narratorId: id,
		...update.response,
	});
	await syncNarratorDraftToRecentTabs(id, {
		promote: !update.previousDraft && !!update.draft,
	});
	return c.json({ ok: true, traits: publicTraitsResponse(update.traits), ...update.response });
});

// Get usage stats for this narrator, optionally including direct subagents.
narratorRoutes.get("/:id/usage-stats", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const includeSubagents = c.req.query("includeSubagents") !== "false";
	const stats = await usageHistoryService.getUsageStats({ narratorId, includeSubagents });
	return c.json(stats);
});

// Get available commands + skills for the slash menu
narratorRoutes.get("/:id/commands", async (c) => {
	const id = c.req.param("id");
	const userId = c.get("user").sub;
	const result = await getSlashMenuItems(id, userId);
	return c.json(result);
});

// Get skills available to this narrator's current project/cwd context.
narratorRoutes.get("/:id/skills", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const refresh = c.req.query("refresh") === "true";
	const context = await skillService.resolveSkillContextForNarrator(id);
	const result = await skillService.loadSkillSummariesForContext(context, {
		forceRefresh: refresh,
	});
	return c.json({
		skills: result.skills.filter((skill) => !skill.disabled),
		roots: result.roots,
		scopeKey: result.scopeKey,
	});
});

function customTraitsResponse(traits: unknown) {
	return {
		subagentModelRestriction: parseSubagentModelRestrictionTrait(traits),
		disabledTools: parseDisabledToolsTrait(traits),
		availableModels: getVisibleModelUses(),
		availableTools: getConfigurableTools(),
	};
}

async function updateNarratorTraits(id: string, update: (traits: string[]) => string[]) {
	const traits = await narratorTraitsLock.acquire(id, async () => {
		const narrator = await narratorService.getById(id);
		const nextTraits = update(parseTraits(narrator.traits));
		await db
			.update(narrators)
			.set({ traits: nextTraits, updatedAt: new Date().toISOString() })
			.where(eq(narrators.id, id));
		return nextTraits;
	});
	updateActiveDisabledTools(id, getDisabledToolSet(traits));
	broadcastToNarrator(id, {
		type: "custom_traits_changed",
		narratorId: id,
		traits: publicTraitsResponse(traits),
		customTraits: customTraitsResponse(traits),
	});
	return traits;
}

narratorRoutes.get("/:id/custom-traits", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	return c.json(customTraitsResponse(narrator.traits));
});

narratorRoutes.put("/:id/custom-traits/subagent-model-restriction", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json().catch(() => ({}));
	const restriction = normalizeSubagentModelRestriction(body);
	const traits = await updateNarratorTraits(id, (currentTraits) =>
		Object.keys(restriction.pools).length === 0
			? removeEncodedTrait(currentTraits, SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX)
			: upsertEncodedTrait(currentTraits, SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, restriction),
	);
	return c.json({
		ok: true,
		traits: publicTraitsResponse(traits),
		customTraits: customTraitsResponse(traits),
	});
});

narratorRoutes.delete("/:id/custom-traits/subagent-model-restriction", async (c) => {
	const id = c.req.param("id");
	const traits = await updateNarratorTraits(id, (currentTraits) =>
		removeEncodedTrait(currentTraits, SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX),
	);
	return c.json({
		ok: true,
		traits: publicTraitsResponse(traits),
		customTraits: customTraitsResponse(traits),
	});
});

narratorRoutes.put("/:id/custom-traits/disabled-tools", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json().catch(() => ({}));
	const disabledTools = normalizeDisabledTools(body);
	const traits = await updateNarratorTraits(id, (currentTraits) =>
		upsertEncodedTrait(currentTraits, DISABLED_TOOLS_TRAIT_PREFIX, disabledTools),
	);
	return c.json({
		ok: true,
		traits: publicTraitsResponse(traits),
		customTraits: customTraitsResponse(traits),
	});
});

narratorRoutes.delete("/:id/custom-traits/disabled-tools", async (c) => {
	const id = c.req.param("id");
	const traits = await updateNarratorTraits(id, (currentTraits) =>
		removeEncodedTrait(currentTraits, DISABLED_TOOLS_TRAIT_PREFIX),
	);
	return c.json({
		ok: true,
		traits: publicTraitsResponse(traits),
		customTraits: customTraitsResponse(traits),
	});
});

function parseGoalStatus(value: unknown): NarratorGoalStatus | undefined {
	if (value == null) return undefined;
	if (["pending", "active", "paused", "complete", "cancelled"].includes(String(value))) {
		return String(value) as NarratorGoalStatus;
	}
	throw new ValidationError("Invalid goal status");
}

async function persistGoalDisplayMessage(narratorId: string, text: string) {
	return narratorService.persistDisplayMessage(narratorId, text);
}

function notifyGoalStateIfRunning(
	narratorId: string,
	action: string,
	result: { goals?: Awaited<ReturnType<typeof narratorGoalService.listGoals>> },
) {
	if (!result.goals) return;
	notifyRunningNarratorGoalStateChanged(narratorId, action, result.goals);
}

async function handleGoalCommand(narratorId: string, cmd: GoalCommandResult, userId: string) {
	switch (cmd.action) {
		case "list":
			return {
				goalCommand: true,
				action: cmd.action,
				goals: await narratorGoalService.listGoals(narratorId),
			};
		case "add":
			if (!cmd.objective) throw new ValidationError("Goal objective is required");
			return {
				goalCommand: true,
				action: cmd.action,
				...(await narratorGoalService.createGoal(narratorId, cmd.objective, userId)),
			};
		case "pause": {
			const active = await narratorGoalService.getActiveGoal(narratorId);
			if (!active) return { goalCommand: true, action: cmd.action, goal: null, goals: [] };
			return {
				goalCommand: true,
				action: cmd.action,
				...(await narratorGoalService.updateGoal(narratorId, active.id, { status: "paused" })),
			};
		}
		case "resume": {
			const goals = await narratorGoalService.listGoals(narratorId);
			const paused = goals.find((goal) => goal.status === "paused");
			if (paused) {
				return {
					goalCommand: true,
					action: cmd.action,
					...(await narratorGoalService.updateGoal(narratorId, paused.id, { status: "active" })),
				};
			}
			await narratorGoalService.activateNextPendingGoal(narratorId);
			return {
				goalCommand: true,
				action: cmd.action,
				goals: await narratorGoalService.listGoals(narratorId),
			};
		}
		case "complete":
			return {
				goalCommand: true,
				action: cmd.action,
				...(await narratorGoalService.completeActiveGoal(narratorId)),
			};
		case "clear":
			return {
				goalCommand: true,
				action: cmd.action,
				...(await narratorGoalService.clearOpenGoals(narratorId)),
			};
	}
}

narratorRoutes.get("/:id/goals", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	return c.json({ goals: await narratorGoalService.listGoals(id) });
});

narratorRoutes.post("/:id/goals", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = (await c.req.json()) as { objective?: string };
	if (!body.objective) throw new ValidationError("objective is required");
	const userId = c.get("user").sub;
	const result = await narratorGoalService.createGoal(id, body.objective, userId);
	notifyGoalStateIfRunning(id, result.created ? "add" : "add_existing", result);
	await persistGoalDisplayMessage(id, body.objective);
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);
	await startGoalContinuationIfPossible(id, locale, replyInUserLanguage);
	return c.json(result, 201);
});

narratorRoutes.patch("/:id/goals/:goalId", async (c) => {
	const id = c.req.param("id");
	const goalId = c.req.param("goalId");
	await narratorService.getById(id);
	const body = (await c.req.json()) as { objective?: string; status?: string };
	const status = parseGoalStatus(body.status);
	const result = await narratorGoalService.updateGoal(id, goalId, {
		objective: body.objective,
		status,
	});
	notifyGoalStateIfRunning(id, status ? `update:${status}` : "update", result);
	if (status === "active") {
		const userId = c.get("user").sub;
		const locale = await getUserLanguage(userId);
		const replyInUserLanguage = await getUserReplyInLanguage(userId);
		await startGoalContinuationIfPossible(id, locale, replyInUserLanguage);
	}
	return c.json(result);
});

narratorRoutes.delete("/:id/goals/:goalId", async (c) => {
	const id = c.req.param("id");
	const goalId = c.req.param("goalId");
	await narratorService.getById(id);
	const result = await narratorGoalService.removeGoal(id, goalId);
	notifyGoalStateIfRunning(id, "remove", result);
	return c.json(result);
});

narratorRoutes.put("/:id/goals/reorder", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = (await c.req.json()) as { orderedIds?: string[] };
	if (!Array.isArray(body.orderedIds)) throw new ValidationError("orderedIds is required");
	const result = await narratorGoalService.reorderGoals(id, body.orderedIds);
	notifyGoalStateIfRunning(id, "reorder", result);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);
	await startGoalContinuationIfPossible(id, locale, replyInUserLanguage);
	return c.json(result);
});

narratorRoutes.delete("/:id/goals", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const result = await narratorGoalService.clearOpenGoals(id);
	notifyGoalStateIfRunning(id, "clear", result);
	return c.json(result);
});

/**
 * Resolve @handle mentions of named narrators and bring them into a chat group
 * with this session. Fire-and-forget: never blocks or fails the message request,
 * and runs regardless of whether the message was sent immediately (idle) or
 * buffered (the narrator was working). Resolves locale internally because the
 * buffered path does not compute it.
 */
function dispatchMentions(originNarratorId: string, content: string, userId: string): void {
	if (!hasMention(content)) return;
	const handles = extractMentions(content);
	if (handles.length === 0) return;
	void (async () => {
		const locale = await getUserLanguage(userId);
		await chatGroupService.handleMentions({
			originNarratorId,
			handles,
			content,
			createdBy: userId,
			projectId: null,
			locale,
			fromUser: true,
		});
	})().catch((err) => {
		logger.warn("Failed to handle @mentions", {
			narratorId: originNarratorId,
			error: String(err),
		});
	});
}

// Send message — fire-and-forget; all streaming events delivered via WebSocket
narratorRoutes.post("/:id/messages", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id); // throws NotFoundError if missing

	// Auto-unarchive on interaction
	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const { message, images, textFiles, priority } = await parseMessageRequest(c, id);
	const userId = c.get("user").sub;
	const queuedNewCommand = parseNewCommand(message);

	// Resolve slash commands
	let finalMessage = message;
	let commandText: string | null = queuedNewCommand?.rawCommand ?? null;
	const cmdResult = queuedNewCommand
		? ({ resolved: false } as Awaited<ReturnType<typeof resolveCommand>>)
		: await resolveCommand(message, id, userId);
	if (cmdResult.resolved && ("loadTool" in cmdResult || "loadToolNotFound" in cmdResult)) {
		const locale = await getUserLanguage(userId);
		const result = await handleLoadToolCommand(
			id,
			cmdResult as LoadToolResult | LoadToolNotFound,
			locale,
			userId,
		);
		return c.json(result, 200);
	}
	if (cmdResult.resolved && ("unloadTool" in cmdResult || "unloadToolNotFound" in cmdResult)) {
		const locale = await getUserLanguage(userId);
		const result = await handleUnloadToolCommand(
			id,
			cmdResult as UnloadToolResult | UnloadToolNotFound,
			locale,
		);
		return c.json(result, 200);
	}
	if (cmdResult.resolved && "loadSkill" in cmdResult) {
		const skillResult = await handleLoadSkillCommand(id, cmdResult as LoadSkillResult);
		if (!skillResult.found) {
			return c.json({ skillName: skillResult.skillName, loaded: false }, 200);
		}
		// Inject skill content into the message, preserving user input after the skill name
		const userInput = (cmdResult as LoadSkillResult).skillInput;
		finalMessage = `<command-name>${skillResult.skillName}</command-name>\n${skillResult.content}${userInput ? `\n\n${userInput}` : ""}`;
		commandText = cmdResult.rawCommand;
	}
	// Only the built-in /bash command should short-circuit here. Custom slash commands
	// with runBashFirst also carry bashCommand, but they must continue below so the
	// expanded prompt is sent after the pre-prompt Bash command completes.
	if (cmdResult.resolved && "bashCommand" in cmdResult && !("expandedPrompt" in cmdResult)) {
		const bashResult = await handleBashCommand(
			id,
			(cmdResult as BashCommandResult).bashCommand,
			cmdResult.rawCommand,
			userId,
		);
		return c.json(bashResult, 201);
	}
	if (cmdResult.resolved && "goalCommand" in cmdResult) {
		const goalCommand = cmdResult as GoalCommandResult;
		const result = await handleGoalCommand(id, goalCommand, userId);
		if (goalCommand.action !== "list") {
			notifyGoalStateIfRunning(id, goalCommand.action, result);
		}
		await persistGoalDisplayMessage(id, goalCommand.rawCommand);
		if (["add", "resume", "complete"].includes(goalCommand.action)) {
			const locale = await getUserLanguage(userId);
			const replyInUserLanguage = await getUserReplyInLanguage(userId);
			await startGoalContinuationIfPossible(id, locale, replyInUserLanguage);
		}
		return c.json(result, 200);
	}
	let prePromptBashCommand: string | undefined;
	if (cmdResult.resolved && "expandedPrompt" in cmdResult) {
		finalMessage = cmdResult.expandedPrompt;
		commandText = cmdResult.rawCommand;
		prePromptBashCommand = cmdResult.bashCommand;
	}

	// Extract model override from resolved command (if any)
	const modelOverride =
		cmdResult.resolved && "command" in cmdResult ? cmdResult.command.modelOverride : undefined;

	if (queuedNewCommand && !(narrator.status === "working" || narrator.status === "waiting")) {
		const currentCwd = narrator.cwd ?? undefined;
		const newNarrator = await narratorService.create({
			chapterId: null,
			model: narrator.model ?? undefined,
			systemPrompt: narrator.systemPrompt ?? undefined,
			permissionMode: narrator.permissionMode ?? undefined,
			reasoningEffort: narrator.reasoningEffort ?? undefined,
			fastMode: narrator.fastMode ?? undefined,
			relaxedPlan: narrator.relaxedPlan ?? undefined,
			planReflectionAutoApproveOverride: normalizeBooleanOverride(
				narrator.planReflectionAutoApproveOverride,
			),
			dangerReflectionOverride: normalizeDangerReflectionOverride(
				narrator.dangerReflectionOverride,
			),
			cwd: currentCwd,
		});
		const locale = await getUserLanguage(userId);
		const replyInUserLanguage = await getUserReplyInLanguage(userId);
		if (queuedNewCommand.initialMessage) {
			await sendMessage(
				newNarrator.id,
				queuedNewCommand.initialMessage,
				images,
				locale,
				replyInUserLanguage,
				undefined,
				userId,
				textFiles,
			);
		}
		return c.json({ newNarrator: publicNarratorResponse(newNarrator) }, 201);
	}

	// Running narrator: buffer the message for execution after the current turn
	if (narrator.status === "working" || narrator.status === "waiting") {
		if (isSubagentVariant(narrator.variant)) {
			if (queuedNewCommand) {
				throw new ValidationError("/new cannot be queued from a running subagent");
			}

			const { pushSubagentBufferedMessage, getSubagentBufferedMessages } = await import(
				"../services/narrator-subagent"
			);
			const result = pushSubagentBufferedMessage(
				id,
				finalMessage,
				undefined,
				priority ? "front" : "back",
			);
			if (!result.ok) {
				if (result.full) throw new ValidationError("Message queue is full");
				throw new ValidationError("Subagent is not running in foreground");
			}
			const messages = toBufferSummary(getSubagentBufferedMessages(id));
			broadcastToNarrator(id, {
				type: "buffer_set",
				narratorId: id,
				messages,
			});
			return c.json({ buffered: true, bufferedAt: result.bufferedAt, id: result.id }, 202);
		}

		// Primary narrator: push onto buffer queue (or unshift if priority).
		const user = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { id: true, username: true, avatarColor: true, avatarImageId: true },
		});
		const creator: BufferCreator | null = user
			? {
					id: user.id,
					username: user.username,
					avatarColor: user.avatarColor,
					avatarImageId: user.avatarImageId,
				}
			: null;
		const result = await pushBufferedMessage(
			id,
			finalMessage,
			images.length > 0 ? images : undefined,
			commandText,
			userId,
			creator,
			textFiles.length > 0 ? textFiles : undefined,
			priority ? "front" : undefined,
			prePromptBashCommand,
		);
		if (result.ok) {
			const messages = toBufferSummary(getBufferedMessages(id));
			broadcastToNarrator(id, {
				type: "buffer_set",
				narratorId: id,
				messages,
			});
			// Priority messages should cut in at the next safe model-request boundary without
			// aborting running tools. The loop soft-stops after current tools complete, then
			// consumes the front of the buffer as the next request.
			if (priority) {
				requestBufferedMessageSoftStop(id);
			}
			// Resolve @handle mentions even when the message was buffered (the
			// narrator was working/waiting); otherwise mentioning a busy named
			// narrator would never create the chat group.
			if (!queuedNewCommand) {
				dispatchMentions(id, message, userId);
			}
			return c.json({ buffered: true, bufferedAt: result.bufferedAt, id: result.id }, 202);
		}
		if (result.full) {
			throw new ValidationError("Message queue is full");
		}
		// Narrator not active in memory — fall through to normal send
	}

	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	// Apply model override from slash command before sending
	if (modelOverride?.model) {
		if (modelOverride.mode === "temporary") {
			// Persist the original model so it can be restored after the turn
			// (survives server restarts). Must be written before sendMessage to
			// avoid a race with the agent loop's finally block.
			await setTemporaryModelRestore(id, narrator.model ?? "__default__");
		}
		// Switch model in DB (sendMessage → ensureNarrator reads from DB)
		await narratorService.updateModel(id, modelOverride.model);
	}

	// prePromptBashCommand (runBashFirst) is passed to sendMessage so the order is:
	// user prompt message → Bash tool card → model reply (handled inside feedMessage).
	const userMsg = await sendMessage(
		id,
		finalMessage,
		images,
		locale,
		replyInUserLanguage,
		commandText,
		userId,
		textFiles,
		prePromptBashCommand,
	);

	// Broadcast model change to frontend (ensureNarrator already picked up the new model from DB)
	if (modelOverride?.model) {
		updateNarratorModel(id, modelOverride.model);
	}

	// Resolve @handle mentions of named narrators: bring them into a chat group
	// with this session. Fire-and-forget so the HTTP response isn't blocked by
	// delivery/wake of the mentioned narrators.
	if (!queuedNewCommand) {
		dispatchMentions(id, message, userId);
	}

	return c.json(userMsg, 201);
});

// Retry last user message — re-run agent loop without creating a new message
narratorRoutes.post("/:id/retry", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);

	if (
		isSubagentVariant(narrator.variant) &&
		(narrator.status === "working" || narrator.status === "waiting")
	) {
		throw new ValidationError("Cannot retry on a running subagent");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	const result = await retryLastMessage(id, locale, replyInUserLanguage);
	return c.json(result);
});

// Continue the agent loop — resume from trailing tool_use without a new user message
narratorRoutes.post("/:id/continue", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);

	if (narrator.status === "working" || narrator.status === "waiting") {
		throw new ValidationError("Cannot continue while narrator is already running");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	const result = await continueNarrator(id, locale, replyInUserLanguage);
	return c.json(result);
});

// Rollback to a specific block — delete everything after it (no re-run)
narratorRoutes.post("/:id/rollback/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");
	const { blockIndex } = await c.req.json();

	if (typeof blockIndex !== "number" || blockIndex < 0) {
		throw new ValidationError("blockIndex is required and must be a non-negative number");
	}

	const narrator = await narratorService.getById(id);

	if (
		isSubagentVariant(narrator.variant) &&
		(narrator.status === "working" || narrator.status === "waiting")
	) {
		throw new ValidationError("Cannot rollback on a running subagent");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const result = await rollbackToBlock(id, messageId, blockIndex);
	return c.json(result);
});

// Edit a user message and regenerate the response
narratorRoutes.post("/:id/edit-and-regenerate/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");
	const { content, rollback } = await c.req.json();

	if (!content || typeof content !== "string") {
		throw new ValidationError("content is required");
	}

	const narrator = await narratorService.getById(id);

	if (
		isSubagentVariant(narrator.variant) &&
		(narrator.status === "working" || narrator.status === "waiting")
	) {
		throw new ValidationError("Cannot edit on a running subagent");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	const result = await editAndRegenerate(
		id,
		messageId,
		content,
		locale,
		replyInUserLanguage,
		!!rollback,
	);
	return c.json(result);
});

// Edit an assistant message's text without deleting later messages or regenerating.
// The edited text is persisted for display and subsequent history assembly, while
// edit metadata (editedAt/editedBy/originalContentJson) stays outside contentJson
// and is never sent to the AI provider.
narratorRoutes.post("/:id/edit-message/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");
	const body = await c.req.json();
	const { content } = editAssistantMessageSchema.parse(body);

	const narrator = await narratorService.getById(id);

	if (
		isSubagentVariant(narrator.variant) &&
		(narrator.status === "working" || narrator.status === "waiting")
	) {
		throw new ValidationError("Cannot edit on a running subagent");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const userId = c.get("user").sub;
	const result = await editAssistantMessage(id, messageId, content, userId);
	return c.json(result);
});

// Restore an edited assistant message back to its original text, clearing the
// edit metadata so the message looks like it was never edited.
narratorRoutes.post("/:id/restore-message/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");

	const narrator = await narratorService.getById(id);

	if (
		isSubagentVariant(narrator.variant) &&
		(narrator.status === "working" || narrator.status === "waiting")
	) {
		throw new ValidationError("Cannot restore on a running subagent");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const result = await restoreAssistantMessage(id, messageId);
	return c.json(result);
});

// Get buffered message queue (for multi-device hydration on page load)
narratorRoutes.get("/:id/buffer", async (c) => {
	const id = c.req.param("id");
	let messages = toBufferSummary(getBufferedMessages(id));
	// Fallback: check subagent buffer
	if (messages.length === 0) {
		const { getSubagentBufferedMessages } = await import("../services/narrator-subagent");
		messages = toBufferSummary(getSubagentBufferedMessages(id));
	}
	return c.json(messages);
});

// Edit a queued buffered message
narratorRoutes.patch("/:id/buffer/:mid", async (c) => {
	const id = c.req.param("id");
	const mid = c.req.param("mid");
	const body = await c.req.json();
	const parsed = updateBufferedMessageSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const ok = updateBufferedMessage(id, mid, parsed.data.text.trim());
	if (!ok) throw new NotFoundError("Buffered message", mid);
	const messages = toBufferSummary(getBufferedMessages(id));
	broadcastToNarrator(id, { type: "buffer_set", narratorId: id, messages });
	return c.json({ ok: true });
});

// Remove a single queued buffered message
narratorRoutes.delete("/:id/buffer/:mid", async (c) => {
	const id = c.req.param("id");
	const mid = c.req.param("mid");
	const ok = removeBufferedMessage(id, mid);
	if (!ok) throw new NotFoundError("Buffered message", mid);
	const messages = toBufferSummary(getBufferedMessages(id));
	broadcastToNarrator(id, { type: "buffer_set", narratorId: id, messages });
	return c.json({ ok: true });
});

// Reorder queued buffered messages
narratorRoutes.put("/:id/buffer/reorder", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const parsed = reorderBufferSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const ok = reorderBufferedMessages(id, parsed.data.orderedIds);
	if (!ok) throw new ValidationError("Invalid reorder: ids do not match the current queue");
	const messages = toBufferSummary(getBufferedMessages(id));
	broadcastToNarrator(id, { type: "buffer_set", narratorId: id, messages });
	return c.json({ ok: true });
});

// Clear entire buffer queue
narratorRoutes.delete("/:id/buffer", async (c) => {
	const id = c.req.param("id");
	clearBufferedMessages(id);
	broadcastToNarrator(id, { type: "buffer_set", narratorId: id, messages: [] });
	return c.json({ ok: true });
});

// Chunk manifest for the virtualized message list (lightweight fingerprints).
// `since` short-circuits with { unchanged: true } when the structure version
// has not changed.
narratorRoutes.get("/:id/chunk-manifest", async (c) => {
	const id = c.req.param("id");
	const sinceRaw = c.req.query("since");
	const since = sinceRaw != null ? Number.parseInt(sinceRaw, 10) : undefined;
	const result = await narratorService.getChunkManifest(
		id,
		since != null && !Number.isNaN(since) ? since : undefined,
	);
	return c.json(result);
});

// Fetch a contiguous range of chunks (full message trees) for the virtualized
// list. Replaces the legacy 20/50 + around triple-path on the chunk codepath.
narratorRoutes.get("/:id/chunks", async (c) => {
	const id = c.req.param("id");
	const fromSeqRaw = c.req.query("fromSeq");
	const fromSeq = fromSeqRaw != null ? Number.parseInt(fromSeqRaw, 10) : undefined;
	const direction = c.req.query("direction") === "newer" ? "newer" : "older";
	const countRaw = c.req.query("count");
	const count = countRaw != null ? Number.parseInt(countRaw, 10) : undefined;
	const [result, narratorMeta] = await Promise.all([
		narratorService.getChunksByRange(id, {
			fromSeq: fromSeq != null && !Number.isNaN(fromSeq) ? fromSeq : undefined,
			direction,
			count: count != null && !Number.isNaN(count) ? count : undefined,
		}),
		db.query.narrators.findFirst({
			where: eq(narrators.id, id),
			columns: {
				pruneBoundaryMessageId: true,
				prunedPercent: true,
				messageVersion: true,
			},
		}),
	]);
	if (!narratorMeta) throw new NotFoundError("Narrator", id);
	return c.json({
		...result,
		pruneBoundaryMessageId: narratorMeta.pruneBoundaryMessageId ?? null,
		prunedPercent: narratorMeta.prunedPercent ?? null,
		messageVersion: narratorMeta.messageVersion ?? 0,
	});
});

// Resolve a message id to the chunk coordinate used by the virtualized list.
narratorRoutes.get("/:id/message-location/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");
	const location = await narratorService.getMessageLocation(id, messageId);
	return c.json(location);
});

// Get full tool call detail (untruncated inputJson/outputJson)
narratorRoutes.get("/:id/tool-calls/:toolUseId", async (c) => {
	const id = c.req.param("id");
	const toolUseId = c.req.param("toolUseId");
	const tc = await narratorService.getToolCallDetail(id, toolUseId);
	return c.json(tc);
});

// Get compact summary for a specific compact message
narratorRoutes.get("/:id/compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const summary = await narratorService.getCompactSummary(narratorId, messageId);
	return c.json({ summary });
});

// Delete a compact message (undo compact)
narratorRoutes.delete("/:id/compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const result = await narratorService.deleteCompactMessage(narratorId, messageId);
	broadcastToNarrator(narratorId, {
		type: "messages_deleted",
		narratorId,
		deletedMessageIds: [messageId],
	});
	broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
	return c.json({ ok: true, ...result });
});

// Batch-delete multiple content blocks across messages
narratorRoutes.delete("/:id/messages/batch-blocks", async (c) => {
	const narratorId = c.req.param("id");
	const body = await c.req.json();
	const { batchDeleteBlocksSchema } = await import("../lib/validators");
	const { blocks } = batchDeleteBlocksSchema.parse(body);
	const result = await narratorService.deleteMessageBlocks(narratorId, blocks);
	return c.json({ ok: true, ...result });
});

// Delete a single content block from a message
narratorRoutes.delete("/:id/messages/:messageId/blocks/:blockIndex", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const blockIndex = Number.parseInt(c.req.param("blockIndex"), 10);
	if (Number.isNaN(blockIndex) || blockIndex < 0) {
		throw new ValidationError("Invalid block index");
	}
	const result = await narratorService.deleteMessageBlock(narratorId, messageId, blockIndex);
	return c.json({ ok: true, ...result });
});

// Delete a message and all subsequent messages
narratorRoutes.delete("/:id/messages/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const result = await narratorService.deleteMessage(narratorId, messageId);
	return c.json({ ok: true, ...result });
});

// Dismiss a single error system message
narratorRoutes.delete("/:id/error-messages/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	await narratorService.dismissErrorMessage(narratorId, messageId);
	return c.json({ ok: true });
});

// Update a compact message summary
narratorRoutes.patch("/:id/compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const { summary } = await c.req.json();
	if (!summary || typeof summary !== "string") throw new ValidationError("summary is required");
	await narratorService.updateCompactSummary(narratorId, messageId, summary);
	return c.json({ ok: true });
});

// Trigger manual compact
narratorRoutes.post("/:id/compact", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const body = await c.req.json().catch(() => ({}));
	const beforeMessageId = body.beforeMessageId ?? undefined;

	if (isCompactInProgress(narratorId)) {
		return c.json({ ok: false, reason: "compact_in_progress" }, 409);
	}

	// Fire-and-forget — compact may take a while (AI summary generation).
	// compact_done / compact_failed are broadcast from doRunCustomCompact itself.
	runCustomCompact(narratorId, locale, beforeMessageId).catch((err) => {
		logger.error("Manual compact failed", { narratorId, err: String(err) });
	});
	return c.json({ ok: true });
});

// Cancel an in-progress compact — aborts the summary-model request and rolls
// back the placeholder marker. Rollback + WS broadcasts happen inside
// doRunCustomCompact's abort branch once the aborted request rejects.
narratorRoutes.post("/:id/compact/cancel", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const cancelled = cancelCompact(narratorId);
	if (!cancelled) {
		return c.json({ ok: false, reason: "no_compact_in_progress" }, 409);
	}
	return c.json({ ok: true });
});

// Clear context — insert an empty compact marker so subsequent queries start fresh.
// When `beforeMessageId` is provided, the marker is positioned before that message
// (discarding earlier context up to that point); otherwise it is appended at the end.
narratorRoutes.post("/:id/clear-context", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const body = await c.req.json().catch(() => ({}));
	const beforeMessageId = body.beforeMessageId ?? undefined;
	const msg = beforeMessageId
		? await narratorService.clearContextBefore(narratorId, beforeMessageId)
		: await narratorService.clearContext(narratorId);
	resetActiveUpstreamSession(narratorId);
	broadcastToNarrator(narratorId, { type: "message", narratorId, message: msg });
	broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
	return c.json({ ok: true, messageId: msg.id });
});

// Create a plan compact message
narratorRoutes.post("/:id/plan", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const { content } = await c.req.json();
	if (!content || typeof content !== "string") throw new ValidationError("content is required");
	const msg = await narratorService.persistPlanMessage(narratorId, content);
	return c.json(msg);
});

// === Segment compact routes ===

// Trigger segment compact for selected messages
narratorRoutes.post("/:id/segment-compact", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const body = await c.req.json();
	const parsed = segmentCompactSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { messageIds } = parsed.data;

	if (isCompactInProgress(narratorId)) {
		return c.json({ ok: false, reason: "compact_in_progress" }, 409);
	}

	runSegmentCompact(narratorId, locale, messageIds).catch((err) => {
		logger.error("Segment compact failed", { narratorId, err: String(err) });
	});
	return c.json({ ok: true });
});

// Get segment compact summary
narratorRoutes.get("/:id/segment-compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const summary = await narratorService.getSegmentCompactSummary(narratorId, messageId);
	return c.json({ summary });
});

// Get messages hidden by a segment compact
narratorRoutes.get("/:id/segment-compact/:messageId/messages", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const messages = await narratorService.getSegmentCompactHiddenMessages(narratorId, messageId);
	return c.json({ messages });
});

// Delete segment compact (undo)
narratorRoutes.delete("/:id/segment-compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	await narratorService.deleteSegmentCompact(narratorId, messageId);
	broadcastToNarrator(narratorId, {
		type: "messages_deleted",
		narratorId,
		deletedMessageIds: [messageId],
	});
	broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
	return c.json({ ok: true });
});

// Update segment compact summary
narratorRoutes.patch("/:id/segment-compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const body = await c.req.json();
	const parsed = updateSegmentCompactSummarySchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	await narratorService.updateSegmentCompactSummary(narratorId, messageId, parsed.data.summary);
	return c.json({ ok: true });
});

// Interrupt active session
narratorRoutes.post("/:id/interrupt", async (c) => {
	const id = c.req.param("id");
	let interrupted = interruptNarrator(id);
	if (!interrupted) {
		// Fallback: the UI Stop button should hard-stop foreground/background subagents.
		// The soft foreground interrupt is still used by Send({ doInterrupt: true }).
		const { cancelBackgroundTask, interruptForegroundSubagent } = await import(
			"../services/narrator-subagent"
		);
		interrupted = interruptForegroundSubagent(id, { hard: true });
		if (!interrupted) {
			interrupted = await cancelBackgroundTask(id);
		}
	}
	// Fallback: if no active loop found but DB status is still working/waiting,
	// the narrator is a zombie (loop ended without updating status, e.g. after
	// hot reload or unhandled error). Force-reset to interrupted.
	if (!interrupted) {
		const narrator = await narratorService.getById(id);
		if (narrator.status === "working" || narrator.status === "waiting") {
			await narratorService.updateStatus(id, "idle", { substatus: ["interrupted"] });
			interrupted = true;
		}
	}
	return c.json({ interrupted });
});

// Detach a foreground subagent to background mode (zero-interrupt)
narratorRoutes.post("/:id/detach", async (c) => {
	const id = c.req.param("id");
	const { detachSubagent } = await import("../services/narrator-subagent");
	const detached = await detachSubagent(id);
	if (!detached) {
		return c.json({ error: "Subagent is not running in foreground mode" }, 400);
	}
	return c.json({ detached: true });
});

// Update the conclusion of an already-completed subagent.
// The user continued operating the subagent from its page and wants to
// push the new result back to the parent narrator's tool_call outputJson.
// If the subagent is in manual_override state (parent blocked waiting),
// this resolves the blocked Promise so the parent narrator resumes.
narratorRoutes.post("/:id/update-conclusion", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);

	if (!isSubagentVariant(narrator.variant)) {
		return c.json({ error: "Not a subagent" }, 400);
	}
	if (!narrator.parentNarratorId) {
		return c.json({ error: "No parent narrator" }, 400);
	}

	// Find the tool_use that spawned this subagent by looking at the subagent's
	// first user message's parentToolUseId
	const firstMsg = await db.query.narratorMessages.findFirst({
		where: and(
			eq(narratorMessages.narratorId, id),
			eq(narratorMessages.role, "user"),
			isNotNull(narratorMessages.parentToolUseId),
		),
		columns: { parentToolUseId: true },
		orderBy: narratorMessages.createdAt,
	});
	if (!firstMsg?.parentToolUseId) {
		return c.json({ error: "Cannot find parent tool_use" }, 400);
	}
	const toolUseId = firstMsg.parentToolUseId;

	const { getSubagentFinalText } = await import("../services/narrator-session");
	const finalText = await getSubagentFinalText(id);
	const hasError = narrator.substatus?.includes("error") ?? false;

	// Check if the parent is blocked in manual_override — if so, resolve
	// the Promise directly. The parent's runSubagent/continueSubagent will
	// handle finalizeSubagent and tool_call updates when it resumes.
	const { isManualOverride, resolveManualOverride } = await import("../services/narrator-subagent");
	if (isManualOverride(id)) {
		resolveManualOverride(id, finalText, hasError);
		return c.json({ ok: true, toolUseId });
	}

	// Not in manual_override — update the tool_call outputJson directly
	// (existing behavior for already-completed subagents).
	// Find the tool_call record
	const tc = await narratorService.getToolCallByToolUseId(toolUseId);
	if (!tc?.messageId) {
		return c.json({ error: "Tool call not found" }, 400);
	}

	// Fork detection: check if the parent's assistant message is shared.
	// After copy-on-write, track the new messageId so updateToolCallResult
	// only updates the private copy (not the original shared record).
	const isShared = await narratorService.isMessageSharedByMultipleNarrators(tc.messageId);
	let privateMessageId: string | undefined;
	if (isShared) {
		privateMessageId = await narratorService.copyOnWriteToolCallMessage(
			narrator.parentNarratorId,
			tc.messageId,
			toolUseId,
		);
	}

	const { updateToolCallConclusion } = await import("../services/narrator-session");
	await updateToolCallConclusion({
		subagentId: id,
		parentNarratorId: narrator.parentNarratorId,
		toolUseId,
		finalText,
		hasError,
		messageId: privateMessageId,
	});

	return c.json({ ok: true, toolUseId });
});

// User left the narrator page — reset interrupted status to idle
narratorRoutes.post("/:id/leave", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (narrator?.substatus?.includes("interrupted")) {
		await narratorService.updateStatus(id, "idle", { substatus: [] });
	}
	return c.json({ ok: true });
});

// Update model
narratorRoutes.patch("/:id/model", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorModelSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	await narratorService.getById(id); // ensure exists
	await narratorService.updateModel(id, parsed.data.model);
	await updateNarratorModel(id, parsed.data.model);
	return c.json({ ok: true });
});

// Update permission mode
narratorRoutes.patch("/:id/permission-mode", async (c) => {
	const id = c.req.param("id");
	const { permissionMode } = await c.req.json();
	if (!isPermissionMode(permissionMode)) {
		throw new ValidationError(`permissionMode must be one of: ${PERMISSION_MODES.join(", ")}`);
	}
	const narrator = await narratorService.getById(id);

	// Ask-in-passing narrators are locked to readOnly until promoted
	if (hasTrait(parseTraits(narrator.traits), "ask-in-passing")) {
		throw new ValidationError(
			"Cannot change permission mode of an ask-in-passing narrator. Use promote to unlock.",
		);
	}

	await narratorService.updatePermissionMode(id, permissionMode);
	await updateNarratorPermissionMode(id, permissionMode);

	// When switching to bypassPermissions, re-run pending permission requests for
	// this narrator and its subagents. Do not blindly approve: the normal pipeline
	// must still detect fatal/blacklisted/dangerous operations and trigger danger reflection.
	if (permissionMode === "bypassPermissions") {
		reprocessAllPendingPermissions(id);
	}

	return c.json({ ok: true });
});

// Enter plan mode as a narrator trait (not a permission mode)
narratorRoutes.post("/:id/plan-mode/enter", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const planState = await enterNarratorPlanMode(id);
	const active = activeNarrators.get(id);
	if (active) {
		active._planFileId = planState.planFileId;
		active._previousPermissionMode = planState.previousPermissionMode;
	}
	if (planState.wasPlanMode) {
		return c.json({ ok: true, planMode: true, traits: publicTraitsResponse(planState.traits) });
	}

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const toolUseId = `toolu_manual_${generateShortId()}`;
	const msg = await narratorService.persistAssistantMessage(id, {
		uuid: randomUUID(),
		session_id: randomUUID(),
		parent_tool_use_id: null,
		message: {
			content: [
				{
					type: "tool_use",
					id: toolUseId,
					name: "EnterPlanMode",
					input: {},
				},
			],
		},
	});
	await narratorService.updateToolCallResult(toolUseId, {
		output: getToolMessage("enterPlanModeOutput", locale as Locale),
		status: "success",
		// The following message broadcast already accounts for this persisted tool state.
		bumpMessageVersion: false,
	});
	const fullMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, msg.id),
		with: { toolCalls: true },
	});
	if (fullMsg) {
		broadcastToNarrator(id, {
			type: "message",
			narratorId: id,
			message: { ...fullMsg, seq: msg.seq },
		});
	}
	broadcastToNarrator(id, {
		type: "plan_mode_changed",
		narratorId: id,
		planMode: true,
		traits: publicTraitsResponse(planState.traits),
	});
	return c.json({ ok: true, planMode: true, traits: publicTraitsResponse(planState.traits) });
});

// Cancel plan mode trait without changing the narrator's permission policy.
narratorRoutes.post("/:id/plan-mode/exit", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const userId = c.get("user").sub;
	const locale = (await getUserLanguage(userId)) as Locale;
	const message = getToolMessage("planModeCancelled", locale);
	const cancelledPermissions = await cancelPendingExitPlanMode(id, message);
	const planState = await exitNarratorPlanMode(id);
	const active = activeNarrators.get(id);
	if (active) {
		active._planFileId = undefined;
		active._previousPermissionMode = undefined;
	}
	planModeAskedOnce.delete(id);

	if (!planState.wasPlanMode && cancelledPermissions === 0) {
		return c.json({ ok: true, planMode: false, traits: publicTraitsResponse(planState.traits) });
	}

	const msg = await narratorService.persistSystemMessage(id, message, undefined, userId);
	broadcastToNarrator(id, {
		type: "message",
		narratorId: id,
		message: msg,
	});
	broadcastToNarrator(id, {
		type: "plan_mode_changed",
		narratorId: id,
		planMode: false,
		traits: publicTraitsResponse(planState.traits),
	});
	return c.json({
		ok: true,
		planMode: false,
		traits: publicTraitsResponse(planState.traits),
		cancelledPermissions,
	});
});

// Update reasoning effort
narratorRoutes.patch("/:id/reasoning-effort", async (c) => {
	const id = c.req.param("id");
	const { reasoningEffort } = await c.req.json();
	const validEfforts = ["none", "low", "medium", "high", "xhigh", "max"];
	if (
		reasoningEffort !== null &&
		reasoningEffort !== undefined &&
		!validEfforts.includes(reasoningEffort)
	) {
		throw new ValidationError(`reasoningEffort must be one of: ${validEfforts.join(", ")} or null`);
	}
	await narratorService.getById(id); // ensure exists
	await narratorService.updateReasoningEffort(id, reasoningEffort);
	updateNarratorReasoningEffort(id, reasoningEffort ?? null);
	return c.json({ ok: true });
});

// Update fast mode
narratorRoutes.patch("/:id/fast-mode", async (c) => {
	const id = c.req.param("id");
	const { fastMode } = await c.req.json();
	if (typeof fastMode !== "boolean") {
		throw new ValidationError("fastMode must be a boolean");
	}
	await narratorService.getById(id); // ensure exists
	await narratorService.updateFastMode(id, fastMode);
	return c.json({ ok: true });
});

// Update relaxed plan toggle
narratorRoutes.patch("/:id/relaxed-plan", async (c) => {
	const id = c.req.param("id");
	const { relaxedPlan } = await c.req.json();
	if (typeof relaxedPlan !== "boolean") {
		throw new ValidationError("relaxedPlan must be a boolean");
	}
	await narratorService.getById(id); // ensure exists
	await narratorService.updateRelaxedPlan(id, relaxedPlan);
	broadcastToNarrator(id, { type: "relaxed_plan_changed", narratorId: id, relaxedPlan });
	return c.json({ ok: true });
});

// Update per-session reflection overrides
narratorRoutes.patch("/:id/reflection-overrides", async (c) => {
	const id = c.req.param("id");
	const body = (await c.req.json()) as unknown;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new ValidationError("Request body must be an object");
	}
	const input = body as Record<string, unknown>;
	const updates: {
		planReflectionAutoApproveOverride?: BooleanOverride;
		dangerReflectionOverride?: DangerReflectionOverride;
	} = {};
	if (Object.hasOwn(input, "planReflectionAutoApproveOverride")) {
		updates.planReflectionAutoApproveOverride = parseBooleanOverride(
			input.planReflectionAutoApproveOverride,
			"planReflectionAutoApproveOverride",
		);
	}
	if (Object.hasOwn(input, "dangerReflectionOverride")) {
		updates.dangerReflectionOverride = parseDangerReflectionOverride(
			input.dangerReflectionOverride,
			"dangerReflectionOverride",
		);
	}
	if (!updates.planReflectionAutoApproveOverride && !updates.dangerReflectionOverride) {
		throw new ValidationError("At least one reflection override must be provided");
	}
	await narratorService.getById(id);
	await narratorService.updateReflectionOverrides(id, updates);
	broadcastToNarrator(id, { type: "reflection_overrides_changed", narratorId: id, ...updates });
	return c.json({ ok: true });
});

// Update prune enabled
narratorRoutes.patch("/:id/prune-enabled", async (c) => {
	const id = c.req.param("id");
	const { pruneEnabled } = await c.req.json();
	if (typeof pruneEnabled !== "boolean") {
		throw new ValidationError("pruneEnabled must be a boolean");
	}
	await narratorService.getById(id);
	await narratorService.updatePruneEnabled(id, pruneEnabled);
	return c.json({ ok: true });
});

// Update narrator title
narratorRoutes.patch("/:id/title", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorTitleSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	await narratorService.getById(id);
	await persistTitle(id, parsed.data.title);
	return c.json({ ok: true, title: parsed.data.title });
});

// Assign, change, or clear a narrator's @handle (named narrator). null clears it.
narratorRoutes.patch("/:id/handle", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorHandleSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const updated = await narratorService.setHandle(id, parsed.data.handle);
	return c.json(publicNarratorResponse(updated));
});

// Update narrator working directory
narratorRoutes.patch("/:id/cwd", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorCwdSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const cwd = parsed.data.cwd.trim();
	if (!isAbsolute(cwd)) {
		throw new ValidationError("cwd must be an absolute path");
	}

	// Validate path exists and is accessible
	try {
		const { access, constants } = await import("node:fs/promises");
		await access(cwd, constants.R_OK | constants.X_OK);
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Working directory does not exist or is not accessible";
		throw new ValidationError(message);
	}

	const narrator = await narratorService.getById(id);
	const previousCwd = narrator.cwd?.trim() || null;
	if (previousCwd === cwd) {
		return c.json({ ok: true, cwd, changed: false });
	}

	await narratorService.updateCwd(id, cwd);
	await updateActiveNarratorCwdAndSkillContext(id, cwd);

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const reminder =
		locale === "zh-CN"
			? previousCwd
				? `工作目录已更新：${previousCwd} → ${cwd}`
				: `工作目录已设置为：${cwd}`
			: previousCwd
				? `Working directory updated: ${previousCwd} → ${cwd}`
				: `Working directory set to: ${cwd}`;
	await narratorService.persistDisplayMessage(id, reminder);

	return c.json({ ok: true, cwd, changed: true });
});

// Regenerate narrator title via AI
narratorRoutes.post("/:id/generate-title", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const title = await generateTitle(id, locale);
	await persistTitle(id, title);
	return c.json({ title });
});

// Archive narrator
narratorRoutes.patch("/:id/archive", async (c) => {
	const id = c.req.param("id");
	if (isNarratorActive(id)) closeNarrator(id);
	await narratorService.getById(id);
	await narratorService.updateStatus(id, "archived");
	return c.json({ ok: true });
});

// Unarchive narrator
narratorRoutes.patch("/:id/unarchive", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	await narratorService.updateStatus(id, "idle");
	return c.json({ ok: true });
});

// Delete narrator (must be archived)
narratorRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (narrator.status !== "archived") {
		throw new ValidationError("Only archived narrators can be deleted");
	}
	if (isNarratorActive(id)) closeNarrator(id);
	await narratorService.remove(id);
	return c.json({ ok: true });
});

// Mark narrator as read (clear unread substatus)
// Error sessions are preserved because only unread substatus can transition.
// Subagents are skipped — their done/error status must be preserved for follow-up Send.
narratorRoutes.patch("/:id/mark-read", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (isSubagentVariant(narrator.variant)) return c.json({ ok: true });
	const currentSubstatus = parseSubstatus(narrator.substatus);
	if (narrator.status === "idle" && currentSubstatus.includes("unread") && !narrator.errorMessage) {
		// Only remove the unread tag. Other tags (e.g. compacting/suspended/manual_override)
		// can coexist with unread and must not be clobbered by a read acknowledgement.
		await narratorService.removeSubstatus(id, "unread");
	}
	return c.json({ ok: true });
});

// Fork: create a new standalone narrator containing only the specified messages
narratorRoutes.post("/:id/fork-messages", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const { forkFromMessagesSchema } = await import("../lib/validators");
	const parsed = forkFromMessagesSchema.parse(body);
	const newNarrator = await narratorService.forkFromMessages(id, parsed.messageIds, {
		title: parsed.title,
	});
	return c.json(publicNarratorResponse(newNarrator), 201);
});

// Fork standalone narrator (chapter-bound narrators must fork via chapter fork)
narratorRoutes.post("/:id/fork", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const parsed = forkNarratorSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const newNarrator = await narratorService.forkNarrator(id, parsed.data.forkMessageUuid, {
		title: parsed.data.title,
		inheritMode: parsed.data.inheritMode ?? "full",
	});
	return c.json(publicNarratorResponse(newNarrator), 201);
});

// === Ask in passing ===

type AskInPassingPendingBlock = {
	type: "ask_in_passing";
	status: "pending";
	sourceMessageId?: string;
	sourceMessageUuid?: string | null;
};

const ASK_IN_PASSING_CONTENT_PREFIX = "[Ask in passing]";

function buildAskInPassingContentText(question?: string): string {
	const trimmedQuestion = question?.trim();
	return trimmedQuestion
		? `${ASK_IN_PASSING_CONTENT_PREFIX} ${trimmedQuestion}`
		: ASK_IN_PASSING_CONTENT_PREFIX;
}

function getAskInPassingPendingBlock(
	message: { role: string; contentJson: unknown } | null | undefined,
): AskInPassingPendingBlock | null {
	if (!message || message.role !== "system" || !Array.isArray(message.contentJson)) {
		return null;
	}

	for (const block of message.contentJson) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as Record<string, unknown>;
		if (candidate.type === "ask_in_passing" && candidate.status === "pending") {
			return candidate as AskInPassingPendingBlock;
		}
	}

	return null;
}

// Start: create a persistent pending message in the source narrator's chat
narratorRoutes.post("/:id/ask-in-passing/start", async (c) => {
	const id = c.req.param("id");
	const userId = c.get("user").sub;
	const body = await c.req.json();
	const parsed = askInPassingStartSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const { sourceMessageId, sourceMessageUuid } = parsed.data;

	// Verify the source message belongs to this narrator and capture its position.
	const ref = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, id),
			eq(narratorMessageRefs.messageId, sourceMessageId),
		),
		columns: { seq: true },
	});
	if (!ref) throw new ValidationError("Source message not found in this narrator");

	const now = new Date().toISOString();
	const msgId = generateId();
	const msg = await db.transaction(async (tx) => {
		const [insertedMsg] = await tx
			.insert(narratorMessages)
			.values({
				id: msgId,
				narratorId: id,
				role: "system",
				contentJson: [
					{
						type: "ask_in_passing",
						status: "pending",
						sourceMessageId,
						sourceMessageUuid: sourceMessageUuid ?? null,
					},
				],
				contentText: buildAskInPassingContentText(),
				createdBy: userId,
				createdAt: now,
			})
			.returning();

		const insertSeq = ref.seq + 1;
		await tx
			.update(narratorMessageRefs)
			.set({ seq: sql`${narratorMessageRefs.seq} + 1` })
			.where(and(eq(narratorMessageRefs.narratorId, id), gte(narratorMessageRefs.seq, insertSeq)));

		await tx.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId: id,
			messageId: msgId,
			seq: insertSeq,
		});

		await tx
			.update(narrators)
			.set({ messageVersion: sql`${narrators.messageVersion} + 1` })
			.where(eq(narrators.id, id));

		return { ...insertedMsg, seq: insertSeq };
	});

	// Broadcast so the UI updates in real-time
	broadcastToNarrator(id, {
		type: "message",
		narratorId: id,
		message: msg,
	});

	return c.json({ messageId: msgId }, 201);
});

// Resolve: fork + send question + update pending message to resolved
narratorRoutes.post("/:id/ask-in-passing", async (c) => {
	const id = c.req.param("id");
	const userId = c.get("user").sub;
	const body = await c.req.json();
	const parsed = askInPassingSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const { question, pendingMessageId } = parsed.data;

	// Verify the pending message exists, belongs to this narrator, and is still pending
	const pendingMsg = await db.query.narratorMessages.findFirst({
		where: and(eq(narratorMessages.id, pendingMessageId), eq(narratorMessages.narratorId, id)),
	});
	const pendingBlock = getAskInPassingPendingBlock(pendingMsg);
	if (!pendingMsg || !pendingBlock) {
		throw new ValidationError("Pending ask-in-passing message not found");
	}

	const sourceMessageId = pendingBlock.sourceMessageId;
	const sourceMessageUuid = pendingBlock.sourceMessageUuid ?? null;
	if (!sourceMessageId && !sourceMessageUuid) {
		throw new ValidationError("Pending ask-in-passing message is missing source reference");
	}

	// Auto-generate title from the question (truncate to 80 chars, take first line)
	const title = question.replace(/\n.*/s, "").slice(0, 80);

	// Fork narrator from the source recorded in the pending card (single source of truth)
	const newNarrator = await narratorService.forkNarrator(id, sourceMessageUuid, {
		inheritMode: "full",
		forkMessageId: sourceMessageId,
		title,
		standalone: true,
	});

	// Lock to readOnly + mark as ask-in-passing (user can "promote" later to unlock)
	const aipTraits = addTrait(parseTraits(newNarrator.traits), "ask-in-passing");
	await db
		.update(narrators)
		.set({ permissionMode: "readOnly", isAskInPassing: true, traits: aipTraits })
		.where(eq(narrators.id, newNarrator.id));

	// Send the user's question to the new narrator
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);
	await sendMessage(newNarrator.id, question, [], locale, replyInUserLanguage, userId);

	// Update the pending message to resolved
	const resolvedContentJson = [
		{
			type: "ask_in_passing",
			status: "resolved",
			sourceMessageId: sourceMessageId ?? null,
			question,
			targetNarratorId: newNarrator.id,
			createdAt: new Date().toISOString(),
		},
	];
	const resolvedContentText = buildAskInPassingContentText(question);
	const updatedMsg = await db.transaction(async (tx) => {
		await tx
			.update(narratorMessages)
			.set({ contentJson: resolvedContentJson, contentText: resolvedContentText })
			.where(eq(narratorMessages.id, pendingMessageId));

		await tx
			.update(narrators)
			.set({ messageVersion: sql`${narrators.messageVersion} + 1` })
			.where(eq(narrators.id, id));

		return {
			...pendingMsg,
			contentJson: resolvedContentJson,
			contentText: resolvedContentText,
		};
	});

	// Broadcast the update
	broadcastToNarrator(id, {
		type: "message_updated",
		narratorId: id,
		message: updatedMsg,
	});

	return c.json(publicNarratorResponse(newNarrator), 201);
});

// Cancel: delete a pending message
narratorRoutes.delete("/:id/ask-in-passing/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");

	// Verify the message exists and is a pending ask-in-passing
	const msg = await db.query.narratorMessages.findFirst({
		where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)),
	});
	if (!msg || !getAskInPassingPendingBlock(msg)) {
		throw new ValidationError("Pending ask-in-passing message not found");
	}

	await db.transaction(async (tx) => {
		await tx
			.delete(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
			);

		const otherRef = await tx.query.narratorMessageRefs.findFirst({
			where: eq(narratorMessageRefs.messageId, messageId),
		});
		if (!otherRef) {
			await tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId));
		}

		await tx
			.update(narrators)
			.set({ messageVersion: sql`${narrators.messageVersion} + 1` })
			.where(eq(narrators.id, narratorId));
	});

	// Broadcast deletion
	broadcastToNarrator(narratorId, {
		type: "messages_deleted",
		narratorId,
		deletedMessageIds: [messageId],
	});

	return c.json({ ok: true });
});

// === Promote ask-in-passing narrator ===
// Standalone: unlock permission mode (readOnly → default)
// Chapter-bound: fork a new chapter from the parent chapter
narratorRoutes.post("/:id/promote", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);

	const narratorTraits = parseTraits(narrator.traits);

	if (!hasTrait(narratorTraits, "ask-in-passing")) {
		throw new ValidationError("Only ask-in-passing narrators can be promoted");
	}

	if (!narrator.chapterId) {
		// Standalone narrator: just unlock
		await narratorTraitsLock.acquire(id, async () => {
			const current = await narratorService.getById(id);
			const unlockedTraits = removeTrait(parseTraits(current.traits), "ask-in-passing");
			await db
				.update(narrators)
				.set({
					isAskInPassing: false,
					traits: unlockedTraits,
					permissionMode: "default",
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, id));
		});

		await updateNarratorPermissionMode(id, "default");

		const updated = await narratorService.getById(id);
		broadcastToNarrator(id, {
			type: "permission_mode_changed",
			narratorId: id,
			permissionMode: "default",
		});

		return c.json({ type: "unlocked", narrator: publicNarratorResponse(updated) });
	}

	// Chapter-bound narrator: fork a new chapter
	const chapter = await chapterFork.fork(narrator.chapterId, {
		inheritMode: "full",
	});

	// Mark the original ask-in-passing narrator as promoted so the UI
	// no longer shows it as locked.  We keep permissionMode as readOnly
	// since the original narrator stays as a read-only question record.
	await narratorTraitsLock.acquire(id, async () => {
		const current = await narratorService.getById(id);
		const promotedTraits = removeTrait(parseTraits(current.traits), "ask-in-passing");
		await db
			.update(narrators)
			.set({
				isAskInPassing: false,
				traits: promotedTraits,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(narrators.id, id));
	});

	return c.json({ type: "forked", chapter });
});

// Get pending permissions
narratorRoutes.get("/:id/permissions", async (c) => {
	const id = c.req.param("id");
	const permissions = await narratorService.getPendingPermissions(id);
	return c.json(permissions);
});

// Approve permission
narratorRoutes.post("/permissions/:requestId/approve", async (c) => {
	const requestId = c.req.param("requestId");
	const userId = c.get("user").sub;
	const body = await c.req.json().catch(() => ({}));
	const parsed = permissionDecisionSchema.safeParse({ decision: "allow", ...body });
	const resolved = await resolvePermissionOrDangerReflection(requestId, "allow", {
		answers: parsed.success ? parsed.data.answers : undefined,
		feedbackText: parsed.success ? parsed.data.feedbackText : undefined,
		compactAfter: parsed.success ? parsed.data.compactAfter : undefined,
		updatedPlan: parsed.success ? parsed.data.updatedPlan : undefined,
		userId,
		decidedBy: "user",
	});
	if (!resolved) return c.json({ error: "Permission request not found" }, 404);
	return c.json({ ok: true });
});

// Deny permission
narratorRoutes.post("/permissions/:requestId/deny", async (c) => {
	const requestId = c.req.param("requestId");
	const body = await c.req.json().catch(() => ({}));
	const parsed = permissionDecisionSchema.safeParse({ decision: "deny", ...body });
	const resolved = await resolvePermissionOrDangerReflection(requestId, "deny", {
		denyMessage: parsed.success ? parsed.data.message : undefined,
		answers: parsed.success ? parsed.data.answers : undefined,
		feedbackText: parsed.success ? parsed.data.feedbackText : undefined,
		updatedPlan: parsed.success ? parsed.data.updatedPlan : undefined,
		decidedBy: "user",
	});
	if (!resolved) return c.json({ error: "Permission request not found" }, 404);
	return c.json({ ok: true });
});

// Run AskUserQuestion reflection immediately and submit the generated answers
narratorRoutes.post("/permissions/:requestId/reflect-question", async (c) => {
	const requestId = c.req.param("requestId");
	const result = await reflectPendingAskUserQuestion(requestId);
	if (!result.ok) {
		return c.json({ error: result.reason ?? "Question reflection request not found" }, 404);
	}
	return c.json({ ok: true, answers: result.answers ?? {} });
});

// Stop automatic danger reflection but leave the tool permission pending for user decision
narratorRoutes.post("/permissions/:requestId/stop-reflection", async (c) => {
	const requestId = c.req.param("requestId");
	const body = await c.req.json().catch(() => ({}));
	const reason = typeof body.reason === "string" ? body.reason : undefined;
	const stopped = await stopDangerReflectionLoop(requestId, reason);
	if (!stopped) return c.json({ error: "Danger reflection request not found" }, 404);
	return c.json({ ok: true });
});

// Stop automatic plan reflection and fall back to the normal ExitPlanMode approval request
narratorRoutes.post("/permissions/:requestId/stop-plan-reflection", async (c) => {
	const requestId = c.req.param("requestId");
	const body = await c.req.json().catch(() => ({}));
	const reason = typeof body.reason === "string" ? body.reason : undefined;
	const stopped = await takeOverExitPlanReflection(requestId, reason);
	if (!stopped) return c.json({ error: "Plan reflection request not found" }, 404);
	return c.json({ ok: true });
});

// Suggest best-practice answers for AskUserQuestion
narratorRoutes.post("/:id/suggest-answers", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	const userId = c.get("user").sub;
	const locale = (await getUserLanguage(userId)) as Locale;

	const body = await c.req.json();
	const parsed = suggestAnswersSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { questions } = parsed.data;
	const answers = await generateAskUserQuestionAnswers(id, questions, {
		locale,
		model: narrator.model,
		mode: "suggest",
	});

	return c.json({ answers });
});

// === Snapshot / Patch routes ===

/** List file snapshots for a narrator */
narratorRoutes.get("/:id/patches", async (c) => {
	const narratorId = c.req.param("id");

	const snapshots = await db.query.narratorFileSnapshots.findMany({
		where: eq(narratorFileSnapshots.narratorId, narratorId),
		orderBy: asc(narratorFileSnapshots.createdAt),
	});

	return c.json(snapshots);
});

/** Get the diff for a specific file snapshot (original vs current rebuilt state) */
narratorRoutes.get("/:id/patches/:patchId/diff", async (c) => {
	const narratorId = c.req.param("id");
	const patchId = c.req.param("patchId");
	const upToMessageId = c.req.query("upToMessageId");
	const fromMessageId = c.req.query("fromMessageId");

	const snap = await db.query.narratorFileSnapshots.findFirst({
		where: and(
			eq(narratorFileSnapshots.id, patchId),
			eq(narratorFileSnapshots.narratorId, narratorId),
		),
	});
	if (!snap) return c.json({ error: "Snapshot not found" }, 404);

	// Resolve "from" boundary: file state at fromMessageId (used as the diff base)
	let originalContent: string | null;
	if (fromMessageId) {
		const fromRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, fromMessageId),
			),
			columns: { seq: true },
		});
		if (fromRef) {
			const states = await rebuildFileStatesUpToSeq(narratorId, fromRef.seq);
			originalContent = states.get(snap.filePath) ?? snap.originalContent;
		} else {
			return c.json({ error: "fromMessageId not found in this narrator" }, 404);
		}
	} else {
		originalContent = snap.originalContent;
	}

	// Resolve "to" boundary: file state at upToMessageId (or current)
	let currentContent: string | null;
	if (upToMessageId) {
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, upToMessageId),
			),
			columns: { seq: true },
		});
		if (ref) {
			const states = await rebuildFileStatesUpToSeq(narratorId, ref.seq);
			currentContent = states.get(snap.filePath) ?? snap.originalContent;
		} else {
			return c.json({ error: "Message not found in this narrator" }, 404);
		}
	} else {
		currentContent = await rebuildFileState(narratorId, snap.filePath);
	}

	return c.json({
		filePath: snap.filePath,
		original: originalContent,
		current: currentContent,
	});
});

/** Revert file changes from a specific message onwards */
narratorRoutes.post("/:id/revert", async (c) => {
	const narratorId = c.req.param("id");
	const body = await c.req.json<{ messageId: string }>();
	if (!body.messageId) return c.json({ error: "messageId is required" }, 400);

	// Prevent revert while narrator is actively running
	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Cannot revert while narrator is running" }, 409);
	}

	const cwd = await resolveNarratorCwd(narratorId);
	if (!cwd) return c.json({ error: "Narrator has no working directory" }, 400);

	// Find the target message's ref to get its seq
	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, body.messageId),
		),
		columns: { seq: true },
	});
	if (!targetRef) return c.json({ error: "Message not found" }, 404);

	// Find all tool calls at or after the target message
	const toolCallsToRevert = await db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			inputJson: narratorToolCalls.inputJson,
		})
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.status, "success"),
				gte(narratorMessageRefs.seq, targetRef.seq),
			),
		);

	const affectedFiles = getAffectedFiles(toolCallsToRevert);
	if (affectedFiles.length === 0) {
		return c.json({ fileCount: 0, files: [] });
	}

	const excludeIds = new Set(toolCallsToRevert.map((tc) => tc.toolUseId));

	try {
		// Re-check right before mutation
		if (isNarratorActive(narratorId)) {
			return c.json({ error: "Narrator became active during revert" }, 409);
		}

		const fileStates = await rebuildFileStatesExcluding(narratorId, affectedFiles, excludeIds);

		// Write files to disk
		const writtenFiles: string[] = [];

		for (const [filePath, content] of fileStates) {
			const absPath = resolve(cwd, filePath);
			try {
				if (content === null) {
					const file = Bun.file(absPath);
					if (await file.exists()) unlinkSync(absPath);
				} else {
					mkdirSync(dirname(absPath), { recursive: true });
					await Bun.write(absPath, content);
				}
				writtenFiles.push(filePath);
			} catch (err) {
				logger.warn("Failed to write reverted file", { filePath, error: String(err) });
			}
		}

		return c.json({ fileCount: writtenFiles.length, files: writtenFiles });
	} catch (err) {
		return c.json(
			{ error: `Revert failed: ${err instanceof Error ? err.message : String(err)}` },
			500,
		);
	}
});

/** Unrevert — rebuild current (full) file state and write to disk */
narratorRoutes.post("/:id/unrevert", async (c) => {
	const narratorId = c.req.param("id");

	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Cannot unrevert while narrator is running" }, 409);
	}

	const cwd = await resolveNarratorCwd(narratorId);
	if (!cwd) return c.json({ error: "Narrator has no working directory" }, 400);

	try {
		if (isNarratorActive(narratorId)) {
			return c.json({ error: "Narrator became active during unrevert" }, 409);
		}

		// Rebuild full file state (all tool calls included)
		const fileStates = await rebuildFileStatesUpToSeq(narratorId, Number.MAX_SAFE_INTEGER);

		for (const [filePath, content] of fileStates) {
			if (content === null) continue;
			const absPath = resolve(cwd, filePath);
			mkdirSync(dirname(absPath), { recursive: true });
			await Bun.write(absPath, content);
		}

		return c.json({ success: true });
	} catch (err) {
		return c.json(
			{ error: `Restore failed: ${err instanceof Error ? err.message : String(err)}` },
			500,
		);
	}
});

/** Get aggregated file modification summary for a narrator */
narratorRoutes.get("/:id/file-modifications", async (c) => {
	const narratorId = c.req.param("id");
	const upToMessageId = c.req.query("upToMessageId");
	const fromMessageId = c.req.query("fromMessageId");

	const snapshots = await db.query.narratorFileSnapshots.findMany({
		where: eq(narratorFileSnapshots.narratorId, narratorId),
		orderBy: asc(narratorFileSnapshots.createdAt),
	});
	if (snapshots.length === 0) return c.json({ files: [], timeline: [] });

	// Always query all tool calls first to build the timeline
	const allToolCalls = await queryOrderedToolCalls(narratorId);

	// Build timeline from all top-level messages (user + assistant + system)
	// so the frontend can use any message as a range boundary.
	const allRefs = await db
		.select({
			messageId: narratorMessageRefs.messageId,
			seq: narratorMessageRefs.seq,
			role: narratorMessages.role,
			createdAt: narratorMessages.createdAt,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(
			and(eq(narratorMessageRefs.narratorId, narratorId), isNull(narratorMessages.parentToolUseId)),
		)
		.orderBy(asc(narratorMessageRefs.seq));

	const timeline: Array<{
		messageId: string;
		createdAt: string;
		seq: number;
		role: string;
		hasEdits: boolean;
	}> = [];
	// Pre-compute which messageIds have file edits
	const editMessageIds = new Set(allToolCalls.map((tc) => tc.messageId));
	for (const ref of allRefs) {
		timeline.push({
			messageId: ref.messageId,
			createdAt: ref.createdAt,
			seq: ref.seq,
			role: ref.role,
			hasEdits: editMessageIds.has(ref.messageId),
		});
	}

	// Resolve seq boundaries for range filtering
	let fromSeq: number | undefined;
	let toSeq: number | undefined;
	if (fromMessageId) {
		const entry = timeline.find((t) => t.messageId === fromMessageId);
		if (entry) fromSeq = entry.seq;
	}
	if (upToMessageId) {
		const entry = timeline.find((t) => t.messageId === upToMessageId);
		if (entry) toSeq = entry.seq;
	}

	// Filter tool calls to the [fromSeq, toSeq] range
	const isRangeFiltered = fromSeq !== undefined || toSeq !== undefined;
	const filteredToolCalls = allToolCalls.filter((tc) => {
		if (fromSeq !== undefined && tc.seq <= fromSeq) return false;
		if (toSeq !== undefined && tc.seq > toSeq) return false;
		return true;
	});

	const grouped = groupByFile(filteredToolCalls);

	const files = snapshots
		.map((snap) => {
			const ops = grouped.get(snap.filePath) ?? [];
			if (isRangeFiltered && ops.length === 0) return null; // hide files with no ops in filtered mode
			return {
				filePath: snap.filePath,
				snapshotId: snap.id,
				originalExists: snap.originalContent !== null,
				editCount: ops.length,
				lastModifiedAt: ops.length > 0 ? ops[ops.length - 1].createdAt : snap.createdAt,
				operations: ops.map((op) => ({
					toolUseId: op.toolUseId,
					toolName: op.toolName,
					messageId: op.messageId,
					createdAt: op.createdAt,
				})),
			};
		})
		.filter(Boolean);

	return c.json({ files, timeline });
});

/** Revert a single file to its original state (before narrator touched it) */
narratorRoutes.post("/:id/revert-file", async (c) => {
	const narratorId = c.req.param("id");
	const body = await c.req.json<{ filePath: string }>();
	if (!body.filePath) return c.json({ error: "filePath is required" }, 400);

	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Cannot revert while narrator is running" }, 409);
	}

	const cwd = await resolveNarratorCwd(narratorId);
	if (!cwd) return c.json({ error: "Narrator has no working directory" }, 400);

	const snap = await db.query.narratorFileSnapshots.findFirst({
		where: and(
			eq(narratorFileSnapshots.narratorId, narratorId),
			eq(narratorFileSnapshots.filePath, body.filePath),
		),
		columns: { originalContent: true },
	});
	if (!snap) return c.json({ error: "No snapshot found for this file" }, 404);

	try {
		if (isNarratorActive(narratorId)) {
			return c.json({ error: "Narrator became active during revert" }, 409);
		}

		const absPath = resolve(cwd, body.filePath);
		if (snap.originalContent === null) {
			// File didn't exist before — delete it
			const file = Bun.file(absPath);
			if (await file.exists()) unlinkSync(absPath);
		} else {
			mkdirSync(dirname(absPath), { recursive: true });
			await Bun.write(absPath, snap.originalContent);
		}

		return c.json({ success: true, originalExists: snap.originalContent !== null });
	} catch (err) {
		return c.json(
			{ error: `Revert failed: ${err instanceof Error ? err.message : String(err)}` },
			500,
		);
	}
});

/** Preview file changes that would be reverted by a rollback-to-block operation */
narratorRoutes.get("/:id/rollback-preview", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.query("messageId");
	const blockIndexStr = c.req.query("blockIndex");
	if (!messageId) return c.json({ error: "messageId query param is required" }, 400);
	if (!blockIndexStr) return c.json({ error: "blockIndex query param is required" }, 400);
	const blockIndex = Number.parseInt(blockIndexStr, 10);
	if (Number.isNaN(blockIndex) || blockIndex < 0) {
		return c.json({ error: "blockIndex must be a non-negative integer" }, 400);
	}

	// Verify narrator exists
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { id: true },
	});
	if (!narrator) return c.json({ error: "Narrator not found" }, 404);

	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
		columns: { seq: true },
	});
	if (!targetRef) return c.json({ error: "Message not found for this narrator" }, 404);

	const targetMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
		columns: { role: true, contentJson: true },
	});
	if (!targetMsg) return c.json({ error: "Message not found" }, 404);

	const blocks = Array.isArray(targetMsg.contentJson)
		? (targetMsg.contentJson as { type: string; id?: string }[])
		: [];
	if (blockIndex >= blocks.length) {
		return c.json({ error: `Block index ${blockIndex} out of range` }, 400);
	}

	const effectiveBlockIndex = normalizeRollbackBlockIndexForMessage(
		targetMsg.role,
		blockIndex,
		blocks.length,
	);

	// Collect tool_use IDs from blocks after the effective boundary in the target message
	const truncatedToolUseIds: string[] = [];
	for (let i = effectiveBlockIndex + 1; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.type === "tool_use" && b.id) {
			truncatedToolUseIds.push(b.id);
		}
	}

	const deletedBlockCount = blocks.length - effectiveBlockIndex - 1;

	// Find tool calls from subsequent messages (seq > targetRef.seq)
	const subsequentToolCalls = await db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			inputJson: narratorToolCalls.inputJson,
		})
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.status, "success"),
				gt(narratorMessageRefs.seq, targetRef.seq),
			),
		);

	// Count subsequent messages
	const subsequentMsgCount = await db
		.select({ cnt: sql<number>`count(*)` })
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				gt(narratorMessageRefs.seq, targetRef.seq),
			),
		);
	const deletedMessageCount = subsequentMsgCount[0]?.cnt ?? 0;

	// Find tool calls from truncated blocks in the target message
	const truncatedToolCalls =
		truncatedToolUseIds.length > 0
			? await db.query.narratorToolCalls.findMany({
					where: and(
						eq(narratorToolCalls.narratorId, narratorId),
						eq(narratorToolCalls.status, "success"),
						inArray(narratorToolCalls.toolUseId, truncatedToolUseIds),
					),
					columns: { toolUseId: true, toolName: true, inputJson: true },
				})
			: [];

	const allToolCalls = [...truncatedToolCalls, ...subsequentToolCalls];
	const affectedFilePaths = getAffectedFiles(allToolCalls);

	if (affectedFilePaths.length === 0) {
		return c.json({
			affectedFiles: [],
			toolCallCount: 0,
			deletedBlockCount,
			deletedMessageCount,
		});
	}

	// Only compute willBeDeleted (skip expensive content rebuild for the modal)
	const revertedStates = await rebuildFileStatesExcluding(
		narratorId,
		affectedFilePaths,
		new Set(allToolCalls.map((tc) => tc.toolUseId)),
	);

	const affectedFiles = affectedFilePaths.map((filePath) => ({
		filePath,
		willBeDeleted: revertedStates.get(filePath) === null,
	}));

	return c.json({
		affectedFiles,
		toolCallCount: allToolCalls.length,
		deletedBlockCount,
		deletedMessageCount,
	});
});

/** Preview file changes that would be reverted if a message is deleted */
narratorRoutes.get("/:id/delete-preview", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.query("messageId");
	if (!messageId) return c.json({ error: "messageId query param is required" }, 400);

	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
		columns: { seq: true },
	});
	if (!targetRef) return c.json({ error: "Message not found" }, 404);

	// Find all tool calls at or after the target message
	const toolCallsToRevert = await db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			inputJson: narratorToolCalls.inputJson,
		})
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.status, "success"),
				gte(narratorMessageRefs.seq, targetRef.seq),
			),
		);

	const affectedFilePaths = getAffectedFiles(toolCallsToRevert);
	if (affectedFilePaths.length === 0) {
		return c.json({ affectedFiles: [], toolCallCount: 0 });
	}

	const excludeIds = new Set(toolCallsToRevert.map((tc) => tc.toolUseId));

	// Current state (all tool calls applied) for affected files only.
	const currentStates = await rebuildFileStatesExcluding(narratorId, affectedFilePaths, new Set());
	// State after revert (excluding deleted tool calls)
	const revertedStates = await rebuildFileStatesExcluding(
		narratorId,
		affectedFilePaths,
		excludeIds,
	);

	const affectedFiles = affectedFilePaths.map((filePath) => ({
		filePath,
		currentContent: currentStates.get(filePath) ?? null,
		revertedContent: revertedStates.get(filePath) ?? null,
		willBeDeleted: revertedStates.get(filePath) === null,
	}));

	return c.json({ affectedFiles, toolCallCount: toolCallsToRevert.length });
});

/** Preview file state for a pending Write/Edit permission request */
narratorRoutes.get("/:id/permission-file-preview", async (c) => {
	const narratorId = c.req.param("id");
	const toolUseId = c.req.query("toolUseId");
	if (!toolUseId) return c.json({ error: "toolUseId query param is required" }, 400);

	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.toolUseId, toolUseId),
		),
		columns: { toolName: true, inputJson: true },
	});
	if (!toolCall) return c.json({ error: "Tool call not found" }, 404);

	const input = toolCall.inputJson as Record<string, unknown> | null;
	const filePath = (input?.file_path as string) ?? null;
	if (!filePath) return c.json({ error: "Tool call has no file_path" }, 400);

	// Rebuild current file state (before this tool call is applied)
	const currentContent = await rebuildFileState(narratorId, filePath);

	// Simulate applying this tool call to get preview
	const fakeOrdered = {
		toolUseId,
		toolName: toolCall.toolName,
		inputJson: toolCall.inputJson,
		status: "success",
		messageId: "",
		seq: 0,
		createdAt: "",
	};
	const previewContent = applyToolCall(currentContent, fakeOrdered);

	return c.json({
		filePath,
		currentContent,
		previewContent,
		toolName: toolCall.toolName,
		inputJson: toolCall.inputJson,
	});
});

// === Background task routes ===

/**
 * GET /api/narrators/:id/background-tasks
 * List all background tasks spawned by this narrator.
 */
narratorRoutes.get("/:id/background-tasks", async (c) => {
	const parentNarratorId = c.req.param("id");
	const { backgroundTaskService } = await import("../services/background-task-service");
	const tasks = await backgroundTaskService.listByParent(parentNarratorId);

	// Also include legacy agent background tasks from narrators table
	// (for tasks created before the migration)
	const legacyTasks = await db
		.select({
			id: narrators.id,
			subagentType: narrators.subagentType,
			backgroundStatus: narrators.backgroundStatus,
			backgroundResult: narrators.backgroundResult,
			backgroundCompletedAt: narrators.backgroundCompletedAt,
			status: narrators.status,
			createdAt: narrators.createdAt,
			title: narrators.title,
		})
		.from(narrators)
		.where(and(eq(narrators.parentNarratorId, parentNarratorId), eq(narrators.isBackground, true)))
		.orderBy(desc(narrators.createdAt));

	// Filter out legacy tasks that already exist in the unified table
	const unifiedIds = new Set(tasks.map((t) => t.id));
	const filteredLegacy = legacyTasks.filter((t) => !unifiedIds.has(t.id));

	return c.json({ tasks, legacySubagentTasks: filteredLegacy });
});

/**
 * POST /api/narrators/:id/background-tasks/:taskId/cancel
 * Cancel a running background task.
 */
narratorRoutes.post("/:id/background-tasks/:taskId/cancel", async (c) => {
	const taskId = c.req.param("taskId");

	// Try unified background task service first
	const { backgroundTaskService } = await import("../services/background-task-service");
	const cancelled = await backgroundTaskService.cancel(taskId);
	if (cancelled) return c.json({ success: true });

	// Fall back to legacy agent background task
	const { cancelBackgroundTask } = await import("../services/narrator-subagent");
	const legacyCancelled = await cancelBackgroundTask(taskId);
	if (legacyCancelled) return c.json({ success: true });

	return c.json({ error: "Task is not running or does not exist" }, 404);
});

/**
 * GET /api/narrators/:id/background-tasks/:taskId/output
 * Get full output of a background bash task.
 */
narratorRoutes.get("/:id/background-tasks/:taskId/output", async (c) => {
	const narratorId = c.req.param("id");
	const taskId = c.req.param("taskId");
	const { backgroundTaskService } = await import("../services/background-task-service");
	const task = await backgroundTaskService.getById(taskId);
	if (!task) {
		return c.json({ error: "Task not found" }, 404);
	}
	if (task.parentNarratorId !== narratorId) {
		return c.json({ error: "Task does not belong to this narrator" }, 403);
	}
	return c.json({ output: task.output, status: task.status });
});

// ── Whitelist directories ──────────────────────────────────

narratorRoutes.get("/:id/whitelist-dirs", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id); // ensure exists
	const dirs = await db.query.narratorWhitelistDirs.findMany({
		where: eq(narratorWhitelistDirs.narratorId, id),
		orderBy: asc(narratorWhitelistDirs.createdAt),
	});
	return c.json(dirs);
});

narratorRoutes.post("/:id/whitelist-dirs", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = await c.req.json();
	const parsed = createWhitelistDirSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	if (!isAbsolute(parsed.data.path)) {
		throw new ValidationError("Whitelist directory path must be absolute");
	}
	const normalizedPath = resolvePath(parsed.data.path);
	// Deduplicate: check if this narrator already has a whitelist entry for the same path
	// (handles Windows case-insensitive paths via pathsEqual)
	const existing = await db.query.narratorWhitelistDirs.findMany({
		where: eq(narratorWhitelistDirs.narratorId, id),
		columns: { id: true, path: true },
	});
	if (existing.some((e) => pathsEqual(e.path, normalizedPath))) {
		throw new ValidationError("This directory is already in the whitelist");
	}
	const now = new Date().toISOString();
	const dir = {
		id: generateId(),
		narratorId: id,
		path: normalizedPath,
		accessLevel: parsed.data.accessLevel,
		enabled: parsed.data.enabled,
		createdAt: now,
	};
	await db.insert(narratorWhitelistDirs).values(dir);
	return c.json(dir, 201);
});

narratorRoutes.patch("/whitelist-dirs/:dirId", async (c) => {
	const dirId = c.req.param("dirId");
	const body = await c.req.json();
	const parsed = updateWhitelistDirSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const updates: Record<string, unknown> = {};
	if (parsed.data.accessLevel !== undefined) updates.accessLevel = parsed.data.accessLevel;
	if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
	if (Object.keys(updates).length === 0) throw new ValidationError("No fields to update");
	await db.update(narratorWhitelistDirs).set(updates).where(eq(narratorWhitelistDirs.id, dirId));
	return c.json({ ok: true });
});

narratorRoutes.delete("/whitelist-dirs/:dirId", async (c) => {
	const dirId = c.req.param("dirId");
	await db.delete(narratorWhitelistDirs).where(eq(narratorWhitelistDirs.id, dirId));
	return c.json({ ok: true });
});

// ── Blacklist directories ──────────────────────────────────

narratorRoutes.get("/:id/blacklist-dirs", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id); // ensure exists
	const dirs = await db.query.narratorBlacklistDirs.findMany({
		where: eq(narratorBlacklistDirs.narratorId, id),
		orderBy: asc(narratorBlacklistDirs.createdAt),
	});
	return c.json(dirs);
});

narratorRoutes.post("/:id/blacklist-dirs", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = await c.req.json();
	const parsed = createBlacklistDirSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	if (!isAbsolute(parsed.data.path)) {
		throw new ValidationError("Blacklist directory path must be absolute");
	}
	const normalizedPath = resolvePath(parsed.data.path);
	const existing = await db.query.narratorBlacklistDirs.findMany({
		where: eq(narratorBlacklistDirs.narratorId, id),
		columns: { id: true, path: true },
	});
	if (existing.some((e) => pathsEqual(e.path, normalizedPath))) {
		throw new ValidationError("This directory is already in the blacklist");
	}
	const now = new Date().toISOString();
	const dir = {
		id: generateId(),
		narratorId: id,
		path: normalizedPath,
		denyLevel: parsed.data.denyLevel,
		enabled: parsed.data.enabled,
		createdAt: now,
	};
	await db.insert(narratorBlacklistDirs).values(dir);
	return c.json(dir, 201);
});

narratorRoutes.patch("/blacklist-dirs/:dirId", async (c) => {
	const dirId = c.req.param("dirId");
	const body = await c.req.json();
	const parsed = updateBlacklistDirSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const updates: Record<string, unknown> = {};
	if (parsed.data.denyLevel !== undefined) updates.denyLevel = parsed.data.denyLevel;
	if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
	if (Object.keys(updates).length === 0) throw new ValidationError("No fields to update");
	await db.update(narratorBlacklistDirs).set(updates).where(eq(narratorBlacklistDirs.id, dirId));
	return c.json({ ok: true });
});

narratorRoutes.delete("/blacklist-dirs/:dirId", async (c) => {
	const dirId = c.req.param("dirId");
	await db.delete(narratorBlacklistDirs).where(eq(narratorBlacklistDirs.id, dirId));
	return c.json({ ok: true });
});

// ── Command whitelist ──────────────────────────────────────

narratorRoutes.get("/:id/cmd-whitelist", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const cmds = await db.query.narratorWhitelistCmds.findMany({
		where: eq(narratorWhitelistCmds.narratorId, id),
		orderBy: asc(narratorWhitelistCmds.createdAt),
	});
	return c.json(cmds);
});

narratorRoutes.post("/:id/cmd-whitelist", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = await c.req.json();
	const parsed = createWhitelistCmdSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const existing = await db.query.narratorWhitelistCmds.findMany({
		where: eq(narratorWhitelistCmds.narratorId, id),
		columns: { id: true, pattern: true },
	});
	if (existing.some((e) => e.pattern === parsed.data.pattern)) {
		throw new ValidationError("This pattern is already in the command whitelist");
	}
	const entry = {
		id: generateId(),
		narratorId: id,
		pattern: parsed.data.pattern,
		enabled: parsed.data.enabled,
		createdAt: new Date().toISOString(),
	};
	await db.insert(narratorWhitelistCmds).values(entry);
	return c.json(entry, 201);
});

narratorRoutes.patch("/cmd-whitelist/:entryId", async (c) => {
	const entryId = c.req.param("entryId");
	const body = await c.req.json();
	const parsed = updateWhitelistCmdSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const updates: Record<string, unknown> = {};
	if (parsed.data.pattern !== undefined) updates.pattern = parsed.data.pattern;
	if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
	if (Object.keys(updates).length === 0) throw new ValidationError("No fields to update");
	await db.update(narratorWhitelistCmds).set(updates).where(eq(narratorWhitelistCmds.id, entryId));
	return c.json({ ok: true });
});

narratorRoutes.delete("/cmd-whitelist/:entryId", async (c) => {
	const entryId = c.req.param("entryId");
	await db.delete(narratorWhitelistCmds).where(eq(narratorWhitelistCmds.id, entryId));
	return c.json({ ok: true });
});

// ── Command blacklist ──────────────────────────────────────

narratorRoutes.get("/:id/cmd-blacklist", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const cmds = await db.query.narratorBlacklistCmds.findMany({
		where: eq(narratorBlacklistCmds.narratorId, id),
		orderBy: asc(narratorBlacklistCmds.createdAt),
	});
	return c.json(cmds);
});

narratorRoutes.post("/:id/cmd-blacklist", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = await c.req.json();
	const parsed = createBlacklistCmdSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const existing = await db.query.narratorBlacklistCmds.findMany({
		where: eq(narratorBlacklistCmds.narratorId, id),
		columns: { id: true, pattern: true },
	});
	if (existing.some((e) => e.pattern === parsed.data.pattern)) {
		throw new ValidationError("This pattern is already in the command blacklist");
	}
	const entry = {
		id: generateId(),
		narratorId: id,
		pattern: parsed.data.pattern,
		denyPrompt: parsed.data.denyPrompt ?? null,
		enabled: parsed.data.enabled,
		createdAt: new Date().toISOString(),
	};
	await db.insert(narratorBlacklistCmds).values(entry);
	return c.json(entry, 201);
});

narratorRoutes.patch("/cmd-blacklist/:entryId", async (c) => {
	const entryId = c.req.param("entryId");
	const body = await c.req.json();
	const parsed = updateBlacklistCmdSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const updates: Record<string, unknown> = {};
	if (parsed.data.pattern !== undefined) updates.pattern = parsed.data.pattern;
	if (parsed.data.denyPrompt !== undefined) updates.denyPrompt = parsed.data.denyPrompt;
	if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
	if (Object.keys(updates).length === 0) throw new ValidationError("No fields to update");
	await db.update(narratorBlacklistCmds).set(updates).where(eq(narratorBlacklistCmds.id, entryId));
	return c.json({ ok: true });
});

narratorRoutes.delete("/cmd-blacklist/:entryId", async (c) => {
	const entryId = c.req.param("entryId");
	await db.delete(narratorBlacklistCmds).where(eq(narratorBlacklistCmds.id, entryId));
	return c.json({ ok: true });
});

// ── Browser sessions ─────────────────────────────────────────────────────────

narratorRoutes.get("/:id/browser-sessions", (c) => {
	const narratorId = c.req.param("id");
	const sessions = listBrowserSessions(narratorId);
	return c.json(sessions.map((s) => ({ ...s, viewport: DEFAULT_VIEWPORT })));
});

narratorRoutes.patch("/:id/browser-sessions/:sessionId/ttl", async (c) => {
	const narratorId = c.req.param("id");
	const sessionId = c.req.param("sessionId");
	const body = await c.req.json().catch(() => ({}));
	const ttlMs = Number((body as { ttlMs?: unknown }).ttlMs);
	if (!Number.isFinite(ttlMs) || !Number.isInteger(ttlMs)) {
		throw new ValidationError("ttlMs must be an integer number of milliseconds");
	}
	if (ttlMs < MIN_SESSION_TTL_MS || ttlMs > MAX_SESSION_TTL_MS) {
		throw new ValidationError(
			`ttlMs must be between ${MIN_SESSION_TTL_MS} and ${MAX_SESSION_TTL_MS}`,
		);
	}
	const session = setBrowserSessionTtl(narratorId, sessionId, ttlMs);
	if (!session) throw new NotFoundError("BrowserSession", sessionId);
	return c.json({
		ok: true,
		session: {
			id: session.id,
			url: session.page.url(),
			lastActivity: session.lastActivity,
			ttlMs: session.ttlMs,
			expiresAt: session.lastActivity + session.ttlMs,
			headless: session.headless,
			tracing: session.tracing
				? { active: session.tracing.active, startedAt: session.tracing.startedAt }
				: null,
			networkRequestCount: session.networkRequests.length,
			networkCaptureEnabled: session.networkCaptureEnabled,
		},
	});
});

narratorRoutes.delete("/:id/browser-sessions/:sessionId", async (c) => {
	const narratorId = c.req.param("id");
	const sessionId = c.req.param("sessionId");

	// Check if tracing was active before closing — we need to notify the model
	const session = getBrowserSession(narratorId, sessionId);
	const hadTracing = session?.tracing?.active ?? false;

	const closed = await closeBrowserSession(narratorId, sessionId);
	if (!closed) throw new NotFoundError("BrowserSession", sessionId);

	if (hadTracing) {
		const text =
			`[System] Browser session ${sessionId} was closed by the user while performance tracing was active. ` +
			`The trace data was discarded. If you need a trace, start a new session and recording.`;
		const msg = await narratorService.persistSystemMessage(narratorId, text);
		broadcastToNarrator(narratorId, {
			type: "message",
			narratorId,
			message: {
				id: msg.id,
				narratorId,
				role: "sys",
				contentJson: msg.contentJson,
				contentText: msg.contentText,
				createdAt: msg.createdAt,
				children: [],
			},
		});
	}

	return c.json({ ok: true });
});

narratorRoutes.get("/:id/browser-sessions/:sessionId/screenshot", async (c) => {
	const narratorId = c.req.param("id");
	const sessionId = c.req.param("sessionId");
	const session = getBrowserSession(narratorId, sessionId);
	if (!session) throw new NotFoundError("BrowserSession", sessionId);
	const result = await browserScreenshot(session);
	const buffer = Buffer.from(result.base64, "base64");
	return new Response(buffer, {
		headers: {
			"Content-Type": "image/png",
			"Cache-Control": "no-store",
		},
	});
});

narratorRoutes.post("/:id/browser-sessions/:sessionId/interact", async (c) => {
	const narratorId = c.req.param("id");
	const sessionId = c.req.param("sessionId");
	const session = getBrowserSession(narratorId, sessionId);
	if (!session) throw new NotFoundError("BrowserSession", sessionId);

	const rawBody = await c.req.json().catch(() => ({}));
	const parsed = browserInteractSchema.safeParse(rawBody);
	if (!parsed.success) {
		return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid interact request" }, 400);
	}
	const { action, coordinate, endCoordinate, direction, amount, text, key, keys } = parsed.data;

	const { page } = session;

	switch (action) {
		case "click":
			await browserClick(session, "", { coordinate });
			break;
		case "scroll": {
			const scrollDirection = direction ?? "down";
			const scrollAmount = amount ?? 300;
			await browserScroll(session, {
				direction: scrollDirection,
				amount: scrollAmount,
				coordinate,
			});
			break;
		}
		case "drag": {
			// Presence of coordinate/endCoordinate is guaranteed by the schema.
			if (!coordinate || !endCoordinate) break;
			touchSessionVisual(session);
			await page.mouse.move(coordinate.x, coordinate.y);
			await page.mouse.down();
			await page.mouse.move(endCoordinate.x, endCoordinate.y, { steps: 10 });
			await page.mouse.up();
			break;
		}
		case "type": {
			if (keys) {
				// Batch: execute a sequence of key/text inputs in order
				for (const item of keys) {
					if (item.key) {
						await browserType(session, { key: item.key });
					} else if (item.text) {
						await browserType(session, { value: item.text });
					}
				}
			} else {
				await browserType(session, { value: text, key });
			}
			break;
		}
	}

	// Return fresh screenshot after the interaction
	const result = await browserScreenshot(session);
	const buffer = Buffer.from(result.base64, "base64");
	return new Response(buffer, {
		headers: {
			"Content-Type": "image/png",
			"Cache-Control": "no-store",
		},
	});
});

narratorRoutes.post("/:id/browser-sessions/:sessionId/stop-tracing", async (c) => {
	const narratorId = c.req.param("id");
	const sessionId = c.req.param("sessionId");
	const stopped = await stopBrowserTracing(narratorId, sessionId);
	if (!stopped) throw new NotFoundError("BrowserSession", sessionId);

	// Inject a system message so the model knows tracing was stopped externally
	const text =
		`[System] Performance tracing on browser session ${sessionId} was stopped by the user from the management panel. ` +
		`The trace data was discarded. If you need a trace, start a new recording with perf_start.`;
	const msg = await narratorService.persistSystemMessage(narratorId, text);
	broadcastToNarrator(narratorId, {
		type: "message",
		narratorId,
		message: {
			id: msg.id,
			narratorId,
			role: "sys",
			contentJson: msg.contentJson,
			contentText: msg.contentText,
			createdAt: msg.createdAt,
			children: [],
		},
	});

	return c.json({ ok: true });
});
