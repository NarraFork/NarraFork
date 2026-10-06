import type {
	ExecutionLogDetail,
	ExecutionLogFacets,
	ExecutionLogFilters,
	ExecutionLogListResponse,
} from "@frontend/types/execution-log";

import { ApiError, authorizedFetch, readFetchError } from "./api/client";

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
	const response = await authorizedFetch(url, { signal });
	if (!response.ok) {
		const error = await readFetchError(response, `HTTP ${response.status}`);
		throw new ApiError(error.message, response.status, error.data);
	}
	return response.json();
}

/** Serialize filters, omitting empties so the query key stays stable. */
export function appendExecutionLogFilters(
	params: URLSearchParams,
	filters: ExecutionLogFilters,
): void {
	if (filters.narratorId) params.append("narratorId", filters.narratorId);
	if (filters.includeSubagents) params.append("includeSubagents", "1");
	if (filters.chapterId) params.append("chapterId", filters.chapterId);
	if (filters.projectId) params.append("projectId", filters.projectId);
	if (filters.toolName) params.append("toolName", filters.toolName);
	if (filters.status) params.append("status", filters.status);
	if (filters.executionDeviceId) params.append("executionDeviceId", filters.executionDeviceId);
	if (filters.provider) params.append("provider", filters.provider);
	if (filters.model) params.append("model", filters.model);
	if (filters.onlyErrors) params.append("onlyErrors", "1");
	if (filters.isBackground !== undefined) {
		params.append("isBackground", filters.isBackground ? "1" : "0");
	}
	// Only sent when the caller opts OUT: the server default is already "hide".
	if (filters.hideFileHistoryCheckpoints === false) {
		params.append("hideFileHistoryCheckpoints", "0");
	}
	if (filters.startDate) params.append("startDate", filters.startDate);
	if (filters.endDate) params.append("endDate", filters.endDate);
	if (filters.q) params.append("q", filters.q);
	// The server rejects searchPayload without a needle, so never send it alone.
	if (filters.q && filters.searchPayload) params.append("searchPayload", "1");
}

export const executionLogApi = {
	/** Cursor-paginated tool calls across every narrator, newest execution first. */
	async listCursor(
		filters: ExecutionLogFilters,
		options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
	): Promise<ExecutionLogListResponse> {
		const params = new URLSearchParams();
		appendExecutionLogFilters(params, filters);
		if (options.cursor) params.append("cursor", options.cursor);
		if (options.limit) params.append("limit", options.limit.toString());

		return fetchJson(`/api/execution-log?${params.toString()}`, options.signal);
	},

	/** Filter options: tool names, statuses, providers. */
	async getFacets(signal?: AbortSignal): Promise<ExecutionLogFacets> {
		return fetchJson("/api/execution-log/facets", signal);
	},

	/** Full detail for one call, including byte-capped input/output payloads. */
	async getRecord(id: string, signal?: AbortSignal): Promise<ExecutionLogDetail> {
		return fetchJson(`/api/execution-log/${encodeURIComponent(id)}`, signal);
	},
};
