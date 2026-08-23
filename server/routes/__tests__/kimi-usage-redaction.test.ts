/**
 * `GET /api/kimi/usages` is readable by every signed-in user, but its `error` field is not.
 *
 * The quota numbers are what the status bar needs, and showing them to whoever is using a
 * Kimi model is the point of opening the route up. The error string is a different kind of
 * value: `kimi-usage-cache.ts` stores the caught message verbatim, so it can carry a
 * fragment of the API key, the account identifier, or an internal endpoint URL — facts about
 * the deployment's own provider account, not about the requesting user's allowance.
 *
 * Withholding it is why this file exists. The route was admin-only until recently, so the
 * field was never reachable by a non-admin and nothing had to assert it; after the widening,
 * a leak here would be invisible (a correct-looking response containing one extra string).
 *
 * `hasError` replaces it rather than the field simply vanishing: the status bar must still
 * render "unavailable" instead of presenting the last cached numbers as current.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/routes/__tests__/kimi-usage-redaction.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { KimiUsageCache } from "../../lib/kimi-usage-cache";
import { redactUsagesForRole } from "../kimi";

/** A cache entry whose refresh failed, with a deliberately sensitive-looking message. */
const SECRET_ERROR = "401 from https://kimi.com/api/internal/usage (key sk-live-abc123 rejected)";

function usages(error: string | null): Record<string, KimiUsageCache> {
	return {
		"provider-1": {
			fiveHour: { used: 10, limit: 100, remaining: 90, resetTime: null },
			weekly: null,
			monthly: null,
			extraWindows: [],
			fetchedAt: 1_700_000_000_000,
			error,
		},
	};
}

describe("kimi usage redaction", () => {
	test("a non-admin never receives the upstream error text", () => {
		const result = redactUsagesForRole(usages(SECRET_ERROR), false);
		const entry = result["provider-1"] as Record<string, unknown>;

		// Asserted on the SERIALIZED response, not on the object: an `error` key set to
		// undefined would pass an `expect(entry.error).toBeUndefined()` check while still
		// being absent from JSON — but a key left in place with the string would not, and
		// that is the direction that leaks.
		expect(JSON.stringify(result)).not.toContain("sk-live-abc123");
		expect(JSON.stringify(result)).not.toContain("kimi.com/api/internal");
		expect(Object.hasOwn(entry, "error")).toBe(false);
	});

	test("a non-admin can still tell the fetch failed", () => {
		// Without this the status bar would render the last cached numbers as if current.
		const entry = redactUsagesForRole(usages(SECRET_ERROR), false)["provider-1"] as Record<
			string,
			unknown
		>;
		expect(entry.hasError).toBe(true);
	});

	test("a successful fetch reports hasError false, not a missing field", () => {
		const entry = redactUsagesForRole(usages(null), false)["provider-1"] as Record<string, unknown>;
		expect(entry.hasError).toBe(false);
	});

	test("the quota numbers survive redaction untouched", () => {
		// Redacting must not cost the data the route was opened up to serve.
		const entry = redactUsagesForRole(usages(SECRET_ERROR), false)["provider-1"] as Record<
			string,
			unknown
		>;
		expect(entry.fiveHour).toEqual({ used: 10, limit: 100, remaining: 90, resetTime: null });
		expect(entry.fetchedAt).toBe(1_700_000_000_000);
	});

	test("an admin gets the full error text", () => {
		// They are the only principal who can act on it.
		const entry = redactUsagesForRole(usages(SECRET_ERROR), true)["provider-1"] as Record<
			string,
			unknown
		>;
		expect(entry.error).toBe(SECRET_ERROR);
		// And no `hasError` shim: the admin shape is the cache entry itself, unchanged.
		expect(Object.hasOwn(entry, "hasError")).toBe(false);
	});
});
