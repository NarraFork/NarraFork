import type {
	CredentialTotalsResponse,
	UsageBreakdownDimension,
	UsageBreakdownMetric,
	UsageBreakdownResponse,
	UsageHistoryCursorListResponse,
	UsageHistoryFilters,
	UsageHistoryGranularity,
	UsageHistoryListResponse,
	UsageHistoryProvidersResponse,
	UsageHistoryRecord,
	UsageHistoryStats,
	UsageHistoryTimeSeriesResponse,
	UsageStackedTimeSeriesResponse,
} from "@frontend/types/usage-history";

import { ApiError, authorizedFetch, readFetchError } from "./api/client";
import { parseContentDispositionFileName } from "./api/narrators";

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
	if (filters.credentialId) params.append("credentialId", filters.credentialId);
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
	 * 按凭据聚合的终生 token/成本累计。
	 *
	 * 数据来自 credential_usage_totals，不随叙述者删除而消失。注意该表只覆盖
	 * 有凭据管理的 provider（如 codex）；Anthropic/OpenAI 直连没有 credentialId，
	 * 不在此表内，因此这里的数字不是整个部署的总账。
	 */
	async getCredentialTotals(
		provider: string,
		options: { limit?: number; signal?: AbortSignal } = {},
	): Promise<CredentialTotalsResponse> {
		const params = new URLSearchParams({ provider });
		if (options.limit) params.append("limit", options.limit.toString());
		return fetchJson(`/api/usage-history/credential-totals?${params.toString()}`, options.signal);
	},

	/**
	 * 获取单条使用记录详情
	 */
	async getRecord(id: string): Promise<UsageHistoryRecord> {
		return fetchJson(`/api/usage-history/${id}`);
	},

	/**
	 * 下载一条请求的完整 dump。
	 *
	 * 必须走这个端点而不是把 `getRecord()` 的 `rawDump` 序列化下来：超过行预算的 dump
	 * 完整内容在服务器文件里，库里只留一个带 `spill` 指针的预览。前端自己拼 JSON
	 * 会静默下载到那个预览——正是「打开了 dump 却拿不到完整数据」的成因。
	 */
	async downloadRawDump(id: string): Promise<{ blob: Blob; fileName: string | null }> {
		const res = await authorizedFetch(`/api/usage-history/${id}/raw-dump`);
		if (!res.ok) {
			const error = await readFetchError(res, `HTTP ${res.status}`);
			throw new ApiError(error.message, res.status, error.data);
		}
		return {
			blob: await res.blob(),
			fileName: parseContentDispositionFileName(res.headers.get("content-disposition")),
		};
	},

	/**
	 * 按维度聚合统计数据（环形图用）
	 */
	async getBreakdown(
		filters: UsageHistoryFilters,
		options: {
			dimension: UsageBreakdownDimension;
			metric: UsageBreakdownMetric;
			cluster?: boolean;
		},
	): Promise<UsageBreakdownResponse> {
		const params = new URLSearchParams();
		appendUsageHistoryFilters(params, filters);
		params.append("dimension", options.dimension);
		params.append("metric", options.metric);
		if (options.cluster != null) params.append("cluster", options.cluster ? "true" : "false");
		return fetchJson(`/api/usage-history/breakdown?${params.toString()}`);
	},

	/**
	 * 按维度+时间的堆叠时序数据（堆叠图用）
	 */
	async getTimeSeriesStacked(
		filters: UsageHistoryFilters,
		options: {
			dimension: UsageBreakdownDimension;
			metric: UsageBreakdownMetric;
			granularity?: UsageHistoryGranularity;
			topN?: number;
			cluster?: boolean;
		},
	): Promise<UsageStackedTimeSeriesResponse> {
		const params = new URLSearchParams();
		appendUsageHistoryFilters(params, filters);
		params.append("dimension", options.dimension);
		params.append("metric", options.metric);
		if (options.granularity) params.append("granularity", options.granularity);
		if (options.topN) params.append("topN", options.topN.toString());
		if (options.cluster != null) params.append("cluster", options.cluster ? "true" : "false");
		return fetchJson(`/api/usage-history/timeseries-stacked?${params.toString()}`);
	},
};
