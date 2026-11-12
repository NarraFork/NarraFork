import { beforeEach, describe, expect, mock, test } from "bun:test";
import { toolOutputImages } from "@shared/agent-protocol/tool-output";
import { LoopTranscript } from "../../loop-transcript";
import type { ToolContext } from "../../types";

let selectedProvider = "";
let requests: Record<string, unknown>[] = [];
let recoveries: string[] = [];
let failure: Error | undefined;
let hasImagesClient = true;
const stored = {
	responseId: "saved-image-response",
	model: "configured-image-model",
	images: [
		{
			imageId: "image-1",
			mediaType: "image/png",
			uploadNarratorId: "narrator-1",
			filePath: "/private/uploads/narrator-1/image-1.png",
		},
		{
			imageId: "image-2",
			mediaType: "image/webp",
			uploadNarratorId: "narrator-1",
			filePath: "/private/uploads/narrator-1/image-2.webp",
		},
	],
};

mock.module("../../provider", () => ({
	getProvider(prefix: string) {
		selectedProvider = prefix;
		return hasImagesClient
			? {
					async generateImage(request: Record<string, unknown>) {
						requests.push(request);
						return { response: new Response("{}") };
					},
				}
			: {};
	},
}));
mock.module("../../image-generation-response", () => ({
	async generateAndStoreImages(
		request: Record<string, unknown>,
		_scope: unknown,
		send: (request: Record<string, unknown>) => Promise<unknown>,
	) {
		await send(request);
		if (failure) throw failure;
		return stored;
	},
	async recoverStoredImages(responseId: string) {
		recoveries.push(responseId);
		if (failure) throw failure;
		return stored;
	},
}));
const { imageGenTool } = await import("../image-gen");

function context(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		narratorId: "narrator-1",
		cwd: "/workspace",
		signal: new AbortController().signal,
		locale: "en",
		provider: "example-provider",
		model: "example-provider:chat-model",
		currentToolUseId: "image-tool-call",
		requestPermission: async () => ({ behavior: "allow" }),
		...overrides,
	};
}

beforeEach(() => {
	selectedProvider = "";
	requests = [];
	recoveries = [];
	failure = undefined;
	hasImagesClient = true;
});

describe("ImageGen tool", () => {
	test("uses the selected provider, explicit image model and all stored image references", async () => {
		const result = await imageGenTool.execute(
			{
				prompt: "A transparent logo",
				model: "upstream-image-model",
				size: "auto",
				transparent_background: true,
				quality: "high",
			},
			context(),
		);
		expect(result.isError).not.toBe(true);
		expect(selectedProvider).toBe("example-provider");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			prompt: "A transparent logo",
			model: "upstream-image-model",
			chatModel: "example-provider:chat-model",
			size: "auto",
			transparentBackground: true,
			quality: "high",
		});
		expect(result.images).toBeUndefined();
		expect(result.imageRefs).toHaveLength(2);
		expect(result.output).toContain("image-1.png");
		expect(result.output).toContain("image-2.webp");
	});

	test("recovery bypasses provider selection and never generates again", async () => {
		const result = await imageGenTool.execute(
			{ response_id: "saved-image-response" },
			context({ provider: undefined }),
		);
		expect(result.isError).not.toBe(true);
		expect(recoveries).toEqual(["saved-image-response"]);
		expect(selectedProvider).toBe("");
		expect(requests).toHaveLength(0);
		expect(result.imageRefs).toHaveLength(2);
	});

	test("a processing failure gives a recovery-only invocation, not a prompt retry", async () => {
		failure = Object.assign(new Error("Image could not be saved"), {
			responseId: "saved-image-response",
		});
		const result = await imageGenTool.execute({ prompt: "Logo", model: "image-model" }, context());
		expect(result.isError).toBe(true);
		expect(requests).toHaveLength(1);
		expect(result.output).toContain('ImageGen({response_id: "saved-image-response"})');
		expect(result.output).toContain("do not generate again");
		expect(result.metadata).toMatchObject({
			imageGeneration: { responseId: "saved-image-response" },
		});
	});

	test("validates generation and recovery modes before any network request", () => {
		expect(() => imageGenTool.parameters.parse({ prompt: "Logo" })).toThrow();
		expect(() => imageGenTool.parameters.parse({ response_id: "saved", prompt: "Logo" })).toThrow();
		expect(() => imageGenTool.parameters.parse({})).toThrow();
		expect(requests).toHaveLength(0);
	});

	test("does not silently change provider when the selected one has no Images client", async () => {
		hasImagesClient = false;
		const result = await imageGenTool.execute({ prompt: "Logo", model: "image-model" }, context());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("does not expose an Images API client");
		expect(requests).toHaveLength(0);
	});

	test("honors cancellation before starting generation", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await imageGenTool.execute(
			{ prompt: "Logo", model: "image-model" },
			context({ signal: controller.signal }),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("cancelled");
		expect(requests).toHaveLength(0);
	});

	test("the in-memory transcript keeps worker-saved references without base64 copies", async () => {
		const result = await imageGenTool.execute({ response_id: "saved-image-response" }, context());
		const transcript = new LoopTranscript();
		transcript.appendStep([
			{ type: "tool_use", toolUseId: "image-tool-call", name: "ImageGen", input: {} },
		]);
		transcript.settleTool("image-tool-call", result);
		const output = transcript.rows[0]?.toolCalls?.[0]?.outputJson;
		expect(toolOutputImages(output)).toEqual(result.imageRefs ?? []);
		expect(JSON.stringify(output)).not.toContain("base64");
	});
});
