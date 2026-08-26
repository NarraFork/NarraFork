/**
 * base-path.ts — The single place that knows where this app is mounted.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every absolute URL in the frontend (`/api/…`, `/ws/…`, `/favicon.svg`) silently
 * assumes NarraFork owns the origin root. That assumption breaks under any prefix:
 *
 *   - a reverse proxy subpath (`location /nf/ { proxy_pass … }`);
 *   - code-server's port proxy (`/proxy/7778/`), which is what `asExternalUri`
 *     returns and therefore what the VS Code extension's embedded panel loads.
 *
 * Under a prefix an absolute `/api/health` does not fail in an obvious way — it
 * reaches whatever is mounted at the proxy's root. For code-server that is
 * code-server itself, which answers 404 with an HTML body, so the app reports
 * "invalid response" rather than "wrong URL".
 *
 * WHERE THE BASE COMES FROM
 * -------------------------
 * `document.baseURI`, i.e. the `<base href>` the server injects when it answers a
 * SPA navigation (see `server/lib/spa-base-href.ts`). NOT `location.pathname`:
 * on `/proxy/7778/projects/abc` the pathname mixes the mount prefix with the SPA
 * route and there is no way to tell where one ends and the other begins. The
 * server can compute it because it sees the path with the prefix already stripped;
 * `<base href>` is how that answer is handed to us.
 *
 * Everything here is deliberately dependency-free and safe to call before React
 * mounts, because `index.html`'s inline boot script needs the same answer (it
 * duplicates the few lines it needs — it cannot import a module).
 *
 * The API/WS classification rule is NOT here: it lives in `lib/app-path-classify.ts`
 * because the Service Worker needs the same answer and cannot import this module (it
 * reads `document`/`location` at module scope).
 */

/** Fallback used outside a browser (bun test, SSR-shaped tooling). */
const ROOT_BASE = "/";

/**
 * Cached because this is called on every request/URL construction and the answer
 * cannot change without a document load. A `<base href>` is fixed for the lifetime
 * of the document, so recomputing would only cost work.
 */
let cachedBase: string | null = null;

/**
 * The app's mount path, always absolute and always trailing-slash terminated
 * (`"/"`, `"/nf/"`, `"/proxy/7778/"`).
 *
 * Trailing slash is part of the contract so callers can concatenate a
 * slash-stripped suffix without re-checking. Absolute (rather than the relative
 * `../` form the server injects) because these values feed `fetch()` and
 * `new WebSocket()`, which need a resolvable URL, not a document-relative hint.
 */
export function getAppBase(): string {
	if (cachedBase !== null) return cachedBase;
	cachedBase = computeAppBase();
	return cachedBase;
}

function computeAppBase(): string {
	if (typeof document === "undefined" || typeof location === "undefined") return ROOT_BASE;
	try {
		// `document.baseURI` already resolves `<base href="../">` against the document
		// URL, so the browser has done the arithmetic for us.
		const resolved = new URL(document.baseURI, location.href);
		// Only the directory part is the mount root. `baseURI` can legitimately end in a
		// file name when no `<base>` was injected (e.g. Vite dev serving `/index.html`),
		// and keeping that would make every URL a sibling of index.html.
		const path = resolved.pathname.endsWith("/")
			? resolved.pathname
			: resolved.pathname.replace(/[^/]*$/, "");
		return path.startsWith("/") ? path : `/${path}`;
	} catch {
		// A malformed baseURI must not take the app down; the root is the behaviour
		// every existing deployment already has.
		return ROOT_BASE;
	}
}

/** Join a path onto the mount base without producing a double slash. */
function joinBase(path: string): string {
	return `${getAppBase()}${path.replace(/^\/+/, "")}`;
}

/**
 * Strip a leading `api` PATH SEGMENT, so both `"/api/health"` and `"health"` name the
 * same endpoint.
 *
 * ⚠️ Segment-wise, not `replace(/^api\/?/, "")`. That spelling matches any path merely
 * STARTING with those three characters, so a future `/api-keys` endpoint would become
 * `/api/-keys` — a 404 whose URL looks almost right. No current endpoint collides
 * (checked across every `request()` literal), which is precisely why the wrong version
 * would have sat here until someone added one.
 */
function stripApiSegment(path: string): string {
	const trimmed = path.replace(/^\/+/, "");
	// `api` ends at the first `/`, `?` or `#`. A bare `/api?x=1` is the API root with a
	// query, so the segment must be recognised there too — otherwise it would be treated
	// as a relative path and produce `/api/api?x=1`.
	if (trimmed === "api") return "";
	const match = /^api(?=[/?#])/.exec(trimmed);
	if (!match) return trimmed;
	const rest = trimmed.slice("api".length);
	// A `/` right after the segment belongs to the separator, not to the suffix.
	return rest.startsWith("/") ? rest.slice(1) : rest;
}

/**
 * URL for an API endpoint. Accepts both `"/api/health"` and `"api/health"`, and
 * `""` yields the API root — which is what `apiBase()` in `lib/api/client.ts` is.
 */
export function apiUrl(path = ""): string {
	const suffix = stripApiSegment(path);
	if (!suffix) return joinBase("api");
	// A suffix that begins with `?`/`#` continues the API root rather than naming a
	// child of it, so no separator is inserted: `/api?x=1` must not become `/api/?x=1`.
	const separator = suffix.startsWith("?") || suffix.startsWith("#") ? "" : "/";
	return `${joinBase("api")}${separator}${suffix}`;
}

/**
 * URL for a static asset served alongside the app shell (`/favicon.svg`,
 * `shiki/langs/ts.mjs`, `/login`).
 */
export function assetUrl(path: string): string {
	return joinBase(path);
}

/**
 * The router basepath, in the form TanStack Router expects: no trailing slash, and
 * `""` (not `"/"`) at the root.
 *
 * TanStack strips this prefix from `location.pathname` before matching and adds it
 * back when building hrefs. Passing `"/"` would make it try to strip a slash that
 * is already part of every path, so the root case must be the empty string.
 */
export function getRouterBasepath(): string {
	const base = getAppBase();
	return base === "/" ? "" : base.replace(/\/+$/, "");
}

/**
 * Whether `url` addresses this app's API — the mount-prefix-aware replacement for
 * `source.startsWith("/api/")`.
 *
 * Several call sites branch on that test to decide whether a URL needs an
 * `Authorization` header, or whether a string is a URL at all rather than base64
 * image bytes. Under a mount prefix the literal test answers "no" for our own URLs,
 * and both branches then fail in ways that do not name the cause: a request goes out
 * unauthenticated and 401s, or a perfectly good URL gets prefixed with
 * `data:image/png;base64,` and renders as a broken image.
 *
 * Only same-origin, rooted paths are considered. An absolute URL to another origin is
 * not ours even if its path happens to contain `/api/`.
 */
export function isApiUrl(url: string): boolean {
	if (!url.startsWith("/")) return false;
	const path = url.split(/[?#]/, 1)[0] ?? "";
	const relative = stripBase(path);
	// `relative === "api"` is deliberately excluded: every real endpoint has a
	// sub-path, and the bare root is not something any call site requests.
	return relative.startsWith("api/");
}

/**
 * Resolve a server-authored `/api/…` URL against the mount prefix, leaving anything else
 * alone.
 *
 * ⚠️ This exists because some `/api/…` URLs are MINTED BY THE SERVER and PERSISTED — a
 * tool call's `previewUrl` is stored with the message and replayed months later. Fixing
 * the generator cannot fix the rows already written, so the prefix has to be applied when
 * the value is turned into a `src`, not when it is produced.
 *
 * Everything else passes through untouched: `blob:`/`data:` URIs and absolute URLs to
 * other origins.
 *
 * ⚠️ The test is a LITERAL `/api/` prefix, deliberately NOT `isApiUrl`. `isApiUrl` strips
 * the mount prefix first, so it also answers true for an already-resolved
 * `/proxy/7778/api/…` — and prefixing that again yields
 * `/proxy/7778/api/proxy/7778/api/…`. Since these values are replayed from storage and
 * re-rendered on every pass, non-idempotence here would compound.
 */
export function resolveServerUrl(url: string): string {
	if (!url.startsWith("/api/")) return url;
	const [path = "", suffix = ""] = splitAtQuery(url);
	return suffix ? `${apiUrl(path)}${suffix}` : apiUrl(path);
}

/** Split a URL into its path and its `?…`/`#…` remainder (which may be empty). */
function splitAtQuery(url: string): [string, string] {
	const at = url.search(/[?#]/);
	return at === -1 ? [url, ""] : [url.slice(0, at), url.slice(at)];
}

/**
 * Remove the mount prefix from an absolute pathname, returning the remainder with
 * no leading slash. A pathname outside the base is returned with only its leading
 * slashes stripped — callers treat "not under our base" as "not ours".
 */
export function stripBase(pathname: string, base = getAppBase()): string {
	if (base !== "/" && pathname.startsWith(base)) {
		return pathname.slice(base.length);
	}
	return pathname.replace(/^\/+/, "");
}

/** Test seam: forget the cached base so a test can simulate another mount point. */
export function resetAppBaseForTest(): void {
	cachedBase = null;
}
