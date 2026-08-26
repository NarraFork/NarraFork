/**
 * loopback.test.ts — Address spellings that decide whether the panel works at all.
 *
 * THE BUG THIS SUITE EXISTS FOR
 * ----------------------------
 * A backend bound to the IPv6 loopback only (Bun's behaviour for `host: "localhost"` on
 * a dual-stack machine) is reachable at `http://[::1]:7778` and NOT at `127.0.0.1`. So
 * that is what a user pins in `narrafork.serverUrl` — and in code-server the panel then
 * came up blank.
 *
 * Three independent failures stacked up, none of which reported anything:
 *
 *  1. `asExternalUri` port-maps only authorities matching its own regex, quoted verbatim
 *     from the VS Code bundle code-server ships:
 *         /^(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)$/
 *     An IPv6 literal does not match, so the URL came back UNCHANGED — no tunnel, no
 *     `/proxy/<port>/`. The call reports success either way.
 *  2. The unchanged loopback URL was handed to the webview, whose browser is on the
 *     user's machine, where nothing listens.
 *  3. A bracketed IPv6 host cannot appear in a CSP source list, so `frame-src` was
 *     discarded and collapsed to `'none'` — blocking the iframe under a policy that
 *     looks permissive in the served HTML.
 *
 * The observable result was a blank panel plus a console warning inside a webview.
 */

import { describe, expect, test } from "bun:test";
import {
	isLoopbackHost,
	isMappableByExternalUri,
	isValidCspSource,
	toMappableLoopbackOrigin,
} from "../../vscode-extension/src/loopback";

/** The exact regex VS Code uses to decide whether it can port-map an authority. */
const VSCODE_PORT_MAPPING_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)$/;

describe("isLoopbackHost", () => {
	test("recognises every spelling of the local machine", () => {
		for (const host of [
			"localhost",
			"LOCALHOST",
			"127.0.0.1",
			// Browsers and tooling use 127.0.0.2+ for isolation; equally local.
			"127.0.0.2",
			"::1",
			"[::1]",
			"0:0:0:0:0:0:0:1",
		]) {
			expect(isLoopbackHost(host)).toBe(true);
		}
	});

	test("does not claim remote hosts", () => {
		for (const host of ["example.com", "10.0.0.1", "0.0.0.0", "127.0.0.256", "notlocalhost"]) {
			expect(isLoopbackHost(host)).toBe(false);
		}
	});
});

describe("isMappableByExternalUri", () => {
	test("agrees with VS Code's actual regex", () => {
		// ⚠️ Asserted AGAINST the upstream pattern rather than restating its verdicts, so
		// this cannot drift into testing our own opinion of what VS Code accepts.
		for (const origin of [
			"http://localhost:7778",
			"http://127.0.0.1:7778",
			"http://0.0.0.0:7778",
			"http://[::1]:7778",
			"https://localhost:7778",
			"http://example.com:7778",
		]) {
			const authority = new URL(origin).host;
			expect(isMappableByExternalUri(origin)).toBe(VSCODE_PORT_MAPPING_RE.test(authority));
		}
	});

	test("the IPv6 literal that caused the blank panel is NOT mappable", () => {
		expect(isMappableByExternalUri("http://[::1]:7778")).toBe(false);
	});

	test("an implicit port is not mappable, because the regex requires one", () => {
		expect(isMappableByExternalUri("http://localhost")).toBe(false);
	});
});

describe("toMappableLoopbackOrigin", () => {
	test("rewrites an IPv6 loopback literal to localhost", () => {
		// The whole fix in one line: same machine, a spelling VS Code can forward.
		expect(toMappableLoopbackOrigin("http://[::1]:7778")).toBe("http://localhost:7778");
		expect(toMappableLoopbackOrigin("http://[0:0:0:0:0:0:0:1]:7778")).toBe("http://localhost:7778");
	});

	test("rewrites IPv4 loopback to localhost too", () => {
		// ⚠️ localhost, NOT 127.0.0.1: a backend may be listening on the IPv6 loopback
		// only, where 127.0.0.1 is refused outright. `localhost` resolves to whichever
		// family is up, so it is the only spelling that works for both.
		expect(toMappableLoopbackOrigin("http://127.0.0.1:7778")).toBe("http://localhost:7778");
	});

	test("output is always mappable, which is the point", () => {
		for (const origin of ["http://[::1]:7778", "http://127.0.0.1:7778", "http://localhost:7778"]) {
			expect(isMappableByExternalUri(toMappableLoopbackOrigin(origin))).toBe(true);
		}
	});

	test("preserves scheme and port, and is idempotent", () => {
		expect(toMappableLoopbackOrigin("https://[::1]:8443")).toBe("https://localhost:8443");
		const once = toMappableLoopbackOrigin("http://[::1]:7778");
		expect(toMappableLoopbackOrigin(once)).toBe(once);
	});

	test("leaves a remote address completely alone", () => {
		// Rewriting a non-loopback host would change WHICH machine is addressed — the one
		// thing this must never do.
		for (const origin of [
			"https://nf.example.com",
			"http://10.0.0.5:7778",
			"http://0.0.0.0:7778",
		]) {
			expect(toMappableLoopbackOrigin(origin)).toBe(origin);
		}
	});

	test("passes through an unparseable value rather than inventing one", () => {
		expect(toMappableLoopbackOrigin("not a url")).toBe("not a url");
	});
});

describe("isValidCspSource", () => {
	test("refuses a bracketed IPv6 host", () => {
		// This is failure #3: the browser discards the invalid source and `frame-src`
		// collapses to 'none', so the iframe is blocked by a policy that reads as
		// permissive. Refusing lets the extension say so instead.
		expect(isValidCspSource("http://[::1]:7778")).toBe(false);
	});

	test("accepts the origins the panel actually ships", () => {
		for (const origin of [
			"http://localhost:7778",
			"https://code.example.com",
			"https://code.example.com:1092",
		]) {
			expect(isValidCspSource(origin)).toBe(true);
		}
	});
});
