import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, narratorToolCalls } from "../db/schema";
import { type AgentConfig, buildHistory, type ToolDefinition } from "../lib/agent";
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	getSubagentType,
	hasTrait,
	isSubagentVariant,
	parseSubstatus,
	parseTraits,
} from "../lib/narrator-utils";
import { getSubagentPrompt, type Locale, type SubagentType } from "../lib/prompt-i18n";
import {
	isAnthropicProvider,
	resolveDefaultReasoningEffort,
	resolveEffectiveModel,
	resolveProvider,
	settings,
	usesCodexApiMode,
} from "../lib/settings";
import type { ImageRef } from "../lib/uploads";
import { generateWordSlug } from "../lib/words";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { type CustomSubagentDef, customSubagentService } from "./custom-subagent-service";
import type { EventHandlerContext, EventHooks } from "./narrator-event-handler";
import { executeAgentLoop } from "./narrator-executor";
import { buildEffectiveSystemPrompt } from "./narrator-prompt";
import {
	getMaxTransientRetries,
	getRetryBackoffCeilMs,
	handleContextOverflow,
	handleTransientError,
	MAX_CONTEXT_OVERFLOW_RETRIES,
} from "./narrator-recovery";
import { narratorService } from "./narrator-service";
import {
	buildContextManagementHooks,
	finalizeOrCleanupPartialMessage,
	getSubagentResultMessageId,
	handlePermission,
	pruneToolCalls,
	toBufferSummary,
} from "./narrator-session";
import {
	deleteConclusionFileId,
	resolveConclusionFilePath,
	setConclusionFileId,
} from "./subagent-conclusion";

// === In-memory state ===
// Use `let` + lazy getter to avoid TDZ issues under Bun --hot reload,
// where a stale dynamic-import resolution can reference the module binding
// before the const initializer has executed.

let _backgroundTaskAbortControllers: Map<string, AbortController> | undefined;
function getBackgroundAbortControllers() {
	if (!_backgroundTaskAbortControllers) _backgroundTaskAbortControllers = new Map();
	return _backgroundTaskAbortControllers;
}

let _foregroundSubagentAbortControllers: Map<string, AbortController> | undefined;
function getForegroundAbortControllers() {
	if (!_foregroundSubagentAbortControllers) _foregroundSubagentAbortControllers = new Map();
	return _foregroundSubagentAbortControllers;
}

interface SubagentBufferedMessage {
	id: string;
	text: string;
	images?: ImageRef[];
	bufferedAt: string;
}

let _subagentBufferedMessages: Map<string, SubagentBufferedMessage[]> | undefined;
function getSubagentBufferedMessagesMap() {
	if (!_subagentBufferedMessages) _subagentBufferedMessages = new Map();
	return _subagentBufferedMessages;
}

// === Manual override state ===
// When a foreground subagent is interrupted, the parent narrator blocks until
// the user explicitly clicks "Update Conclusion" from the subagent page.
// This map is ONLY resolved by the update-conclusion API endpoint, giving
// the user full control over when to return results.

interface ManualOverrideEntry {
	resolve: (result: { finalText: string; hasError: boolean }) => void;
	parentSignal: AbortSignal;
	parentNarratorId: string;
	toolUseId: string;
	/** The subagent ID that was active when manual override started. */
	subagentId: string;
}

let _manualOverrides: Map<string, ManualOverrideEntry> | undefined;
function getManualOverrideMap() {
	if (!_manualOverrides) _manualOverrides = new Map();
	return _manualOverrides;
}

/** Maximum time to wait for manual override before timing out (2 hours). */
const MANUAL_OVERRIDE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Conclusion watchers: for subagents that have already completed (done/error)
 * and whose result was already returned to the parent narrator. When the user
 * later continues operating the subagent and clicks "Update Conclusion",
 * we register a watcher that will update the parent's tool_call outputJson
 * when the subagent next completes.
 */
interface ConclusionWatcher {
	parentNarratorId: string;
	toolUseId: string;
}

let _conclusionWatchers: Map<string, ConclusionWatcher> | undefined;
function getConclusionWatchersMap() {
	if (!_conclusionWatchers) _conclusionWatchers = new Map();
	return _conclusionWatchers;
}

// === ProxyAbortController for detach/attach ===

// === Background task completion notifications for parent agent ===
interface CompletedBgSubagentNotification {
	id: string;
	title: string;
	status: string;
	resultPreview: string;
}

let _bgCompletionQueue: Map<string, CompletedBgSubagentNotification[]> | undefined;
function getBgCompletionQueue() {
	if (!_bgCompletionQueue) _bgCompletionQueue = new Map();
	return _bgCompletionQueue;
}

function pushBgCompletionNotification(
	parentNarratorId: string,
	notification: CompletedBgSubagentNotification,
) {
	const queue = getBgCompletionQueue();
	const list = queue.get(parentNarratorId) ?? [];
	list.push(notification);
	queue.set(parentNarratorId, list);
}

/**
 * Drain completed background subagent notifications for a parent narrator.
 * Used by getInjectedUserText to inform the agent about completed background tasks.
 */
export function drainCompletedBackgroundSubagents(
	parentNarratorId: string,
): CompletedBgSubagentNotification[] {
	const queue = getBgCompletionQueue();
	const list = queue.get(parentNarratorId);
	if (!list || list.length === 0) return [];
	queue.delete(parentNarratorId);
	return list;
}

/**
 * A proxy AbortController that forwards abort signals from one or more sources.
 * The key feature: sources can be swapped at runtime (detach removes parent signal,
 * adds independent background signal) without the consumer (agent loop) noticing.
 */
class ProxyAbortController {
	private _ctrl = new AbortController();
	private _listeners: Array<[AbortSignal, () => void]> = [];

	get signal(): AbortSignal {
		return this._ctrl.signal;
	}

	get aborted(): boolean {
		return this._ctrl.signal.aborted;
	}

	/** Listen to one or more abort signal sources. */
	listenTo(...signals: AbortSignal[]): void {
		for (const s of signals) {
			if (s.aborted) {
				this._ctrl.abort(s.reason);
				return;
			}
			const handler = () => this._ctrl.abort(s.reason);
			s.addEventListener("abort", handler, { once: true });
			this._listeners.push([s, handler]);
		}
	}

	/** Remove listener for a specific signal source. */
	unlisten(signal: AbortSignal): void {
		this._listeners = this._listeners.filter(([s, h]) => {
			if (s === signal) {
				s.removeEventListener("abort", h);
				return false;
			}
			return true;
		});
	}

	/** Replace one signal source with another (used during detach). */
	replaceSource(oldSignal: AbortSignal, newSignal: AbortSignal): void {
		this.unlisten(oldSignal);
		this.listenTo(newSignal);
	}

	abort(reason?: string): void {
		this._ctrl.abort(reason);
	}

	/** Clean up all listeners and reset the internal AbortController. */
	dispose(): void {
		for (const [s, h] of this._listeners) {
			s.removeEventListener("abort", h);
		}
		this._listeners = [];
		// Reset the internal controller so the proxy can be reused after an abort.
		// Without this, once _ctrl is aborted it stays aborted forever and
		// subsequent listenTo() calls hand out a permanently-aborted signal.
		if (this._ctrl.signal.aborted) {
			this._ctrl = new AbortController();
		}
	}
}

// === Detach infrastructure ===

interface DetachEntry {
	/** Called to set the detached flag inside runLoop. */
	markDetached: () => void;
	/** Resolve the foreground Promise (unblocks parent narrator immediately). */
	foregroundResolve: (result: string) => void;
	proxy: ProxyAbortController;
	parentSignal: AbortSignal;
	fgAbort: AbortController;
	toolUseId: string;
	parentNarratorId: string;
	subagentId: string;
}

let _detachableSubagents: Map<string, DetachEntry> | undefined;
function getDetachableMap() {
	if (!_detachableSubagents) _detachableSubagents = new Map();
	return _detachableSubagents;
}

// === Attach infrastructure ===
// When a background task is attached (pulled to foreground), we store a Promise
// that the caller (continueSubagent) can await.

interface AttachEntry {
	promise: Promise<{ finalText: string; hasError: boolean }>;
	resolve: (result: { finalText: string; hasError: boolean }) => void;
}

let _attachWaiters: Map<string, AttachEntry> | undefined;
function getAttachWaitersMap() {
	if (!_attachWaiters) _attachWaiters = new Map();
	return _attachWaiters;
}

// === Background task alias registry ===
// Provides human-readable aliases for background tasks (both Agent and Bash).
// Scoped per parent narrator — aliases are unique within a narrator's session.
// Maps: narratorId → Map<alias, realId> and realId → alias (bidirectional).

interface AliasRegistry {
	aliasToId: Map<string, string>;
	idToAlias: Map<string, string>;
}

let _aliasRegistries: Map<string, AliasRegistry> | undefined;
function getAliasRegistryMap() {
	if (!_aliasRegistries) _aliasRegistries = new Map();
	return _aliasRegistries;
}

function getOrCreateRegistry(narratorId: string): AliasRegistry {
	const map = getAliasRegistryMap();
	let reg = map.get(narratorId);
	if (!reg) {
		reg = { aliasToId: new Map(), idToAlias: new Map() };
		map.set(narratorId, reg);
	}
	return reg;
}

/** Slugify a string for use as an alias. */
function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
}

/**
 * Register a background task alias. If the desired alias is taken,
 * appends an incrementing suffix (-2, -3, ...).
 * Returns the final unique alias and whether a conflict occurred.
 */
export function registerTaskAlias(
	narratorId: string,
	realId: string,
	desiredAlias?: string,
): { alias: string; conflicted: boolean } {
	const reg = getOrCreateRegistry(narratorId);

	// Already registered
	const existing = reg.idToAlias.get(realId);
	if (existing) return { alias: existing, conflicted: false };

	let base = desiredAlias ? slugify(desiredAlias) : slugify(realId);
	if (!base) base = "task";

	let alias = base;
	let suffix = 2;
	let conflicted = false;
	while (reg.aliasToId.has(alias)) {
		alias = `${base}-${suffix}`;
		suffix++;
		conflicted = true;
	}

	reg.aliasToId.set(alias, realId);
	reg.idToAlias.set(realId, alias);
	return { alias, conflicted };
}

/**
 * Resolve an alias or real ID to the actual task/subagent ID.
 * Checks alias registry first, then returns the input as-is (assumed to be a real ID).
 */
export function resolveTaskAlias(narratorId: string, aliasOrId: string): string {
	const reg = getAliasRegistryMap().get(narratorId);
	if (!reg) return aliasOrId;
	return reg.aliasToId.get(aliasOrId) ?? aliasOrId;
}

/** Get the alias for a real ID (if registered). */
export function getTaskAlias(narratorId: string, realId: string): string | undefined {
	return getAliasRegistryMap().get(narratorId)?.idToAlias.get(realId);
}

/** Clean up alias registry for a narrator. */
export function clearAliasRegistry(narratorId: string): void {
	getAliasRegistryMap().delete(narratorId);
}

// === Subagent type definitions ===

// === Team file-change tracking ===
// parentNarratorId → Map<subagentId, Set<filePath>>

let _teamFileChanges: Map<string, Map<string, Set<string>>> | undefined;
function getTeamFileChangesMap() {
	if (!_teamFileChanges) _teamFileChanges = new Map();
	return _teamFileChanges;
}

/** Record a file change made by a subagent (called from Write/Edit tools). */
export function recordTeamFileChange(
	parentNarratorId: string,
	subagentId: string,
	filePath: string,
): void {
	const team = getTeamFileChangesMap();
	let members = team.get(parentNarratorId);
	if (!members) {
		members = new Map();
		team.set(parentNarratorId, members);
	}
	let files = members.get(subagentId);
	if (!files) {
		files = new Set();
		members.set(subagentId, files);
	}
	files.add(filePath);
}

/** Get all file changes for a team (all subagents under a parent narrator). */
export function getTeamFileChanges(parentNarratorId: string): Map<string, Set<string>> {
	return getTeamFileChangesMap().get(parentNarratorId) ?? new Map();
}

/** Clear file change tracking for a team. */
export function clearTeamFileChanges(parentNarratorId: string): void {
	getTeamFileChangesMap().delete(parentNarratorId);
}

// === Team messaging ===

export interface TeamMessage {
	fromId: string;
	fromTitle: string | null;
	fromType: string;
	text: string;
	timestamp: string;
	isBroadcast: boolean;
}

// In-memory only — intentionally not persisted. Subagent lifetimes are short
// (bounded by the parent narrator session) so messages don't need to survive
// server restarts. This avoids DB overhead for ephemeral coordination data.
let _teamInbox: Map<string, TeamMessage[]> | undefined;
function getTeamInboxMap() {
	if (!_teamInbox) _teamInbox = new Map();
	return _teamInbox;
}

/** Deliver a message to a subagent's team inbox, emit event, and broadcast to WebSocket. */
export function deliverTeamMessage(
	targetId: string,
	message: TeamMessage,
	parentNarratorId?: string,
): void {
	const inbox = getTeamInboxMap();
	if (!inbox.has(targetId)) inbox.set(targetId, []);
	inbox.get(targetId)?.push(message);
	if (parentNarratorId) {
		eventBus.emit({
			type: "narrator:team_message",
			narratorId: targetId,
			fromId: message.fromId,
			parentNarratorId,
			text: message.text,
			isBroadcast: message.isBroadcast,
		});
		broadcastToNarrator(targetId, {
			type: "team_message",
			narratorId: targetId,
			fromId: message.fromId,
			fromTitle: message.fromTitle,
			fromType: message.fromType,
			text: message.text,
			isBroadcast: message.isBroadcast,
		});
	}
}

/** Drain all pending team messages for a subagent. */
export function drainTeamInbox(subagentId: string): TeamMessage[] {
	const inbox = getTeamInboxMap();
	const messages = inbox.get(subagentId);
	if (!messages?.length) return [];
	inbox.delete(subagentId);
	return messages;
}

/** Check if a subagent has pending team messages (non-destructive). */
export function hasTeamMessages(subagentId: string): boolean {
	const messages = getTeamInboxMap().get(subagentId);
	return !!messages?.length;
}

/** Clear team inbox for a subagent. */
export function clearTeamInbox(subagentId: string): void {
	getTeamInboxMap().delete(subagentId);
}

/** Tools available to explore/plan subagents (read + search + shell + conclusion file write + todos) */
const EXPLORE_PLAN_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
	SHELL_TOOL_NAME,
	"Write",
	"Edit",
	"TaskCreate",
	"TeamStatus",
]);

/**
 * Per-subagent conclusion file ID map is managed in subagent-conclusion.ts
 * to avoid circular imports with narrator-session.ts.
 */

/** Tools available to general subagents (EXPLORE_PLAN_TOOLS + interactive tools, no nesting/plan/forking) */
const GENERAL_TOOLS = new Set([...EXPLORE_PLAN_TOOLS, "AskUserQuestion", "Skill"]);

/** Tool filter factories per built-in subagent type */
const BUILTIN_TOOL_FILTERS: Record<string, (tool: ToolDefinition) => boolean> = {
	explore: (tool) => EXPLORE_PLAN_TOOLS.has(tool.name),
	plan: (tool) => EXPLORE_PLAN_TOOLS.has(tool.name),
	general: (tool) => GENERAL_TOOLS.has(tool.name),
};

/**
 * Resolve the tool filter for a subagent type.
 * For built-in types, returns the static filter.
 * For custom types, builds a filter based on the custom definition's toolAccess.
 * Accepts an optional pre-loaded customDef to avoid redundant I/O.
 */
function resolveToolFilter(
	subagentType: string,
	customDef?: CustomSubagentDef | null,
): ((tool: ToolDefinition) => boolean) | undefined {
	const builtin = BUILTIN_TOOL_FILTERS[subagentType];
	if (builtin) return builtin;

	if (!customDef) return BUILTIN_TOOL_FILTERS.explore; // fallback: deny write access when definition is missing

	switch (customDef.toolAccess) {
		case "readOnly":
			return BUILTIN_TOOL_FILTERS.explore;
		case "general":
			return BUILTIN_TOOL_FILTERS.general;
		case "custom": {
			const allowed = new Set(customDef.customTools);
			return (tool) => allowed.has(tool.name);
		}
		default:
			return BUILTIN_TOOL_FILTERS.explore;
	}
}

// === Shared helpers ===

/**
 * Build the effective system prompt for a subagent.
 * Optionally injects contextSummary (after compact).
 * Accepts an optional pre-loaded customPrompt to avoid redundant I/O.
 */
async function buildSubagentSystemPrompt(
	subagentType: SubagentType,
	cwd: string,
	locale: Locale,
	contextSummary?: string | null,
	customPrompt?: string | null,
): Promise<string> {
	// Try built-in prompt first
	let basePrompt = getSubagentPrompt(subagentType, locale);

	// If not a built-in type, use the pre-loaded custom prompt or load it
	if (!basePrompt) {
		if (customPrompt !== undefined) {
			basePrompt = customPrompt;
		} else {
			const customDef = await customSubagentService.loadByName(subagentType);
			basePrompt = customDef?.prompt ?? null;
		}
	}

	// Fallback to a generic prompt if nothing found
	if (!basePrompt) {
		basePrompt =
			locale === "zh-CN"
				? "你是一个执行委派任务的子代理。完成任务并简洁地报告结果。"
				: "You are a subagent executing a delegated task. Complete the task and report your results concisely.";
	}

	const { prompt } = await buildEffectiveSystemPrompt({
		basePrompt,
		cwd,
		locale,
		contextSummary,
	});
	return prompt ?? basePrompt;
}

/** Build an EventHandlerContext for a subagent. */
function buildSubagentEventContext(
	subagentId: string,
	parentNarratorId: string,
	parentToolUseId: string,
	conversationId: string,
	subagentModel: string,
): EventHandlerContext {
	let contextUsagePct: number | undefined;
	let meterUsage: number | undefined;
	let meterUnit: string | undefined;
	let partialMessageId: string | undefined;
	let tokenUsage: import("./narrator-event-handler").TokenUsageSnapshot | undefined;

	return {
		narratorId: subagentId,
		broadcastTargetId: parentNarratorId,
		conversationId,
		parentToolUseId,
		subagentModel,
		getContextUsagePct: () => contextUsagePct,
		getMeterUsage: () => meterUsage,
		getMeterUnit: () => meterUnit,
		getPartialMessageId: () => partialMessageId,
		getTokenUsage: () => tokenUsage,
		setPartialMessageId: (id) => {
			partialMessageId = id;
		},
		setContextUsagePct: (pct) => {
			contextUsagePct = pct;
		},
		setMeterData: (u, un) => {
			meterUsage = u;
			meterUnit = un;
		},
		setTokenUsage: (u) => {
			tokenUsage = u;
		},
	};
}

/** Mark subagent as done/error and broadcast completion. */
async function finalizeSubagent(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
	hasError: boolean,
	errorText: string | null,
): Promise<void> {
	// Clean up any remaining buffered messages and team inbox
	getSubagentBufferedMessagesMap().delete(subagentId);
	clearTeamInbox(subagentId);

	// NOTE: file change records are intentionally NOT cleared here.
	// They remain available for sibling subagents to query via TeamStatus.file_changes
	// until the parent narrator session ends (clearTeamFileChanges is called then).

	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			status: "idle",
			substatus: JSON.stringify(hasError ? ["error"] : ["unread"]),
			errorMessage: hasError ? errorText : null,
			updatedAt: now,
		})
		.where(eq(narrators.id, subagentId));

	eventBus.emit({
		type: "narrator:subagent_completed",
		narratorId: subagentId,
		parentNarratorId,
		toolUseId,
	});
}

/** Broadcast subagent_started event. */
function broadcastSubagentStarted(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
	subagentType: string,
	model?: string,
): void {
	eventBus.emit({
		type: "narrator:subagent_started",
		narratorId: subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
	});
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_started",
		narratorId: parentNarratorId,
		subagentNarratorId: subagentId,
		toolUseId,
		subagentType,
		...(model && { model }),
	});
}

/**
 * Load subagent messages and build history.
 * Clears parentToolUseId so buildHistory includes subagent messages.
 */
async function loadSubagentHistory(
	narratorId: string,
	model: string,
	provider: string,
	pruneBoundaryId?: string | null,
) {
	const rawMessages = await narratorService.getMessagesSinceLastCompact(narratorId);
	const dbMessages = rawMessages.map((msg) => ({ ...msg, parentToolUseId: null }));
	if (pruneBoundaryId) {
		pruneToolCalls(dbMessages, pruneBoundaryId);
	}
	return buildHistory(dbMessages, model, provider, narratorId);
}

async function consumeNextBufferedSubagentMessage(opts: {
	narratorId: string;
	parentNarratorId: string;
	toolUseId: string;
	model: string;
	provider: string;
	pruneBoundaryId?: string | null;
}): Promise<{
	prompt: string;
	history: unknown[];
	trailingToolResults: unknown[];
} | null> {
	const { narratorId, parentNarratorId, toolUseId, model, provider } = opts;
	let { pruneBoundaryId } = opts;
	const bufQueue = getSubagentBufferedMessagesMap().get(narratorId);
	const buffered = bufQueue?.[0];
	if (!buffered) return null;
	bufQueue?.shift();
	if (bufQueue?.length === 0) getSubagentBufferedMessagesMap().delete(narratorId);
	const userMsg = await narratorService.persistSubagentUserMessage(
		narratorId,
		buffered.text,
		toolUseId,
		buffered.images,
	);
	broadcastToNarrator(parentNarratorId, {
		type: "user_message",
		narratorId: parentNarratorId,
		message: userMsg,
	});
	broadcastToNarrator(narratorId, {
		type: "user_message",
		narratorId,
		message: { ...userMsg, parentToolUseId: null },
	});
	const remaining = toBufferSummary(getSubagentBufferedMessagesMap().get(narratorId) ?? []);
	broadcastToNarrator(parentNarratorId, {
		type: "buffer_consumed",
		narratorId: parentNarratorId,
		messageId: buffered.id,
		remaining,
	});
	broadcastToNarrator(narratorId, {
		type: "buffer_consumed",
		narratorId,
		messageId: buffered.id,
		remaining,
	});
	if (pruneBoundaryId === undefined) {
		const freshNarrator = await narratorService.getById(narratorId);
		pruneBoundaryId = freshNarrator.pruneBoundaryMessageId ?? null;
	}
	const rebuilt = await loadSubagentHistory(narratorId, model, provider, pruneBoundaryId);
	return {
		prompt: buffered.text,
		history: rebuilt.history,
		trailingToolResults: rebuilt.trailingToolResults,
	};
}

// === Core subagent execution with compact/prune support ===

interface SubagentExecOptions {
	narratorId: string;
	parentNarratorId: string;
	toolUseId: string;
	subagentType: string;
	prompt: string;
	cwd: string;
	model: string;
	provider: string;
	locale: string;
	signal: AbortSignal;
	systemPrompt: string;
	/** Initial history (empty for new subagents, pre-loaded for continued) */
	initialHistory: unknown[];
	initialTrailingToolResults?: unknown[];
	/** Pre-loaded custom subagent definition (avoids redundant I/O) */
	customDef?: CustomSubagentDef | null;
}

/**
 * Execute a subagent with optional compact/prune support.
 *
 * For general subagents: wraps executeAgentLoop in a while-loop that
 * restarts after compact, with prune boundary tracking and onBeforeTurn.
 *
 * For explore/plan subagents: single-pass execution (no compact/prune).
 */
async function executeSubagent(opts: SubagentExecOptions): Promise<{
	finalText: string;
	hasError: boolean;
	contextLengthExceeded?: boolean;
}> {
	let {
		narratorId,
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		model,
		provider,
		locale,
		signal,
	} = opts;

	let {
		systemPrompt,
		initialHistory: history,
		initialTrailingToolResults: trailingToolResults,
	} = opts;

	// Mutable state for compact/prune
	let pruneBoundaryId: string | null = null;
	let needsRestart = false;
	let currentConversationId = randomUUID();
	let contextLengthExceeded = false;
	let overflowRetries = 0;

	// Transient error retry state
	let transientRetries = 0;

	// Conclusion file for explore/plan subagents — Write/Edit are restricted to this file.
	// The file content is read after the loop finishes and used as finalText.
	const isReadOnlySubagent = subagentType === "explore" || subagentType === "plan";
	const conclusionFileId = isReadOnlySubagent ? generateWordSlug() : undefined;
	if (conclusionFileId) {
		setConclusionFileId(narratorId, conclusionFileId);
	}

	// Build context management hooks (prune + compact) for all subagent types
	const ctxMgmt = buildContextManagementHooks({
		narratorId,
		locale: locale as Locale,
		getModel: () => model,
		getProvider: () => provider,
		isSubagent: true,
		getPruneBoundary: () => pruneBoundaryId,
		setPruneBoundary: (id) => {
			pruneBoundaryId = id;
		},
		onCompactDone: () => {
			needsRestart = true;
			currentConversationId = randomUUID();
		},
	});

	let finalText = "";
	let hasError = false;
	const initialNarrator = await narratorService.getById(narratorId);
	let narratorReasoningEffort = initialNarrator.reasoningEffort ?? undefined;
	let narratorFastMode = initialNarrator.fastMode ?? false;

	// Resolve tool filter for this subagent type using pre-loaded customDef
	const toolFilter = resolveToolFilter(subagentType, opts.customDef);

	while (true) {
		const eventContext = buildSubagentEventContext(
			narratorId,
			parentNarratorId,
			toolUseId,
			currentConversationId,
			model,
		);

		const hooks: EventHooks = {
			onContextUsage: ctxMgmt.onContextUsage,
			onTodoWrite: async (todos, todoToolUseId) => {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				await narratorService.updateTodos(narratorId, todos as any[], todoToolUseId);
				// Broadcast to subagent's own subscribers
				broadcastToNarrator(narratorId, {
					type: "todos_updated",
					narratorId,
					// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
					todos: todos as any[],
					toolUseId: todoToolUseId,
				});
				// Also notify parent narrator so SubagentCard can update
				broadcastToNarrator(parentNarratorId, {
					type: "subagent_todos_updated",
					narratorId: parentNarratorId,
					subagentNarratorId: narratorId,
					// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
					todos: todos as any[],
					toolUseId: todoToolUseId,
				});
			},
		};

		const resolvedProvider = resolveProvider(model);
		const resolvedServiceTier =
			narratorFastMode && usesCodexApiMode(resolvedProvider) ? "priority" : undefined;
		const config: AgentConfig = {
			narratorId,
			conversationId: currentConversationId,
			model,
			provider: resolvedProvider,
			cwd,
			systemPrompt,
			locale,
			signal,
			parentNarratorId,
			reasoningEffort: narratorReasoningEffort ?? resolveDefaultReasoningEffort(resolvedProvider),
			serviceTier: resolvedServiceTier,
			maxTransientRetries: getMaxTransientRetries(),
			retryBackoffCeilMs: getRetryBackoffCeilMs(),
			metadata: isAnthropicProvider(resolvedProvider)
				? { user_id: `user_${narratorId}_account__session_${currentConversationId}` }
				: undefined,
			toolFilter,
			permissionHandler: (toolName, permInput, permToolUseId) =>
				handlePermission(
					narratorId,
					signal,
					toolName,
					permInput,
					permToolUseId,
					cwd,
					locale as Locale,
					parentNarratorId,
				),
			onBeforeTurn: ctxMgmt.onBeforeTurn,
			getInjectedUserText: () => {
				// 1. Check for buffered user messages
				const queue = getSubagentBufferedMessagesMap().get(narratorId);
				const buf = queue?.[0];
				let userText: string | null = null;
				if (buf) {
					queue?.shift();
					if (queue?.length === 0) getSubagentBufferedMessagesMap().delete(narratorId);
					// Persist user message in the background (fire-and-forget).
					// The text is injected into the next turn immediately.
					narratorService
						.persistSubagentUserMessage(narratorId, buf.text, toolUseId, buf.images)
						.then((userMsg) => {
							broadcastToNarrator(parentNarratorId, {
								type: "user_message",
								narratorId: parentNarratorId,
								message: userMsg,
							});
							broadcastToNarrator(narratorId, {
								type: "user_message",
								narratorId,
								message: { ...userMsg, parentToolUseId: null },
							});
						})
						.catch((err) => {
							logger.error("Failed to persist injected subagent user message", {
								narratorId,
								error: String(err),
							});
						});
					const remaining = toBufferSummary(getSubagentBufferedMessagesMap().get(narratorId) ?? []);
					broadcastToNarrator(parentNarratorId, {
						type: "buffer_consumed",
						narratorId: parentNarratorId,
						messageId: buf.id,
						remaining,
					});
					broadcastToNarrator(narratorId, {
						type: "buffer_consumed",
						narratorId,
						messageId: buf.id,
						remaining,
					});
					userText = buf.text;
				}

				// 2. Drain team inbox and append as notifications
				const teamMessages = drainTeamInbox(narratorId);
				if (teamMessages.length > 0) {
					const teamBlock = teamMessages
						.map(
							(m) =>
								`[Team ${m.isBroadcast ? "broadcast" : "message"} from ${m.fromTitle ?? m.fromId} (${m.fromType})]: ${m.text}`,
						)
						.join("\n");
					userText = userText ? `${userText}\n\n${teamBlock}` : teamBlock;
				}

				// 3. Background bash tasks are temporarily disabled (circuit breaker)

				return userText;
			},
		};

		needsRestart = false;

		const result = await executeAgentLoop({
			config,
			userText: prompt,
			history,
			trailingToolResults,
			eventContext,
			hooks,
		});

		finalText = result.contextLengthExceeded ? "Error: context length exceeded" : result.finalText;
		hasError = result.hasError;
		if (result.retryableError && !result.hasError) {
			// Don't mark as error yet — try transient retry below
		}

		// --- Context length exceeded: aggressive prune (Codex) then compact/retry ---
		if (result.contextLengthExceeded) {
			if (signal.aborted) {
				hasError = true;
				contextLengthExceeded = true;
				finalText = "Error: context length exceeded";
				break;
			}

			// Finalize or clean up partial message from the failed turn before retry.
			// If tools were already executed, the message is kept so the retry
			// includes them in history.
			const partialId = eventContext.getPartialMessageId();
			if (partialId) {
				await finalizeOrCleanupPartialMessage(partialId, narratorId);
				eventContext.setPartialMessageId(undefined);
			}

			const overflow = await handleContextOverflow({
				narratorId,
				locale: locale as Locale,
				provider: resolvedProvider,
				model,
				overflowRetries,
				maxRetries: MAX_CONTEXT_OVERFLOW_RETRIES,
			});
			overflowRetries = overflow.overflowRetries;

			if (overflow.action === "retry_pruned") {
				pruneBoundaryId = overflow.boundaryMessageId;
				const rebuilt = await loadSubagentHistory(
					narratorId,
					model,
					resolvedProvider,
					pruneBoundaryId,
				);
				history = rebuilt.history;
				trailingToolResults = rebuilt.trailingToolResults;
				transientRetries = 0;
				continue;
			}
			if (overflow.action === "retry_compacted") {
				needsRestart = true;
				currentConversationId = overflow.newConversationId;
				transientRetries = 0;
				// Continue to the restart-after-compact flow below
			} else {
				hasError = true;
				contextLengthExceeded = true;
				finalText = "Error: context length exceeded and compact failed";
				break;
			}
		}

		// --- Transient API error: retry with exponential backoff ---
		if (result.retryableError && !signal.aborted) {
			transientRetries++;
			const { shouldRetry } = await handleTransientError({
				narratorId,
				error: result.retryableError,
				retryCount: transientRetries,
				maxRetries: getMaxTransientRetries(),
				signal,
			});
			if (shouldRetry) {
				// Finalize or clean up partial message from the failed turn.
				// If tools were already executed, the message is kept so the
				// rebuilt history includes them.
				const partialId = eventContext.getPartialMessageId();
				if (partialId) {
					await finalizeOrCleanupPartialMessage(partialId, narratorId);
					eventContext.setPartialMessageId(undefined);
				}
				// Rebuild history from DB so the retry includes any tool calls
				// that were persisted before the API error occurred. Without this,
				// the retry would use stale history and the model would repeat
				// the same tool calls it already executed.
				const rebuilt = await loadSubagentHistory(
					narratorId,
					model,
					resolvedProvider,
					pruneBoundaryId,
				);
				history = rebuilt.history;
				trailingToolResults = rebuilt.trailingToolResults;
				currentConversationId = randomUUID();
				continue;
			}
			// If aborted during backoff sleep, don't mark as error — the
			// caller will handle the abort status.
			if (signal.aborted) {
				break;
			}
			hasError = true;
			finalText = `Error: ${result.retryableError}`;
			break;
		}

		// Reset transient retry counter on success
		transientRetries = 0;

		if (result.silentDisconnect) {
			const partialId = eventContext.getPartialMessageId();
			eventContext.setPartialMessageId(undefined);
			if (partialId) {
				await finalizeOrCleanupPartialMessage(partialId, narratorId);
			}
		}

		// --- Check for buffered user message (sent from subagent page) ---
		if (!signal.aborted && !hasError) {
			const consumedBuffered = await consumeNextBufferedSubagentMessage({
				narratorId,
				parentNarratorId,
				toolUseId,
				model,
				provider: resolveProvider(model),
				pruneBoundaryId,
			});
			if (consumedBuffered) {
				prompt = consumedBuffered.prompt;
				history = consumedBuffered.history;
				trailingToolResults = consumedBuffered.trailingToolResults;
				currentConversationId = randomUUID();
				continue;
			}
		}

		if (!needsRestart || signal.aborted || hasError) break;

		// Compact completed mid-turn — restart with fresh history
		logger.info("Subagent restarting after compact", { narratorId, parentNarratorId });

		// Reload fresh state — compact clears prune boundary
		const freshNarrator = await narratorService.getById(narratorId);
		pruneBoundaryId = freshNarrator.pruneBoundaryMessageId ?? null;
		narratorReasoningEffort = freshNarrator.reasoningEffort ?? undefined;
		narratorFastMode = freshNarrator.fastMode ?? false;

		// Rebuild system prompt with new contextSummary
		systemPrompt = await buildSubagentSystemPrompt(
			subagentType,
			cwd,
			locale as Locale,
			freshNarrator.contextSummary,
		);

		// Reload history from post-compact messages (no prune after compact)
		const rebuilt = await loadSubagentHistory(narratorId, model, resolvedProvider, null);
		history = rebuilt.history;
		trailingToolResults = rebuilt.trailingToolResults;
	}

	// Read conclusion file for explore/plan subagents.
	// If the subagent wrote to the designated conclusion file, use its content as finalText.
	if (conclusionFileId) {
		deleteConclusionFileId(narratorId);
		const conclusionPath = resolveConclusionFilePath(cwd, conclusionFileId);
		try {
			if (existsSync(conclusionPath)) {
				const content = readFileSync(conclusionPath, "utf-8").trim();
				if (content && !hasError) {
					finalText = content;
				}
				// Clean up the temporary conclusion file
				rmSync(conclusionPath, { force: true });
			}
		} catch {
			// Ignore read/cleanup errors
		}
	}

	return { finalText, hasError, contextLengthExceeded };
}

// === Background task management ===

/**
 * Push a user message onto the subagent buffer queue.
 * Returns false if the subagent is not currently running or the queue is full.
 */
export function pushSubagentBufferedMessage(
	subagentId: string,
	text: string,
	images?: ImageRef[],
	position: "front" | "back" = "back",
): { ok: boolean; bufferedAt: string; id: string; full?: boolean } {
	if (!getForegroundAbortControllers().has(subagentId)) {
		return { ok: false, bufferedAt: "", id: "" };
	}
	const queue = getSubagentBufferedMessagesMap().get(subagentId) ?? [];
	if (queue.length >= 50) {
		return { ok: false, bufferedAt: "", id: "", full: true };
	}
	const id = generateShortId();
	const bufferedAt = new Date().toISOString();
	const entry = { id, text, images, bufferedAt };
	if (position === "front") {
		queue.unshift(entry);
	} else {
		queue.push(entry);
	}
	getSubagentBufferedMessagesMap().set(subagentId, queue);
	return { ok: true, bufferedAt, id };
}

/** Clear the entire subagent buffer queue. */
export function clearSubagentBufferedMessages(subagentId: string): void {
	getSubagentBufferedMessagesMap().delete(subagentId);
}

/** Get the full subagent buffer queue (for REST hydration). */
export function getSubagentBufferedMessages(subagentId: string): SubagentBufferedMessage[] {
	return getSubagentBufferedMessagesMap().get(subagentId) ?? [];
}

/**
 * Interrupt a running foreground subagent.
 * Returns true if the subagent was found and aborted.
 */
export function interruptForegroundSubagent(subagentId: string): boolean {
	const ctrl = getForegroundAbortControllers().get(subagentId);
	if (!ctrl) return false;
	ctrl.abort("Interrupted by user");
	return true;
}

// === Detach / Attach ===

/**
 * Detach a foreground subagent to background mode (zero-interrupt).
 * The agent loop continues running; the parent narrator's blocking Promise resolves immediately.
 */
export async function detachSubagent(subagentId: string): Promise<boolean> {
	const entry = getDetachableMap().get(subagentId);
	if (!entry) return false;

	const { proxy, parentSignal, toolUseId, parentNarratorId } = entry;

	// 1. Create independent background AbortController
	const bgAbort = new AbortController();
	getBackgroundAbortControllers().set(subagentId, bgAbort);

	// 2. Swap signal source: remove parent signal, add background signal
	proxy.replaceSource(parentSignal, bgAbort.signal);

	// Also remove the fgAbort listener (it's no longer relevant)
	const fgCtrl = getForegroundAbortControllers().get(subagentId);
	if (fgCtrl) {
		proxy.unlisten(fgCtrl.signal);
		getForegroundAbortControllers().delete(subagentId);
	}

	// 3. Update DB
	const now = new Date().toISOString();
	const subNarrator = await narratorService.getById(subagentId);
	const updatedTraits = [...new Set([...parseTraits(subNarrator.traits), "background"])];
	await db
		.update(narrators)
		.set({
			isBackground: true,
			backgroundStatus: "running",
			traits: updatedTraits,
			updatedAt: now,
		})
		.where(eq(narrators.id, subagentId));

	// 4. Register alias if not already registered (foreground tasks may not have one yet)
	const { alias: detachAlias } = registerTaskAlias(
		entry.parentNarratorId,
		subagentId,
		subNarrator.title ?? undefined,
	);

	// 5. Mark as detached (signals to runForegroundLoop)
	entry.markDetached();
	getDetachableMap().delete(subagentId);

	// 6. Immediately resolve the foreground Promise (unblocks parent narrator)
	// Use raw subagentId in the tag — the Agent tool will replace it with the alias
	const resultPrefix = `<background_task_id>${subagentId}</background_task_id>\n\n`;
	entry.foregroundResolve(
		resultPrefix +
			`Subagent detached to background. Use Agent(resume: "${detachAlias}") to attach and get results.`,
	);

	// 7. Broadcast events
	eventBus.emit({
		type: "narrator:background_task_started",
		narratorId: parentNarratorId,
		parentNarratorId,
		taskNarratorId: subagentId,
		toolUseId,
		subagentType: subNarrator.subagentType ?? "general",
	});
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_detached",
		narratorId: parentNarratorId,
		subagentNarratorId: subagentId,
		toolUseId,
	});

	return true;
}

/**
 * Attach a running background subagent to foreground (blocks until completion).
 * Called from continueSubagent when the target is a running background task.
 * Returns the subagent result string.
 */
export async function attachSubagent(
	subagentId: string,
	parentNarratorId: string,
	_toolUseId: string,
	signal: AbortSignal,
): Promise<string> {
	// 1. Migrate abort controller: background → foreground
	const bgAbort = getBackgroundAbortControllers().get(subagentId);
	if (!bgAbort) {
		throw new ValidationError("Background task abort controller not found");
	}
	getBackgroundAbortControllers().delete(subagentId);
	getForegroundAbortControllers().set(subagentId, bgAbort);

	// 2. Update DB
	const now = new Date().toISOString();
	const subNarrator = await narratorService.getById(subagentId);
	const updatedTraits = parseTraits(subNarrator.traits).filter((t) => t !== "background");
	await db
		.update(narrators)
		.set({
			isBackground: false,
			backgroundStatus: null,
			traits: updatedTraits,
			updatedAt: now,
		})
		.where(eq(narrators.id, subagentId));

	// 3. Create attach waiter — the running loop will resolve this when it completes
	const { promise, resolve } = Promise.withResolvers<{ finalText: string; hasError: boolean }>();
	getAttachWaitersMap().set(subagentId, { promise, resolve });

	// 4. Broadcast
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_attached",
		narratorId: parentNarratorId,
		subagentNarratorId: subagentId,
	});

	// 5. Wait for the loop to complete (or parent abort)
	const abortPromise = new Promise<{ finalText: string; hasError: boolean }>((res) => {
		if (signal.aborted) {
			res({ finalText: "Aborted", hasError: true });
			return;
		}
		const handler = () => res({ finalText: "Aborted", hasError: true });
		signal.addEventListener("abort", handler, { once: true });
		promise.then((result) => {
			signal.removeEventListener("abort", handler);
			res(result);
		});
	});

	const result = await abortPromise;
	getAttachWaitersMap().delete(subagentId);

	const resultPrefix = `<subagent_id>${subagentId}</subagent_id>\n\n`;
	return resultPrefix + (result.finalText || "(no output)");
}

// === Conclusion watcher public API ===

/** Register a watcher for an already-completed subagent's next conclusion. */
export function registerConclusionWatcher(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
): void {
	getConclusionWatchersMap().set(subagentId, { parentNarratorId, toolUseId });
}

/** Remove a conclusion watcher. */
export function removeConclusionWatcher(subagentId: string): boolean {
	return getConclusionWatchersMap().delete(subagentId);
}

/** Get the conclusion watcher for a subagent (if any). */
export function getConclusionWatcher(subagentId: string): ConclusionWatcher | undefined {
	return getConclusionWatchersMap().get(subagentId);
}

// === Manual override public API ===

/** Check if a subagent is in manual override (parent blocked, waiting for update-conclusion). */
export function isManualOverride(subagentId: string): boolean {
	return getManualOverrideMap().has(subagentId);
}

/**
 * Resolve a manual-override subagent's blocked Promise.
 * Called from the update-conclusion API when the user clicks "Update Conclusion".
 */
export function resolveManualOverride(
	subagentId: string,
	finalText: string,
	hasError: boolean,
): boolean {
	const entry = getManualOverrideMap().get(subagentId);
	if (!entry) return false;
	getManualOverrideMap().delete(subagentId);
	entry.resolve({ finalText, hasError });
	return true;
}

/** Abandon a manual-override subagent (e.g. parent interrupted). */
export function abandonManualOverride(subagentId: string): boolean {
	const entry = getManualOverrideMap().get(subagentId);
	if (!entry) return false;
	getManualOverrideMap().delete(subagentId);
	entry.resolve({ finalText: "Manual override abandoned", hasError: true });
	return true;
}

/** Maximum background task execution time (30 minutes). */
const BACKGROUND_TASK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Block until the user clicks "Update Conclusion" (or parent is interrupted / timeout).
 * Used by both runSubagent and continueSubagent when the subagent is interrupted.
 */
function waitForManualOverride(
	subagentId: string,
	parentSignal: AbortSignal,
	parentNarratorId: string,
	toolUseId: string,
): Promise<{ finalText: string; hasError: boolean }> {
	return new Promise<{ finalText: string; hasError: boolean }>((resolve) => {
		// Shared cleanup: clear timeout and remove the abort listener to avoid leaks.
		const cleanup = () => {
			clearTimeout(timeoutId);
			parentSignal.removeEventListener("abort", onParentAbort);
		};

		const timeoutId = setTimeout(() => {
			const entry = getManualOverrideMap().get(subagentId);
			if (entry) {
				getManualOverrideMap().delete(subagentId);
				cleanup();
				resolve({
					finalText: "Manual override timed out after 2 hours",
					hasError: true,
				});
			}
		}, MANUAL_OVERRIDE_TIMEOUT_MS);

		getManualOverrideMap().set(subagentId, {
			resolve: (result) => {
				cleanup();
				resolve(result);
			},
			parentSignal,
			parentNarratorId,
			toolUseId,
			subagentId,
		});

		// If parent narrator is interrupted, abandon the manual override
		const onParentAbort = () => {
			const entry = getManualOverrideMap().get(subagentId);
			if (entry) {
				getManualOverrideMap().delete(subagentId);
				cleanup();
				resolve({
					finalText: "Parent narrator interrupted",
					hasError: true,
				});
			}
		};
		if (parentSignal.aborted) {
			onParentAbort();
		} else {
			parentSignal.addEventListener("abort", onParentAbort, { once: true });
		}
	});
}

/**
 * Execute a background task (fire-and-forget).
 * Updates narrator status and broadcasts events on completion/failure.
 */
async function executeBackgroundTask(opts: SubagentExecOptions): Promise<void> {
	const { narratorId, parentNarratorId, toolUseId } = opts;

	// Set a maximum execution timeout
	const timeoutId = setTimeout(() => {
		const ctrl = getBackgroundAbortControllers().get(narratorId);
		if (ctrl) ctrl.abort("Background task timeout");
	}, BACKGROUND_TASK_TIMEOUT_MS);

	try {
		const result = await executeSubagent(opts);

		const finalText = result.contextLengthExceeded
			? "Error: context length exceeded"
			: result.finalText;
		const hasError = result.hasError || !!result.contextLengthExceeded;

		// Finalize the subagent narrator status
		await finalizeSubagent(
			narratorId,
			parentNarratorId,
			toolUseId,
			hasError,
			hasError ? finalText : null,
		);

		// Update background-specific fields
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({
				backgroundStatus: hasError ? "failed" : "completed",
				backgroundResult: finalText || "(no output)",
				backgroundCompletedAt: now,
				updatedAt: now,
			})
			.where(eq(narrators.id, narratorId));

		if (hasError) {
			eventBus.emit({
				type: "narrator:background_task_failed",
				narratorId: parentNarratorId,
				parentNarratorId,
				taskNarratorId: narratorId,
				toolUseId,
				error: finalText,
			});
			broadcastToNarrator(parentNarratorId, {
				type: "background_task_failed",
				narratorId: parentNarratorId,
				taskNarratorId: narratorId,
				toolUseId,
				error: finalText,
			});
			pushBgCompletionNotification(parentNarratorId, {
				id: narratorId,
				title: (await narratorService.getById(narratorId).catch(() => null))?.title ?? narratorId,
				status: "failed",
				resultPreview: (finalText || "").slice(0, 500),
			});
		} else {
			eventBus.emit({
				type: "narrator:background_task_completed",
				narratorId: parentNarratorId,
				parentNarratorId,
				taskNarratorId: narratorId,
				toolUseId,
				resultPreview: (finalText || "").slice(0, 500),
			});
			broadcastToNarrator(parentNarratorId, {
				type: "background_task_completed",
				narratorId: parentNarratorId,
				taskNarratorId: narratorId,
				toolUseId,
				resultPreview: (finalText || "").slice(0, 500),
			});
		}
	} catch (err) {
		const errorText = err instanceof Error ? err.message : String(err);
		logger.error("Background task execution failed", { narratorId, error: errorText });

		await finalizeSubagent(narratorId, parentNarratorId, toolUseId, true, errorText);

		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({
				backgroundStatus: "failed",
				backgroundResult: errorText,
				backgroundCompletedAt: now,
				updatedAt: now,
			})
			.where(eq(narrators.id, narratorId));

		eventBus.emit({
			type: "narrator:background_task_failed",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			error: errorText,
		});
		broadcastToNarrator(parentNarratorId, {
			type: "background_task_failed",
			narratorId: parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			error: errorText,
		});
	} finally {
		clearTimeout(timeoutId);
		getBackgroundAbortControllers().delete(narratorId);

		// Resolve attach waiter if any (Agent(resume) on a run_in_background task)
		const attachWaiter = getAttachWaitersMap().get(narratorId);
		if (attachWaiter) {
			// Determine final result — on success path use the outer scope vars,
			// on catch path the DB was already updated so read from there.
			const nar = await narratorService.getById(narratorId).catch(() => null);
			const status = nar?.backgroundStatus ?? "failed";
			const result = nar?.backgroundResult ?? "(no output)";
			attachWaiter.resolve({
				finalText: result,
				hasError: status === "failed",
			});
			getAttachWaitersMap().delete(narratorId);
		}
	}
}

/**
 * Cancel a running background task.
 * Returns true if the task was found and cancelled.
 */
export async function cancelBackgroundTask(taskNarratorId: string): Promise<boolean> {
	const ctrl = getBackgroundAbortControllers().get(taskNarratorId);
	if (!ctrl) return false;

	ctrl.abort("Cancelled by user");

	const narrator = await narratorService.getById(taskNarratorId);
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			backgroundStatus: "cancelled",
			backgroundCompletedAt: now,
			status: "idle",
			substatus: JSON.stringify(["interrupted"]),
			updatedAt: now,
		})
		.where(eq(narrators.id, taskNarratorId));

	const parentNarratorId = narrator.parentNarratorId;
	if (parentNarratorId) {
		eventBus.emit({
			type: "narrator:background_task_cancelled",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId,
			toolUseId: "",
		});
		broadcastToNarrator(parentNarratorId, {
			type: "background_task_cancelled",
			narratorId: parentNarratorId,
			taskNarratorId,
			toolUseId: "",
		});
	}

	getBackgroundAbortControllers().delete(taskNarratorId);
	return true;
}

/**
 * Get the status of a background task.
 */
export async function getBackgroundTaskStatus(taskNarratorId: string): Promise<{
	status: string;
	result: string | null;
	completedAt: string | null;
	isRunning: boolean;
} | null> {
	const narrator = await narratorService.getById(taskNarratorId);
	if (!hasTrait(parseTraits(narrator.traits), "background")) return null;

	return {
		status: narrator.backgroundStatus ?? "unknown",
		result: narrator.backgroundResult ?? null,
		completedAt: narrator.backgroundCompletedAt ?? null,
		isRunning: getBackgroundAbortControllers().has(taskNarratorId),
	};
}

/**
 * Wait for a background task to complete (with timeout).
 * Returns the task status when done or when timeout expires.
 */
export function waitForBackgroundTask(
	taskNarratorId: string,
	timeoutMs = 30000,
): Promise<{ status: string; result: string | null }> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			cleanup();
			resolve({ status: "running", result: null });
		}, timeoutMs);

		const WATCHED_EVENTS = new Set([
			"narrator:background_task_completed",
			"narrator:background_task_failed",
			"narrator:background_task_cancelled",
		]);

		const handler = (event: import("../lib/event-bus").NarraForkEvent) => {
			if (!WATCHED_EVENTS.has(event.type)) return;
			if (!("taskNarratorId" in event) || event.taskNarratorId !== taskNarratorId) return;
			cleanup();
			getBackgroundTaskStatus(taskNarratorId).then((s) => {
				resolve({ status: s?.status ?? "unknown", result: s?.result ?? null });
			});
		};

		const cleanup = () => {
			clearTimeout(timeout);
			eventBus.offAny(handler);
		};

		// Check if already completed
		getBackgroundTaskStatus(taskNarratorId).then((s) => {
			if (s && s.status !== "running") {
				cleanup();
				resolve({ status: s.status, result: s.result });
				return;
			}
			eventBus.onAny(handler);
		});
	});
}

// === Foreground subagent execution loop ===

interface ForegroundLoopInput {
	subagentId: string;
	parentNarratorId: string;
	toolUseId: string;
	subagentType: string;
	prompt: string;
	cwd: string;
	model: string;
	provider: string;
	locale: string;
	signal: AbortSignal;
	systemPrompt: string;
	initialHistory: unknown[];
	initialTrailingToolResults?: unknown[];
	customDef: Awaited<ReturnType<typeof customSubagentService.loadByName>> | null;
}

/**
 * Shared foreground execution loop for both runSubagent and continueSubagent.
 * Handles the while-loop, buffered message consumption, and manual override.
 * Returns the subagent_id-prefixed result string.
 */
async function runForegroundLoop(input: ForegroundLoopInput): Promise<string> {
	const {
		subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		cwd,
		model,
		provider,
		locale,
		signal,
		systemPrompt,
		customDef,
	} = input;

	let finalText = "";
	let hasError = false;
	let currentPrompt = input.prompt;
	let currentHistory: unknown[] = input.initialHistory;
	let currentTrailingToolResults: unknown[] | undefined = input.initialTrailingToolResults;

	// Wrap in a Promise so detach can resolve it early
	const { promise: foregroundPromise, resolve: foregroundResolve } =
		Promise.withResolvers<string>();

	// Track whether we've been detached (set by detachSubagent)
	let detached = false;

	const runLoop = async () => {
		const proxy = new ProxyAbortController();

		try {
			// Register detach entry so the API can detach this subagent
			getDetachableMap().set(subagentId, {
				markDetached: () => {
					detached = true;
				},
				foregroundResolve,
				proxy,
				parentSignal: signal,
				fgAbort: new AbortController(), // placeholder, updated in loop
				toolUseId,
				parentNarratorId,
				subagentId,
			});

			while (true) {
				const fgAbort = new AbortController();
				getForegroundAbortControllers().set(subagentId, fgAbort);

				// Update detach entry's fgAbort reference
				const detachEntry = getDetachableMap().get(subagentId);
				if (detachEntry) detachEntry.fgAbort = fgAbort;

				// Use proxy instead of AbortSignal.any
				proxy.dispose();
				proxy.listenTo(signal, fgAbort.signal);

				const result = await executeSubagent({
					narratorId: subagentId,
					parentNarratorId,
					toolUseId,
					subagentType,
					prompt: currentPrompt,
					cwd,
					model,
					provider,
					locale,
					signal: proxy.signal,
					systemPrompt,
					initialHistory: currentHistory,
					initialTrailingToolResults: currentTrailingToolResults,
					customDef,
				});
				finalText = result.contextLengthExceeded
					? "Error: context length exceeded"
					: result.finalText;
				hasError = result.hasError || !!result.contextLengthExceeded;
				getForegroundAbortControllers().delete(subagentId);

				// Check if we were detached during execution
				if (detached) {
					// Loop continues running in background mode.
					// foregroundResolve was already called by detachSubagent().
					// Continue to finally block for background completion.
					break;
				}

				const continueAfterInterrupt =
					!hasError &&
					fgAbort.signal.aborted &&
					!signal.aborted &&
					(await consumeNextBufferedSubagentMessage({
						narratorId: subagentId,
						parentNarratorId,
						toolUseId,
						model,
						provider: resolveProvider(model),
					}));
				if (continueAfterInterrupt) {
					currentPrompt = continueAfterInterrupt.prompt;
					currentHistory = continueAfterInterrupt.history;
					currentTrailingToolResults = continueAfterInterrupt.trailingToolResults;
					finalText = "";
					continue;
				}
				// Detect subagent-only interrupt (not parent abort)
				if (!hasError && fgAbort.signal.aborted && !signal.aborted) {
					// --- Manual override: block until user clicks "Update Conclusion" ---
					await narratorService.updateStatus(subagentId, "idle", {
						substatus: ["manual_override"],
					});
					broadcastToNarrator(parentNarratorId, {
						type: "subagent_suspended",
						narratorId: parentNarratorId,
						subagentNarratorId: subagentId,
						toolUseId,
					});
					broadcastToNarrator(subagentId, {
						type: "status_change",
						narratorId: subagentId,
						status: "idle",
						substatus: ["manual_override"],
					});

					const overrideResult = await waitForManualOverride(
						subagentId,
						signal,
						parentNarratorId,
						toolUseId,
					);

					finalText = overrideResult.finalText;
					hasError = overrideResult.hasError;
				}
				break;
			}
		} finally {
			getDetachableMap().delete(subagentId);
			proxy.dispose();
			getManualOverrideMap().delete(subagentId);
			getForegroundAbortControllers().delete(subagentId);

			try {
				await finalizeSubagent(
					subagentId,
					parentNarratorId,
					toolUseId,
					hasError,
					hasError ? finalText : null,
				);

				// Bind the result to the subagent's last assistant message
				const resultMsgId = await getSubagentResultMessageId(subagentId);
				if (resultMsgId) {
					await db
						.update(narratorToolCalls)
						.set({ resultMessageId: resultMsgId })
						.where(eq(narratorToolCalls.toolUseId, toolUseId));
				}
			} catch {
				// Non-critical — don't fail the whole flow
			}

			if (detached) {
				// Background completion path: update backgroundStatus/backgroundResult
				// and broadcast completion event (mirrors executeBackgroundTask behavior)
				const now = new Date().toISOString();
				try {
					await db
						.update(narrators)
						.set({
							backgroundStatus: hasError ? "failed" : "completed",
							backgroundResult: finalText || "(no output)",
							backgroundCompletedAt: now,
							updatedAt: now,
						})
						.where(eq(narrators.id, subagentId));

					if (hasError) {
						eventBus.emit({
							type: "narrator:background_task_failed",
							narratorId: parentNarratorId,
							parentNarratorId,
							taskNarratorId: subagentId,
							toolUseId,
							error: finalText,
						});
						broadcastToNarrator(parentNarratorId, {
							type: "background_task_failed",
							narratorId: parentNarratorId,
							taskNarratorId: subagentId,
							toolUseId,
							error: finalText,
						});
						pushBgCompletionNotification(parentNarratorId, {
							id: subagentId,
							title:
								(await narratorService.getById(subagentId).catch(() => null))?.title ?? subagentId,
							status: "failed",
							resultPreview: (finalText || "").slice(0, 500),
						});
					} else {
						eventBus.emit({
							type: "narrator:background_task_completed",
							narratorId: parentNarratorId,
							parentNarratorId,
							taskNarratorId: subagentId,
							toolUseId,
							resultPreview: (finalText || "").slice(0, 500),
						});
						broadcastToNarrator(parentNarratorId, {
							type: "background_task_completed",
							narratorId: parentNarratorId,
							taskNarratorId: subagentId,
							toolUseId,
							resultPreview: (finalText || "").slice(0, 500),
						});
						pushBgCompletionNotification(parentNarratorId, {
							id: subagentId,
							title:
								(await narratorService.getById(subagentId).catch(() => null))?.title ?? subagentId,
							status: "completed",
							resultPreview: (finalText || "").slice(0, 500),
						});
					}
				} catch {
					// Non-critical
				}

				// Notify attach waiter if any (background → foreground transition)
				const attachWaiter = getAttachWaitersMap().get(subagentId);
				if (attachWaiter) {
					attachWaiter.resolve({ finalText, hasError });
					getAttachWaitersMap().delete(subagentId);
				}

				// Clean up team tracking
				clearTeamInbox(subagentId);
			} else {
				// Normal foreground completion
				const resultPrefix = `<subagent_id>${subagentId}</subagent_id>\n\n`;
				foregroundResolve(resultPrefix + (finalText || "(no output)"));
			}
		}
	};

	// Start the loop (don't await — foregroundPromise is resolved when done or detached).
	// Note: foregroundResolve may be called from multiple paths (detach, normal completion,
	// error catch below), but Promise.resolve is idempotent — only the first call takes effect.
	runLoop().catch((err) => {
		foregroundResolve(
			`<subagent_id>${subagentId}</subagent_id>\n\nSubagent error: ${err instanceof Error ? err.message : String(err)}`,
		);
	});

	return foregroundPromise;
}

// === Subagent runner ===

export interface RunSubagentInput {
	parentNarratorId: string;
	toolUseId: string;
	subagentType: string;
	prompt: string;
	cwd: string;
	title?: string;
	signal: AbortSignal;
	locale: string;
	model?: string;
	background?: boolean;
}

/**
 * Run a subagent synchronously (from the parent narrator's perspective),
 * or in background mode (fire-and-forget, returns immediately with a task ID).
 *
 * Creates a subagent narrator, runs the agent loop, persists all messages,
 * and returns the final text result.
 */
export async function runSubagent(input: RunSubagentInput): Promise<string> {
	const {
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		title,
		signal,
		locale,
		model: explicitModel,
		background,
	} = input;

	// Load custom subagent definition once for non-builtin types
	const isBuiltin =
		subagentType === "explore" || subagentType === "plan" || subagentType === "general";
	const customDef = isBuiltin ? null : await customSubagentService.loadByName(subagentType);

	const systemPrompt = await buildSubagentSystemPrompt(
		subagentType,
		cwd,
		locale as Locale,
		undefined,
		customDef?.prompt,
	);

	// Resolve model: explicit param > per-type setting / custom default > parent model > global default
	let subagentPref: string | undefined;
	if (subagentType === "explore" || subagentType === "plan") {
		subagentPref = settings.agent.subagentModels?.[subagentType] || undefined;
	} else if (customDef) {
		subagentPref = customDef.defaultModel || undefined;
	}

	// Apply per-type subagent allowed-model pool restriction.
	// When the pool is non-empty, only models in the pool may be used.
	// Walk the priority chain and pick the first allowed candidate.
	// Note: "review" and custom subagent types fall back to the "general" pool
	// since they don't have dedicated pool configurations.
	const poolKey =
		subagentType === "explore" || subagentType === "plan" || subagentType === "general"
			? subagentType
			: "general";
	const allowedPool = settings.agent.subagentAllowedModels?.[poolKey] ?? [];
	let resolvedModelInput: string | undefined;
	if (allowedPool.length > 0) {
		// Resolve sentinel values in the pool (e.g. "__default__" or bare "default")
		// to the actual default model so they can match real candidate model IDs.
		const poolSet = new Set(
			allowedPool.map((m) => resolveEffectiveModel(m === "default" ? null : m)),
		);
		const parent = await narratorService.getById(parentNarratorId);
		// Resolve __default__ sentinel to the actual default model so it can match the pool.
		const parentModel = parent.model ? resolveEffectiveModel(parent.model) : undefined;
		const candidates = [
			explicitModel,
			subagentPref,
			parentModel,
			settings.agent.defaultModel,
		].filter((m): m is string => !!m);
		resolvedModelInput = candidates.find((m) => poolSet.has(m));
		if (!resolvedModelInput) {
			throw new ValidationError(
				`No candidate model is in the allowed pool for "${poolKey}" subagents. ` +
					`Allowed models: ${[...poolSet].join(", ")}. ` +
					`Please specify one of these models explicitly.`,
			);
		}
	} else {
		resolvedModelInput = explicitModel || subagentPref || undefined;
	}

	// 1. Create subagent narrator
	const subagent = await narratorService.createSubagent({
		parentNarratorId,
		subagentType,
		title,
		cwd,
		systemPrompt,
		model: resolvedModelInput,
	});

	const subagentId = subagent.id;
	const model = subagent.model ?? settings.agent.defaultModel;
	const provider = resolveProvider(model);

	// 2. Persist subagent's user message (linked to parent's tool_use)
	await narratorService.persistSubagentUserMessage(subagentId, prompt, toolUseId);

	// Broadcast subagent_started after persist so the frontend only sees it
	// when the subagent record is fully consistent (narrator + user message).
	broadcastSubagentStarted(subagentId, parentNarratorId, toolUseId, subagentType, model);

	if (background) {
		// --- Background mode: fire-and-forget ---

		// Mark narrator and tool_call as background
		const now = new Date().toISOString();
		const subNarrator = await narratorService.getById(subagentId);
		const updatedTraits = [...new Set([...parseTraits(subNarrator.traits), "background"])];
		await db
			.update(narrators)
			.set({
				isBackground: true,
				backgroundStatus: "running",
				traits: updatedTraits,
				updatedAt: now,
			})
			.where(eq(narrators.id, subagentId));
		eventBus.emit({
			type: "narrator:background_task_started",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId: subagentId,
			toolUseId,
			subagentType,
		});
		broadcastToNarrator(parentNarratorId, {
			type: "background_task_started",
			narratorId: parentNarratorId,
			taskNarratorId: subagentId,
			toolUseId,
			subagentType,
		});

		// Create an independent AbortController for the background task
		// (parent's signal should not cancel background tasks)
		const bgAbort = new AbortController();

		// Store the abort controller for later cancellation
		getBackgroundAbortControllers().set(subagentId, bgAbort);

		// Fire-and-forget execution
		executeBackgroundTask({
			narratorId: subagentId,
			parentNarratorId,
			toolUseId,
			subagentType,
			prompt,
			cwd,
			model,
			provider,
			locale,
			signal: bgAbort.signal,
			systemPrompt,
			initialHistory: [],
			customDef,
		}).catch((err) => {
			logger.error("Background task unexpected error", {
				subagentId,
				error: err instanceof Error ? err.message : String(err),
			});
		});

		const resultPrefix = `<background_task_id>${subagentId}</background_task_id>\n\n`;
		return (
			resultPrefix +
			"Background task started. Use Agent(resume) with this ID to attach and get results."
		);
	}

	// --- Foreground mode ---

	return runForegroundLoop({
		subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		model,
		provider,
		locale,
		signal,
		systemPrompt,
		initialHistory: [],
		customDef,
	});
}

// === Continue subagent ===

export interface ContinueSubagentInput {
	subagentId: string;
	parentNarratorId: string;
	toolUseId: string;
	prompt?: string;
	signal: AbortSignal;
	locale: string;
}

/**
 * Continue a previously completed/errored subagent in-place.
 *
 * Instead of forking, we directly resume the original subagent narrator:
 * persist a new user message (with the ContinueTask's toolUseId as
 * parentToolUseId), reload the full history, and run the agent loop.
 * The subagent keeps its single narrator record and accumulates a
 * continuous conversation visible on the subagent page.
 */
export async function continueSubagent(input: ContinueSubagentInput): Promise<string> {
	const { subagentId, parentNarratorId, toolUseId, prompt, signal, locale } = input;

	// 1. Validate original subagent
	const original = await narratorService.getById(subagentId);
	if (!isSubagentVariant(original.variant)) {
		throw new ValidationError("Target narrator is not a subagent");
	}
	if (original.parentNarratorId !== parentNarratorId) {
		throw new ValidationError("Subagent does not belong to the calling narrator");
	}

	// --- Attach path: resume a RUNNING background task (pull to foreground) ---
	if (original.isBackground && original.backgroundStatus === "running") {
		return attachSubagent(subagentId, parentNarratorId, toolUseId, signal);
	}

	// --- Return completed background task result directly ---
	if (
		original.isBackground &&
		(original.backgroundStatus === "completed" || original.backgroundStatus === "failed")
	) {
		const resultPrefix = `<subagent_id>${subagentId}</subagent_id>\n\n`;
		return resultPrefix + (original.backgroundResult ?? "(no output)");
	}

	// --- Standard continue path: idle subagent ---
	if (!prompt) {
		throw new ValidationError("prompt is required to continue an idle subagent");
	}
	const origSubstatus = parseSubstatus(original.substatus);
	if (
		!(
			original.status === "idle" &&
			(origSubstatus.includes("unread") || origSubstatus.includes("error"))
		)
	) {
		throw new ValidationError(`Cannot continue subagent in status "${original.status}"`);
	}

	const subagentType = getSubagentType(original.variant) ?? original.subagentType ?? "general";
	const model = original.model ?? settings.agent.defaultModel;
	const provider = resolveProvider(model);
	const cwd = original.cwd ?? ".";

	// Load custom subagent definition once for non-builtin types
	const isBuiltinContinue =
		subagentType === "explore" || subagentType === "plan" || subagentType === "general";
	const customDef = isBuiltinContinue ? null : await customSubagentService.loadByName(subagentType);

	// 2. Mark subagent as working (in-place, no fork)
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({ status: "working", substatus: "[]", errorMessage: null, updatedAt: now })
		.where(eq(narrators.id, subagentId));

	// 3. Broadcast subagent_started (same subagentId)
	broadcastSubagentStarted(subagentId, parentNarratorId, toolUseId, subagentType, model);

	// 4. Persist new user message with ContinueTask's toolUseId
	await narratorService.persistSubagentUserMessage(subagentId, prompt, toolUseId);

	// 5. Load full subagent history (all previous rounds included)
	const { history, trailingToolResults } = await loadSubagentHistory(subagentId, model, provider);

	// 6. Run via shared foreground loop (same subagentId)
	return runForegroundLoop({
		subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		model,
		provider,
		locale,
		signal,
		systemPrompt: original.systemPrompt ?? "",
		initialHistory: history,
		initialTrailingToolResults: trailingToolResults,
		customDef,
	});
}
