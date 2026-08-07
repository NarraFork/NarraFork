/**
 * Credential storage. The host vault is the only persistent store.
 *
 * ## Two arrival paths, one store
 *
 * - **Provider calls** (`chat`, `generate`, `listModels`, `validateConfig`) receive the
 *   credential already resolved in `config`: the host reads every field its `configSchema`
 *   marks secret and merges it in (`plugin-provider-credential-resolver.ts`). Zero extra
 *   round-trips.
 * - **Commands** do not. `commands.invoke` forwards only `{contributionId, input, context}`
 *   (`plugin-command-registry.ts`), and the iframe's `commands.execute` params are a
 *   `.strict()` `{commandId, input, idempotencyKey, expectedVersion}` — there is no field
 *   through which config could travel. So commands read the vault directly over
 *   `secrets.get`.
 *
 * reads `input.config`. That works in its e2e test, which passes `{config, ...input}` by
 * hand, and yields `undefined` in production. Every command here goes through
 * {@link loadCredentials} instead.
 *
 * ## Refresh is deduplicated, and that is not an optimisation
 *
 * Two concurrent turns can both find the token expired. Upstream may rotate the refresh
 * token on use, so two refreshes racing means the second overwrites the first's rotated
 * token with one upstream has already retired — the account is then locked out until the user
 * signs in again. A single in-flight promise makes the second caller await the first's result.
 */

import { createHash } from "node:crypto";
import { accountBaseFrom, type ClineCredentials, isTokenExpired, refreshAccessToken } from "./auth";
import { isRecord, log, request } from "./rpc";

/**
 * Vault keys owned by this plugin.
 *
 * The shape is fixed by the host: `provider.<contributionId>.<field>`, validated on write by
 * `plugin-command-secret-writes.ts` against the contributions this plugin actually registered.
 * `cline` is this plugin's provider contribution id (the manifest's `contributes.providers[0].id`),
 * not its prefix — `cline-ext` is the user-facing prefix and appears in neither key.
 */
export const CREDENTIALS_KEY = "provider.cline.credentials";
export const ENABLED_MODELS_KEY = "provider.cline.enabledModels";

/** Raised when stored credentials exist but cannot be read. */
export class InvalidCredentialsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidCredentialsError";
	}
}

/** Raised when no credential is stored at all. */
export class MissingCredentialError extends Error {
	constructor(message = "Cline is not signed in") {
		super(message);
		this.name = "MissingCredentialError";
	}
}

function text(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse a stored credential blob.
 *
 * A malformed blob throws rather than degrading to "not signed in". Silently reporting a
 * configured account as unconfigured would send the user to sign in again over what may be a
 * recoverable read problem, and the second sign-in would overwrite whatever was there.
 */
export function parseCredentials(raw: string): ClineCredentials {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new InvalidCredentialsError("Stored Cline credentials are not valid JSON");
	}
	if (!isRecord(parsed)) {
		throw new InvalidCredentialsError("Stored Cline credentials are not an object");
	}
	const accessToken = text(parsed.accessToken);
	const refreshToken = text(parsed.refreshToken);
	if (!accessToken || !refreshToken) {
		throw new InvalidCredentialsError("Stored Cline credentials are missing a token");
	}
	const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0;
	const startedAt = typeof parsed.startedAt === "number" ? parsed.startedAt : Date.now();
	return {
		accessToken,
		refreshToken,
		// A missing or non-numeric expiry is treated as already expired rather than as
		// "never expires": a refresh that turns out to be unnecessary costs one request,
		// while assuming validity would send a dead token upstream on every turn.
		expiresAt,
		email: text(parsed.email) ?? "",
		displayName: text(parsed.displayName) ?? "",
		...(text(parsed.userId) ? { userId: text(parsed.userId) as string } : {}),
		startedAt,
	};
}

export function serializeCredentials(credentials: ClineCredentials): string {
	return JSON.stringify(credentials);
}

/** Read the stored credential over RPC, or undefined when nothing is stored. */
export async function loadCredentials(): Promise<ClineCredentials | undefined> {
	const result = await request("secrets.get", { key: CREDENTIALS_KEY });
	const value = isRecord(result) ? result.value : undefined;
	if (typeof value !== "string" || value.length === 0) return undefined;
	return parseCredentials(value);
}

/** Read the stored credential, or throw a message the settings view can show as-is. */
export async function requireCredentials(): Promise<ClineCredentials> {
	const credentials = await loadCredentials();
	if (!credentials) throw new MissingCredentialError();
	return credentials;
}

/** Persist a credential to the vault. */
export async function storeCredentials(credentials: ClineCredentials): Promise<void> {
	await request("secrets.set", {
		key: CREDENTIALS_KEY,
		value: serializeCredentials(credentials),
	});
	rememberFresh(credentials);
}

/** Remove the stored credential. */
export async function clearCredentials(): Promise<void> {
	await request("secrets.delete", { key: CREDENTIALS_KEY });
	cachedFresh = undefined;
	inFlightRefresh = undefined;
}

/**
 * The last credential known to be fresh, keyed by a digest of the refresh token.
 *
 * Keyed by digest rather than held as a bare object so that a credential replaced out from
 * under this process (a sign-out and sign-in elsewhere, or a rotation written by another
 * call) does not silently keep using a stale access token: the key stops matching and the
 * cache is bypassed.
 *
 * A digest rather than the token itself so no secret is retained as a map key or shows up in
 * a heap dump under an obvious name.
 */
let cachedFresh: { key: string; credentials: ClineCredentials } | undefined;
let inFlightRefresh: Promise<ClineCredentials> | undefined;

function fingerprint(credentials: ClineCredentials): string {
	return createHash("sha256").update(credentials.refreshToken).digest("hex");
}

function rememberFresh(credentials: ClineCredentials): void {
	cachedFresh = { key: fingerprint(credentials), credentials };
}

/** Forget cached state. Called on deactivate so a restart re-reads the vault. */
export function resetCredentialCache(): void {
	cachedFresh = undefined;
	inFlightRefresh = undefined;
}

/**
 * A credential from provider `config`, or undefined when the field is absent.
 *
 * The host omits an unset secret rather than sending an empty string, so absence here means
 * "not signed in" and is reported by the caller, not guessed at.
 */
export function credentialsFromConfig(config: unknown): ClineCredentials | undefined {
	const raw = isRecord(config) ? config.credentials : undefined;
	if (typeof raw !== "string" || raw.length === 0) return undefined;
	return parseCredentials(raw);
}

/**
 * A usable access token, refreshing first when the stored one has expired.
 *
 * `credentials` is what the caller already has: the config-injected value on a provider call,
 * or a vault read on a command path. Passing it in keeps this function free of any assumption
 * about where the credential came from.
 *
 * A refresh writes the result back to the vault, because the refresh token may have rotated
 * and the value the host injects on the next call comes from there. Skipping the write would
 * leave the vault holding a token upstream has already retired.
 */
export async function accessTokenFor(
	credentials: ClineCredentials,
	chatBaseUrl: string | undefined,
	proxyUrl: string | undefined,
): Promise<string> {
	if (!isTokenExpired(credentials)) return credentials.accessToken;

	const key = fingerprint(credentials);
	if (cachedFresh?.key === key && !isTokenExpired(cachedFresh.credentials)) {
		return cachedFresh.credentials.accessToken;
	}
	// A refresh already running for this credential: await it rather than starting a second
	// one. See the header — concurrent refreshes can lose a rotated refresh token.
	if (inFlightRefresh) {
		const settled = await inFlightRefresh;
		return settled.accessToken;
	}

	const attempt = (async (): Promise<ClineCredentials> => {
		const outcome = await refreshAccessToken(credentials, accountBaseFrom(chatBaseUrl), proxyUrl);
		if (outcome.status === "refreshed") {
			await storeCredentials(outcome.credentials);
			log("access token refreshed");
			return outcome.credentials;
		}
		if (outcome.status === "invalid") {
			// The refresh token is rejected, so nothing stored can produce a working token.
			// Clearing it makes the provider report "not signed in", which is actionable,
			// instead of failing every turn with an auth error that looks transient.
			await clearCredentials().catch(() => undefined);
			throw new MissingCredentialError(
				"Cline sign-in has expired. Sign in again from the provider settings.",
			);
		}
		// Transient: leave the stored credential alone so a later call can retry.
		throw new Error(`Could not refresh the Cline access token (${outcome.reason})`);
	})();

	inFlightRefresh = attempt;
	try {
		return (await attempt).accessToken;
	} finally {
		// Cleared regardless of outcome: a failed refresh must not pin every later caller to
		// the same rejected promise.
		if (inFlightRefresh === attempt) inFlightRefresh = undefined;
	}
}

/**
 * The user's enabled-model list.
 *
 * Stored as a JSON array in a secret field. It is not confidential; the secret channel is
 * used because it is the only persistence a plugin command can write that the host then
 * injects back into provider calls (`config.write_self` has no host method behind it). See
 * the plan's decision A, and `docs/plugin-system/cline-external.md`.
 *
 * Unlike a credential, a malformed value degrades to an empty list: this is a preference the
 * user can simply set again, and refusing to serve a model catalog over it would take the
 * whole provider down for a recoverable annoyance.
 */
export function parseEnabledModels(raw: unknown): string[] {
	if (typeof raw !== "string" || raw.length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		log("stored enabledModels is not valid JSON; treating as empty");
		return [];
	}
	if (!Array.isArray(parsed)) {
		log("stored enabledModels is not an array; treating as empty");
		return [];
	}
	const seen = new Set<string>();
	for (const entry of parsed) {
		const id = text(entry);
		if (id) seen.add(id);
	}
	return [...seen];
}

/** Read the enabled-model list from the vault. Used by command paths only. */
export async function loadEnabledModels(): Promise<string[]> {
	const result = await request("secrets.get", { key: ENABLED_MODELS_KEY });
	return parseEnabledModels(isRecord(result) ? result.value : undefined);
}
