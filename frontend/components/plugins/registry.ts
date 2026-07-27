import { authorizedFetch, BASE, getToken } from "../../lib/api/client";
import {
	fromPluginUiContributionItem,
	pluginContributionStore,
	toPluginUiContribution,
} from "./PluginContributionStore";
import type { PluginDockPanelParams } from "./protocol";
import type {
	PluginContributionAvailability,
	PluginContributionRecord,
	PluginUiContribution,
	PluginUiStatus,
} from "./types";

function toAvailability(status: PluginUiStatus | undefined): PluginContributionAvailability {
	if (status === "available" || status === "denied" || status === "incompatible") return status;
	return "disabled";
}

/**
 * Resolve the host-owned contribution for a panel.
 *
 * Returns `undefined` when the registry has no record for the panel's
 * `pluginId`/`contributionId`, which callers must treat as the **missing**
 * state rather than a generic runtime failure.
 */
export function resolvePluginUiContribution(
	params: PluginDockPanelParams,
): PluginUiContribution | undefined {
	const record = pluginContributionStore.get(params.pluginId, params.contributionId);
	return record ? toPluginUiContribution(record) : undefined;
}

/**
 * Resolve the contribution and explicitly report whether it is missing.
 * Prefer this over `resolvePluginUiContribution` when the UI needs to
 * distinguish "not present in the registry" from other statuses.
 */
export function resolvePluginUiContributionDetailed(params: PluginDockPanelParams): {
	contribution?: PluginUiContribution;
	missing: boolean;
} {
	const record = pluginContributionStore.get(params.pluginId, params.contributionId);
	return {
		contribution: record ? toPluginUiContribution(record) : undefined,
		missing: !record,
	};
}

/** Check whether a contribution exists in the current host-owned snapshot. */
export function hasPluginUiContribution(pluginId: string, contributionId: string): boolean {
	return pluginContributionStore.has(pluginId, contributionId);
}

/** Register a single host-owned contribution record. Returns an unregister function. */
export function registerPluginUiContribution(contribution: PluginUiContribution): () => void {
	const record: PluginContributionRecord = {
		pluginId: contribution.pluginId,
		contributionId: contribution.contributionId,
		version: contribution.version,
		hash: contribution.packageHash ?? contribution.contentHash,
		title: contribution.title,
		pluginName: contribution.pluginName,
		entryPath: contribution.entryPath,
		stylePath: contribution.stylePath,
		scope: contribution.scope,
		entryUrl: contribution.entryUrl,
		styleUrl: contribution.styleUrl,
		availability: toAvailability(contribution.status),
		unavailableReason: contribution.unavailableReason,
	};
	const snapshot = pluginContributionStore.getSnapshot();
	const next = {
		...snapshot.contributions,
		[`${record.pluginId}:${record.contributionId}`]: record,
	};
	pluginContributionStore.applyRecords(Object.values(next));
	return () => {
		const current = pluginContributionStore.get(record.pluginId, record.contributionId);
		if (current === record) {
			const after = { ...pluginContributionStore.getSnapshot().contributions };
			delete after[`${record.pluginId}:${record.contributionId}`];
			pluginContributionStore.applyRecords(Object.values(after));
		}
	};
}

/** Clear all host-owned contributions (used on logout and full resync). */
export function clearPluginUiContributions(): void {
	pluginContributionStore.clear();
}

/**
 * Pull the bounded host-owned contribution snapshot from the backend and
 * replace the local store. No iframe can mutate this registry; the backend
 * remains the only source of truth.
 */
export async function syncPluginUiContributions(): Promise<number> {
	const token = getToken();
	if (!token) return 0;
	pluginContributionStore.beginSync();
	try {
		const response = await authorizedFetch(`${BASE}/plugins/ui/contributions`);
		if (!response.ok) {
			throw new Error(`Failed to sync plugin contributions: ${response.status}`);
		}
		const payload = (await response.json()) as unknown;
		const count = pluginContributionStore.applySnapshot(payload);
		return count;
	} catch (error) {
		pluginContributionStore.failSync(error);
		return 0;
	}
}

/** Mark the current snapshot stale so the next sync refetches from the backend. */
export function invalidatePluginUiContributions(): void {
	pluginContributionStore.invalidate();
}

/** Apply typed API items directly (used by React Query-backed hooks). */
export function applyPluginUiContributionItems(
	items: readonly import("../../lib/api/plugins").PluginUiContributionItem[],
): void {
	pluginContributionStore.applyRecords(items.map(fromPluginUiContributionItem));
}
