import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { foldHandle } from "@shared/narrator-handle";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
	terminalTabs,
	terminalViewState,
	users,
} from "../db/schema";
import {
	KNOWLEDGE_KIND_PRELOAD_TOOLS,
	KNOWLEDGE_KIND_PRELOAD_TOOLS_ADMIN,
} from "../lib/agent/tools/knowledge-kind";
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
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
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
	getToolMessageWithParams,
	type Locale,
} from "../lib/prompt-i18n";
import { FOLLOW_DEFAULT_MODEL, resolveEffectiveModel, settings } from "../lib/settings";
import {
	contentJsonHasImageBlocks,
	deleteNarratorUploads,
	type ImageRef,
	type TextFileRef,
} from "../lib/uploads";
import { generateWordSlug } from "../lib/words";
import { broadcastToNarrator } from "../websocket/narrator-ws";
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
import { narratorMessageQueries } from "./narrator-messages";
import {
	appendMessageRef,
	bumpParentNarratorMessageVersion,
	narratorPersistence,
} from "./narrator-persistence";
import { specVfsService } from "./spec-vfs-service";
import { removeTabFromAllUsers } from "./user-preferences-service";

export {
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
 * A history compact marker is transient while its block is `compacting` (or
 * legacy `running`) or while its latest persisted attempt is still running.  A fork
 * must not share that row: the parent finalizer may COW it, leaving the child
 * with an impossible-to-finish marker forever.  Keep this predicate narrowly
 * scoped to `type=compact`; segment compact rows deliberately remain visible.
 */
function stableForkMessageCondition() {
	return sql`NOT EXISTS (
		SELECT 1
		FROM json_each(${narratorMessages.contentJson}) AS compact_block
		WHERE json_extract(compact_block.value, '$.type') = 'compact'
			AND (
				json_extract(compact_block.value, '$.status') IN ('compacting', 'running')
				OR json_extract(compact_block.value, '$.attempts[#-1].status') = 'running'
			)
	)`;
}

/** Raw-SQL equivalent used by INSERT...SELECT, where the message alias is fixed. */
function stableForkMessageRawCondition() {
	return sql.raw(`AND NOT EXISTS (
		SELECT 1
		FROM json_each(messages.content_json) AS compact_block
		WHERE json_extract(compact_block.value, '$.type') = 'compact'
			AND (
				json_extract(compact_block.value, '$.status') IN ('compacting', 'running')
				OR json_extract(compact_block.value, '$.attempts[#-1].status') = 'running'
			)
	)`);
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
	fastMode?: boolean;
	relaxedPlan?: boolean;
	pruneEnabled?: boolean;
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
	/** Specialized standalone narrator kind. "knowledge" → a Knowledge Steward (knowledge-base management). */
	kind?: "knowledge";
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
}

interface CreateSubagentInput {
	parentNarratorId: string;
	subagentType: string;
	cwd: string;
	title?: string;
	permissionMode?: string;
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
const ADMIN_ONLY_LOAD_TOOLS = new Set(["NarraForkAdmin", "KnowledgeAdmin"]);

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
	const disabledTools = getDisabledToolSet(currentNarrator.traits);
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
	const narratorForBlock = await narratorService.getById(narratorId);
	const blocked = getBlockedSkills(narratorForBlock.traits);
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
	updateActiveBlockedSkills(narratorId, { all: next.all, names: next.names });
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
	await narratorService.updateToolCallResult(toolUseId, {
		output: persistedOutput,
		status,
		errorMessage: result.isError ? result.output : undefined,
		durationMs,
		executionStartedAt: streamStartedAt,
		completedAt,
	});

	broadcastToNarrator(narratorId, {
		type: "tool_completed",
		narratorId,
		toolCallId,
		toolUseId,
		toolName: "Bash",
		status,
		output:
			result.output.length > 2000
				? {
						_truncated: true,
						preview: result.output.slice(0, 2000),
						fullLength: result.output.length,
					}
				: result.output,
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
		enabledToolsSet.add("GroupControl");
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
			fastMode: input.fastMode ?? false,
			relaxedPlan: resolveInitialRelaxedPlan({
				permissionMode: resolvedPermMode,
				explicit: input.relaxedPlan,
				defaultRelaxedPlan: settings.agent.defaultRelaxedPlan,
			}),
			pruneEnabled: input.pruneEnabled ?? settings.agent.defaultPruneEnabled,
			planReflectionAutoApproveOverride: input.planReflectionAutoApproveOverride ?? "inherit",
			dangerReflectionOverride: input.dangerReflectionOverride ?? "inherit",
			autoContinuationOverride: input.autoContinuationOverride ?? "inherit",
			behaviorFenceIntervalOverride: input.behaviorFenceIntervalOverride ?? null,
			behaviorFenceAttachOverride: input.behaviorFenceAttachOverride ?? "inherit",
			cwd: input.cwd ?? null,
			contextProjectId: input.contextProjectId ?? null,
			oauthPolicySnapshotJson: input.oauthPolicySnapshotJson ?? null,
			defaultDeviceId: input.defaultDeviceId ?? null,
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
		const parent = await this.getById(input.parentNarratorId);

		if (isSubagentVariant(parent.variant)) {
			throw new ValidationError("Subagents cannot spawn nested subagents");
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
				fastMode: parent.fastMode ?? false,
				relaxedPlan: resolvedRelaxedPlan,
				pruneEnabled: parent.pruneEnabled ?? settings.agent.defaultPruneEnabled,
				planReflectionAutoApproveOverride: parent.planReflectionAutoApproveOverride ?? "inherit",
				dangerReflectionOverride: parent.dangerReflectionOverride ?? "inherit",
				autoContinuationOverride: parent.autoContinuationOverride ?? "inherit",
				behaviorFenceIntervalOverride: parent.behaviorFenceIntervalOverride ?? null,
				behaviorFenceAttachOverride: parent.behaviorFenceAttachOverride ?? "inherit",
				parentNarratorId: input.parentNarratorId,
				cwd: input.cwd,
				defaultDeviceId: input.defaultDeviceId ?? parent.defaultDeviceId ?? null,
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
	 */
	async listSubagentsByParent(parentNarratorId: string) {
		return db.query.narrators.findMany({
			where: eq(narrators.parentNarratorId, parentNarratorId),
			orderBy: (n, { asc }) => [asc(n.createdAt)],
		});
	},

	async persistSubagentUserMessage(
		narratorId: string,
		text: string,
		parentToolUseId: string,
		options?: {
			images?: ImageRef[];
			textFiles?: TextFileRef[];
			commandText?: string | null;
			createdBy?: string | null;
		},
	) {
		const id = generateId();
		const now = new Date().toISOString();
		const contentJson: Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					imageId: string;
					filename: string;
					mediaType: string;
					uploadNarratorId?: string;
			  }
			| { type: "text_file"; filename: string; size: number; filePath: string }
		> = [];
		for (const image of options?.images ?? []) {
			contentJson.push({
				type: "image",
				imageId: image.imageId,
				filename: image.filename,
				mediaType: image.mediaType,
				...(image.uploadNarratorId ? { uploadNarratorId: image.uploadNarratorId } : {}),
			});
		}
		for (const file of options?.textFiles ?? []) {
			contentJson.push({
				type: "text_file",
				filename: file.filename,
				size: file.size,
				filePath: file.filePath,
			});
		}
		contentJson.push({ type: "text", text });
		const effectiveText =
			(!text.trim() && (options?.images?.length ?? 0) > 0 ? "[user sent image(s)]" : text) +
			buildAttachedFilesHint(options?.textFiles ?? []);
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				parentToolUseId,
				role: "user",
				contentJson,
				contentText: effectiveText,
				commandText: options?.commandText ?? null,
				createdBy: options?.createdBy ?? null,
				createdAt: now,
			})
			.returning();

		const seq = await appendMessageRef(narratorId, id);
		await bumpParentNarratorMessageVersion(parentToolUseId);
		const creator = options?.createdBy
			? ((await db.query.users.findFirst({
					where: eq(users.id, options.createdBy),
					columns: { id: true, username: true, avatarColor: true, avatarImageId: true },
				})) ?? null)
			: null;
		return { ...msg, seq, creator };
	},

	async getById(id: string) {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, id),
		});
		if (!narrator) throw new NotFoundError("Narrator", id);
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
			let nextEnabledTools = narrator.enabledTools;
			if (displayHandle) {
				nextTraits.push("named");
				const currentTools = Array.isArray(narrator.enabledTools)
					? narrator.enabledTools.filter((tool): tool is string => typeof tool === "string")
					: [];
				if (!currentTools.includes("GroupControl")) {
					nextEnabledTools = [...currentTools, "GroupControl"];
				}
			}
			const [updated] = await db
				.update(narrators)
				.set({
					handle: displayHandle,
					handleFold: foldedHandle,
					traits: nextTraits,
					enabledTools: nextEnabledTools,
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

		const preserveUploads = await hasSharedOwnedImageMessages(narratorId);

		const bindingTransition = db.transaction((tx) => {
			const transition = integrationResourceBindingService.markDeletedInTransaction(
				tx,
				"narrator",
				narratorId,
			);
			tx.delete(terminalViewState).where(eq(terminalViewState.narratorId, narratorId)).run();
			tx.delete(terminalTabs).where(eq(terminalTabs.narratorId, narratorId)).run();
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
			tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, narratorId)).run();

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
				tx.update(narrators)
					.set({ pruneBoundaryMessageId: null })
					.where(inArray(narrators.pruneBoundaryMessageId, orphanIds))
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

		const newNarrator = db.transaction((tx) => {
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
					fastMode: parent.fastMode ?? false,
					relaxedPlan: resolveInitialRelaxedPlan({
						permissionMode: resolvedPermMode,
						explicit: parent.relaxedPlan ?? undefined,
						defaultRelaxedPlan: false,
					}),
					pruneEnabled: parent.pruneEnabled ?? settings.agent.defaultPruneEnabled,
					planReflectionAutoApproveOverride: parent.planReflectionAutoApproveOverride ?? "inherit",
					dangerReflectionOverride: parent.dangerReflectionOverride ?? "inherit",
					autoContinuationOverride: parent.autoContinuationOverride ?? "inherit",
					behaviorFenceIntervalOverride: parent.behaviorFenceIntervalOverride ?? null,
					behaviorFenceAttachOverride: parent.behaviorFenceAttachOverride ?? "inherit",
					parentNarratorId,
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
			const stableParentRefs = tx
				.select({
					messageId: narratorMessageRefs.messageId,
					seq: narratorMessageRefs.seq,
					isCompact: narratorMessageRefs.isCompact,
				})
				.from(narratorMessageRefs)
				.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
				.where(
					and(
						eq(narratorMessageRefs.narratorId, parentNarratorId),
						inArray(narratorMessageRefs.messageId, messageIds),
						stableForkMessageCondition(),
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

			return created;
		});

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
			prunedPercent: number | null;
			segmentCompactId: string | null;
		}> = [];
		let resolvedForkMessageId: string | null = null;
		let forkCompactSeq: number | undefined;
		let requestedForkMessageId: string | null = null;

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

		const newNarrator = db.transaction((tx) => {
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
					fastMode: parent.fastMode ?? false,
					relaxedPlan: resolveInitialRelaxedPlan({
						permissionMode: resolvedPermMode,
						explicit: parent.relaxedPlan ?? undefined,
						defaultRelaxedPlan: settings.agent.defaultRelaxedPlan,
					}),
					pruneEnabled: parent.pruneEnabled ?? settings.agent.defaultPruneEnabled,
					planReflectionAutoApproveOverride: parent.planReflectionAutoApproveOverride ?? "inherit",
					dangerReflectionOverride: parent.dangerReflectionOverride ?? "inherit",
					autoContinuationOverride: parent.autoContinuationOverride ?? "inherit",
					behaviorFenceIntervalOverride: parent.behaviorFenceIntervalOverride ?? null,
					behaviorFenceAttachOverride: parent.behaviorFenceAttachOverride ?? "inherit",
					parentNarratorId,
					forkMessageId: null,
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
				prefixRows = tx
					.select({
						messageId: narratorMessageRefs.messageId,
						seq: narratorMessageRefs.seq,
						isCompact: narratorMessageRefs.isCompact,
						prunedPercent: narratorMessageRefs.prunedPercent,
						segmentCompactId: narratorMessageRefs.segmentCompactId,
					})
					.from(narratorMessageRefs)
					.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
					.where(
						and(
							eq(narratorMessageRefs.narratorId, parentNarratorId),
							sql`${narratorMessageRefs.seq} <= ${forkRef.seq}`,
							stableForkMessageCondition(),
						),
					)
					.orderBy(narratorMessageRefs.seq)
					.all();
				resolvedForkMessageId = prefixRows.at(-1)?.messageId ?? null;
			} else if (inheritMode === "full") {
				const lastCompact = tx
					.select({ seq: narratorMessageRefs.seq })
					.from(narratorMessageRefs)
					.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
					.where(
						and(
							eq(narratorMessageRefs.narratorId, parentNarratorId),
							eq(narratorMessageRefs.isCompact, 1),
							stableForkMessageCondition(),
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
						prunedPercent: narratorMessageRefs.prunedPercent,
						segmentCompactId: narratorMessageRefs.segmentCompactId,
					})
					.from(narratorMessageRefs)
					.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
					.where(
						and(
							eq(narratorMessageRefs.narratorId, parentNarratorId),
							forkCompactSeq != null
								? sql`${narratorMessageRefs.seq} > ${forkCompactSeq}`
								: undefined,
							sql`${narratorMessageRefs.segmentCompactId} IS NULL`,
							stableForkMessageCondition(),
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
				logger.warn("Full narrator fork has no local refs; remote conversation id not inherited", {
					parentNarratorId,
					newNarratorId: id,
				});
			}

			tx.update(narrators)
				.set({ forkMessageId: resolvedForkMessageId, apiConversationId })
				.where(eq(narrators.id, id))
				.run();

			if (prefixRows.length > 0) {
				// 优化: 用单条 INSERT...SELECT 替代应用层 32 批循环 + 15608 次 nanoid。
				// id 用 hex(randomblob(16)) 生成 (32 字符十六进制), 与 nanoid 同样全局唯一。
				// seq 从 0 重编号, 与下方 JS 路径行为一致。
				// 预期收益: refs 复制从 ~700ms 降到 ~50ms (见 fork-perf 调研)。
				// 注意: SQL 必须复现 prefixRows 的完整过滤条件（compact 边界、segment 排除、上限截断），
				// 不能简化为 seq <= lastSeq，否则会错误复制已 compact/prune 掉的历史 refs。
				const lastSeq = prefixRows[prefixRows.length - 1].seq;
				const firstSeq = prefixRows[0].seq;
				if (inheritMode === "full") {
					tx.run(sql`
						INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, is_compact, pruned_percent, segment_compact_id)
						SELECT
							lower(hex(randomblob(16))),
							${id},
							refs.message_id,
							(row_number() OVER (ORDER BY refs.seq)) - 1,
							refs.is_compact,
							refs.pruned_percent,
							refs.segment_compact_id
						FROM narrator_message_refs AS refs
						INNER JOIN narrator_messages AS messages ON messages.id = refs.message_id
						WHERE refs.narrator_id = ${parentNarratorId}
							AND refs.seq > ${forkCompactSeq ?? -1}
							AND refs.segment_compact_id IS NULL
							AND refs.seq >= ${firstSeq}
							AND refs.seq <= ${lastSeq}
							${stableForkMessageRawCondition()}
						ORDER BY refs.seq
					`);
				} else {
					tx.run(sql`
						INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, is_compact, pruned_percent, segment_compact_id)
						SELECT
							lower(hex(randomblob(16))),
							${id},
							refs.message_id,
							(row_number() OVER (ORDER BY refs.seq)) - 1,
							refs.is_compact,
							refs.pruned_percent,
							refs.segment_compact_id
						FROM narrator_message_refs AS refs
						INNER JOIN narrator_messages AS messages ON messages.id = refs.message_id
						WHERE refs.narrator_id = ${parentNarratorId}
							AND refs.seq <= ${lastSeq}
							${stableForkMessageRawCondition()}
						ORDER BY refs.seq
					`);
				}

				if (parent.pruneBoundaryMessageId) {
					const boundaryInPrefix = prefixRows.find(
						(r) => r.messageId === parent.pruneBoundaryMessageId,
					);
					if (boundaryInPrefix) {
						const boundaryIdx = prefixRows.indexOf(boundaryInPrefix);
						const inheritedPrunedPercent = Math.round(
							((boundaryIdx + 1) / prefixRows.length) * 100,
						);
						tx.update(narrators)
							.set({
								pruneBoundaryMessageId: parent.pruneBoundaryMessageId,
								prunedPercent: inheritedPrunedPercent,
							})
							.where(eq(narrators.id, id))
							.run();
					}
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
				const maxSeqResult = tx
					.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
					.from(narratorMessageRefs)
					.where(eq(narratorMessageRefs.narratorId, id))
					.all();
				const compactSeq = (maxSeqResult[0]?.maxSeq ?? -1) + 1;
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
							createdAt: now,
						})),
					)
					.run();
			}

			const finalNarrator = tx.query.narrators.findFirst({ where: eq(narrators.id, id) }).sync();
			if (!finalNarrator) throw new NotFoundError("Narrator", id);
			return finalNarrator;
		});

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
				fastMode: parent.fastMode ?? undefined,
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
	getChunkManifest: narratorMessageQueries.getChunkManifest.bind(narratorMessageQueries),
	getChunksByRange: narratorMessageQueries.getChunksByRange.bind(narratorMessageQueries),
	getPretextDocumentPage:
		narratorMessageQueries.getPretextDocumentPage.bind(narratorMessageQueries),
	getMessageVersion: narratorMessageQueries.getMessageVersion.bind(narratorMessageQueries),
	getMessageLocation: narratorMessageQueries.getMessageLocation.bind(narratorMessageQueries),
	getMessagesAfter: narratorMessageQueries.getMessagesAfter.bind(narratorMessageQueries),
	getToolCallDetail: narratorMessageQueries.getToolCallDetail.bind(narratorMessageQueries),
	getCompactSummary: narratorMessageQueries.getCompactSummary.bind(narratorMessageQueries),
	deleteCompactMessage: narratorMessageQueries.deleteCompactMessage.bind(narratorMessageQueries),
	deleteMessage: narratorMessageQueries.deleteMessage.bind(narratorMessageQueries),
	dismissSpecCarryoverMessage:
		narratorMessageQueries.dismissSpecCarryoverMessage.bind(narratorMessageQueries),
	dismissCwdRecoveryMessage:
		narratorMessageQueries.dismissCwdRecoveryMessage.bind(narratorMessageQueries),
	dismissErrorMessage: narratorMessageQueries.dismissErrorMessage.bind(narratorMessageQueries),
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
	updateFastMode: narratorPersistence.updateFastMode.bind(narratorPersistence),
	updateRelaxedPlan: narratorPersistence.updateRelaxedPlan.bind(narratorPersistence),
	updateReflectionOverrides:
		narratorPersistence.updateReflectionOverrides.bind(narratorPersistence),
	updateBehaviorFenceSettings:
		narratorPersistence.updateBehaviorFenceSettings.bind(narratorPersistence),
	updatePruneEnabled: narratorPersistence.updatePruneEnabled.bind(narratorPersistence),
	updateStatus: narratorPersistence.updateStatus.bind(narratorPersistence),
	compareAndSetStatus: narratorPersistence.compareAndSetStatus.bind(narratorPersistence),
	updateSubstatus: narratorPersistence.updateSubstatus.bind(narratorPersistence),
	addSubstatus: narratorPersistence.addSubstatus.bind(narratorPersistence),
	removeSubstatus: narratorPersistence.removeSubstatus.bind(narratorPersistence),
	updateToolCallExecutionTarget:
		narratorPersistence.updateToolCallExecutionTarget.bind(narratorPersistence),
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
	computeAndUpdatePruneBoundary:
		narratorPersistence.computeAndUpdatePruneBoundary.bind(narratorPersistence),
	clearPruneBoundary: narratorPersistence.clearPruneBoundary.bind(narratorPersistence),
};
