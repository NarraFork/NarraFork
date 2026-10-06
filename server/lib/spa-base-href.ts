/**
 * spa-base-href.ts — Make the SPA's own asset references work at ANY mount prefix.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Vite build emits relative asset references (`./assets/index-abc.js`), which is
 * what lets NarraFork be served from a prefix it does not know about: a reverse-proxy
 * subpath (`/nf/`), or code-server's port proxy (`/proxy/7778/`). An ABSOLUTE `/assets/…`
 * would resolve against the proxy's own origin root and 404 — served by whatever is
 * mounted there, which for code-server is code-server itself.
 *
 * But relative references are resolved against the DOCUMENT's directory, and the SPA
 * answers deep links from a single `index.html`. On `/projects/abc` the document
 * directory is `/projects/`, so `./assets/index-abc.js` resolves to
 * `/projects/assets/index-abc.js` — 404, and this one is fatal in a way nothing can
 * recover from: the entry script never loads, so no client-side code gets the chance
 * to notice or repair it. That is why this correction MUST happen server-side.
 *
 * `<base href="../">` fixes it by re-pointing relative resolution at the mount root.
 *
 * WHY THE DEPTH CAN BE COMPUTED FROM THE PATH WE RECEIVE
 * -----------------------------------------------------
 * The server never learns the mount prefix, and does not need to: a prefix adds the
 * SAME number of leading segments to the browser's URL as it strips before reaching
 * us, so the number of `../` needed to climb from the document's directory back to the
 * mount root is identical either way.
 *
 *   browser `/proxy/7778/projects/abc` → we see `/projects/abc` → 1 up
 *   `../` from `/proxy/7778/projects/` → `/proxy/7778/`   ✅ the mount root
 *   `../` from `/projects/`            → `/`              ✅ the mount root
 *
 * ⚠️ This equivalence is exactly why code-server's **path-stripping** `/proxy/<port>/`
 * is the supported form and `/absproxy/<port>/` is NOT. absproxy forwards the prefix
 * verbatim, so we would see `/absproxy/7778/projects/abc` and count 3 ups — climbing
 * past the mount root to `/`, where our assets are not served. absproxy additionally
 * breaks plain static requests (`/absproxy/7778/assets/x.js` has no matching file on
 * disk), so it cannot be rescued from here at all; it needs a configured prefix that
 * the request pipeline strips. Not implemented — `asExternalUri` returns the `/proxy`
 * form by default, so the supported path is also the default one.
 */

/**
 * How many `../` segments lead from the document's directory back to the mount root.
 *
 * The directory is everything up to the last `/`, which is why a trailing slash
 * changes the answer: `/projects` is a document named `projects` in the root, while
 * `/projects/` is a document inside a `projects/` directory.
 */
function countUpLevels(requestPath: string): number {
	// Normalise away the leading slash and collapse repeats, so `//projects//abc`
	// counts the same as `/projects/abc`. A proxy chain can introduce those, and an
	// empty segment would otherwise be counted as a directory level.
	const trimmed = requestPath.replace(/^\/+/, "");
	if (trimmed === "") return 0;
	const endsWithSlash = trimmed.endsWith("/");
	const segments = trimmed.split("/").filter((segment) => segment !== "");
	if (segments.length === 0) return 0;
	// A trailing slash means every segment is a directory level; otherwise the last
	// segment is the document itself and contributes nothing to climb.
	return endsWithSlash ? segments.length : segments.length - 1;
}

/**
 * The `href` for the `<base>` element to inject when answering `requestPath` with
 * `index.html`. Always relative, never rooted — a rooted value would defeat the
 * entire purpose by re-introducing an assumption about the mount prefix.
 */
export function computeSpaBaseHref(requestPath: string): string {
	const levels = countUpLevels(requestPath);
	return levels === 0 ? "./" : "../".repeat(levels);
}

/**
 * A `Location` value for redirecting to an in-app route, correct under any mount prefix.
 *
 * ⚠️ `c.redirect("/login")` is wrong the moment NarraFork is not at the origin root: the
 * browser sends the user to the PROXY's `/login`, which is not us. It fails silently in
 * the worst way for an auth callback — the user lands on someone else's page (or a 404)
 * at the end of a successful login, with no error to connect it to this redirect.
 *
 * A relative `Location` is resolved by the browser against the request URL, which already
 * carries the prefix — so the same arithmetic that positions `<base href>` applies here,
 * for the same reason (see this module's header). `requestPath` is the path WE received,
 * i.e. with the prefix already stripped.
 *
 *   browser `/nf/api/auth/sso/callback` → we see `/api/auth/sso/callback` → 2 up
 *   `../../login` from `/nf/api/auth/sso/` → `/nf/login`   ✅
 *
 * `target` is an app route with a leading slash (`/login?sso_error=x`), matching how
 * these call sites already read.
 */
export function spaRedirectLocation(requestPath: string, target: string): string {
	const climb = computeSpaBaseHref(requestPath);
	const suffix = target.replace(/^\/+/, "");
	// `computeSpaBaseHref` returns `./` at the root, and `./login` is a correct relative
	// reference — but the bare `login` it would produce after concatenation is too, and
	// keeping `./` makes the value obviously relative when read in a log.
	return `${climb}${suffix}`;
}

/** Matches an existing `<base …>` element, so injection never produces a second one. */
const EXISTING_BASE_TAG = /<base\b[^>]*>/gi;
const HEAD_OPEN_TAG = /<head\b[^>]*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** Half-open `[start, end)` ranges of every HTML comment in the document. */
function commentRanges(html: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	HTML_COMMENT.lastIndex = 0;
	for (let match = HTML_COMMENT.exec(html); match; match = HTML_COMMENT.exec(html)) {
		ranges.push([match.index, match.index + match[0].length]);
	}
	return ranges;
}

/**
 * First match of `pattern` that is NOT inside an HTML comment.
 *
 * ⚠️ Comment-awareness is a correctness requirement, not tidiness. `index.html`'s head
 * carries a comment that MENTIONS `<base>` to explain why the icon hrefs are relative,
 * and a naive `/<base\b[^>]*>/` matches that prose. The injector then took its
 * "replace the existing base" branch and wrote the real tag INSIDE the comment, so the
 * document shipped with no effective `<base>` at all: every deep link resolved
 * `./assets/…` against the route directory and 404'd the entry script — a blank page,
 * with the injected tag plainly visible in the served HTML.
 *
 * `pattern` must be a global regex; its `lastIndex` is managed here.
 */
function matchOutsideComments(html: string, pattern: RegExp): RegExpExecArray | null {
	const comments = commentRanges(html);
	pattern.lastIndex = 0;
	for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
		const start = match.index;
		if (!comments.some(([from, to]) => start >= from && start < to)) return match;
	}
	return null;
}

/**
 * Set the document's `<base href>` to `href`, inserting the element if absent.
 *
 * Inserted immediately AFTER `<head>` rather than before `</head>`: `<base>` only
 * affects references that come after it, and this document's head already contains
 * `<link rel="icon">` and `<link rel="apple-touch-icon">`. Appending at the end of
 * head would leave exactly those two resolving against the wrong directory — a
 * missing favicon, which nobody would connect back to this function.
 *
 * An already-present `<base>` is REPLACED rather than supplemented, because a second
 * `<base>` is ignored by browsers: the stale first one would keep winning, and the
 * page would look correct in the source while behaving as if this ran at all. Only a
 * REAL element counts as present — see `matchOutsideComments`.
 *
 * Returns the html unchanged when there is no `<head>` to anchor to. That case means
 * the document is not the app shell we expect, and silently prepending a `<base>` to
 * an unknown document is worse than leaving it alone.
 *
 * Separated from `injectSpaBaseHref` because there are two callers with the same
 * "replace exactly one real base element" requirement but different arithmetic: the
 * servers compute a RELATIVE href from the request path, while the Service Worker
 * already knows the mount root absolutely (its own registration scope) and must not
 * re-derive it. Sharing the injector is what keeps the comment-awareness and the
 * replace-don't-append rule from existing in two versions.
 */
export function setBaseHref(html: string, href: string): string {
	const tag = `<base href="${href}">`;

	const existing = matchOutsideComments(html, EXISTING_BASE_TAG);
	if (existing) {
		const end = existing.index + existing[0].length;
		return `${html.slice(0, existing.index)}${tag}${html.slice(end)}`;
	}

	const headMatch = matchOutsideComments(html, HEAD_OPEN_TAG);
	if (!headMatch) return html;
	const insertAt = headMatch.index + headMatch[0].length;
	return `${html.slice(0, insertAt)}${tag}${html.slice(insertAt)}`;
}

/**
 * Inject (or correct) the `<base href>` in an `index.html` document being served as
 * the answer to a navigation for `requestPath`.
 */
export function injectSpaBaseHref(html: string, requestPath: string): string {
	return setBaseHref(html, computeSpaBaseHref(requestPath));
}

/** Both filesystem and embedded SPA responses use the same public-share privacy policy. */
export function spaIndexHeaders(requestPath: string): Record<string, string> {
	const publicShare =
		requestPath === "/shared/narrators" || requestPath.startsWith("/shared/narrators/");
	return {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": publicShare ? "no-store" : "no-cache",
		...(publicShare
			? {
					"Referrer-Policy": "no-referrer",
					"X-Robots-Tag": "noindex, nofollow, noarchive",
				}
			: {}),
	};
}
