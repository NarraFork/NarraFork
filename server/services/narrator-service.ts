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
	narratorGoals,
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
import { narratorHandleLock } from "../lib/async-mutex";
import {
	type BooleanOverride,
	type DangerReflectionOverride,
	normalizeBooleanOverride,
	normalizeDangerReflectionOverride,
} from "../lib/boolean-override";
import { getBuiltinToolRoutines } from "../lib/builtin-routines";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getDisabledToolSet } from "../lib/narrator-custom-traits";
import { isSubagentVariant, parseTraits, subagentVariant } from "../lib/narrator-utils";
import { normalizeLegacyPermissionMode } from "../lib/permission-modes";
import { getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";
import {
	FOLLOW_DEFAULT_MODEL,
	resolveDefaultReasoningEffort,
	resolveEffectiveModel,
	resolveProvider,
	settings,
} from "../lib/settings";
import { contentJsonHasImageBlocks, deleteNarratorUploads, type ImageRef } from "../lib/uploads";
import { generateWordSlug } from "../lib/words";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import type {
	LoadSkillResult,
	LoadToolNotFound,
	LoadToolResult,
	UnloadToolNotFound,
	UnloadToolResult,
} from "./command-service";
import { getAvailableOptionalToolIds } from "./command-service";
import { narratorMessageQueries } from "./narrator-messages";
import {
	appendMessageRef,
	bumpParentNarratorMessageVersion,
	narratorPersistence,
} from "./narrator-persistence";

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

/** Batch-insert narratorMessageRefs rows, chunking to stay within SQLite's variable limit. */
async function insertRefsBatched(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	values: (typeof narratorMessageRefs.$inferInsert)[],
) {
	for (let i = 0; i < values.length; i += REFS_INSERT_BATCH) {
		await tx.insert(narratorMessageRefs).values(values.slice(i, i + REFS_INSERT_BATCH));
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

interface CreateNarratorInput {
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
	startInPlanMode?: boolean;
	title?: string;
	/** When true, create a "named narrator": standalone, long-lived, @handle-mentionable. Requires `handle`. */
	makeNamed?: boolean;
	/** Globally-unique mention handle. Only used when makeNamed is true. */
	handle?: string;
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
}

function formatAvailableOptionalToolIds(): string {
	return getAvailableOptionalToolIds().join(", ");
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
	const toolName = cmdResult.loadTool;
	const currentNarrator = await narratorService.getById(narratorId);
	if (getDisabledToolSet(currentNarrator.traits).has(toolName)) {
		const infoText =
			locale === "zh-CN"
				? `⛔ 工具已被此叙述者的自定义 trait 禁用：${toolName}`
				: `⛔ Tool disabled by this narrator's custom trait: ${toolName}`;
		await narratorService.persistDisplayMessage(narratorId, infoText);
		return { toolName, loaded: false, alreadyLoaded: false };
	}

	// Admin-only tool check
	if (toolName === "NarraForkAdmin") {
		const adminOnlyMsg =
			locale === "zh-CN"
				? "⛔ 只有管理员才能加载此工具"
				: "⛔ Only administrators can load this tool";
		if (!userId) {
			await narratorService.persistDisplayMessage(narratorId, adminOnlyMsg);
			return { toolName, loaded: false, alreadyLoaded: false };
		}
		const user = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { role: true },
		});
		if (!user || user.role !== "admin") {
			await narratorService.persistDisplayMessage(narratorId, adminOnlyMsg);
			return { toolName, loaded: false, alreadyLoaded: false };
		}
	}

	const { loadOptionalTool } = await import("./narrator-session");
	const result = await loadOptionalTool(narratorId, toolName);
	const alreadyLoaded = result === "already_loaded";
	const infoText = alreadyLoaded
		? `🔧 Tool already loaded: ${toolName}`
		: `🔧 Tool loaded: ${toolName}`;
	await narratorService.persistDisplayMessage(narratorId, infoText);

	// Persist a user-role message so the model is aware the tool was just loaded
	if (!alreadyLoaded) {
		const routine = getBuiltinToolRoutines().find((r) => r.tool?.toolName === toolName);
		const toolDescription =
			locale === "zh-CN"
				? (routine?.tool?.descriptionZh ?? routine?.tool?.descriptionEn ?? toolName)
				: (routine?.tool?.descriptionEn ?? toolName);
		const text = getToolMessageWithParams("toolLoaded", locale, {
			toolName,
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
				contentJson: [{ type: "tool_loaded", toolName, text }],
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

	return { toolName, loaded: true, alreadyLoaded };
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

	const toolName = cmdResult.unloadTool;
	const { unloadOptionalTool } = await import("./narrator-session");
	const result = await unloadOptionalTool(narratorId, toolName);
	const notLoaded = result === "not_loaded";
	const unknownTool = result === "unknown_tool";
	const infoText = unknownTool
		? `⚠️ Unknown tool: ${toolName}`
		: notLoaded
			? `🔧 Tool not loaded: ${toolName}`
			: `🔧 Tool unloaded: ${toolName}`;
	await narratorService.persistDisplayMessage(narratorId, infoText);

	// Persist a user-role message so the model is aware the tool is no longer available.
	if (!notLoaded && !unknownTool) {
		const text = getToolMessageWithParams("toolUnloaded", locale, { toolName });
		const id = generateId();
		const now = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "user",
				contentJson: [{ type: "tool_unloaded", toolName, text }],
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

	return { toolName, unloaded: !notLoaded && !unknownTool, notLoaded };
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
 * Handle `/bash <command>` slash command.
 * Directly executes a bash command without AI involvement.
 * Persists a running tool card before execution, then streams output via WS.
 */
export async function handleBashCommand(
	narratorId: string,
	command: string,
	rawCommand: string,
	userId?: string,
	options?: { skipUserMessage?: boolean },
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
		toolUseId,
		toolName: "Bash",
		input: toolInput,
		streamStartedAt,
	});

	// 3. Execute the process with live-output callbacks wired into the WS channel.
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
			signal: new AbortController().signal,
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

export const narratorService = {
	// ── Core CRUD ──────────────────────────────────────────────────────────────

	async create(input: CreateNarratorInput) {
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
		const id = generateId();
		const resolvedPermMode = normalizeLegacyPermissionMode(
			input.permissionMode ?? settings.agent.defaultPermissionMode,
			"default",
		);
		const startInPlanMode = input.startInPlanMode ?? settings.agent.defaultStartInPlanMode;
		const previousPermissionMode = startInPlanMode ? resolvedPermMode : null;
		const planFileId = startInPlanMode ? generateWordSlug() : null;

		const storedModel = input.model ?? FOLLOW_DEFAULT_MODEL;
		const actualModel = resolveEffectiveModel(storedModel);
		const resolvedProvider = resolveProvider(actualModel);
		const resolvedReasoningEffort =
			input.reasoningEffort === undefined
				? (resolveDefaultReasoningEffort(resolvedProvider, actualModel) ?? null)
				: input.reasoningEffort;

		const chapterId = input.chapterId ?? null;
		const traits: string[] = chapterId === null ? ["standalone"] : [];
		if (startInPlanMode) traits.push("plan");

		// Named narrator: validate + reserve the handle atomically. Named narrators
		// must be standalone (no chapter binding) so they are long-lived and
		// independent of any single chapter's lifecycle.
		const makeNamed = input.makeNamed ?? false;
		let normalizedHandle: string | null = null;
		if (makeNamed) {
			if (!input.handle) {
				throw new ValidationError("handle is required when creating a named narrator");
			}
			if (chapterId !== null) {
				throw new ValidationError("Named narrators must be standalone (no chapterId)");
			}
			normalizedHandle = input.handle.trim().toLowerCase();
			traits.push("named");
		}

		const insertNarrator = async () =>
			(
				await db
					.insert(narrators)
					.values({
						id,
						chapterId,
						type,
						variant: "primary",
						traits,
						handle: normalizedHandle,
						// Named narrators get the GroupControl optional tool by default so
						// they can oversee fellow chat-group members out of the box.
						enabledTools: makeNamed ? ["GroupControl"] : undefined,
						model: storedModel,
						systemPrompt: input.systemPrompt,
						permissionMode: resolvedPermMode,
						previousPermissionMode,
						planFileId,
						planMode: startInPlanMode,
						reasoningEffort: resolvedReasoningEffort,
						fastMode: input.fastMode ?? false,
						relaxedPlan: input.relaxedPlan ?? settings.agent.defaultRelaxedPlan,
						pruneEnabled: input.pruneEnabled ?? settings.agent.defaultPruneEnabled,
						planReflectionAutoApproveOverride: input.planReflectionAutoApproveOverride ?? "inherit",
						dangerReflectionOverride: input.dangerReflectionOverride ?? "inherit",
						cwd: input.cwd ?? null,
						inheritMode: "fresh",
						status: "idle",
						title: input.title ?? null,
						createdAt: now,
						updatedAt: now,
					})
					.returning()
			)[0];

		// Reserve the handle under a global lock so concurrent creates can't both
		// pass the uniqueness check before either inserts.
		const narrator = normalizedHandle
			? await narratorHandleLock.acquire("handle", async () => {
					await this.assertHandleAvailable(normalizedHandle as string);
					return insertNarrator();
				})
			: await insertNarrator();

		logger.info("Narrator created", { id, chapterId, type, handle: normalizedHandle });
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
			basePermMode = parent.relaxedPlan ? (parent.permissionMode ?? "default") : "readOnly";
		}
		const resolvedPermMode = basePermMode as
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "readOnly"
			| "dontAsk";

		const resolvedModel = resolveEffectiveModel(input.model ?? parent.model);
		const resolvedProvider = resolveProvider(resolvedModel);
		const resolvedReasoningEffort =
			input.reasoningEffort === undefined
				? parent.reasoningEffort ||
					(resolveDefaultReasoningEffort(resolvedProvider, resolvedModel) ?? null)
				: input.reasoningEffort;

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
				relaxedPlan: parent.relaxedPlan ?? settings.agent.defaultRelaxedPlan,
				pruneEnabled: parent.pruneEnabled ?? settings.agent.defaultPruneEnabled,
				planReflectionAutoApproveOverride: parent.planReflectionAutoApproveOverride ?? "inherit",
				dangerReflectionOverride: parent.dangerReflectionOverride ?? "inherit",
				parentNarratorId: input.parentNarratorId,
				cwd: input.cwd,
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
		images?: ImageRef[],
	) {
		const id = generateId();
		const now = new Date().toISOString();
		const contentJson: Array<
			| { type: "text"; text: string }
			| { type: "image"; imageId: string; filename: string; mediaType: string }
		> = [];
		if (images?.length) {
			for (const img of images) {
				contentJson.push({
					type: "image",
					imageId: img.imageId,
					filename: img.filename,
					mediaType: img.mediaType,
				});
			}
		}
		contentJson.push({ type: "text", text });
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				parentToolUseId,
				role: "user",
				contentJson,
				contentText: text,
				createdAt: now,
			})
			.returning();

		await appendMessageRef(narratorId, id);
		await bumpParentNarratorMessageVersion(parentToolUseId);
		return msg;
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
	 * Look up a named narrator by its handle (case-insensitive). Returns null if
	 * no narrator owns the handle. Does not throw.
	 */
	async getByHandle(handle: string) {
		const normalized = handle.trim().toLowerCase();
		if (!normalized) return null;
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.handle, normalized),
		});
		return narrator ?? null;
	},

	/**
	 * Throw a ValidationError if the handle is already taken by another narrator.
	 * `excludeNarratorId` lets a narrator keep its own handle when re-validating.
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
			const normalized = handle === null ? null : handle.trim().toLowerCase();
			if (normalized) {
				if (narrator.chapterId !== null) {
					throw new ValidationError("Only standalone narrators can be named");
				}
				await this.assertHandleAvailable(normalized, narratorId);
			}
			const currentTraits = parseTraits(narrator.traits);
			const nextTraits = currentTraits.filter((t) => t !== "named");
			let nextEnabledTools = narrator.enabledTools;
			if (normalized) {
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
					handle: normalized,
					traits: nextTraits,
					enabledTools: nextEnabledTools,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, narratorId))
				.returning();
			logger.info("Narrator handle updated", { narratorId, handle: normalized });
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

		await db.transaction(async (tx) => {
			await tx.delete(terminalViewState).where(eq(terminalViewState.narratorId, narratorId));
			await tx.delete(terminalTabs).where(eq(terminalTabs.narratorId, narratorId));
			await tx.delete(terminals).where(eq(terminals.narratorId, narratorId));
			await tx
				.delete(narratorBufferedMessages)
				.where(eq(narratorBufferedMessages.narratorId, narratorId));
			await tx.delete(narratorGoals).where(eq(narratorGoals.narratorId, narratorId));
			await tx
				.delete(narratorFileSnapshots)
				.where(eq(narratorFileSnapshots.narratorId, narratorId));
			await tx.delete(narratorPatches).where(eq(narratorPatches.narratorId, narratorId));
			await tx
				.delete(narratorWhitelistDirs)
				.where(eq(narratorWhitelistDirs.narratorId, narratorId));
			await tx
				.delete(narratorBlacklistDirs)
				.where(eq(narratorBlacklistDirs.narratorId, narratorId));
			await tx
				.delete(narratorWhitelistCmds)
				.where(eq(narratorWhitelistCmds.narratorId, narratorId));
			await tx
				.delete(narratorBlacklistCmds)
				.where(eq(narratorBlacklistCmds.narratorId, narratorId));
			await tx.delete(apiRequests).where(eq(apiRequests.narratorId, narratorId));
			await tx
				.update(chapterCommits)
				.set({ narratorId: null })
				.where(eq(chapterCommits.narratorId, narratorId));
			await tx
				.update(benchmarkTaskResults)
				.set({ narratorId: null })
				.where(eq(benchmarkTaskResults.narratorId, narratorId));
			await tx
				.delete(gatewaySessionMappings)
				.where(eq(gatewaySessionMappings.narratorId, narratorId));
			await tx.delete(backgroundTasks).where(eq(backgroundTasks.subagentNarratorId, narratorId));
			await tx.delete(backgroundTasks).where(eq(backgroundTasks.parentNarratorId, narratorId));
			await tx.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
			await tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, narratorId));

			const sharedRows = await tx
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
				);

			for (const row of sharedRows) {
				const contentJson = annotateImageBlocksWithUploadOwner(row.contentJson, narratorId);
				await tx
					.update(narratorMessages)
					.set({ narratorId: row.newOwnerId, contentJson })
					.where(eq(narratorMessages.id, row.id));
			}

			const orphanRows = await tx
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
				);
			const orphanIds = orphanRows.map((r) => r.id);

			if (orphanIds.length > 0) {
				await tx
					.update(narrators)
					.set({ forkMessageId: null })
					.where(inArray(narrators.forkMessageId, orphanIds));
				await tx
					.update(narrators)
					.set({ pruneBoundaryMessageId: null })
					.where(inArray(narrators.pruneBoundaryMessageId, orphanIds));
				await tx
					.update(chapterCommits)
					.set({ narratorMessageId: null })
					.where(inArray(chapterCommits.narratorMessageId, orphanIds));
				await tx
					.update(apiRequests)
					.set({ messageId: null })
					.where(inArray(apiRequests.messageId, orphanIds));
				await tx.delete(narratorPatches).where(inArray(narratorPatches.messageId, orphanIds));
				await tx.delete(narratorToolCalls).where(inArray(narratorToolCalls.messageId, orphanIds));
				await tx.delete(narratorMessages).where(inArray(narratorMessages.id, orphanIds));
			}

			await tx.delete(narrators).where(eq(narrators.id, narratorId));
		});

		if (preserveUploads) {
			logger.info("Preserving narrator uploads because shared image messages still exist", {
				narratorId,
			});
		} else {
			await deleteNarratorUploads(narratorId);
		}

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

		const newNarrator = await db.transaction(async (tx) => {
			const [created] = await tx
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
					relaxedPlan: parent.relaxedPlan ?? false,
					pruneEnabled: parent.pruneEnabled ?? settings.agent.defaultPruneEnabled,
					planReflectionAutoApproveOverride: parent.planReflectionAutoApproveOverride ?? "inherit",
					dangerReflectionOverride: parent.dangerReflectionOverride ?? "inherit",
					parentNarratorId,
					inheritMode: "full",
					status: "idle",
					title: opts?.title ?? null,
					cwd: parent.cwd ?? null,
					createdAt: now,
					updatedAt: now,
				})
				.returning();

			const dupRefValues = parentRefs.map((row, i) => ({
				id: generateId(),
				narratorId: id,
				messageId: row.messageId,
				seq: i + 1,
				isCompact: 0,
			}));
			await insertRefsBatched(tx, dupRefValues);

			return created;
		});

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

		const directMessageId = opts?.forkMessageId;
		if ((forkMessageUuid || directMessageId) && inheritMode !== "fresh") {
			let msgId: string;
			if (forkMessageUuid) {
				const msg = await db.query.narratorMessages.findFirst({
					where: eq(narratorMessages.messageUuid, forkMessageUuid),
				});
				if (!msg) throw new ValidationError("Fork message not found");
				msgId = msg.id;
			} else {
				if (!directMessageId) throw new ValidationError("Fork message not found");
				msgId = directMessageId;
			}

			const forkRef = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, parentNarratorId),
					eq(narratorMessageRefs.messageId, msgId),
				),
			});
			if (!forkRef) throw new ValidationError("Fork message not found in parent narrator's refs");
			resolvedForkMessageId = forkRef.messageId;

			prefixRows = await db
				.select({
					messageId: narratorMessageRefs.messageId,
					seq: narratorMessageRefs.seq,
					isCompact: narratorMessageRefs.isCompact,
					prunedPercent: narratorMessageRefs.prunedPercent,
					segmentCompactId: narratorMessageRefs.segmentCompactId,
				})
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, parentNarratorId),
						sql`${narratorMessageRefs.seq} <= ${forkRef.seq}`,
					),
				)
				.orderBy(narratorMessageRefs.seq);
		} else if (inheritMode === "full") {
			const lastCompact = await db
				.select({ seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, parentNarratorId),
						eq(narratorMessageRefs.isCompact, 1),
					),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(1);
			const compactSeq = lastCompact[0]?.seq;
			const rows = await db
				.select({
					messageId: narratorMessageRefs.messageId,
					seq: narratorMessageRefs.seq,
					isCompact: narratorMessageRefs.isCompact,
					prunedPercent: narratorMessageRefs.prunedPercent,
					segmentCompactId: narratorMessageRefs.segmentCompactId,
				})
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, parentNarratorId),
						compactSeq != null ? sql`${narratorMessageRefs.seq} > ${compactSeq}` : undefined,
						sql`${narratorMessageRefs.segmentCompactId} IS NULL`,
					),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(MAX_INHERITED_FULL_FORK_REFS + 1);

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
			resolvedForkMessageId = prefixRows[prefixRows.length - 1]?.messageId ?? null;
		}

		if (inheritMode === "full" && prefixRows.length === 0 && parent.apiConversationId) {
			apiConversationId = null;
			logger.warn("Full narrator fork has no local refs; remote conversation id not inherited", {
				parentNarratorId,
				newNarratorId: id,
			});
		}

		const storedModel = parent.model ?? FOLLOW_DEFAULT_MODEL;
		const effectiveModel = resolveEffectiveModel(storedModel);
		const resolvedProvider = resolveProvider(effectiveModel);
		const resolvedReasoningEffort =
			parent.reasoningEffort ||
			(resolveDefaultReasoningEffort(resolvedProvider, effectiveModel) ?? null);

		const forkTraits2: string[] = targetChapterId ? [] : ["standalone"];

		const newNarrator = await db.transaction(async (tx) => {
			const [created] = await tx
				.insert(narrators)
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
					relaxedPlan: parent.relaxedPlan ?? settings.agent.defaultRelaxedPlan,
					pruneEnabled: parent.pruneEnabled ?? settings.agent.defaultPruneEnabled,
					planReflectionAutoApproveOverride: parent.planReflectionAutoApproveOverride ?? "inherit",
					dangerReflectionOverride: parent.dangerReflectionOverride ?? "inherit",
					parentNarratorId,
					forkMessageId: resolvedForkMessageId,
					inheritMode,
					apiConversationId,
					contextSummary,
					status: "idle",
					title: opts?.title ?? null,
					cwd: parent.cwd ?? null,
					createdAt: now,
					updatedAt: now,
				})
				.returning();

			if (prefixRows.length > 0) {
				const refValues = prefixRows.map((row, index) => ({
					id: generateId(),
					narratorId: id,
					messageId: row.messageId,
					seq: index,
					isCompact: row.isCompact,
					prunedPercent: row.prunedPercent,
					segmentCompactId: row.segmentCompactId,
				}));
				await insertRefsBatched(tx, refValues);

				if (parent.pruneBoundaryMessageId) {
					const boundaryInPrefix = prefixRows.find(
						(r) => r.messageId === parent.pruneBoundaryMessageId,
					);
					if (boundaryInPrefix) {
						const boundaryIdx = prefixRows.indexOf(boundaryInPrefix);
						const inheritedPrunedPercent = Math.round(
							((boundaryIdx + 1) / prefixRows.length) * 100,
						);
						await tx
							.update(narrators)
							.set({
								pruneBoundaryMessageId: parent.pruneBoundaryMessageId,
								prunedPercent: inheritedPrunedPercent,
							})
							.where(eq(narrators.id, id));
					}
				}
			}

			if (inheritMode === "compressed" && contextSummary) {
				const compactMsgId = generateId();
				const compactNow = new Date().toISOString();
				await tx.insert(narratorMessages).values({
					id: compactMsgId,
					narratorId: id,
					role: "system",
					contentJson: [{ type: "compact", status: "compacted", summary: contextSummary }],
					contentText: `[Compressed context from parent conversation]`,
					createdAt: compactNow,
				});
				const maxSeqResult = await tx
					.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
					.from(narratorMessageRefs)
					.where(eq(narratorMessageRefs.narratorId, id));
				const compactSeq = (maxSeqResult[0]?.maxSeq ?? -1) + 1;
				await tx.insert(narratorMessageRefs).values({
					id: generateId(),
					narratorId: id,
					messageId: compactMsgId,
					seq: compactSeq,
					isCompact: 1,
				});
			}

			const parentWhitelistDirs = await tx
				.select()
				.from(narratorWhitelistDirs)
				.where(eq(narratorWhitelistDirs.narratorId, parentNarratorId));

			if (parentWhitelistDirs.length > 0) {
				await tx.insert(narratorWhitelistDirs).values(
					parentWhitelistDirs.map((dir) => ({
						id: generateId(),
						narratorId: id,
						path: dir.path,
						accessLevel: dir.accessLevel,
						enabled: dir.enabled,
						createdAt: now,
					})),
				);
			}

			return created;
		});

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
	getLatestCompactSeq: narratorMessageQueries.getLatestCompactSeq.bind(narratorMessageQueries),
	getMessagesBefore: narratorMessageQueries.getMessagesBefore.bind(narratorMessageQueries),
	getEarliestMessages: narratorMessageQueries.getEarliestMessages.bind(narratorMessageQueries),
	_getPostCompactTopLevelRefs:
		narratorMessageQueries._getPostCompactTopLevelRefs.bind(narratorMessageQueries),
	getCompactBoundaryMessage:
		narratorMessageQueries.getCompactBoundaryMessage.bind(narratorMessageQueries),
	getRecentMessages: narratorMessageQueries.getRecentMessages.bind(narratorMessageQueries),
	isSubagentNarrator: narratorMessageQueries.isSubagentNarrator.bind(narratorMessageQueries),
	getChunkManifest: narratorMessageQueries.getChunkManifest.bind(narratorMessageQueries),
	getChunksByRange: narratorMessageQueries.getChunksByRange.bind(narratorMessageQueries),
	getMessageVersion: narratorMessageQueries.getMessageVersion.bind(narratorMessageQueries),
	getMessageLocation: narratorMessageQueries.getMessageLocation.bind(narratorMessageQueries),
	getMessagesAfter: narratorMessageQueries.getMessagesAfter.bind(narratorMessageQueries),
	getToolCallDetail: narratorMessageQueries.getToolCallDetail.bind(narratorMessageQueries),
	getCompactSummary: narratorMessageQueries.getCompactSummary.bind(narratorMessageQueries),
	deleteCompactMessage: narratorMessageQueries.deleteCompactMessage.bind(narratorMessageQueries),
	deleteMessage: narratorMessageQueries.deleteMessage.bind(narratorMessageQueries),
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
	persistPlanMessage: narratorPersistence.persistPlanMessage.bind(narratorPersistence),
	clearContext: narratorPersistence.clearContext.bind(narratorPersistence),
	clearContextBefore: narratorPersistence.clearContextBefore.bind(narratorPersistence),
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
	updatePruneEnabled: narratorPersistence.updatePruneEnabled.bind(narratorPersistence),
	updateStatus: narratorPersistence.updateStatus.bind(narratorPersistence),
	compareAndSetStatus: narratorPersistence.compareAndSetStatus.bind(narratorPersistence),
	updateSubstatus: narratorPersistence.updateSubstatus.bind(narratorPersistence),
	addSubstatus: narratorPersistence.addSubstatus.bind(narratorPersistence),
	removeSubstatus: narratorPersistence.removeSubstatus.bind(narratorPersistence),
	updateTodos: narratorPersistence.updateTodos.bind(narratorPersistence),
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
