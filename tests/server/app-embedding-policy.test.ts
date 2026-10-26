/**
 * app-embedding-policy.test.ts — The SPA must stay embeddable in an editor webview.
 *
 * The VS Code extension renders NarraFork's own UI inside an iframe. A blanket
 * `X-Frame-Options: DENY` is a natural-looking hardening change, and its effect on the
 * extension is a BLANK PANEL: the browser refuses the frame, the SPA never boots, and
 * there is no request failure or server-side error to trace. That header must never
 * appear — whoever reaches for it should be told here, in a file that explains what
 * depends on it, rather than finding out from a bug report about an empty webview.
 *
 * Framing IS constrained, but with a CSP `frame-ancestors` directive, not a blunt
 * `X-Frame-Options`. `app.ts` appends `frame-ancestors` to the `text/html` app shell,
 * naming exactly who may embed it: same-origin, the editor webview scheme, and the
 * operator-configured embed origins. Unlike `X-Frame-Options`, this still admits the
 * VS Code webview. The directive is merged onto any existing CSP rather than written as
 * a second header, and an existing policy that already constrains framing is left alone.
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

	test("app.ts constrains framing with a merged frame-ancestors CSP, not X-Frame-Options", () => {
		const appSource = withoutComments(APP_TS);
		// Framing control lives in app.ts (not main.ts) and uses frame-ancestors.
		expect(appSource).toMatch(/frame-ancestors/i);
		// The approved framers: same-origin, the editor webview scheme, and the
		// operator-configured embed origins (the same list trusted for CORS).
		expect(appSource).toContain("'self'");
		expect(appSource).toContain("vscode-webview:");
		expect(appSource).toContain("normalizeConfiguredOrigins(settings.server.allowedOrigins)");
		// Scoped to the HTML app shell, so API/JSON and the sanitized preview are untouched.
		expect(appSource).toMatch(/text\/html/);
		// The directive is merged onto any existing Content-Security-Policy rather than
		// written as a second header, and a policy that already constrains framing is left
		// as-is instead of being clobbered.
		expect(appSource).toContain('c.res.headers.get("Content-Security-Policy")');
		expect(appSource).toMatch(
			/if\s*\(\s*existing\s*&&\s*\/frame-ancestors\/i\.test\(existing\)\s*\)/,
		);
		expect(appSource).toMatch(
			/existing\s*\?\s*`\$\{existing\};\s*\$\{directive\}`\s*:\s*directive/,
		);
	});

	test("main.ts does not send frame-ancestors itself — app.ts owns the app-shell policy", () => {
		expect(withoutComments(SERVER_MAIN)).not.toMatch(/frame-ancestors/i);
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

	test("responses declare that they vary by Origin", () => {
		// The allow header now echoes the caller's origin, so a shared cache must not
		// reuse one origin's response for another. Asserted behaviourally in
		// `tests/server/api-cors-vary.test.ts`; this only pins that the wiring stays in
		// `app.ts`, since deleting it there would leave that test passing against its own
		// reconstruction.
		expect(withoutComments(APP_TS)).toMatch(/append\(\s*"Vary"\s*,\s*"Origin"\s*\)/);
	});
});
