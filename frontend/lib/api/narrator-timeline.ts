import type { TimelineTurnsResponse, TurnTimelineResponse } from "@shared/narrator-timeline";
import { request } from "./client";

export const narratorTimelineApi = {
	turns: (narratorId: string, options: { before?: string; limit?: number } = {}) => {
		const params = new URLSearchParams();
		if (options.before) params.set("before", options.before);
		if (options.limit) params.set("limit", String(options.limit));
		const query = params.toString();
		return request<TimelineTurnsResponse>(
			`/narrators/${narratorId}/timeline/turns${query ? `?${query}` : ""}`,
		);
	},
	turn: (narratorId: string, turnId?: string) =>
		request<TurnTimelineResponse>(
			`/narrators/${narratorId}/timeline${turnId ? `?turnId=${encodeURIComponent(turnId)}` : ""}`,
		),
};
