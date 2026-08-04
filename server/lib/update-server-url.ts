/**
 * update-server-url.ts — Trust predicate for the configured update-server origin.
 *
 * Lives in `lib/` rather than in `services/update-service.ts` because BOTH sides of
 * the setting need it: the service filters at read time (an untrusted value degrades
 * to "no update server"), and the settings Zod schema rejects it at write time so an
 * administrator gets a 400 instead of a silent downgrade. A route importing a service
 * for one predicate would invert the dependency direction; the service re-exports
 * this instead, keeping every existing import path working.
 */

/**
 * Hosts allowed to serve updates over plaintext HTTP, for local test servers.
 * `URL.hostname` keeps the brackets on an IPv6 literal, so the bracketed form is listed too.
 */
const PLAINTEXT_UPDATE_HOST_ALLOWLIST = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * Whether an update-server base URL is allowed to be used as a code-delivery origin.
 *
 * TLS is currently the only trust anchor for update payloads: the expected SHA-512 arrives from
 * the same response as the download, so it proves transport integrity and nothing more. Over
 * plaintext HTTP a man in the middle can rewrite the metadata and the payload together and
 * obtain code execution under the NarraFork user. A loopback exception keeps the documented
 * local test-server workflow available, where there is no network to intercept.
 *
 * An empty string is NOT trusted here: this answers "may we fetch code from this origin", and
 * there is no origin. The settings schema treats `""` separately as "clear the override" and the
 * service treats it as "not configured", both of which are decisions about absence, not trust.
 */
export function isTrustedUpdateServerUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "https:") return true;
		if (parsed.protocol !== "http:") return false;
		return PLAINTEXT_UPDATE_HOST_ALLOWLIST.has(parsed.hostname);
	} catch {
		return false;
	}
}
