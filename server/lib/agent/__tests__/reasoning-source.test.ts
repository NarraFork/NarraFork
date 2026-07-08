import { describe, expect, test } from "bun:test";
import { signatureSourcesCompatible } from "../reasoning-source";

describe("signatureSourcesCompatible", () => {
	test("same source is compatible", () => {
		expect(signatureSourcesCompatible("anthropic", "anthropic")).toBe(true);
	});

	test("different sources are incompatible", () => {
		// Direct provider vs gateway channel.
		expect(signatureSourcesCompatible("anthropic", "nug:anthropic")).toBe(false);
	});

	test("missing stored source (legacy message) is incompatible", () => {
	});

	test("missing current source is incompatible", () => {
	});

	test("both missing is incompatible", () => {
		expect(signatureSourcesCompatible(undefined, undefined)).toBe(false);
	});
});
