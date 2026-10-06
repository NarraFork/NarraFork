/**
 * shell.test.ts — The webview document that hosts the SPA iframe.
 *
 * The panel's whole security posture is in this HTML: a CSP that must permit exactly one
 * frame origin and one nonce'd script, and a relay whose target origin must never be a
 * wildcard. Every mistake here fails silently — a blank panel, or a session token posted
 * to whatever occupies the frame — so the document's shape is asserted rather than
 * eyeballed.
 *
 * `shell.ts` imports nothing from `vscode` so this can run under the repo's `bun test`.
 */

import { describe, expect, it } from "bun:test";
import { buildFrameUrl, generateNonce, renderShellHtml } from "../../vscode-extension/src/shell";

const BASE_URL = "http://127.0.0.1:7778/";
const BASE_ORIGIN = "http://127.0.0.1:7778";

function render(overrides: Partial<Parameters<typeof renderShellHtml>[0]> = {}): string {
	return renderShellHtml({
		baseUrl: BASE_URL,
		baseOrigin: BASE_ORIGIN,
		nonce: "n0nce",
		handshakeNonce: "handshake123",
		loadingLabel: "Connecting…",
		...overrides,
	});
}

describe("generateNonce", () => {
	it("produces a fresh 128-bit hex value each time", () => {
		const a = generateNonce();
		const b = generateNonce();
		expect(a).toMatch(/^[0-9a-f]{32}$/);
		expect(a).not.toBe(b);
	});
});

describe("buildFrameUrl", () => {
	it("marks the load so the SPA knows it was deliberately embedded", () => {
		expect(buildFrameUrl(BASE_URL, "handshake123")).toBe(
			"http://127.0.0.1:7778/?nfEmbed=handshake123",
		);
	});

	it("preserves a mount prefix, including its trailing slash", () => {
		// code-server's `/proxy/<port>` strips the prefix and resolves relative requests
		// against the parent directory when the slash is missing, so every asset lands one
		// level too high. The result is a blank panel with nothing naming the cause.
		expect(buildFrameUrl("https://cs.example.com/proxy/7778/", "n")).toBe(
			"https://cs.example.com/proxy/7778/?nfEmbed=n",
		);
	});
});

describe("the inlined relay script", () => {
	/** The `<script nonce=…>` body, i.e. the JS the webview will actually run. */
	function scriptBody(html: string): string {
		const match = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html);
		expect(match).not.toBeNull();
		return match?.[1] ?? "";
	}

	it("is syntactically valid JavaScript", () => {
		// ⚠️ This script is JS inside a template literal, so `tsc` type-checks the STRING and
		// sees nothing wrong with a syntax error in its contents. A stray backtick in a
		// comment (which happened) terminates the template early and turns the rest of the
		// comment into live code — a build-time break in the extension, and had it landed
		// somewhere less fatal it would have shipped as a panel whose relay silently never
		// runs. Parsing the rendered body is the only check that can see it.
		expect(() => new Function(scriptBody(render()))).not.toThrow();
	});

	it("contains no backtick, which would end the enclosing template literal", () => {
		// Asserted separately from the parse check because a backtick does not always
		// produce invalid syntax — it can silently truncate the script instead.
		expect(scriptBody(render())).not.toContain("`");
	});
});

describe("renderShellHtml", () => {
	/**
	 * The CSP as the BROWSER sees it, i.e. with HTML entities decoded.
	 *
	 * The attribute is entity-escaped on the way out (`'` → `&#39;`), which is correct and
	 * decoded by the parser before the policy is applied. Asserting on the raw attribute
	 * text would be asserting on the escaping rather than on the policy.
	 */
	function cspOf(html: string): string {
		const meta = /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(html)?.[0] ?? "";
		const raw = /content="([^"]*)"/.exec(meta)?.[1] ?? "";
		return raw
			.replace(/&#39;/g, "'")
			.replace(/&quot;/g, '"')
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&");
	}

	it("frames the backend origin", () => {
		expect(cspOf(render())).toContain(`frame-src ${BASE_ORIGIN}`);
		expect(render()).toContain('src="http://127.0.0.1:7778/?nfEmbed=handshake123"');
	});

	it("allows only the nonce'd script", () => {
		const csp = cspOf(render());
		expect(csp).toContain("script-src 'nonce-n0nce'");
		// No `unsafe-inline` / `unsafe-eval` escape hatch: with them the nonce would be
		// decorative, since injected markup could execute anyway.
		expect(csp).not.toContain("unsafe-eval");
		expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
		expect(render()).toContain('<script nonce="n0nce">');
	});

	it("denies everything it does not explicitly need", () => {
		const csp = cspOf(render());
		expect(csp).toContain("default-src 'none'");
		// The relay makes no requests of its own — all API traffic happens inside the
		// iframe under the SPA's code, on the backend's origin.
		expect(csp).toContain("connect-src 'none'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("base-uri 'none'");
		expect(csp).toContain("form-action 'none'");
	});

	it("never posts to a wildcard target origin", () => {
		// ⚠️ The single most dangerous mistake available in this file: `"*"` would hand the
		// session token to whatever document occupies the frame.
		const html = render();
		expect(html).not.toMatch(/postMessage\([^)]*,\s*["']\*["']/);
		expect(html).toContain("backendOrigin");
		expect(html).toContain(`const backendOrigin = ${JSON.stringify(BASE_ORIGIN)}`);
	});

	it("relays a token upward only from the backend origin", () => {
		// The check is on the EVENT's origin, which the browser sets, rather than on
		// anything the message claims about itself.
		expect(render()).toContain("event.origin === backendOrigin");
	});

	it("announces readiness so the host does not bootstrap into a void", () => {
		expect(render()).toContain("narrafork.shell-ready");
	});

	it("escapes the values it interpolates", () => {
		// `loadingLabel` is localized text and `baseUrl` comes from `asExternalUri`; neither
		// is attacker-controlled today, but both are interpolated into markup, and an
		// unescaped `"` would silently break out of the attribute.
		const html = render({
			loadingLabel: "</script><img src=x onerror=alert(1)>",
			baseUrl: 'http://127.0.0.1:7778/"onload="alert(1)',
		});
		expect(html).not.toContain("<img src=x");
		expect(html).not.toContain('"onload="alert(1)');
		expect(html).toContain("&lt;/script&gt;");
	});
});
