import { z } from "zod/v4";
import { redactDiagnosticText } from "../../net/diagnostic-redaction";
import type { ImageGenerationRequest } from "../image-generation-api";
import {
	generateAndStoreImages,
	recoverStoredImages,
	type StoredImageGeneration,
} from "../image-generation-response";
import { getProvider } from "../provider";
import type { ToolDefinition, ToolResult } from "../types";

const imageGenParameters = z
	.object({
		prompt: z.string().min(1).optional().describe("Description of the image to generate"),
		model: z
			.string()
			.min(1)
			.optional()
			.describe("Upstream image-generation model ID, not the conversation model"),
		size: z.string().min(1).optional().describe("Image size accepted by the provider, or auto"),
		transparent_background: z.boolean().optional().describe("Request a transparent PNG background"),
		quality: z.string().min(1).optional().describe("Quality value accepted by the image provider"),
		response_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Recover a previously received response locally, without generating or paying again",
			),
	})
	.superRefine((args, ctx) => {
		if (args.response_id) {
			if (
				args.prompt !== undefined ||
				args.model !== undefined ||
				args.size !== undefined ||
				args.transparent_background !== undefined ||
				args.quality !== undefined
			) {
				ctx.addIssue({
					code: "custom",
					message: "Recovery accepts only response_id; it never starts another generation.",
				});
			}
			return;
		}
		if (!args.prompt || !args.model) {
			ctx.addIssue({
				code: "custom",
				message:
					"Generation requires prompt and an explicit image model ID, or use response_id to recover.",
			});
		}
	});

function storedImageResult(result: StoredImageGeneration): ToolResult {
	return {
		output: [
			`Generated ${result.images.length} image(s). Response ID: ${result.responseId}.`,
			...result.images.map((image) => image.filePath),
		].join("\n"),
		title: "Generated images",
		imageRefs: result.images.map(({ imageId, mediaType, uploadNarratorId }) => ({
			imageId,
			mediaType,
			uploadNarratorId,
		})),
		metadata: {
			imageGeneration: {
				responseId: result.responseId,
				model: result.model,
				images: result.images,
			},
		},
	};
}

export const imageGenTool: ToolDefinition = {
	name: "ImageGen",
	description:
		"Generate images through the current provider's Images API. Supply prompt and an explicit " +
		"image-generation model ID supported by that provider; do not substitute the conversation model " +
		"or assume a particular model is the latest. Optional size, quality, and transparent_background " +
		"are passed to the provider without silently changing them. This tool generates new images; " +
		"it does not edit reference images. All returned images are saved and shown in the tool result. " +
		"If generation returned a response_id but local processing failed, invoke this tool with only " +
		"response_id to recover the saved response locally. Recovery never sends another generation request. " +
		"Do not repeat the prompt to recover an already-paid response. The existing native image tool, " +
		"if available, remains separate and is not disabled by loading ImageGen.",
	parameters: imageGenParameters,
	async execute(input, ctx): Promise<ToolResult> {
		const args = imageGenParameters.parse(input);
		const scope = {
			narratorId: ctx.narratorId,
			callId: ctx.currentToolUseId,
			signal: ctx.signal,
		};
		try {
			ctx.signal.throwIfAborted();
			if (args.response_id) {
				return storedImageResult(await recoverStoredImages(args.response_id, scope));
			}
			if (!ctx.provider) throw new Error("No provider is selected for this conversation.");
			const provider = getProvider(ctx.provider);
			if (!provider.generateImage) {
				throw new Error(`Provider ${ctx.provider} does not expose an Images API client.`);
			}
			if (!args.prompt || !args.model) throw new Error("Generation requires prompt and model.");
			const generate = provider.generateImage.bind(provider);
			const request: ImageGenerationRequest = {
				prompt: args.prompt,
				model: args.model,
				size: args.size,
				transparentBackground: args.transparent_background,
				quality: args.quality,
				signal: ctx.signal,
				conversationId: ctx.narratorId,
				chatModel: ctx.model,
				callId: ctx.currentToolUseId,
			};
			return storedImageResult(await generateAndStoreImages(request, scope, generate));
		} catch (error) {
			const responseId =
				error &&
				typeof error === "object" &&
				"responseId" in error &&
				typeof error.responseId === "string"
					? error.responseId
					: undefined;
			const message = redactDiagnosticText(error instanceof Error ? error.message : String(error));
			return {
				isError: true,
				output:
					`Image generation ${ctx.signal.aborted ? "cancelled" : "failed"}: ${message}` +
					(responseId
						? `\nSaved response_id: ${responseId}. Recover with ImageGen({response_id: "${responseId}"}); do not generate again.`
						: ""),
				...(responseId ? { metadata: { imageGeneration: { responseId } } } : {}),
			};
		}
	},
};
