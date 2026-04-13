import type {
	UsageHistoryFilters,
	UsageHistoryListResponse,
	UsageHistoryProvidersResponse,
	UsageHistoryRecord,
	UsageHistoryStats,
} from "@frontend/types/usage-history";

async function fetchJson<T>(url: string): Promise<T> {
	const token = localStorage.getItem("narrafork_token");
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
		},
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return response.json();
}

export const usageHistoryApi = {
	/**
	 * 获取使用历史记录列表
	 */
	async list(
		filters: UsageHistoryFilters & { page?: number; pageSize?: number },
	): Promise<UsageHistoryListResponse> {
		const params = new URLSearchParams();

		if (filters.narratorId) params.append("narratorId", filters.narratorId);
		if (filters.chapterId) params.append("chapterId", filters.chapterId);
		if (filters.projectId) params.append("projectId", filters.projectId);
		if (filters.provider) params.append("provider", filters.provider);
		if (filters.model) params.append("model", filters.model);
		if (filters.startDate) params.append("startDate", filters.startDate);
		if (filters.endDate) params.append("endDate", filters.endDate);
		if (filters.page) params.append("page", filters.page.toString());
		if (filters.pageSize) params.append("pageSize", filters.pageSize.toString());

		return fetchJson(`/api/usage-history?${params.toString()}`);
	},

	/**
	 * 获取使用统计
	 */
	async getStats(filters: UsageHistoryFilters): Promise<UsageHistoryStats> {
		const params = new URLSearchParams();

		if (filters.narratorId) params.append("narratorId", filters.narratorId);
		if (filters.chapterId) params.append("chapterId", filters.chapterId);
		if (filters.projectId) params.append("projectId", filters.projectId);
		if (filters.provider) params.append("provider", filters.provider);
		if (filters.model) params.append("model", filters.model);
		if (filters.startDate) params.append("startDate", filters.startDate);
		if (filters.endDate) params.append("endDate", filters.endDate);

		return fetchJson(`/api/usage-history/stats?${params.toString()}`);
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
