import { AppError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import { settings } from "@server/lib/settings";
import {
	speechProviderQuerySchema,
	speechSynthesisRequestSchema,
	speechTranscriptionQuerySchema,
} from "@server/lib/validators/speech-requests";
import { requireAdmin } from "@server/middleware/auth";
import { readSpeechBody, speechResponseStream } from "@server/services/speech/http-stream";
import { SpeechService } from "@server/services/speech/service";
import { SPEECH_LIMITS, type SpeechTranscriptEvent } from "@shared/speech";
import { Hono } from "hono";

const encoder = new TextEncoder();
const AUDIO_MIMES = new Set([
	"audio/wav",
	"audio/x-wav",
	"audio/mpeg",
	"audio/mp3",
	"audio/mp4",
	"audio/m4a",
	"audio/flac",
	"audio/ogg",
	"audio/webm",
	"audio/aac",
]);

/** Private session/admin routes, deliberately not registered in External API v1. */
export function createSpeechRoutes(service: SpeechService) {
	const routes = new Hono();
	routes.use("*", requireAdmin);
	routes.get("/capabilities", (c) => c.json(service.getCapabilities()));

	routes.post("/transcriptions", async (c) => {
		const query = speechTranscriptionQuerySchema.parse(c.req.query());
		const mimeType = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
		if (!AUDIO_MIMES.has(mimeType)) {
			throw new AppError("A supported audio Content-Type is required.", 415, "SPEECH_UNSUPPORTED");
		}
		const operation = service.begin(c.get("user").sub, "asr", query.providerId, c.req.raw.signal);
		try {
			const audio = await readSpeechBody(c.req.raw, SPEECH_LIMITS.inputBytes, operation.signal);
			const events = operation.transcribe({
				audio,
				mimeType,
				language: query.language,
				stream: query.stream === "true",
			});
			if (query.stream !== "true") {
				let text: string | undefined;
				for await (const event of events) if (event.type === "done") text = event.text;
				return c.json({ text }, 200, { "Cache-Control": "no-store" });
			}
			const encode = (event: SpeechTranscriptEvent) =>
				encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			const source = events[Symbol.asyncIterator]();
			const firstEvent = await source.next();
			async function* stream() {
				try {
					if (!firstEvent.done) yield encode(firstEvent.value);
					for (;;) {
						const next = await source.next();
						if (next.done) break;
						yield encode(next.value);
					}
				} catch {
					yield encoder.encode('event: error\ndata: {"code":"SPEECH_INTERRUPTED"}\n\n');
				} finally {
					await source.return?.();
				}
			}
			const iterator = stream();
			const first = await iterator.next();
			return new Response(
				speechResponseStream(iterator, first, operation.signal, operation.close),
				{
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-store",
						"X-Accel-Buffering": "no",
					},
				},
			);
		} catch (error) {
			operation.close();
			throw error;
		}
	});

	routes.post("/synthesis", async (c) => {
		const query = speechProviderQuerySchema.parse(c.req.query());
		if (
			(c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase() !== "application/json"
		) {
			throw new AppError("JSON Content-Type is required.", 415, "SPEECH_UNSUPPORTED");
		}
		const operation = service.begin(c.get("user").sub, "tts", query.providerId, c.req.raw.signal);
		try {
			const bytes = await readSpeechBody(c.req.raw, 128 * 1024, operation.signal);
			let json: unknown;
			try {
				json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			} catch {
				throw new AppError("Invalid speech request JSON.", 400, "SPEECH_INVALID_REQUEST");
			}
			const input = speechSynthesisRequestSchema.parse(json);
			const { metadata, audio } = await operation.synthesize(input);
			const iterator = audio[Symbol.asyncIterator]();
			// Validate the first upstream audio frame before committing a successful response.
			const first = await iterator.next();
			const headers = new Headers({
				"Content-Type": metadata.mimeType,
				"Cache-Control": "no-store",
				"X-Audio-Format": metadata.format,
				"X-Content-Type-Options": "nosniff",
			});
			if (metadata.sampleRate) headers.set("X-Audio-Sample-Rate", String(metadata.sampleRate));
			if (metadata.channels) headers.set("X-Audio-Channels", String(metadata.channels));
			return new Response(
				speechResponseStream(iterator, first, operation.signal, operation.close),
				{ headers },
			);
		} catch (error) {
			operation.close();
			throw error;
		}
	});
	return routes;
}

export const speechRoutes = createSpeechRoutes(
	new SpeechService(() => settings.speech ?? { enabled: false, providers: [] }, undefined, {
		onSlow: (entry) => logger.warn("Slow speech operation", entry),
	}),
);
