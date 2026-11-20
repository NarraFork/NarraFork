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

export interface CommandCodeCredits {
	monthlyCredits: number;
	purchasedCredits: number;
	freeCredits: number;
	creditThreshold: number;
	belowThreshold: boolean;
}

export interface CommandCodeWindow {
	used: number;
	cap: number;
	exceeded: boolean;
	/** 窗口重置时间（毫秒时间戳）。 */
	resetAt?: number;
}

export interface CommandCodeWindowLimits {
	limited: boolean;
	fiveHour?: CommandCodeWindow;
	weekly?: CommandCodeWindow;
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

export interface CommandCodeUsageResponse {
	loggedIn: boolean;
	reason?: string;
	error?: string;
	credits?: CommandCodeCredits;
	windowLimits?: CommandCodeWindowLimits;
	sandboxAccess?: boolean;
	summary?: CommandCodeUsageSummary;
}

function authHeaders(): HeadersInit {
	const token = getToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

export const commandCodeApi = {
	async commandCodeStatus(prefix?: string): Promise<CommandCodeStatus> {
		const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
		const response = await fetch(`${apiBase()}/commandcode/status${query}`, {
			headers: authHeaders(),
		});
		return (await response.json()) as CommandCodeStatus;
	},

	/** 额度按平台实例取：每个实例用自己的 key 与 baseUrl。 */
	async commandCodeUsage(prefix?: string): Promise<CommandCodeUsageResponse> {
		const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
		const response = await fetch(`${apiBase()}/commandcode/usage${query}`, {
			headers: authHeaders(),
		});
		return (await response.json()) as CommandCodeUsageResponse;
	},

	/**
	 * 丢弃服务端的模型缓存并重新拉取。
	 * `apiKey`/`baseUrl` 只在设置页有尚未保存的草稿时传入，服务端不会把它写进 settings；
	 * `prefix` 指定按哪个平台实例的配置拉取。
	 */
	async commandCodeRefreshModels(draft?: {
		apiKey?: string;
		baseUrl?: string;
		prefix?: string;
	}): Promise<string[]> {
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
