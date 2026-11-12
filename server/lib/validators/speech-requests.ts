import { SPEECH_LIMITS } from "@shared/speech";
import { z } from "zod";

export const speechProviderQuerySchema = z
	.object({
		providerId: z.string().min(1).max(200).optional(),
	})
	.strict();

export const speechTranscriptionQuerySchema = speechProviderQuerySchema.extend({
	language: z
		.string()
		.regex(/^[a-zA-Z-]{2,20}$/)
		.optional(),
	stream: z.enum(["true", "false"]).optional(),
});

export const speechSynthesisRequestSchema = z
	.object({
		text: z.string().min(1).max(SPEECH_LIMITS.textCharacters),
		voice: z.string().min(1).max(200).optional(),
		instructions: z.string().max(SPEECH_LIMITS.textCharacters).optional(),
		format: z.enum(["mp3", "wav", "pcm16", "opus", "flac", "aac"]).optional(),
	})
	.strict();
