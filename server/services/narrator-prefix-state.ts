import type { DbMessage } from "@shared/agent-protocol/types";
import {
	applyContextChanges,
	type ContextUpdate,
	contextUpdateOf,
	type PrefixSnapshot,
	renderPrefixPrompt,
} from "@shared/prefix-context";
import type { ToolDefinitionSnapshot } from "../lib/agent/tool-loading";
import {
	getPrefixJson,
	getPrefixText,
	getPrefixToolDefinitions,
} from "./narrator-prefix-snapshots";

/** Source identity is process-local, not another persistent history version. */
const historySources = new WeakMap<object, { token: object; compactSeq: number | null }>();
export function attachPrefixHistorySource(
	messages: readonly DbMessage[],
	source: object & { compactSeq?: number | null },
): void {
	historySources.set(messages, { token: source, compactSeq: source.compactSeq ?? null });
}

export interface PrefixState {
	baselinePrompt: string;
	parts: ReadonlyMap<string, string>;
	definitionSnapshots: ToolDefinitionSnapshot[];
	/** Keep only the merged state alive, never all historical replacement bodies. */
	keepalive: object;
}
type PrefixEpoch = { markerId?: string; prefix: PrefixSnapshot; prefixState?: object };
type Payload = { changes: ContextUpdate["changes"]; modelText?: string };
type LoadedUpdate = ContextUpdate & { modelText?: string };
type Stamp = { id: string; revision: string };
type CachedState = PrefixState & {
	key: string;
	stamps: Stamp[];
	source?: WeakRef<object>;
	payloads?: WeakRef<Map<string, Payload>>;
	compactSeq?: number | null;
	bytes: number;
};
type SnapshotReader = {
	getPrefixText(hash: string, signal?: AbortSignal): Promise<string>;
	getPrefixJson<T>(hash: string, signal?: AbortSignal): Promise<T>;
	getPrefixToolDefinitions(hash: string, signal?: AbortSignal): Promise<ToolDefinitionSnapshot[]>;
};

/** Budget limits residency only. Oversized active states still have weak/shared reuse. */
export function createPrefixStateLoader(
	reader: SnapshotReader,
	options: { cacheBytes?: number; cacheEntries?: number } = {},
) {
	const budget = options.cacheBytes ?? 32 * 1024 * 1024;
	const maxEntries = Math.max(1, options.cacheEntries ?? 256);
	const resident = new Map<string, CachedState>();
	const weak = new Map<string, WeakRef<CachedState>>();
	const owned = new WeakSet<object>();
	let residentBytes = 0;
	// Request lifetime sharing is separate from merged-state residency. In particular,
	// history projection can reuse a payload even when a long replay exceeds the LRU.
	const requestPayloads = new WeakMap<object, Map<string, Payload>>();
	const livePayloads = new Map<string, WeakRef<Payload>>();
	const hydratedOwners = new WeakMap<object, Payload>();
	const definitionSizes = new WeakMap<object, number>();
	async function definitionBytes(definition: ToolDefinitionSnapshot, signal?: AbortSignal) {
		const cached = definitionSizes.get(definition);
		if (cached !== undefined) return cached;
		let bytes = 0;
		const queue: unknown[] = [definition];
		const seen = new WeakSet<object>();
		let visited = 0;
		while (queue.length) {
			if (++visited % 512 === 0) {
				signal?.throwIfAborted();
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			const value = queue.pop();
			if (typeof value === "string") bytes += value.length * 2;
			else if (value && typeof value === "object") {
				if (seen.has(value)) continue;
				seen.add(value);
				bytes += 64;
				for (const key in value) {
					if (++visited % 512 === 0) {
						signal?.throwIfAborted();
						await new Promise<void>((resolve) => setImmediate(resolve));
					}
					if (!Object.hasOwn(value, key)) continue;
					bytes += key.length * 2 + 16;
					queue.push((value as Record<string, unknown>)[key]);
				}
			} else bytes += 8;
		}
		definitionSizes.set(definition, bytes);
		return bytes;
	}

	function remember(state: CachedState) {
		const old = resident.get(state.key);
		if (old) residentBytes -= old.bytes;
		resident.delete(state.key);
		weak.delete(state.key);
		weak.set(state.key, new WeakRef(state));
		while (weak.size > maxEntries * 4) {
			const oldest = weak.keys().next().value;
			if (oldest === undefined) break;
			weak.delete(oldest);
		}
		if (state.bytes > budget) return;
		for (const [key, value] of resident) {
			if (residentBytes + state.bytes <= budget && resident.size < maxEntries) break;
			resident.delete(key);
			residentBytes -= value.bytes;
		}
		resident.set(state.key, state);
		residentBytes += state.bytes;
	}

	async function loadContextUpdate(
		update: ContextUpdate,
		signal?: AbortSignal,
		request?: object,
	): Promise<LoadedUpdate> {
		signal?.throwIfAborted();
		if (!update.snapshotRef) return update;
		let payload = request && requestPayloads.get(request)?.get(update.snapshotRef);
		payload ??= livePayloads.get(update.snapshotRef)?.deref();
		payload ??= await reader.getPrefixJson<Payload>(update.snapshotRef, signal);
		signal?.throwIfAborted();
		livePayloads.delete(update.snapshotRef);
		livePayloads.set(update.snapshotRef, new WeakRef(payload));
		while (livePayloads.size > 4096) {
			const oldest = livePayloads.keys().next().value;
			if (oldest === undefined) break;
			livePayloads.delete(oldest);
		}
		if (request) {
			let payloads = requestPayloads.get(request);
			if (!payloads) {
				payloads = new Map();
				requestPayloads.set(request, payloads);
			}
			payloads.set(update.snapshotRef, payload);
		}
		return { ...update, ...payload };
	}

	async function hydrateContextUpdates<T extends DbMessage>(
		messages: readonly T[],
		signal?: AbortSignal,
		sourceMessages: readonly DbMessage[] = messages,
	): Promise<T[]> {
		const result: T[] = [];
		for (const [index, row] of messages.entries()) {
			if (index % 128 === 0) {
				signal?.throwIfAborted();
				if (index) await new Promise<void>((resolve) => setImmediate(resolve));
			}
			const update =
				row.role === "sys" && Array.isArray(row.contentJson)
					? row.contentJson.map(contextUpdateOf).find((value) => value?.snapshotRef)
					: undefined;
			if (!update?.snapshotRef) {
				result.push(row);
				continue;
			}
			const loaded = await loadContextUpdate(update, signal, sourceMessages);
			const hydrated = {
				...row,
				contentText: loaded.modelText ?? row.contentText,
				contentJson: [
					{ type: "text", text: loaded.modelText },
					{ ...loaded, modelText: undefined },
				],
			};
			const payload = requestPayloads.get(sourceMessages)?.get(update.snapshotRef);
			if (payload) hydratedOwners.set(hydrated, payload);
			result.push(hydrated);
		}
		signal?.throwIfAborted();
		return result;
	}

	async function loadPrefixState(
		epoch: PrefixEpoch,
		messages: readonly DbMessage[],
		signal?: AbortSignal,
	): Promise<PrefixState> {
		signal?.throwIfAborted();
		const key = JSON.stringify([epoch.markerId, epoch.prefix]);
		const held =
			epoch.prefixState && owned.has(epoch.prefixState)
				? (epoch.prefixState as CachedState)
				: undefined;
		let previous = resident.get(key) ?? weak.get(key)?.deref() ?? held;
		if (previous?.key !== key) previous = undefined;
		const source = historySources.get(messages);
		if (previous && source && previous.source?.deref() === source.token) {
			const payloads = previous.payloads?.deref();
			if (payloads) requestPayloads.set(messages, payloads);
			remember(previous);
			return previous;
		}
		const stamps: Stamp[] = [];
		const events: DbMessage[] = [];
		const markerIndex = messages.findIndex((message) => message.id === epoch.markerId);
		for (const [index, message] of messages.entries()) {
			if (index % 128 === 0) {
				signal?.throwIfAborted();
				if (index) await new Promise<void>((resolve) => setImmediate(resolve));
			}
			if (!Array.isArray(message.contentJson)) continue;
			const toolEvent = message.contentJson[0] as { type?: string } | undefined;
			const relevant =
				message.role === "sys"
					? message.contentJson.some((block) => {
							const update = contextUpdateOf(block);
							return update && update.epochId === epoch.markerId;
						})
					: message.role === "user" &&
						index > markerIndex &&
						(toolEvent?.type === "tool_loaded" || toolEvent?.type === "tool_unloaded");
			if (!relevant) continue;
			events.push(message);
			const revision = (message as DbMessage & { bodyRevision?: number }).bodyRevision;
			stamps.push({
				id: message.id,
				// Unversioned/legacy callers cannot claim stability from the row id alone.
				revision: `${message.role}:${revision && revision > 0 ? revision : Bun.hash(JSON.stringify(message.contentJson) ?? "")}`,
			});
		}
		const appendOnly =
			previous &&
			previous.compactSeq === source?.compactSeq &&
			previous.stamps.length <= stamps.length &&
			previous.stamps.every(
				(stamp, index) =>
					stamp.id === stamps[index].id && stamp.revision === stamps[index].revision,
			);
		if (appendOnly && previous && previous.stamps.length === stamps.length) {
			const payloads = previous.payloads?.deref();
			if (payloads) requestPayloads.set(messages, payloads);
			previous.source = source && new WeakRef(source.token);
			remember(previous);
			return previous;
		}
		let baselinePrompt: string;
		let parts: Map<string, string>;
		let definitions: Map<string, ToolDefinitionSnapshot>;
		if (appendOnly && previous) {
			const payloads = previous.payloads?.deref();
			if (payloads) requestPayloads.set(messages, new Map(payloads));
			baselinePrompt = previous.baselinePrompt;
			parts = new Map(previous.parts);
			definitions = new Map(previous.definitionSnapshots.map((value) => [value.name, value]));
		} else {
			const contract = await reader.getPrefixText(epoch.prefix.contract, signal);
			const baselineParts = [];
			for (const part of epoch.prefix.parts) {
				signal?.throwIfAborted();
				baselineParts.push({ key: part.key, text: await reader.getPrefixText(part.hash, signal) });
			}
			baselinePrompt = renderPrefixPrompt(contract, baselineParts);
			parts = new Map(baselineParts.map((part) => [part.key, part.text]));
			definitions = new Map(
				(await reader.getPrefixToolDefinitions(epoch.prefix.tools, signal)).map((value) => [
					value.name,
					value,
				]),
			);
		}
		const start = appendOnly && previous ? previous.stamps.length : 0;
		for (let index = start; index < events.length; index++) {
			signal?.throwIfAborted();
			if (index && index % 128 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			const message = events[index];
			if (!Array.isArray(message.contentJson)) continue;
			for (const block of message.contentJson) {
				const update = message.role === "sys" ? contextUpdateOf(block) : undefined;
				if (update && update.epochId === epoch.markerId) {
					const loaded = await loadContextUpdate(update, signal, messages);
					applyContextChanges(parts, loaded.changes);
				}
			}
			if (message.role !== "user") continue;
			const block = message.contentJson[0] as
				| {
						type?: string;
						definitionSnapshotRef?: string;
						definitionSnapshots?: ToolDefinitionSnapshot[];
				  }
				| undefined;
			if (block?.type !== "tool_loaded") continue;
			const additions = block.definitionSnapshotRef
				? await reader.getPrefixToolDefinitions(block.definitionSnapshotRef, signal)
				: (block.definitionSnapshots ?? []);
			for (const definition of additions) {
				if (!definitions.has(definition.name)) definitions.set(definition.name, definition);
			}
		}
		signal?.throwIfAborted();
		const definitionSnapshots = [...definitions.values()];
		const payloads = requestPayloads.get(messages);
		let toolsBytes = 0;
		for (const definition of definitionSnapshots)
			toolsBytes += await definitionBytes(definition, signal);
		signal?.throwIfAborted();
		const state: CachedState = {
			key,
			baselinePrompt,
			parts,
			definitionSnapshots,
			stamps,
			source: source && new WeakRef(source.token),
			payloads: payloads && new WeakRef(payloads),
			compactSeq: source?.compactSeq,
			bytes:
				(baselinePrompt.length +
					[...parts.values()].reduce((sum, text) => sum + text.length, 0) +
					key.length) *
					2 +
				stamps.reduce((sum, stamp) => sum + (stamp.id.length + stamp.revision.length) * 2 + 64, 0) +
				toolsBytes,
			keepalive: undefined as unknown as object,
		};
		state.keepalive = state;
		owned.add(state);
		remember(state);
		return state;
	}
	return {
		loadPrefixState,
		loadContextUpdate,
		hydrateContextUpdates,
		stats: () => ({ residentBytes, residentEntries: resident.size, weakEntries: weak.size }),
	};
}

const loader = createPrefixStateLoader({ getPrefixText, getPrefixJson, getPrefixToolDefinitions });
export const { loadPrefixState, loadContextUpdate, hydrateContextUpdates } = loader;
