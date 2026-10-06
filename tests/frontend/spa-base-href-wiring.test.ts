/**
 * spa-base-href-wiring.test.ts — Both halves of mount-prefix support must be present.
 *
 * Serving NarraFork from a prefix it does not know at build time needs two independent
 * pieces, and NEITHER works alone:
 *
 *   1. `base: "./"` in the Vite config, so asset references are relative.
 *   2. A `<base href>` injected per navigation, so those relative references resolve
 *      against the mount root instead of the current route's directory.
 *
 * The failure mode of a missing half is a blank page: the entry script 404s, so no
 * client code runs and nothing can report the cause. There is no degraded mode to
 * notice — which is why the wiring is asserted rather than left to review.
 *
 * ⚠️ Half 2 must exist in BOTH servers. The backend covers production
 * (`server/main.ts`), and the Vite dev server covers `bun run dev:frontend`. Having only
 * one is the shape that hides: the app works in whichever environment you happen to test
 * and breaks on a deep-link reload in the other. The dev gap was real — Vite answers
 * `/projects/abc` from the same `index.html` with no `<base>`, so `document.baseURI` said
 * the mount root was `/projects/` and every request went to `/projects/api/…`, which
 * Vite's SPA fallback answers with HTML (a parse error, not a 404).
 */

import { describe, expect, test } from "bun:test";
import { injectSpaBaseHref } from "@server/lib/spa-base-href";

const VITE_CONFIG = await Bun.file("frontend/vite.config.ts").text();
const SERVER_MAIN = await Bun.file("server/main.ts").text();
const APP_SHELL = await Bun.file("frontend/index.html").text();

describe("half 1: relative asset references", () => {
	test("the Vite config sets a relative base", () => {
		// A rooted base re-introduces the assumption that NarraFork owns the origin root.
		expect(VITE_CONFIG).toMatch(/base:\s*"\.\/"/);
	});
});

describe("half 2: server-injected <base href>", () => {
	test("the production server injects it on the SPA catch-all", () => {
		expect(SERVER_MAIN).toContain("injectSpaBaseHref");
		// Both static-serving branches (embedded assets in a compiled binary, filesystem in
		// a source run) must route through the same helper, or the shipped binary and the
		// source run disagree.
		expect(SERVER_MAIN.match(/serveSpaIndex\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
	});

	test("the dev server injects it too, reusing the server implementation", () => {
		// Imported rather than reimplemented: two copies of "how deep am I" are free to
		// disagree, and a disagreement only shows up on a deep-link reload in one of the
		// two environments.
		expect(VITE_CONFIG).toContain("injectSpaBaseHref");
		expect(VITE_CONFIG).toContain("../server/lib/spa-base-href");
		// The browser's path, not Vite's already-resolved `/index.html` — which would
		// always compute `./` and leave deep links broken while looking implemented.
		expect(VITE_CONFIG).toContain("originalUrl");
	});
});

describe("the app shell survives injection", () => {
	/** A `<base>` written inside a comment is inert, so comments are stripped first. */
	function effectiveBase(html: string): string | null {
		return html.replace(/<!--[\s\S]*?-->/g, "").match(/<base[^>]*>/)?.[0] ?? null;
	}

	test("every navigation depth gets exactly one effective base element", () => {
		for (const [path, href] of [
			["/", "./"],
			["/login", "./"],
			["/projects/abc", "../"],
			["/narrators/abc/archive", "../../"],
			["/projects/abc/chapters/xyz", "../../../"],
		] as const) {
			const out = injectSpaBaseHref(APP_SHELL, path);
			expect(effectiveBase(out)).toBe(`<base href="${href}">`);
		}
	});

	test("the shell's own asset references are relative, so the base governs them", () => {
		// If these were rooted, the injected base would be decorative.
		expect(APP_SHELL).not.toMatch(/rel="(?:icon|apple-touch-icon)" href="\//);
	});
});
