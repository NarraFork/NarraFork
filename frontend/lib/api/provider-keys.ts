/** Keys of a custom API provider (admin). Changes apply immediately, outside the settings draft. */
import type { CredentialNetwork } from "@shared/credential-network";
import { request } from "./client";

export interface ProviderKeyUsageWindow {
	label: string;
	usedRatio: number | null;
	resetsAt: string | null;
}

export interface ProviderKeyInfo {
	id: string;
	label: string | null;
	masked: string;
	priority: number;
	disabled: boolean;
	disabledReason: "manual" | "invalid" | null;
	network: CredentialNetwork;
	cooldown: { until: number; reason: "rate_limited" | "quota" | "forbidden" } | null;
	usage: { fetchedAt: number; error: string | null; windows: ProviderKeyUsageWindow[] } | null;
}

const base = (providerId: string) => `/provider-keys/${encodeURIComponent(providerId)}`;
const keyPath = (id: string) => `/provider-keys/key/${encodeURIComponent(id)}`;

export const providerKeysApi = {
	list: (providerId: string) => request<{ keys: ProviderKeyInfo[] }>(base(providerId)),
	add: (providerId: string, input: { apiKey: string; label?: string }) =>
		request<{ key: ProviderKeyInfo }>(base(providerId), {
			method: "POST",
			body: JSON.stringify(input),
		}),
	update: (
		id: string,
		fields: { label?: string; disabled?: boolean; network?: CredentialNetwork | null },
	) =>
		request<{ key: ProviderKeyInfo }>(keyPath(id), {
			method: "PATCH",
			body: JSON.stringify(fields),
		}),
	remove: (id: string) => request<{ ok: true }>(keyPath(id), { method: "DELETE" }),
	reorder: (providerId: string, ids: string[]) =>
		request<{ keys: ProviderKeyInfo[] }>(`${base(providerId)}/order`, {
			method: "PUT",
			body: JSON.stringify({ ids }),
		}),
	refreshUsage: (providerId: string) =>
		request<{ keys: ProviderKeyInfo[] }>(`${base(providerId)}/usage/refresh`, { method: "POST" }),
};
