/** Normalized, credential-free projections of relay wallet/key allowances. */
/**
 * `new-api-user` is the site-account credit query: it authenticates with the site's system
 * access token plus the user id and reads `quota`/`used_quota` from `/api/user/self`, unlike
 * `new-api`, which reads a single key's usage from `/api/usage/token/`.
 */
export type ProviderBalanceAdapter = "sub2api" | "new-api" | "new-api-user";
export type ProviderBalanceScope = "wallet" | "key" | "subscription";
export type ProviderBalanceStatus = "pending" | "probing" | "supported" | "unsupported" | "error";

export interface ProviderBalanceAmount {
	/** USD/CNY/TOKENS/QUOTA or a validated site currency symbol. */
	unit: string;
	remaining: number | null;
	used?: number;
	total?: number;
	/** For example 5h, 1d, 7d, daily, weekly or monthly. */
	window?: string;
	/** Upstream-reported window start, ISO timestamp; not a reset-time guarantee. */
	windowStart?: string;
}

export interface ProviderBalanceData {
	scope: ProviderBalanceScope;
	unlimited: boolean;
	amounts: ProviderBalanceAmount[];
	/** Subscription metadata only; optional on older upstream deployments. */
	planName?: string;
	expiresAt?: string;
}

/**
 * Failure classification of one balance round.
 *
 * `request_failed` is transient (network error, timeout, 5xx, 429): the caller may retry and
 * may keep showing the last good value for a short window. Every other code is
 * deterministic: retrying the same configuration cannot help, so the value is surfaced
 * immediately and any previously cached allowance must be dropped instead of being revived by
 * a later network blip.
 */
export type ProviderBalanceError =
	/** Transient transport or upstream availability failure. */
	| "request_failed"
	/** Local configuration cannot address a quota endpoint (missing token, user id or root). */
	| "invalid_configuration"
	/** 401/403: the site access token or user id was rejected. */
	| "auth_failed"
	/** The endpoint answered, but not with the allowance shape this adapter requires. */
	| "invalid_response"
	/**
	 * The `apikey-quota` plugin owns this capability and an administrator disabled it. Being a
	 * configuration state rather than a transport failure, it is deterministic: no retry can
	 * change the answer, and re-enabling the plugin is the only fix.
	 */
	| "plugin_not_enabled";

export interface ProviderBalanceSnapshot {
	generation: string;
	status: ProviderBalanceStatus;
	adapter?: ProviderBalanceAdapter;
	balance: ProviderBalanceData | null;
	fetchedAt: number;
	attemptedAt: number;
	/** Safe fixed codes only, never upstream response text or transport exceptions. */
	error: ProviderBalanceError | null;
}
