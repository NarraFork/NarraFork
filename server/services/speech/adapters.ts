import {
	SPEECH_LIMITS,
	type SpeechAudioFormat,
	type SpeechAudioMetadata,
	type SpeechAudioOutput,
	type SpeechCapabilities,
	type SpeechProvider,
	type SpeechSynthesisInput,
	type SpeechTranscriptEvent,
	type SpeechTranscriptionInput,
} from "@shared/speech";
import {
	decodeAudio,
	finished,
	jsonResponse,
	postSpeech,
	record,
	speechError,
	sseEvents,
} from "./transport";

const OPENAI_FORMATS: SpeechAudioFormat[] = ["mp3", "wav", "pcm16", "opus", "flac", "aac"];
function formats(provider: SpeechProvider): SpeechAudioFormat[] {
	switch (provider.tts?.protocol) {
		case "openai-speech":
			return [...OPENAI_FORMATS];
		case "chat-completions-tts":
			return provider.tts.streaming ? ["pcm16"] : ["wav", "pcm16"];
		case "dashscope-tts":
			return provider.tts.variant === "qwen-audio-tts" ? ["wav", "pcm16", "mp3"] : ["pcm16"];
		default:
			return [];
	}
}

export function getCapabilities(provider: SpeechProvider): SpeechCapabilities {
	return {
		id: provider.id,
		name: provider.name,
		...(provider.asr
			? {
					asr: {
						textStreaming:
							provider.asr.protocol === "chat-completions-asr" && provider.asr.streaming === true,
						realtimeInput: false as const,
					},
				}
			: {}),
		...(provider.tts
			? {
					tts: {
						audioStreaming:
							provider.tts.protocol !== "chat-completions-tts" || provider.tts.streaming === true,
						formats: formats(provider),
						urlDownload: false as const,
					},
				}
			: {}),
	};
}

function textLimit(text: string): void {
	if (text.length > SPEECH_LIMITS.outputBytes / 4) throw speechError("SPEECH_OUTPUT_LIMIT");
}

export async function* transcribe(
	provider: SpeechProvider,
	input: SpeechTranscriptionInput,
	signal: AbortSignal,
): AsyncIterable<SpeechTranscriptEvent> {
	const profile = provider.asr;
	if (!profile || !input.audio.byteLength || input.audio.byteLength > SPEECH_LIMITS.inputBytes)
		throw speechError("SPEECH_INVALID_INPUT");
	const stream = input.stream === true;
	if (stream && !getCapabilities(provider).asr?.textStreaming)
		throw speechError("SPEECH_UNSUPPORTED_STREAMING");
	if (profile.protocol === "openai-transcription") {
		const form = new FormData();
		form.set("model", profile.model);
		form.set("response_format", "json");
		form.set(
			"file",
			new Blob([new Uint8Array(input.audio)], { type: input.mimeType }),
			input.filename ?? "audio",
		);
		if (input.language) form.set("language", input.language);
		const value = await jsonResponse(
			await postSpeech(provider, "audio/transcriptions", form, signal),
		);
		if (typeof value.text !== "string") throw speechError("SPEECH_INVALID_RESPONSE");
		textLimit(value.text);
		yield { type: "done", text: value.text };
		return;
	}
	const prefix = `data:${input.mimeType};base64,`;
	if (
		profile.variant === "mimo" &&
		(!["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"].includes(input.mimeType) ||
			Buffer.byteLength(prefix) + 4 * Math.ceil(input.audio.length / 3) > 10 * 1024 * 1024 ||
			(input.language !== undefined && !["auto", "zh", "en"].includes(input.language)))
	)
		throw speechError("SPEECH_INVALID_INPUT");
	const data = prefix + Buffer.from(input.audio).toString("base64");
	const asrOptions: Record<string, unknown> = {};
	if (input.language) asrOptions.language = input.language;
	if (profile.variant === "qwen" && profile.enableItn !== undefined)
		asrOptions.enable_itn = profile.enableItn;
	const response = await postSpeech(
		provider,
		"chat/completions",
		JSON.stringify({
			model: profile.model,
			messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data } }] }],
			stream,
			...(Object.keys(asrOptions).length ? { asr_options: asrOptions } : {}),
		}),
		signal,
	);
	if (!stream) {
		const value = await jsonResponse(response);
		finished(value);
		const choice = record(Array.isArray(value.choices) ? value.choices[0] : undefined);
		const content = record(choice.message).content;
		if (typeof content !== "string") throw speechError("SPEECH_INVALID_RESPONSE");
		textLimit(content);
		yield { type: "done", text: content };
		return;
	}
	let text = "";
	for await (const value of sseEvents(response, true)) {
		const choice = record(Array.isArray(value.choices) ? value.choices[0] : undefined);
		const delta = record(choice.delta).content;
		const snapshot = record(choice.message).content;
		if (typeof delta === "string") {
			text += delta;
			textLimit(text);
			if (delta) yield { type: "delta", text: delta };
		} else if (typeof snapshot === "string") {
			text = snapshot;
			textLimit(text);
			yield { type: "replace", text };
		}
	}
	yield { type: "done", text };
}

const MIME: Record<SpeechAudioFormat, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	pcm16: "audio/pcm",
	opus: "audio/ogg",
	flac: "audio/flac",
	aac: "audio/aac",
};
function metadata(format: SpeechAudioFormat): SpeechAudioMetadata {
	return {
		format,
		mimeType: MIME[format],
		...(format === "pcm16" ? { sampleRate: 24000, channels: 1 } : {}),
	};
}

function validAudioPrefix(format: SpeechAudioFormat, bytes: Uint8Array): boolean {
	const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
	switch (format) {
		case "wav":
			return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
		case "flac":
			return ascii(0, 4) === "fLaC";
		case "opus":
			return ascii(0, 4) === "OggS";
		case "mp3":
			return (
				ascii(0, 3) === "ID3" ||
				(bytes[0] === 0xff &&
					(bytes[1] & 0xe0) === 0xe0 &&
					(bytes[1] & 0x06) !== 0 &&
					(bytes[1] & 0x18) !== 0x08)
			);
		case "aac":
			return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
		case "pcm16":
			return true; // Every 16-bit pattern is legitimate PCM: never sniff text in it.
	}
}

/** Official Qwen SSE audio is raw PCM16LE/24k/mono; its final WAV URL is NOT the stream format.
 * qwen-tts-api and qwen-audio-tts-http-api intentionally have separate wire profiles.
 */
export async function synthesize(
	provider: SpeechProvider,
	input: SpeechSynthesisInput,
	signal: AbortSignal,
): Promise<SpeechAudioOutput> {
	const profile = provider.tts;
	if (!profile || !input.text.trim() || input.text.length > SPEECH_LIMITS.textCharacters)
		throw speechError("SPEECH_INVALID_INPUT");
	const format = input.format ?? profile.format;
	if (!formats(provider).includes(format)) throw speechError("SPEECH_UNSUPPORTED_FORMAT");
	const voice = input.voice ?? profile.voice;
	if (profile.protocol === "openai-speech") {
		const response = await postSpeech(
			provider,
			"audio/speech",
			JSON.stringify({
				model: profile.model,
				input: input.text,
				voice,
				response_format: format === "pcm16" ? "pcm" : format,
				stream_format: "audio",
				...(input.instructions ? { instructions: input.instructions } : {}),
			}),
			signal,
		);
		const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
		if (
			contentType &&
			contentType !== "application/octet-stream" &&
			contentType !== MIME[format] &&
			!(format === "wav" && contentType === "audio/x-wav")
		) {
			response.close();
			throw speechError("SPEECH_INVALID_AUDIO");
		}
		async function* binary(): AsyncIterable<Uint8Array> {
			let total = 0;
			const needed = format === "wav" ? 12 : format === "mp3" ? 3 : format === "aac" ? 2 : 4;
			const prefix = new Uint8Array(needed);
			let prefixSize = 0;
			let verified = format === "pcm16";
			for await (const chunk of response.bytes()) {
				total += chunk.length;
				if (verified) {
					yield chunk;
					continue;
				}
				const take = Math.min(needed - prefixSize, chunk.length);
				prefix.set(chunk.subarray(0, take), prefixSize);
				prefixSize += take;
				if (prefixSize < needed) continue;
				if (!validAudioPrefix(format, prefix)) throw speechError("SPEECH_INVALID_AUDIO");
				verified = true;
				yield prefix;
				if (take < chunk.length) yield chunk.subarray(take);
			}
			if (!total) throw speechError("SPEECH_NO_AUDIO");
			if (!verified || (format === "pcm16" && total % 2)) throw speechError("SPEECH_INVALID_AUDIO");
		}
		return { metadata: metadata(format), audio: binary() };
	}
	let path: string;
	let body: Record<string, unknown>;
	const dashscope = profile.protocol === "dashscope-tts";
	if (dashscope) {
		if (profile.variant === "qwen-tts") {
			if (input.instructions) throw speechError("SPEECH_UNSUPPORTED_INSTRUCTIONS");
			path = "services/aigc/multimodal-generation/generation";
			body = { model: profile.model, input: { text: input.text, voice } };
		} else if (profile.variant === "qwen-audio-tts") {
			path = "services/audio/tts/SpeechSynthesizer";
			body = {
				model: profile.model,
				input: {
					text: input.text,
					voice,
					format: format === "pcm16" ? "pcm" : format,
					sample_rate: 24000,
					...(input.instructions ? { instruction: input.instructions } : {}),
				},
			};
		} else throw speechError("SPEECH_INVALID_INPUT");
	} else {
		path = "chat/completions";
		body = {
			model: profile.model,
			messages: [
				...(input.instructions ? [{ role: "user", content: input.instructions }] : []),
				{ role: "assistant", content: input.text },
			],
			audio: { voice, format },
			stream: profile.streaming === true,
		};
	}
	const response = await postSpeech(provider, path, JSON.stringify(body), signal, dashscope);
	const streaming = dashscope || profile.streaming === true;
	async function* audio(): AsyncIterable<Uint8Array> {
		let total = 0;
		try {
			const events = streaming ? sseEvents(response, true) : [await jsonResponse(response)];
			for await (const value of events) {
				finished(value);
				const choice = record(Array.isArray(value.choices) ? value.choices[0] : undefined);
				const payload = dashscope
					? record(record(value.output).audio)
					: record(record(streaming ? choice.delta : choice.message).audio);
				if (typeof payload.data !== "string" || !payload.data) continue;
				const bytes = decodeAudio(payload.data);
				total += bytes.length;
				if (total > SPEECH_LIMITS.outputBytes) throw speechError("SPEECH_OUTPUT_LIMIT");
				if (bytes.length) yield bytes;
			}
			if (!total) throw speechError("SPEECH_NO_AUDIO");
			if (format === "pcm16" && total % 2) throw speechError("SPEECH_INVALID_AUDIO");
		} finally {
			response.close();
		}
	}
	return { metadata: metadata(format), audio: audio() };
}
