import type {
	UsageHistoryCursorListResponse,
	UsageHistoryFilters,
	UsageHistoryGranularity,
	UsageHistoryListResponse,
	UsageHistoryProvidersResponse,
	UsageHistoryRecord,
	UsageHistoryStats,
	UsageHistoryTimeSeriesResponse,
} from "@frontend/types/usage-history";

import { ApiError, authorizedFetch, readFetchError } from "./api/client";

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
	const response = await authorizedFetch(url, { signal });
	if (!response.ok) {
		const error = await readFetchError(response, `HTTP ${response.status}`);
		throw new ApiError(error.message, response.status, error.data);
	}
	return response.json();
}

function appendUsageHistoryFilters(params: URLSearchParams, filters: UsageHistoryFilters): void {
	if (filters.narratorId) params.append("narratorId", filters.narratorId);
	if (filters.chapterId) params.append("chapterId", filters.chapterId);
	if (filters.projectId) params.append("projectId", filters.projectId);
	if (filters.provider) params.append("provider", filters.provider);
	if (filters.model) params.append("model", filters.model);
	if (filters.kind) params.append("kind", filters.kind);
	if (filters.startDate) params.append("startDate", filters.startDate);
	if (filters.endDate) params.append("endDate", filters.endDate);
}

export const usageHistoryApi = {
	/**
	 * 获取使用历史记录列表
	 */
	async list(
		filters: UsageHistoryFilters & { page?: number; pageSize?: number },
	): Promise<UsageHistoryListResponse> {
		const params = new URLSearchParams();
		appendUsageHistoryFilters(params, filters);
		if (filters.page) params.append("page", filters.page.toString());
		if (filters.pageSize) params.append("pageSize", filters.pageSize.toString());

		return fetchJson(`/api/usage-history?${params.toString()}`);
	},

	/**
	 * 使用 keyset cursor 获取用量历史，避免 COUNT(*) 与 OFFSET。
	 */
	async listCursor(
		filters: UsageHistoryFilters,
		options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
	): Promise<UsageHistoryCursorListResponse> {
		const params = new URLSearchParams();
		appendUsageHistoryFilters(params, filters);
		params.append("pagination", "cursor");
		if (options.cursor) params.append("cursor", options.cursor);
		if (options.limit) params.append("limit", options.limit.toString());

		return fetchJson(`/api/usage-history?${params.toString()}`, options.signal);
	},

	/**
	 * 获取使用统计
	 */
	async getStats(filters: UsageHistoryFilters): Promise<UsageHistoryStats> {
		const params = new URLSearchParams();
		appendUsageHistoryFilters(params, filters);

		return fetchJson(`/api/usage-history/stats?${params.toString()}`);
	},

	/**
	 * 获取时间序列统计
	 */
	async getTimeSeries(
		filters: UsageHistoryFilters,
		options: { granularity?: UsageHistoryGranularity } = {},
	): Promise<UsageHistoryTimeSeriesResponse> {
		const params = new URLSearchParams();
		appendUsageHistoryFilters(params, filters);
		if (options.granularity) params.append("granularity", options.granularity);

		return fetchJson(`/api/usage-history/timeseries?${params.toString()}`);
	},

	/**
	 * 获取历史中出现过的 provider 列表
	 */
	async listProviders(): Promise<UsageHistoryProvidersResponse> {
		return fetchJson("/api/usage-history/providers");
	},

	/**
	 * 获取单条使用记录详情
	 */
	async getRecord(id: string): Promise<UsageHistoryRecord> {
		return fetchJson(`/api/usage-history/${id}`);
	},
};
