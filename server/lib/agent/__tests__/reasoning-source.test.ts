import { describe, expect, test } from "bun:test";
import { signatureSourcesCompatible } from "../reasoning-source";

describe("signatureSourcesCompatible", () => {
	test("same source is compatible", () => {
		expect(signatureSourcesCompatible("nug:anthropic", "nug:anthropic")).toBe(true);
		expect(signatureSourcesCompatible("anthropic", "anthropic")).toBe(true);
	});

	test("different sources are incompatible", () => {
		// Same channelType but different upstream servers.
		expect(signatureSourcesCompatible("nug:anthropic", "nug:antigravity")).toBe(false);
		expect(signatureSourcesCompatible("nug:antigravity", "nug:anthropic")).toBe(false);
		// Direct provider vs gateway channel.
		expect(signatureSourcesCompatible("anthropic", "nug:anthropic")).toBe(false);
		expect(signatureSourcesCompatible("openai", "nug:openai")).toBe(false);
	});

	test("missing stored source (legacy message) is incompatible", () => {
		expect(signatureSourcesCompatible(undefined, "nug:anthropic")).toBe(false);
		expect(signatureSourcesCompatible(null, "nug:anthropic")).toBe(false);
		expect(signatureSourcesCompatible("", "nug:anthropic")).toBe(false);
	});

	test("missing current source is incompatible", () => {
		expect(signatureSourcesCompatible("nug:anthropic", undefined)).toBe(false);
		expect(signatureSourcesCompatible("nug:anthropic", null)).toBe(false);
		expect(signatureSourcesCompatible("nug:anthropic", "")).toBe(false);
	});

	test("both missing is incompatible", () => {
		expect(signatureSourcesCompatible(undefined, undefined)).toBe(false);
	});
});
