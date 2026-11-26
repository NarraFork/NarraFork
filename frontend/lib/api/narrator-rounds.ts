import type { NarratorRoundsPage } from "@shared/narrator-rounds";
import { request } from "./client";

/**
 * 轮次索引（导航轨的数据源）。
 *
 * 与 `narrator-timeline` 的区别：那个是「这一轮的时间花在哪了」（性能分析），
 * 这个是「会话里有哪几轮」（导航）。
 */
export const narratorRoundsApi = {
	rounds: (narratorId: string, options: { beforeSeq?: number; limit?: number } = {}) => {
		const params = new URLSearchParams();
		if (typeof options.beforeSeq === "number") params.set("beforeSeq", String(options.beforeSeq));
		if (options.limit) params.set("limit", String(options.limit));
		const query = params.toString();
		return request<NarratorRoundsPage>(
			`/narrators/${narratorId}/rounds${query ? `?${query}` : ""}`,
		);
	},
};
