/**
 * loopback.ts — Spell a loopback origin the way `asExternalUri` can actually map it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `asExternalUri` only establishes port forwarding for an authority its own regex
 * recognises. That regex is, verbatim from the VS Code bundle code-server ships
 * (`out/vs/workbench/api/node/extensionHostProcess.js`):
 *
 *   const t = /^(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)$/.exec(e.authority);
 *   if (t) return { address: t[1], port: +t[2] };
 *
 * ⚠️ An IPv6 LITERAL does not match it. `http://[::1]:7778` is passed straight through
 * UNCHANGED — no tunnel, no `/proxy/<port>/`. Note that the same file's loopback
 * hostname list DOES include `::1`; it is specifically the port-mapping path that has
 * no IPv6 case. So this is not something a caller can detect by asking VS Code: the
 * call succeeds and returns a URL that simply is not reachable from the browser.
 *
 * That failure is maximally quiet. In desktop VS Code the webview can reach loopback
 * directly, so `[::1]` works and nothing is wrong. In code-server the returned URL
 * points at the USER'S OWN machine, where nothing is listening — and because a CSP
 * source list cannot express a bracketed IPv6 host either, the `frame-src` entry is
 * discarded and the directive collapses to `'none'`, which is what produced:
 *
 *   The source list for the CSP directive 'frame-src' contains an invalid source:
 *   'http://[::1]:7778'. It will be ignored.
 *   Framing 'http://[::1]:7778/' violates ... "frame-src 'none'".
 *
 * WHY REWRITING IS SAFE
 * ---------------------
 * `::1` and `127.0.0.1` are the same machine by definition, and `localhost` is the
 * name that resolves to whichever family is actually listening. Rewriting a loopback
 * literal to `localhost` therefore changes nothing about WHICH host is addressed — it
 * only picks a spelling VS Code's mapper understands.
 *
 * ⚠️ It must be `localhost`, not `127.0.0.1`: a backend may be bound to the IPv6
 * loopback ONLY (Bun's default for `host: "localhost"` on a dual-stack machine), in
 * which case `127.0.0.1` refuses the connection outright. `localhost` resolves to
 * whichever family is up. Only the AUTHORITY is rewritten; scheme, port and path are
 * left exactly as given.
 */

/** Loopback hosts, as they appear in a URL authority (brackets already stripped). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

/**
 * The authority forms `asExternalUri` maps, verbatim from the regex quoted above.
 *
 * `0.0.0.0` is included because VS Code accepts it, but it is NOT a rewrite target:
 * it names every interface rather than the local one, and is not a valid destination.
 */
const MAPPABLE_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

/** Whether a hostname is the local machine, in any of its spellings. */
export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (LOOPBACK_HOSTS.has(host)) return true;
	// The whole 127.0.0.0/8 block: tooling uses 127.0.0.2+ for isolation and they are
	// equally local.
	const octets = host.split(".");
	return (
		octets.length === 4 &&
		octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
		octets[0] === "127"
	);
}

/**
 * Whether `asExternalUri` will recognise this origin's authority for port mapping.
 *
 * Used to decide whether a returned-unchanged URL means "no mapping was needed"
 * (desktop, where that is correct) or "no mapping was possible" (a spelling VS Code
 * cannot parse — which must not be shipped to a webview).
 */
export function isMappableByExternalUri(origin: string): boolean {
	try {
		const url = new URL(origin);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		// The regex requires an explicit port, so a default-port URL (no `:port` in the
		// authority) does not match it either.
		if (!url.port) return false;
		return MAPPABLE_HOSTS.has(url.hostname.replace(/^\[|\]$/g, "").toLowerCase());
	} catch {
		return false;
	}
}

/**
 * Rewrite a loopback origin to the `localhost` spelling, leaving anything else alone.
 *
 * Returns a bare origin (no trailing slash) to match `BackendEndpoint.origin`.
 */
export function toMappableLoopbackOrigin(origin: string): string {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return origin;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return origin;
	if (!isLoopbackHost(url.hostname)) return origin;
	if (url.hostname.toLowerCase() === "localhost") return url.origin;
	// `URL#hostname` assignment re-serializes the authority, so the brackets of an
	// IPv6 literal are dropped along with it.
	url.hostname = "localhost";
	return url.origin;
}

/**
 * Whether a value can appear in a CSP source list at all.
 *
 * ⚠️ A bracketed IPv6 host CANNOT. The browser discards the invalid source and the
 * directive falls back to whatever remains — for a single-source `frame-src` that is
 * effectively `'none'`, so the iframe is blocked by a policy that LOOKS permissive in
 * the served HTML. Checked explicitly so the extension can fail with an explanation
 * instead of rendering a blank panel.
 */
export function isValidCspSource(origin: string): boolean {
	try {
		const url = new URL(origin);
		// A CSP host-source has no bracket syntax; an IPv6 literal is unrepresentable.
		if (url.hostname.startsWith("[")) return false;
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}
