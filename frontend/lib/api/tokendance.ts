import type {
	TokenDanceBalance,
	TokenDanceCatalogModel,
	TokenDanceDraftRestore,
	TokenDanceDraftSnapshot,
	TokenDanceOAuthComplete,
	TokenDanceOAuthStart,
	TokenDancePaymentCreate,
	TokenDancePaymentSession,
	TokenDancePublicConnection,
} from "@shared/tokendance";
import {
	apiBase,
	authorizedFetch,
	pickRequestOptions,
	type RequestOptions,
	request,
} from "./client";

function transport(options?: RequestOptions, maxResponseBytes = 2 * 1024 * 1024) {
	const picked = pickRequestOptions(options);
	const timeout = AbortSignal.timeout(60_000);
	return {
		...picked,
		maxResponseBytes: Math.min(picked.maxResponseBytes ?? maxResponseBytes, maxResponseBytes),
		signal: picked.signal ? AbortSignal.any([picked.signal, timeout]) : timeout,
	};
}
function post<T>(path: string, data: unknown, options?: RequestOptions) {
	return request<T>(`/tokendance/${path}`, {
		method: "POST",
		body: JSON.stringify(data),
		...transport(options),
	});
}
export const tokendanceApi = {
	tokenDanceBalance: (options?: RequestOptions) =>
		request<TokenDanceBalance>("/tokendance/balance", transport(options, 32_768)),
	tokenDanceRefreshBalance: (options?: RequestOptions) =>
		post<TokenDanceBalance>("balance/refresh", {}, options),
	tokenDanceCreatePayment: (data: TokenDancePaymentCreate, options?: RequestOptions) =>
		post<{ session: TokenDancePaymentSession }>("payment/sessions", data, options),
	tokenDancePaymentSession: (id: string, options?: RequestOptions) =>
		request<{ session: TokenDancePaymentSession }>(
			`/tokendance/payment/sessions/${encodeURIComponent(id)}`,
			transport(options, 32_768),
		),
	tokenDanceOAuthStart: (
		data: { callbackUrl: string; draftSnapshot?: TokenDanceDraftSnapshot },
		options?: RequestOptions,
	) => post<TokenDanceOAuthStart>("oauth/start", data, options),
	tokenDanceOAuthComplete: (data: { flowId: string; code: string }, options?: RequestOptions) =>
		post<TokenDanceOAuthComplete>("oauth/complete", data, options),
	tokenDanceOAuthCancel: (flowId: string, options?: RequestOptions) =>
		post<unknown>("oauth/cancel", { flowId }, options),
	tokenDanceDraftRestore: (flowId: string, options?: RequestOptions) =>
		post<TokenDanceDraftRestore>("oauth/restore", { flowId }, options),
	tokenDanceConnection: (options?: RequestOptions) =>
		request<TokenDancePublicConnection>("/tokendance/connection", transport(options)),
	tokenDanceRefreshModels: (options?: RequestOptions) =>
		post<{ models: TokenDanceCatalogModel[] }>("models/refresh", {}, options),
	tokenDanceUpdateConnection: (disabled: boolean, options?: RequestOptions) =>
		request<TokenDancePublicConnection>("/tokendance/connection", {
			method: "PATCH",
			body: JSON.stringify({ disabled }),
			...transport(options),
		}),
	tokenDanceDeleteConnection: async (options?: RequestOptions) => {
		const response = await authorizedFetch(`${apiBase()}/tokendance/connection`, {
			method: "DELETE",
			signal: transport(options).signal,
		});
		if (!response.ok) throw new Error("TokenDance operation failed");
		await response.body?.cancel();
	},
};
