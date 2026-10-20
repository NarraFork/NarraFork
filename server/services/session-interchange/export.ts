import { readQuery } from "@server/db/worker-read";
/**
 * NarraFork narrator → InterchangeSession → Claude Code / Codex session files.
 *
 * Reading goes through `iterateNarratorTranscript`, the same read-only, bounded
 * pager the Markdown/JSON export uses, so a lazily forked narrator is exported
 * without materializing refs and no page stalls the main thread.
 *
 * Unlike the Markdown export, a resumable session cannot be an excerpt: the
 * destination CLI will send it to a model. So there is one hard cap on the whole
 * transcript (`SESSION_EXPORT_MAX_CHARS`) instead of per-page truncation, and
 * exceeding it fails the export with a clear error rather than producing a file
 * that looks resumable but is missing the middle of the conversation.
 *
 * Tool outputs are the exception: they are clamped per call and counted as a
 * `truncated_output` warning, because a single huge `cat` must not make an
 * otherwise normal session unexportable.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { outputToText } from "@shared/agent-protocol/tool-output";
import { parseCompactMessageBlock } from "@shared/compact-message";
import { modelTextFromContentBlocks } from "@shared/native-injection";
import {
	claudeCodeSessionLayout,
	claudeCodeSubagentFileNames,
	defaultClaudeCodePathHash,
	newClaudeCodeAgentId,
} from "@shared/session-interchange/claude-code/paths";
import { serializeClaudeCodeSession } from "@shared/session-interchange/claude-code/serialize";
import {
	codexRolloutPath,
	localDateParts,
	newUuidV7,
} from "@shared/session-interchange/codex/paths";
import {
	codexSessionIndexLine,
	serializeCodexSession,
} from "@shared/session-interchange/codex/serialize";
import {
	type InterchangeAssistantBlock,
	type InterchangeFormat,
	type InterchangeMessage,
	type InterchangeSession,
	type InterchangeSubagent,
	type InterchangeUserBlock,
	type InterchangeWarning,
	WarningCollector,
} from "@shared/session-interchange/model";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { narratorMessages, narrators, narratorToolCalls } from "../../db/schema";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { getSubagentType, isSubagentVariant } from "../../lib/narrator-utils";
import { settings } from "../../lib/settings";
import { getImagePath, imageToBase64 } from "../../lib/uploads";
import { iterateNarratorTranscript, resolveTranscriptScope } from "../narrator-export";
/**
 * Ceiling on the characters one export may hold in memory, subagents included.
 *
 * A resumable file is built whole (the CLI needs every row) and serialized
 * synchronously, so this is what bounds both the heap and the time the main
 * thread spends in one export: the session, its serialized rows, the joined file
 * and its bytes coexist briefly, a small multiple of this. 32M characters covers
 * the largest real sessions seen (~20 MB transcripts) with room to spare.
 */
export const SESSION_EXPORT_MAX_CHARS = 32 * 1024 * 1024;

/** Per-call tool output clamp, matching the import side. */
export const SESSION_EXPORT_TOOL_OUTPUT_MAX_CHARS = 512 * 1024;

/** Subagent narrators exported per session. */
export const SESSION_EXPORT_MAX_SUBAGENTS = 200;

/** Images embedded per session; beyond this they become a text placeholder. */
export const SESSION_EXPORT_MAX_IMAGES = 200;

/** Largest single image embedded, in bytes on disk. */
export const SESSION_EXPORT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface SessionExportOptions {
	format: InterchangeFormat;
	/** Working directory written into the session; defaults to the narrator's. */
	cwd?: string;
	/** Codex only: `model_provider` in session_meta. */
	codexModelProvider?: string;
	/** Claude Code only: drop signed thinking too. */
	dropAllReasoning?: boolean;
}

/** One file to write, relative to the CLI's config root (`~/.claude` or `~/.codex`). */
export interface SessionExportFile {
	relativePath: string[];
	content: string;
	/** Codex `session_index.jsonl` is appended to, never replaced. */
	mode: "create" | "append";
}

export interface SessionExportResult {
	format: InterchangeFormat;
	sessionId: string;
	cwd: string;
	title: string | undefined;
	files: SessionExportFile[];
	resumeCommand: string;
	warnings: InterchangeWarning[];
}

// ── Reading ────────────────────────────────────────────────────────────────

type MessageRow = typeof narratorMessages.$inferSelect;
type ToolRow = Pick<
	typeof narratorToolCalls.$inferSelect,
	| "messageId"
	| "toolUseId"
	| "toolName"
	| "inputJson"
	| "outputJson"
	| "status"
	| "errorMessage"
	| "completedAt"
	| "createdAt"
>;

class Budget {
	private used = 0;

	charge(chars: number): void {
		this.used += chars;
		if (this.used > SESSION_EXPORT_MAX_CHARS) {
			throw new ValidationError(
				`Session is too large to export as a resumable file (over ${SESSION_EXPORT_MAX_CHARS} characters).`,
			);
		}
	}
}

interface ReadContext {
	warnings: WarningCollector;
	budget: Budget;
	/** Shared by the parent and every subagent, so the cap is per export. */
	images: { embedded: number };
	/** tool_use id → subagent narrator id, for the calls that spawned one. */
	subagentByToolUseId: Map<string, string>;
	/**
	 * Reasoning sources that are the official Anthropic API: the prefixes of
	 * providers configured with `officialApi`. A signature minted anywhere else
	 * (a NUG channel, a relay) is not replayable by `claude --resume`.
	 */
	officialSources: ReadonlySet<string>;
	signal?: AbortSignal;
}

// biome-ignore lint/suspicious/noExplicitAny: contentJson is dynamic SDK JSON
function blocksOf(contentJson: any): Array<Record<string, any>> {
	return Array.isArray(contentJson) ? contentJson : [];
}

/**
 * Reasoning sources known to be the official Anthropic API.
 *
 * A direct Anthropic provider stamps its own prefix as `signatureSource` (see
 * `getActiveReasoningSource`); only those configured with `officialApi` talk to
 * the API Claude Code uses. A block with no source at all is legacy and cannot be
 * proven either way, so it is treated as foreign, matching
 * `signatureSourcesCompatible`.
 */
function officialAnthropicSources(): Set<string> {
	const sources = new Set<string>();
	for (const provider of settings.anthropicProviders ?? []) {
		if (provider.officialApi && !provider.disabled && provider.prefix) sources.add(provider.prefix);
	}
	return sources;
}

/**
 * Whether a stored thinking signature was minted by the official Anthropic API:
 * either by a provider configured as the official API, or read out of a Claude
 * Code transcript on import (Claude Code only talks to that API).
 */
// biome-ignore lint/suspicious/noExplicitAny: stored reasoning block
function isOfficialSignature(block: Record<string, any>, ctx: ReadContext): boolean {
	const meta = block.providerMetadata;
	if (meta?.importedOfficialAnthropic === true) return true;
	return typeof meta?.signatureSource === "string" && ctx.officialSources.has(meta.signatureSource);
}
async function loadImageBlock(
	// biome-ignore lint/suspicious/noExplicitAny: stored image block
	block: Record<string, any>,
	ownerNarratorId: string,
	ctx: ReadContext,
): Promise<InterchangeUserBlock | null> {
	if (ctx.images.embedded >= SESSION_EXPORT_MAX_IMAGES) {
		ctx.warnings.add("dropped_unsupported_block", "image limit reached");
		return { type: "text", text: "[image omitted]" };
	}
	const uploadNarratorId =
		typeof block.uploadNarratorId === "string" ? block.uploadNarratorId : ownerNarratorId;
	const filePath =
		typeof block.imageId === "string" ? getImagePath(uploadNarratorId, block.imageId) : null;
	if (!filePath) {
		ctx.warnings.add("dropped_unsupported_block", "image missing on disk");
		return { type: "text", text: "[image unavailable]" };
	}
	const size = Bun.file(filePath).size;
	if (size > SESSION_EXPORT_MAX_IMAGE_BYTES) {
		ctx.warnings.add("dropped_unsupported_block", "image too large");
		return { type: "text", text: "[image omitted]" };
	}
	try {
		const result = await imageToBase64(filePath);
		ctx.budget.charge(result.base64.length);
		ctx.images.embedded += 1;
		return {
			type: "image",
			mediaType:
				result.detectedMediaType ??
				(typeof block.mediaType === "string" ? block.mediaType : "image/png"),
			data: result.base64,
		};
	} catch (error) {
		ctx.warnings.add(
			"dropped_unsupported_block",
			`image: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { type: "text", text: "[image unavailable]" };
	}
}

async function userMessage(row: MessageRow, ctx: ReadContext): Promise<InterchangeMessage | null> {
	const blocks: InterchangeUserBlock[] = [];
	const content = blocksOf(row.contentJson);
	const text = modelTextFromContentBlocks(content) || (content.length ? "" : row.contentText) || "";
	if (text.trim()) blocks.push({ type: "text", text });
	for (const block of content) {
		if (block.type !== "image") continue;
		const image = await loadImageBlock(block, row.narratorId, ctx);
		if (image) blocks.push(image);
	}
	if (blocks.length === 0) return null;
	ctx.budget.charge(text.length);
	return { role: "user", timestamp: row.createdAt, blocks };
}

function compactMessage(row: MessageRow): InterchangeMessage | null {
	for (const block of blocksOf(row.contentJson)) {
		const compact = parseCompactMessageBlock(block);
		if (compact?.status === "compacted" && compact.summary?.trim()) {
			return { role: "compact", timestamp: row.createdAt, summary: compact.summary };
		}
	}
	return null;
}

function clampOutput(value: string, ctx: ReadContext): string {
	if (value.length <= SESSION_EXPORT_TOOL_OUTPUT_MAX_CHARS) return value;
	ctx.warnings.add("truncated_output");
	return `${value.slice(0, SESSION_EXPORT_TOOL_OUTPUT_MAX_CHARS)}\n\n[truncated on export]`;
}

function parseInput(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {
			// Fall through: an unparseable input still exports as an empty object.
		}
	}
	return {};
}

/**
 * An assistant row plus the results of its calls.
 *
 * The block order in `contentJson` is the order the model produced, so it is
 * kept; a call recorded only in `narrator_tool_calls` (older rows) is appended.
 * Only finished calls are exported: an unfinished one has no result to pair
 * with, and both CLIs reject or drop an unpaired call.
 */
function assistantMessages(
	row: MessageRow,
	tools: ToolRow[],
	ctx: ReadContext,
): InterchangeMessage[] {
	const finished = new Map<string, ToolRow>();
	for (const tool of tools) {
		if (tool.status === "success" || tool.status === "fail") finished.set(tool.toolUseId, tool);
	}
	const blocks: InterchangeAssistantBlock[] = [];
	const emitted = new Set<string>();
	let chars = 0;

	const pushTool = (tool: ToolRow) => {
		const input = parseInput(tool.inputJson);
		chars += JSON.stringify(input).length;
		const subagentRef = ctx.subagentByToolUseId.get(tool.toolUseId);
		blocks.push({
			type: "tool_use",
			id: tool.toolUseId,
			name: tool.toolName,
			input,
			...(subagentRef ? { subagentRef } : {}),
		});
		emitted.add(tool.toolUseId);
	};

	for (const block of blocksOf(row.contentJson)) {
		if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
			blocks.push({ type: "text", text: block.text });
			chars += block.text.length;
		} else if (block.type === "reasoning" && typeof block.text === "string" && block.text.trim()) {
			const signature = block.providerMetadata?.anthropic?.signature;
			blocks.push({
				type: "reasoning",
				text: block.text,
				...(typeof signature === "string" && signature
					? {
							signature: {
								provider: "anthropic" as const,
								value: signature,
								officialAnthropic: isOfficialSignature(block, ctx),
							},
						}
					: {}),
			});
			chars += block.text.length;
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			blocks.push({
				type: "reasoning",
				text: block.thinking,
				...(typeof block.signature === "string" && block.signature
					? {
							signature: {
								provider: "anthropic" as const,
								value: block.signature,
								officialAnthropic: isOfficialSignature(block, ctx),
							},
						}
					: {}),
			});
			chars += block.thinking.length;
		} else if (block.type === "redacted_thinking") {
			// Encrypted by the upstream that produced it; no other CLI can use it.
			ctx.warnings.add("dropped_reasoning", "redacted_thinking");
		} else if (block.type === "tool_use" && typeof block.id === "string") {
			const tool = finished.get(block.id);
			if (tool && !emitted.has(block.id)) pushTool(tool);
		}
	}
	for (const tool of finished.values()) if (!emitted.has(tool.toolUseId)) pushTool(tool);
	if (blocks.length === 0 && row.contentText?.trim()) {
		blocks.push({ type: "text", text: row.contentText });
		chars += row.contentText.length;
	}
	if (blocks.length === 0) return [];

	const out: InterchangeMessage[] = [
		{
			role: "assistant",
			timestamp: row.createdAt,
			...(row.model ? { model: row.model } : {}),
			blocks,
		},
	];
	for (const block of blocks) {
		if (block.type !== "tool_use") continue;
		const tool = finished.get(block.id);
		if (!tool) continue;
		const raw =
			tool.status === "fail" && tool.outputJson == null
				? (tool.errorMessage ?? "Tool call failed.")
				: outputToText(tool.outputJson);
		const output = clampOutput(raw, ctx);
		chars += output.length;
		out.push({
			role: "tool_result",
			timestamp: tool.completedAt ?? row.createdAt,
			toolUseId: tool.toolUseId,
			output,
			isError: tool.status === "fail",
		});
	}
	ctx.budget.charge(chars);
	return out;
}

async function loadTools(messageIds: string[]): Promise<Map<string, ToolRow[]>> {
	const byMessage = new Map<string, ToolRow[]>();
	if (messageIds.length === 0) return byMessage;
	const rows = await readQuery(
		db
			.select({
				messageId: narratorToolCalls.messageId,
				toolUseId: narratorToolCalls.toolUseId,
				toolName: narratorToolCalls.toolName,
				inputJson: narratorToolCalls.inputJson,
				outputJson: narratorToolCalls.outputJson,
				status: narratorToolCalls.status,
				errorMessage: narratorToolCalls.errorMessage,
				completedAt: narratorToolCalls.completedAt,
				createdAt: narratorToolCalls.createdAt,
			})
			.from(narratorToolCalls)
			.where(inArray(narratorToolCalls.messageId, messageIds))
			.orderBy(asc(narratorToolCalls.createdAt), asc(narratorToolCalls.id)),
	);
	for (const row of rows) {
		if (!row.messageId) continue;
		const list = byMessage.get(row.messageId);
		if (list) list.push(row);
		else byMessage.set(row.messageId, [row]);
	}
	return byMessage;
}

async function rowsToMessages(
	rows: MessageRow[],
	ctx: ReadContext,
	isCompactRef: (messageId: string) => boolean,
): Promise<InterchangeMessage[]> {
	const tools = await loadTools(rows.filter((r) => r.role === "assistant").map((r) => r.id));
	const out: InterchangeMessage[] = [];
	for (const row of rows) {
		if (row.role === "assistant") {
			out.push(...assistantMessages(row, tools.get(row.id) ?? [], ctx));
		} else if (row.role === "user") {
			const message = await userMessage(row, ctx);
			if (message) out.push(message);
		} else if (row.role === "system" && isCompactRef(row.id)) {
			const compact = compactMessage(row);
			if (compact) out.push(compact);
		}
		// `sys` rows are injected reminders and `disp` rows are display-only: neither
		// is conversation the destination CLI should replay.
	}
	return out;
}

/** The narrator's own top-level transcript, full scope, in seq order. */
async function readTopLevel(narratorId: string, ctx: ReadContext): Promise<InterchangeMessage[]> {
	const scope = await resolveTranscriptScope(narratorId, "full");
	const out: InterchangeMessage[] = [];
	for await (const page of iterateNarratorTranscript(narratorId, scope, ctx.signal)) {
		if (page.refs.length === 0) continue;
		const ids = page.refs.map((ref) => ref.messageId);
		const compactIds = new Set(page.refs.filter((ref) => ref.isCompact).map((r) => r.messageId));
		const loaded = await readQuery(
			db.select().from(narratorMessages).where(inArray(narratorMessages.id, ids)),
		);
		const byId = new Map(loaded.map((row) => [row.id, row]));
		const ordered = ids.flatMap((id) => {
			const row = byId.get(id);
			return row ? [row] : [];
		});
		out.push(...(await rowsToMessages(ordered, ctx, (id) => compactIds.has(id))));
	}
	if (ctx.signal?.aborted) throw new ValidationError("Export cancelled");
	return out;
}

/**
 * Subagent narrators spawned by this narrator's tool calls, keyed by the spawning
 * tool_use id. Only tool-originated children count: a standalone subagent has no
 * call in the parent transcript to hang from.
 */
async function loadSubagents(
	parentId: string,
): Promise<Array<{ id: string; toolUseId: string; variant: string; title: string | null }>> {
	const rows = await readQuery(
		db
			.select({
				id: narrators.id,
				variant: narrators.variant,
				subagentType: narrators.subagentType,
				title: narrators.title,
				toolUseId: narratorToolCalls.toolUseId,
			})
			.from(narrators)
			.innerJoin(narratorToolCalls, eq(narratorToolCalls.id, narrators.originToolCallId))
			.where(
				and(
					eq(narrators.parentNarratorId, parentId),
					eq(narrators.type, "subagent"),
					eq(narrators.subagentOriginKind, "tool"),
				),
			)
			.orderBy(asc(narrators.createdAt), asc(narrators.id))
			.limit(SESSION_EXPORT_MAX_SUBAGENTS + 1),
	);
	return rows.map((row) => ({
		id: row.id,
		toolUseId: row.toolUseId,
		variant: row.variant,
		title: row.title,
	}));
}

/**
 * Build the interchange form of a narrator and its tool-spawned subagents.
 *
 * Exported separately from the file writers so the conversion can be tested on
 * its own and reused by any future destination.
 */
export async function narratorToInterchange(
	narratorId: string,
	signal?: AbortSignal,
): Promise<InterchangeSession> {
	const narrator = await readQuery(
		db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) }),
	);
	if (!narrator) throw new NotFoundError("Narrator", narratorId);

	const warnings = new WarningCollector();
	const ctx: ReadContext = {
		warnings,
		budget: new Budget(),
		images: { embedded: 0 },
		subagentByToolUseId: new Map(),
		officialSources: officialAnthropicSources(),
		signal,
	};

	const isSubagent = isSubagentVariant(narrator.variant);
	const children = isSubagent ? [] : await loadSubagents(narratorId);
	if (children.length > SESSION_EXPORT_MAX_SUBAGENTS) {
		warnings.add(
			"missing_subagent",
			"subagent limit reached",
			children.length - SESSION_EXPORT_MAX_SUBAGENTS,
		);
		children.length = SESSION_EXPORT_MAX_SUBAGENTS;
	}
	for (const child of children) ctx.subagentByToolUseId.set(child.toolUseId, child.id);

	const messages = await readTopLevel(narratorId, ctx);

	// A child whose spawning call never made it into the exported transcript (an
	// unfinished call, or history outside this narrator's scope) has nothing to
	// attach to; exporting it would produce an orphan sidechain.
	const referenced = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.blocks) {
			if (block.type === "tool_use" && block.subagentRef) referenced.add(block.subagentRef);
		}
	}

	const subagents: InterchangeSubagent[] = [];
	for (const child of children) {
		if (!referenced.has(child.id)) {
			warnings.add("missing_subagent", child.id);
			continue;
		}
		const childMessages = await readTopLevel(child.id, {
			...ctx,
			subagentByToolUseId: new Map(),
		});
		if (childMessages.length === 0) continue;
		subagents.push({
			ref: child.id,
			parentToolUseId: child.toolUseId,
			subagentType: getSubagentType(child.variant) ?? undefined,
			...(child.title ? { title: child.title } : {}),
			messages: childMessages,
		});
	}

	if (!messages.some((m) => m.role === "user" || m.role === "assistant")) {
		throw new ValidationError("Narrator has no conversation to export");
	}

	return {
		source: "narrafork",
		externalId: narrator.id,
		...(narrator.title ? { title: narrator.title } : {}),
		...(narrator.cwd ? { cwd: narrator.cwd } : {}),
		...(narrator.model ? { model: narrator.model } : {}),
		createdAt: narrator.createdAt,
		updatedAt: narrator.updatedAt,
		messages,
		subagents,
		warnings: warnings.list(),
	};
}

// ── Writing ────────────────────────────────────────────────────────────────

function hex(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

function resolveCwd(session: InterchangeSession, options: SessionExportOptions): string {
	const cwd = options.cwd?.trim() || session.cwd?.trim();
	if (!cwd) {
		throw new ValidationError("A working directory is required to export this session");
	}
	return cwd;
}

function quoteArg(value: string): string {
	return /^[A-Za-z0-9._\-/:@]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function mergeWarnings(...lists: InterchangeWarning[][]): InterchangeWarning[] {
	const collector = new WarningCollector();
	for (const list of lists) collector.merge(list);
	return collector.list();
}

export function serializeForClaudeCode(
	session: InterchangeSession,
	options: SessionExportOptions,
): SessionExportResult {
	const cwd = resolveCwd(session, options);
	const sessionId = randomUUID();
	const serialized = serializeClaudeCodeSession(session, {
		sessionId,
		cwd,
		newUuid: () => randomUUID(),
		newAgentId: () => newClaudeCodeAgentId(hex),
		dropAllReasoning: options.dropAllReasoning,
		defaultModel: session.model,
	});
	const layout = claudeCodeSessionLayout(cwd, sessionId, defaultClaudeCodePathHash);
	const files: SessionExportFile[] = [
		{
			relativePath: layout.transcript,
			content: `${serialized.lines.join("\n")}\n`,
			mode: "create",
		},
	];
	for (const sub of serialized.subagents) {
		const names = claudeCodeSubagentFileNames(sub.agentId);
		files.push({
			relativePath: [...layout.subagentsDir, names.transcript],
			content: `${sub.lines.join("\n")}\n`,
			mode: "create",
		});
		files.push({
			relativePath: [...layout.subagentsDir, names.meta],
			content: sub.meta,
			mode: "create",
		});
	}
	return {
		format: "claude-code",
		sessionId,
		cwd,
		title: session.title,
		files,
		resumeCommand: `cd ${quoteArg(cwd)} && claude --resume ${sessionId}`,
		warnings: mergeWarnings(session.warnings, serialized.warnings),
	};
}

export function serializeForCodex(
	session: InterchangeSession,
	options: SessionExportOptions,
	now: Date = new Date(),
): SessionExportResult {
	const cwd = resolveCwd(session, options);
	const newId = () => newUuidV7(Date.now(), (count) => new Uint8Array(randomBytes(count)));
	const threadId = newId();
	const serialized = serializeCodexSession(session, {
		threadId,
		cwd,
		modelProvider: options.codexModelProvider?.trim() || "openai",
		newThreadId: newId,
		newTurnId: () => randomUUID(),
	});
	const files: SessionExportFile[] = [];
	for (const thread of [serialized.main, ...serialized.children]) {
		const createdAt = new Date(thread.createdAt);
		const at = Number.isFinite(createdAt.getTime()) ? createdAt : now;
		files.push({
			relativePath: codexRolloutPath(thread.threadId, localDateParts(at)),
			content: `${thread.lines.join("\n")}\n`,
			mode: "create",
		});
	}
	if (serialized.title) {
		files.push({
			relativePath: ["session_index.jsonl"],
			content: `${codexSessionIndexLine(threadId, serialized.title, now)}\n`,
			mode: "append",
		});
	}
	return {
		format: "codex",
		sessionId: threadId,
		cwd,
		title: serialized.title,
		files,
		resumeCommand: `cd ${quoteArg(cwd)} && codex resume ${threadId}`,
		warnings: mergeWarnings(session.warnings, serialized.warnings),
	};
}

/** Read a narrator and serialize it for the requested CLI. Nothing is written. */
export async function exportNarratorSession(
	narratorId: string,
	options: SessionExportOptions,
	signal?: AbortSignal,
): Promise<SessionExportResult> {
	const session = await narratorToInterchange(narratorId, signal);
	return options.format === "claude-code"
		? serializeForClaudeCode(session, options)
		: serializeForCodex(session, options);
}
