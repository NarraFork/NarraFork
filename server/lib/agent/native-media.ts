import { outputToText } from "@shared/agent-protocol/tool-output";
import {
	isMediaContentBlock,
	MAX_MEDIA_FILE_SIZE,
	type MediaRef,
	mediaModality,
	mediaRefToContentBlock,
	type NativeMediaFallbackWarning,
	type NativeMediaInput,
} from "@shared/media-attachments";
import { getMediaPath } from "../media-uploads";
import { getEffectiveModelProfile } from "../model-catalog";
import type { DbMessage, ProviderAdapter } from "./provider";

/** Only traverse model-input containers, never tool schemas or generated output metadata. */
export function visitNativeMedia(
	values: unknown,
	visit: (value: Record<string, unknown>, modality: "audio" | "video") => void,
): void {
	const walk = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		const item = value as Record<string, unknown>;
		const data = (item.inlineData ??
			item.inline_data ??
			item.fileData ??
			item.file_data ??
			item.source) as Record<string, unknown> | undefined;
		const mime = String(
			item.mediaType ??
				item.mime_type ??
				data?.mimeType ??
				data?.mime_type ??
				data?.media_type ??
				"",
		);
		const modality =
			item.type === "audio" || item.type === "input_audio" || mime.startsWith("audio/")
				? "audio"
				: item.type === "video" ||
						item.type === "video_url" ||
						item.type === "input_video" ||
						mime.startsWith("video/")
					? "video"
					: undefined;
		if (modality) visit(item, modality);
		for (const key of [
			"content",
			"parts",
			"messages",
			"input",
			"contents",
			"result",
			"media",
			"_media",
			"_nativeMedia",
			"history",
			"toolResults",
			"response",
			"functionResponse",
			"mediaParts",
		])
			walk(item[key]);
	};
	walk(values);
}

/** Diagnostic snapshots retain MIME/schema information, never native media bytes. */
export function redactNativeMediaForDump<T>(value: T): T {
	const redact = (part: unknown): unknown => {
		if (!part || typeof part !== "object") return part;
		if (Array.isArray(part)) return part.map(redact);
		const item = part as Record<string, unknown>;
		const result = Object.fromEntries(Object.entries(item).map(([key, val]) => [key, redact(val)]));
		const omitted = (data: string) => `[native media omitted: ${data.length} base64 characters]`;
		const mime = String(item.mediaType ?? item.mimeType ?? item.mime_type ?? item.media_type ?? "");
		if (["audio", "video"].includes(String(item.type)) || /^(audio|video)\//.test(mime)) {
			for (const key of ["data", "base64", "dataBase64"])
				if (typeof item[key] === "string") result[key] = omitted(item[key]);
		}
		if (item.type === "input_audio" && item.input_audio && typeof item.input_audio === "object") {
			const audio = item.input_audio as Record<string, unknown>;
			if (typeof audio.data === "string")
				result.input_audio = { ...audio, data: omitted(audio.data) };
		}
		if (
			item.type === "input_video" &&
			typeof item.video_url === "string" &&
			item.video_url.startsWith("data:")
		)
			result.video_url = omitted(item.video_url);
		if (item.type === "video_url" && item.video_url && typeof item.video_url === "object") {
			const video = item.video_url as Record<string, unknown>;
			if (typeof video.url === "string" && video.url.startsWith("data:"))
				result.video_url = { ...video, url: omitted(video.url) };
		}
		return result;
	};
	return redact(value) as T;
}

export function rejectNativeMedia(protocol: string, values: unknown): void {
	visitNativeMedia(values, (_item, modality) => {
		throw new Error(
			`${protocol} does not support native ${modality} input. Select a provider/API with a documented native media input schema (for example Gemini).`,
		);
	});
}

/** Omit only attachments explicitly carried by this current input, never older turns or replay. */
export function projectCurrentNativeMediaForModel<T extends DbMessage>(
	messages: T[],
	currentMedia: readonly MediaRef[] | undefined,
	fallbackNarratorId?: string,
): T[] {
	if (!currentMedia?.length) return messages;
	let tailIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.parentToolUseId || ["sys", "disp", "system"].includes(message.role)) continue;
		if (message.role === "user") tailIndex = index;
		break;
	}
	if (tailIndex < 0) return messages;
	const message = messages[tailIndex];
	if (!Array.isArray(message.contentJson)) return messages;
	const key = (ref: MediaRef, rowOwner?: string | null): string | undefined => {
		const owner = ref.uploadNarratorId || rowOwner || fallbackNarratorId;
		return owner ? JSON.stringify([owner, ref.mediaId]) : undefined;
	};
	const current = new Set(
		currentMedia.map((ref) => key(ref)).filter((value): value is string => !!value),
	);
	const contentJson = message.contentJson.filter((block: unknown) => {
		if (!isMediaContentBlock(block)) return true;
		const identity = key(block, message.narratorId);
		return !identity || !current.has(identity);
	});
	if (contentJson.length === message.contentJson.length) return messages;
	return messages.map((row, index) => (index === tailIndex ? { ...row, contentJson } : row));
}

export function hasStoredUserMedia(message: DbMessage): boolean {
	return (
		message.role === "user" &&
		Array.isArray(message.contentJson) &&
		message.contentJson.some(
			(block: unknown) =>
				!!block &&
				typeof block === "object" &&
				(["audio", "video"].includes(String((block as { type?: unknown }).type)) ||
					(block as { nativeMediaFallback?: unknown }).nativeMediaFallback === true),
		)
	);
}

export function storedMessageMedia(message: DbMessage): unknown[] {
	if (message.parentToolUseId || !["user", "assistant", "sys"].includes(message.role)) return [];
	return [
		...(message.role === "user" && Array.isArray(message.contentJson) ? message.contentJson : []),
		...(message.toolCalls ?? [])
			.filter((call) => call.status === "success" || call.status === "fail")
			.flatMap((call) => toolMediaBlocks(call.outputJson)),
	];
}

export function toolMediaBlocks(output: unknown): unknown[] {
	if (!output || typeof output !== "object") return [];
	const media = (output as { _media?: unknown })._media;
	if (media === undefined) return [];
	if (!Array.isArray(media) || media.some((block) => !isMediaContentBlock(block)))
		throw new Error("Stored tool media references are invalid.");
	return media;
}

export async function resolveNativeMediaBlocks(
	blocks: unknown[],
	fallbackNarratorId?: string,
): Promise<NativeMediaInput[]> {
	const media: NativeMediaInput[] = [];
	for (const block of blocks) {
		if (
			!block ||
			typeof block !== "object" ||
			!["audio", "video"].includes(String((block as { type?: unknown }).type))
		)
			continue;
		if (!isMediaContentBlock(block)) {
			const inline = block as NativeMediaInput & { mediaId?: unknown };
			if (inline.mediaId !== undefined)
				throw new Error("Stored native media reference is invalid or incomplete.");
			assertNativeMediaPayload(inline);
			media.push({
				type: inline.type,
				mediaType: inline.mediaType,
				base64: inline.base64,
				...(inline.filename ? { filename: inline.filename } : {}),
			});
			continue;
		}
		const { mediaToBase64 } = await import("../media-uploads");
		media.push(await mediaToBase64(block, fallbackNarratorId));
	}
	return media;
}

export function assertNativeMediaPayload(media: NativeMediaInput): void {
	if (
		!media ||
		!["audio", "video"].includes(media.type) ||
		!media.mediaType?.startsWith(`${media.type}/`)
	)
		throw new Error("Native media type and MIME type do not match.");
	const data = media.base64;
	if (
		typeof data !== "string" ||
		!data.length ||
		data.length % 4 !== 0 ||
		/[^A-Za-z0-9+/=]/.test(data) ||
		/=/.test(data.slice(0, -2)) ||
		/=[^=]/.test(data) ||
		(data.endsWith("==") && !/[AQgw]==$/.test(data)) ||
		(!data.endsWith("==") && data.endsWith("=") && !/[AEIMQUYcgkosw048]=$/.test(data))
	)
		throw new Error(`Native ${media.type} input is missing valid base64 media bytes.`);
	const size = (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
	if (size > MAX_MEDIA_FILE_SIZE)
		throw new Error("Native media input exceeds the 100MiB attachment limit.");
}

const GEMINI_AUDIO_MIMES = new Set([
	"audio/wav",
	"audio/mp3",
	"audio/mpeg",
	"audio/aiff",
	"audio/aac",
	"audio/ogg",
	"audio/flac",
	"audio/m4a",
	"audio/l16",
	"audio/opus",
	"audio/alaw",
	"audio/mulaw",
	"audio/webm",
]);
const GEMINI_VIDEO_MIMES = new Set([
	"video/mp4",
	"video/mpeg",
	"video/mpg",
	"video/mov",
	"video/avi",
	"video/x-flv",
	"video/webm",
	"video/wmv",
	"video/3gpp",
]);

// Chat-compatible providers such as Ark accept base64 video_url parts for MP4/MOV.
// Keep the wire-format MIME allowlist separate from each model's declared modalities.
const CHAT_VIDEO_MIMES = new Set(["video/mp4", "video/quicktime"]);

export type NativeMediaDescriptor = Pick<NativeMediaInput, "type" | "mediaType" | "filename">;

export function modelSupportsNativeMediaInput(
	media: NativeMediaDescriptor,
	model: string,
): boolean {
	if (mediaModality(media.mediaType) !== media.type) return false;
	const inputs = getEffectiveModelProfile(model).inputModalities;
	return !Array.isArray(inputs) || inputs.includes(media.type);
}

export function supportsNativeMediaProtocolInput(
	protocol: "generate" | "interactions" | "completions" | "responses" | "unsupported",
	media: NativeMediaDescriptor,
	model: string,
): boolean {
	if (!modelSupportsNativeMediaInput(media, model) || protocol === "unsupported") return false;
	if (protocol === "responses") return media.type === "video" && media.mediaType === "video/mp4";
	if (protocol === "completions")
		return media.type === "video"
			? CHAT_VIDEO_MIMES.has(media.mediaType)
			: ["audio/wav", "audio/mpeg", "audio/mp3"].includes(media.mediaType);
	const mime =
		media.mediaType === "audio/mp4"
			? "audio/m4a"
			: media.mediaType === "video/quicktime"
				? "video/mov"
				: media.mediaType;
	return (media.type === "audio" ? GEMINI_AUDIO_MIMES : GEMINI_VIDEO_MIMES).has(mime);
}

export function splitNativeMediaReferences(
	refs: readonly MediaRef[] | undefined,
	model: string,
	adapter: Pick<ProviderAdapter, "supportsNativeMediaInput">,
	fallbackNarratorId?: string,
): { nativeRefs: MediaRef[]; fallbackText: string; warnings: NativeMediaFallbackWarning[] } {
	const nativeRefs: MediaRef[] = [];
	const fallbacks: string[] = [];
	const warnings: NativeMediaFallbackWarning[] = [];
	for (const ref of refs ?? []) {
		const block = mediaRefToContentBlock(ref, fallbackNarratorId);
		if (!isMediaContentBlock(block))
			throw new Error("Native media reference is invalid or incomplete.");
		if (
			modelSupportsNativeMediaInput(block, model) &&
			adapter.supportsNativeMediaInput?.(block, model) === true
		) {
			nativeRefs.push(block);
			continue;
		}
		const owner = block.uploadNarratorId;
		const filePath = owner && getMediaPath(owner, block.mediaId);
		if (!owner || !filePath) throw new Error(`Media asset is missing: ${block.mediaId}`);
		fallbacks.push(
			`当前模型不支持读取该模态数据，回退到一般文件。以下仅为文件路径和元数据；当前模型未读取该文件的音视频内容。\n${JSON.stringify({ filePath, filename: block.filename, mediaType: block.mediaType, size: block.size, mediaId: block.mediaId, uploadNarratorId: owner })}`,
		);
		warnings.push({
			model,
			filename: block.filename,
			mediaType: block.mediaType,
			type: block.type,
			mediaId: block.mediaId,
			uploadNarratorId: owner,
			reason: "unsupported-native-media-input",
		});
	}
	return { nativeRefs, fallbackText: fallbacks.join("\n\n"), warnings };
}

export function projectUnsupportedNativeMediaForModel(
	messages: DbMessage[],
	model: string,
	adapter: Pick<ProviderAdapter, "supportsNativeMediaInput">,
	narratorId?: string,
): { messages: DbMessage[]; warnings: NativeMediaFallbackWarning[] } {
	const warnings: NativeMediaFallbackWarning[] = [];
	const projected = messages.map((message) => {
		if (message.parentToolUseId || !["user", "assistant", "sys"].includes(message.role))
			return message;
		let next = message;
		if (message.role === "user" && Array.isArray(message.contentJson)) {
			const fallbackTexts: string[] = [];
			const contentJson = message.contentJson.map((block: unknown) => {
				if (
					!block ||
					typeof block !== "object" ||
					!["audio", "video"].includes(String((block as { type?: unknown }).type))
				)
					return block;
				if (!isMediaContentBlock(block))
					throw new Error("Stored native media reference is invalid or incomplete.");
				const split = splitNativeMediaReferences(
					[block],
					model,
					adapter,
					message.narratorId ?? narratorId,
				);
				if (!split.warnings.length) return block;
				warnings.push(...split.warnings);
				fallbackTexts.push(split.fallbackText);
				return { type: "text", text: split.fallbackText, nativeMediaFallback: true };
			});
			if (fallbackTexts.length) {
				const original =
					message.contentText ||
					message.contentJson
						.filter((block: { type?: string }) => block?.type === "text")
						.map((block: { text?: string }) => block.text ?? "")
						.join("\n");
				next = {
					...message,
					contentJson,
					contentText: [original, ...fallbackTexts].filter(Boolean).join("\n\n"),
				};
			}
		}
		let changed = false;
		const toolCalls = message.toolCalls?.map((call) => {
			if (!["success", "fail"].includes(call.status)) return call;
			const refs = toolMediaBlocks(
				call.outputJson,
			) as import("@shared/media-attachments").MediaContentBlock[];
			if (!refs.length) return call;
			const split = splitNativeMediaReferences(
				refs,
				model,
				adapter,
				message.narratorId ?? narratorId,
			);
			if (!split.warnings.length) return call;
			changed = true;
			warnings.push(...split.warnings);
			return {
				...call,
				outputJson: {
					...(call.outputJson as Record<string, unknown>),
					_text: [outputToText(call.outputJson), split.fallbackText].filter(Boolean).join("\n\n"),
					_media: split.nativeRefs,
				},
			};
		});
		return changed ? { ...next, toolCalls } : next;
	});
	return { messages: projected, warnings };
}

export function geminiMediaMime(media: NativeMediaInput): string {
	assertNativeMediaPayload(media);
	const mime =
		media.mediaType === "audio/mp4"
			? "audio/m4a"
			: media.mediaType === "video/quicktime"
				? "video/mov"
				: media.mediaType;
	if (!(media.type === "audio" ? GEMINI_AUDIO_MIMES : GEMINI_VIDEO_MIMES).has(mime))
		throw new Error(
			`Gemini native ${media.type} input does not support MIME type ${media.mediaType}.`,
		);
	return mime;
}

export function geminiInlineMedia(media: NativeMediaInput): {
	inlineData: { mimeType: string; data: string };
} {
	return { inlineData: { mimeType: geminiMediaMime(media), data: media.base64 } };
}

export function interactionInlineMedia(media: NativeMediaInput): {
	type: "audio" | "video";
	mime_type: string;
	data: string;
} {
	return { type: media.type, mime_type: geminiMediaMime(media), data: media.base64 };
}

export function chatAudioMedia(media: NativeMediaInput): {
	type: "input_audio";
	input_audio: { data: string; format: "wav" | "mp3" };
} {
	assertNativeMediaPayload(media);
	if (media.type !== "audio")
		throw new Error("Chat Completions input_audio requires audio; video uses video_url.");
	const format =
		media.mediaType === "audio/wav"
			? "wav"
			: ["audio/mpeg", "audio/mp3"].includes(media.mediaType)
				? "mp3"
				: undefined;
	if (!format)
		throw new Error(
			`OpenAI Chat Completions input_audio only supports WAV/MP3, not ${media.mediaType}.`,
		);
	return { type: "input_audio", input_audio: { data: media.base64, format } };
}

/** Ark-style Chat Completions video input; send bytes, never a server-local path. */
export function chatVideoMedia(media: NativeMediaInput): {
	type: "video_url";
	video_url: { url: string };
} {
	assertNativeMediaPayload(media);
	if (media.type !== "video" || !CHAT_VIDEO_MIMES.has(media.mediaType))
		throw new Error(
			`Chat Completions video_url only supports MP4/MOV video, not ${media.mediaType}.`,
		);
	return {
		type: "video_url",
		video_url: { url: `data:${media.mediaType};base64,${media.base64}` },
	};
}

export function chatNativeMedia(media: NativeMediaInput) {
	return media.type === "video" ? chatVideoMedia(media) : chatAudioMedia(media);
}

/** Ark Responses input_video uses a string data URL, not Chat's video_url object. */
export function responsesVideoMedia(media: NativeMediaInput): {
	type: "input_video";
	video_url: string;
} {
	assertNativeMediaPayload(media);
	if (media.type !== "video" || media.mediaType !== "video/mp4")
		throw new Error(`Ark Responses input_video only supports MP4 video, not ${media.mediaType}.`);
	return { type: "input_video", video_url: `data:${media.mediaType};base64,${media.base64}` };
}
