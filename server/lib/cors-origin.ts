/**
 * cors-origin.ts — Which cross-origin callers may read `/api/*` responses.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * NarraFork's own UI is same-origin, so for years the allowed origin could be a single
 * hard-coded string. An embedded front end changes that: the VS Code extension renders
 * the SPA inside a webview whose origin is NOT the backend's — `vscode-webview://<uuid>`
 * in desktop VS Code, and code-server's own origin in the browser build.
 *
 * WHY THIS IS NOT AN AUTHORIZATION HOLE
 * ------------------------------------
 * ⚠️ Read this before widening anything here.
 *
 * The allowance below is safe for exactly ONE reason: NarraFork authenticates with an
 * `Authorization: Bearer` header and nothing else. `server/middleware/auth.ts` reads
 * only that header — there is no cookie path anywhere in the request pipeline. Browsers
 * never attach a bearer header on their own, so a hostile page that reaches this origin
 * still has no credential and sees only what an unauthenticated caller sees (health,
 * branding, changelog, licenses — all already public by design).
 *
 * If session cookies are ever introduced, this file becomes an ambient-authority
 * vulnerability the same day, because a browser DOES attach cookies automatically. Any
 * change that adds a cookie must revisit this allowance, not just add a cookie.
 *
 * WHY LOOPBACK IS ALLOWED WITHOUT CONFIGURATION
 * ---------------------------------------------
 * The desktop webview's origin carries a random UUID, so it cannot be enumerated in
 * advance and a configuration-only policy would mean "paste a new origin every window".
 * Loopback additionally means the caller is a process on this machine, which already has
 * the filesystem access needed to read `~/.narrafork/settings.json` — CORS is not what
 * stands between it and the data.
 *
 * A NOTE ON `null`
 * ----------------
 * A `null` Origin (sandboxed iframe, `file://`, some redirects) is deliberately NOT
 * allowed. It is unattributable, so allowing it would let any sandboxed document read
 * responses while making the allowance impossible to reason about — and no front end we
 * ship needs it.
 */

/** Hosts that are loopback by definition, regardless of port. */
function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost") return true;
	if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
	// The whole 127.0.0.0/8 block, not just 127.0.0.1: browsers and tooling use
	// 127.0.0.2+ for isolation, and they are equally local.
	const octets = host.split(".");
	return (
		octets.length === 4 &&
		octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
		octets[0] === "127"
	);
}

/**
 * Origins belonging to an editor host embedding our UI.
 *
 * `vscode-webview:` is desktop VS Code's webview scheme; its authority is a per-webview
 * random UUID, which is why the scheme rather than a full origin is matched. Only the
 * scheme is trusted — the authority is not inspected, because there is nothing stable
 * in it to check and no other party can mint this scheme in a browser context.
 */
const EDITOR_HOST_SCHEMES = new Set(["vscode-webview:", "vscode-file:"]);

export interface CorsOriginPolicy {
	/** The server's own origin, always allowed. May be omitted when unknown. */
	selfOrigin?: string | null;
	/** Extra origins from `settings.server.allowedOrigins`, matched verbatim. */
	configured?: readonly string[];
	/**
	 * Dev-server origins, allowed only when the backend is running in dev mode.
	 * Kept separate from `configured` so a production instance cannot inherit them.
	 */
	devOrigins?: readonly string[];
}

/**
 * Decide whether `origin` may read `/api/*` responses.
 *
 * Returns the origin to echo back in `Access-Control-Allow-Origin`, or `null` to refuse.
 * Returning the request's origin verbatim (rather than `*`) keeps the response usable by
 * a caller that sends credentials, and keeps the header truthful about who was allowed.
 */
export function resolveAllowedCorsOrigin(
	origin: string | undefined | null,
	policy: CorsOriginPolicy,
): string | null {
	// No Origin header: not a cross-origin request the browser is policing (curl, a
	// server-to-server call, a same-origin navigation). Nothing to allow or refuse.
	if (!origin) return null;
	// Literal "null" is the serialized opaque origin — see the header note.
	if (origin === "null") return null;

	if (policy.selfOrigin && origin === policy.selfOrigin) return origin;
	if (policy.configured?.includes(origin)) return origin;
	if (policy.devOrigins?.includes(origin)) return origin;

	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return null;
	}

	if (EDITOR_HOST_SCHEMES.has(parsed.protocol)) return origin;

	// Loopback over http/https only. Refusing other schemes keeps this from becoming a
	// general "anything mentioning localhost" allowance.
	if (
		(parsed.protocol === "http:" || parsed.protocol === "https:") &&
		isLoopbackHostname(parsed.hostname)
	) {
		return origin;
	}

	return null;
}

/** Normalize configured origins to their canonical serialization, dropping junk. */
export function normalizeConfiguredOrigins(values: readonly string[] | undefined): string[] {
	if (!values) return [];
	const normalized: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		// A configured entry with a path is a misconfiguration rather than a stricter
		// rule: `Origin` never carries one, so it could never match and the operator
		// would see a silent refusal. Normalizing to the origin makes the intent work.
		try {
			normalized.push(new URL(trimmed).origin);
		} catch {
			// Unparseable entries are skipped rather than compared verbatim: a verbatim
			// comparison against a malformed value can only ever fail to match, so keeping
			// it would just be a permanent no-op the operator cannot see.
		}
	}
	return normalized;
}
