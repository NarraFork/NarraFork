/** One immutable request baseline; only compact and model changes start another epoch. */
import type { DbMessage } from "@shared/agent-protocol/types";
import {
	contextChanges,
	type PrefixSnapshot,
	type PromptPart,
	renderContextUpdate,
} from "@shared/prefix-context";
import { and, desc, eq, sql } from "drizzle-orm";
import { activeDatabaseBackend, db, sqlite } from "../db";
import { narratorMessageRefs, narratorMessages } from "../db/schema";
import { resolveEpochTarget, resolveHistoryToolLoadingStrategy } from "../lib/agent";
import { collectSenderContext } from "../lib/agent/sender-context";
import {
	classifyToolAdditions,
	deriveToolLoadingState,
	type EpochRecord,
	epochRecordOf,
	latestToolLoadingEpoch,
	type ToolDefinitionSnapshot,
	ToolEpochError,
	type ToolLoadingEpoch,
	toolLoadingDrift,
} from "../lib/agent/tool-loading";
import { resolveToolJsonSchema, toolRegistry } from "../lib/agent/tool-registry";
import type { ToolDefinition } from "../lib/agent/types";
import { getBuiltinToolNames, getBuiltinToolRoutines } from "../lib/builtin-routines";
import type { Locale } from "../lib/i18n";
import { logger } from "../lib/logger";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { blockReadsEnabled, storedElementsSql } from "./narrator-block-scans";
import {
	getPrefixToolDefinitions,
	putPrefixJson,
	putPrefixText,
	putPrefixToolDefinitions,
	withPrefixSnapshotPublication,
} from "./narrator-prefix-snapshots";
import { loadPrefixState } from "./narrator-prefix-state";

export { hydrateContextUpdates, loadContextUpdate } from "./narrator-prefix-state";

import type { narratorService } from "./narrator-service";
import { withNarratorMutationAdmission } from "./narrator-session-state";
import { narratorStore } from "./narrator-store";
import { serializeToolChanges } from "./tool-loading-service";

export function optionalToolDescription(toolName: string, locale: Locale): string {
	const routine = getBuiltinToolRoutines().find(
		(candidate) => candidate.tool && getBuiltinToolNames(candidate.tool).includes(toolName),
	);
	return (
		(locale === "zh-CN" ? routine?.tool?.descriptionZh : undefined) ??
		routine?.tool?.descriptionEn ??
		toolName
	);
}

export function compactEpochRecord(
	active:
		| { alive: boolean; model: string; provider: string; _enabledOptionalTools: Set<string> }
		| undefined,
): EpochRecord | undefined {
	if (!active?.alive) return undefined;
	return {
		reason: "compact",
		target: resolveEpochTarget(active.model, active.provider).fingerprint,
		toolNames: [...active._enabledOptionalTools].sort(),
	};
}

function loadingEpoch(epoch: EpochRecord, markerId?: string): ToolLoadingEpoch {
	return { ...epoch, markerId };
}

/** Only the compact's small metadata, never its potentially large summary. */
export function compactToolLoadingEpoch(narratorId: string): ToolLoadingEpoch | undefined {
	if (activeDatabaseBackend !== "sqlite") return undefined;
	const element = (path: string) =>
		blockReadsEnabled()
			? storedElementsSql("m", (json, root) => `json_extract(${json}, '${root}[0]${path}')`)
			: `json_extract(m.content_json, '$[0]${path}')`;
	const row = sqlite
		.prepare(
			`SELECT m.id, ${element(".type")} AS type, ${element(".epoch")} AS epoch
		 FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id
		 WHERE r.narrator_id = ? AND r.is_compact = 1 ORDER BY r.seq DESC LIMIT 1`,
		)
		.get(narratorId) as { id: string; type: string | null; epoch: string | null } | null;
	if (row?.type !== "compact") return undefined;
	if (!row.epoch) return loadingEpoch({ reason: "compact", toolNames: [] }, row.id);
	try {
		const epoch = epochRecordOf({ type: "compact", epoch: JSON.parse(row.epoch) });
		return epoch ? loadingEpoch(epoch, row.id) : undefined;
	} catch {
		return undefined;
	}
}

async function latestCompactEpoch(narratorId: string): Promise<ToolLoadingEpoch | undefined> {
	if (activeDatabaseBackend === "sqlite") return compactToolLoadingEpoch(narratorId);
	const [row] = await db
		.select({
			id: narratorMessages.id,
			epoch: sql<unknown>`(${narratorMessages.contentJson}::jsonb)->0->'epoch'`,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(
			and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
		)
		.orderBy(desc(narratorMessageRefs.seq))
		.limit(1);
	const record = epochRecordOf({ type: "compact", epoch: row?.epoch });
	return record
		? loadingEpoch(record, row?.id)
		: row?.id
			? loadingEpoch({ reason: "compact", toolNames: [] }, row.id)
			: undefined;
}

export async function currentCompactMessageId(narratorId: string): Promise<string | null> {
	return (await latestCompactEpoch(narratorId))?.markerId ?? null;
}

/** Retry preparation when a compact wins while a baseline is being materialized. */
export class PrefixContextChangedError extends Error {
	constructor() {
		super("Context compacted during prefix preparation; rebuild the request");
	}
}
export async function toolLoadingEpochOf(
	narratorId: string,
	messages: readonly DbMessage[],
	signal?: AbortSignal,
): Promise<ToolLoadingEpoch | undefined> {
	let epoch = latestToolLoadingEpoch(messages);
	const compact = await latestCompactEpoch(narratorId);
	// Compaction can retain an older model-switch marker among the kept turns.
	// Its presence must not hide the new summary/baseline boundary.
	if (!epoch || (compact?.markerId && epoch.compactMessageId !== compact.markerId)) epoch = compact;
	if (!epoch) return;
	if (epoch.prefix) {
		const state = await loadPrefixState({ ...epoch, prefix: epoch.prefix }, messages, signal);
		return {
			...epoch,
			definitionSnapshots: state.definitionSnapshots,
			prefixState: state.keepalive,
		};
	}
	const definitions = epoch.definitionSnapshots ?? [];
	const additions: ToolDefinitionSnapshot[] = [];
	let after = !epoch.markerId || !messages.some((message) => message.id === epoch.markerId);
	for (const message of messages) {
		if (!after) {
			if (message.id === epoch.markerId) after = true;
			continue;
		}
		if (message.role !== "user" || !Array.isArray(message.contentJson)) continue;
		const block = message.contentJson[0] as
			| { type?: string; definitionSnapshotRef?: string }
			| undefined;
		if (block?.type === "tool_loaded" && typeof block.definitionSnapshotRef === "string") {
			additions.push(...(await getPrefixToolDefinitions(block.definitionSnapshotRef)));
		}
	}
	if (!additions.length) return { ...epoch, definitionSnapshots: definitions };
	const first = new Map<string, ToolDefinitionSnapshot>();
	for (const definition of [...definitions, ...additions]) {
		if (!first.has(definition.name)) first.set(definition.name, definition);
	}
	return { ...epoch, definitionSnapshots: [...first.values()] };
}

const definitionCache = new WeakMap<ToolDefinition, ToolDefinitionSnapshot>();
/** Static definitions are materialized once per registry object, not once per request. */
export function snapshotToolDefinitions(
	candidates: readonly ToolDefinition[],
): ToolDefinitionSnapshot[] {
	return candidates.map((tool) => {
		let definition = definitionCache.get(tool);
		if (!definition) {
			definition = {
				name: tool.name,
				description: tool.description,
				parameters: resolveToolJsonSchema(tool),
			};
			definitionCache.set(tool, definition);
		}
		return definition;
	});
}

export type PrefixToolInput = Pick<
	ReconcileEpochInput,
	"managed" | "current" | "candidates" | "registryRevision" | "prompt"
>;

export interface ReconciledEpoch {
	loading?: PrefixToolInput;
	sourceMessages?: Awaited<ReturnType<typeof narratorService.getModelHistorySinceLastCompact>>;
	changed: boolean;
	opened?: boolean;
	epoch: ToolLoadingEpoch | undefined;
	systemPrompt?: string;
}

export interface ReconcileEpochInput {
	narratorId: string;
	messages: readonly DbMessage[];
	managed: ReadonlySet<string>;
	current: Iterable<string>;
	candidates?: readonly ToolDefinition[];
	registryRevision?: string;
	model: string;
	provider: string;
	prompt?: { contract: string; parts: readonly PromptPart[]; compactMessageId?: string | null };
	refreshTools?: () => Promise<PrefixToolInput>;
	signal?: AbortSignal;
	noticeText: (kind: "tool_loaded" | "tool_unloaded", toolName: string) => string;
	/** Compatibility for callers/tests; cache age never opens an epoch. */
	now?: number;
	resolveTarget?: typeof resolveEpochTarget;
}

/** Serializes with /load so two request preparations cannot publish the same update. */
export async function reconcileEpoch(input: ReconcileEpochInput): Promise<ReconciledEpoch> {
	return serializeToolChanges(
		input.narratorId,
		async () => {
			try {
				const loading = await input.refreshTools?.();
				const result = await reconcilePrefix(loading ? { ...input, ...loading } : input);
				return { ...result, ...(loading ? { loading } : {}) };
			} catch (error) {
				if (error instanceof PrefixContextChangedError) throw error;
				logger.warn("Prefix epoch could not be prepared", {
					narratorId: input.narratorId,
					error: String(error),
				});
				throw new ToolEpochError(error);
			}
		},
		input.signal,
	);
}

function currentPromptParts(
	input: ReconcileEpochInput,
	messages: readonly DbMessage[],
	candidates: readonly ToolDefinition[],
	current: ReadonlySet<string>,
	epoch?: ToolLoadingEpoch,
	previous?: ReadonlyMap<string, string>,
): PromptPart[] {
	const requested = candidates
		.filter(
			(tool) => !tool.reflectionOnly && (!input.managed.has(tool.name) || current.has(tool.name)),
		)
		.map((tool) => tool.name);
	const { allowed, blocked } = classifyToolAdditions(epoch, requested);
	const availability = [
		`Currently available tools: ${allowed.sort().join(", ")}`,
		...(blocked.length
			? [
					`Unavailable in this model's current tool-declaration protocol: ${blocked.sort().join(", ")}. Other tools remain available; a compact or model change can establish a new declaration baseline.`,
				]
			: []),
	].join("\n");
	return [
		...(input.prompt?.parts ?? []).filter(
			(part) => part.key !== "senders" && part.key !== "tools.availability",
		),
		{ key: "tools.availability", text: availability },
		{ key: "senders", text: collectSenderContext(messages, previous?.get("senders")) },
	];
}
async function reconcilePrefix(input: ReconcileEpochInput): Promise<ReconciledEpoch> {
	const { narratorId, managed, signal } = input;
	signal?.throwIfAborted();
	// Production uses the shared incremental history loader. Legacy/test tool-only
	// callers can still provide their captured history without a prompt baseline.
	const sourceMessages = input.prompt
		? await (await import("./narrator-service")).narratorService.getModelHistorySinceLastCompact(
				narratorId,
				undefined,
				{ signal },
			)
		: undefined;
	const messages = sourceMessages ?? input.messages;
	const compactMessageId = await currentCompactMessageId(narratorId);
	if (
		input.prompt &&
		input.prompt.compactMessageId !== undefined &&
		input.prompt.compactMessageId !== compactMessageId
	) {
		throw new PrefixContextChangedError();
	}
	const publish = <T>(action: () => Promise<T>) =>
		input.prompt
			? withNarratorMutationAdmission(narratorId, async () => {
					if ((await currentCompactMessageId(narratorId)) !== compactMessageId)
						throw new PrefixContextChangedError();
					return action();
				})
			: action();
	const target = (input.resolveTarget ?? resolveEpochTarget)(input.model, input.provider);
	let epoch = await toolLoadingEpochOf(narratorId, messages, signal);
	const current = new Set(input.current);
	const candidates = input.candidates ?? toolRegistry.all();
	const targetChanged = epoch?.target !== undefined && epoch.target !== target.fingerprint;
	let changed = false;
	let opened = false;
	if (!epoch || targetChanged || (input.prompt && !epoch.prefix)) {
		const baseCandidates = candidates.filter(
			(tool) => !managed.has(tool.name) || current.has(tool.name),
		);
		const definitions = snapshotToolDefinitions(baseCandidates);
		let prefix: PrefixSnapshot | undefined;
		if (input.prompt) {
			const parts: PrefixSnapshot["parts"] = [];
			for (const part of currentPromptParts(input, messages, candidates, current))
				parts.push({ key: part.key, hash: await putPrefixText(part.text, signal) });
			prefix = {
				contract: await putPrefixText(input.prompt.contract, signal),
				parts,
				tools: await putPrefixToolDefinitions(definitions, signal),
			};
		}
		const record: EpochRecord = {
			reason: targetChanged ? "target" : epoch?.reason === "compact" ? "compact" : "initial",
			target: target.fingerprint,
			compactMessageId,
			toolNames: [...current].sort(),
			registryRevision: input.registryRevision ?? toolRegistry.revision,
			baseToolNames: baseCandidates.map((tool) => tool.name),
			...(prefix
				? { prefix, strategy: resolveHistoryToolLoadingStrategy(input.model, input.provider) }
				: { definitionSnapshots: definitions }),
		};
		const marker = await withPrefixSnapshotPublication(
			prefix ? [prefix.contract, prefix.tools, ...prefix.parts.map((part) => part.hash)] : [],
			() => publish(() => narratorStore.openEpoch(narratorId, record)),
			signal,
		);
		epoch = { ...loadingEpoch(record, marker.id), definitionSnapshots: definitions };
		changed = true;
		opened = true;
	}
	// Snapshot additions at their load boundary. Already published tools never follow
	// a registry replacement; removed definitions remain in the immutable base.
	const state = deriveToolLoadingState(messages, managed, current, epoch, candidates);
	const drift = toolLoadingDrift(messages, state);
	const additionsPolicy = classifyToolAdditions(epoch, drift.loads);
	const byName = new Map(candidates.map((tool) => [tool.name, tool]));
	const additions: ToolDefinitionSnapshot[] = [];
	const frozenDefinitions = new Map(
		epoch.definitionSnapshots?.map((definition) => [definition.name, definition]),
	);
	for (const [type, names] of [
		["tool_loaded", additionsPolicy.allowed],
		["tool_unloaded", drift.unloads],
	] as const) {
		for (const name of names) {
			const tool = byName.get(name);
			const frozen = frozenDefinitions.get(name);
			const definitions =
				type === "tool_loaded"
					? frozen
						? [frozen]
						: tool
							? snapshotToolDefinitions([tool])
							: []
					: [];
			const definitionSnapshotRef =
				definitions.length && input.prompt
					? await putPrefixToolDefinitions(definitions, signal)
					: undefined;
			await withPrefixSnapshotPublication(
				definitionSnapshotRef ? [definitionSnapshotRef] : [],
				() =>
					publish(() =>
						narratorStore.appendToolChange(
							narratorId,
							{
								type,
								toolName: name,
								toolNames: [name],
								text: input.noticeText(type, name),
								...(definitionSnapshotRef
									? { definitionSnapshotRef }
									: definitions.length
										? { definitionSnapshots: definitions }
										: {}),
							},
							"system",
						),
					),
				signal,
			);
			additions.push(...definitions);
			changed = true;
		}
	}
	if (additions.length)
		epoch = { ...epoch, definitionSnapshots: [...(epoch.definitionSnapshots ?? []), ...additions] };
	if (!input.prompt || !epoch.prefix) return { changed, opened, epoch };
	const reduced = await loadPrefixState({ ...epoch, prefix: epoch.prefix }, messages, signal);
	epoch = { ...epoch, prefixState: reduced.keepalive };
	const parts = currentPromptParts(input, messages, candidates, current, epoch, reduced.parts);
	const changes = contextChanges(reduced.parts, parts);
	if (changes.length) {
		const modelText = renderContextUpdate(changes);
		const snapshotRef = await putPrefixJson({ changes, modelText }, signal);
		const row = await withPrefixSnapshotPublication(
			[snapshotRef],
			() =>
				publish(() =>
					narratorStore.appendNotice(
						narratorId,
						`Context updated: ${changes.map((part) => part.key).join(", ")}`,
						[{ type: "context_update", epochId: epoch.markerId, changes: [], snapshotRef }],
					),
				),
			signal,
		);
		broadcastToNarrator(narratorId, {
			type: "message",
			narratorId,
			message: { ...row, children: [] },
		});
		changed = true;
	}
	if ((await currentCompactMessageId(narratorId)) !== compactMessageId)
		throw new PrefixContextChangedError();
	return { changed, opened, epoch, systemPrompt: reduced.baselinePrompt, sourceMessages };
}
