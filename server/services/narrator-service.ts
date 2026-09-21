import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { MessageOriginOptions } from "@shared/message-origin";
import { foldHandle } from "@shared/narrator-handle";
import { and, desc, eq, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
	apiRequests,
	backgroundTasks,
	benchmarkTaskResults,
	chapterCommits,
	chapters,
	gatewaySessionMappings,
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narratorBufferedMessages,
	narratorFileSnapshots,
	narratorMessageRefs,
	narratorMessages,
	narratorPatches,
	narrators,
	narratorToolCalls,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	terminals,
	terminalViewState,
	users,
} from "../db/schema";
import {
	KNOWLEDGE_KIND_PRELOAD_TOOLS,
	KNOWLEDGE_KIND_PRELOAD_TOOLS_ADMIN,
} from "../lib/agent/tools/knowledge-kind";
import { SETUP_KIND_PRELOAD_TOOLS, SETUP_KIND_TRAIT } from "../lib/agent/tools/setup-kind";
import { narratorHandleLock, narratorTraitsLock } from "../lib/async-mutex";
import { buildAttachedFilesHint } from "../lib/attached-files";
import {
	type AutoContinuationOverride,
	type BooleanOverride,
	type DangerReflectionOverride,
	normalizeAutoContinuationOverride,
	normalizeBooleanOverride,
	normalizeDangerReflectionOverride,
} from "../lib/boolean-override";
import { getBuiltinToolRoutines } from "../lib/builtin-routines";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { fastModeOverrideFromLegacyInput, legacyFastModeMirror } from "../lib/fast-mode";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { resolveNarratorAudiences } from "../lib/narrator-audiences";
import {
	BLOCKED_SKILLS_TRAIT_PREFIX,
	type BlockedSkillsTrait,
	buildCustomTraitsResponse,
	getBlockedSkills,
	getDisabledToolSet,
	isBlockedSkillsEmpty,
	isSkillBlocked,
	normalizeBlockedSkills,
	removeEncodedTrait,
	upsertEncodedTrait,
} from "../lib/narrator-custom-traits";
import {
	isSubagentVariant,
	KNOWLEDGE_KIND_TRAIT,
	type NarratorTrait,
	parseTraits,
	redactDraftTraits,
	subagentVariant,
} from "../lib/narrator-utils";
import { getPacksExtractRoot } from "../lib/pack-archives";
import { normalizeLegacyPermissionMode, resolveInitialRelaxedPlan } from "../lib/permission-modes";
import {
	buildKnowledgeStewardSystemPrompt,
	buildSetupAssistantSystemPrompt,
	getToolMessageWithParams,
	type Locale,
} from "../lib/prompt-i18n";
import { FOLLOW_DEFAULT_MODEL, resolveEffectiveModel, settings } from "../lib/settings";
import { escapeLikeNeedle } from "../lib/sql-like";
import {
	contentJsonHasImageBlocks,
	deleteNarratorUploads,
	type ImageRef,
	imageRefToContentBlock,
	type PersistedUserImageBlock,
	type TextFileRef,
} from "../lib/uploads";
import { generateWordSlug } from "../lib/words";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { agentMessageDeliveryBody } from "./agent-message-delivery";
import { buildAgentMessageOrigin } from "./agent-message-origin";
import type {
	BlockAllSkillsResult,
	BlockSkillResult,
	LoadSkillResult,
	LoadToolNotFound,
	LoadToolResult,
	UnblockAllSkillsResult,
	UnblockSkillResult,
	UnloadToolNotFound,
	UnloadToolResult,
} from "./command-service";
import { getAvailableOptionalToolIds } from "./command-service";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import { assertNarratorAccess, type NarratorAccessNeed } from "./narrator-acl";
import { buildSystemInjectionBlock, type SystemInjectionBlock } from "./narrator-injection";
import { DEFAULT_TOOL_IO_BUDGET, narratorMessageQueries, truncateJson } from "./narrator-messages";
// `bumpParentNarratorMessageVersion` is deliberately NOT imported any more: the bump
// now happens inside `persistUserMessage`/`persistSystemMessage`, so every writer of a
// child row gets it rather than only the subagent entry point that remembered to call it.
import {
	appendMessageRef,
	deleteRecipientMessageRefs,
	narratorPersistence,
} from "./narrator-persistence";
import {
	claimNextRefSeq,
	initializeRefSeqFloor,
	withSeqFloorRaiseScope,
} from "./narrator-refs/seq-store";
import { materializeChildrenOf } from "./narrator-refs-backfill";
import { specVfsService } from "./spec-vfs-service";
import { removeTabFromAllUsers } from "./user-preferences-service";

export {
	DEFAULT_TOOL_IO_BUDGET,
	EXACT_TOOL_IO_BUDGET,
	enrichToolUseBlocks,
	narratorMessageQueries,
	truncateJson,
	truncateToolIO,
} from "./narrator-messages";
export { narratorPersistence } from "./narrator-persistence";

/**
 * SQLite has a max variable number limit (~32766 in bun:sqlite).
 * Each narratorMessageRefs row has ~6 columns, so we batch at 500 rows
 * (3000 variables) to stay well within the limit.
 */
const REFS_INSERT_BATCH = 500;
const MAX_INHERITED_FULL_FORK_REFS = 500;

/**
 * Cap for the "and N more" figure reported by `listSubagentsForTeamView`.
 *
 * An exact remainder would be an unbounded `COUNT(*)` over a table that grows for
 * the whole lifetime of a session; past this point "500+" tells the caller the
 * same thing an exact number would.
 */
const TEAM_VIEW_OMITTED_COUNT_CAP = 500;

/**
 * The narrator columns a team listing renders. Deliberately narrower than the
 * full row: `systemPrompt` / `contextSummary` are large and unused by any listing,
 * and `traits` is needed only because it carries the alias a label resolves from.
 */
export interface TeamViewSubagent {
	id: string;
	title: string | null;
	traits: string[];
	variant: string;
	status: string;
	createdAt: string;
}

/**
 * A history compact marker is transient while its block is `compacting` (or
 * legacy `running`) or while its latest persisted attempt is still running.  A fork
 * must not share that row: the parent finalizer may COW it, leaving the child
 * with an impossible-to-finish marker forever.  Segment compact rows deliberately
 * remain visible.
 *
 * `narratorMessages.compactPending` is a virtual generated column projecting
 * exactly this predicate out of `contentJson`, backed by a partial index over
 * the pending rows only. Reading the flag through that index costs a constant
 * handful of pages; evaluating the predicate inline would instead pull every
 * prefix message's `contentJson` off disk (~149 MB for a 31k-message narrator)
 * just to discover the set is almost always empty.
 */
function pendingCompactMessageCondition() {
	return eq(narratorMessages.compactPending, 1);
}

/**
 * Ids of the messages a fork must NOT share, i.e. those carrying an in-flight
 * compact marker. Resolved up front through the partial index so the ref queries
 * can run against `narrator_message_refs` alone, without joining message bodies.
 *
 * Must be called inside the fork transaction: the set has to reflect the same
 * committed state the ref copy sees. The result is normally empty.
 */
function selectPendingCompactMessageIds(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): string[] {
	return tx
		.select({ id: narratorMessages.id })
		.from(narratorMessages)
		.where(pendingCompactMessageCondition())
		.all()
		.map((row) => row.id);
}

/**
 * Drizzle condition excluding the pending-compact messages from a refs query.
 * Returns undefined for the common empty case, so `and()` drops it entirely and
 * the statement stays a plain index range scan.
 */
function excludePendingCompactCondition(pendingIds: string[]) {
	return pendingIds.length > 0 ? notInArray(narratorMessageRefs.messageId, pendingIds) : undefined;
}

/** Raw-SQL equivalent of {@link excludePendingCompactCondition} for INSERT...SELECT. */
function excludePendingCompactRawCondition(pendingIds: string[]) {
	if (pendingIds.length === 0) return sql.raw("");
	// Ids come from our own generators, but quote defensively so this can never
	// become an injection point.
	const list = pendingIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
	return sql.raw(`AND refs.message_id NOT IN (${list})`);
}

/** Batch-insert narratorMessageRefs rows, chunking to stay within SQLite's variable limit. */
function insertRefsBatched(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	values: (typeof narratorMessageRefs.$inferInsert)[],
) {
	for (let i = 0; i < values.length; i += REFS_INSERT_BATCH) {
		tx.insert(narratorMessageRefs)
			.values(values.slice(i, i + REFS_INSERT_BATCH))
			.run();
	}
}

function annotateImageBlocksWithUploadOwner(contentJson: unknown, narratorId: string): unknown {
	if (!Array.isArray(contentJson)) return contentJson;

	let changed = false;
	const next = contentJson.map((block) => {
		if (!block || typeof block !== "object") return block;
		const candidate = block as { type?: unknown; imageId?: unknown; uploadNarratorId?: unknown };
		if (
			candidate.type !== "image" ||
			typeof candidate.imageId !== "string" ||
			typeof candidate.uploadNarratorId === "string"
		) {
			return block;
		}
		changed = true;
		return { ...candidate, uploadNarratorId: narratorId };
	});

	return changed ? next : contentJson;
}

async function hasSharedOwnedImageMessages(narratorId: string): Promise<boolean> {
	const sharedOwnedMessages = await db
		.select({ contentJson: narratorMessages.contentJson })
		.from(narratorMessages)
		.where(
			and(
				eq(narratorMessages.narratorId, narratorId),
				sql`EXISTS (
					SELECT 1 FROM narrator_message_refs nmr
					WHERE nmr.message_id = ${narratorMessages.id}
					AND nmr.narrator_id != ${narratorId}
				)`,
			),
		);
	return sharedOwnedMessages.some((row) => contentJsonHasImageBlocks(row.contentJson));
}

/**
 * Remove a narrator's pack extraction subtree (~/.narrafork/packs/<narratorId>/).
 * The activation + whitelist DB rows are cleared by FK cascade / explicit delete in
 * remove(); this clears the on-disk temp dirs that the DB cascade can't reach.
 */
async function deleteNarratorPackExtractions(narratorId: string): Promise<void> {
	try {
		const dir = resolve(getPacksExtractRoot(), narratorId);
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	} catch (err) {
		logger.warn("Failed to remove narrator pack extractions", {
			narratorId,
			error: String(err),
		});
	}
}

export interface CreateNarratorInput {
	chapterId?: string | null;
	type?: "primary";
	model?: string;
	systemPrompt?: string;
	permissionMode?: string;
	cwd?: string;
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null;
	/** @deprecated Legacy boolean; coerced into `fastModeOverride` ("on"/"off"). */
	fastMode?: boolean;
	/** Tri-state priority-tier override. "inherit" follows the user's fastModeDefault. */
	fastModeOverride?: BooleanOverride;
	relaxedPlan?: boolean;
	planReflectionAutoApproveOverride?: BooleanOverride;
	dangerReflectionOverride?: DangerReflectionOverride;
	autoContinuationOverride?: AutoContinuationOverride;
	behaviorFenceIntervalOverride?: number | null;
	behaviorFenceAttachOverride?: BooleanOverride;
	startInPlanMode?: boolean;
	title?: string;
	/** When true, create a "named narrator": standalone, long-lived, @handle-mentionable. Requires `handle`. */
	makeNamed?: boolean;
	/** Globally-unique mention handle. Only used when makeNamed is true. */
	handle?: string;
	/**
	 * Specialized standalone narrator kind.
	 * "knowledge" → a Knowledge Steward (knowledge-base management).
	 * "setup" → a Setup Assistant (installs missing system dependencies).
	 */
	kind?: "knowledge" | "setup";
	/** Whether the creating user is an admin (gates KnowledgeAdmin preinstall for kind="knowledge"). */
	creatorIsAdmin?: boolean;
	/** Locale for generating the default kind-specific system prompt. */
	locale?: Locale;
	/** Extra permanent trait tags to attach (merged with derived traits, deduped). */
	extraTraits?: NarratorTrait[];
	/** Explicit project context for an externally provisioned standalone narrator. */
	contextProjectId?: string | null;
	/** Frozen OAuth client policy applied at provisioning time. */
	oauthPolicySnapshotJson?: Record<string, unknown> | null;
	/** Initial default execution device, written atomically with external ownership. */
	defaultDeviceId?: string | null;
	/**
	 * The user this narrator belongs to. Every request-initiated path must pass it,
	 * or the narrator lands ownerless and only admins can ever share it. Left null
	 * only where there genuinely is no human initiator.
	 */
	ownerUserId?: string | null;
	/**
	 * Read audience. Omitted follows agent.defaultNarratorVisibility; auto keeps
	 * standalone narrators private and chapter-bound narrators project-visible.
	 */
	visibility?: "private" | "project" | "public";
	/**
	 * Write audience. Omitted follows agent.defaultNarratorWriteAudience, narrowed
	 * to effective visibility; auto uses the widest legal audience for that visibility.
	 */
	writeAudience?: "owner" | "project" | "public";
}

interface CreateSubagentInput {
	/** Immutable source Agent row; omitted only for non-tool/legacy creation paths. */
	originToolCallId?: string;
	/** Only trusted non-tool creation paths may explicitly declare standalone provenance. */
	subagentOriginKind?: "standalone";
	parentNarratorId: string;
	subagentType: string;
	cwd: string;
	title?: string;
	permissionMode?: string;
	planReflectionAutoApproveOverride?: BooleanOverride;
	model?: string;
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null;
	systemPrompt?: string;
	inheritedTraits?: string[];
	defaultDeviceId?: string | null;
}

function formatAvailableOptionalToolIds(): string {
	return getAvailableOptionalToolIds().join(", ");
}

/**
 * Optional tools that may only be loaded by admin users. Non-admin /load attempts
 * are rejected in handleLoadToolCommand. KnowledgeReview is intentionally NOT here:
 * reviewers need not be admins, and per-action authority is enforced by the service
 * layer (canReview / canWriteMain) at execution time.
 */
const ADMIN_ONLY_LOAD_TOOLS = new Set([
	"NarraForkAdmin",
	"KnowledgeAdmin",
	"PluginInstall",
	"McpAdmin",
	"HookAdmin",
	"ScheduledTaskAdmin",
]);

/**
 * Resolve a narrator's traits across the user/project/narrator layers.
 *
 * Local helper so the several command handlers below share one lazy import; the
 * trait layer service is imported dynamically to avoid a cycle
 * (trait-layer-service → db → … → narrator-service).
 */
async function resolveLayeredTraitsFor(
	narrator: { traits: unknown; chapterId?: string | null; contextProjectId?: string | null },
	userId: string | undefined,
): Promise<string[]> {
	try {
		const { resolveEffectiveTraits, resolveNarratorProjectId } = await import(
			"./trait-layer-service"
		);
		const resolved = await resolveEffectiveTraits({
			narratorTraits: narrator.traits,
			projectId: await resolveNarratorProjectId(narrator),
			actingUserId: userId ?? null,
		});
		return resolved.traits;
	} catch {
		// Degrade to narrator-only traits rather than failing the command.
		const { parseTraits } = await import("../lib/narrator-utils");
		return parseTraits(narrator.traits);
	}
}

/**
 * Shared handler for `/load <tool>` commands.
 */
export async function handleLoadToolCommand(
	narratorId: string,
	cmdResult: LoadToolResult | LoadToolNotFound,
	locale: Locale = "en",
	userId?: string,
): Promise<{ toolName: string; loaded: boolean; alreadyLoaded: boolean }> {
	if ("loadToolNotFound" in cmdResult) {
		const toolId = cmdResult.loadToolNotFound;
		const available = formatAvailableOptionalToolIds();
		const infoText =
			locale === "zh-CN"
				? `⚠️ 未知工具：${toolId}。可用：${available}`
				: `⚠️ Unknown tool: ${toolId}. Available: ${available}`;
		await narratorService.persistDisplayMessage(narratorId, infoText);
		return { toolName: toolId, loaded: false, alreadyLoaded: false };
	}
	const toolNames = cmdResult.loadTools ?? [cmdResult.loadTool];
	const displayToolName = cmdResult.loadToolId ?? cmdResult.loadTool;
	const currentNarrator = await narratorService.getById(narratorId);
	// Layered: a project/user-level deny must also block a manual `/load`.
	const loadTraits = await resolveLayeredTraitsFor(currentNarrator, userId);
	const disabledTools = getDisabledToolSet(loadTraits);
	const disabledTool = toolNames.find((name) => disabledTools.has(name));
	if (disabledTool) {
		const infoText =
			locale === "zh-CN"
				? `⛔ 工具已被此叙述者的自定义 trait 禁用：${displayToolName}`
				: `⛔ Tool disabled by this narrator's custom trait: ${displayToolName}`;
		await narratorService.persistDisplayMessage(narratorId, infoText);
		return { toolName: displayToolName, loaded: false, alreadyLoaded: false };
	}

	// Admin-only tool check
	if (toolNames.some((name) => ADMIN_ONLY_LOAD_TOOLS.has(name))) {
		const adminOnlyMsg =
			locale === "zh-CN"
				? "⛔ 只有管理员才能加载此工具"
				: "⛔ Only administrators can load this tool";
		if (!userId) {
			await narratorService.persistDisplayMessage(narratorId, adminOnlyMsg);
			return { toolName: displayToolName, loaded: false, alreadyLoaded: false };
		}
		const user = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { role: true },
		});
		if (!user || user.role !== "admin") {
			await narratorService.persistDisplayMessage(narratorId, adminOnlyMsg);
			return { toolName: displayToolName, loaded: false, alreadyLoaded: false };
		}
	}

	const { loadOptionalTool } = await import("./narrator-session");
	const results = [];
	for (const toolName of toolNames) {
		results.push(await loadOptionalTool(narratorId, toolName));
	}
	const alreadyLoaded = results.every((result) => result === "already_loaded");
	const infoText = alreadyLoaded
		? `🔧 Tool already loaded: ${displayToolName}`
		: `🔧 Tool loaded: ${displayToolName}`;
	await narratorService.persistDisplayMessage(narratorId, infoText);

	// Persist a user-role message so the model is aware the tool was just loaded
	if (!alreadyLoaded) {
		const routine =
			getBuiltinToolRoutines().find((r) => r.id === cmdResult.loadToolId) ??
			getBuiltinToolRoutines().find((r) => r.tool?.toolName === cmdResult.loadTool);
		const toolDescription =
			locale === "zh-CN"
				? (routine?.tool?.descriptionZh ?? routine?.tool?.descriptionEn ?? displayToolName)
				: (routine?.tool?.descriptionEn ?? displayToolName);
		const text = getToolMessageWithParams("toolLoaded", locale, {
			toolName: displayToolName,
			toolDescription,
		});
		const id = generateId();
		const now = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "user",
				contentJson: [{ type: "tool_loaded", toolName: displayToolName, text }],
				contentText: text,
				createdAt: now,
			})
			.returning();
		await appendMessageRef(narratorId, id);
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: {
				id: msg.id,
				narratorId,
				role: "user",
				contentJson: msg.contentJson,
				contentText: msg.contentText,
				createdAt: msg.createdAt,
				children: [],
			},
		});
	}

	return { toolName: displayToolName, loaded: true, alreadyLoaded };
}

/**
 * Shared handler for `/unload <tool>` commands.
 */
export async function handleUnloadToolCommand(
	narratorId: string,
	cmdResult: UnloadToolResult | UnloadToolNotFound,
	locale: Locale = "en",
): Promise<{ toolName: string; unloaded: boolean; notLoaded: boolean }> {
	if ("unloadToolNotFound" in cmdResult) {
		const toolId = cmdResult.unloadToolNotFound;
		const available = formatAvailableOptionalToolIds();
		const infoText =
			locale === "zh-CN"
				? `⚠️ 未知工具：${toolId}。可用：${available}`
				: `⚠️ Unknown tool: ${toolId}. Available: ${available}`;
		await narratorService.persistDisplayMessage(narratorId, infoText);
		return { toolName: toolId, unloaded: false, notLoaded: false };
	}

	const toolNames = cmdResult.unloadTools ?? [cmdResult.unloadTool];
	const displayToolName = cmdResult.unloadToolId ?? cmdResult.unloadTool;
	const { unloadOptionalTool } = await import("./narrator-session");
	const results = [];
	for (const toolName of toolNames) {
		results.push(await unloadOptionalTool(narratorId, toolName));
	}
	const notLoaded = results.every((result) => result === "not_loaded");
	const unknownTool = results.some((result) => result === "unknown_tool");
	const infoText = unknownTool
		? `⚠️ Unknown tool: ${displayToolName}`
		: notLoaded
			? `🔧 Tool not loaded: ${displayToolName}`
			: `🔧 Tool unloaded: ${displayToolName}`;
	await narratorService.persistDisplayMessage(narratorId, infoText);

	// Persist a user-role message so the model is aware the tool is no longer available.
	if (!notLoaded && !unknownTool) {
		const text = getToolMessageWithParams("toolUnloaded", locale, { toolName: displayToolName });
		const id = generateId();
		const now = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "user",
				contentJson: [{ type: "tool_unloaded", toolName: displayToolName, text }],
				contentText: text,
				createdAt: now,
			})
			.returning();
		await appendMessageRef(narratorId, id);
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: {
				id: msg.id,
				narratorId,
				role: "user",
				contentJson: msg.contentJson,
				contentText: msg.contentText,
				createdAt: msg.createdAt,
				children: [],
			},
		});
	}

	return { toolName: displayToolName, unloaded: !notLoaded && !unknownTool, notLoaded };
}

/**
 * Handle `/skill <name>` slash command.
 */
export async function handleLoadSkillCommand(
	narratorId: string,
	cmdResult: LoadSkillResult,
): Promise<
	{ found: true; skillName: string; content: string } | { found: false; skillName: string }
> {
	const { dirname, join } = await import("node:path");
	const {
		loadSkillByNameForContext,
		loadSkillSummariesForContext,
		resolveSkillContextForNarrator,
	} = await import("./skill-service");

	const skillContext = await resolveSkillContextForNarrator(narratorId);
	const summaries = await loadSkillSummariesForContext(skillContext);
	const found = await loadSkillByNameForContext(skillContext, cmdResult.loadSkill);

	if (!found) {
		const available = summaries.skills
			.filter((s) => !s.disabled)
			.map((s) => s.name)
			.join(", ");
		const infoText = `⚠️ Skill "${cmdResult.loadSkill}" not found. Available: ${available || "(none)"}`;
		await narratorService.persistDisplayMessage(narratorId, infoText);
		return { found: false, skillName: cmdResult.loadSkill };
	}

	// Respect the blocked-skills trait: a blocked skill cannot be manually injected.
	// Resolved across layers so a project-level block also applies. No acting user
	// is threaded into this command, so only the project layer contributes.
	const narratorForBlock = await narratorService.getById(narratorId);
	const blocked = getBlockedSkills(await resolveLayeredTraitsFor(narratorForBlock, undefined));
	if (isSkillBlocked(blocked, found.name)) {
		const infoText = blocked.all
			? `⛔ Skills are disabled for this narrator. Use "/load all_skills" to re-enable them.`
			: `⛔ Skill "${found.name}" is blocked. Use "/load skill ${found.name}" to unblock it first.`;
		await narratorService.persistDisplayMessage(narratorId, infoText);
		return { found: false, skillName: found.name };
	}

	const skillDir = dirname(found.location);
	const lines = [`<skill_content name="${escapeXmlAttr(found.name)}">`];
	lines.push(`# Skill: ${found.name}`);
	lines.push("");
	if (found.content) {
		lines.push(found.content);
		lines.push("");
	}
	lines.push(`Base directory for this skill: ${skillDir}`);
	if (found.files.length > 0) {
		lines.push("");
		lines.push("<skill_files>");
		for (const f of found.files) {
			lines.push(`<file>${join(skillDir, f)}</file>`);
		}
		lines.push("</skill_files>");
	}
	lines.push("</skill_content>");

	await narratorService.persistDisplayMessage(narratorId, `🔧 Skill loaded: ${found.name}`);

	return { found: true, skillName: found.name, content: lines.join("\n") };
}

/**
 * Apply a mutation to the blocked-skills trait under the shared traits lock,
 * then sync the live session and broadcast the change. Mirrors the route-level
 * updateNarratorTraits flow so panel + slash-command edits stay consistent.
 */
async function mutateBlockedSkillsTrait(
	narratorId: string,
	mutate: (current: BlockedSkillsTrait) => BlockedSkillsTrait,
): Promise<BlockedSkillsTrait> {
	const { updateActiveBlockedSkills } = await import("./narrator-session");
	const { traits, next } = await narratorTraitsLock.acquire(narratorId, async () => {
		const narrator = await narratorService.getById(narratorId);
		const current = normalizeBlockedSkills(getBlockedSkillsTrait(narrator.traits));
		const next = normalizeBlockedSkills(mutate(current));
		const traits = isBlockedSkillsEmpty(next)
			? removeEncodedTrait(narrator.traits, BLOCKED_SKILLS_TRAIT_PREFIX)
			: upsertEncodedTrait(narrator.traits, BLOCKED_SKILLS_TRAIT_PREFIX, next);
		await db
			.update(narrators)
			.set({ traits, updatedAt: new Date().toISOString() })
			.where(eq(narrators.id, narratorId));
		return { traits, next };
	});
	// Sync the live session from the *resolved* traits: an edit here must not
	// appear to lift a block that the project/user layer enforces.
	const narratorRow = await narratorService.getById(narratorId);
	const effectiveBlocked = getBlockedSkills(
		await resolveLayeredTraitsFor({ ...narratorRow, traits }, undefined),
	);
	updateActiveBlockedSkills(narratorId, {
		all: effectiveBlocked.all,
		names: effectiveBlocked.names,
	});
	broadcastToNarrator(narratorId, {
		type: "custom_traits_changed",
		narratorId,
		traits: redactDraftTraits(traits),
		customTraits: buildCustomTraitsResponse(traits),
	});
	return next;
}

/** Read the current blocked-skills trait as a plain object (defaults if absent). */
function getBlockedSkillsTrait(traits: unknown): BlockedSkillsTrait {
	const state = getBlockedSkills(traits);
	return { version: 1, all: state.all, names: [...state.names] };
}

/**
 * Handle `/unload skill <name>` — block a specific skill for this narrator.
 */
export async function handleBlockSkillCommand(
	narratorId: string,
	cmdResult: BlockSkillResult,
	locale: Locale = "en",
): Promise<{ skillName: string; blocked: boolean }> {
	const { resolveSkillContextForNarrator, loadSkillSummariesForContext } = await import(
		"./skill-service"
	);
	// Normalize the requested name to the canonical skill name when it exists.
	let skillName = cmdResult.blockSkill;
	try {
		const context = await resolveSkillContextForNarrator(narratorId);
		const summaries = await loadSkillSummariesForContext(context);
		const match = summaries.skills.find(
			(s) => s.name === skillName || s.name.toLowerCase() === skillName.toLowerCase(),
		);
		if (match) skillName = match.name;
	} catch {
		// Non-fatal — fall back to the raw name.
	}

	const next = await mutateBlockedSkillsTrait(narratorId, (current) => ({
		...current,
		names: current.names.includes(skillName) ? current.names : [...current.names, skillName],
	}));

	const infoText = next.all
		? locale === "zh-CN"
			? `⛔ 已屏蔽技能：${skillName}（所有技能当前已被屏蔽）`
			: `⛔ Blocked skill: ${skillName} (all skills are currently blocked)`
		: locale === "zh-CN"
			? `⛔ 已屏蔽技能：${skillName}`
			: `⛔ Blocked skill: ${skillName}`;
	await narratorService.persistDisplayMessage(narratorId, infoText);
	return { skillName, blocked: true };
}

/**
 * Handle `/unload all_skills` — block every skill for this narrator.
 */
export async function handleBlockAllSkillsCommand(
	narratorId: string,
	_cmdResult: BlockAllSkillsResult,
	locale: Locale = "en",
): Promise<{ all: true }> {
	await mutateBlockedSkillsTrait(narratorId, (current) => ({ ...current, all: true }));
	const infoText =
		locale === "zh-CN"
			? "⛔ 已屏蔽所有技能。使用 /load all_skills 可重新启用。"
			: '⛔ All skills are now blocked. Use "/load all_skills" to re-enable.';
	await narratorService.persistDisplayMessage(narratorId, infoText);
	return { all: true };
}

/**
 * Handle `/load skill <name>` — unblock a specific skill.
 */
export async function handleUnblockSkillCommand(
	narratorId: string,
	cmdResult: UnblockSkillResult,
	locale: Locale = "en",
): Promise<{ skillName: string; unblocked: boolean }> {
	const skillName = cmdResult.unblockSkill;
	const before = getBlockedSkills((await narratorService.getById(narratorId)).traits);
	// Match case-insensitively against currently blocked names.
	const matched = [...before.names].find(
		(n) => n === skillName || n.toLowerCase() === skillName.toLowerCase(),
	);

	await mutateBlockedSkillsTrait(narratorId, (current) => ({
		...current,
		names: current.names.filter((n) => n !== (matched ?? skillName)),
	}));

	const wasBlocked = before.all || !!matched;
	const infoText = before.all
		? locale === "zh-CN"
			? `ℹ️ 所有技能仍处于屏蔽状态。使用 /load all_skills 可全部解除。`
			: `ℹ️ All skills are still blocked. Use "/load all_skills" to unblock every skill.`
		: wasBlocked
			? locale === "zh-CN"
				? `✅ 已解除屏蔽技能：${matched ?? skillName}`
				: `✅ Unblocked skill: ${matched ?? skillName}`
			: locale === "zh-CN"
				? `ℹ️ 技能未被屏蔽：${skillName}`
				: `ℹ️ Skill was not blocked: ${skillName}`;
	await narratorService.persistDisplayMessage(narratorId, infoText);
	return { skillName: matched ?? skillName, unblocked: wasBlocked && !before.all };
}

/**
 * Handle `/load all_skills` — clear the blocked-skills restriction entirely.
 */
export async function handleUnblockAllSkillsCommand(
	narratorId: string,
	_cmdResult: UnblockAllSkillsResult,
	locale: Locale = "en",
): Promise<{ cleared: true }> {
	await mutateBlockedSkillsTrait(narratorId, () => ({ version: 1, all: false, names: [] }));
	const infoText =
		locale === "zh-CN"
			? "✅ 已解除所有技能屏蔽，技能重新可用。"
			: "✅ Skill restrictions cleared — all skills are available again.";
	await narratorService.persistDisplayMessage(narratorId, infoText);
	return { cleared: true };
}

/**
 * Handle `/bash <command>` slash command.
 * Directly executes a bash command without AI involvement.
 * Persists a running tool card before execution, then streams output via WS.
 */
/**
 * AbortControllers for in-flight manual `/bash` commands, keyed by narratorId.
 * Manual `/bash` runs (both the standalone command and the runBashFirst pre-prompt
 * flow) execute outside the normal tool-executor path, so the agent loop's abort
 * signal never reaches them. We track their controllers here so the interrupt
 * endpoint can terminate the underlying process.
 *
 * A narrator can have more than one manual bash in flight (e.g. a runBashFirst
 * pre-prompt command plus a separately triggered one), so we keep a Set per
 * narrator instead of a single controller — otherwise a later command would
 * overwrite the earlier one's entry and leave it un-interruptible.
 *
 * Pinned to globalThis via hotSafe so hot reloads don't lose references to
 * running child processes.
 */
const manualBashAborts = hotSafe(
	"narrafork:manualBashAborts",
	() => new Map<string, Set<AbortController>>(),
);

/**
 * Abort ALL in-flight manual `/bash` commands for this narrator.
 * Returns true if at least one running manual bash command was found and aborted.
 */
export function interruptManualBash(narratorId: string): boolean {
	const ctrls = manualBashAborts.get(narratorId);
	if (!ctrls || ctrls.size === 0) return false;
	// Snapshot before aborting: abort() may synchronously trigger the finally
	// block that mutates the Set we're iterating.
	for (const ctrl of [...ctrls]) {
		try {
			ctrl.abort();
		} catch {
			// already aborted
		}
	}
	logger.info("Manual bash command interrupted", { narratorId });
	return true;
}

export async function handleBashCommand(
	narratorId: string,
	command: string,
	rawCommand: string,
	userId?: string,
	options?: { skipUserMessage?: boolean; signal?: AbortSignal },
): Promise<{ type: "bash"; id: string; output: string; isError: boolean }> {
	const narrator = await narratorService.getById(narratorId);
	const cwd = narrator.cwd ?? process.cwd();

	// 1. Persist and broadcast the user-visible /bash command immediately.
	// When skipUserMessage is set (runBashFirst flow), the user's slash command was
	// already persisted as a separate message, so we skip the extra "$ cmd" bubble
	// and only render the Bash tool card below.
	let userMsg: Awaited<ReturnType<typeof narratorService.persistUserMessage>> | undefined;
	if (!options?.skipUserMessage) {
		userMsg = await narratorService.persistUserMessage(
			narratorId,
			rawCommand,
			[{ type: "bash_command", command }],
			rawCommand,
			userId,
		);
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: {
				id: userMsg.id,
				narratorId,
				role: "user",
				contentJson: userMsg.contentJson,
				contentText: userMsg.contentText,
				commandText: rawCommand,
				createdAt: userMsg.createdAt,
				seq: userMsg.seq,
				children: [],
				creator: userMsg.creator ?? null,
			},
		});
	}

	const { bashTool } = await import("../lib/agent/tools/bash");
	const toolUseId = `toolu_bash_${generateId()}`;
	const toolCallId = generateId();
	const assistantMsgId = generateId();
	const streamStartedAt = Date.now();
	const streamStartedAtIso = new Date(streamStartedAt).toISOString();
	const toolInput = { command, description: command };
	const toolUseBlock = {
		type: "tool_use",
		id: toolUseId,
		name: "Bash",
		input: toolInput,
		streamStartedAt,
	};
	const now = new Date().toISOString();

	// 2. Persist and broadcast a running assistant tool card before the process starts.
	const [assistantMsg] = await db
		.insert(narratorMessages)
		.values({
			id: assistantMsgId,
			narratorId,
			role: "assistant",
			contentJson: [toolUseBlock],
			contentText: null,
			createdAt: now,
		})
		.returning();
	const assistantSeq = await appendMessageRef(narratorId, assistantMsgId);
	await db.insert(narratorToolCalls).values({
		id: toolCallId,
		narratorId,
		messageId: assistantMsgId,
		toolUseId,
		toolName: "Bash",
		inputJson: toolInput,
		status: "running",
		streamStartedAt: streamStartedAtIso,
		createdAt: now,
	});

	broadcastToNarrator(narratorId, {
		type: "message",
		narratorId,
		message: {
			id: assistantMsg.id,
			narratorId,
			role: "assistant",
			contentJson: assistantMsg.contentJson,
			contentText: assistantMsg.contentText,
			createdAt: assistantMsg.createdAt,
			seq: assistantSeq,
			children: [],
			toolCalls: [
				{
					id: toolCallId,
					toolUseId,
					toolName: "Bash",
					inputJson: toolInput,
					status: "running",
					streamStartedAt: streamStartedAtIso,
				},
			],
		},
	});
	broadcastToNarrator(narratorId, {
		type: "tool_started",
		narratorId,
		toolCallId,
		toolUseId,
		toolName: "Bash",
		input: toolInput,
		streamStartedAt,
	});

	// 3. Execute the process with live-output callbacks wired into the WS channel.
	// Set up an AbortController so the interrupt endpoint (Stop button) can
	// terminate this process. When a parent loop signal is provided (runBashFirst
	// flow), chain it so aborting the loop also aborts the bash process.
	const bashAbort = new AbortController();
	const parentSignal = options?.signal;
	const onParentAbort = () => bashAbort.abort();
	if (parentSignal) {
		if (parentSignal.aborted) bashAbort.abort();
		else parentSignal.addEventListener("abort", onParentAbort, { once: true });
	}
	let bashControllers = manualBashAborts.get(narratorId);
	if (!bashControllers) {
		bashControllers = new Set<AbortController>();
		manualBashAborts.set(narratorId, bashControllers);
	}
	bashControllers.add(bashAbort);

	const progressTimer = setInterval(() => {
		broadcastToNarrator(narratorId, {
			type: "tool_progress",
			narratorId,
			toolUseId,
			elapsed: Math.floor((Date.now() - streamStartedAt) / 1000),
		});
	}, 5000);

	let result: Awaited<ReturnType<typeof bashTool.execute>>;
	try {
		result = await bashTool.execute(toolInput, {
			narratorId,
			cwd,
			signal: bashAbort.signal,
			locale: "en",
			requestPermission: async () => ({ behavior: "allow" as const }),
			currentToolUseId: toolUseId,
			emitOutput: (output) => {
				broadcastToNarrator(narratorId, {
					type: "tool_output",
					narratorId,
					toolUseId,
					output,
				});
			},
			emitLongRunning: (_toolUseId, elapsed) => {
				broadcastToNarrator(narratorId, {
					type: "tool_long_running",
					narratorId,
					toolUseId,
					elapsed,
				});
			},
		});
	} catch (err) {
		result = {
			output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
		};
	} finally {
		clearInterval(progressTimer);
		if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
		// Remove only this command's controller; other concurrent manual bash
		// commands for the same narrator keep their entries. Drop the Set once
		// it's empty so the map doesn't accumulate stale narrator keys.
		const controllers = manualBashAborts.get(narratorId);
		if (controllers) {
			controllers.delete(bashAbort);
			if (controllers.size === 0) manualBashAborts.delete(narratorId);
		}
	}

	const completedAt = Date.now();
	const durationMs = completedAt - streamStartedAt;
	const status = result.isError ? "fail" : "success";
	const persistedOutput = result.metadata
		? { _text: result.output, _metadata: result.metadata }
		: result.output;
	const toolResultBlock = {
		type: "tool_result",
		tool_use_id: toolUseId,
		content: result.output,
		is_error: result.isError ?? false,
	};

	await db
		.update(narratorMessages)
		.set({
			contentJson: [toolUseBlock, toolResultBlock],
			durationMs,
		})
		.where(eq(narratorMessages.id, assistantMsgId));
	await narratorService.updateToolCallResult(
		toolUseId,
		{
			output: persistedOutput,
			status,
			errorMessage: result.isError ? result.output : undefined,
			durationMs,
			executionStartedAt: streamStartedAt,
			completedAt,
		},
		assistantMsgId,
		toolCallId,
	);

	broadcastToNarrator(narratorId, {
		type: "tool_completed",
		narratorId,
		toolCallId,
		toolUseId,
		toolName: "Bash",
		status,
		// Same projection as every other broadcast (this used to be a hand-rolled
		// copy of it); the default budget keeps the WS payload bounded.
		output: truncateJson(result.output, DEFAULT_TOOL_IO_BUDGET),
		durationMs,
		...(result.metadata && { metadata: result.metadata }),
	});

	return {
		type: "bash" as const,
		id: userMsg?.id ?? assistantMsgId,
		output: result.output,
		isError: result.isError ?? false,
	};
}

/** Escape characters that would break XML attribute values. */
function escapeXmlAttr(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Controls what happens to a forked narrator's inherited Dynamic Spec tasks:
 * - `"card"` (default): if the parent had any tasks, insert a UI-only display
 *   card in the child so the user can review, clear the tasks, or reset the
 *   whole spec. The card never enters the model history.
 * - `"clear"`: silently empty the child's tasks.json (used for lightweight,
 *   read-only forks like ask-in-passing where task management is just noise).
 */
export type SpecForkCarryover = "card" | "clear";

/**
 * After a fork has copied the parent's Dynamic Spec into the child's (fresh,
 * independent) namespace, apply the requested carryover behavior. All spec
 * operations here target the CHILD narrator only, so nothing can affect the
 * parent. Failures are swallowed: spec carryover must never break a fork.
 */
async function applySpecForkCarryover(
	childNarratorId: string,
	carryover: SpecForkCarryover,
): Promise<void> {
	try {
		if (carryover === "clear") {
			await specVfsService.clearSpecTasks(childNarratorId);
			return;
		}
		// "card": only surface the reset card when there is something to manage.
		const summary = await specVfsService.summarizeSpecTasks(childNarratorId);
		if (summary.total <= 0) return;
		await narratorPersistence.persistDisplayMessage(childNarratorId, "", [
			{
				type: "spec_fork_carryover",
				total: summary.total,
				open: summary.open,
				protectedOpen: summary.protectedOpen,
			},
		]);
	} catch (err) {
		logger.warn("Failed to apply spec fork carryover (non-fatal)", {
			childNarratorId,
			carryover,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * After a narrator's context is fully cleared, its Dynamic Spec tasks.json is
 * left untouched (clearing context only drops model history). If any tasks
 * remain, surface a UI-only card so the user can review, clear the tasks, or
 * reset the whole spec — mirroring the fork carryover card. The card never
 * enters the model history. Failures are swallowed: this must never break the
 * clear-context flow.
 */
async function insertSpecClearedCarryoverCard(narratorId: string): Promise<void> {
	try {
		const summary = await specVfsService.summarizeSpecTasks(narratorId);
		if (summary.total <= 0) return;
		await narratorPersistence.persistDisplayMessage(narratorId, "", [
			{
				type: "spec_context_cleared",
				total: summary.total,
				open: summary.open,
				protectedOpen: summary.protectedOpen,
			},
		]);
	} catch (err) {
		logger.warn("Failed to insert spec cleared carryover card (non-fatal)", {
			narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

type NarratorInsertExecutor = Pick<typeof db, "insert">;

export interface PreparedNarratorCreation {
	row: typeof narrators.$inferInsert;
	handle: string | null;
	handleFold: string | null;
}

export async function prepareNarratorCreation(
	input: CreateNarratorInput,
): Promise<PreparedNarratorCreation> {
	if (input.chapterId) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, input.chapterId),
		});
		if (!chapter) throw new NotFoundError("Chapter", input.chapterId);
		if (chapter.status !== "active") {
			throw new ValidationError("Cannot create narrator for non-active chapter");
		}
	}

	const type = input.type ?? "primary";
	if (type === "primary" && input.chapterId) {
		const existing = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, input.chapterId), eq(narrators.variant, "primary")),
		});
		if (existing) {
			throw new ValidationError("Chapter already has a primary narrator");
		}
	}

	const now = new Date().toISOString();
	const resolvedPermMode = normalizeLegacyPermissionMode(
		input.permissionMode ?? settings.agent.defaultPermissionMode,
		"default",
	);
	const startInPlanMode = input.startInPlanMode ?? settings.agent.defaultStartInPlanMode;
	const previousPermissionMode = startInPlanMode ? resolvedPermMode : null;
	const planFileId = startInPlanMode ? generateWordSlug() : null;
	const storedModel = input.model ?? FOLLOW_DEFAULT_MODEL;
	// Do not固化 the global default: store null unless an explicit effort was
	// passed. A null reasoningEffort means "follow the global default", which
	// is resolved (and clamped per-model) at request time.
	const resolvedReasoningEffort = input.reasoningEffort ?? null;
	// Same reasoning for fast mode: default to "inherit" so a later change to the
	// user's fastModeDefault preference applies to this narrator too. Only an
	// explicit caller choice pins it.
	const resolvedFastModeOverride = fastModeOverrideFromLegacyInput(
		input.fastModeOverride,
		input.fastMode,
	);

	const chapterId = input.chapterId ?? null;
	const traits: string[] = chapterId === null ? ["standalone"] : [];
	if (startInPlanMode) traits.push("plan");

	// Knowledge Steward: a specialized standalone narrator for knowledge-base management.
	// Mark it with a trait, preinstall the knowledge tools (KnowledgeAdmin only for admins),
	// and default its system prompt to the steward instructions when none was supplied.
	const enabledToolsSet = new Set<string>();
	let resolvedSystemPrompt = input.systemPrompt;
	if (input.kind === "knowledge") {
		if (chapterId !== null) {
			throw new ValidationError("Knowledge Steward narrators must be standalone (no chapterId)");
		}
		traits.push(KNOWLEDGE_KIND_TRAIT);
		for (const tool of KNOWLEDGE_KIND_PRELOAD_TOOLS) enabledToolsSet.add(tool);
		if (input.creatorIsAdmin) enabledToolsSet.add(KNOWLEDGE_KIND_PRELOAD_TOOLS_ADMIN);
		if (!resolvedSystemPrompt) {
			resolvedSystemPrompt = buildKnowledgeStewardSystemPrompt(input.locale ?? "en");
		}
	}

	// Setup Assistant: a specialized standalone narrator that installs the system
	// dependencies NarraFork needs (git / rg / dtach). It preinstalls Terminal
	// because package managers often want a PTY. Its dependency briefing is
	// rendered by the caller and passed in as `systemPrompt`; the fallback below
	// only covers callers that supply none.
	if (input.kind === "setup") {
		if (chapterId !== null) {
			throw new ValidationError("Setup Assistant narrators must be standalone (no chapterId)");
		}
		traits.push(SETUP_KIND_TRAIT);
		for (const tool of SETUP_KIND_PRELOAD_TOOLS) enabledToolsSet.add(tool);
		if (!resolvedSystemPrompt) {
			resolvedSystemPrompt = buildSetupAssistantSystemPrompt(input.locale ?? "en");
		}
	}

	// Named narrators must be standalone so they are independent of a chapter lifecycle.
	const makeNamed = input.makeNamed ?? false;
	let displayHandle: string | null = null;
	let foldedHandle: string | null = null;
	if (makeNamed) {
		if (!input.handle) {
			throw new ValidationError("handle is required when creating a named narrator");
		}
		if (chapterId !== null) {
			throw new ValidationError("Named narrators must be standalone (no chapterId)");
		}
		displayHandle = input.handle.trim();
		foldedHandle = foldHandle(displayHandle);
		traits.push("named");
	}

	if (input.extraTraits?.length) {
		for (const trait of input.extraTraits) {
			if (!traits.includes(trait)) traits.push(trait);
		}
	}

	return {
		handle: displayHandle,
		handleFold: foldedHandle,
		row: {
			id: generateId(),
			chapterId,
			type,
			variant: "primary",
			traits,
			handle: displayHandle,
			handleFold: foldedHandle,
			enabledTools: enabledToolsSet.size > 0 ? [...enabledToolsSet] : undefined,
			model: storedModel,
			systemPrompt: resolvedSystemPrompt,
			permissionMode: resolvedPermMode,
			previousPermissionMode,
			planFileId,
			planMode: startInPlanMode,
			reasoningEffort: resolvedReasoningEffort,
			fastModeOverride: resolvedFastModeOverride,
			fastMode: legacyFastModeMirror(resolvedFastModeOverride),
			relaxedPlan: resolveInitialRelaxedPlan({
				permissionMode: resolvedPermMode,
				explicit: input.relaxedPlan,
				defaultRelaxedPlan: settings.agent.defaultRelaxedPlan,
			}),
			planReflectionAutoApproveOverride: input.planReflectionAutoApproveOverride ?? "inherit",
			dangerReflectionOverride: input.dangerReflectionOverride ?? "inherit",
			autoContinuationOverride: input.autoContinuationOverride ?? "inherit",
			behaviorFenceIntervalOverride: input.behaviorFenceIntervalOverride ?? null,
			behaviorFenceAttachOverride: input.behaviorFenceAttachOverride ?? "inherit",
			cwd: input.cwd ?? null,
			contextProjectId: input.contextProjectId ?? null,
			oauthPolicySnapshotJson: input.oauthPolicySnapshotJson ?? null,
			defaultDeviceId: input.defaultDeviceId ?? null,
			ownerUserId: input.ownerUserId ?? null,
			...resolveNarratorAudiences(
				input.visibility,
				input.writeAudience,
				chapterId,
				settings.agent.defaultNarratorVisibility,
				settings.agent.defaultNarratorWriteAudience,
			),
			inheritMode: "fresh",
			status: "idle",
			title: input.title ?? null,
			createdAt: now,
			updatedAt: now,
		},
	};
}

/** Insert a prepared narrator using the caller's synchronous SQLite transaction. */
export function createPreparedNarratorInTransaction(
	executor: NarratorInsertExecutor,
	prepared: PreparedNarratorCreation,
): typeof narrators.$inferSelect {
	return executor.insert(narrators).values(prepared.row).returning().get();
}

/** Publish non-transactional narrator creation side effects after commit. */
export function publishNarratorCreated(narrator: typeof narrators.$inferSelect): void {
	logger.info("Narrator created", {
		id: narrator.id,
		chapterId: narrator.chapterId,
		type: narrator.type,
		handle: narrator.handle,
	});
}

export const narratorService = {
	// ── Core CRUD ──────────────────────────────────────────────────────────────

	async create(input: CreateNarratorInput) {
		const prepared = await prepareNarratorCreation(input);
		const insertNarrator = () =>
			db.transaction((tx) => createPreparedNarratorInTransaction(tx, prepared));

		// Reserve the handle under a global lock so concurrent creates can't both
		// pass the uniqueness check before either inserts.
		const narrator = prepared.handleFold
			? await narratorHandleLock.acquire("handle", async () => {
					await this.assertHandleAvailable(prepared.handle as string);
					return insertNarrator();
				})
			: insertNarrator();

		publishNarratorCreated(narrator);
		return narrator;
	},

	async createSubagent(input: CreateSubagentInput) {
		if (input.subagentOriginKind === "standalone" && input.originToolCallId != null) {
			throw new ValidationError("Standalone subagents cannot have an Agent tool-call origin");
		}
		const parent = await this.getById(input.parentNarratorId);

		if (isSubagentVariant(parent.variant)) {
			throw new ValidationError("Subagents cannot spawn nested subagents");
		}
		if (input.originToolCallId != null) {
			const origin = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, input.originToolCallId),
				columns: {
					narratorId: true,
					toolUseId: true,
					toolName: true,
					status: true,
					executionAttempt: true,
					executionStartedAt: true,
				},
			});
			if (
				!origin ||
				origin.narratorId !== input.parentNarratorId ||
				origin.toolName !== "Agent" ||
				origin.status !== "running" ||
				!origin.executionStartedAt
			) {
				throw new ValidationError("Subagent origin must be its parent's executing Agent row");
			}
			await narratorPersistence.validateToolCallBinding(input.parentNarratorId, origin.toolUseId, {
				toolCallId: input.originToolCallId,
				attempt: origin.executionAttempt,
			});
		}

		const now = new Date().toISOString();
		const id = generateId();

		let basePermMode = input.permissionMode ?? parent.permissionMode ?? "default";
		if (parseTraits(parent.traits).includes("plan")) {
			const parentRelaxed = resolveInitialRelaxedPlan({
				permissionMode: parent.permissionMode,
				explicit: parent.relaxedPlan ?? undefined,
				defaultRelaxedPlan: settings.agent.defaultRelaxedPlan,
			});
			basePermMode = parentRelaxed ? (parent.permissionMode ?? "default") : "readOnly";
		}
		const resolvedPermMode = basePermMode as
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "readOnly"
			| "dontAsk";
		const resolvedRelaxedPlan = resolveInitialRelaxedPlan({
			permissionMode: resolvedPermMode,
			explicit: parent.relaxedPlan ?? undefined,
			defaultRelaxedPlan: settings.agent.defaultRelaxedPlan,
		});

		const resolvedModel = resolveEffectiveModel(input.model ?? parent.model);
		// Inherit the parent's explicit override if any; otherwise store null
		// (follow the global default). Never固化 the resolved default here.
		const resolvedReasoningEffort = input.reasoningEffort ?? parent.reasoningEffort ?? null;

		const subChapterId = parent.chapterId ?? null;
		const subTraits: string[] = [
			...(subChapterId === null ? ["standalone"] : []),
			...(input.inheritedTraits ?? []),
		];

		const [narrator] = await db
			.insert(narrators)
			.values({
				id,
				chapterId: subChapterId,
				type: "subagent",
				subagentType: input.subagentType,
				variant: subagentVariant(input.subagentType),
				traits: subTraits,
				title: input.title ?? null,
				model: resolvedModel,
				systemPrompt: input.systemPrompt ?? null,
				permissionMode: resolvedPermMode,
				reasoningEffort: resolvedReasoningEffort,
				fastModeOverride: normalizeBooleanOverride(parent.fastModeOverride),
				fastMode: legacyFastModeMirror(parent.fastModeOverride),
				relaxedPlan: resolvedRelaxedPlan,
				planReflectionAutoApproveOverride:
					input.planReflectionAutoApproveOverride ??
					parent.planReflectionAutoApproveOverride ??
					"inherit",
				dangerReflectionOverride: parent.dangerReflectionOverride ?? "inherit",
				autoContinuationOverride: parent.autoContinuationOverride ?? "inherit",
				behaviorFenceIntervalOverride: parent.behaviorFenceIntervalOverride ?? null,
				behaviorFenceAttachOverride: parent.behaviorFenceAttachOverride ?? "inherit",
				parentNarratorId: input.parentNarratorId,
				originToolCallId: input.originToolCallId ?? null,
				subagentOriginKind:
					input.originToolCallId != null ? "tool" : (input.subagentOriginKind ?? null),
				cwd: input.cwd,
				defaultDeviceId: input.defaultDeviceId ?? parent.defaultDeviceId ?? null,
				// A subagent is part of its parent's work, so its access is DELEGATED to the
				// root rather than copied: `acl_root_narrator_id` is the only thing consulted
				// when deciding who may read or drive it. That is what makes a later sharing
				// change on the main session reach its subagents — there is nothing to
				// propagate, because there is no copy. Copying used to be the approach, and
				// sharing a parent afterwards silently left its subagents unreachable.
				//
				// Nested subagents point at the same root, so the chain is never walked on a
				// decision path.
				aclRootNarratorId: parent.aclRootNarratorId ?? input.parentNarratorId,
				// Kept because "whose work is this" is still read for listings, attribution
				// and user deletion — it just no longer decides access.
				ownerUserId: parent.ownerUserId,
				// Frozen at their strictest values ON PURPOSE, not copied from the parent.
				// Delegation means these are never consulted, and a copy that cannot follow
				// the root is a trap: any future code path that reads them instead of the
				// judged row would get a stale snapshot that may be WIDER than the root.
				// Pinning them here makes such a mistake fail closed instead of leaking.
				visibility: "private",
				writeAudience: "owner",
				inheritMode: "fresh",
				status: "working",
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		logger.info("Subagent created", {
			id,
			parentNarratorId: input.parentNarratorId,
			subagentType: input.subagentType,
		});
		return narrator;
	},

	/**
	 * List all subagents belonging to a parent narrator.
	 *
	 * Unbounded on purpose: selector resolution (`Send`, `Await`, `ContextAsk`)
	 * needs to see every candidate or it would report "no such subagent" for one
	 * that exists. Callers that only DISPLAY the team must use
	 * `listSubagentsForTeamView`, which is bounded.
	 */
	async listSubagentsByParent(parentNarratorId: string) {
		return db.query.narrators.findMany({
			where: eq(narrators.parentNarratorId, parentNarratorId),
			orderBy: (n, { asc }) => [asc(n.createdAt)],
		});
	},

	/**
	 * Bounded team listing for display, ordered by usefulness rather than by age.
	 *
	 * A narrator that keeps working keeps spawning subagents, and unlike background
	 * task rows these are never reaped — so the full list grows for the lifetime of
	 * the session. `TeamStatus` printed all of it into the model's context.
	 *
	 * Ordering is `active first, then most recent`: `working`/`waiting` members are
	 * what a coordination question is actually about, and among the rest the newest
	 * are the ones the caller just launched. Plain `createdAt` ordering buries a
	 * still-running agent under dozens of finished ones as soon as the team is
	 * larger than the limit. The same ordering applies to a search, so `omitted`
	 * stays a correct remainder for the rows actually shown.
	 *
	 * `query` matches title / alias traits / id prefix — the same handles the
	 * listing prints, so a member found by name can be addressed by that name.
	 *
	 * Only the display columns are selected: the full row carries `systemPrompt` and
	 * `contextSummary`, which can be large and which no listing renders.
	 *
	 * `omitted` is capped: an exact remainder would be an unbounded `COUNT(*)` on
	 * the very table this method exists to stop scanning.
	 */
	async listSubagentsForTeamView(input: {
		parentNarratorId: string;
		limit: number;
		query?: string;
	}): Promise<{
		subagents: TeamViewSubagent[];
		omitted: number;
		omittedCapped: boolean;
	}> {
		const limit = Math.max(1, Math.trunc(input.limit));
		const needle = escapeLikeNeedle(input.query);
		const conditions = [eq(narrators.parentNarratorId, input.parentNarratorId)];
		if (needle) {
			const like = `%${needle}%`;
			const match = or(
				sql`${narrators.title} LIKE ${like} ESCAPE '\\'`,
				// Aliases live in the traits JSON array as `subagent-alias:<slug>`; a
				// LIKE over the raw JSON text is enough for a display filter and needs
				// no json1 table function.
				sql`${narrators.traits} LIKE ${like} ESCAPE '\\'`,
				sql`${narrators.id} LIKE ${`${needle}%`} ESCAPE '\\'`,
			);
			if (match) conditions.push(match);
		}
		const where = and(...conditions);
		// Active members first. A CASE rather than a status filter so both groups come
		// back in one query and one ordering — and NOT a bare `sql\`1\``, which SQLite
		// reads as the ordinal of the first selected column.
		const activeFirst = sql`CASE WHEN ${narrators.status} IN ('working','waiting') THEN 0 ELSE 1 END`;

		const rows = await db
			.select({
				id: narrators.id,
				title: narrators.title,
				traits: narrators.traits,
				variant: narrators.variant,
				status: narrators.status,
				createdAt: narrators.createdAt,
			})
			.from(narrators)
			.where(where)
			.orderBy(activeFirst, desc(narrators.createdAt), desc(narrators.id))
			.limit(limit)
			.all();

		const remainder = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(where)
			.orderBy(activeFirst, desc(narrators.createdAt), desc(narrators.id))
			.limit(TEAM_VIEW_OMITTED_COUNT_CAP + 1)
			.offset(rows.length)
			.all();

		return {
			subagents: rows,
			omitted: Math.min(remainder.length, TEAM_VIEW_OMITTED_COUNT_CAP),
			omittedCapped: remainder.length > TEAM_VIEW_OMITTED_COUNT_CAP,
		};
	},

	/**
	 * Persist a subagent's `role: "user"` turn.
	 *
	 * ## What is left here, and why it is not drift
	 *
	 * The WRITE itself is now `persistUserMessage` with a `parentToolUseId` placement —
	 * there is one insert path for user rows again. Three things remain this method's
	 * own, and each is a decision the generic entry point must NOT make:
	 *
	 * 1. **Explicit delivery attribution.** The in-pass drain, pass-restart drain and
	 *    `resumeSubagent` carry an envelope only for agent-authored messages. It owns
	 *    the exact reserved message ID and reader-facing body. No text/hash registry is
	 *    consulted: a cleared, reordered or failed delivery cannot label human input.
	 * 2. **Withholding the creator for AI-authored text.** `createdBy` stays audit data,
	 *    but the creator ROW is what a bubble header renders as the author, so a machine's
	 *    words must not be signed with a real person's avatar. The generic path keeps
	 *    returning the creator whenever `createdBy` is set, because primary-narrator
	 *    producers (a scheduled task run) legitimately pair an account with a non-human
	 *    origin and their UI depends on it.
	 * 3. **Attachment blocks + the empty-text placeholder.** Image/text-file blocks and
	 *    the `[user sent image(s)]` fallback are a subagent-page input concern; the
	 *    primary path builds its blocks in `feedMessage`.
	 *
	 * An explicit `origin` still wins, so a caller that knows better is never overridden.
	 */
	async persistSubagentUserMessage(
		narratorId: string,
		text: string,
		parentToolUseId: string,
		options?: {
			images?: ImageRef[];
			textFiles?: TextFileRef[];
			fileReferences?: import("@shared/file-reference").FileReferenceSnapshot[];
			commandText?: string | null;
			createdBy?: string | null;
			origin?: MessageOriginOptions;
			delivery?: import("./agent-message-delivery").AgentMessageDelivery;
			mailboxClaim?: import("./agent-runtime/mailbox-types").MailboxClaim;
		},
	) {
		const delivery = options?.delivery;
		if (delivery && delivery.recipientNarratorId !== narratorId) {
			throw new ValidationError("Agent delivery recipient does not match message recipient");
		}
		const origin =
			options?.origin ?? (delivery ? buildAgentMessageOrigin(delivery.sender) : undefined);
		const contentJson: Array<
			| { type: "text"; text: string }
			| PersistedUserImageBlock
			| SystemInjectionBlock
			| { type: "text_file"; filename: string; size: number; filePath: string }
			| import("@shared/file-reference").FileReferenceSnapshot
		> = [];
		for (const image of options?.images ?? []) {
			contentJson.push(imageRefToContentBlock(image));
		}
		for (const file of options?.textFiles ?? []) {
			contentJson.push({
				type: "text_file",
				filename: file.filename,
				size: file.size,
				filePath: file.filePath,
			});
		}
		contentJson.push(...(options?.fileReferences ?? []));
		contentJson.push({ type: "text", text });
		if (delivery) {
			contentJson.push(
				buildSystemInjectionBlock("subagent_message", agentMessageDeliveryBody(delivery)),
			);
		}
		const effectiveText =
			(!text.trim() && (options?.images?.length ?? 0) > 0 ? "[user sent image(s)]" : text) +
			buildAttachedFilesHint(options?.textFiles ?? []);
		const msg = await narratorPersistence.persistUserMessage(
			narratorId,
			effectiveText,
			contentJson,
			options?.commandText ?? null,
			options?.createdBy ?? null,
			origin,
			{
				parentToolUseId,
				messageId: delivery?.recipientMessageId,
				mailboxClaim: options?.mailboxClaim ?? delivery?.mailboxClaim,
			},
		);
		// See (2) above: withheld here rather than in the shared entry point, so the
		// row's `created_by` survives as audit data while the rendered author does not
		// claim a human wrote it.
		const authoredByHuman = (origin?.origin ?? "user") === "user";
		return authoredByHuman ? msg : { ...msg, creator: null };
	},

	/**
	 * Load a narrator, optionally enforcing that a user may reach it.
	 *
	 * `acl` is optional on purpose. Internal callers — the agent loop, background
	 * jobs, event handlers, cascade deletes — act on behalf of the system and have
	 * no requesting user, so demanding one would either be a lie or force every
	 * such path to invent an identity. Anything serving an HTTP/WS request passes
	 * `acl` (routes normally go through `requireNarratorAccess`, which does it for
	 * them).
	 *
	 * A denied access reports NotFoundError, identical to a missing row, so no
	 * caller can distinguish "exists but not yours" from "does not exist".
	 */
	async getById(id: string, acl?: { userId: string; isAdmin: boolean; need?: NarratorAccessNeed }) {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, id),
		});
		if (!narrator) throw new NotFoundError("Narrator", id);
		if (acl) {
			await assertNarratorAccess(
				narrator,
				{ userId: acl.userId, isAdmin: acl.isAdmin },
				acl.need ?? "read",
			);
		}
		return narrator;
	},

	// ── Named narrators (handle-based @mention targets) ─────────────────────────

	/**
	 * Look up a named narrator by its handle (case-insensitive). Matches against
	 * the folded form so "@MyBot"/"@mybot"/"@MYBOT" all resolve to the same
	 * narrator. Returns null if no narrator owns the handle. Does not throw.
	 */
	async getByHandle(handle: string) {
		const folded = foldHandle(handle.trim());
		if (!folded) return null;
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.handleFold, folded),
		});
		return narrator ?? null;
	},

	/**
	 * Throw a ValidationError if the handle is already taken by another narrator
	 * (case-insensitive). `excludeNarratorId` lets a narrator keep its own handle
	 * when re-validating.
	 */
	async assertHandleAvailable(handle: string, excludeNarratorId?: string) {
		const existing = await this.getByHandle(handle);
		if (existing && existing.id !== excludeNarratorId) {
			throw new ValidationError(`Handle "@${handle}" is already taken`);
		}
	},

	/** List all named narrators (traits include "named"), most recent first. */
	async listNamed() {
		const rows = await db.query.narrators.findMany({
			where: and(eq(narrators.type, "primary"), isNotNull(narrators.handle)),
			orderBy: (n, { desc }) => [desc(n.lastMessageAt), desc(n.createdAt)],
		});
		// Defensive: only return those actually flagged as named.
		return rows.filter((n) => parseTraits(n.traits).includes("named"));
	},

	/**
	 * Assign, change, or clear a narrator's handle. Passing null clears it and
	 * removes the "named" trait. Uniqueness is enforced under a global lock.
	 */
	async setHandle(narratorId: string, handle: string | null) {
		return narratorHandleLock.acquire("handle", async () => {
			const narrator = await this.getById(narratorId);
			if (isSubagentVariant(narrator.variant)) {
				throw new ValidationError("Subagents cannot be named");
			}
			// Preserve the user's original case in `handle`; match/uniqueness use the fold.
			const displayHandle = handle === null ? null : handle.trim();
			const foldedHandle = displayHandle ? foldHandle(displayHandle) : null;
			if (displayHandle) {
				if (narrator.chapterId !== null) {
					throw new ValidationError("Only standalone narrators can be named");
				}
				await this.assertHandleAvailable(displayHandle, narratorId);
			}
			const currentTraits = parseTraits(narrator.traits);
			const nextTraits = currentTraits.filter((t) => t !== "named");
			if (displayHandle) {
				nextTraits.push("named");
			}
			const [updated] = await db
				.update(narrators)
				.set({
					handle: displayHandle,
					handleFold: foldedHandle,
					traits: nextTraits,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, narratorId))
				.returning();
			logger.info("Narrator handle updated", { narratorId, handle: displayHandle });
			return updated;
		});
	},

	async listByChapter(chapterId: string) {
		return db.query.narrators.findMany({
			where: and(eq(narrators.chapterId, chapterId), eq(narrators.variant, "primary")),
			orderBy: (n, { asc }) => [asc(n.createdAt)],
		});
	},

	async remove(narratorId: string) {
		const children = await db.query.narrators.findMany({
			where: eq(narrators.parentNarratorId, narratorId),
			columns: { id: true },
		});
		for (const child of children) {
			await this.remove(child.id);
		}

		// Any surviving narrator that still borrows pre-compact refs from this one must
		// materialize what it can keep and drop the link first: the self-FK would abort
		// the delete below, and a dangling pointer would silently hide its history.
		await materializeChildrenOf(narratorId);

		const preserveUploads = await hasSharedOwnedImageMessages(narratorId);

		const bindingTransition = db.transaction((tx) => {
			const transition = integrationResourceBindingService.markDeletedInTransaction(
				tx,
				"narrator",
				narratorId,
			);
			tx.delete(terminalViewState).where(eq(terminalViewState.narratorId, narratorId)).run();
			tx.delete(terminals).where(eq(terminals.narratorId, narratorId)).run();
			tx.delete(narratorBufferedMessages)
				.where(eq(narratorBufferedMessages.narratorId, narratorId))
				.run();
			tx.delete(narratorFileSnapshots)
				.where(eq(narratorFileSnapshots.narratorId, narratorId))
				.run();
			tx.delete(narratorPatches).where(eq(narratorPatches.narratorId, narratorId)).run();
			tx.delete(narratorWhitelistDirs)
				.where(eq(narratorWhitelistDirs.narratorId, narratorId))
				.run();
			tx.delete(narratorBlacklistDirs)
				.where(eq(narratorBlacklistDirs.narratorId, narratorId))
				.run();
			tx.delete(narratorWhitelistCmds)
				.where(eq(narratorWhitelistCmds.narratorId, narratorId))
				.run();
			tx.delete(narratorBlacklistCmds)
				.where(eq(narratorBlacklistCmds.narratorId, narratorId))
				.run();
			tx.delete(apiRequests).where(eq(apiRequests.narratorId, narratorId)).run();
			tx.update(chapterCommits)
				.set({ narratorId: null })
				.where(eq(chapterCommits.narratorId, narratorId))
				.run();
			tx.update(benchmarkTaskResults)
				.set({ narratorId: null })
				.where(eq(benchmarkTaskResults.narratorId, narratorId))
				.run();
			tx.delete(gatewaySessionMappings)
				.where(eq(gatewaySessionMappings.narratorId, narratorId))
				.run();
			tx.delete(backgroundTasks).where(eq(backgroundTasks.subagentNarratorId, narratorId)).run();
			tx.delete(backgroundTasks).where(eq(backgroundTasks.parentNarratorId, narratorId)).run();
			tx.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId)).run();
			deleteRecipientMessageRefs(tx).where(eq(narratorMessageRefs.narratorId, narratorId)).run();

			const sharedRows = tx
				.select({
					id: narratorMessages.id,
					contentJson: narratorMessages.contentJson,
					newOwnerId: sql<string>`(
						SELECT nmr.narrator_id FROM narrator_message_refs nmr
						WHERE nmr.message_id = ${narratorMessages.id}
						ORDER BY nmr.seq ASC
						LIMIT 1
					)`,
				})
				.from(narratorMessages)
				.where(
					and(
						eq(narratorMessages.narratorId, narratorId),
						sql`EXISTS (
							SELECT 1 FROM narrator_message_refs nmr
							WHERE nmr.message_id = ${narratorMessages.id}
						)`,
					),
				)
				.all();

			for (const row of sharedRows) {
				const contentJson = annotateImageBlocksWithUploadOwner(row.contentJson, narratorId);
				tx.update(narratorMessages)
					.set({ narratorId: row.newOwnerId, contentJson })
					.where(eq(narratorMessages.id, row.id))
					.run();
			}

			const orphanRows = tx
				.select({ id: narratorMessages.id })
				.from(narratorMessages)
				.where(
					and(
						eq(narratorMessages.narratorId, narratorId),
						sql`NOT EXISTS (
							SELECT 1 FROM narrator_message_refs nmr
							WHERE nmr.message_id = ${narratorMessages.id}
						)`,
					),
				)
				.all();
			const orphanIds = orphanRows.map((r) => r.id);

			if (orphanIds.length > 0) {
				tx.update(narrators)
					.set({ forkMessageId: null })
					.where(inArray(narrators.forkMessageId, orphanIds))
					.run();
				tx.update(chapterCommits)
					.set({ narratorMessageId: null })
					.where(inArray(chapterCommits.narratorMessageId, orphanIds))
					.run();
				tx.update(apiRequests)
					.set({ messageId: null })
					.where(inArray(apiRequests.messageId, orphanIds))
					.run();
				tx.delete(narratorPatches).where(inArray(narratorPatches.messageId, orphanIds)).run();
				tx.delete(narratorToolCalls).where(inArray(narratorToolCalls.messageId, orphanIds)).run();
				tx.delete(narratorMessages).where(inArray(narratorMessages.id, orphanIds)).run();
			}

			tx.delete(narrators).where(eq(narrators.id, narratorId)).run();
			return transition;
		});
		// FK cascades remove durable questions without emitting their own lifecycle frames.
		eventBus.emit({ type: "human_attention:changed" });
		if (bindingTransition) {
			await integrationResourceBindingService.recordTransitionAudit(
				"resource_binding.delete",
				bindingTransition,
			);
		}

		await removeTabFromAllUsers("narrator", narratorId).catch((err) => {
			logger.warn("Failed to clean up recent tabs after narrator delete", {
				narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
		});

		if (preserveUploads) {
			logger.info("Preserving narrator uploads because shared image messages still exist", {
				narratorId,
			});
		} else {
			await deleteNarratorUploads(narratorId);
		}

		// Remove any pack extraction directories this narrator owned. The activation rows +
		// whitelist rows are already gone (FK cascade / explicit delete above); this clears the
		// on-disk temp dirs that DB cascade can't reach.
		await deleteNarratorPackExtractions(narratorId);

		logger.info("Narrator removed", { narratorId });
	},

	// ── Fork ──────────────────────────────────────────────────────────────────

	async forkFromMessages(
		parentNarratorId: string,
		messageIds: string[],
		opts?: { title?: string },
	) {
		const parent = await this.getById(parentNarratorId);
		if (isSubagentVariant(parent.variant)) {
			throw new ValidationError("Cannot fork from a subagent narrator");
		}

		const parentRefs = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
				isCompact: narratorMessageRefs.isCompact,
			})
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, parentNarratorId),
					inArray(narratorMessageRefs.messageId, messageIds),
				),
			)
			.orderBy(narratorMessageRefs.seq);

		if (parentRefs.length === 0) {
			throw new ValidationError("None of the specified messages belong to this narrator");
		}

		const now = new Date().toISOString();
		const id = generateId();
		const storedModel = parent.model ?? FOLLOW_DEFAULT_MODEL;
		const resolvedPermMode = (parent.permissionMode ?? "default") as
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "readOnly"
			| "dontAsk";

		// Fork inserts the narrator row first, then initializeRefSeqFloor — do not pre-raise
		// a not-yet-inserted id. withSeqFloorRaiseScope marks after the tx commits because
		// initializeRefSeqFloor records into the active raise scope.
		const newNarrator = withSeqFloorRaiseScope(() =>
			db.transaction((tx) => {
				// Insert first so this transaction owns SQLite's write lock before it
				// snapshots the parent's marker state.
				const created = tx
					.insert(narrators)
					.values({
						id,
						chapterId: null,
						type: "primary",
						variant: "primary",
						traits: ["standalone"],
						model: storedModel,
						systemPrompt: parent.systemPrompt,
						permissionMode: resolvedPermMode,
						reasoningEffort: parent.reasoningEffort ?? null,
						fastModeOverride: normalizeBooleanOverride(parent.fastModeOverride),
						fastMode: legacyFastModeMirror(parent.fastModeOverride),
						relaxedPlan: resolveInitialRelaxedPlan({
							permissionMode: resolvedPermMode,
							explicit: parent.relaxedPlan ?? undefined,
							defaultRelaxedPlan: false,
						}),
						planReflectionAutoApproveOverride:
							parent.planReflectionAutoApproveOverride ?? "inherit",
						dangerReflectionOverride: parent.dangerReflectionOverride ?? "inherit",
						autoContinuationOverride: parent.autoContinuationOverride ?? "inherit",
						behaviorFenceIntervalOverride: parent.behaviorFenceIntervalOverride ?? null,
						behaviorFenceAttachOverride: parent.behaviorFenceAttachOverride ?? "inherit",
						parentNarratorId,
						// A fork carries the parent's history, so it must not be reachable by a
						// wider audience than the parent was. Both axes are copied, not delegated:
						// a fork is an independent session (`type: "primary"`), and its owner must
						// be able to re-share it without the origin's settings overriding them.
						ownerUserId: parent.ownerUserId,
						visibility: parent.visibility,
						writeAudience: parent.writeAudience,
						inheritMode: "full",
						status: "idle",
						title: opts?.title ?? null,
						cwd: parent.cwd ?? null,
						createdAt: now,
						updatedAt: now,
					})
					.returning()
					.get();

				// Re-read selected refs in this synchronous transaction. A compact can
				// finalize after the request preflight; only the state visible here may be
				// shared with the child.
				const pendingCompactIds = selectPendingCompactMessageIds(tx);
				const stableParentRefs = tx
					.select({
						messageId: narratorMessageRefs.messageId,
						seq: narratorMessageRefs.seq,
						isCompact: narratorMessageRefs.isCompact,
					})
					.from(narratorMessageRefs)
					.where(
						and(
							eq(narratorMessageRefs.narratorId, parentNarratorId),
							inArray(narratorMessageRefs.messageId, messageIds),
							excludePendingCompactCondition(pendingCompactIds),
						),
					)
					.orderBy(narratorMessageRefs.seq)
					.all();

				const dupRefValues = stableParentRefs.map((row, i) => ({
					id: generateId(),
					narratorId: id,
					messageId: row.messageId,
					seq: i + 1,
					isCompact: 0,
				}));
				insertRefsBatched(tx, dupRefValues);
				const nextSeq = initializeRefSeqFloor(tx, id);

				return { ...created, nextSeq };
			}),
		);

		await specVfsService.forkSpecNamespace(parentNarratorId, newNarrator.id);
		await applySpecForkCarryover(newNarrator.id, "card");
		return newNarrator;
	},

	async forkNarrator(
		parentNarratorId: string,
		forkMessageUuid: string | null,
		opts?: {
			title?: string;
			newChapterId?: string;
			inheritMode?: "full" | "compressed" | "fresh";
			locale?: string;
			forkMessageId?: string;
			/** Allow forking a chapter-bound narrator into a standalone narrator (no chapter). */
			standalone?: boolean;
			/**
			 * What to do with the inherited Dynamic Spec tasks in the child.
			 * Defaults to `"card"` (surface a reset card when tasks exist).
			 */
			specCarryover?: SpecForkCarryover;
		},
	) {
		const parent = await this.getById(parentNarratorId);

		if (isSubagentVariant(parent.variant)) {
			throw new ValidationError("Cannot fork from a subagent narrator");
		}

		if (parent.chapterId && !opts?.newChapterId && !opts?.standalone) {
			throw new ValidationError(
				"Chapter-bound narrators can only be forked together with a chapter",
			);
		}

		const inheritMode = opts?.inheritMode ?? "fresh";
		const now = new Date().toISOString();
		const id = generateId();

		const resolvedPermMode = (parent.permissionMode ?? "default") as
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "readOnly"
			| "dontAsk";

		const targetChapterId = opts?.newChapterId ?? null;

		let contextSummary: string | null = null;
		let apiConversationId: string | null = null;
		let systemPrompt = parent.systemPrompt;

		if (inheritMode === "compressed") {
			const { narratorContext } = await import("./narrator-context");
			const locale = (opts?.locale ?? "en") as import("../lib/prompt-i18n").Locale;
			contextSummary = await narratorContext.generateContextSummary(parentNarratorId, locale);
			if (contextSummary && parent.systemPrompt) {
				systemPrompt = `${parent.systemPrompt}\n\n## Previous Context Summary\n\nThis session continues from a previous conversation. Here is a summary of the prior context:\n\n${contextSummary}`;
			}
		} else if (inheritMode === "full") {
			// Do NOT inherit apiConversationId: forked narrators must use their
			// own upstream session to avoid sharing a sticky routing slot in NUG
			// (which causes queue contention and unintended co-migration on
			// credential switches). The first request will establish a fresh
			// upstream session automatically.
			apiConversationId = null;
			contextSummary = parent.contextSummary ?? null;
		}

		let prefixRows: Array<{
			messageId: string;
			seq: number;
			isCompact: number;
			segmentCompactId: string | null;
		}> = [];
		let resolvedForkMessageId: string | null = null;
		let forkCompactSeq: number | undefined;
		let requestedForkMessageId: string | null = null;
		let pendingCompactIds: string[] = [];

		const directMessageId = opts?.forkMessageId;
		if ((forkMessageUuid || directMessageId) && inheritMode !== "fresh") {
			// A caller may identify the fork point by either coordinate: the SDK
			// message uuid (only assistant messages carry one) or the local row id.
			// Prefer the explicit row id, then resolve the uuid, then accept a
			// uuid-shaped argument that is actually a row id (older callers passed
			// the id through this parameter).
			if (directMessageId) {
				requestedForkMessageId = directMessageId;
			} else if (forkMessageUuid) {
				const msg = await db.query.narratorMessages.findFirst({
					where: eq(narratorMessages.messageUuid, forkMessageUuid),
					columns: { id: true },
				});
				if (msg) {
					requestedForkMessageId = msg.id;
				} else {
					const byId = await db.query.narratorMessages.findFirst({
						where: eq(narratorMessages.id, forkMessageUuid),
						columns: { id: true },
					});
					if (!byId) throw new ValidationError("Fork message not found");
					requestedForkMessageId = byId.id;
				}
			}
		}

		const storedModel = parent.model ?? FOLLOW_DEFAULT_MODEL;
		// Inherit the parent's explicit override if any; otherwise store null
		// (follow the global default). Never固化 the resolved default here.
		const resolvedReasoningEffort = parent.reasoningEffort ?? null;

		const forkTraits2: string[] = targetChapterId ? [] : ["standalone"];

		// Same as forkFromMessages: insert first, initializeRefSeqFloor after refs land.
		const newNarrator = withSeqFloorRaiseScope(() =>
			db.transaction((tx) => {
				// Insert before reading parent refs so this transaction acquires the write
				// lock first; a concurrent finalize then waits and cannot change the state
				// between our final read and ref copy.
				tx.insert(narrators)
					.values({
						id,
						chapterId: targetChapterId,
						type: "primary",
						variant: "primary",
						traits: forkTraits2,
						model: storedModel,
						systemPrompt,
						permissionMode: resolvedPermMode,
						reasoningEffort: resolvedReasoningEffort,
						fastModeOverride: normalizeBooleanOverride(parent.fastModeOverride),
						fastMode: legacyFastModeMirror(parent.fastModeOverride),
						relaxedPlan: resolveInitialRelaxedPlan({
							permissionMode: resolvedPermMode,
							explicit: parent.relaxedPlan ?? undefined,
							defaultRelaxedPlan: settings.agent.defaultRelaxedPlan,
						}),
						planReflectionAutoApproveOverride:
							parent.planReflectionAutoApproveOverride ?? "inherit",
						dangerReflectionOverride: parent.dangerReflectionOverride ?? "inherit",
						autoContinuationOverride: parent.autoContinuationOverride ?? "inherit",
						behaviorFenceIntervalOverride: parent.behaviorFenceIntervalOverride ?? null,
						behaviorFenceAttachOverride: parent.behaviorFenceAttachOverride ?? "inherit",
						parentNarratorId,
						forkMessageId: null,
						// Same rule as forkFromMessages: inherited history keeps the parent's
						// audiences, both of them. When the fork lands in a chapter it is at least
						// project-visible anyway, so inheriting can only narrow, never widen.
						ownerUserId: parent.ownerUserId,
						visibility: parent.visibility,
						writeAudience: parent.writeAudience,
						inheritMode,
						apiConversationId,
						contextSummary,
						status: "idle",
						title: opts?.title ?? null,
						cwd: parent.cwd ?? null,
						createdAt: now,
						updatedAt: now,
					})
					.run();

				// Resolve and copy refs in one synchronous transaction. This closes the
				// finalize window: either the finalizer commits first (so its stable marker
				// is copied) or the fork commits first (so an active marker is omitted).
				//
				// The in-flight compact markers are resolved once, up front, through the
				// partial index — so none of the queries below has to join message bodies.
				pendingCompactIds = selectPendingCompactMessageIds(tx);
				const excludePending = excludePendingCompactCondition(pendingCompactIds);
				if (requestedForkMessageId) {
					const forkRef = tx.query.narratorMessageRefs
						.findFirst({
							where: and(
								eq(narratorMessageRefs.narratorId, parentNarratorId),
								eq(narratorMessageRefs.messageId, requestedForkMessageId),
							),
						})
						.sync();
					if (!forkRef) {
						throw new ValidationError("Fork message not found in parent narrator's refs");
					}
					// Only the history the model still sees is materialized: everything up to
					// and including the last stable compact at or before the fork point is
					// left in the parent and backfilled on demand (see narrator-refs-backfill).
					const lastCompact = tx
						.select({ seq: narratorMessageRefs.seq })
						.from(narratorMessageRefs)
						.where(
							and(
								eq(narratorMessageRefs.narratorId, parentNarratorId),
								eq(narratorMessageRefs.isCompact, 1),
								sql`${narratorMessageRefs.seq} <= ${forkRef.seq}`,
								excludePending,
							),
						)
						.orderBy(sql`${narratorMessageRefs.seq} DESC`)
						.limit(1)
						.all();
					forkCompactSeq = lastCompact[0]?.seq;
					prefixRows = tx
						.select({
							messageId: narratorMessageRefs.messageId,
							seq: narratorMessageRefs.seq,
							isCompact: narratorMessageRefs.isCompact,
							segmentCompactId: narratorMessageRefs.segmentCompactId,
						})
						.from(narratorMessageRefs)
						.where(
							and(
								eq(narratorMessageRefs.narratorId, parentNarratorId),
								forkCompactSeq != null
									? sql`${narratorMessageRefs.seq} > ${forkCompactSeq}`
									: undefined,
								sql`${narratorMessageRefs.seq} <= ${forkRef.seq}`,
								sql`${narratorMessageRefs.segmentCompactId} IS NULL`,
								excludePending,
							),
						)
						.orderBy(narratorMessageRefs.seq)
						.all();
					resolvedForkMessageId = prefixRows.at(-1)?.messageId ?? null;
				} else if (inheritMode === "full") {
					const lastCompact = tx
						.select({ seq: narratorMessageRefs.seq })
						.from(narratorMessageRefs)
						.where(
							and(
								eq(narratorMessageRefs.narratorId, parentNarratorId),
								eq(narratorMessageRefs.isCompact, 1),
								excludePending,
							),
						)
						.orderBy(sql`${narratorMessageRefs.seq} DESC`)
						.limit(1)
						.all();
					forkCompactSeq = lastCompact[0]?.seq;
					const rows = tx
						.select({
							messageId: narratorMessageRefs.messageId,
							seq: narratorMessageRefs.seq,
							isCompact: narratorMessageRefs.isCompact,
							segmentCompactId: narratorMessageRefs.segmentCompactId,
						})
						.from(narratorMessageRefs)
						.where(
							and(
								eq(narratorMessageRefs.narratorId, parentNarratorId),
								forkCompactSeq != null
									? sql`${narratorMessageRefs.seq} > ${forkCompactSeq}`
									: undefined,
								sql`${narratorMessageRefs.segmentCompactId} IS NULL`,
								excludePending,
							),
						)
						.orderBy(sql`${narratorMessageRefs.seq} DESC`)
						.limit(MAX_INHERITED_FULL_FORK_REFS + 1)
						.all();

					if (rows.length > MAX_INHERITED_FULL_FORK_REFS) {
						prefixRows = rows.slice(0, MAX_INHERITED_FULL_FORK_REFS).reverse();
						logger.warn("Full narrator fork context truncated to safe ref limit", {
							parentNarratorId,
							newNarratorId: id,
							limit: MAX_INHERITED_FULL_FORK_REFS,
							copiedRefs: prefixRows.length,
							hasCompactSummary: Boolean(parent.contextSummary),
						});
					} else {
						prefixRows = rows.reverse();
					}
					resolvedForkMessageId = prefixRows.at(-1)?.messageId ?? null;
				}

				if (inheritMode === "full" && prefixRows.length === 0 && parent.apiConversationId) {
					apiConversationId = null;
					logger.warn(
						"Full narrator fork has no local refs; remote conversation id not inherited",
						{
							parentNarratorId,
							newNarratorId: id,
						},
					);
				}

				tx.update(narrators)
					.set({ forkMessageId: resolvedForkMessageId, apiConversationId })
					.where(eq(narrators.id, id))
					.run();

				if (prefixRows.length > 0) {
					// 单条 INSERT...SELECT 复制 refs（替代应用层批量循环 + 逐行 nanoid）。
					// id 用 hex(randomblob(16)) 生成 (32 字符十六进制), 与 nanoid 同样全局唯一。
					//
					// seq 刻意**沿用父叙述者的原值**，不再重编号为 0 起。惰性 fork 之后要能按 seq
					// 区间从父叙述者补齐更早的历史；一旦重编号，父子 seq 就失去对应关系，补齐
					// 只能插负数或整体位移。保留原值后，补齐就只是插入更多行（见
					// narrator-refs-backfill.ts）。seq 因此从 forkCompactSeq+1 开始而非 0，
					// 中间留有空洞——所有消费者都是游标/排序语义，不依赖 seq 密集。
					//
					// 注意: SQL 必须复现 prefixRows 的完整过滤条件（compact 边界、segment 排除、
					// 进行中 compact 标记排除、上限截断），不能简化为 seq <= lastSeq，否则会错误
					// 复制已 compact 掉的历史 refs。
					//
					// 这里刻意不 join narrator_messages: 进行中的 compact 标记已经在上面通过
					// 部分索引解析成一个通常为空的 id 列表，join 消息表只会把整段历史的
					// contentJson 拖进来（3 万条消息约 149 MB）。
					const lastSeq = prefixRows[prefixRows.length - 1].seq;
					const firstSeq = prefixRows[0].seq;
					const excludePendingRaw = excludePendingCompactRawCondition(pendingCompactIds);
					tx.run(sql`
					INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, is_compact, segment_compact_id)
					SELECT
						lower(hex(randomblob(16))),
						${id},
						refs.message_id,
						refs.seq,
						refs.is_compact,
						refs.segment_compact_id
					FROM narrator_message_refs AS refs
					WHERE refs.narrator_id = ${parentNarratorId}
						AND refs.seq >= ${firstSeq}
						AND refs.seq <= ${lastSeq}
						AND refs.segment_compact_id IS NULL
						${excludePendingRaw}
					ORDER BY refs.seq
				`);

					// Reserve copied seqs in the child's monotone counter in this transaction.
					// Subsequent lazy backfills can only raise, never lower, this floor.
					initializeRefSeqFloor(tx, id);

					// Record the lazy-fork boundary whenever the parent still holds refs below
					// the window we copied — whether they were skipped by the compact boundary
					// or dropped by the MAX_INHERITED_FULL_FORK_REFS cap. Previously the capped
					// history was simply unreachable; now it can be backfilled.
					const parentHasOlder = tx
						.select({ seq: narratorMessageRefs.seq })
						.from(narratorMessageRefs)
						.where(
							and(
								eq(narratorMessageRefs.narratorId, parentNarratorId),
								sql`${narratorMessageRefs.seq} < ${firstSeq}`,
							),
						)
						.limit(1)
						.all();
					if (parentHasOlder.length > 0) {
						tx.update(narrators)
							.set({
								refsInheritedFrom: parentNarratorId,
								refsBackfillCursor: firstSeq,
							})
							.where(eq(narrators.id, id))
							.run();
					}
				}

				if (inheritMode === "compressed" && contextSummary) {
					const compactMsgId = generateId();
					const compactNow = new Date().toISOString();
					tx.insert(narratorMessages)
						.values({
							id: compactMsgId,
							narratorId: id,
							role: "system",
							contentJson: [{ type: "compact", status: "compacted", summary: contextSummary }],
							contentText: `[Compressed context from parent conversation]`,
							createdAt: compactNow,
						})
						.run();
					// Same single seq authority as every other refs writer — the child's
					// copied prefix is already in place, so this claims max(prefix)+1.
					const compactSeq = claimNextRefSeq(tx, id);
					tx.insert(narratorMessageRefs)
						.values({
							id: generateId(),
							narratorId: id,
							messageId: compactMsgId,
							seq: compactSeq,
							isCompact: 1,
						})
						.run();
				}

				// Copy all four per-narrator permission rule sets from the parent, preserving the
				// canonical selector and its legacy mirror so every fork inherits one execution profile.
				const parentWhitelistDirs = tx
					.select()
					.from(narratorWhitelistDirs)
					.where(eq(narratorWhitelistDirs.narratorId, parentNarratorId))
					.all();
				if (parentWhitelistDirs.length > 0) {
					tx.insert(narratorWhitelistDirs)
						.values(
							parentWhitelistDirs.map((dir) => ({
								id: generateId(),
								narratorId: id,
								path: dir.path,
								accessLevel: dir.accessLevel,
								enabled: dir.enabled,
								targetKind: dir.targetKind,
								targetValue: dir.targetValue,
								deviceScope: dir.deviceScope,
								createdAt: now,
							})),
						)
						.run();
				}

				const parentBlacklistDirs = tx
					.select()
					.from(narratorBlacklistDirs)
					.where(eq(narratorBlacklistDirs.narratorId, parentNarratorId))
					.all();
				if (parentBlacklistDirs.length > 0) {
					tx.insert(narratorBlacklistDirs)
						.values(
							parentBlacklistDirs.map((dir) => ({
								id: generateId(),
								narratorId: id,
								path: dir.path,
								denyLevel: dir.denyLevel,
								enabled: dir.enabled,
								targetKind: dir.targetKind,
								targetValue: dir.targetValue,
								deviceScope: dir.deviceScope,
								createdAt: now,
							})),
						)
						.run();
				}

				const parentWhitelistCmds = tx
					.select()
					.from(narratorWhitelistCmds)
					.where(eq(narratorWhitelistCmds.narratorId, parentNarratorId))
					.all();
				if (parentWhitelistCmds.length > 0) {
					tx.insert(narratorWhitelistCmds)
						.values(
							parentWhitelistCmds.map((cmd) => ({
								id: generateId(),
								narratorId: id,
								pattern: cmd.pattern,
								enabled: cmd.enabled,
								targetKind: cmd.targetKind,
								targetValue: cmd.targetValue,
								deviceScope: cmd.deviceScope,
								createdAt: now,
							})),
						)
						.run();
				}

				const parentBlacklistCmds = tx
					.select()
					.from(narratorBlacklistCmds)
					.where(eq(narratorBlacklistCmds.narratorId, parentNarratorId))
					.all();
				if (parentBlacklistCmds.length > 0) {
					tx.insert(narratorBlacklistCmds)
						.values(
							parentBlacklistCmds.map((cmd) => ({
								id: generateId(),
								narratorId: id,
								pattern: cmd.pattern,
								denyPrompt: cmd.denyPrompt,
								enabled: cmd.enabled,
								targetKind: cmd.targetKind,
								targetValue: cmd.targetValue,
								deviceScope: cmd.deviceScope,
								createdAt: now,
							})),
						)
						.run();
				}

				const finalNarrator = tx.query.narrators.findFirst({ where: eq(narrators.id, id) }).sync();
				if (!finalNarrator) throw new NotFoundError("Narrator", id);
				return finalNarrator;
			}),
		);

		// fire-and-forget: spec fork 和 carryover 不阻塞 fork 响应
		// fork 的成功不依赖这些副作用, 失败时记录到 narrators 表便于后续补偿
		void (async () => {
			const maxRetries = 3;
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				try {
					await specVfsService.forkSpecNamespace(parentNarratorId, id);
					break;
				} catch (err) {
					const isLast = attempt === maxRetries;
					if (isLast) {
						logger.error("forkSpecNamespace failed after retries", {
							parentNarratorId,
							newNarratorId: id,
							attempt,
							error: String(err),
						});
					} else {
						logger.warn("forkSpecNamespace attempt failed, retrying", {
							parentNarratorId,
							newNarratorId: id,
							attempt,
							error: String(err),
						});
						await new Promise((r) => setTimeout(r, 500 * attempt));
					}
				}
			}
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				try {
					await applySpecForkCarryover(id, opts?.specCarryover ?? "card");
					break;
				} catch (err) {
					const isLast = attempt === maxRetries;
					if (isLast) {
						logger.error("applySpecForkCarryover failed after retries", {
							parentNarratorId,
							newNarratorId: id,
							attempt,
							error: String(err),
						});
					} else {
						logger.warn("applySpecForkCarryover attempt failed, retrying", {
							parentNarratorId,
							newNarratorId: id,
							attempt,
							error: String(err),
						});
						await new Promise((r) => setTimeout(r, 500 * attempt));
					}
				}
			}
		})();
		eventBus.emit({ type: "narrator:forked", narratorId: id, parentNarratorId });
		broadcastToNarrator(parentNarratorId, {
			type: "narrator_forked",
			narratorId: id,
			parentNarratorId,
		});
		logger.info("Narrator forked", { parentNarratorId, newNarratorId: id, forkMessageUuid });
		return newNarrator;
	},

	async getLatestMessageUuid(narratorId: string): Promise<string | null> {
		const latestRef = await db
			.select({ messageId: narratorMessageRefs.messageId })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, narratorId))
			.orderBy(sql`${narratorMessageRefs.seq} DESC`)
			.limit(1);

		if (!latestRef.length) return null;

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, latestRef[0].messageId),
			columns: { messageUuid: true },
		});
		return msg?.messageUuid ?? null;
	},

	/**
	 * Extract a subagent into an independent primary narrator.
	 * Ordinary fork still refuses subagent sources; this is the dedicated control-plane
	 * promotion path (AskUserQuestion etc. become available on the new session).
	 */
	async extractSubagentToPrimary(
		sourceNarratorId: string,
		opts?: {
			title?: string;
			inheritMode?: "full" | "compressed";
			locale?: Locale;
		},
	) {
		const { extractSubagentToPrimary } = await import("./subagent-extract");
		return extractSubagentToPrimary(sourceNarratorId, opts);
	},

	async forkStandaloneFromTool(
		parentNarratorId: string,
		mode: "fresh" | "fork",
		opts?: {
			title?: string;
			inheritMode?: "full" | "compressed";
			model?: string;
			locale?: string;
		},
	) {
		const parent = await this.getById(parentNarratorId);

		if (isSubagentVariant(parent.variant)) {
			throw new ValidationError("Cannot fork from a subagent narrator");
		}
		if (parent.chapterId) {
			throw new ValidationError(
				"Chapter-bound narrators must fork via chapter fork (use chapterFork.fork)",
			);
		}

		if (mode === "fresh") {
			const newNarrator = await this.create({
				chapterId: null,
				model: opts?.model ?? parent.model ?? undefined,
				systemPrompt: parent.systemPrompt ?? undefined,
				permissionMode: parent.permissionMode ?? undefined,
				cwd: parent.cwd ?? undefined,
				reasoningEffort: parent.reasoningEffort as
					| "none"
					| "low"
					| "medium"
					| "high"
					| "xhigh"
					| null
					| undefined,
				fastModeOverride: normalizeBooleanOverride(parent.fastModeOverride),
				relaxedPlan: parent.relaxedPlan ?? undefined,
				planReflectionAutoApproveOverride: normalizeBooleanOverride(
					parent.planReflectionAutoApproveOverride,
				),
				dangerReflectionOverride: normalizeDangerReflectionOverride(
					parent.dangerReflectionOverride,
				),
				autoContinuationOverride: normalizeAutoContinuationOverride(
					parent.autoContinuationOverride,
				),
				behaviorFenceIntervalOverride: parent.behaviorFenceIntervalOverride ?? null,
				behaviorFenceAttachOverride: normalizeBooleanOverride(parent.behaviorFenceAttachOverride),
				title: opts?.title ?? undefined,
				// A tool-initiated fork belongs to whoever owns the session that spawned
				// it — the model has no identity of its own to attribute it to. Both
				// audiences come along so the fork is never reachable more widely than
				// the session it came from.
				ownerUserId: parent.ownerUserId,
				visibility: parent.visibility,
				writeAudience: parent.writeAudience,
			});
			eventBus.emit({
				type: "narrator:forked",
				narratorId: newNarrator.id,
				parentNarratorId,
			});
			broadcastToNarrator(parentNarratorId, {
				type: "narrator_forked",
				narratorId: newNarrator.id,
				parentNarratorId,
			});
			return newNarrator;
		}

		const latestMsgUuid = await this.getLatestMessageUuid(parentNarratorId);

		return this.forkNarrator(parentNarratorId, latestMsgUuid, {
			title: opts?.title,
			inheritMode: opts?.inheritMode ?? "full",
			locale: opts?.locale,
		});
	},

	// ── Delegated methods (from narratorMessages) ─────────────────────────────

	getMessages: narratorMessageQueries.getMessages.bind(narratorMessageQueries),
	getMessagesSinceLastCompact:
		narratorMessageQueries.getMessagesSinceLastCompact.bind(narratorMessageQueries),
	getContextAskHistorySnapshot:
		narratorMessageQueries.getContextAskHistorySnapshot.bind(narratorMessageQueries),
	getModelHistorySinceLastCompact:
		narratorMessageQueries.getModelHistorySinceLastCompact.bind(narratorMessageQueries),
	getLatestCompactSeq: narratorMessageQueries.getLatestCompactSeq.bind(narratorMessageQueries),
	getMessagesBefore: narratorMessageQueries.getMessagesBefore.bind(narratorMessageQueries),
	getEarliestMessages: narratorMessageQueries.getEarliestMessages.bind(narratorMessageQueries),
	_getPostCompactTopLevelRefs:
		narratorMessageQueries._getPostCompactTopLevelRefs.bind(narratorMessageQueries),
	getCompactBoundaryMessage:
		narratorMessageQueries.getCompactBoundaryMessage.bind(narratorMessageQueries),
	getEmergencyCompactBoundaryMessage:
		narratorMessageQueries.getEmergencyCompactBoundaryMessage.bind(narratorMessageQueries),
	getRecentMessages: narratorMessageQueries.getRecentMessages.bind(narratorMessageQueries),
	getLatestAssistantTextAndId:
		narratorMessageQueries.getLatestAssistantTextAndId.bind(narratorMessageQueries),
	getLatestSuccessfulCompactSummary:
		narratorMessageQueries.getLatestSuccessfulCompactSummary.bind(narratorMessageQueries),
	isSubagentNarrator: narratorMessageQueries.isSubagentNarrator.bind(narratorMessageQueries),
	getPretextDocumentPage:
		narratorMessageQueries.getPretextDocumentPage.bind(narratorMessageQueries),
	getMessageVersion: narratorMessageQueries.getMessageVersion.bind(narratorMessageQueries),
	getMessageLocation: narratorMessageQueries.getMessageLocation.bind(narratorMessageQueries),
	getMessagesAfter: narratorMessageQueries.getMessagesAfter.bind(narratorMessageQueries),
	getToolCallDetail: narratorMessageQueries.getToolCallDetail.bind(narratorMessageQueries),
	getToolCallPreviewMetadata:
		narratorMessageQueries.getToolCallPreviewMetadata.bind(narratorMessageQueries),
	getCompactSummary: narratorMessageQueries.getCompactSummary.bind(narratorMessageQueries),
	deleteCompactMessage: narratorMessageQueries.deleteCompactMessage.bind(narratorMessageQueries),
	deleteMessage: narratorMessageQueries.deleteMessage.bind(narratorMessageQueries),
	deleteEmptyRetryPlaceholder:
		narratorMessageQueries.deleteEmptyRetryPlaceholder.bind(narratorMessageQueries),
	deleteDanglingReasoningMessage:
		narratorMessageQueries.deleteDanglingReasoningMessage.bind(narratorMessageQueries),
	dismissSpecCarryoverMessage:
		narratorMessageQueries.dismissSpecCarryoverMessage.bind(narratorMessageQueries),
	markReviewFeedbackApplied:
		narratorMessageQueries.markReviewFeedbackApplied.bind(narratorMessageQueries),
	releaseReviewFeedbackClaim:
		narratorMessageQueries.releaseReviewFeedbackClaim.bind(narratorMessageQueries),
	dismissCwdRecoveryMessage:
		narratorMessageQueries.dismissCwdRecoveryMessage.bind(narratorMessageQueries),
	dismissErrorMessage: narratorMessageQueries.dismissErrorMessage.bind(narratorMessageQueries),
	dismissInterruptTaskGuardMessage:
		narratorMessageQueries.dismissInterruptTaskGuardMessage.bind(narratorMessageQueries),
	deleteMessagesAfter: narratorMessageQueries.deleteMessagesAfter.bind(narratorMessageQueries),
	deleteMessageBlock: narratorMessageQueries.deleteMessageBlock.bind(narratorMessageQueries),
	deleteMessageBlocks: narratorMessageQueries.deleteMessageBlocks.bind(narratorMessageQueries),
	removeCompactingMessage:
		narratorMessageQueries.removeCompactingMessage.bind(narratorMessageQueries),
	updateCompactSummary: narratorMessageQueries.updateCompactSummary.bind(narratorMessageQueries),
	getPendingPermissions: narratorMessageQueries.getPendingPermissions.bind(narratorMessageQueries),

	// ── Delegated methods (from narratorPersistence) ───────────────────────────

	persistUserMessage: narratorPersistence.persistUserMessage.bind(narratorPersistence),
	persistSystemMessage: narratorPersistence.persistSystemMessage.bind(narratorPersistence),
	persistDisplayMessage: narratorPersistence.persistDisplayMessage.bind(narratorPersistence),
	persistCompactingMessage: narratorPersistence.persistCompactingMessage.bind(narratorPersistence),
	prepareFailedCompactRetry:
		narratorPersistence.prepareFailedCompactRetry.bind(narratorPersistence),
	persistPlanMessage: narratorPersistence.persistPlanMessage.bind(narratorPersistence),
	clearContext: narratorPersistence.clearContext.bind(narratorPersistence),
	clearContextBefore: narratorPersistence.clearContextBefore.bind(narratorPersistence),
	insertSpecClearedCarryoverCard,
	finalizeCompactingMessage:
		narratorPersistence.finalizeCompactingMessage.bind(narratorPersistence),
	persistAssistantMessage: narratorPersistence.persistAssistantMessage.bind(narratorPersistence),
	createPartialAssistantMessage:
		narratorPersistence.createPartialAssistantMessage.bind(narratorPersistence),
	appendBlockToMessage: narratorPersistence.appendBlockToMessage.bind(narratorPersistence),
	patchReasoningTranslation:
		narratorPersistence.patchReasoningTranslation.bind(narratorPersistence),
	updateConversationId: narratorPersistence.updateConversationId.bind(narratorPersistence),
	updateStats: narratorPersistence.updateStats.bind(narratorPersistence),
	updateMessageCost: narratorPersistence.updateMessageCost.bind(narratorPersistence),
	updateMessageHistoryTokenEstimate:
		narratorPersistence.updateMessageHistoryTokenEstimate.bind(narratorPersistence),
	updateTitle: narratorPersistence.updateTitle.bind(narratorPersistence),
	updateCwd: narratorPersistence.updateCwd.bind(narratorPersistence),
	updateModel: narratorPersistence.updateModel.bind(narratorPersistence),
	updatePermissionMode: narratorPersistence.updatePermissionMode.bind(narratorPersistence),
	updateReasoningEffort: narratorPersistence.updateReasoningEffort.bind(narratorPersistence),
	updateFastModeOverride: narratorPersistence.updateFastModeOverride.bind(narratorPersistence),
	updateRelaxedPlan: narratorPersistence.updateRelaxedPlan.bind(narratorPersistence),
	updateReflectionOverrides:
		narratorPersistence.updateReflectionOverrides.bind(narratorPersistence),
	updateBehaviorFenceSettings:
		narratorPersistence.updateBehaviorFenceSettings.bind(narratorPersistence),
	updateStatus: narratorPersistence.updateStatus.bind(narratorPersistence),
	compareAndSetStatus: narratorPersistence.compareAndSetStatus.bind(narratorPersistence),
	updateSubstatus: narratorPersistence.updateSubstatus.bind(narratorPersistence),
	addSubstatus: narratorPersistence.addSubstatus.bind(narratorPersistence),
	removeSubstatus: narratorPersistence.removeSubstatus.bind(narratorPersistence),
	updateToolCallExecutionTarget:
		narratorPersistence.updateToolCallExecutionTarget.bind(narratorPersistence),
	updateToolCallExecutionPlan:
		narratorPersistence.updateToolCallExecutionPlan.bind(narratorPersistence),
	updateToolCallResult: narratorPersistence.updateToolCallResult.bind(narratorPersistence),
	isMessageSharedByMultipleNarrators:
		narratorPersistence.isMessageSharedByMultipleNarrators.bind(narratorPersistence),
	getToolCallByToolUseId: narratorPersistence.getToolCallByToolUseId.bind(narratorPersistence),
	copyOnWriteMessage: narratorPersistence.copyOnWriteMessage.bind(narratorPersistence),
	copyOnWriteToolCallMessage:
		narratorPersistence.copyOnWriteToolCallMessage.bind(narratorPersistence),
	overwriteToolCallInput: narratorPersistence.overwriteToolCallInput.bind(narratorPersistence),
	getToolCallPlanText: narratorPersistence.getToolCallPlanText.bind(narratorPersistence),
	persistSegmentCompactMarker:
		narratorPersistence.persistSegmentCompactMarker.bind(narratorPersistence),
	getMessagesForSegmentCompact:
		narratorPersistence.getMessagesForSegmentCompact.bind(narratorPersistence),
	finalizeSegmentCompact: narratorPersistence.finalizeSegmentCompact.bind(narratorPersistence),
	getSegmentCompactHiddenMessages:
		narratorPersistence.getSegmentCompactHiddenMessages.bind(narratorPersistence),
	deleteSegmentCompact: narratorPersistence.deleteSegmentCompact.bind(narratorPersistence),
	getSegmentCompactSummary: narratorPersistence.getSegmentCompactSummary.bind(narratorPersistence),
	updateSegmentCompactSummary:
		narratorPersistence.updateSegmentCompactSummary.bind(narratorPersistence),
};
