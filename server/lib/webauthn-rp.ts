/**
 * WebAuthn relying-party (RP) resolution — pure logic, no database access.
 *
 * Split out from lib/webauthn.ts so it can be unit-tested without pulling in the
 * database layer.
 *
 * RP resolution strategy
 * ----------------------
 * WebAuthn ties credentials to a Relying Party ID (a domain) and verifies the
 * ceremony origin. NarraFork is self-hosted and reached via many hostnames
 * (localhost, LAN IPs/names, custom domains), so by default we DERIVE the rpID
 * and origin from each request's `Origin` header. This makes passkeys work with
 * zero configuration. `settings.auth.webauthn` can pin a fixed rpID/origins for
 * advanced reverse-proxy deployments.
 */
import { AppError } from "./errors";
import { settings } from "./settings";

export interface ResolvedRp {
	rpID: string;
	rpName: string;
	/** The single origin for this request (used as expectedOrigin). */
	origin: string;
	/** All origins accepted during verification (configured ∪ request origin). */
	expectedOrigins: string[];
}

const DEFAULT_RP_NAME = "NarraFork";

/**
 * Derive relying-party parameters for a ceremony from the request Origin header,
 * honoring optional settings overrides.
 *
 * Throws when no usable origin can be determined (e.g. missing Origin header and
 * no configured origins).
 */
export function resolveRp(originHeader: string | undefined | null): ResolvedRp {
	const cfg = settings.auth.webauthn;
	const rpName = cfg?.rpName?.trim() || DEFAULT_RP_NAME;
	const configuredOrigins = (cfg?.origins ?? []).map((o) => o.trim()).filter(Boolean);

	let requestOrigin: string | undefined;
	let requestHost: string | undefined;
	if (originHeader) {
		try {
			const u = new URL(originHeader);
			requestOrigin = u.origin;
			requestHost = u.hostname;
		} catch {
			// Ignore an unparseable Origin header.
		}
	}

	// rpID: explicit config wins; otherwise the request hostname.
	const rpID = cfg?.rpID?.trim() || requestHost;
	if (!rpID) {
		throw new AppError("Unable to determine WebAuthn relying party", 400, "WEBAUTHN_NO_RP");
	}

	// Origin used to label this ceremony: prefer the request origin, else the
	// first configured origin.
	const origin = requestOrigin || configuredOrigins[0];
	if (!origin) {
		throw new AppError("Unable to determine request origin", 400, "WEBAUTHN_NO_ORIGIN");
	}

	// Accept the configured origins plus the live request origin on verify.
	const expectedOrigins = Array.from(new Set([...configuredOrigins, origin]));

	return { rpID, rpName, origin, expectedOrigins };
}
