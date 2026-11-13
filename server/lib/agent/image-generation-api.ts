export interface ImageGenerationRequest {
	prompt: string;
	model: string;
	size?: string;
	transparentBackground?: boolean;
	quality?: string;
	signal: AbortSignal;
	conversationId?: string;
	chatModel?: string;
	callId?: string;
}

export interface ImageGenerationResponse {
	response: Response;
	credentialId?: string;
}

export function buildImageGenerationBody(params: ImageGenerationRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: params.model,
		prompt: params.prompt,
	};
	if (params.size !== undefined) body.size = params.size;
	if (params.quality !== undefined) body.quality = params.quality;
	if (params.transparentBackground === true) {
		body.background = "transparent";
		body.output_format = "png";
	}
	return body;
}
