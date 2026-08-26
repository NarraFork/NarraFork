/**
 * api-cors-vary.test.ts — `/api/*` responses must declare that they vary by Origin.
 *
 * WHY THIS MATTERS NOW AND DID NOT BEFORE
 * --------------------------------------
 * While the allowed origin was a single hard-coded string, the CORS headers did not
 * depend on the request, so a shared cache could reuse a response freely. The policy is
 * now per-caller: `Access-Control-Allow-Origin` echoes back the requester's own origin
 * (see `server/lib/cors-origin.ts`).
 *
 * Hono's cors middleware sets `Vary` only on the `OPTIONS` preflight. Without it on
 * ordinary responses, a reverse proxy or CDN in front of NarraFork may hand the response
 * it stored for one origin — headers included — to a different origin. That either leaks
 * a readable response to a caller that was never allowed, or refuses one that was. Both
 * are deployment-dependent and produce no error, which is why this is pinned by a
 * behavioural test rather than by reading `app.ts` for a string.
 *
 * The middleware pair is rebuilt here rather than importing `server/app.ts`, which pulls
 * in the database, every route module and the settings singleton. What is under test is
 * the ordering contract between the two middlewares, and that is reproduced exactly.
 */

import { describe, expect, test } from "bun:test";
import { normalizeConfiguredOrigins, resolveAllowedCorsOrigin } from "@server/lib/cors-origin";
import { SESSION_RENEWAL_HEADER } from "@shared/session-auth";
import { Hono } from "hono";
import { cors } from "hono/cors";

const SELF_ORIGIN = "http://localhost:7778";
const WEBVIEW_ORIGIN = "vscode-webview://7803497a-8232-4556-988a-7a1636d48b30";

function buildApp(): Hono {
	const app = new Hono();

	// Registered before `cors()` so it unwinds after it — the same order as `app.ts`.
	app.use("/api/*", async (c, next) => {
		await next();
		const existing = c.res.headers.get("Vary") ?? "";
		if (!/(^|,)\s*origin\s*(,|$)/i.test(existing)) {
			c.res.headers.append("Vary", "Origin");
		}
	});

	app.use(
		"/api/*",
		cors({
			origin: (origin, c) => {
				let selfOrigin: string | null = null;
				try {
					selfOrigin = new URL(c.req.url).origin;
				} catch {}
				return (
					resolveAllowedCorsOrigin(origin, {
						selfOrigin,
						configured: normalizeConfiguredOrigins(["https://ide.example.com"]),
					}) ?? undefined
				);
			},
			exposeHeaders: [SESSION_RENEWAL_HEADER],
		}),
	);

	app.get("/api/health", (c) => c.json({ status: "ok" }));
	return app;
}

/** Split a `Vary` header into its field names, lowercased. */
function varyFields(response: Response): string[] {
	return (response.headers.get("Vary") ?? "")
		.split(",")
		.map((field) => field.trim().toLowerCase())
		.filter(Boolean);
}

describe("Vary: Origin", () => {
	const app = buildApp();

	test("is present on an allowed cross-origin GET", async () => {
		const response = await app.request(`${SELF_ORIGIN}/api/health`, {
			headers: { Origin: WEBVIEW_ORIGIN },
		});
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(WEBVIEW_ORIGIN);
		expect(varyFields(response)).toContain("origin");
	});

	test("is present even when the origin was REFUSED", async () => {
		// The absence of `Access-Control-Allow-Origin` is itself origin-dependent, so a
		// cache must not reuse a refusal for an origin that would have been allowed.
		const response = await app.request(`${SELF_ORIGIN}/api/health`, {
			headers: { Origin: "https://evil.example.com" },
		});
		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(varyFields(response)).toContain("origin");
	});

	test("is present on a same-origin request with no Origin header", async () => {
		// A cache keyed on a no-Origin response would otherwise serve it to a
		// cross-origin caller, who would then see no allow header at all.
		const response = await app.request(`${SELF_ORIGIN}/api/health`);
		expect(varyFields(response)).toContain("origin");
	});

	test("appears exactly once, and does not displace what cors adds on a preflight", async () => {
		// cors sets `Vary: Origin` itself on OPTIONS and appends
		// `Access-Control-Request-Headers`. Appending blindly would duplicate the first
		// and setting would destroy the second.
		const response = await app.request(`${SELF_ORIGIN}/api/health`, {
			method: "OPTIONS",
			headers: {
				Origin: WEBVIEW_ORIGIN,
				"Access-Control-Request-Method": "GET",
				"Access-Control-Request-Headers": "authorization",
			},
		});
		const fields = varyFields(response);
		expect(fields.filter((field) => field === "origin")).toHaveLength(1);
		expect(fields).toContain("access-control-request-headers");
	});
});
