import type { PluginUiContributionItem } from "../../lib/api/plugins";
import type {
	PluginContributionAvailability,
	PluginContributionRecord,
	PluginContributionSnapshot,
} from "./types";

export type {
	PluginContributionAvailability,
	PluginContributionIdentity,
	PluginContributionRecord,
	PluginContributionSnapshot,
	PluginContributionSnapshotStatus,
} from "./types";

export const PLUGIN_CONTRIBUTION_LIMIT = 200;

const EMPTY_SNAPSHOT: PluginContributionSnapshot = Object.freeze({
	revision: 0,
	synced: false,
	status: "idle",
	contributions: Object.freeze({}) as Readonly<Record<string, PluginContributionRecord>>,
});

export function pluginContributionKey(pluginId: string, contributionId: string): string {
	return `${pluginId}:${contributionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readAvailability(value: unknown): PluginContributionAvailability {
	if (
		value === "available" ||
		value === "disabled" ||
		value === "denied" ||
		value === "incompatible" ||
		value === "missing"
	) {
		return value;
	}
	return "disabled";
}

/**
 * Parse a bounded backend contribution payload into host-owned records.
 * Unknown or malformed items are skipped; missing optional fields stay absent
 * so older backends remain compatible.
 */
export function parsePluginContributionItems(
	payload: unknown,
	limit = PLUGIN_CONTRIBUTION_LIMIT,
): PluginContributionRecord[] {
	if (!Array.isArray(payload)) return [];
	const records: PluginContributionRecord[] = [];
	for (const item of payload.slice(0, limit)) {
		if (!isRecord(item)) continue;
		const pluginId = readString(item.pluginId);
		const contributionId = readString(item.contributionId);
		const version = readString(item.version);
		const hash = readString(item.hash);
		if (!pluginId || !contributionId || !version || !hash) continue;
		const availability = readAvailability(item.status);
		records.push({
			pluginId,
			contributionId,
			version,
			hash,
			title: readString(item.title) ?? contributionId,
			pluginName: readString(item.pluginName),
			entryPath: readString(item.entryPath) ?? readString(item.entry),
			stylePath: readString(item.stylePath) ?? readString(item.style),
			scope:
				item.scope === "workspace" ||
				item.scope === "narrator" ||
				item.scope === "project" ||
				item.scope === "global"
					? item.scope
					: undefined,
			entryUrl: readString(item.entryUrl),
			styleUrl: readString(item.styleUrl),
			availability,
			unavailableReason:
				availability === "available" ? undefined : readString(item.unavailableReason),
		});
	}
	return records;
}

/**
 * Host-owned, subscribable store for plugin UI contribution snapshots.
 *
 * The backend is the only source of truth: this store never infers plugin
 * state, it only applies bounded HTTP snapshots and emits immutable snapshots
 * to subscribers (React Query hooks, `useSyncExternalStore`, or legacy
 * registry readers). It supports full replacement plus explicit invalidation
 * so login, WS reconnect, and lifecycle mutations can force a resync.
 */
export class PluginContributionStore {
	private snapshot: PluginContributionSnapshot = EMPTY_SNAPSHOT;
	private listeners = new Set<() => void>();

	getSnapshot = (): PluginContributionSnapshot => this.snapshot;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	private setSnapshot(partial: Partial<PluginContributionSnapshot>): void {
		this.snapshot = Object.freeze({
			...this.snapshot,
			...partial,
		});
		this.emit();
	}

	/** Mark the current snapshot stale; the next sync should refetch from the backend. */
	invalidate(): void {
		this.setSnapshot({ synced: false, status: "idle" });
	}

	/** Begin a sync pass. Keeps existing contributions visible while fetching. */
	beginSync(): void {
		this.setSnapshot({ status: "syncing", error: undefined });
	}

	/** Apply a bounded backend payload. Returns the number of accepted records. */
	applySnapshot(payload: unknown, limit = PLUGIN_CONTRIBUTION_LIMIT): number {
		const records = parsePluginContributionItems(payload, limit);
		const contributions: Record<string, PluginContributionRecord> = {};
		for (const record of records) {
			contributions[pluginContributionKey(record.pluginId, record.contributionId)] = record;
		}
		this.snapshot = Object.freeze({
			revision: this.snapshot.revision + 1,
			synced: true,
			updatedAt: Date.now(),
			status: "ready",
			error: undefined,
			contributions: Object.freeze(contributions),
		});
		this.emit();
		return records.length;
	}

	/** Apply already-parsed records (used by tests and React Query select pipelines). */
	applyRecords(records: readonly PluginContributionRecord[]): void {
		const contributions: Record<string, PluginContributionRecord> = {};
		for (const record of records.slice(0, PLUGIN_CONTRIBUTION_LIMIT)) {
			contributions[pluginContributionKey(record.pluginId, record.contributionId)] = record;
		}
		this.snapshot = Object.freeze({
			revision: this.snapshot.revision + 1,
			synced: true,
			updatedAt: Date.now(),
			status: "ready",
			error: undefined,
			contributions: Object.freeze(contributions),
		});
		this.emit();
	}

	/** Record a failed sync attempt. Keeps the previous contributions visible. */
	failSync(error: unknown): void {
		this.setSnapshot({
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		});
	}

	get(pluginId: string, contributionId: string): PluginContributionRecord | undefined {
		return this.snapshot.contributions[pluginContributionKey(pluginId, contributionId)];
	}

	has(pluginId: string, contributionId: string): boolean {
		return pluginContributionKey(pluginId, contributionId) in this.snapshot.contributions;
	}

	list(): PluginContributionRecord[] {
		return Object.values(this.snapshot.contributions);
	}

	clear(): void {
		if (this.snapshot.revision === 0 && !this.snapshot.synced) return;
		this.snapshot = Object.freeze({
			...EMPTY_SNAPSHOT,
			revision: this.snapshot.revision + 1,
		});
		this.emit();
	}
}

/** Shared runtime store instance. */
export const pluginContributionStore = new PluginContributionStore();

/** Convert a store record to the legacy runtime contribution shape. */
export function toPluginUiContribution(
	record: PluginContributionRecord,
): import("./types").PluginUiContribution {
	return {
		pluginId: record.pluginId,
		contributionId: record.contributionId,
		version: record.version ?? "",
		title: record.title,
		pluginName: record.pluginName,
		contentHash: record.hash,
		packageHash: record.hash,
		entryPath: record.entryPath,
		stylePath: record.stylePath,
		scope: record.scope,
		entryUrl: record.entryUrl ?? "",
		styleUrl: record.styleUrl,
		status: record.availability === "missing" ? "missing" : record.availability,
		unavailableReason: record.unavailableReason,
	};
}

/** Convert a backend API item to a store record without applying it. */
export function fromPluginUiContributionItem(
	item: PluginUiContributionItem,
): PluginContributionRecord {
	return {
		pluginId: item.pluginId,
		contributionId: item.contributionId,
		version: item.version,
		hash: item.hash,
		scope: item.scope,
		title: item.title,
		entryPath: item.entryPath ?? item.entry,
		stylePath: item.stylePath ?? item.style,
		availability: item.status === "available" ? "available" : "disabled",
		unavailableReason: item.status === "available" ? undefined : "Plugin UI package is not enabled",
	};
}
