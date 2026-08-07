/**
 * Consumption of `hostHints`, the per-call advice the host attaches to provider requests.
 *
 * ## Why this is its own module
 *
 * `server.ts` calls `listen()` and writes a `hello` frame at import time, so importing it
 * from a test would take over stdio. Keeping this logic separate means the real
 * implementation can be tested directly instead of a copy of it re-declared inside a test,
 * which would keep passing after the original changed.
 *
 * ## Absent `hostHints` means "no proxy", not "no opinion"
 *
 * that plugin's rule is wrong against the host it talks to. Verified in
 * `plugin-provider-adapter-factory.ts` `injectHints()` and
 * `plugin-platform-services.ts` `resolveProviderHostHints()`:
 *
 * - the host builds hints **only** when a proxy exists (`if (!proxyUrl) return undefined`);
 * - `injectHints` then attaches the field **only** when it is non-empty
 *   (`if (!hints.outbound?.proxyUrl && !hints.concurrency?...) return params`).
 *
 * So the host never sends a present-but-empty `hostHints`. Absent is the *only* way it can
 * last value" and clears only on a present-but-empty block — which the host never sends.
 * The consequence there is a real bug: once a proxy has been used, removing it from host
 * settings leaves the plugin routing upstream traffic through the deleted proxy for the
 * rest of the process lifetime. That is precisely the failure its own comment describes,
 * guarded on the branch that cannot happen.
 *
 * Clearing on absent is safe because `applyHostHints` is only called from provider methods
 * that carry `config` (chat, generate, listModels, validateConfig) — all of which go through
 * `injectHints`. It is never called for `provider.describe`, which carries no hints and
 * makes no network calls.
 *
 * ## Why the proxy lives in a module-level variable
 *
 * The host resolves one proxy from its own settings and sends the same value to every call,
 * so concurrent requests race only to write identical strings. Callers read it synchronously
 * while building a request, so the value read is the one the current call just set. If the
 * host ever routes per-request proxies this would need AsyncLocalStorage; it does not, so it
 * does not.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

let currentProxyUrl: string | undefined;

/** The proxy currently in effect, to be passed to `pfetch`. */
export function activeProxyUrl(): string | undefined {
	return currentProxyUrl;
}

/**
 * Apply the `hostHints` block of a provider request.
 *
 * SECURITY: `outbound.proxyUrl` may carry credentials in its userinfo component. It is
 * never logged and never leaves this module except through `activeProxyUrl`.
 */
export function applyHostHints(params: unknown): void {
	const hostHints = isRecord(params) ? params.hostHints : undefined;
	const outbound = isRecord(hostHints) ? hostHints.outbound : undefined;
	const proxyUrl = isRecord(outbound) ? outbound.proxyUrl : undefined;
	// Assign unconditionally, including to `undefined`: see the header — absent hints are
	// the host stating it has no proxy, so a previously applied proxy must stop being used.
	currentProxyUrl = typeof proxyUrl === "string" && proxyUrl ? proxyUrl : undefined;
	// `concurrency.maxConcurrentUpstream` is deliberately not consumed: the host does not
	// send it, because the only value it could compute is the one this plugin declared for
	// itself (verified — `resolveProviderHostHints` populates `outbound` only). Reading it
	// into an unused variable would be dead code that looks load-bearing.
}

/** Test seam: forget the applied proxy so cases do not leak into one another. */
export function resetHostHints(): void {
	currentProxyUrl = undefined;
}
