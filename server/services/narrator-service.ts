import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorWhitelistDirs,
	overseers,
	projects,
	terminals,
	terminalTabs,
	terminalViewState,
	users,
} from "../db/schema";
import { getBuiltinToolRoutines } from "../lib/builtin-routines";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { isSubagentVariant, subagentVariant } from "../lib/narrator-utils";
import { getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";
import {
	FOLLOW_DEFAULT_MODEL,
	resolveDefaultReasoningEffort,
	resolveEffectiveModel,
	resolveProvider,
	settings,
} from "../lib/settings";
import { contentJsonHasImageBlocks, deleteNarratorUploads, type ImageRef } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import type { LoadSkillResult, LoadToolNotFound, LoadToolResult } from "./command-service";
import { narratorMessageQueries } from "./narrator-messages";
import { appendMessageRef, narratorPersistence } from "./narrator-persistence";

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

/** Batch-insert narratorMessageRefs rows, chunking to stay within SQLite's variable limit. */
async function insertRefsBatched(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	values: (typeof narratorMessageRefs.$inferInsert)[],
) {
	for (let i = 0; i < values.length; i += REFS_INSERT_BATCH) {
		await tx.insert(narratorMessageRefs).values(values.slice(i, i + REFS_INSERT_BATCH));
	}
}

async function narratorStillOwnsImageMessages(narratorId: string): Promise<boolean> {
	const remainingOwnedMessages = await db
		.select({ contentJson: narratorMessages.contentJson })
		.from(narratorMessages)
		.where(eq(narratorMessages.narratorId, narratorId));
	return remainingOwnedMessages.some((row) => contentJsonHasImageBlocks(row.contentJson));
}

interface CreateNarratorInput {
	chapterId?: string | null;
	type?: "primary";
	model?: string;
	systemPrompt?: string;
	permissionMode?: string;
	cwd?: string;
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | null;
	fastMode?: boolean;
	relaxedPlan?: boolean;
	title?: string;
}

interface CreateSubagentInput {
	parentNarratorId: string;
	subagentType: string;
	cwd: string;
	title?: string;
	permissionMode?: string;
	model?: string;
	systemPrompt?: string;
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
		const infoText =
			locale === "zh-CN"
				? `⚠️ 未知工具：${toolId}。可用：terminal, share_file, narrafork_admin`
				: `⚠️ Unknown tool: ${toolId}. Available: terminal, share_file, narrafork_admin`;
		await narratorService.persistDisplayMessage(narratorId, infoText);
		return { toolName: toolId, loaded: false, alreadyLoaded: false };
	}
	const toolName = cmdResult.loadTool;

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
 * Handle `/skill <name>` slash command.
 */
export async function handleLoadSkillCommand(
	narratorId: string,
	cmdResult: LoadSkillResult,
): Promise<
	{ found: true; skillName: string; content: string } | { found: false; skillName: string }
> {
	const { join } = await import("node:path");
	const { loadAllSkills } = await import("./skill-service");

	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true },
	});
	let gitPath: string | null = null;
	if (narrator?.chapterId) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
			columns: { projectId: true },
		});
		if (chapter) {
			const project = await db.query.projects.findFirst({
				where: eq(projects.id, chapter.projectId),
				columns: { gitPath: true },
			});
			gitPath = project?.gitPath ?? null;
		}
	}

	const allSkills = await loadAllSkills(gitPath);
	const skills = allSkills.filter((s) => !s.disabled);
	const found = skills.find((s) => s.name === cmdResult.loadSkill);

	if (!found) {
		const available = skills.map((s) => s.name).join(", ");
		const infoText = `⚠️ Skill "${cmdResult.loadSkill}" not found. Available: ${available || "(none)"}`;
		await narratorService.persistDisplayMessage(narratorId, infoText);
		return { found: false, skillName: cmdResult.loadSkill };
	}

	const skillDir = join(found.location, "..");
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
		const resolvedPermMode = (input.permissionMode ?? settings.agent.defaultPermissionMode) as
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "plan"
			| "dontAsk";

		const storedModel = input.model ?? FOLLOW_DEFAULT_MODEL;
		const actualModel = resolveEffectiveModel(storedModel);
		const resolvedProvider = resolveProvider(actualModel);
		const resolvedReasoningEffort =
			input.reasoningEffort === undefined
				? (resolveDefaultReasoningEffort(resolvedProvider) ?? null)
				: input.reasoningEffort;

		const chapterId = input.chapterId ?? null;
		const traits: string[] = chapterId === null ? ["standalone"] : [];

		const [narrator] = await db
			.insert(narrators)
			.values({
				id,
				chapterId,
				type,
				variant: "primary",
				traits,
				model: storedModel,
				systemPrompt: input.systemPrompt,
				permissionMode: resolvedPermMode,
				reasoningEffort: resolvedReasoningEffort,
				fastMode: input.fastMode ?? false,
				relaxedPlan: input.relaxedPlan ?? settings.agent.defaultRelaxedPlan,
				cwd: input.cwd ?? null,
				inheritMode: "fresh",
				status: "idle",
				title: input.title ?? null,
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		logger.info("Narrator created", { id, chapterId, type });
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
		if (basePermMode === "plan") {
			basePermMode = parent.relaxedPlan ? (parent.previousPermissionMode ?? "default") : "readOnly";
		}
		const resolvedPermMode = basePermMode as
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "plan"
			| "dontAsk";

		const resolvedModel = resolveEffectiveModel(input.model ?? parent.model);
		const resolvedProvider = resolveProvider(resolvedModel);
		const resolvedReasoningEffort =
			parent.reasoningEffort || (resolveDefaultReasoningEffort(resolvedProvider) ?? null);

		const subChapterId = parent.chapterId ?? null;
		const subTraits: string[] = subChapterId === null ? ["standalone"] : [];

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
		return msg;
	},

	async getById(id: string) {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, id),
		});
		if (!narrator) throw new NotFoundError("Narrator", id);
		return narrator;
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

		await db.transaction(async (tx) => {
			await tx.delete(overseers).where(eq(overseers.narratorId, narratorId));
			await tx
				.update(narratorToolCalls)
				.set({ permissionOverseerNarratorId: null })
				.where(eq(narratorToolCalls.permissionOverseerNarratorId, narratorId));
			await tx.delete(terminalViewState).where(eq(terminalViewState.narratorId, narratorId));
			await tx.delete(terminalTabs).where(eq(terminalTabs.narratorId, narratorId));
			await tx.delete(terminals).where(eq(terminals.narratorId, narratorId));
			await tx.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
			await tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, narratorId));

			const orphanRows = await tx
				.select({ id: narratorMessages.id })
				.from(narratorMessages)
				.where(
					and(
						eq(narratorMessages.narratorId, narratorId),
						sql`NOT EXISTS (
							SELECT 1 FROM narrator_message_refs nmr
							WHERE nmr.message_id = ${narratorMessages.id}
							AND nmr.narrator_id != ${narratorId}
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
				await tx.delete(narratorMessages).where(inArray(narratorMessages.id, orphanIds));
			}

			await tx.delete(narrators).where(eq(narrators.id, narratorId));
		});

		if (await narratorStillOwnsImageMessages(narratorId)) {
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
		},
	) {
		const parent = await this.getById(parentNarratorId);

		if (isSubagentVariant(parent.variant)) {
			throw new ValidationError("Cannot fork from a subagent narrator");
		}

		if (parent.chapterId && !opts?.newChapterId) {
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
			apiConversationId = parent.apiConversationId ?? null;
			contextSummary = parent.contextSummary ?? null;
		}

		let prefixRows: Array<{
			messageId: string;
			seq: number;
			isCompact: number;
			prunedPercent: number | null;
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
				msgId = directMessageId!;
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
				})
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, parentNarratorId),
						sql`${narratorMessageRefs.seq} <= ${forkRef.seq}`,
					),
				)
				.orderBy(narratorMessageRefs.seq);
		}

		const storedModel = parent.model ?? FOLLOW_DEFAULT_MODEL;
		const effectiveModel = resolveEffectiveModel(storedModel);
		const resolvedProvider = resolveProvider(effectiveModel);
		const resolvedReasoningEffort =
			parent.reasoningEffort || (resolveDefaultReasoningEffort(resolvedProvider) ?? null);

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
				const refValues = prefixRows.map((row) => ({
					id: generateId(),
					narratorId: id,
					messageId: row.messageId,
					seq: row.seq,
					isCompact: row.isCompact,
					prunedPercent: row.prunedPercent,
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
	getMessagesBefore: narratorMessageQueries.getMessagesBefore.bind(narratorMessageQueries),
	getEarliestMessages: narratorMessageQueries.getEarliestMessages.bind(narratorMessageQueries),
	_getPostCompactTopLevelRefs:
		narratorMessageQueries._getPostCompactTopLevelRefs.bind(narratorMessageQueries),
	getCompactBoundaryMessage:
		narratorMessageQueries.getCompactBoundaryMessage.bind(narratorMessageQueries),
	getRecentMessages: narratorMessageQueries.getRecentMessages.bind(narratorMessageQueries),
	isSubagentNarrator: narratorMessageQueries.isSubagentNarrator.bind(narratorMessageQueries),
	getMessagesCursor: narratorMessageQueries.getMessagesCursor.bind(narratorMessageQueries),
	getMessageVersion: narratorMessageQueries.getMessageVersion.bind(narratorMessageQueries),
	getMessagesAfter: narratorMessageQueries.getMessagesAfter.bind(narratorMessageQueries),
	getMessagesAround: narratorMessageQueries.getMessagesAround.bind(narratorMessageQueries),
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
	updateTitle: narratorPersistence.updateTitle.bind(narratorPersistence),
	updateCwd: narratorPersistence.updateCwd.bind(narratorPersistence),
	updateModel: narratorPersistence.updateModel.bind(narratorPersistence),
	updatePermissionMode: narratorPersistence.updatePermissionMode.bind(narratorPersistence),
	updateReasoningEffort: narratorPersistence.updateReasoningEffort.bind(narratorPersistence),
	updateFastMode: narratorPersistence.updateFastMode.bind(narratorPersistence),
	updateRelaxedPlan: narratorPersistence.updateRelaxedPlan.bind(narratorPersistence),
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
