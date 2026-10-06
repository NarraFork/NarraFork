/**
 * pwa-offline-shell.test.ts — The precached app shell must be usable at any route.
 *
 * WHAT WENT WRONG BEFORE
 * ---------------------
 * Switching Vite to `base: "./"` made the shell's asset references relative, which is
 * what lets NarraFork be served from an unknown mount prefix. In production the server
 * repairs those references per navigation by injecting a `<base href>`
 * (`server/lib/spa-base-href.ts`).
 *
 * The Service Worker precaches the BUILD ARTIFACT, which never passes through that
 * injection. So the cached shell carried no `<base>` at all, and answering a nested
 * navigation from cache made the browser resolve `./assets/index-abc.js` against the
 * route's directory: `/settings/assets/index-abc.js`, a 404 on the entry script. The
 * page is blank and NO client code is running to report why.
 *
 * ⚠️ It was not limited to prefixed mounts, which is what made the original reasoning
 * ("at the root every navigation gets `./`") wrong: at the origin root the cached shell
 * is still only valid for root-level navigations, and almost every route in this app is
 * nested.
 *
 * These tests assert against the emitted `dist/frontend` bytes rather than the source,
 * because the defect lived exactly in the gap between them.
 */

import { describe, expect, test } from "bun:test";
import { setBaseHref } from "@server/lib/spa-base-href";

const HTML_PATH = "dist/frontend/index.html";
const SW_PATH = "dist/frontend/src-sw.js";
const hasBuild = (await Bun.file(HTML_PATH).exists()) && (await Bun.file(SW_PATH).exists());

/** A `<base>` inside a comment is inert, so comments are stripped before looking. */
function effectiveBaseHref(html: string): string | null {
	const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
	return withoutComments.match(/<base[^>]*\bhref="([^"]*)"/)?.[1] ?? null;
}

/** The module entry script the document loads; a 404 here is a blank page. */
function entryScriptRef(html: string): string {
	const src = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
	if (!src) throw new Error("built index.html has no module entry script");
	return src;
}

describe.skipIf(!hasBuild)("the precached shell as built", () => {
	test("uses relative asset references, so a base href governs them", async () => {
		// If these were rooted the whole mount-prefix scheme would be moot — and so
		// would the rewrite below.
		const html = await Bun.file(HTML_PATH).text();
		expect(entryScriptRef(html).startsWith("/")).toBe(false);
	});

	test("carries no effective base href of its own", async () => {
		// Documents the reason the worker MUST rewrite it. If a future build starts
		// emitting a `<base>`, this fails and whoever changed it has to decide which of
		// the two mechanisms wins rather than silently ending up with both.
		const html = await Bun.file(HTML_PATH).text();
		expect(effectiveBaseHref(html)).toBeNull();
	});

	test("resolves the entry script correctly ONLY at the root without a base href", async () => {
		// The failure this suite exists for, stated as an executable fact.
		const html = await Bun.file(HTML_PATH).text();
		const entry = entryScriptRef(html);
		expect(new URL(entry, "https://nf.test/").pathname).toBe(
			"/assets/".concat(entry.split("/").pop() ?? ""),
		);
		expect(new URL(entry, "https://nf.test/settings/providers").pathname).toContain(
			"/settings/assets/",
		);
	});
});

describe.skipIf(!hasBuild)("the worker's base-href rewrite", () => {
	test("is present in the emitted worker", async () => {
		// Asserted on the BUILT worker: the source could import the helper while the
		// bundler drops it, and the symptom would be a blank page in production only.
		const sw = await Bun.file(SW_PATH).text();
		expect(sw).toContain('<base href="');
	});

	test("registers the navigation route unconditionally, not just at the root", async () => {
		// Asserted on the SOURCE: the emitted worker is minified, so `NavigationRoute`
		// survives only as a mangled local and a string match there would be testing the
		// minifier's naming rather than this decision.
		//
		// The previous implementation gated the route on `SW_BASE === "/"`, which both
		// gave up offline support under a prefix AND left the root case broken.
		const source = await Bun.file("frontend/src-sw.ts").text();
		expect(source).toContain("new NavigationRoute(");
		expect(source).not.toMatch(/if\s*\(\s*SW_BASE\s*===\s*"\/"\s*\)/);
	});

	test("makes the shell valid at every navigation depth, at the root and under a prefix", async () => {
		// The worker injects its registration scope as an ABSOLUTE base href, so one
		// rewrite is correct for all depths — unlike the server, which must compute a
		// relative climb per request.
		const html = await Bun.file(HTML_PATH).text();
		const entry = entryScriptRef(html);
		const assetName = entry.split("/").pop();

		for (const [scope, navigations] of [
			["/", ["/", "/login", "/settings/providers", "/narrators/abc/messages"]],
			["/proxy/7778/", ["/proxy/7778/", "/proxy/7778/login", "/proxy/7778/narrators/abc/messages"]],
		] as const) {
			const rewritten = setBaseHref(html, scope);
			expect(effectiveBaseHref(rewritten)).toBe(scope);

			for (const nav of navigations) {
				const baseUrl = new URL(scope, `https://nf.test${nav}`);
				const resolved = new URL(entryScriptRef(rewritten), baseUrl).pathname;
				expect(resolved).toBe(`${scope}assets/${assetName}`);
			}
		}
	});

	test("replaces rather than appends, so a second rewrite cannot be shadowed", async () => {
		// Browsers honour only the FIRST base element, so appending would leave a stale
		// one winning while the served HTML looks correct.
		//
		// Counted with comments stripped: `index.html`'s head carries a comment that
		// MENTIONS `<base>` to explain why the icon hrefs are relative, and counting that
		// prose would make this fail for a reason unrelated to the injector. (That same
		// prose is why the injector itself has to be comment-aware.)
		const html = await Bun.file(HTML_PATH).text();
		const twice = setBaseHref(setBaseHref(html, "/proxy/7778/"), "/nf/");
		const realTags = twice.replace(/<!--[\s\S]*?-->/g, "").match(/<base\b/g) ?? [];
		expect(realTags).toHaveLength(1);
		expect(effectiveBaseHref(twice)).toBe("/nf/");
	});
});
