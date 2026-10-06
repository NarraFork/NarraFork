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

export interface RevokeAllOAuthGrantsResult {
	revokedCount: number;
	hasMore: false;
}

export class RevokeAllOAuthGrantsError extends Error {
	readonly revokedCount: number;
	readonly batchCount: number;
	readonly hasMore: boolean;

	constructor(
		message: string,
		progress: { revokedCount: number; batchCount: number; hasMore: boolean },
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "RevokeAllOAuthGrantsError";
		this.revokedCount = progress.revokedCount;
		this.batchCount = progress.batchCount;
		this.hasMore = progress.hasMore;
	}
}

interface RevokeOAuthGrantBatchResult {
	revokedCount: number;
	hasMore: boolean;
}

function revokeAllErrorMessage(error: unknown, revokedCount: number, batchCount: number): string {
	const detail = error instanceof Error && error.message ? error.message : "Request failed";
	if (revokedCount === 0 && batchCount === 0) return detail;
	const grantLabel = revokedCount === 1 ? "grant" : "grants";
	const batchLabel = batchCount === 1 ? "batch" : "batches";
	return `OAuth grant revocation stopped after revoking ${revokedCount} ${grantLabel} in ${batchCount} ${batchLabel}: ${detail}`;
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
	revokeAllOAuthGrants: async (signal?: AbortSignal): Promise<RevokeAllOAuthGrantsResult> => {
		let revokedCount = 0;
		let batchCount = 0;
		let hasMore = true;
		for (;;) {
			let page: RevokeOAuthGrantBatchResult;
			try {
				page = await request<RevokeOAuthGrantBatchResult>("/oauth/grants/revoke-all", {
					method: "POST",
					body: JSON.stringify({ confirm: true }),
					signal,
				});
			} catch (error) {
				throw new RevokeAllOAuthGrantsError(
					revokeAllErrorMessage(error, revokedCount, batchCount),
					{ revokedCount, batchCount, hasMore },
					{ cause: error },
				);
			}

			batchCount += 1;
			revokedCount += page.revokedCount;
			hasMore = page.hasMore;
			if (!hasMore) return { revokedCount, hasMore: false };
			if (page.revokedCount === 0) {
				throw new RevokeAllOAuthGrantsError(
					revokeAllErrorMessage(
						new Error("OAuth grant revocation made no progress"),
						revokedCount,
						batchCount,
					),
					{ revokedCount, batchCount, hasMore },
				);
			}
		}
	},
};
