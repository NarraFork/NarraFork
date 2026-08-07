/**
 * Ambient proxy environment neutralization.
 *
 * Bun's `fetch()` consults the ambient `HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY`
 * environment variables, and — as of Bun 1.3.14 — the per-request `proxy` option
 * provides NO way to opt out: `proxy: ""`, `proxy: undefined`, `proxy: null` and
 * omitting the key entirely are all still routed through the ambient proxy.
 * Verified behaviour on Bun 1.3.14 for an `https://` target with `HTTPS_PROXY`
 * exported: every one of those forms produced a CONNECT to the proxy.
 *
 * That silently breaks NarraFork's proxy policy. A user who selects "direct"
 * globally, or "direct" as a per-provider override, still has their traffic sent
 * through whatever proxy the shell exported, with no indication in the UI. The
 * settings screen becomes advisory rather than authoritative.
 *
 * `NO_PROXY=*` is not a usable workaround: it suppresses explicitly configured
 * per-request proxies too, so "custom"/"system" modes would stop working.
 *
 * `delete process.env.HTTPS_PROXY` is also not a workaround: Bun's `delete` does
 * not reach the native environment that `fetch()` reads, so the proxy keeps
 * being applied. Assigning the empty string DOES propagate and is honoured as
 * "no proxy".
 *
 * Therefore: snapshot the ambient values once at startup, then blank them in the
 * process environment. From that point on the ONLY thing that decides whether a
 * request is proxied is the explicit per-request `proxy` value that
 * `outbound-fetch.ts` passes, which is exactly what the settings policy
 * computes. `detectSystemProxy()` reads the snapshot, so "system" mode keeps
 * working.
 *
 * Subprocesses (user shells, git, podman, the agent Bash tool) must NOT inherit
 * the blanked values — their proxy needs are the user's, not ours — so they are
 * spawned with {@link proxyEnvForSubprocess}, which restores the original values.
 */

/** Proxy variables Bun's fetch consults, in both canonical casings. */
const PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
] as const;

type ProxyEnvSnapshot = Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>>;

/**
 * The ambient values as they were before neutralization. Populated by
 * {@link neutralizeAmbientProxyEnv}; empty until then, which makes "system" mode
 * resolve to "no proxy" rather than to a stale value.
 */
let snapshot: ProxyEnvSnapshot = {};
let neutralized = false;

/**
 * Snapshot and blank the ambient proxy environment.
 *
 * MUST run before the first outbound `fetch()`, hence its position at the very
 * top of the server entrypoint. Idempotent: a second call is a no-op, so it
 * cannot clobber the snapshot with the already-blanked values.
 */
export function neutralizeAmbientProxyEnv(): void {
	if (neutralized) return;
	neutralized = true;

	const captured: ProxyEnvSnapshot = {};
	for (const key of PROXY_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined && value !== "") captured[key] = value;
	}
	snapshot = captured;

	for (const key of PROXY_ENV_KEYS) {
		// Assignment rather than `delete`: only assignment reaches the native
		// environment Bun's fetch reads. An empty value is honoured as "no proxy".
		if (process.env[key] !== undefined) process.env[key] = "";
	}
}

/**
 * The ambient proxy URL the process was started with, in the standard precedence
 * order (HTTPS → HTTP → ALL). This is what "system" proxy mode resolves to.
 *
 * Reads the snapshot rather than `process.env`, because the live environment has
 * been deliberately blanked.
 */
export function ambientSystemProxy(): string | undefined {
	return (
		snapshot.HTTPS_PROXY ||
		snapshot.https_proxy ||
		snapshot.HTTP_PROXY ||
		snapshot.http_proxy ||
		snapshot.ALL_PROXY ||
		snapshot.all_proxy ||
		undefined
	);
}

/** The ambient `NO_PROXY` value the process was started with. */
export function ambientNoProxy(): string {
	return snapshot.NO_PROXY || snapshot.no_proxy || "";
}

/**
 * Proxy variables to merge into a subprocess environment so external tools keep
 * the user's own proxy configuration. Returns the original ambient values, or an
 * empty object when the process had none.
 */
export function proxyEnvForSubprocess(): Record<string, string> {
	return { ...snapshot };
}

/**
 * A subprocess environment with the user's ambient proxy variables restored.
 *
 * Use this instead of a bare `{ ...process.env }` for anything the user drives
 * (shells, the agent Bash tool) or that talks to a network the user configured
 * (git remotes, container registries). NarraFork's own outbound requests go
 * through `outbound-fetch.ts` and must not use this.
 */
export function envWithAmbientProxy(
	extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return { ...process.env, ...proxyEnvForSubprocess(), ...extra };
}

/** Test-only: reset module state so a test can exercise the snapshot logic. */
export function resetProxyEnvStateForTest(): void {
	snapshot = {};
	neutralized = false;
}
