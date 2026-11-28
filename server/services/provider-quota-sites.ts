import { ProviderQuotaError } from "@server/lib/provider-quota-async";

export interface SiteQuotaSettings {
	baseUrl: string;
	quotaSiteUrl?: string;
	quotaAccessToken?: string;
	quotaUserId?: string;
}

/** Any field opts into an authoritative site-account query, never a key-query fallback. */
export function hasSiteQuotaConfig(config: Partial<SiteQuotaSettings>): boolean {
	return [config.quotaSiteUrl, config.quotaAccessToken, config.quotaUserId].some(
		(value) => typeof value === "string" && value.trim().length > 0,
	);
}

export function buildQuotaRoots(baseUrl: string): string[] {
	if (!baseUrl || baseUrl.length > 2048 || /[?#\\\s]/u.test(baseUrl)) {
		throw new ProviderQuotaError("invalid_configuration");
	}
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new ProviderQuotaError("invalid_configuration");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw new ProviderQuotaError("invalid_configuration");
	}
	const original = url.origin + url.pathname.replace(/\/+$/, "");
	const stripped = original.replace(/\/(?:v1|v1beta|anthropic)$/, "");
	return stripped === original ? [original] : [stripped, original];
}

/** Credential-free root metadata. Validation never needs to disclose the site token. */
export function siteQuotaRoot(config: SiteQuotaSettings): string | null {
	try {
		return buildQuotaRoots(config.quotaSiteUrl?.trim() || config.baseUrl)[0] ?? null;
	} catch {
		return null;
	}
}

/** Invalid destinations never match, even when both fail to normalize. Keep tenant paths in scope. */
export function sameSiteQuotaRoot(saved: SiteQuotaSettings, next: SiteQuotaSettings): boolean {
	const root = siteQuotaRoot(saved);
	return root !== null && root === siteQuotaRoot(next);
}

/** Host-private resolution, used only while validating and injecting a saved connection. */
export function resolveSiteQuotaConfig(config: SiteQuotaSettings): {
	root: string;
	accessToken: string;
	userId: string;
} {
	const root = siteQuotaRoot(config);
	const accessToken = config.quotaAccessToken?.trim() ?? "";
	const userId = config.quotaUserId?.trim() ?? "";
	if (
		!root ||
		!accessToken ||
		!userId ||
		accessToken.length > 4096 ||
		userId.length > 128 ||
		[...(accessToken + userId)].some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		)
	) {
		throw new ProviderQuotaError("invalid_configuration");
	}
	return { root, accessToken, userId };
}

export function balanceRootCandidates(config: SiteQuotaSettings): string[] {
	return hasSiteQuotaConfig(config)
		? [resolveSiteQuotaConfig(config).root]
		: buildQuotaRoots(config.baseUrl);
}
