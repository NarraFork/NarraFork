/**
 * Auth-settings masking helpers — pure functions with no database or provider
 * dependencies, so they can be unit-tested in isolation (importing the settings
 * route would otherwise pull in the whole provider/db chain).
 *
 * Used to redact secrets from the `auth` block before it is returned to clients
 * (GET /settings, GET /admin/auth-config) and to detect masked values on write
 * so a redacted value sent back by the UI never overwrites the real secret.
 */
import type { NarraForkSettings } from "./settings/types";

type AuthSettings = NarraForkSettings["auth"];

/** Mask a secret as 8 stars + last 4 chars (short secrets become all stars). */
export function maskSecret(value?: string): string {
	if (!value) return "";
	if (value.length <= 4) return "*".repeat(value.length);
	return `${"*".repeat(8)}${value.slice(-4)}`;
}

/**
 * Whether a value looks like a masked secret (or is empty). Such values must NOT
 * be persisted — the existing stored secret should be kept instead.
 *
 * We match the masked SHAPE produced by `maskSecret` (a run of leading stars,
 * optionally followed by the last 4 chars) by testing for a leading `*`, rather
 * than `value.includes("*")`. A real OIDC client secret can legitimately contain
 * a `*` anywhere in the middle; `includes` would misclassify it as masked and
 * silently drop it (keeping the stale/empty stored value). A leading `*` cannot
 * occur in a `maskSecret` output for a non-masked value, so prefix-matching is
 * the precise test.
 */
export function isMaskedSecret(value: string | undefined | null): boolean {
	if (!value) return true; // empty → keep existing
	return value.startsWith("*");
}

/**
 * Produce a client-safe view of the auth settings:
 *  - `jwtSecret` removed entirely;
 *  - each OIDC provider's `clientSecret` masked;
 *  - all non-secret fields (issuer, clientId, scopes, …) and webauthn config
 *    preserved as-is.
 */
export function maskAuthSettings(auth: AuthSettings): Omit<AuthSettings, "jwtSecret"> {
	const { jwtSecret: _jwtSecret, oidcProviders, ...rest } = auth;
	return {
		...rest,
		oidcProviders: oidcProviders?.map((p) => ({
			...p,
			clientSecret: maskSecret(p.clientSecret),
		})),
	};
}
