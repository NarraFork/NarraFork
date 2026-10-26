/**
 * Prefix-preserving optional tool loading.
 *
 * `/load` used to change the request's `tools` array. Tools sit at the very front of
 * every provider's cached prefix, so each load invalidated the whole conversation's
 * prompt cache. Within one context epoch (everything after the latest compact
 * boundary) the array now stays fixed: it carries the optional tools that were
 * loaded when the visible history starts, and tools loaded inside that history are
 * delivered at the load's own position, in whatever form the target protocol offers:
 *
 *   - `anthropic_tool_addition` — a mid-conversation `role:"system"` message with a
 *     `tool_addition` block that defines the tool by value (`inline-tools` beta).
 *   - `anthropic_deferred_tail` — the definition is appended to the end of `tools`
 *     with `defer_loading`, and a `tool_addition` block names it by reference.
 *   - `openai_additional_tools` — an `additional_tools` input item (Responses API).
 *   - `kimi_system_tools` — a mid-conversation `role:"system"` message whose `tools`
 *     field defines the tool by value (Kimi Chat Completions).
 *   - `custom_injection` — the JSON schema is written into the load notice itself,
 *     for endpoints that do not validate tool names against the declared list.
 *
 * Everything else (`replace_tools`) keeps the old behaviour: the array follows the
 * loaded set and the cache is lost. A new epoch (a compact, or an epoch marker row the
 * runtime writes when the target changes or the cache has gone cold) folds the loads
 * before it into the array.
 *
 * An epoch that recorded its loaded set (`ToolLoadingEpoch`) fixes the array's share for
 * its whole length; a change that bypassed `/load` is reconciled into the history as a
 * notice row instead (docs/BLOCK_STORAGE-DESIGN.md §7.7). Without one, the share is
 * derived backwards from the current set.
 *
 * Unloading never shrinks the array within an epoch; the executor rejects a call to
 * an unloaded tool instead, and the Anthropic modes also send a `tool_removal` block.
 */

import type { DbMessage } from "@shared/agent-protocol/types";
import { parseModelId } from "@shared/model-id";
import {
	bareModelForEffort,
	claudeVersionAtLeast,
	parseClaudeModel,
} from "@shared/reasoning-effort-support";
import { getBuiltinToolNames, getBuiltinToolRoutines } from "../builtin-routines";
import type { ModelProtocol } from "../settings/types";
import type { ProviderAdapter } from "./provider";
import { effectiveModelProfile } from "./provider-model-metadata";
import { resolveToolJsonSchema, toolRegistry } from "./tool-registry";
import type { ResolvedToolDefinition, ToolDefinition } from "./types";

export const TOOL_LOADING_MODES = [
	"anthropic_tool_addition",
	"anthropic_deferred_tail",
	"openai_additional_tools",
	"kimi_system_tools",
	"custom_injection",
] as const;

export type ToolLoadingMode = (typeof TOOL_LOADING_MODES)[number];

/** A mode, or the fallback that rewrites `tools` on every change. */
export type ToolLoadingStrategy = ToolLoadingMode | "replace_tools";

/** Modes whose additions travel in the history as a protocol-native item. */
export type NativeToolLoadingMode = Exclude<ToolLoadingMode, "custom_injection">;

/** The wire a request is about to use, as reported by the provider adapter. */
export interface ToolLoadingTarget {
	protocol: ModelProtocol;
	/** The ChatGPT Codex backend, whose `additional_tools` support starts later. */
	codexBackend?: boolean;
	/** Upstream model id when the adapter routes to a different name (gateways). */
	model?: string;
}

/** The protocol each mode needs; `null` works on any protocol. */
const MODE_PROTOCOL: Record<ToolLoadingMode, ModelProtocol | null> = {
	anthropic_tool_addition: "anthropic-messages",
	anthropic_deferred_tail: "anthropic-messages",
	openai_additional_tools: "openai-responses",
	kimi_system_tools: "completions-compatible",
	custom_injection: null,
};

export function isToolLoadingMode(value: unknown): value is ToolLoadingMode {
	return typeof value === "string" && (TOOL_LOADING_MODES as readonly string[]).includes(value);
}

/**
 * Claude models with mid-conversation tool changes: Opus 4.8+, Sonnet and Haiku 5.5+,
 * and every Fable/Mythos. Sonnet 5 is documented as unsupported. An id that does not
 * parse as a versioned Claude is left enabled; the user can turn it off per model.
 */
function claudeSupportsToolChanges(model: string): boolean {
	const parsed = parseClaudeModel(model);
	if (!parsed) return true;
	if (parsed.family === "fable" || parsed.family === "mythos") return true;
	if (parsed.family === "opus") return claudeVersionAtLeast(parsed, 4, 8);
	return claudeVersionAtLeast(parsed, 5, 5);
}

/** `gpt-5.4`, `gpt-6-astra` → [major, minor]; anything else does not parse. */
const GPT_VERSION_PATTERN = /gpt[-_.]?(\d{1,2})(?!\d)(?:[._](\d{1,2})(?!\d))?/i;

/**
 * `additional_tools` arrived with `tool_search`: gpt-5.4 on the OpenAI API, and 5.6 on
 * the Codex backend. An id without a parseable version is left enabled.
 */
function gptSupportsAdditionalTools(model: string, codexBackend: boolean): boolean {
	const match = GPT_VERSION_PATTERN.exec(model);
	if (!match) return true;
	const major = Number(match[1]);
	const minor = match[2] != null ? Number(match[2]) : 0;
	const [floorMajor, floorMinor] = codexBackend ? [5, 6] : [5, 4];
	return major > floorMajor || (major === floorMajor && minor >= floorMinor);
}

/** `kimi-k3`, `kimi-k3.5`, and Kimi Coding's `k3`/`k3-256k` → major. */
const KIMI_VERSION_PATTERN = /(?:^|kimi[-_.]?)k(\d{1,2})(?!\d)/i;

/**
 * Dynamic tool loading (a `system` message carrying `tools`) is reported for Kimi K3 and
 * Kimi Coding's `kimi-for-coding`. K2.x and `kimi-for-coding-highspeed` reject a
 * tool-bearing system message with a 400, so ids that are not known to support it inject.
 */
function kimiSupportsSystemTools(model: string): boolean {
	if (model.includes("highspeed")) return false;
	if (model === "kimi-for-coding") return true;
	const match = KIMI_VERSION_PATTERN.exec(model);
	return !!match && Number(match[1]) >= 3;
}

/**
 * The modes a model gets when its catalog card declares none. Matched on the bare
 * name so the catalog does not have to list every current model.
 */
export function defaultToolLoadingModes(
	model: string,
	target: Pick<ToolLoadingTarget, "codexBackend"> = {},
): ToolLoadingMode[] {
	const bare = bareModelForEffort(model).toLowerCase();
	if (bare.includes("claude"))
		return claudeSupportsToolChanges(bare) ? ["anthropic_tool_addition"] : [];
	// Open-weights gpt-oss runs on third-party servers, not OpenAI's tool_search stack.
	if (bare.includes("gpt") && !bare.includes("gpt-oss"))
		return gptSupportsAdditionalTools(bare, !!target.codexBackend)
			? ["openai_additional_tools"]
			: [];
	if (bare.includes("deepseek")) return ["anthropic_deferred_tail"];
	// Through an Anthropic or Responses relay Kimi has no native form; inject instead.
	if (kimiSupportsSystemTools(bare)) return ["kimi_system_tools", "custom_injection"];
	return ["custom_injection"];
}

/**
 * Pick the strategy for one request.
 *
 * @param declaredModes The card's `tool_loading_modes`: `undefined`/`null` means "not
 *   declared" and falls back to the name defaults; an empty list turns loading
 *   preservation off for the model.
 */
export function resolveToolLoadingStrategy(
	model: string,
	target: ToolLoadingTarget | undefined,
	declaredModes?: readonly string[] | null,
): ToolLoadingStrategy {
	if (!target) return "replace_tools";
	const modes =
		declaredModes == null
			? defaultToolLoadingModes(target.model ?? model, target)
			: declaredModes.filter(isToolLoadingMode);
	for (const mode of modes) {
		const protocol = MODE_PROTOCOL[mode];
		if (protocol === null || protocol === target.protocol) return mode;
	}
	return "replace_tools";
}

/**
 * The strategy for a request sent through `adapter` to `model` (`prefix:id`), honouring
 * the model card's `tool_loading_modes` before the name defaults.
 */
export function resolveAdapterToolLoadingStrategy(
	adapter: Pick<ProviderAdapter, "toolLoadingTarget">,
	model: string,
): ToolLoadingStrategy {
	const target = adapter.toolLoadingTarget?.(model);
	if (!target) return "replace_tools";
	return resolveToolLoadingStrategy(
		parseModelId(model).model,
		target,
		effectiveModelProfile(model).toolLoadingModes,
	);
}

/**
 * A loadable tool as the request's `tools` array would declare it. Only static
 * definitions qualify: a description computed from the loop config could not be
 * reproduced byte-for-byte here.
 */
function staticLoadableToolDefinition(
	tool: ToolDefinition | undefined,
): ResolvedToolDefinition | null {
	if (!tool || (tool.isAvailable && !tool.isAvailable())) return null;
	if (typeof tool.description !== "string" || tool.getRawJsonSchema) return null;
	return { ...tool, description: tool.description };
}

export function resolveLoadableToolDefinition(name: string): ResolvedToolDefinition | null {
	return staticLoadableToolDefinition(toolRegistry.get(name));
}

// === Loading state of one context epoch ===

export interface ToolDefinitionSnapshot {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export function snapshotToolDefinitions(
	names: Iterable<string>,
	candidates?: readonly ToolDefinition[],
): ToolDefinitionSnapshot[] {
	const byName = candidates ? new Map(candidates.map((tool) => [tool.name, tool])) : undefined;
	const snapshots: ToolDefinitionSnapshot[] = [];
	let remaining = 1024 * 1024;
	for (const name of names) {
		if (snapshots.length >= 2048) throw new Error("Tool definition group exceeds 2048 tools");
		// A supplied candidate view is authoritative: a missing name must not leak back
		// into a second registry lookup with potentially different filters or metadata.
		const tool = byName
			? staticLoadableToolDefinition(byName.get(name))
			: resolveLoadableToolDefinition(name);
		if (!tool) continue;
		// The replacer charges a conservative escaped-JSON budget BEFORE each value
		// is serialized. Never clone an entire oversized group and measure afterwards.
		const encoded = JSON.stringify(
			{ name, description: tool.description, parameters: resolveToolJsonSchema(tool) },
			(key, value: unknown) => {
				remaining -= key.length * 6 + 4;
				remaining -=
					typeof value === "string" ? value.length * 6 + 2 : typeof value === "number" ? 32 : 8;
				if (remaining < 0)
					throw new Error("Tool definition group exceeds 1 MiB serialization budget");
				return value;
			},
		);
		snapshots.push(JSON.parse(encoded) as ToolDefinitionSnapshot);
	}
	return snapshots;
}

function snapshotDefinition(snapshot: ToolDefinitionSnapshot): ResolvedToolDefinition {
	return {
		name: snapshot.name,
		description: snapshot.description,
		rawJsonSchema: snapshot.parameters,
	} as ResolvedToolDefinition;
}

function readSnapshots(value: unknown): ToolDefinitionSnapshot[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter(
		(item): item is ToolDefinitionSnapshot =>
			!!item &&
			typeof item.name === "string" &&
			typeof item.description === "string" &&
			!!item.parameters &&
			typeof item.parameters === "object" &&
			!Array.isArray(item.parameters),
	);
}

export interface ToolLoadingEvent {
	kind: "load" | "unload";
	tools: readonly string[];
	definitionSnapshots?: ToolDefinitionSnapshot[];
}

/**
 * Loading state derived from the history a request is built from.
 *
 * `managed` is the set of tools whose presence follows session loading at all; it is
 * empty for sessions whose capability ceiling lists tools explicitly.
 */
export interface ToolLoadingState {
	managed: ReadonlySet<string>;
	/**
	 * The epoch marker row the history's epoch opened at; rows up to and including it
	 * belong to an earlier epoch, whose loads only keep their notice text.
	 */
	epochMarkerId?: string;
	/** Managed tools loaded when the visible history starts: the `tools` array's share. */
	base: ReadonlySet<string>;
	/** Managed tools loaded inside the visible history, in first-load order. */
	loaded: readonly string[];
	/** Managed tools loaded right now. */
	current: ReadonlySet<string>;
	definitionSnapshots?: ToolDefinitionSnapshot[];
}

/** The loaded set an epoch froze when it opened, and where it opened. */
export interface ToolLoadingEpoch {
	/** The marker row inside the history; absent when the epoch opens at its start. */
	markerId?: string;
	/** Optional tools loaded when the epoch opened (any tool; managed ones are kept). */
	toolNames: readonly string[];
	definitionSnapshots?: ToolDefinitionSnapshot[];
	/** The request target the epoch opened for (`resolveEpochTarget`), when recorded. */
	target?: string;
}

/** What an epoch marker records (§7.7); a compact element carries the same as `epoch`. */
export interface EpochRecord {
	reason: "compact" | "target" | "cold" | "manual";
	target?: string;
	toolNames: string[];
	definitionSnapshots?: ToolDefinitionSnapshot[];
}

/** The epoch a stored element opens: a marker `{type:"epoch"}` or a compact with `epoch`. */
export function epochRecordOf(block: unknown): EpochRecord | undefined {
	if (!block || typeof block !== "object") return undefined;
	const record = block as Record<string, unknown>;
	if (record.type !== "epoch" && record.type !== "compact") return undefined;
	const epoch = record.epoch as Record<string, unknown> | undefined;
	if (!epoch || typeof epoch !== "object" || !Array.isArray(epoch.toolNames)) return undefined;
	return {
		reason: (typeof epoch.reason === "string" ? epoch.reason : "manual") as EpochRecord["reason"],
		...(typeof epoch.target === "string" ? { target: epoch.target } : {}),
		toolNames: epoch.toolNames.filter((name): name is string => typeof name === "string"),
		definitionSnapshots: readSnapshots(epoch.definitionSnapshots),
	};
}

/** The latest epoch marker row of a history, if it has one. */
export function latestToolLoadingEpoch(
	messages: readonly DbMessage[],
): ToolLoadingEpoch | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "system" || !Array.isArray(message.contentJson)) continue;
		const epoch = epochRecordOf(message.contentJson[0]);
		if (epoch)
			return {
				markerId: message.id,
				toolNames: epoch.toolNames,
				definitionSnapshots: epoch.definitionSnapshots,
				...(epoch.target ? { target: epoch.target } : {}),
			};
	}
	return undefined;
}

/** Older rows name a routine id; newer rows also carry the expanded `toolNames`. */
function eventToolNames(block: Record<string, unknown>): string[] {
	if (Array.isArray(block.toolNames))
		return block.toolNames.filter((name): name is string => typeof name === "string");
	if (typeof block.toolName !== "string") return [];
	const routine = getBuiltinToolRoutines().find((candidate) => candidate.id === block.toolName);
	return routine?.tool ? getBuiltinToolNames(routine.tool) : [block.toolName];
}

/** The load/unload event a persisted notice row records, limited to managed tools. */
export function toolLoadingEventOf(
	message: DbMessage,
	managed: ReadonlySet<string>,
): ToolLoadingEvent | null {
	if (message.role !== "user" || message.parentToolUseId) return null;
	const block = Array.isArray(message.contentJson) ? message.contentJson[0] : null;
	if (!block || typeof block !== "object") return null;
	const record = block as Record<string, unknown>;
	const kind =
		record.type === "tool_loaded" ? "load" : record.type === "tool_unloaded" ? "unload" : null;
	if (!kind) return null;
	const tools = eventToolNames(record).filter((name) => managed.has(name));
	return tools.length > 0
		? { kind, tools, definitionSnapshots: readSnapshots(record.definitionSnapshots) }
		: null;
}

/** The rows of the current epoch: those after its marker, or all of them. */
function epochRows(messages: readonly DbMessage[], markerId: string | undefined) {
	if (!markerId) return messages;
	const index = messages.findIndex((message) => message.id === markerId);
	return index === -1 ? messages : messages.slice(index + 1);
}

/**
 * The loading state of the history's current epoch.
 *
 * With an epoch that froze its loaded set, that set is the array's share. Without one,
 * the epoch's events are replayed backwards from the current set to find what was
 * loaded when it opened, so loads with no notice row (resident tools, creation-time
 * preloads, fork inheritance) land in `base`.
 */
export function deriveToolLoadingState(
	messages: readonly DbMessage[],
	managed: ReadonlySet<string>,
	current: Iterable<string>,
	epoch?: ToolLoadingEpoch,
): ToolLoadingState {
	const events = epochRows(messages, epoch?.markerId).flatMap(
		(message) => toolLoadingEventOf(message, managed) ?? [],
	);
	const currentSet = new Set([...current].filter((name) => managed.has(name)));
	const base = epoch
		? new Set(epoch.toolNames.filter((name) => managed.has(name)))
		: new Set(currentSet);
	if (!epoch)
		for (let index = events.length - 1; index >= 0; index--) {
			const event = events[index];
			for (const name of event.tools) {
				if (event.kind === "load") base.delete(name);
				else base.add(name);
			}
		}
	const loaded: string[] = [];
	for (const event of events) {
		if (event.kind !== "load") continue;
		for (const name of event.tools) if (!loaded.includes(name)) loaded.push(name);
	}
	return {
		managed,
		...(epoch?.markerId ? { epochMarkerId: epoch.markerId } : {}),
		base,
		loaded,
		current: currentSet,
		definitionSnapshots: [
			...(epoch?.definitionSnapshots ?? []),
			...epochRows(messages, epoch?.markerId).flatMap((message) => {
				const block = Array.isArray(message.contentJson)
					? (message.contentJson[0] as Record<string, unknown>)
					: undefined;
				return message.role === "user" && !message.parentToolUseId && block?.type === "tool_loaded"
					? (readSnapshots(block.definitionSnapshots) ?? [])
					: [];
			}),
		].filter(
			(snapshot, index, all) => all.findIndex((item) => item.name === snapshot.name) === index,
		),
	};
}

/**
 * What the current set says that the epoch's frozen set and its notices do not: tools
 * loaded or unloaded without a notice row. Only meaningful for a frozen epoch; the
 * runtime writes the difference as notices before the request (§7.7).
 */
export function toolLoadingDrift(
	messages: readonly DbMessage[],
	state: ToolLoadingState,
): { loads: string[]; unloads: string[] } {
	const expected = new Set(state.base);
	for (const message of epochRows(messages, state.epochMarkerId)) {
		const event = toolLoadingEventOf(message, state.managed);
		if (!event) continue;
		for (const name of event.tools) {
			if (event.kind === "load") expected.add(name);
			else expected.delete(name);
		}
	}
	return {
		loads: [...state.current].filter((name) => !expected.has(name)).sort(),
		unloads: [...expected].filter((name) => !state.current.has(name)).sort(),
	};
}

/**
 * Whether a state has anything to keep out of the array. A session with no loadable
 * tools (an explicit ceiling, OAuth, subagents) keeps the plain request shape, so it
 * never carries a placeholder tool or a tool-change beta.
 */
export function usesToolLoading(state: ToolLoadingState | undefined): state is ToolLoadingState {
	return !!state && state.managed.size > 0;
}

// === Request tools ===

/**
 * Never-activated deferred tool declared from the first request of an Anthropic-mode
 * epoch. The first tool change otherwise adds hidden prompt scaffolding in front of
 * the conversation and misses the whole cache (measured by pi).
 */
export const DEFERRED_TOOL_PLACEHOLDER = {
	name: "__narrafork_deferred_placeholder__",
	description: "Reserved placeholder. Never available. Never call this.",
	input_schema: { type: "object", properties: {}, required: [] },
	defer_loading: true,
} as const;

/**
 * Split the candidate tools into the request's `tools` array.
 *
 * `candidates` must already be filtered for everything except loading state. Order is
 * preserved, so the array only depends on which managed tools it keeps.
 */
export function selectRequestTools(
	candidates: readonly ResolvedToolDefinition[],
	state: ToolLoadingState | undefined,
	strategy: ToolLoadingStrategy,
): { tools: ResolvedToolDefinition[]; deferred: ResolvedToolDefinition[] } {
	if (!state) return { tools: [...candidates], deferred: [] };
	const keep =
		strategy === "replace_tools"
			? (name: string) => state.current.has(name)
			: (name: string) => state.base.has(name);
	const frozen = new Map(
		state.definitionSnapshots?.map((snapshot) => [snapshot.name, snapshotDefinition(snapshot)]),
	);
	const definitions =
		strategy === "replace_tools"
			? candidates
			: candidates.map((tool) => frozen.get(tool.name) ?? tool);
	const tools = definitions.filter((tool) => !state.managed.has(tool.name) || keep(tool.name));
	if (strategy !== "anthropic_deferred_tail") return { tools, deferred: [] };
	const byName = new Map(definitions.map((tool) => [tool.name, tool]));
	const deferred = state.loaded.flatMap((name) => {
		const tool = byName.get(name);
		return tool && !state.base.has(name) ? [tool] : [];
	});
	return { tools, deferred };
}

/**
 * Assemble the provider-formatted array. The Anthropic modes need at least one active
 * tool to anchor the deferred placeholder; without one they fall back to the plain list.
 */
export function formatRequestTools(
	formatTools: (tools: ResolvedToolDefinition[]) => unknown[],
	candidates: readonly ResolvedToolDefinition[],
	state: ToolLoadingState | undefined,
	strategy: ToolLoadingStrategy,
): unknown[] {
	const { tools, deferred } = selectRequestTools(candidates, state, strategy);
	const formatted = formatTools(tools);
	if (
		(strategy !== "anthropic_tool_addition" && strategy !== "anthropic_deferred_tail") ||
		formatted.length === 0
	)
		return formatted;
	return [
		...formatted,
		{ ...DEFERRED_TOOL_PLACEHOLDER },
		...formatTools(deferred).map((tool) => ({
			...(tool as Record<string, unknown>),
			defer_loading: true,
		})),
	];
}

// === History projection ===

/** A tool surfaced at one history position. `definition` is set when it is defined there. */
export interface ToolLoadingAddition {
	name: string;
	definition?: ResolvedToolDefinition;
}

export interface ToolLoadingChange {
	mode: NativeToolLoadingMode;
	additions: readonly ToolLoadingAddition[];
	removals: readonly string[];
}

/**
 * Changes attached to projected notice rows. Kept beside the row instead of on it so
 * the shared `DbMessage` shape stays a pure storage type.
 */
const toolLoadingChanges = new WeakMap<DbMessage, ToolLoadingChange>();

/** The protocol-native change a history builder emits for this row, if any. */
export function toolLoadingChangeOf(message: DbMessage): ToolLoadingChange | undefined {
	return toolLoadingChanges.get(message);
}

/** Schema text appended to a load notice under `custom_injection`. */
export function renderInjectedToolDefinitions(tools: readonly ResolvedToolDefinition[]): string {
	const lines = tools.map((tool) =>
		JSON.stringify({
			name: tool.name,
			description: tool.description,
			parameters: resolveToolJsonSchema(tool),
		}),
	);
	return [
		"<tool_definitions>",
		...lines,
		"</tool_definitions>",
		"These tools are not in the declared tool list. Call them by name with the usual tool-call format, passing arguments that match each schema.",
	].join("\n");
}

function withNoticeText(message: DbMessage, suffix: string): DbMessage {
	const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
	const head = blocks[0] as Record<string, unknown> | undefined;
	const text =
		typeof head?.text === "string" && head.text ? head.text : (message.contentText ?? "");
	const next = text ? `${text}\n\n${suffix}` : suffix;
	return {
		...message,
		contentJson: [{ ...head, text: next }, ...blocks.slice(1)],
		contentText: next,
	};
}

/**
 * Rewrite the notice rows of a history for one strategy.
 *
 * Returns new row objects only for notices that change; every other row is passed
 * through untouched. `resolveDefinition` must resolve the same definitions the request's
 * `tools` array is formatted from, so a tool reads identically wherever it is declared.
 */
export function projectToolLoadingHistory(
	messages: readonly DbMessage[],
	state: ToolLoadingState,
	strategy: ToolLoadingStrategy,
	resolveDefinition: (name: string) => ResolvedToolDefinition | null,
): DbMessage[] {
	if (strategy === "replace_tools") return [...messages];
	const liveDefinition = resolveDefinition;
	const frozen = new Map(
		state.definitionSnapshots?.map((snapshot) => [snapshot.name, snapshotDefinition(snapshot)]),
	);
	resolveDefinition = (name) => frozen.get(name) ?? liveDefinition(name);
	// Under the additive modes a tool is only ever declared once per epoch. A base tool
	// that no longer resolves is not in the request's array either.
	const declared = new Set([...state.base].filter((name) => resolveDefinition(name)));
	// Loads of an earlier epoch are part of the array now; their notices stay plain text.
	let inEpoch = !state.epochMarkerId || !messages.some((row) => row.id === state.epochMarkerId);
	return messages.map((message) => {
		if (!inEpoch) {
			if (message.id === state.epochMarkerId) inEpoch = true;
			return message;
		}
		const event = toolLoadingEventOf(message, state.managed);
		if (!event) return message;
		if (
			strategy === "custom_injection" ||
			strategy === "openai_additional_tools" ||
			strategy === "kimi_system_tools"
		) {
			if (event.kind !== "load") return message;
			const fresh = event.tools.flatMap((name) => {
				if (declared.has(name)) return [];
				const definition = resolveDefinition(name);
				if (!definition) return [];
				declared.add(name);
				return [definition];
			});
			if (fresh.length === 0) return message;
			if (strategy === "custom_injection")
				return withNoticeText(message, renderInjectedToolDefinitions(fresh));
			const projected = { ...message };
			toolLoadingChanges.set(projected, {
				mode: strategy,
				additions: fresh.map((definition) => ({ name: definition.name, definition })),
				removals: [],
			});
			return projected;
		}
		// Anthropic modes surface every load (a removed tool needs re-adding). Inline definitions are self-contained; the deferred tail names
		// tools the request's array declares. Both reject a reference to a name that was
		// never declared, so a tool that cannot be resolved is skipped on both sides.
		const additions: ToolLoadingAddition[] = [];
		const removals: string[] = [];
		for (const name of event.tools) {
			if (event.kind === "unload") {
				// Only the inline mode sends removals: the deferred-tail endpoints are only
				// known to read additions (deepseek-harness `addition-only`).
				if (strategy === "anthropic_tool_addition" && declared.has(name)) removals.push(name);
				continue;
			}
			const definition = resolveDefinition(name);
			if (!definition) continue;
			declared.add(name);
			additions.push(strategy === "anthropic_deferred_tail" ? { name } : { name, definition });
		}
		if (additions.length === 0 && removals.length === 0) return message;
		const projected = { ...message };
		toolLoadingChanges.set(projected, { mode: strategy, additions, removals });
		return projected;
	});
}
