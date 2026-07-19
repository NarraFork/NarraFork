import { request } from "./client";

export interface OAuthGrantClient {
	clientId: string;
	name: string;
}

export interface OAuthGrant {
	id: string;
	client: OAuthGrantClient;
	scopes: string[];
	projectIds: string[];
	consentedAt: string | null;
	lastUsedAt: string | null;
	status: string;
	revokedAt: string | null;
	reason: string | null;
}

export interface OAuthGrantPage {
	items: OAuthGrant[];
	nextCursor: string | null;
}

export interface ListOAuthGrantsParams {
	limit?: number;
	cursor?: string | null;
}

export const OAUTH_GRANTS_MAX_LIMIT = 100;
const DEFAULT_OAUTH_GRANTS_LIMIT = 25;

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_OAUTH_GRANTS_LIMIT;
	return Math.min(OAUTH_GRANTS_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

export const oauthGrantsApi = {
	listOAuthGrants: (
		params: ListOAuthGrantsParams = {},
		signal?: AbortSignal,
	): Promise<OAuthGrantPage> => {
		const search = new URLSearchParams({ limit: String(normalizeLimit(params.limit)) });
		if (params.cursor) search.set("cursor", params.cursor);
		return request<OAuthGrantPage>(`/oauth/grants?${search.toString()}`, { signal });
	},
	getOAuthGrant: (id: string, signal?: AbortSignal): Promise<OAuthGrant> =>
		request<OAuthGrant>(`/oauth/grants/${encodeURIComponent(id)}`, { signal }),
	revokeOAuthGrant: (id: string): Promise<unknown> =>
		request<unknown>(`/oauth/grants/${encodeURIComponent(id)}`, { method: "DELETE" }),
	revokeOAuthGrants: (grantIds: string[]): Promise<unknown> =>
		request<unknown>("/oauth/grants/revoke-batch", {
			method: "POST",
			body: JSON.stringify({ grantIds }),
		}),
	revokeAllOAuthGrants: (): Promise<unknown> =>
		request<unknown>("/oauth/grants/revoke-all", {
			method: "POST",
			body: JSON.stringify({ confirm: true }),
		}),
};
