/**
 * narrator-epochs.ts — epochs of a narrator's request prefix (docs/BLOCK_STORAGE-DESIGN.md
 * §7.7, P1 scope).
 *
 * Within an epoch the request's tool array only grows by appended history, so the
 * provider's prompt cache survives tool loads. An epoch opens at a compact (the compact
 * element records `epoch`) or at an epoch marker row the runtime writes when the target
 * changes or its cache has certainly gone cold. Either one records the optional tools
 * loaded when it opened; that set, not a backwards derivation, is then the array's share.
 *
 * `reconcileEpoch` runs before each pass's history is built and writes what the
 * request must say, as rows:
 *   - at a boundary, a new epoch marker, but only when rebuilding would actually change
 *     the tool layout (otherwise the bytes are the same and the cache is kept anyway);
 *   - inside a frozen epoch, a system notice for every tool loaded or unloaded without
 *     one (resident mode, preloads), so the array never shifts under the cache.
 *
 * P1 freezes the tool set only. Frozen tool definitions, frozen system sections with
 * reminders, and the prefix check are the rest of §7.7.
 */

import type { DbMessage } from "@shared/agent-protocol/types";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { activeDatabaseBackend, db, sqlite } from "../db";
import { narratorMessageRefs, narratorMessages } from "../db/schema";
import { resolveEpochTarget } from "../lib/agent";
import {
	deriveToolLoadingState,
	type EpochRecord,
	epochRecordOf,
	latestToolLoadingEpoch,
	snapshotToolDefinitions,
	type ToolLoadingEpoch,
	toolLoadingDrift,
} from "../lib/agent/tool-loading";
import { toolRegistry } from "../lib/agent/tool-registry";
import type { ToolDefinition } from "../lib/agent/types";
import { getBuiltinToolNames, getBuiltinToolRoutines } from "../lib/builtin-routines";
import type { Locale } from "../lib/i18n";
import { logger } from "../lib/logger";
import { blockReadsEnabled, storedElementsSql } from "./narrator-block-scans";
import { narratorStore } from "./narrator-store";

/** What a reconciled load notice says a tool does: its routine's description, else its name. */
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

/**
 * What a compact's epoch records: the loaded tools and target of the running session.
 * Undefined when the session is not running; the epoch then derives its tool set.
 */
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
		definitionSnapshots: snapshotToolDefinitions(active._enabledOptionalTools),
	};
}

/** The epoch the latest compact opened, when it recorded one (SQLite; PG derives). */
export function compactToolLoadingEpoch(narratorId: string): ToolLoadingEpoch | undefined {
	if (activeDatabaseBackend !== "sqlite") return undefined;
	// Only the epoch: the summary beside it can be large. With block reads it comes from
	// the compact block's payload.
	const element = (path: string) =>
		blockReadsEnabled()
			? storedElementsSql("m", (json, root) => `json_extract(${json}, '${root}[0]${path}')`)
			: `json_extract(m.content_json, '$[0]${path}')`;
	const row = sqlite
		.prepare(
			`SELECT ${element(".type")} AS type, ${element(".epoch")} AS epoch
			 FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id
			 WHERE r.narrator_id = ? AND r.is_compact = 1 ORDER BY r.seq DESC LIMIT 1`,
		)
		.get(narratorId) as { type: string | null; epoch: string | null } | null;
	if (row?.type !== "compact" || !row.epoch) return undefined;
	let recorded: unknown;
	try {
		recorded = JSON.parse(row.epoch);
	} catch {
		return undefined;
	}
	const epoch = epochRecordOf({ type: "compact", epoch: recorded });
	return epoch
		? {
				toolNames: epoch.toolNames,
				definitionSnapshots: epoch.definitionSnapshots,
				...(epoch.target ? { target: epoch.target } : {}),
			}
		: undefined;
}

/** The epoch a history window is in: its latest marker row, else the compact before it. */
export async function toolLoadingEpochOf(
	narratorId: string,
	messages: readonly DbMessage[],
): Promise<ToolLoadingEpoch | undefined> {
	const visible = latestToolLoadingEpoch(messages);
	if (visible) return visible;
	if (activeDatabaseBackend === "sqlite") return compactToolLoadingEpoch(narratorId);
	// PG stores the authoritative body in content_json, so block reads do not apply.
	// Project only the compact epoch, never the potentially large summary beside it.
	const [row] = await db
		.select({ epoch: sql<unknown>`(${narratorMessages.contentJson}::jsonb)->0->'epoch'` })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(
			and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
		)
		.orderBy(desc(narratorMessageRefs.seq))
		.limit(1);
	const epoch = epochRecordOf({ type: "compact", epoch: row?.epoch });
	return epoch
		? {
				toolNames: epoch.toolNames,
				definitionSnapshots: epoch.definitionSnapshots,
				...(epoch.target ? { target: epoch.target } : {}),
			}
		: undefined;
}

/** The newest assistant step this narrator holds: when and through what it was sent. */
async function lastStep(
	narratorId: string,
): Promise<{ provider: string | null; model: string | null; createdAt: string } | undefined> {
	if (activeDatabaseBackend !== "sqlite") {
		const [row] = await db
			.select({
				provider: narratorMessages.provider,
				model: narratorMessages.model,
				createdAt: narratorMessages.createdAt,
			})
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessages.role, "assistant"),
					isNull(narratorMessages.parentToolUseId),
				),
			)
			.orderBy(desc(narratorMessageRefs.seq))
			.limit(1);
		return row;
	}
	return (
		(sqlite
			.prepare(
				`SELECT m.provider, m.model, m.created_at AS createdAt FROM narrator_message_refs r
				 JOIN narrator_messages m ON m.id = r.message_id
				 WHERE r.narrator_id = ? AND m.role = 'assistant' AND m.parent_tool_use_id IS NULL
				 ORDER BY r.seq DESC LIMIT 1`,
			)
			.get(narratorId) as
			| { provider: string | null; model: string | null; createdAt: string }
			| null
			| undefined) ?? undefined
	);
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
	a.size === b.size && [...a].every((name) => b.has(name));

export interface ReconciledEpoch {
	changed: boolean;
	epoch: ToolLoadingEpoch | undefined;
}

/** Shared by sessions without managed tools; they perform no epoch DB/history work. */
const EMPTY_RECONCILED_EPOCH: ReconciledEpoch = Object.freeze({
	changed: false,
	epoch: undefined,
});

/**
 * Write what this pass's request must carry before its history is built. `changed` says
 * whether rows were written; `epoch` is the exact already-read/opened epoch for history.
 * A failed freeze aborts assembly: current definitions must never rewrite history.
 */
export async function reconcileEpoch(input: {
	narratorId: string;
	messages: readonly DbMessage[];
	managed: ReadonlySet<string>;
	current: Iterable<string>;
	/** Full candidates from the caller's current registry view (legacy callers may omit). */
	candidates?: readonly ToolDefinition[];
	model: string;
	provider: string;
	/** Notice text for a reconciled load or unload of `toolName`. */
	noticeText: (kind: "tool_loaded" | "tool_unloaded", toolName: string) => string;
	now?: number;
	resolveTarget?: typeof resolveEpochTarget;
}): Promise<ReconciledEpoch> {
	const { narratorId, messages, managed } = input;
	if (managed.size === 0) return EMPTY_RECONCILED_EPOCH;
	try {
		// Production always supplies this view. The fallback keeps standalone legacy callers
		// working without ever mixing two registry arrays inside one reconcile.
		const candidates = input.candidates ?? toolRegistry.all();
		const snapshots = (current: Iterable<string>) => snapshotToolDefinitions(current, candidates);
		const resolveTarget = input.resolveTarget ?? resolveEpochTarget;
		const target = resolveTarget(input.model, input.provider);
		const epoch = await toolLoadingEpochOf(narratorId, messages);
		const state = deriveToolLoadingState(messages, managed, input.current, epoch);
		const last = await lastStep(narratorId);
		const sentTo =
			last?.model && last.provider
				? resolveTarget(last.model, last.provider).fingerprint
				: epoch?.target;
		const targetChanged = sentTo !== undefined && sentTo !== target.fingerprint;
		const cold =
			target.cacheTtlMs !== null &&
			!!last &&
			(input.now ?? Date.now()) - Date.parse(last.createdAt) > target.cacheTtlMs;
		const layoutChanges = state.loaded.length > 0 || !sameSet(state.base, state.current);
		const liveSnapshots = new Map(
			snapshots(state.definitionSnapshots?.map((item) => item.name) ?? []).map((item) => [
				item.name,
				item,
			]),
		);
		const definitionsChanged =
			state.definitionSnapshots?.some(
				(item) => JSON.stringify(item) !== JSON.stringify(liveSnapshots.get(item.name)),
			) ?? false;
		const frozenNames = new Set(state.definitionSnapshots?.map((item) => item.name));
		const missingMcpSnapshots =
			snapshots(
				(epoch?.toolNames ?? []).filter(
					(name) => name.startsWith("mcp__") && managed.has(name) && !frozenNames.has(name),
				),
			).length > 0;
		if (
			(!epoch && [...managed].some((name) => name.startsWith("mcp__"))) ||
			missingMcpSnapshots ||
			definitionsChanged ||
			((targetChanged || cold) && layoutChanges)
		) {
			const definitionSnapshots = snapshots(state.current);
			const opened: EpochRecord = {
				reason: definitionsChanged ? "manual" : targetChanged ? "target" : cold ? "cold" : "manual",
				target: target.fingerprint,
				toolNames: [...state.current].sort(),
				...(definitionSnapshots.length ? { definitionSnapshots } : {}),
			};
			const marker = await narratorStore.openEpoch(narratorId, opened);
			return {
				changed: true,
				epoch: {
					markerId: marker.id,
					toolNames: opened.toolNames,
					...(opened.definitionSnapshots
						? { definitionSnapshots: opened.definitionSnapshots }
						: {}),
					...(opened.target ? { target: opened.target } : {}),
				},
			};
		}
		if (!epoch) return { changed: false, epoch };
		const drift = toolLoadingDrift(messages, state);
		for (const [type, names] of [
			["tool_loaded", drift.loads],
			["tool_unloaded", drift.unloads],
		] as const)
			for (const toolName of names)
				await narratorStore.appendToolChange(
					narratorId,
					{
						type,
						toolName,
						toolNames: [toolName],
						text: input.noticeText(type, toolName),
						...(type === "tool_loaded" ? { definitionSnapshots: snapshots([toolName]) } : {}),
					},
					"system",
				);
		return {
			changed: drift.loads.length > 0 || drift.unloads.length > 0,
			epoch,
		};
	} catch (error) {
		logger.warn(
			"Epoch reconcile failed; request assembly stopped to preserve frozen tool definitions",
			{
				narratorId,
				error: String(error),
			},
		);
		throw new Error(
			"Tool epoch could not be saved or its definitions exceed the snapshot budget; retry after correcting the tool configuration or storage error.",
			{ cause: error },
		);
	}
}
