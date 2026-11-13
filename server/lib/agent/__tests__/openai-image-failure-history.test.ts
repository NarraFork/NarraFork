import { describe, expect, test } from "bun:test";
import { OpenAIProvider } from "../openai-provider";
import type { DbMessage } from "../provider";

const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

function provider() {
	return new OpenAIProvider({
		id: "image-history",
		name: "Image history test",
		prefix: "image-history",
		apiKey: "unused",
		baseUrl: "https://example.invalid/v1",
		defaultModel: "gpt-5.5",
		apiMode: "responses",
	});
}

function message(block: Record<string, unknown>): DbMessage {
	return {
		id: "image-message",
		role: "assistant",
		contentJson: [block],
		contentText: null,
		parentToolUseId: null,
		messageUuid: null,
		toolCalls: [],
	};
}

describe("Responses image failure history", () => {
	for (const status of ["failed", "cancelled", "incomplete"]) {
		test(`${status} retains its explanation without replaying a successful native image`, async () => {
			const built = await provider().buildHistory(
				[
					message({
						type: "image_generation",
						id: "ig_failure",
						status,
						error: "No final image was received",
						errorCode: "image_result_missing",
						// A partial preview must not become a completed native result.
						result: PNG,
					}),
				],
				"image-history:gpt-5.5",
			);
			const wire = JSON.stringify(built.history);
			expect(wire).toContain(status);
			expect(wire).toContain("No final image was received");
			expect(wire).toContain("image_result_missing");
			expect(wire).not.toContain('"type":"image_generation_call"');
			expect(wire).not.toContain(PNG);
		});
	}

	test("legacy empty image blocks are visible as incomplete, not successful or silently lost", async () => {
		const built = await provider().buildHistory(
			[message({ type: "image_generation", id: "ig_legacy" })],
			"image-history:gpt-5.5",
		);
		const wire = JSON.stringify(built.history);
		expect(wire).toContain("incomplete");
		expect(wire).not.toContain('"type":"image_generation_call"');
	});

	test("legacy successful image results still replay natively", async () => {
		const built = await provider().buildHistory(
			[message({ type: "image_generation", id: "ig_legacy_success", result: PNG })],
			"image-history:gpt-5.5",
		);
		const wire = JSON.stringify(built.history);
		expect(wire).toContain('"type":"image_generation_call"');
		expect(wire).toContain('"status":"completed"');
		expect(wire).toContain(PNG);
	});
});
