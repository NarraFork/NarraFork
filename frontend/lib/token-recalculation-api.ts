import type { TokenRecalculationJob, TokenRecalculationRange } from "@shared/token-recalculation";
import { request } from "./api/client";

export const TOKEN_RECALCULATION_QUERY_KEY = ["token-recalculation"] as const;
const PATH = "/usage-history/token-recalculation";

export const tokenRecalculationApi = {
	get(signal?: AbortSignal) {
		return request<{ job: TokenRecalculationJob | null }>(PATH, { signal });
	},
	start(range: TokenRecalculationRange) {
		return request<{ job: TokenRecalculationJob }>(PATH, {
			method: "POST",
			body: JSON.stringify(range),
		});
	},
	cancel(id: string) {
		return request<{ job: TokenRecalculationJob }>(`${PATH}/${encodeURIComponent(id)}/cancel`, {
			method: "POST",
		});
	},
};
