/**
 * cors-origin.test.ts — Contract for who may read `/api/*` cross-origin.
 *
 * This is the file that decides an access boundary, so both directions matter: too
 * narrow and the VS Code extension's webview silently cannot talk to the backend (a
 * CORS refusal surfaces in the panel as an opaque network failure), too wide and the
 * allowance stops being explainable.
 */

import { describe, expect, test } from "bun:test";
import {
	type CorsOriginPolicy,
	normalizeConfiguredOrigins,
	resolveAllowedCorsOrigin,
} from "@server/lib/cors-origin";

const SELF = "http://localhost:7778";

function allow(origin: string | undefined | null, policy: CorsOriginPolicy = {}): string | null {
	return resolveAllowedCorsOrigin(origin, { selfOrigin: SELF, ...policy });
}

describe("resolveAllowedCorsOrigin", () => {
	test("allows the server's own origin", () => {
		expect(allow(SELF)).toBe(SELF);
	});

	test("returns null when there is no Origin header", () => {
		// Not a browser-policed cross-origin request (curl, server-to-server). There is
		// nothing to allow, and echoing an allowance would be a claim about a caller we
		// know nothing about.
		expect(allow(undefined)).toBeNull();
		expect(allow(null)).toBeNull();
		expect(allow("")).toBeNull();
	});

	test("refuses the opaque origin", () => {
		// A sandboxed iframe or file:// document serializes its origin as "null".
		// Allowing it would grant read access to any sandboxed document while making the
		// policy impossible to reason about, and nothing we ship needs it.
		expect(allow("null")).toBeNull();
	});

	describe("loopback", () => {
		test("allows any loopback host and port over http/https", () => {
			// The desktop webview's origin carries a random per-webview UUID, so it cannot
			// be enumerated in configuration. Loopback also means the caller already has
			// this machine's filesystem, which is a stronger capability than CORS governs.
			for (const origin of [
				"http://localhost:3000",
				"http://127.0.0.1:9999",
				"http://127.0.0.2:8080",
				"https://localhost:8443",
				"http://[::1]:7778",
			]) {
				expect(allow(origin)).toBe(origin);
			}
		});

		test("refuses non-loopback hosts", () => {
			for (const origin of [
				"https://evil.example.com",
				"http://192.168.1.10:7778",
				"http://10.0.0.5",
				// Deliberate near-misses: a hostname that merely CONTAINS a loopback
				// literal is a different host entirely, and treating it as local is the
				// classic way an allowance like this gets bypassed.
				"http://localhost.evil.example.com",
				"http://127.0.0.1.evil.example.com",
				"http://notlocalhost",
			]) {
				expect(allow(origin)).toBeNull();
			}
		});

		test("refuses loopback over a non-http scheme", () => {
			// Keeps this from degrading into "anything that mentions localhost".
			expect(allow("ws://localhost:7778")).toBeNull();
			expect(allow("ftp://127.0.0.1")).toBeNull();
		});
	});

	describe("editor webviews", () => {
		test("allows the vscode-webview scheme regardless of its authority", () => {
			// The authority is a random UUID minted per webview; there is nothing stable
			// to match, and no other party can produce this scheme in a browser context.
			expect(allow("vscode-webview://7803497a-8232-4556-988a-7a1636d48b30")).toBe(
				"vscode-webview://7803497a-8232-4556-988a-7a1636d48b30",
			);
			expect(allow("vscode-file://vscode-app")).toBe("vscode-file://vscode-app");
		});

		test("does not allow a lookalike scheme", () => {
			expect(allow("vscode-webview-evil://x")).toBeNull();
			expect(allow("https://vscode-webview.example.com")).toBeNull();
		});
	});

	describe("configured origins", () => {
		test("allows a verbatim match", () => {
			const configured = ["https://ide.example.com"];
			expect(allow("https://ide.example.com", { configured })).toBe("https://ide.example.com");
		});

		test("does not treat a configured origin as a prefix or suffix rule", () => {
			const configured = ["https://ide.example.com"];
			expect(allow("https://ide.example.com.evil.test", { configured })).toBeNull();
			expect(allow("https://evil.ide.example.com", { configured })).toBeNull();
			// Scheme and port are part of an origin, so neither may be substituted.
			expect(allow("http://ide.example.com", { configured })).toBeNull();
			expect(allow("https://ide.example.com:8443", { configured })).toBeNull();
		});
	});

	test("dev origins apply only when the caller passes them", () => {
		// The `devOrigins` hook is retained for a future non-loopback dev front end, but
		// `app.ts` deliberately passes NOTHING: the Vite dev server is on loopback, which
		// is already allowed on any port, so enumerating it would be a constant that looks
		// load-bearing while never deciding anything.
		const devOrigins = ["http://dev.internal:7778"];
		expect(allow("http://dev.internal:7778", { devOrigins })).toBe("http://dev.internal:7778");
		expect(allow("http://dev.internal:7778", { devOrigins: [] })).toBeNull();
		expect(allow("http://dev.internal:7778")).toBeNull();
	});

	test("refuses an unparseable origin", () => {
		expect(allow("not an origin")).toBeNull();
		expect(allow("://")).toBeNull();
	});

	test("works with no self origin known", () => {
		// An unparseable request URL only costs the same-origin shortcut.
		expect(resolveAllowedCorsOrigin(SELF, {})).toBe(SELF);
		expect(resolveAllowedCorsOrigin("https://evil.example.com", {})).toBeNull();
	});
});

describe("normalizeConfiguredOrigins", () => {
	test("reduces an entry with a path to its origin", () => {
		// `Origin` never carries a path, so a configured value with one could never
		// match — it would be a silent no-op the operator has no way to notice.
		expect(normalizeConfiguredOrigins(["https://ide.example.com/app"])).toEqual([
			"https://ide.example.com",
		]);
	});

	test("trims and drops empty entries", () => {
		expect(normalizeConfiguredOrigins(["  https://a.test  ", "", "   "])).toEqual([
			"https://a.test",
		]);
	});

	test("drops unparseable entries rather than keeping them verbatim", () => {
		// A verbatim malformed value can only fail to match, so keeping it would be a
		// permanent no-op that looks like configuration.
		expect(normalizeConfiguredOrigins(["not an origin", "https://ok.test"])).toEqual([
			"https://ok.test",
		]);
	});

	test("handles an absent list", () => {
		expect(normalizeConfiguredOrigins(undefined)).toEqual([]);
	});
});
