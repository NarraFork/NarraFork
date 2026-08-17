import { afterEach, describe, expect, test } from "bun:test";
import {
	deleteNugCachedModels,
	dropNugCachedCapability,
	getNugCachedCapabilities,
	nugSupportsCapability,
	setNugCachedCapabilities,
} from "./nug-model-cache";

/**
 * Gateway capability advertisements.
 *
 * A capability decides which endpoint a request targets, and the fallback path
 * still works — so every mistake here is silent. The distinction that carries the
 * most weight is "said nothing" (an older gateway, must fall back) versus "said it
 * serves this" (use the new endpoint).
 */

const PROVIDER = "cap-test-provider";

afterEach(() => {
	setNugCachedCapabilities(PROVIDER, undefined);
	deleteNugCachedModels(PROVIDER);
});

describe("nug capability cache", () => {
	test("records an advertised list", () => {

	});

	test("an unknown provider supports nothing", () => {
		// The default direction has to be "not capable": guessing yes would target an
		// endpoint that may not exist, while guessing no only costs the legacy path.
		expect(getNugCachedCapabilities("never-seen")).toBeUndefined();
	});

	test("an absent field clears a previous advertisement", () => {
		// This is what makes a rolled-back gateway stop being treated as capable.
		// Leaving the old list would send every request to an endpoint that now 404s.
		setNugCachedCapabilities(PROVIDER, undefined);

		expect(getNugCachedCapabilities(PROVIDER)).toBeUndefined();
	});

	test("malformed payloads are treated as no advertisement", () => {
		// A non-array, or an array whose every entry is unusable, is malformed rather
		// than a deliberate empty list — reported as "said nothing" so it is not
		// mistaken for a gateway that legitimately serves no optional protocol.
			expect(setNugCachedCapabilities(PROVIDER, malformed)).toBeUndefined();
		}
	});

	test("an explicit empty list is distinguished from saying nothing", () => {
		// Behaviourally identical (both support nothing), but the distinction lets a
		// support question about a gateway advertising no optional protocol be told
		// apart from one still running an old image.
		expect(setNugCachedCapabilities(PROVIDER, [])).toEqual([]);

		expect(getNugCachedCapabilities(PROVIDER)).toEqual([]);

		setNugCachedCapabilities(PROVIDER, undefined);
		expect(getNugCachedCapabilities(PROVIDER)).toBeUndefined();
	});

	test("non-string entries are dropped but valid siblings survive", () => {

	});

	test("matching is exact, not by prefix", () => {
		// A gateway serving some other optional protocol must not be mistaken for one
		// serving this endpoint.

	});
});

describe("withdrawing a capability after a 404", () => {
	test("drops the named capability and keeps the others", () => {
		// The catalog and the served routes can disagree: rolling the image back
		// leaves a cached catalog from the newer build, so the advertisement outlives
		// the endpoint and has to be withdrawn on first contact.

		expect(getNugCachedCapabilities(PROVIDER)).toEqual(["other.v1"]);
	});

	test("clears the entry entirely when the last capability goes", () => {

		expect(getNugCachedCapabilities(PROVIDER)).toBeUndefined();
	});

	test("reports no change when the capability was not advertised", () => {
		// The caller logs on a real withdrawal, so a repeated 404 must not keep
		// producing log lines for something already forgotten.
		setNugCachedCapabilities(PROVIDER, ["other.v1"]);

	});

	test("a later catalog fetch can restore it", () => {
		// Upgrading the gateway again must re-enable the endpoint without a client
		// restart.


	});
});
