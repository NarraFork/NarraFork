/** Independent speech protocols; model audio modalities do not imply endpoint support. */
export type SpeechAudioFormat = "mp3" | "wav" | "pcm16" | "opus" | "flac" | "aac";

export interface SpeechAsrProfile {
	protocol: "openai-transcription" | "chat-completions-asr";
	model: string;
	/** Explicit opt-in to output text deltas; this never means live audio input. */
	streaming?: boolean;
	/** MiMo requires WAV/MP3 and caps the encoded payload, unlike generic chat audio. */
	variant?: "generic" | "mimo" | "qwen";
	enableItn?: boolean;
}

export interface SpeechTtsProfile {
	protocol: "openai-speech" | "chat-completions-tts" | "dashscope-tts";
	model: string;
	voice: string;
	format: SpeechAudioFormat;
	/** Whether the configured chat model really produces incremental audio. */
	streaming?: boolean;
	/** DashScope wire profiles have distinct endpoints and supported parameters. */
	variant?: "qwen-tts" | "qwen-audio-tts";
}

export interface SpeechProvider {
	id: string;
	name: string;
	enabled: boolean;
	/** API root including version, e.g. https://host/v1 or https://host/api/v1. */
	baseUrl: string;
	apiKey?: string;
	extraHeaders?: Record<string, string>;
	proxy?: { mode: "default" | "direct" | "system" | "custom"; url?: string };
	asr?: SpeechAsrProfile;
	tts?: SpeechTtsProfile;
}

export interface SpeechSettings {
	enabled: boolean;
	providers: SpeechProvider[];
	defaultAsrProviderId?: string;
	defaultTtsProviderId?: string;
}

export interface SpeechCapabilities {
	id: string;
	name: string;
	asr?: { textStreaming: boolean; realtimeInput: false };
	tts?: { audioStreaming: boolean; formats: SpeechAudioFormat[]; urlDownload: false };
}

export interface SpeechTranscriptionInput {
	audio: Uint8Array;
	mimeType: string;
	filename?: string;
	language?: string;
	stream?: boolean;
}

export type SpeechTranscriptEvent =
	| { type: "delta"; text: string }
	| { type: "replace"; text: string }
	| { type: "done"; text: string };

export interface SpeechSynthesisInput {
	text: string;
	voice?: string;
	instructions?: string;
	format?: SpeechAudioFormat;
}

export interface SpeechAudioMetadata {
	mimeType: string;
	format: SpeechAudioFormat;
	sampleRate?: number;
	channels?: number;
}

export interface SpeechAudioOutput {
	metadata: SpeechAudioMetadata;
	audio: AsyncIterable<Uint8Array>;
}

export const SPEECH_LIMITS = {
	inputBytes: 10 * 1024 * 1024,
	textCharacters: 10_000,
	outputBytes: 32 * 1024 * 1024,
	frameBytes: 16 * 1024 * 1024,
	idleTimeoutMs: 30_000,
	totalTimeoutMs: 120_000,
} as const;
