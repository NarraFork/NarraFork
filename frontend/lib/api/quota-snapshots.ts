import type { QuotaSnapshotReadScope, QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import { pickRequestOptions, type RequestOptions, request } from "./client";

export interface QuotaSnapshotRefreshTarget {
	groupId?: string;
	credentialId?: string;
}

export const quotaSnapshotsApi = {
	quotaSnapshots: (options?: RequestOptions & QuotaSnapshotReadScope) => {
		const query = new URLSearchParams();
		if (options?.groupId) query.set("groupId", options.groupId);
		if (options?.cachedOnly) query.set("cachedOnly", "true");
		if (options?.expectedGeneration !== undefined)
			query.set("expectedGeneration", String(options.expectedGeneration));
		const suffix = query.size ? `?${query}` : "";
		return request<QuotaSnapshotsResponse>(`/quota-snapshots${suffix}`, {
			...pickRequestOptions(options),
			...(query.size
				? {
						maxResponseBytes: 64 * 1024,
						signal: options?.signal
							? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
							: AbortSignal.timeout(15_000),
					}
				: {}),
		});
	},
	refreshQuotaSnapshots: (target: QuotaSnapshotRefreshTarget = {}, options?: RequestOptions) =>
		request<QuotaSnapshotsResponse>("/quota-snapshots/refresh", {
			...pickRequestOptions(options),
			method: "POST",
			body: JSON.stringify(target),
		}),
};
