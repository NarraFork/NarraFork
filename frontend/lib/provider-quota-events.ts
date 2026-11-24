import { REMOTE_BUILD } from "@frontend/lib/build-target";
import type { QueryClient } from "@tanstack/react-query";
import { narratorWSManager } from "./narrator-ws-manager";

export interface ProviderQuotaChangedEvent {
	type: "provider_quota_changed";
	providerIds: string[];
	version: number;
}

/** Only identity/version hints cross the socket. Fetch values through the visibility-filtered API. */
export function dispatchProviderQuotaChanged(data: Record<string, unknown>): boolean {
	if (data.type !== "provider_quota_changed") return false;
	if (REMOTE_BUILD) return true;
	if (
		!Array.isArray(data.providerIds) ||
		data.providerIds.length > 1_024 ||
		!data.providerIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256) ||
		typeof data.version !== "number" ||
		!Number.isSafeInteger(data.version) ||
		data.version < 0
	)
		return true;
	window.dispatchEvent(
		new CustomEvent("narrafork:provider-quota-changed", {
			detail: { providerIds: data.providerIds, version: data.version },
		}),
	);
	return true;
}

export function invalidateProviderQuotaQueries(client: QueryClient, providerIds?: string[]): void {
	if (REMOTE_BUILD) return;
	const ids = providerIds ? new Set(providerIds) : undefined;
	void client.invalidateQueries({
		queryKey: ["provider-quotas"],
		predicate: ({ queryKey }) => {
			if (!ids) return true;
			if (queryKey[1] === "provider") return ids.has(queryKey[2] as string);
			if (queryKey[1] === "list" && Array.isArray(queryKey[2])) {
				return queryKey[2].some((entry) => Array.isArray(entry) && ids.has(entry[0]));
			}
			return false;
		},
	});
}

const subscriptions = new WeakMap<QueryClient, { references: number; dispose: () => void }>();

/** A single listener per query client, not one broadcast/refetch for every mounted narrator. */
export function subscribeProviderQuotaEvents(client: QueryClient): () => void {
	if (REMOTE_BUILD) return () => {};
	let subscription = subscriptions.get(client);
	if (!subscription) {
		const onQuota = (event: Event) => {
			const detail = (event as CustomEvent<Omit<ProviderQuotaChangedEvent, "type">>).detail;
			if (!detail?.providerIds?.length) return;
			invalidateProviderQuotaQueries(client, detail.providerIds);
			const settings = client.getQueryData<{ providerBalanceCapability?: { enabled?: unknown } }>([
				"settings",
			]);
			// Public quota hints must also recover viewers who cannot receive admin plugin events.
			if (settings?.providerBalanceCapability?.enabled === false) {
				void client.invalidateQueries({ queryKey: ["settings"] });
				void client.invalidateQueries({ queryKey: ["admin", "settings"] });
			}
		};
		const onPlugin = (event: Event) => {
			if (
				(event as CustomEvent<{ type?: string }>).detail?.type === "plugin:contributions_changed"
			) {
				invalidateProviderQuotaQueries(client);
				void client.invalidateQueries({ queryKey: ["settings"] });
				void client.invalidateQueries({ queryKey: ["admin", "settings"] });
			}
		};
		window.addEventListener("narrafork:provider-quota-changed", onQuota);
		window.addEventListener("narrafork:plugin-event", onPlugin);
		const listener = narratorWSManager.addListener(
			{ types: ["provider_quota_changed"] },
			dispatchProviderQuotaChanged,
		);
		const disconnect = narratorWSManager.onConnectionChange((connected) => {
			if (!connected) return;
			invalidateProviderQuotaQueries(client);
			void client.invalidateQueries({ queryKey: ["settings"] });
			void client.invalidateQueries({ queryKey: ["admin", "settings"] });
		});
		subscription = {
			references: 0,
			dispose: () => {
				window.removeEventListener("narrafork:provider-quota-changed", onQuota);
				window.removeEventListener("narrafork:plugin-event", onPlugin);
				narratorWSManager.removeListener(listener);
				disconnect();
			},
		};
		subscriptions.set(client, subscription);
	}
	subscription.references++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--subscription.references === 0) {
			subscription.dispose();
			subscriptions.delete(client);
		}
	};
}
