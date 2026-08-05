import { describe, expect, test } from "bun:test";
import { isCodexImageGenerationDisabledError } from "../codex-image-generation-error";

describe("isCodexImageGenerationDisabledError — recognizes the refusal", () => {
	test("matches the observed Codex gateway wording", () => {
		expect(
			isCodexImageGenerationDisabledError(
				"OpenAI API error 403: Image generation is not enabled for this group",
			),
		).toBe(true);
	});

	test("matches through the timeline's display prefixes", () => {
		// The card text carries `[Error] ` / `Error: `; the predicate runs on the
		// rendered string, so it must not depend on them being stripped first.
		expect(
			isCodexImageGenerationDisabledError(
				"[Error] OpenAI API error 403: Image generation is not enabled for this group",
			),
		).toBe(true);
		expect(
			isCodexImageGenerationDisabledError(
				"Error: OpenAI API error 403: image_generation is not allowed",
			),
		).toBe(true);
	});

	test("matches reworded relay refusals that still name the tool", () => {
		for (const message of [
			"OpenAI API error 403: image_generation is not supported for this account",
			"403 Forbidden: unsupported tool: image_generation",
			"permission_denied: the image_generation tool is disabled for your plan",
			"insufficient_permissions — image generation not allowed",
		]) {
			expect(isCodexImageGenerationDisabledError(message)).toBe(true);
		}
	});

	test("accepts a named forbidden status without the numeric code", () => {
		expect(isCodexImageGenerationDisabledError("Forbidden: image generation is not enabled")).toBe(
			true,
		);
	});
});

describe("isCodexImageGenerationDisabledError — refuses to over-match", () => {
	test("a generic 403 is not an image-generation problem", () => {
		// Turning off image generation must never be offered for an auth or quota
		// failure: it would not fix anything and silently degrades the provider.
		for (const message of [
			"OpenAI API error 403: Invalid API key provided",
			"OpenAI API error 403: You exceeded your current quota",
			"403 Forbidden",
		]) {
			expect(isCodexImageGenerationDisabledError(message)).toBe(false);
		}
	});

	test("image-generation prose without a forbidden status does not match", () => {
		for (const message of [
			"OpenAI API error 500: image_generation failed to render",
			"The image_generation tool timed out",
			"image generation is not enabled in the docs example",
		]) {
			expect(isCodexImageGenerationDisabledError(message)).toBe(false);
		}
	});

	test("an unrelated tool refusal does not match", () => {
		expect(
			isCodexImageGenerationDisabledError("OpenAI API error 403: web_search is not enabled"),
		).toBe(false);
	});

	test("empty and missing values are not eligible", () => {
		expect(isCodexImageGenerationDisabledError("")).toBe(false);
		expect(isCodexImageGenerationDisabledError("   ")).toBe(false);
		expect(isCodexImageGenerationDisabledError(null)).toBe(false);
		expect(isCodexImageGenerationDisabledError(undefined)).toBe(false);
	});
});
