import { afterEach, describe, expect, it } from "bun:test";
import { isApiOrWsRelativePath } from "@frontend/lib/app-path-classify";
import {
	apiUrl,
	assetUrl,
	getAppBase,
	getRouterBasepath,
	isApiUrl,
	resetAppBaseForTest,
	resolveServerUrl,
	stripBase,
} from "@frontend/lib/base-path";

/**
 * Simulate a document mounted at `mountUrl` with `baseHref` injected by the server.
 *
 * `document.baseURI` is read-only and derived, so it is stubbed directly — the point
 * under test is how this module interprets the browser's already-resolved answer, not
 * how the browser resolves `<base href>`.
 */
function mountAt(mountUrl: string, baseHref: string): void {
	resetAppBaseForTest();
	const resolved = new URL(baseHref, mountUrl).toString();
	(globalThis as { document?: unknown }).document = { baseURI: resolved };
	(globalThis as { location?: unknown }).location = { href: mountUrl };
}

afterEach(() => {
	resetAppBaseForTest();
	delete (globalThis as { document?: unknown }).document;
	delete (globalThis as { location?: unknown }).location;
});

describe("getAppBase", () => {
	it("returns the root when served from the origin root", () => {
		mountAt("https://nf.example.com/", "./");
		expect(getAppBase()).toBe("/");
	});

	it("recovers the mount root from a deep SPA route", () => {
		// This is the case absolute URLs get wrong: the pathname mixes prefix and route.
		mountAt("https://nf.example.com/projects/abc", "../");
		expect(getAppBase()).toBe("/");
	});

	it("recovers a reverse-proxy subpath", () => {
		mountAt("https://nf.example.com/nf/projects/abc", "../");
		expect(getAppBase()).toBe("/nf/");
	});

	it("recovers code-server's port proxy prefix", () => {
		mountAt("https://cs.example.com/proxy/7778/narrators/abc/archive", "../../");
		expect(getAppBase()).toBe("/proxy/7778/");
	});

	it("drops a file name when no <base> was injected", () => {
		// Vite dev serves `/index.html` with no <base>; keeping the file name would make
		// every URL a sibling of index.html rather than a child of the mount root.
		mountAt("http://localhost:7778/index.html", "http://localhost:7778/index.html");
		expect(getAppBase()).toBe("/");
	});

	it("falls back to the root outside a browser", () => {
		resetAppBaseForTest();
		expect(getAppBase()).toBe("/");
	});
});

describe("apiUrl", () => {
	it("builds API URLs under the mount prefix", () => {
		mountAt("https://cs.example.com/proxy/7778/", "./");
		expect(apiUrl()).toBe("/proxy/7778/api");
		expect(apiUrl("/health")).toBe("/proxy/7778/api/health");
		expect(apiUrl("health")).toBe("/proxy/7778/api/health");
	});

	it("accepts paths that already carry the /api prefix", () => {
		// Call sites written before this module exists pass `/api/...` literals; both
		// spellings must produce the same URL or the migration would double the segment.
		mountAt("https://nf.example.com/nf/", "./");
		expect(apiUrl("/api/fs/preview")).toBe("/nf/api/fs/preview");
		expect(apiUrl("/fs/preview")).toBe("/nf/api/fs/preview");
	});

	it("is unchanged at the root", () => {
		mountAt("https://nf.example.com/", "./");
		expect(apiUrl("/narrators/abc/messages")).toBe("/api/narrators/abc/messages");
	});

	it("strips `api` as a path SEGMENT, not as three leading characters", () => {
		// ⚠️ A character-prefix test turns a future `/api-keys` endpoint into
		// `/api/-keys`: a 404 at a URL that looks almost right. No endpoint collides
		// today, which is exactly why the wrong predicate would go unnoticed until one
		// does.
		mountAt("https://nf.example.com/", "./");
		expect(apiUrl("/api-keys")).toBe("/api/api-keys");
		expect(apiUrl("/apiary/x")).toBe("/api/apiary/x");
		expect(apiUrl("apikeys")).toBe("/api/apikeys");
	});

	it("treats a query or fragment on the API root as continuing it", () => {
		// `/api?x=1` names the root with a query, so inserting a separator would produce
		// `/api/?x=1` — a different path, and one the server does not route.
		mountAt("https://nf.example.com/nf/", "./");
		expect(apiUrl("/api?x=1")).toBe("/nf/api?x=1");
		expect(apiUrl("/api#frag")).toBe("/nf/api#frag");
	});

	it("is idempotent on an already-built URL at the root", () => {
		// `authorizedFetch` re-resolves whatever it is handed, so applying this twice must
		// be a no-op; otherwise every wrapped call site would double the segment.
		mountAt("https://nf.example.com/", "./");
		const once = apiUrl("/fs/preview");
		expect(apiUrl(once)).toBe(once);
	});
});

describe("resolveServerUrl", () => {
	/*
	 * These inputs are SERVER-MINTED and PERSISTED — a screenshot's `previewUrl` is stored
	 * with the tool call and replayed later — so they cannot be fixed at the generator.
	 * The prefix has to be applied when the value becomes a `src` or a fetch target.
	 */
	it("re-points a rooted /api URL at the mount prefix", () => {
		mountAt("https://cs.example.com/proxy/7778/", "./");
		expect(resolveServerUrl("/api/shares/abc/preview")).toBe("/proxy/7778/api/shares/abc/preview");
	});

	it("keeps the query string intact", () => {
		mountAt("https://nf.example.com/nf/", "./");
		expect(resolveServerUrl("/api/fs/preview?path=%2Ftmp%2Fa.png")).toBe(
			"/nf/api/fs/preview?path=%2Ftmp%2Fa.png",
		);
	});

	it("is idempotent, so a replayed value cannot accumulate prefixes", () => {
		// ⚠️ The trap: `isApiUrl` strips the prefix before comparing, so it answers TRUE for
		// an already-resolved URL. Using it as the predicate here would turn
		// `/proxy/7778/api/x` into `/proxy/7778/api/proxy/7778/api/x`, and since these
		// values are re-rendered on every pass the damage would compound.
		mountAt("https://cs.example.com/proxy/7778/", "./");
		const once = resolveServerUrl("/api/shares/abc/preview");
		expect(resolveServerUrl(once)).toBe(once);
	});

	it("leaves everything that is not ours untouched", () => {
		mountAt("https://cs.example.com/proxy/7778/", "./");
		for (const url of [
			"blob:https://cs.example.com/1234",
			"data:image/png;base64,AAAA",
			"https://other.example.com/api/x",
			"/favicon.svg",
		]) {
			expect(resolveServerUrl(url)).toBe(url);
		}
	});

	it("stays recognisable as an API URL afterwards, so auth is still applied", () => {
		// Call sites decide whether to send an Authorization header by asking `isApiUrl`
		// about the resolved value. If resolution made it unrecognisable, the request would
		// go out unauthenticated and 401 — with the URL looking perfectly correct.
		mountAt("https://cs.example.com/proxy/7778/", "./");
		expect(isApiUrl(resolveServerUrl("/api/shares/abc/preview"))).toBe(true);
	});
});

describe("assetUrl", () => {
	it("prefixes static assets", () => {
		mountAt("https://cs.example.com/proxy/7778/projects/abc", "../");
		expect(assetUrl("/favicon.svg")).toBe("/proxy/7778/favicon.svg");
		expect(assetUrl("shiki/langs/ts.mjs")).toBe("/proxy/7778/shiki/langs/ts.mjs");
	});
});

describe("getRouterBasepath", () => {
	it("is empty at the root, since TanStack strips the value it is given", () => {
		mountAt("https://nf.example.com/", "./");
		expect(getRouterBasepath()).toBe("");
	});

	it("drops the trailing slash under a prefix", () => {
		mountAt("https://cs.example.com/proxy/7778/", "./");
		expect(getRouterBasepath()).toBe("/proxy/7778");
	});
});

describe("stripBase", () => {
	it("removes the mount prefix", () => {
		mountAt("https://cs.example.com/proxy/7778/", "./");
		expect(stripBase("/proxy/7778/api/health")).toBe("api/health");
		expect(stripBase("/proxy/7778/assets/index.js")).toBe("assets/index.js");
		expect(stripBase("/proxy/7778/")).toBe("");
	});

	it("does not treat a path outside the base as ours", () => {
		mountAt("https://cs.example.com/proxy/7778/", "./");
		// code-server's own API sits at the origin root; caching decisions must not
		// claim it just because the suffix looks familiar.
		expect(stripBase("/other/api/health")).toBe("other/api/health");
	});
});

/*
 * The API/WS rule is shared with the Service Worker (see `lib/app-path-classify.ts`).
 * ⚠️ It is asserted here on paths that have ALREADY been prefix-stripped, which is the
 * only form both sides agree on: the app strips using `document.baseURI`, the worker
 * using its registration scope. A drift between the two is silent — either API
 * responses get cached (stale data, no error) or asset caching stops.
 */
describe("isApiOrWsRelativePath", () => {
	it("classifies the API and WS surfaces, including their bare roots", () => {
		for (const relative of ["api", "api/health", "ws", "ws/narrator"]) {
			expect(isApiOrWsRelativePath(relative)).toBe(true);
		}
	});

	it("leaves static assets and the app root alone", () => {
		for (const relative of ["", "assets/index.js", "favicon.svg", "login"]) {
			expect(isApiOrWsRelativePath(relative)).toBe(false);
		}
	});

	it("matches whole segments, not leading characters", () => {
		// `api-keys` merely starts with those three characters. Classifying it as API
		// traffic would silently stop it being cached; the reverse spelling would let a
		// real endpoint be cached.
		for (const relative of ["api-keys", "apidocs", "wsx", "website/index.js"]) {
			expect(isApiOrWsRelativePath(relative)).toBe(false);
		}
	});
});
