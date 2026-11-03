import { describe, expect, test } from "bun:test";
import { type ProviderNativeMedia, providerNativeMediaSchema } from "@server/lib/plugins/protocol";
import type {
	ProviderChatParams,
	ProviderDescriptor,
	ProviderModelDescriptor,
	ProviderOperation,
} from "@server/services/plugin-provider-rpc";
import { mediaRefToContentBlock, type NativeMediaInput } from "@shared/media-attachments";
import type { RecordingFrame, RecordingRequest, RequestRecording } from "@shared/request-recording";
import { saveUploadedMedia } from "../../media-uploads";
import type { ChatParams, DbMessage } from "../provider";
import { RemoteProviderAdapter, type RemoteProviderRpcClient } from "../remote-provider-adapter";
import { ApiRequestDumpCollector } from "../request-dump";

const audioBytes = Buffer.from("RIFF\u0004\u0000\u0000\u0000WAVE");
const videoBytes = Buffer.alloc(16);
videoBytes.writeUInt32BE(16, 0);
videoBytes.write("ftypisom", 4);
const audio: NativeMediaInput = {
	type: "audio",
	mediaType: "audio/wav",
	filename: "speech.wav",
	base64: audioBytes.toString("base64"),
};
const video: NativeMediaInput = {
	type: "video",
	mediaType: "video/mp4",
	filename: "clip.mp4",
	base64: videoBytes.toString("base64"),
};

const dbDefaults = {
	id: "media-message",
	contentText: null,
	parentToolUseId: null,
	messageUuid: null,
};

function canonical(media: NativeMediaInput): ProviderNativeMedia {
	const block: ProviderNativeMedia = {
		type: media.type,
		mediaType: media.mediaType,
		dataBase64: media.base64,
	};
	if (media.filename) block.filename = media.filename;
	return block;
}

function harness(
	options: {
		provider?: { inputAudio?: boolean; inputVideo?: boolean };
		model?: { inputAudio?: boolean; inputVideo?: boolean };
		dumpBody?: string;
		dumpTruncated?: boolean;
	} = {},
) {
	const calls: ProviderChatParams[] = [];
	const rpc: RemoteProviderRpcClient = {
		chat: async (params) => {
			calls.push(params);
			return {
				operationId: "media-op",
				cancel: async () => ({ operationId: "media-op", state: "cancelling" }),
				events: async function* () {
					if (options.dumpBody !== undefined) {
						const split = Math.floor(options.dumpBody.length / 2);
						yield {
							type: "dump.request",
							transport: "http",
							url: "https://plugin.example.test/chat",
							bodyChunk: options.dumpBody.slice(0, split),
						};
						yield {
							type: "dump.request",
							bodyChunk: options.dumpBody.slice(split),
							...(options.dumpTruncated ? { truncated: true } : {}),
						};
					}
					yield { type: "done", status: "completed", stopReason: "end_turn" };
				},
			} as ProviderOperation;
		},
		generate: async () => {
			throw new Error("Unexpected generate");
		},
	};
	const model: ProviderModelDescriptor = {
		id: "native",
		displayName: "Native",
		capabilities: {
			chat: true,
			generate: true,
			streaming: true,
			tools: true,
			sessionMode: "stateless",
			...options.model,
		},
	};
	const descriptor: ProviderDescriptor = {
		pluginId: "com.example.native",
		providerTypeId: "com.example.native/main",
		localId: "main",
		displayName: "Native",
		configSchema: {},
		capabilities: {
			validateConfig: true,
			listModels: true,
			chat: true,
			generate: true,
			...options.provider,
		},
		limits: {
			maxConcurrentChat: 1,
			maxConcurrentGenerate: 1,
			maxConfigBytes: 4096,
			maxModelPageSize: 100,
		},
	};
	const adapter = new RemoteProviderAdapter({
		rpc,
		providerTypeId: descriptor.providerTypeId,
		providerInstanceId: "native-instance",
		providerPrefix: "plugin",
		config: {},
		modelCatalog: [model],
		descriptor,
	});
	return { adapter, calls };
}

function params(overrides: Partial<ChatParams> = {}): ChatParams {
	return {
		conversationId: "native-owner",
		content: "Describe this",
		model: "plugin:native",
		cwd: "/unused",
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
		...overrides,
	};
}

async function drain(stream: AsyncGenerator<unknown>): Promise<void> {
	for await (const _event of stream) {
		/* consume the finite fake operation */
	}
}

function recordedCollector() {
	const frames: RecordingFrame[] = [];
	const requests: RecordingRequest[] = [];
	const recording: RequestRecording = {
		requestId: "native-dump-test",
		request: (request) => requests.push(request),
		responseChunk: () => {},
		responseMeta: () => {},
		frame: (frame) => frames.push(frame),
		pin: () => {},
		finish: () => {},
	};
	return {
		collector: new ApiRequestDumpCollector(recording),
		frames,
		requests,
		body: () =>
			frames
				.filter((frame) => frame.direction === "request" && frame.type === "plugin.reported_body")
				.map((frame) => frame.text ?? "")
				.join(""),
	};
}

const supported = {
	provider: { inputAudio: true, inputVideo: true },
	model: { inputAudio: true, inputVideo: true },
};

describe("Remote provider native media contract", () => {
	test("capability queries require both negotiated provider and selected model support without RPC", () => {
		for (const options of [
			{},
			{ provider: supported.provider },
			{ model: supported.model },
			{ provider: supported.provider, model: { inputAudio: false, inputVideo: false } },
		]) {
			const { adapter, calls } = harness(options);
			expect(adapter.supportsNativeMediaInput(audio, "plugin:native")).toBe(false);
			expect(adapter.supportsNativeMediaInput(video, "plugin:native")).toBe(false);
			expect(calls).toEqual([]);
		}
		const { adapter, calls } = harness(supported);
		expect(adapter.supportsNativeMediaInput(audio, "plugin:native")).toBe(true);
		expect(adapter.supportsNativeMediaInput(video, "plugin:native")).toBe(true);
		expect(adapter.supportsNativeMediaInput(audio, "plugin:unknown")).toBe(false);
		expect(calls).toEqual([]);
	});

	test("current media crosses RPC as native original bytes with no transcript or path", async () => {
		const { adapter, calls } = harness(supported);
		await drain(adapter.chat(params({ media: [audio, video] })));
		expect(calls).toHaveLength(1);
		expect(calls[0].request.current.media).toEqual([canonical(audio), canonical(video)]);
		expect(calls[0].request.current.images).toBeUndefined();
	});

	for (const location of ["current", "history", "tool"] as const) {
		test(`legacy plugin rejects ${location} media despite positive model metadata, with zero RPC calls`, async () => {
			const { adapter, calls } = harness({ model: supported.model });
			const input = params();
			if (location === "current") input.media = [audio];
			if (location === "history") input.history = [{ role: "user", content: [canonical(video)] }];
			if (location === "tool")
				input.toolResults = [
					{ type: "tool_result", toolUseId: "read-1", content: [canonical(audio)] },
				];
			await expect(drain(adapter.chat(input))).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
			expect(calls).toHaveLength(0);
		});
	}

	test("provider declaration alone cannot override omitted model support", async () => {
		const { adapter, calls } = harness({ provider: supported.provider });
		await expect(drain(adapter.chat(params({ media: [audio] })))).rejects.toMatchObject({
			code: "UNSUPPORTED_MEDIA",
		});
		expect(calls).toHaveLength(0);
	});

	test("explicit model false cannot inherit provider media support", async () => {
		const { adapter, calls } = harness({
			provider: supported.provider,
			model: { inputAudio: true, inputVideo: false },
		});
		await expect(drain(adapter.chat(params({ media: [video] })))).rejects.toMatchObject({
			code: "UNSUPPORTED_MEDIA",
		});
		expect(calls).toHaveLength(0);
	});

	test("canonical rows retain tool-result and user audio/video blocks", async () => {
		const { adapter, calls } = harness(supported);
		const owner = "remote-canonical";
		const refs = await Promise.all([
			saveUploadedMedia(owner, new File([audioBytes], "speech.wav", { type: "audio/wav" })),
			saveUploadedMedia(owner, new File([videoBytes], "clip.mp4", { type: "video/mp4" })),
		]);
		const media = refs.map((ref) => mediaRefToContentBlock(ref));
		const built = await adapter.buildHistory(
			[
				{
					...dbDefaults,
					id: "tool",
					role: "assistant",
					contentJson: [],
					toolCalls: [
						{
							toolUseId: "read-1",
							toolName: "Read",
							inputJson: {},
							status: "success",
							outputJson: { _text: "Native media", _media: media },
						},
					],
				},
				{
					...dbDefaults,
					id: "follow",
					role: "user",
					contentText: "Follow up",
					contentJson: [{ type: "text", text: "Follow up" }, ...media],
				},
			],
			"plugin:native",
			owner,
		);
		await drain(adapter.chat(params({ history: built.history })));
		expect(calls[0].request.history.slice(-2)).toEqual([
			{
				role: "tool",
				content: [
					{
						type: "tool_result",
						toolUseId: "read-1",
						name: "Read",
						isError: false,
						content: [{ type: "text", text: "Native media" }, canonical(audio), canonical(video)],
					},
				],
			},
			{
				role: "user",
				content: [{ type: "text", text: "Follow up" }, canonical(audio), canonical(video)],
			},
		]);
	});

	test("legacy plugin refuses canonical tool-result media rather than returning text-only", async () => {
		const { adapter, calls } = harness({ model: supported.model });
		await expect(
			drain(
				adapter.chat(
					params({
						toolResults: [
							{ type: "tool_result", toolUseId: "read-1", content: [canonical(audio)] },
						],
					}),
				),
			),
		).rejects.toThrow(/inputAudio/);
		expect(calls).toHaveLength(0);
	});

	test("buildHistory materializes stored user and tool references to original bytes", async () => {
		const { adapter, calls } = harness(supported);
		const owner = "remote-media-history";
		const audioRef = await saveUploadedMedia(
			owner,
			new File([audioBytes], "speech.wav", { type: "audio/wav" }),
		);
		const videoRef = await saveUploadedMedia(
			owner,
			new File([videoBytes], "clip.mp4", { type: "video/mp4" }),
		);
		const messages: DbMessage[] = [
			{
				...dbDefaults,
				role: "user",
				contentJson: [mediaRefToContentBlock(audioRef), mediaRefToContentBlock(videoRef)],
			},
			{
				...dbDefaults,
				role: "assistant",
				contentJson: [],
				toolCalls: [
					{
						toolUseId: "read-1",
						toolName: "Read",
						inputJson: {},
						outputJson: {
							_text: "Native tool media",
							_media: [mediaRefToContentBlock(audioRef), mediaRefToContentBlock(videoRef)],
						},
						status: "success",
					},
				],
			},
		];
		const built = await adapter.buildHistory(messages, "plugin:native", owner);
		await drain(adapter.chat(params({ history: built.history, content: "", toolResults: [] })));
		expect(calls[0].request.history[0]).toEqual({
			role: "user",
			content: [canonical(audio), canonical(video)],
		});
		expect(calls[0].request.current.toolResults).toEqual([
			{
				type: "tool_result",
				toolUseId: "read-1",
				name: "Read",
				isError: false,
				content: [{ type: "text", text: "Native tool media" }, canonical(audio), canonical(video)],
			},
		]);
		const wire = JSON.stringify(calls[0].request);
		expect(wire).not.toContain(audioRef.mediaId);
		expect(wire).not.toContain("uploadNarratorId");
	});

	test("legacy reference fallback uses the original message owner, not the current narrator", async () => {
		const { adapter, calls } = harness(supported);
		const saved = await saveUploadedMedia(
			"original-media-owner",
			new File([audioBytes], "speech.wav", { type: "audio/wav" }),
		);
		const { uploadNarratorId: _owner, ...legacyRef } = mediaRefToContentBlock(saved);
		const built = await adapter.buildHistory(
			[
				{
					...dbDefaults,
					narratorId: "original-media-owner",
					role: "user",
					contentJson: [legacyRef],
				},
			],
			"plugin:native",
			"different-current-owner",
		);
		await drain(adapter.chat(params({ history: built.history })));
		expect(calls[0].request.history[0].content).toEqual([canonical(audio)]);
	});

	test("buildHistory retains inline native bytes as well as references", async () => {
		const { adapter, calls } = harness(supported);
		const built = await adapter.buildHistory(
			[{ ...dbDefaults, role: "user", contentJson: [audio, canonical(video)] }],
			"plugin:native",
		);
		await drain(adapter.chat(params({ history: built.history })));
		expect(calls[0].request.history[0].content).toEqual([canonical(audio), canonical(video)]);
	});

	test("missing historical assets fail instead of becoming text or being omitted", async () => {
		const { adapter, calls } = harness(supported);
		await expect(
			adapter.buildHistory(
				[
					{
						...dbDefaults,
						role: "user",
						contentJson: [
							{
								type: "audio",
								mediaId: "missing",
								filename: "speech.wav",
								mediaType: "audio/wav",
								size: 12,
								uploadNarratorId: "unknown-owner",
							},
						],
					},
				],
				"plugin:native",
			),
		).rejects.toThrow(/missing/i);
		expect(calls).toHaveLength(0);
	});

	for (const malformed of [
		{ type: "audio", mediaType: "audio/wav", filename: "speech.wav" },
		{ type: "video", mediaType: "audio/wav", dataBase64: audio.base64 },
		{ type: "audio", mediaType: "audio/wav", dataBase64: "not base64" },
		{ type: "input_audio", input_audio: { data: audio.base64, format: "wav" } },
		{ type: "video_url", video_url: { url: "/local/clip.mp4" } },
	]) {
		test(`malformed or unknown media representation is never silently dropped: ${malformed.type}`, async () => {
			const { adapter, calls } = harness(supported);
			await expect(
				drain(
					adapter.chat(
						params({
							history: [{ role: "user", content: [{ type: "text", text: "keep" }, malformed] }],
						}),
					),
				),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
			expect(calls).toHaveLength(0);
		});
	}

	test("malformed tool media also fails before RPC", async () => {
		const { adapter, calls } = harness(supported);
		await expect(
			drain(
				adapter.chat(
					params({
						toolResults: [
							{
								type: "tool_result",
								toolUseId: "read-1",
								content: [{ type: "audio", mediaType: "audio/wav", path: "/host/file.wav" }],
							},
						],
					}),
				),
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		expect(calls).toHaveLength(0);
	});

	test("plugin diagnostic JSON redacts canonical and upstream media without changing real RPC bytes", async () => {
		const body = {
			keep: "diagnostic schema",
			media: [canonical(audio), canonical(video)],
			upstream: { inline_data: { mime_type: "audio/wav", data: audio.base64 } },
		};
		const { adapter, calls } = harness({ ...supported, dumpBody: JSON.stringify(body) });
		const { collector, frames, requests, body: diagnosticBody } = recordedCollector();
		await drain(adapter.chat(params({ media: [audio, video], requestDump: collector })));
		const serialized = JSON.stringify({ frames, requests });
		expect(serialized).not.toContain(audio.base64);
		expect(serialized).not.toContain(video.base64);
		expect(JSON.parse(diagnosticBody())).toMatchObject({ keep: "diagnostic schema" });
		expect(calls[0].request.current.media).toEqual([canonical(audio), canonical(video)]);
	});

	for (const location of ["current", "history", "tool"] as const) {
		test(`unparseable or truncated native ${location} request dumps never retain a binary prefix`, async () => {
			const prefix = audio.base64.slice(0, 8);
			const { adapter } = harness({
				...supported,
				dumpBody: `{"native_payload":"${prefix}`,
				dumpTruncated: true,
			});
			const { collector, frames, requests, body: diagnosticBody } = recordedCollector();
			const input = params({ requestDump: collector });
			if (location === "current") input.media = [audio];
			if (location === "history") input.history = [{ role: "user", content: [canonical(audio)] }];
			if (location === "tool")
				input.toolResults = [
					{ type: "tool_result", toolUseId: "read-1", content: [canonical(audio)] },
				];
			await drain(adapter.chat(input));
			expect(JSON.stringify({ frames, requests })).not.toContain(prefix);
			expect(diagnosticBody()).toMatch(/native media request body omitted/i);
		});
	}

	test("over-budget native diagnostic frames never emit base64 prefixes and leave RPC unchanged", async () => {
		const large = Buffer.alloc(4 * 1024 * 1024, 0xa7).toString("base64");
		const prefix = large.slice(0, 96);
		const input = { ...audio, base64: large };
		const { adapter, calls } = harness({
			...supported,
			dumpBody: JSON.stringify({ media: [canonical(input)] }),
		});
		const { collector, frames, requests, body } = recordedCollector();
		await drain(adapter.chat(params({ media: [input], requestDump: collector })));
		expect(JSON.stringify({ frames, requests })).not.toContain(prefix);
		expect(body()).toContain("native media request body omitted");
		expect(calls[0].request.current.media?.[0].dataBase64).toBe(large);
	});

	test("canonical native schema rejects unknown keys, data URLs and modality mismatch", () => {
		expect(providerNativeMediaSchema.safeParse(canonical(audio)).success).toBe(true);
		expect(
			providerNativeMediaSchema.safeParse({ ...canonical(audio), path: "/host/audio.wav" }).success,
		).toBe(false);
		expect(
			providerNativeMediaSchema.safeParse({
				...canonical(audio),
				dataBase64: `data:audio/wav;base64,${audio.base64}`,
			}).success,
		).toBe(false);
		expect(
			providerNativeMediaSchema.safeParse({ ...canonical(audio), type: "video" }).success,
		).toBe(false);
	});
});
