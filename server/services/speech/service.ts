import { AppError } from "@server/lib/errors";
import {
	SPEECH_LIMITS,
	type SpeechAudioOutput,
	type SpeechCapabilities,
	type SpeechProvider,
	type SpeechSettings,
	type SpeechSynthesisInput,
	type SpeechTranscriptEvent,
	type SpeechTranscriptionInput,
} from "@shared/speech";
import * as adapters from "./adapters";

export interface SpeechAdapter {
	getCapabilities(provider: SpeechProvider): SpeechCapabilities;
	transcribe(
		provider: SpeechProvider,
		input: SpeechTranscriptionInput,
		signal: AbortSignal,
	): AsyncIterable<SpeechTranscriptEvent>;
	synthesize(
		provider: SpeechProvider,
		input: SpeechSynthesisInput,
		signal: AbortSignal,
	): Promise<SpeechAudioOutput>;
}

export interface SpeechOperation {
	readonly signal: AbortSignal;
	transcribe(input: SpeechTranscriptionInput): AsyncIterable<SpeechTranscriptEvent>;
	synthesize(input: SpeechSynthesisInput): Promise<SpeechAudioOutput>;
	/** Idempotent: releases admission and aborts unfinished upstream work. */
	close(): void;
}

function failure(code: string, message: string, status = 400): AppError {
	return new AppError(message, status, code);
}

/** Owns admission from upload through consumption; independent of Agent sessions. */
export class SpeechService {
	private readonly users = new Set<string>();

	constructor(
		private readonly config: () => SpeechSettings,
		private readonly adapter: SpeechAdapter = adapters,
		private readonly options: {
			timeoutMs?: number;
			onSlow?: (entry: { providerId: string; operation: string; elapsedMs: number }) => void;
		} = {},
	) {}

	getCapabilities() {
		const config = this.config();
		return {
			enabled: config.enabled,
			defaultAsrProviderId: config.enabled ? config.defaultAsrProviderId : undefined,
			defaultTtsProviderId: config.enabled ? config.defaultTtsProviderId : undefined,
			providers: config.enabled
				? config.providers.filter((p) => p.enabled).map((p) => this.adapter.getCapabilities(p))
				: [],
		};
	}

	begin(
		userId: string,
		operation: "asr" | "tts",
		providerId?: string,
		externalSignal?: AbortSignal,
	): SpeechOperation {
		const config = this.config();
		if (!config.enabled) throw failure("SPEECH_DISABLED", "Speech is disabled.", 503);
		if (externalSignal?.aborted)
			throw failure("SPEECH_CANCELLED", "Speech request cancelled.", 499);
		const id =
			providerId ??
			(operation === "asr" ? config.defaultAsrProviderId : config.defaultTtsProviderId);
		const selected = config.providers.find((p) => p.id === id && p.enabled && p[operation]);
		if (!selected)
			throw failure("SPEECH_PROVIDER_UNAVAILABLE", "No enabled speech provider selected.");
		if (!userId || this.users.has(userId) || this.users.size >= 2) {
			throw failure("SPEECH_BUSY", "Speech capacity is busy. Try again later.", 429);
		}
		// Pin the connection and its credentials for the lifetime of this operation.
		const provider = structuredClone(selected);
		this.users.add(userId);
		const controller = new AbortController();
		const signal = controller.signal;
		const started = Date.now();
		let closed = false;
		let used = false;
		const release = () => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			externalSignal?.removeEventListener("abort", close);
			this.users.delete(userId);
			const elapsedMs = Date.now() - started;
			if (elapsedMs >= 5_000) {
				this.options.onSlow?.({ providerId: provider.id, operation, elapsedMs });
			}
		};
		const close = () => {
			if (closed) return;
			controller.abort(failure("SPEECH_CANCELLED", "Speech request cancelled.", 499));
			release();
		};
		const timer = setTimeout(
			() => {
				controller.abort(failure("SPEECH_TIMEOUT", "Speech request timed out.", 504));
				close();
			},
			Math.min(
				this.options.timeoutMs ?? SPEECH_LIMITS.totalTimeoutMs,
				SPEECH_LIMITS.totalTimeoutMs,
			),
		);
		externalSignal?.addEventListener("abort", close, { once: true });
		const claim = (expected: "asr" | "tts") => {
			if (signal.aborted) throw signal.reason;
			if (used || closed)
				throw failure("SPEECH_OPERATION_INVALID", "Speech operation is not reusable.");
			if (operation !== expected) {
				close();
				throw failure("SPEECH_OPERATION_INVALID", "Wrong speech operation type.");
			}
			used = true;
		};
		const adapter = this.adapter;
		return {
			signal,
			close,
			async *transcribe(input) {
				claim("asr");
				try {
					if (!input.audio.byteLength || input.audio.byteLength > SPEECH_LIMITS.inputBytes) {
						throw failure("SPEECH_INPUT_LIMIT", "Audio input is empty or too large.", 413);
					}
					if (input.stream && !adapter.getCapabilities(provider).asr?.textStreaming) {
						throw failure("SPEECH_UNSUPPORTED", "Streaming transcription is not supported.");
					}
					let completed = false;
					for await (const event of adapter.transcribe(provider, input, signal)) {
						if (signal.aborted) throw signal.reason;
						if (completed)
							throw failure(
								"SPEECH_INVALID_RESPONSE",
								"Unexpected transcription after completion.",
								502,
							);
						if (event.text.length > SPEECH_LIMITS.textCharacters) {
							throw failure("SPEECH_OUTPUT_LIMIT", "Transcription is too large.", 502);
						}
						completed = event.type === "done";
						yield event;
					}
					if (!completed)
						throw failure("SPEECH_INVALID_RESPONSE", "Transcription did not complete.", 502);
				} finally {
					release();
				}
			},
			async synthesize(input) {
				claim("tts");
				try {
					if (!input.text.trim() || input.text.length > SPEECH_LIMITS.textCharacters) {
						throw failure("SPEECH_INPUT_LIMIT", "Synthesis text is empty or too large.", 413);
					}
					if (input.instructions && input.instructions.length > SPEECH_LIMITS.textCharacters) {
						throw failure("SPEECH_INPUT_LIMIT", "Synthesis instructions are too large.", 413);
					}
					const output = await adapter.synthesize(provider, input, signal);
					if (signal.aborted) throw signal.reason;
					return {
						metadata: output.metadata,
						audio: (async function* () {
							let size = 0;
							try {
								for await (const chunk of output.audio) {
									if (signal.aborted) throw signal.reason;
									size += chunk.byteLength;
									if (size > SPEECH_LIMITS.outputBytes)
										throw failure("SPEECH_OUTPUT_LIMIT", "Synthesized audio is too large.", 502);
									yield chunk;
								}
								if (!size)
									throw failure("SPEECH_INVALID_RESPONSE", "No synthesized audio returned.", 502);
							} finally {
								release();
							}
						})(),
					};
				} catch (error) {
					close();
					throw error;
				}
			},
		};
	}
}
