import type { QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import { pickRequestOptions, type RequestOptions, request } from "./client";

export interface QuotaSnapshotRefreshTarget {
	groupId?: string;
	credentialId?: string;
}

export const quotaSnapshotsApi = {
	quotaSnapshots: (options?: RequestOptions) =>
		request<QuotaSnapshotsResponse>("/quota-snapshots", pickRequestOptions(options)),
	refreshQuotaSnapshots: (target: QuotaSnapshotRefreshTarget = {}, options?: RequestOptions) =>
		request<QuotaSnapshotsResponse>("/quota-snapshots/refresh", {
			...pickRequestOptions(options),
			method: "POST",
			body: JSON.stringify(target),
		}),
};
