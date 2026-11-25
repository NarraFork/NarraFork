/**
 * Command Code 的登录状态与额度接口。
 *
 * 后端已把语义编码进响应体（未登录返回 `loggedIn: false` 与 `reason`，凭据失效同样如此），
 * 所以这里不按 HTTP 状态码抛错，交给调用方统一按 `loggedIn` 分支。
 */

import { apiBase, getToken } from "./client";

/** Provider API 的推理端点，逐模型可覆盖。 */
export type CommandCodeEndpoint = "messages" | "completions" | "responses";

export interface CommandCodeStatus {
	loggedIn: boolean;
	userName?: string;
	reason?: string;
}

export interface CommandCodeUsageSummary {
	totalCount: number;
	totalTokens: number;
	totalTokensIn: number;
	totalTokensOut: number;
	successRate: number;
	completedCount: number;
	failedCount: number;
	/** 计费周期内已消耗的月度额度；与 credits.monthlyCredits（余额）相加即总配额。 */
	totalMonthlyCredits: number;
	periodStart?: string;
}

export interface CommandCodeUsageSummaryResponse {
	loggedIn: boolean;
	reason?: string;
	error?: string;
	summary?: CommandCodeUsageSummary;
}

function authHeaders(): HeadersInit {
	const token = getToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

export const commandCodeApi = {
	async commandCodeStatus(): Promise<CommandCodeStatus> {
		const response = await fetch(`${apiBase()}/commandcode/status`, { headers: authHeaders() });
		return (await response.json()) as CommandCodeStatus;
	},

	async commandCodeUsageSummary(): Promise<CommandCodeUsageSummaryResponse> {
		const response = await fetch(`${apiBase()}/commandcode/usage-summary`, {
			headers: authHeaders(),
		});
		return (await response.json()) as CommandCodeUsageSummaryResponse;
	},

	/**
	 * 丢弃服务端的模型缓存并重新拉取。
	 * `apiKey` 只在设置页有尚未保存的新 key 时传入，服务端不会把它写进 settings。
	 */
	async commandCodeRefreshModels(draft?: { apiKey?: string; baseUrl?: string }): Promise<string[]> {
		const response = await fetch(`${apiBase()}/commandcode/models/refresh`, {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify(draft ?? {}),
		});
		const body = (await response.json()) as { models?: string[]; error?: string };
		if (!response.ok) {
			throw new Error(body.error ?? `command code model refresh failed: ${response.status}`);
		}
		return body.models ?? [];
	},
};
