/**
 * app-embedding-policy.test.ts — The SPA must stay embeddable in an editor webview.
 *
 * The VS Code extension renders NarraFork's own UI inside an iframe. Nothing in the
 * request pipeline currently sends `X-Frame-Options` or a CSP `frame-ancestors` for the
 * app shell, so that works today — by absence, not by decision.
 *
 * This test turns the absence into a decision. Adding a blanket
 * `X-Frame-Options: DENY` is a natural-looking hardening change, and its effect on the
 * extension is a BLANK PANEL: the browser refuses the frame, the SPA never boots, and
 * there is no request failure or server-side error to trace. Whoever makes that change
 * should be told here, in a file that explains what depends on it, rather than finding
 * out from a bug report about an empty webview.
 *
 * Scope note: `routes/plugin-ui.ts` and `routes/shares.ts` DO set restrictive CSPs, and
 * they must keep doing so — those serve untrusted plugin/shared content and are
 * deliberately sandboxed. This guard is about the app shell and `/api/*` only.
 */

import { describe, expect, test } from "bun:test";

const APP_TS = await Bun.file("server/app.ts").text();
const SERVER_MAIN = await Bun.file("server/main.ts").text();

/** Strip comments so prose explaining a header is not mistaken for setting one. */
function withoutComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");
}

describe("app shell embedding policy", () => {
	test("neither app.ts nor main.ts sends X-Frame-Options", () => {
		// A blanket DENY/SAMEORIGIN here breaks the extension panel with no diagnosable
		// symptom. If a future change genuinely needs framing control, it must scope the
		// header to specific routes and allow the editor webview explicitly.
		for (const source of [withoutComments(APP_TS), withoutComments(SERVER_MAIN)]) {
			expect(source).not.toMatch(/X-Frame-Options/i);
		}
	});

	test("neither app.ts nor main.ts sends frame-ancestors for the app shell", () => {
		for (const source of [withoutComments(APP_TS), withoutComments(SERVER_MAIN)]) {
			expect(source).not.toMatch(/frame-ancestors/i);
		}
	});
});

describe("api cross-origin policy", () => {
	test("the allowed origin is decided by the tested resolver, not inline", () => {
		// The previous inline value was a hard-coded `http://localhost:5173` while this
		// repo's dev server runs on 7778 — wrong for years, and invisible because dev is
		// same-origin through Vite's proxy. Routing the decision through a named function
		// is what makes it testable at all.
		expect(APP_TS).toContain("resolveAllowedCorsOrigin");
		expect(APP_TS).toContain("normalizeConfiguredOrigins");
	});

	test("the session renewal header stays exposed to cross-origin readers", () => {
		// The sliding-renewal token rides on a custom response header, which a
		// cross-origin caller cannot read unless it is listed in `exposeHeaders`. Without
		// it an embedded front end would keep using a token until it expires outright,
		// then appear to log the user out at random.
		expect(APP_TS).toContain("exposeHeaders: [SESSION_RENEWAL_HEADER]");
	});

	test("responses declare that they vary by Origin", () => {
		// The allow header now echoes the caller's origin, so a shared cache must not
		// reuse one origin's response for another. Asserted behaviourally in
		// `tests/server/api-cors-vary.test.ts`; this only pins that the wiring stays in
		// `app.ts`, since deleting it there would leave that test passing against its own
		// reconstruction.
		expect(withoutComments(APP_TS)).toMatch(/append\(\s*"Vary"\s*,\s*"Origin"\s*\)/);
	});
});
