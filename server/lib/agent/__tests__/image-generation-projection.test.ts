import { describe, expect, test } from "bun:test";
import { decodeLegacyContent } from "@shared/narrator-blocks/decode";
import { NO_ASSETS, toTurns } from "../projection/turns";

function project(raw: Record<string, unknown>) {
	const envelope = decodeLegacyContent({
		id: "message",
		role: "assistant",
		contentJson: [{ type: "image_generation", id: "image", ...raw }],
		contentText: null,
		parentToolUseId: null,
	});
	return toTurns(
		[envelope],
		{ strict: false },
		{
			...NO_ASSETS,
			generatedImages: new Map([["message:0", "readable-bytes"]]),
		},
	).turns;
}

describe("native image history projection", () => {
	for (const status of ["failed", "cancelled", "incomplete"]) {
		test(`${status} retains the real error without replaying image bytes`, () => {
			expect(
				project({ status, error: "upstream detail", errorCode: "policy", result: "stale" }),
			).toEqual([
				{
					kind: "assistant",
					envelopeId: "message",
					items: [
						{
							kind: "image_generation",
							blockId: "message:0",
							wireId: "image",
							status,
							error: "upstream detail",
							errorCode: "policy",
						},
					],
				},
			]);
		});
	}

	test("unknown legacy state stays unknown, while a saved artifact establishes legacy success", () => {
		const unknown = project({});
		expect(unknown[0]?.kind === "assistant" && unknown[0].items[0]).not.toHaveProperty("status");
		const saved = project({ savedPath: "/generated.png", revisedPrompt: "prompt" });
		expect(saved[0]?.kind === "assistant" && saved[0].items[0]).toMatchObject({
			status: "completed",
			savedPath: "/generated.png",
			revisedPrompt: "prompt",
			result: "readable-bytes",
		});
	});

	test("active image calls are not projected into history", () => {
		expect(project({ status: "generating" })).toEqual([]);
	});
});
