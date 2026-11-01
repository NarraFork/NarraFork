import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { MediaContentBlock, NativeMediaInput } from "@shared/media-attachments";
import { GEMINI_FILES_METADATA_MAX_BYTES, GeminiMediaFiles } from "../gemini-media-files";
import {
	assertNativeMediaPayload,
	chatAudioMedia,
	projectCurrentNativeMediaForModel,
	projectUnsupportedNativeMediaForModel,
	splitNativeMediaReferences,
} from "../native-media";
import type { ChatParams, DbMessage, ProviderAdapter } from "../provider";
import { assertModelInputModalities } from "../provider-model-metadata";
import { ApiRequestDumpCollector } from "../request-dump";

let createProviders: () => Array<{ kind: string; provider: ProviderAdapter }>;
let unsupportedProviders: () => ProviderAdapter[];
let setFetch: typeof import("../../net/outbound-fetch").setOutboundFetchOverrideForTest;
let saveMedia: typeof import("../../media-uploads").saveUploadedMedia;
const wav = Buffer.from(
	"524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000",
	"hex",
);
const audio: NativeMediaInput = {
	type: "audio",
	mediaType: "audio/wav",
	base64: wav.toString("base64"),
	filename: "tone.wav",
};
const video: NativeMediaInput = {
	type: "video",
	mediaType: "video/mp4",
	base64: Buffer.from("000000146674797069736f6d0000000069736f6d", "hex").toString("base64"),
	filename: "clip.mp4",
};
const model = "media-test:unknown-native-model";

beforeAll(async () => {
	const [
		{ GeminiProvider },
		{ GeminiInteractionsProvider },
		{ OpenAIProvider },
		{ AnthropicProvider },
		{ CodexProvider },
		outbound,
		media,
	] = await Promise.all([
		import("../gemini-provider"),
		import("../gemini-interactions-provider"),
		import("../openai-provider"),
		import("../anthropic-provider"),
		import("../codex-provider"),
		import("../../net/outbound-fetch"),
		import("../../media-uploads"),
	]);
	const base = {
		id: "media-test",
		name: "Media test",
		prefix: "media-test",
		apiKey: "secret-test-key",
		baseUrl: "https://gemini.example.test/v1beta",
		defaultModel: "unknown-native-model",
	};
	createProviders = () => [
		{ kind: "generate", provider: new GeminiProvider(base) },
		{ kind: "interactions", provider: new GeminiInteractionsProvider(base) },
		{ kind: "chat", provider: new OpenAIProvider({ ...base, apiMode: "completions" }) },
	];
	unsupportedProviders = () => [
		new AnthropicProvider(base),
		new OpenAIProvider({ ...base, apiMode: "responses" }),
		new OpenAIProvider({ ...base, apiMode: "codex" }),
		new CodexProvider({ useWebSocket: true }),
		new CodexProvider({ useWebSocket: false }),
	];
	setFetch = outbound.setOutboundFetchOverrideForTest;
	saveMedia = media.saveUploadedMedia;
});
afterEach(() => setFetch?.(null));
afterAll(() => setFetch?.(null));

function params(extra: Partial<ChatParams> = {}): ChatParams {
	return {
		conversationId: "native-media",
		content: "",
		model,
		cwd: "/tmp",
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
		...extra,
	};
}
async function drain(provider: ProviderAdapter, extra: Partial<ChatParams> = {}): Promise<void> {
	for await (const _event of provider.chat(params(extra))) {
		/* Drain the mocked native stream. */
	}
}
function done(kind: string): Response {
	if (kind === "responses")
		return new Response(
			'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
			{ headers: { "content-type": "text/event-stream" } },
		);
	return new Response(
		kind === "generate"
			? `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`
			: kind === "interactions"
				? 'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"status":"completed"}}\n\n'
				: "data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } },
	);
}
function capture(kind: string): Array<Record<string, unknown>> {
	const requests: Array<Record<string, unknown>> = [];
	setFetch(async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)));
		return done(kind);
	});
	return requests;
}
function occurrence(value: unknown, base64: string): number {
	return JSON.stringify(value).split(base64).length - 1;
}
function attachmentIdentity(media: NativeMediaInput, toolCallId?: string, type = "text") {
	return {
		type,
		text:
			`Native media attachment metadata: ${JSON.stringify({ ...(media.filename ? { filename: media.filename } : {}), type: media.type, mediaType: media.mediaType, ...(toolCallId ? { toolCallId } : {}) })}\n` +
			`The following ${media.type} content is included directly in this message. The filename is an attachment label, not a device file path. Use this attachment for this message; do not substitute a file path from earlier conversation history.`,
	};
}
function expectIdentity(part: unknown, media: NativeMediaInput, type: string, toolCallId?: string) {
	const label = part as { type: string; text: string };
	expect(label.type).toBe(type);
	const prefix = "Native media attachment metadata: ";
	expect(label.text.startsWith(prefix)).toBe(true);
	expect(JSON.parse(label.text.slice(prefix.length).split("\n")[0])).toEqual({
		...(media.filename ? { filename: media.filename } : {}),
		type: media.type,
		mediaType: media.mediaType,
		...(toolCallId ? { toolCallId } : {}),
	});
}
function dbMessage(id: string, role: string, contentJson: unknown[], text = ""): DbMessage {
	return {
		id,
		role,
		contentJson,
		contentText: text,
		parentToolUseId: null,
		messageUuid: null,
	} as DbMessage;
}

describe("native media fallback capability and projection", () => {
	test("capability queries combine native protocol, model metadata and MIME without bytes", () => {
		for (const { kind, provider } of createProviders()) {
			expect(
				provider.supportsNativeMediaInput?.({ type: "audio", mediaType: "audio/wav" }, model),
			).toBe(true);
			expect(
				provider.supportsNativeMediaInput?.({ type: "video", mediaType: "video/mp4" }, model),
			).toBe(true);
			expect(
				provider.supportsNativeMediaInput?.({ type: "audio", mediaType: "audio/flac" }, model),
			).toBe(kind !== "chat");
			expect(provider.supportsNativeMediaInput?.(audio, "openai:gpt-5.5")).toBe(false);
		}
		for (const provider of unsupportedProviders())
			expect(provider.supportsNativeMediaInput?.(audio, model)).toBe(false);
	});
	test("unknown/old adapters fallback to real asset paths and metadata, never bytes or transcripts", async () => {
		const ref = await saveMedia(
			"fallback-query-owner",
			new File([wav], "tone.wav", { type: "audio/wav" }),
		);
		const adapter = { supportsNativeMediaInput: undefined } as unknown as ProviderAdapter;
		const result = splitNativeMediaReferences([ref], model, adapter, "wrong-fallback");
		expect(result.nativeRefs).toEqual([]);
		expect(result.fallbackText).toContain("当前模型不支持读取该模态数据，回退到一般文件");
		expect(result.fallbackText).toContain("当前模型未读取");
		expect(result.fallbackText).toContain('"filePath":');
		expect(result.fallbackText).toContain(ref.mediaId);
		expect(result.fallbackText).not.toContain(audio.base64);
		expect(result.warnings).toEqual([
			{
				model,
				filename: "tone.wav",
				mediaType: "audio/wav",
				type: "audio",
				mediaId: ref.mediaId,
				uploadNarratorId: "fallback-query-owner",
				reason: "unsupported-native-media-input",
			},
		]);
		expect(() =>
			splitNativeMediaReferences([{ ...ref, mediaId: "missing-file" }], model, adapter),
		).toThrow(/missing/);
	});
	test("supported references remain native; unsupported models become files before decoding", async () => {
		const ref = await saveMedia(
			"capability-owner",
			new File([wav], "tone.wav", { type: "audio/wav" }),
		);
		for (const { provider } of createProviders()) {
			const supported = splitNativeMediaReferences([ref], model, provider);
			expect(supported.nativeRefs).toHaveLength(1);
			expect(supported.fallbackText).toBe("");
			expect(supported.warnings).toEqual([]);
			const denied = splitNativeMediaReferences([ref], "openai:gpt-5.5", provider);
			expect(denied.nativeRefs).toHaveLength(0);
			expect(denied.warnings).toHaveLength(1);
		}
	});
	test("user/history/tool fallback copies rows, preserves stored refs, and reaches wire without native bytes", async () => {
		const ref = await saveMedia(
			"projection-owner",
			new File([wav], "tone.wav", { type: "audio/wav" }),
		);
		const block: MediaContentBlock = { ...ref, type: "audio" };
		const messages = [
			{ ...dbMessage("u", "user", [block]), narratorId: "wrong-row-owner" },
			{
				...dbMessage("a", "assistant", [], "read"),
				toolCalls: [
					{
						toolUseId: "r",
						toolName: "Read",
						inputJson: {},
						status: "success",
						outputJson: { _text: "read result", _media: [block] },
					},
				],
			} as DbMessage,
		];
		const original = JSON.stringify(messages);
		for (const { kind, provider } of createProviders()) {
			const result = projectUnsupportedNativeMediaForModel(
				messages,
				"openai:gpt-5.5",
				provider,
				"wrong-fallback",
			);
			expect(result.warnings).toHaveLength(2);
			expect(JSON.stringify(result.messages)).toContain("filePath");
			expect(JSON.stringify(result.messages)).not.toContain(audio.base64);
			expect(
				(result.messages[1].toolCalls?.[0].outputJson as { _media: unknown[] })._media,
			).toEqual([]);
			expect(JSON.stringify(messages)).toBe(original);
			const requests = capture(kind);
			const rebuilt = await provider.buildHistory(
				result.messages,
				"openai:gpt-5.5",
				"projection-owner",
			);
			await drain(provider, {
				model: "openai:gpt-5.5",
				history: rebuilt.history,
				toolResults: [],
			});
			expect(JSON.stringify(requests[0])).toContain("filePath");
			expect(JSON.stringify(requests[0])).not.toContain(audio.base64);
			const tail = projectUnsupportedNativeMediaForModel([messages[0]], "openai:gpt-5.5", provider);
			const tailHistory = await provider.buildHistory(tail.messages, "openai:gpt-5.5");
			await drain(provider, { model: "openai:gpt-5.5", history: tailHistory.history });
			expect(JSON.stringify(requests[1])).toContain("filePath");
		}
	});
});

describe("native media provider wire contracts", () => {
	test("small audio/video carries real base64 with the API-family-specific shape", async () => {
		for (const { kind, provider } of createProviders()) {
			const requests = capture(kind);
			await drain(provider, { media: [audio, video] });
			expect(occurrence(requests[0], audio.base64)).toBe(1);
			if (kind === "generate")
				expect(requests[0].contents).toEqual([
					{
						role: "user",
						parts: [
							{ inlineData: { mimeType: "audio/wav", data: audio.base64 } },
							{ inlineData: { mimeType: "video/mp4", data: video.base64 } },
						],
					},
				]);
			if (kind === "interactions")
				expect(requests[0].input).toEqual([
					{
						type: "user_input",
						content: [
							{ type: "audio", mime_type: "audio/wav", data: audio.base64 },
							{ type: "video", mime_type: "video/mp4", data: video.base64 },
						],
					},
				]);
			expect(occurrence(requests[0], video.base64)).toBe(1);
			if (kind === "chat") {
				expect(requests[0].messages).toEqual([
					{
						role: "user",
						content: [
							attachmentIdentity(audio),
							{ type: "input_audio", input_audio: { data: audio.base64, format: "wav" } },
							attachmentIdentity(video),
							{ type: "video_url", video_url: { url: `data:video/mp4;base64,${video.base64}` } },
						],
					},
				]);
			}
		}
	});
	test("request diagnostics omit audio/video bytes without changing the real request", async () => {
		for (const { kind, provider } of createProviders()) {
			const requests = capture(kind);
			const dump = new ApiRequestDumpCollector();
			await drain(provider, {
				requestDump: dump,
				media: [audio, video],
			});
			const snapshot = JSON.stringify(dump.lastRequestBody());
			expect(occurrence(requests[0], audio.base64)).toBe(1);
			expect(occurrence(requests[0], video.base64)).toBe(1);
			expect(snapshot).not.toContain(audio.base64);
			expect(snapshot).not.toContain(video.base64);
			expect(snapshot).toContain("native media omitted");
		}
	});
	test("canonical rows preserve media exactly once across repeated continuation projections", async () => {
		const ref = await saveMedia(
			"continuation-owner",
			new File([wav], "tone.wav", { type: "audio/wav" }),
		);
		const rows = [dbMessage("media-only", "user", [{ ...ref, type: "audio" }])];
		for (const { kind, provider } of createProviders()) {
			const requests = capture(kind);
			for (let attempt = 0; attempt < 2; attempt++) {
				const built = await provider.buildHistory(rows, model, "continuation-owner");
				await drain(provider, { content: ".", history: built.history });
				expect(occurrence(requests[attempt], audio.base64)).toBe(1);
			}
		}
	});
	test("parallel tool results precede native media and replay without internal fields", async () => {
		for (const { kind, provider } of createProviders()) {
			const requests = capture(kind);
			const ref = await saveMedia(
				"parallel-tools",
				new File([wav], "tone.wav", { type: "audio/wav" }),
			);
			const rows: DbMessage[] = [
				{
					...dbMessage("parallel", "assistant", []),
					toolCalls: ["one", "two"].map((toolUseId, index) => ({
						toolUseId,
						toolName: "Read",
						inputJson: {},
						status: "success",
						outputJson: { _text: index ? "second" : "first", _media: [{ ...ref, type: "audio" }] },
					})),
				},
			];
			const built = await provider.buildHistory(rows, model, "parallel-tools");
			await drain(provider, { content: "", history: built.history });
			expect(occurrence(requests[0], audio.base64)).toBe(2);
			expect(JSON.stringify(requests[0])).not.toContain("_nativeMedia");
			if (kind === "chat")
				expect(
					(requests[0].messages as Array<{ role: string }>).map((message) => message.role),
				).toEqual(["assistant", "tool", "tool", "user"]);
			const replay = await provider.buildHistory(rows, model, "parallel-tools");
			await drain(provider, { content: ".", history: replay.history });
			expect(occurrence(requests[1], audio.base64)).toBe(2);
		}
	});
	test("historical user media and tool _media resolve owner precedence and keep bytes", async () => {
		const ref = await saveMedia("media-owner", new File([wav], "tone.wav", { type: "audio/wav" }));
		const block: MediaContentBlock = { ...ref, type: "audio" };
		const user = { ...dbMessage("u1", "user", [block]), narratorId: "wrong-row-owner" };
		const assistant = {
			...dbMessage("a1", "assistant", [], "read complete"),
			narratorId: "wrong-row-owner",
			toolCalls: [
				{
					toolUseId: "read1",
					toolName: "Read",
					inputJson: {},
					outputJson: { _text: "media", _media: [block] },
					status: "success",
				},
			],
		} as DbMessage;
		for (const { kind, provider } of createProviders()) {
			const requests = capture(kind);
			const rebuilt = await provider.buildHistory(
				projectCurrentNativeMediaForModel(
					[user, assistant, dbMessage("u2", "user", [block])],
					[ref],
					"wrong-fallback-owner",
				),
				model,
				"wrong-fallback-owner",
			);
			await drain(provider, {
				history: rebuilt.history,
				toolResults: [],
				media: [audio],
			});
			// Old user, Read result, current attachment: the tail DB user was removed, not duplicated.
			expect(occurrence(requests[0], audio.base64)).toBe(3);
		}
	});
	test("history-only replay sends a pure media tail user even without current refs or sys messages", async () => {
		const ref = await saveMedia(
			"tail-replay-owner",
			new File([wav], "tone.wav", { type: "audio/wav" }),
		);
		const block: MediaContentBlock = { ...ref, type: "audio" };
		for (const { kind, provider } of createProviders()) {
			const requests = capture(kind);
			const rebuilt = await provider.buildHistory(
				[dbMessage("tail-only", "user", [block])],
				model,
				"tail-replay-owner",
			);
			await drain(provider, { content: "", history: rebuilt.history });
			expect(occurrence(requests[0], audio.base64)).toBe(1);
		}
	});
	test("sys-tail current attachments are omitted only from that row while history replay retains them", async () => {
		const ref = await saveMedia(
			"sys-tail-owner",
			new File([wav], "tone.wav", { type: "audio/wav" }),
		);
		const block: MediaContentBlock = { ...ref, type: "audio" };
		const rows = [
			dbMessage("old-user", "user", [block]),
			dbMessage("old-assistant", "assistant", [], "ok"),
			dbMessage("current-user", "user", [block]),
			dbMessage("sys-tail", "sys", [{ type: "text", text: "context" }], "context"),
		];
		const projected = projectCurrentNativeMediaForModel(rows, [ref], "sys-tail-owner");
		expect(rows[2].contentJson).toEqual([block]);
		expect(projected[0].contentJson).toEqual([block]);
		expect(projected[2].contentJson).toEqual([]);
		expect(projectCurrentNativeMediaForModel(rows, undefined, "sys-tail-owner")).toBe(rows);
		expect(
			projectCurrentNativeMediaForModel(
				rows,
				[{ ...ref, uploadNarratorId: "another-owner" }],
				"sys-tail-owner",
			),
		).toBe(rows);
		const afterAssistant = [
			...rows,
			dbMessage("new-assistant", "assistant", [], "already handled"),
		];
		expect(projectCurrentNativeMediaForModel(afterAssistant, [ref], "sys-tail-owner")).toBe(
			afterAssistant,
		);
		for (const { kind, provider } of createProviders()) {
			const requests = capture(kind);
			const current = await provider.buildHistory(projected, model, "sys-tail-owner");
			await drain(provider, { history: current.history, media: [audio] });
			expect(occurrence(requests[0], audio.base64)).toBe(2);
			const replay = await provider.buildHistory(rows, model, "sys-tail-owner");
			await drain(provider, { history: replay.history, content: "." });
			expect(occurrence(requests[1], audio.base64)).toBe(2);
		}
	});
	test("historical row and builder fallback owners work without explicit uploadNarratorId", async () => {
		const ref = await saveMedia(
			"fallback-owner",
			new File([wav], "tone.wav", { type: "audio/wav" }),
		);
		const { uploadNarratorId: _owner, ...rest } = ref;
		const block: MediaContentBlock = { ...rest, type: "audio" };
		for (const { kind, provider } of createProviders()) {
			for (const rowOwner of ["fallback-owner", undefined]) {
				const requests = capture(kind);
				const rebuilt = await provider.buildHistory(
					[
						{ ...dbMessage("old", "user", [block]), narratorId: rowOwner },
						dbMessage("answer", "assistant", [], "ok"),
					],
					model,
					"fallback-owner",
				);
				await drain(provider, { content: ".", history: rebuilt.history });
				expect(occurrence(requests[0], audio.base64)).toBe(1);
			}
		}
	});
	test("missing historical assets fail before any model request", async () => {
		let calls = 0;
		setFetch(async () => {
			calls++;
			throw new Error("must not fetch");
		});
		const block: MediaContentBlock = {
			type: "audio",
			mediaId: "missing",
			filename: "gone.wav",
			mediaType: "audio/wav",
			size: 44,
			uploadNarratorId: "no-owner",
		};
		for (const { provider } of createProviders()) {
			await expect(
				provider.buildHistory(
					[dbMessage("old", "user", [block]), dbMessage("a", "assistant", [], "ok")],
					model,
				),
			).rejects.toThrow(/missing/i);
			await expect(
				provider.buildHistory(
					[dbMessage("tail-invalid", "user", [{ type: "audio", mediaType: "audio/wav" }])],
					model,
				),
			).rejects.toThrow(/invalid|incomplete|base64/i);
		}
		expect(calls).toBe(0);
	});
	test("unsupported API families reject current, continuation, tool results and stored refs", async () => {
		let calls = 0;
		setFetch(async () => {
			calls++;
			throw new Error("must not fetch");
		});
		const block: MediaContentBlock = {
			type: "audio",
			mediaId: "missing",
			filename: "gone.wav",
			mediaType: "audio/wav",
			size: 44,
			uploadNarratorId: "no-owner",
		};
		for (const provider of unsupportedProviders()) {
			await expect(drain(provider, { media: [audio] })).rejects.toThrow(
				/does not support native audio/,
			);
			await expect(
				drain(provider, {
					history: [
						{
							role: "user",
							content: [
								{ type: "input_audio", input_audio: { data: audio.base64, format: "wav" } },
							],
						},
					],
				}),
			).rejects.toThrow(/does not support native audio/);
			await expect(
				drain(provider, {
					toolResults: [{ type: "tool_result", toolUseId: "r", content: [audio] }],
				}),
			).rejects.toThrow(/does not support native audio/);
			await expect(provider.buildHistory([dbMessage("u", "user", [block])], model)).rejects.toThrow(
				/does not support native audio/,
			);
			await expect(
				provider.buildHistory(
					[
						{
							...dbMessage("a", "assistant", [], "read"),
							toolCalls: [
								{
									toolUseId: "r",
									toolName: "Read",
									status: "success",
									inputJson: {},
									outputJson: { _text: "read", _media: [block] },
								},
							],
						} as DbMessage,
					],
					model,
				),
			).rejects.toThrow(/does not support native audio/);
		}
		expect(calls).toBe(0);
	});
	test("Doubao full model ID retains native video in current input, history and parallel Read results", async () => {
		const { buildAdapterHistory } = await import("../history-build");
		const provider = createProviders().find((entry) => entry.kind === "chat")?.provider;
		if (!provider) throw new Error("Chat provider fixture is missing.");
		const doubaoModel = "media-test:doubao-seed-2-1-lite-260915";
		const ref = await saveMedia(
			"doubao-video-owner",
			new File([Buffer.from(video.base64, "base64")], "clip.mp4", { type: "video/mp4" }),
		);
		const block: MediaContentBlock = { ...ref, type: "video" };
		expect(provider.supportsNativeMediaInput?.(video, doubaoModel)).toBe(true);
		const split = splitNativeMediaReferences([ref], doubaoModel, provider);
		expect(split.nativeRefs).toEqual([block]);
		expect(split.fallbackText).toBe("");
		expect(split.warnings).toEqual([]);
		const requests = capture("chat");
		await drain(provider, { model: doubaoModel, media: [video] });
		expect(requests[0].model).toBe("doubao-seed-2-1-lite-260915");
		expect(requests[0].messages).toEqual([
			{
				role: "user",
				content: [
					attachmentIdentity(video),
					{ type: "video_url", video_url: { url: `data:video/mp4;base64,${video.base64}` } },
				],
			},
		]);
		const rows: DbMessage[] = [
			dbMessage("doubao-history", "user", [block]),
			{
				...dbMessage("doubao-parallel-read", "assistant", []),
				toolCalls: ["read-one", "read-two"].map((toolUseId) => ({
					toolUseId,
					toolName: "Read",
					inputJson: { file_path: "clip.mp4" },
					status: "success",
					outputJson: { _text: "Read original video", _media: [block] },
				})),
			},
		];
		const original = JSON.stringify(rows);
		const history = await buildAdapterHistory(
			provider,
			rows,
			{ provider: "media-test", model: doubaoModel },
			{ narratorId: "wrong-fallback-owner" },
		);
		expect(history.mediaFallbackWarnings ?? []).toEqual([]);
		const dump = new ApiRequestDumpCollector();
		await drain(provider, {
			model: doubaoModel,
			history: history.history,
			media: [video],
			requestDump: dump,
		});
		const messages = requests[1].messages as Array<{ role: string; content: unknown }>;
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"tool",
			"user",
			"user",
		]);
		const expectedVideo = [
			attachmentIdentity(video),
			{ type: "video_url", video_url: { url: `data:video/mp4;base64,${video.base64}` } },
		];
		expect(messages[0].content).toEqual(expectedVideo);
		expect(messages[4].content).toEqual(
			["read-one", "read-two"].flatMap((id) => [attachmentIdentity(video, id), expectedVideo[1]]),
		);
		expect(messages[5].content).toEqual(expectedVideo);
		expect(occurrence(requests[1], video.base64)).toBe(4);
		expect(JSON.stringify(requests[1])).not.toContain("_nativeMedia");
		expect(JSON.stringify(requests[1])).not.toContain("回退到一般文件");
		expect(JSON.stringify(dump.lastRequestBody())).not.toContain(video.base64);
		expect(JSON.stringify(dump.lastRequestBody())).toContain("native media omitted");
		expect(JSON.stringify(rows)).toBe(original);
		// Canonical history-only replay must keep all three historical copies.
		await drain(provider, { model: doubaoModel, history: history.history });
		expect(occurrence(requests[2], video.base64)).toBe(3);
	});
	test("unsupported Responses, Codex and Anthropic still reject video in every input lane", async () => {
		const requests = capture("chat");
		const block: MediaContentBlock = {
			type: "video",
			mediaId: "missing-video",
			filename: "clip.mp4",
			mediaType: "video/mp4",
			size: 20,
			uploadNarratorId: "missing-owner",
		};
		for (const provider of unsupportedProviders()) {
			await expect(drain(provider, { media: [video] })).rejects.toThrow(
				/does not support native video/,
			);
			await expect(
				drain(provider, {
					history: [
						{
							role: "user",
							content: [
								{ type: "video_url", video_url: { url: `data:video/mp4;base64,${video.base64}` } },
							],
						},
					],
				}),
			).rejects.toThrow(/does not support native video/);
			await expect(drain(provider, { toolResults: [{ _nativeMedia: [video] }] })).rejects.toThrow(
				/does not support native video/,
			);
			await expect(
				provider.buildHistory([dbMessage("unsupported-video", "user", [block])], model),
			).rejects.toThrow(/does not support native video/);
			await expect(
				provider.buildHistory(
					[
						{
							...dbMessage("unsupported-video-tool", "assistant", []),
							toolCalls: [
								{
									toolUseId: "r",
									toolName: "Read",
									inputJson: {},
									status: "success",
									outputJson: { _text: "read", _media: [block] },
								},
							],
						},
					],
					model,
				),
			).rejects.toThrow(/does not support native video/);
		}
		expect(requests).toHaveLength(0);
	});
	test("Chat supports MP4 and QuickTime video_url but rejects unsupported media encodings before network", async () => {
		const entry = createProviders().find((item) => item.kind === "chat");
		if (!entry) throw new Error("Chat provider fixture is missing.");
		const { provider } = entry;
		const requests = capture("chat");
		for (const mediaType of ["video/mp4", "video/quicktime"]) {
			await drain(provider, { media: [{ ...video, mediaType }] });
			expect(requests.at(-1)?.messages).toEqual([
				{
					role: "user",
					content: [
						attachmentIdentity({ ...video, mediaType }),
						{ type: "video_url", video_url: { url: `data:${mediaType};base64,${video.base64}` } },
					],
				},
			]);
		}
		requests.length = 0;
		for (const mediaType of ["video/webm", "video/mpeg", "audio/wav"]) {
			expect(provider.supportsNativeMediaInput?.({ ...video, mediaType }, model)).toBe(false);
			await expect(drain(provider, { media: [{ ...video, mediaType }] })).rejects.toThrow();
		}
		await expect(
			drain(provider, { media: [{ ...audio, mediaType: "audio/flac" }] }),
		).rejects.toThrow(/only supports WAV\/MP3/);
		expect(requests).toHaveLength(0);
	});
	test("unsupported model metadata rejects media before any upload or model request", async () => {
		for (const { kind, provider } of createProviders()) {
			const requests = capture(kind);
			for (const media of [audio, video])
				await expect(drain(provider, { model: "openai:gpt-5.5", media: [media] })).rejects.toThrow(
					/does not support (audio|video)/,
				);
			expect(requests).toHaveLength(0);
		}
	});
	test("NUG delegates preserve current, historical and Read audio/video for a full Doubao model ID", async () => {
		const [{ NugProvider }, cache] = await Promise.all([
			import("../nug-provider"),
			import("../../nug-model-cache"),
		]);
		const config = {
			id: "media-nug",
			name: "Media NUG",
			prefix: "media-nug",
			apiKey: "test",
			baseUrl: "https://nug.example.test",
			defaultModel: "video-channel:doubao-seed-2-1-lite-260915",
		};
		cache.setNugCachedModels(config.id, [
			{
				id: "video-channel:doubao-seed-2-1-lite-260915",
				model: "doubao-seed-2-1-lite-260915",
				channel: "video-channel",
				channelType: "openai",
			},
		]);
		try {
			const provider = new NugProvider(config);
			const requests = capture("chat");
			const nugModel = "media-nug:video-channel:doubao-seed-2-1-lite-260915";
			expect(provider.supportsNativeMediaInput(audio, nugModel)).toBe(true);
			expect(provider.supportsNativeMediaInput(video, nugModel)).toBe(true);
			provider.prepareForModel(nugModel);
			const ref = await saveMedia("nug-owner", new File([wav], "tone.wav", { type: "audio/wav" }));
			const block = { ...ref, type: "audio" };
			const videoRef = await saveMedia(
				"nug-owner",
				new File([Buffer.from(video.base64, "base64")], "clip.mp4", { type: "video/mp4" }),
			);
			const videoBlock = { ...videoRef, type: "video" };
			const built = await provider.buildHistory(
				[
					dbMessage("nug-input", "user", [block, videoBlock]),
					{
						...dbMessage("nug-tool", "assistant", []),
						toolCalls: [
							{
								toolUseId: "r",
								toolName: "Read",
								inputJson: {},
								status: "success",
								outputJson: { _text: "read", _media: [block, videoBlock] },
							},
						],
					},
				],
				nugModel,
				"nug-owner",
			);
			await drain(provider, { model: nugModel, history: built.history, media: [audio, video] });
			expect(occurrence(requests[0], audio.base64)).toBe(3);
			expect(occurrence(requests[0], video.base64)).toBe(3);
			expect(requests[0].model).toBe("video-channel:doubao-seed-2-1-lite-260915");
			expect(JSON.stringify(requests[0])).toContain("video_url");
			expect(JSON.stringify(requests[0])).not.toContain("回退到一般文件");
			expect(JSON.stringify(requests[0])).not.toContain("imageRef");
		} finally {
			cache.deleteNugCachedModels(config.id);
		}
	});
	test("a text-only local metadata binding overrides a Doubao model name for native video", async () => {
		const [{ settings }, { OpenAIProvider }, { buildAdapterHistory }] = await Promise.all([
			import("../../settings"),
			import("../openai-provider"),
			import("../history-build"),
		]);
		const oldCatalog = settings.agent.modelCatalog;
		const oldProviders = settings.openaiProviders;
		const config = {
			id: "doubao-metadata",
			prefix: "doubao-metadata",
			name: "Test metadata binding",
			apiKey: "test-only",
			baseUrl: "https://ark.example.test/api/v3",
			defaultModel: "doubao-seed-2-1-lite-260915",
			apiMode: "completions" as const,
		};
		const fullModel = `${config.prefix}:${config.defaultModel}`;
		try {
			settings.openaiProviders = [...(oldProviders ?? []), config];
			settings.agent.modelCatalog = {
				schemaVersion: 2,
				migrationVersion: 2,
				autoApply: false,
				pinnedVersion: null,
				local: {
					revision: 101,
					models: [{ id: "doubao-text-only-card", metadata: {} }],
					bindings: [
						{
							id: "doubao-text-only-binding",
							providerId: config.id,
							upstreamModelId: config.defaultModel,
							modelId: "doubao-text-only-card",
							overrides: { supported_modalities: ["text"] },
						},
					],
				},
			};
			const provider = new OpenAIProvider(config);
			expect(provider.supportsNativeMediaInput(video, fullModel)).toBe(false);
			const requests = capture("chat");
			await expect(drain(provider, { model: fullModel, media: [video] })).rejects.toThrow(
				/does not support video/,
			);
			expect(requests).toHaveLength(0);
			const ref = await saveMedia(
				"doubao-text-only-owner",
				new File([Buffer.from(video.base64, "base64")], "clip.mp4", { type: "video/mp4" }),
			);
			const block: MediaContentBlock = { ...ref, type: "video" };
			const split = splitNativeMediaReferences([ref], fullModel, provider);
			expect(split.nativeRefs).toEqual([]);
			expect(split.warnings).toHaveLength(1);
			expect(split.fallbackText).toContain("当前模型未读取");
			expect(split.fallbackText).not.toContain(video.base64);
			const rows = [dbMessage("doubao-text-only-user", "user", [block])];
			const built = await buildAdapterHistory(provider, rows, {
				provider: config.id,
				model: fullModel,
			});
			expect(built.mediaFallbackWarnings).toHaveLength(1);
			await drain(provider, { model: fullModel, history: built.history });
			expect(occurrence(requests[0], video.base64)).toBe(0);
			expect(JSON.stringify(requests[0])).toContain("当前模型未读取");
			expect(rows[0].contentJson).toEqual([block]);
		} finally {
			settings.agent.modelCatalog = oldCatalog;
			settings.openaiProviders = oldProviders;
		}
	});
	test("Chat rejects malformed native video bytes and video_url representations before network", async () => {
		const provider = createProviders().find((entry) => entry.kind === "chat")?.provider;
		if (!provider) throw new Error("Chat provider fixture is missing.");
		const requests = capture("chat");
		const fullModel = "media-test:doubao-seed-2-1-lite-260915";
		for (const base64 of [
			"",
			"not base64",
			"YQ=",
			"YR==",
			"Y===",
			`data:video/mp4;base64,${video.base64}`,
		]) {
			await expect(
				drain(provider, { model: fullModel, media: [{ ...video, base64 }] }),
			).rejects.toThrow();
			await expect(
				drain(provider, {
					model: fullModel,
					toolResults: [
						{ tool_call_id: "r", content: "read", _nativeMedia: [{ ...video, base64 }] },
					],
				}),
			).rejects.toThrow();
		}
		for (const url of [
			"https://example.invalid/clip.mp4",
			"data:video/mp4;base64,not base64",
			`data:video/webm;base64,${video.base64}`,
			`data:audio/wav;base64,${video.base64}`,
			`data:video/mp4,${video.base64}`,
			"data:video/mp4;base64,",
		]) {
			await expect(
				drain(provider, {
					model: fullModel,
					history: [{ role: "user", content: [{ type: "video_url", video_url: { url } }] }],
				}),
			).rejects.toThrow();
		}
		expect(requests).toHaveLength(0);
	});
	test("metadata detects canonical, Interactions, Chat and fileData media", () => {
		for (const value of [
			audio,
			{ type: "audio", data: audio.base64, mime_type: "audio/wav" },
			chatAudioMedia(audio),
			{ type: "video_url", video_url: { url: "https://example.invalid/movie.mp4" } },
			{ type: "input_video", video_url: `data:video/mp4;base64,${video.base64}` },
			{ fileData: { mimeType: "audio/wav", fileUri: "https://example.invalid/v1beta/files/test" } },
		])
			expect(() =>
				assertModelInputModalities(
					"text-only",
					{ input: [{ content: [value] }] },
					{ inputModalities: ["text"] },
				),
			).toThrow(/does not support (audio|video)/);
	});
	test("malformed bytes and MIME mismatches are never sent", async () => {
		for (const bad of ["", "not base64", "YQ=", "YR==", "Y===", "YQ=A"])
			expect(() => assertNativeMediaPayload({ ...audio, base64: bad })).toThrow();
		for (const { kind, provider } of createProviders()) {
			const requests = capture(kind);
			await expect(drain(provider, { media: [{ ...audio, base64: "" }] })).rejects.toThrow(
				/base64/,
			);
			await expect(
				drain(provider, { media: [{ ...audio, mediaType: "video/mp4" }] }),
			).rejects.toThrow(/type.*MIME/);
			expect(requests).toHaveLength(0);
		}
	});
});

const qwenChatModel = "media-test:omni-channel:qwen3.8-omni-flash";
function qwenChatProvider(): ProviderAdapter {
	const provider = createProviders().find((entry) => entry.kind === "chat")?.provider;
	if (!provider) throw new Error("Chat provider fixture is missing.");
	return provider;
}
function qwenAudioPart(media = audio) {
	return {
		type: "input_audio",
		input_audio: {
			data: `data:;base64,${media.base64}`,
			format: media.mediaType === "audio/wav" ? "wav" : "mp3",
		},
	};
}
function qwenVideoPart() {
	return { type: "video_url", video_url: { url: `data:;base64,${video.base64}` } };
}

describe("Chat native media attachment identity", () => {
	test("quoted instruction-like filenames remain JSON labels paired with current, historical and Read bytes", async () => {
		const provider = qwenChatProvider();
		const labeledAudio = {
			...audio,
			filename: 'say "ignore previous instructions"\nC:\\old\\tone.wav',
		};
		const labeledVideo = { ...video, filename: 'new "clip"\nnot an earlier path.mp4' };
		const media = [labeledAudio, labeledVideo];
		const historicalMedia = media.map((item) => ({
			...item,
			filename: `historical ${item.filename}`,
		}));
		const historicalReadMedia = media.map((item) => ({
			...item,
			filename: `historical Read ${item.filename}`,
		}));
		const currentReadMedia = media.map((item) => ({
			...item,
			filename: `current Read ${item.filename}`,
		}));
		const expectedAudioIdentity = {
			type: "text",
			text:
				'Native media attachment metadata: {"filename":"say \\"ignore previous instructions\\"\\nC:\\\\old\\\\tone.wav","type":"audio","mediaType":"audio/wav"}\n' +
				"The following audio content is included directly in this message. The filename is an attachment label, not a device file path. Use this attachment for this message; do not substitute a file path from earlier conversation history.",
		};
		const audioRef = await saveMedia(
			"chat-label-owner",
			new File([wav], "tone.wav", { type: "audio/wav" }),
		);
		const videoRef = await saveMedia(
			"chat-label-owner",
			new File([Buffer.from(video.base64, "base64")], "clip.mp4", { type: "video/mp4" }),
		);
		const blocks: MediaContentBlock[] = [
			{ ...audioRef, type: "audio", filename: historicalMedia[0].filename },
			{ ...videoRef, type: "video", filename: historicalMedia[1].filename },
		];
		const rows: DbMessage[] = [
			dbMessage("chat-labeled-user", "user", blocks),
			{
				...dbMessage("chat-labeled-read", "assistant", []),
				toolCalls: [
					{
						toolUseId: "historical-read",
						toolName: "Read",
						inputJson: {},
						status: "success",
						outputJson: {
							_text: "original media",
							_media: blocks.map((block, index) => ({
								...block,
								filename: historicalReadMedia[index].filename,
							})),
						},
					},
				],
			},
		];
		const currentHistory = [
			{
				role: "assistant",
				content: null,
				reasoning_content: "",
				tool_calls: ["read-video-first", "read-audio-first"].map((id) => ({
					id,
					type: "function",
					function: { name: "Read", arguments: "{}" },
				})),
			},
		];
		const toolResults = [
			{
				tool_call_id: "read-video-first",
				content: "first",
				_nativeMedia: [currentReadMedia[1], currentReadMedia[0]],
			},
			{ tool_call_id: "read-audio-first", content: "second", _nativeMedia: currentReadMedia },
		];
		const original = JSON.stringify({ rows, media, currentHistory, toolResults });
		for (const selectedModel of [model, qwenChatModel]) {
			const requests = capture("chat");
			const expectedAudio =
				selectedModel === qwenChatModel
					? qwenAudioPart(labeledAudio)
					: { type: "input_audio", input_audio: { data: audio.base64, format: "wav" } };
			const expectedVideo =
				selectedModel === qwenChatModel
					? qwenVideoPart()
					: { type: "video_url", video_url: { url: `data:video/mp4;base64,${video.base64}` } };
			const expectedMedia = [
				expectedAudioIdentity,
				expectedAudio,
				attachmentIdentity(labeledVideo),
				expectedVideo,
			];
			const expectedHistorical = [
				attachmentIdentity(historicalMedia[0]),
				expectedAudio,
				attachmentIdentity(historicalMedia[1]),
				expectedVideo,
			];
			const expectedHistoricalRead = [
				attachmentIdentity(historicalReadMedia[0], "historical-read"),
				expectedAudio,
				attachmentIdentity(historicalReadMedia[1], "historical-read"),
				expectedVideo,
			];
			const expectedCurrentRead = [
				attachmentIdentity(currentReadMedia[0], "read-audio-first"),
				expectedAudio,
				attachmentIdentity(currentReadMedia[1], "read-audio-first"),
				expectedVideo,
			];
			const built = await provider.buildHistory(rows, selectedModel, "wrong-fallback-owner");
			const historyBefore = JSON.stringify(built.history);
			await drain(provider, { model: selectedModel, history: built.history, media });
			const messages = requests[0].messages as Array<{ role: string; content: unknown }>;
			expect(messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"tool",
				"user",
				"user",
			]);
			expect(messages[0].content).toEqual(expectedHistorical);
			expect(messages[3].content).toEqual(expectedHistoricalRead);
			expect(messages[4].content).toEqual(expectedMedia);
			for (const item of media) expect(occurrence(requests[0], item.base64)).toBe(3);
			expect(expectedAudioIdentity.text.split("\n")).toHaveLength(2);
			expect(
				JSON.parse(
					expectedAudioIdentity.text
						.split("\n")[0]
						.slice("Native media attachment metadata: ".length),
				),
			).toEqual({
				filename: labeledAudio.filename,
				type: "audio",
				mediaType: "audio/wav",
			});
			await drain(provider, { model: selectedModel, history: built.history });
			const replay = requests[1].messages as Array<{ role: string; content: unknown }>;
			expect(replay.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
			expect(replay[0].content).toEqual(expectedHistorical);
			expect(replay[3].content).toEqual(expectedHistoricalRead);
			for (const item of media) expect(occurrence(requests[1], item.base64)).toBe(2);
			expect(JSON.stringify(built.history)).toBe(historyBefore);
			await drain(provider, { model: selectedModel, history: currentHistory, toolResults });
			const currentRead = requests[2].messages as Array<{ role: string; content: unknown }>;
			expect(currentRead.map((message) => message.role)).toEqual([
				"assistant",
				"tool",
				"tool",
				"user",
			]);
			expect(currentRead[3].content).toEqual([
				attachmentIdentity(currentReadMedia[1], "read-video-first"),
				expectedVideo,
				attachmentIdentity(currentReadMedia[0], "read-video-first"),
				expectedAudio,
				...expectedCurrentRead,
			]);
			for (const item of media) expect(occurrence(requests[2], item.base64)).toBe(2);
			expect(JSON.stringify(requests)).not.toContain("_nativeMedia");
			expect(JSON.stringify({ rows, media, currentHistory, toolResults })).toBe(original);
		}
	});
	test("absent and empty filenames never invent metadata in current, historical or Read input", async () => {
		const provider = qwenChatProvider();
		for (const selectedModel of [model, qwenChatModel]) {
			for (const filename of [undefined, ""]) {
				const media = [audio, video].map(({ filename: _filename, ...item }) =>
					filename === undefined ? item : { ...item, filename },
				);
				const rows = [dbMessage("unnamed-media", "user", media)];
				const toolResults = [
					{ tool_call_id: "unnamed-read", content: "read", _nativeMedia: media },
				];
				const original = JSON.stringify({ media, rows, toolResults });
				const requests = capture("chat");
				const expectedMedia =
					selectedModel === qwenChatModel
						? [qwenAudioPart(), qwenVideoPart()]
						: [
								{ type: "input_audio", input_audio: { data: audio.base64, format: "wav" } },
								{ type: "video_url", video_url: { url: `data:video/mp4;base64,${video.base64}` } },
							];
				const labeled = expectedMedia;
				const labeledTool = media.flatMap((item, index) => [
					attachmentIdentity(item, "unnamed-read"),
					expectedMedia[index],
				]);
				await drain(provider, { model: selectedModel, media });
				expect(requests[0].messages).toEqual([{ role: "user", content: labeled }]);
				const built = await provider.buildHistory(rows, selectedModel);
				const historyBefore = JSON.stringify(built.history);
				await drain(provider, { model: selectedModel, history: built.history });
				expect(requests[1].messages).toEqual([{ role: "user", content: labeled }]);
				await drain(provider, { model: selectedModel, toolResults });
				expect(requests[2].messages).toEqual([
					{ role: "tool", tool_call_id: "unnamed-read", content: "read" },
					{ role: "user", content: labeledTool },
				]);
				for (const request of requests) {
					for (const item of media) expect(occurrence(request, item.base64)).toBe(1);
				}
				expect(JSON.stringify(built.history)).toBe(historyBefore);
				expect(JSON.stringify({ media, rows, toolResults })).toBe(original);
			}
		}
	});
	test("nonempty whitespace and padded filenames preserve their exact attachment label", async () => {
		const provider = qwenChatProvider();
		for (const selectedModel of [model, qwenChatModel]) {
			for (const filename of [" \t\n", "  tone.wav  "]) {
				const media = [{ ...audio, filename }];
				const original = JSON.stringify(media);
				const requests = capture("chat");
				const expectedMedia = [
					attachmentIdentity(media[0]),
					selectedModel === qwenChatModel
						? qwenAudioPart()
						: { type: "input_audio", input_audio: { data: audio.base64, format: "wav" } },
				];
				await drain(provider, { model: selectedModel, media });
				expect(requests[0].messages).toEqual([{ role: "user", content: expectedMedia }]);
				const built = await provider.buildHistory(
					[dbMessage("padded-label", "user", media)],
					selectedModel,
				);
				await drain(provider, { model: selectedModel, history: built.history });
				expect(requests[1].messages).toEqual([{ role: "user", content: expectedMedia }]);
				expect(JSON.stringify(media)).toBe(original);
			}
		}
	});
});

describe("Qwen Omni Chat native media", () => {
	test("prefixed dash and dotted Omni model IDs send no-MIME data URIs for WAV, MP3 and MP4", async () => {
		const provider = qwenChatProvider();
		const requests = capture("chat");
		const mp3: NativeMediaInput = {
			...audio,
			mediaType: "audio/mpeg",
			filename: "tone.mp3",
			base64: Buffer.from("49443304000000000000", "hex").toString("base64"),
		};
		for (const qwenModel of [qwenChatModel, "media-test:omni-channel:qwen3.8-omni.flash"]) {
			const media = [audio, mp3, video];
			const original = JSON.stringify(media);
			const dump = new ApiRequestDumpCollector();
			await drain(provider, { model: qwenModel, media, requestDump: dump });
			expect(requests.at(-1)?.messages).toEqual([
				{
					role: "user",
					content: [
						attachmentIdentity(audio),
						qwenAudioPart(),
						attachmentIdentity(mp3),
						qwenAudioPart(mp3),
						attachmentIdentity(video),
						qwenVideoPart(),
					],
				},
			]);
			for (const item of media) {
				expect(occurrence(requests.at(-1), item.base64)).toBe(1);
				expect(JSON.stringify(dump.lastRequestBody())).not.toContain(item.base64);
			}
			expect(JSON.stringify(dump.lastRequestBody())).toContain("native media omitted");
			expect(JSON.stringify(media)).toBe(original);
		}
	});
	test("canonical history and two mixed Read results preserve bytes and ordering without mutating history", async () => {
		const { buildAdapterHistory } = await import("../history-build");
		const provider = qwenChatProvider();
		const audioRef = await saveMedia(
			"qwen-history-owner",
			new File([wav], "tone.wav", { type: "audio/wav" }),
		);
		const videoRef = await saveMedia(
			"qwen-history-owner",
			new File([Buffer.from(video.base64, "base64")], "clip.mp4", { type: "video/mp4" }),
		);
		const blocks: MediaContentBlock[] = [
			{ ...audioRef, type: "audio" },
			{ ...videoRef, type: "video" },
		];
		const rows: DbMessage[] = [
			dbMessage("qwen-history-user", "user", blocks),
			{
				...dbMessage("qwen-history-read", "assistant", []),
				toolCalls: ["qwen-read-one", "qwen-read-two"].map((toolUseId) => ({
					toolUseId,
					toolName: "Read",
					inputJson: {},
					status: "success",
					outputJson: { _text: "Read original media", _media: blocks },
				})),
			},
		];
		const original = JSON.stringify(rows);
		const built = await buildAdapterHistory(
			provider,
			rows,
			{ provider: "media-test", model: qwenChatModel },
			{ narratorId: "wrong-owner" },
		);
		expect(built.mediaFallbackWarnings ?? []).toEqual([]);
		const historyBefore = JSON.stringify(built.history);
		const requests = capture("chat");
		const dump = new ApiRequestDumpCollector();
		await drain(provider, {
			model: qwenChatModel,
			history: built.history,
			media: [audio, video],
			requestDump: dump,
		});
		const messages = requests[0].messages as Array<{ role: string; content: unknown }>;
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"tool",
			"user",
			"user",
		]);
		const expectedMedia = [
			attachmentIdentity(audio),
			qwenAudioPart(),
			attachmentIdentity(video),
			qwenVideoPart(),
		];
		expect(messages[0].content).toEqual(expectedMedia);
		expect(messages[4].content).toEqual(
			["qwen-read-one", "qwen-read-two"].flatMap((id) => [
				attachmentIdentity(audio, id),
				qwenAudioPart(),
				attachmentIdentity(video, id),
				qwenVideoPart(),
			]),
		);
		expect(messages[5].content).toEqual(expectedMedia);
		for (const media of [audio, video]) {
			expect(occurrence(requests[0], media.base64)).toBe(4);
			expect(JSON.stringify(dump.lastRequestBody())).not.toContain(media.base64);
		}
		expect(JSON.stringify(requests[0])).not.toContain("_nativeMedia");
		expect(JSON.stringify(rows)).toBe(original);
		expect(JSON.stringify(built.history)).toBe(historyBefore);
		await drain(provider, { model: qwenChatModel, history: built.history });
		for (const media of [audio, video]) expect(occurrence(requests[1], media.base64)).toBe(3);
		expect(JSON.stringify(built.history)).toBe(historyBefore);
	});
	test("current mixed tool results are answered together before one Qwen media user turn", async () => {
		const provider = qwenChatProvider();
		const requests = capture("chat");
		const calls = ["qwen-current-one", "qwen-current-two"];
		const history = [
			{
				role: "assistant",
				content: null,
				// Canonical Chat history already carries this existing relay normalization.
				reasoning_content: "",
				tool_calls: calls.map((id) => ({
					id,
					type: "function",
					function: { name: "Read", arguments: "{}" },
				})),
			},
		];
		const toolResults = calls.map((tool_call_id) => ({
			tool_call_id,
			content: "Read original media",
			_nativeMedia: [audio, video],
		}));
		const original = JSON.stringify({ history, toolResults });
		await drain(provider, { model: qwenChatModel, history, toolResults });
		const messages = requests[0].messages as Array<{ role: string; content: unknown }>;
		expect(messages.map((message) => message.role)).toEqual(["assistant", "tool", "tool", "user"]);
		expect(messages[3].content).toEqual(
			calls.flatMap((id) => [
				attachmentIdentity(audio, id),
				qwenAudioPart(),
				attachmentIdentity(video, id),
				qwenVideoPart(),
			]),
		);
		expect(JSON.stringify(requests[0])).not.toContain("_nativeMedia");
		expect(JSON.stringify({ history, toolResults })).toBe(original);
	});
	test("valid no-MIME audio and video data URIs already in Qwen history replay unchanged", async () => {
		const provider = qwenChatProvider();
		const requests = capture("chat");
		const history = [{ role: "user", content: [qwenAudioPart(), qwenVideoPart()] }];
		const original = JSON.stringify(history);
		await drain(provider, { model: qwenChatModel, history });
		expect(requests[0].messages).toEqual(history);
		expect(JSON.stringify(history)).toBe(original);
	});
	test("non-Qwen Chat keeps raw input_audio and MIME video URLs while Qwen Responses stays unsupported", async () => {
		const requests = capture("chat");
		await drain(qwenChatProvider(), { model, media: [audio, video] });
		expect(requests[0].messages).toEqual([
			{
				role: "user",
				content: [
					attachmentIdentity(audio),
					{ type: "input_audio", input_audio: { data: audio.base64, format: "wav" } },
					attachmentIdentity(video),
					{ type: "video_url", video_url: { url: `data:video/mp4;base64,${video.base64}` } },
				],
			},
		]);
		requests.length = 0;
		const provider = await createResponsesProvider();
		for (const media of [audio, video]) {
			expect(provider.supportsNativeMediaInput(media, qwenChatModel)).toBe(false);
			await expect(drain(provider, { model: qwenChatModel, media: [media] })).rejects.toThrow();
		}
		expect(requests).toHaveLength(0);
	});
	test("invalid Omni data URIs, base64, audio formats and remote URLs fail before transport", async () => {
		const provider = qwenChatProvider();
		const requests = capture("chat");
		for (const base64 of ["", "not base64", "YQ=", "YR==", `data:;base64,${audio.base64}`]) {
			await expect(
				drain(provider, { model: qwenChatModel, media: [{ ...audio, base64 }] }),
			).rejects.toThrow();
		}
		for (const data of [
			"data:;base64,",
			"data:;base64,not base64",
			"data:;base64,YR==",
			`data:,${audio.base64}`,
			`data:;base64,data:;base64,${audio.base64}`,
			"https://example.invalid/tone.wav",
		]) {
			await expect(
				drain(provider, {
					model: qwenChatModel,
					history: [
						{
							role: "user",
							content: [{ type: "input_audio", input_audio: { data, format: "wav" } }],
						},
					],
				}),
			).rejects.toThrow();
		}
		for (const format of ["flac", "ogg", "", "mp4"]) {
			await expect(
				drain(provider, {
					model: qwenChatModel,
					history: [
						{
							role: "user",
							content: [
								{
									type: "input_audio",
									input_audio: { data: `data:;base64,${audio.base64}`, format },
								},
							],
						},
					],
				}),
			).rejects.toThrow();
		}
		for (const url of [
			"https://example.invalid/clip.mp4",
			"data:;base64,",
			"data:;base64,not base64",
			`data:,${video.base64}`,
			`data:;base64,data:;base64,${video.base64}`,
		]) {
			await expect(
				drain(provider, {
					model: qwenChatModel,
					history: [{ role: "user", content: [{ type: "video_url", video_url: { url } }] }],
				}),
			).rejects.toThrow();
		}
		expect(requests).toHaveLength(0);
	});
	test("Qwen audio and video Data URIs above the former 10MiB threshold reach transport unchanged", async () => {
		const provider = qwenChatProvider();
		const requests = capture("chat");
		const base64 = "A".repeat(10 * 1024 * 1024);
		for (const media of [audio, video]) {
			await drain(provider, { model: qwenChatModel, media: [{ ...media, base64 }] });
			const request = requests.at(-1) as {
				messages: Array<{
					content: Array<{
						type: string;
						text?: string;
						input_audio?: { data: string };
						video_url?: { url: string };
					}>;
				}>;
			};
			expect(request.messages[0].content).toHaveLength(2);
			expect(request.messages[0].content[0]).toEqual(attachmentIdentity(media));
			const part = request.messages[0].content[1];
			expect(part.input_audio?.data ?? part.video_url?.url).toBe(`data:;base64,${base64}`);
		}
		expect(requests).toHaveLength(2);
	});
	test("Qwen request bodies above the former 16MiB threshold reach transport without a local size ceiling", async () => {
		const provider = qwenChatProvider();
		const requests = capture("chat");
		const base64 = Buffer.alloc(6 * 1024 * 1024 - 1024, 49).toString("base64");
		const media = [
			{ ...audio, base64 },
			{ ...video, base64 },
		];
		for (const extras of [
			{ content: "汉".repeat(4096) },
			{
				tools: [
					{
						type: "function",
						function: {
							name: "Read",
							description: "schema-budget".repeat(4096),
							parameters: { type: "object", properties: {} },
						},
					},
				],
			},
		]) {
			await drain(provider, { model: qwenChatModel, media, ...extras });
			const request = requests.at(-1);
			expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeGreaterThan(16 * 1024 * 1024);
			expect(occurrence(request, base64)).toBe(2);
		}
		expect(requests).toHaveLength(2);
	});
	test("Qwen transport size errors are reported from the server rather than invented locally", async () => {
		const provider = qwenChatProvider();
		let calls = 0;
		setFetch(async () => {
			calls++;
			return new Response(
				JSON.stringify({
					error: { message: "Provider request size limit", type: "invalid_request_error" },
				}),
				{
					status: 413,
					headers: { "content-type": "application/json" },
				},
			);
		});
		await expect(drain(provider, { model: qwenChatModel, media: [audio] })).rejects.toThrow(/413/);
		expect(calls).toBe(1);
	});
});

const doubaoResponsesModel = "media-test:doubao-seed-2-1-lite-260915";
async function createResponsesProvider(
	extra: { baseUrl?: string; apiMode?: "responses" | "codex" } = {},
) {
	const { OpenAIProvider } = await import("../openai-provider");
	return new OpenAIProvider({
		id: "media-test",
		prefix: "media-test",
		name: "Mock Responses video",
		apiKey: "test-only-key",
		baseUrl: "https://responses.example.test/v1",
		defaultModel: "doubao-seed-2-1-lite-260915",
		apiMode: "responses",
		...extra,
	});
}

describe("parallel Chat completions tool images retain original behavior", () => {
	const ids = ["chat-image-one", "chat-image-two"];
	const images = [
		[
			{ format: "png", base64: "AQID" },
			{ format: "png", base64: "BwgJ" },
		],
		[{ format: "png", base64: "BAUG" }],
	];
	const history = [
		{
			role: "assistant",
			content: null,
			reasoning_content: "",
			tool_calls: ids.map((id) => ({
				id,
				type: "function",
				function: { name: "Read", arguments: "{}" },
			})),
		},
	];
	const results = ids.map((tool_call_id, index) => ({
		tool_call_id,
		content: `image result ${index}`,
		_images: images[index],
	}));

	function expectParallelImages(input: unknown[]) {
		const messages = input as Array<{ role: string; tool_call_id?: string; content: unknown }>;
		expect(messages.map((message) => message.role)).toEqual(["assistant", "tool", "tool"]);
		expect(
			messages.slice(1, 3).map(({ tool_call_id, content }) => ({ tool_call_id, content })),
		).toEqual(
			ids.map((tool_call_id, index) => ({ tool_call_id, content: `image result ${index}` })),
		);
		expect(JSON.stringify(input)).not.toContain("_images");
	}

	test("current parallel results retain text-only tool outputs", async () => {
		const provider = qwenChatProvider();
		const requests = capture("chat");
		const original = JSON.stringify({ history, results });
		await drain(provider, { history, toolResults: results });
		expectParallelImages(requests[0].messages as unknown[]);
		expect(JSON.stringify({ history, results })).toBe(original);
	});

	test("LoopTranscript history retains text-only tool outputs", async () => {
		const provider = qwenChatProvider();
		const requests = capture("chat");
		const { LoopTranscript } = await import("../loop-transcript");
		const transcript = new LoopTranscript();
		transcript.appendStep(
			ids.map((toolUseId) => ({ type: "tool_use", toolUseId, name: "Read", input: {} })),
		);
		ids.forEach((id, index) => {
			transcript.settleTool(id, { output: `image result ${index}`, images: images[index] });
		});
		const original = JSON.stringify(transcript.rows);
		const built = await provider.buildHistory(transcript.rows, model);
		const builtOriginal = JSON.stringify(built.history);
		await drain(provider, { history: built.history });
		expectParallelImages(requests[0].messages as unknown[]);
		expect(JSON.stringify(transcript.rows)).toBe(original);
		expect(JSON.stringify(built.history)).toBe(builtOriginal);
	});
});

describe("parallel Responses tool image identity", () => {
	const ids = ["image-one", "image-two"];
	const images = [
		{ format: "png", base64: "AQID" },
		{ format: "png", base64: "BAUG" },
	];
	const calls = ids.map((call_id) => ({
		type: "function_call",
		call_id,
		name: "Read",
		arguments: "{}",
	}));
	const results = ids.map((call_id, index) => ({
		type: "function_call_output",
		call_id,
		output: "image result",
		_images: [images[index]],
	}));

	function expectParallelImages(input: unknown[]) {
		const items = input as Array<{
			type?: string;
			role?: string;
			call_id?: string;
			content?: unknown;
		}>;
		expect(items.map((item) => item.type ?? item.role)).toEqual([
			"function_call",
			"function_call",
			"function_call_output",
			"user",
			"function_call_output",
			"user",
		]);
		expect([items[2].call_id, items[4].call_id]).toEqual(ids);
		for (const [index, image] of images.entries()) {
			expect(items[3 + index * 2].content).toEqual([
				{ type: "input_image", image_url: `data:image/png;base64,${image.base64}` },
			]);
		}
		expect(JSON.stringify(input)).not.toContain("_images");
	}

	test("current and historical results retain original per-result image ordering", async () => {
		const provider = await createResponsesProvider();
		const requests = capture("responses");
		await drain(provider, { history: calls, toolResults: results });
		const { LoopTranscript } = await import("../loop-transcript");
		const transcript = new LoopTranscript();
		transcript.appendStep(
			ids.map((toolUseId) => ({ type: "tool_use", toolUseId, name: "Read", input: {} })),
		);
		ids.forEach((id, index) => {
			transcript.settleTool(id, { output: "image result", images: [images[index]] });
		});
		const built = await provider.buildHistory(transcript.rows, model);
		await drain(provider, { history: built.history });
		for (const request of requests) expectParallelImages(request.input as unknown[]);
	});

	test("mixed parallel current and historical results preserve image and video provenance", async () => {
		const provider = await createResponsesProvider();
		const requests = capture("responses");
		await drain(provider, {
			model: doubaoResponsesModel,
			history: calls,
			toolResults: results.map((result, index) =>
				index === 0 ? { ...result, _nativeMedia: [video] } : result,
			),
		});
		const owner = "mixed-image-video-owner";
		const ref = await saveMedia(
			owner,
			new File([Buffer.from(video.base64, "base64")], "clip.mp4", { type: "video/mp4" }),
		);
		const { LoopTranscript } = await import("../loop-transcript");
		const transcript = new LoopTranscript();
		transcript.appendStep(
			ids.map((toolUseId) => ({ type: "tool_use", toolUseId, name: "Read", input: {} })),
		);
		ids.forEach((id, index) => {
			transcript.settleTool(id, {
				output: "image result",
				images: [images[index]],
				...(index === 0 ? { mediaRefs: [{ ...ref, type: "video" as const }] } : {}),
			});
		});
		const built = await provider.buildHistory(transcript.rows, doubaoResponsesModel, owner);
		await drain(provider, { model: doubaoResponsesModel, history: built.history });
		for (const request of requests) {
			const items = request.input as Array<{ type?: string; role?: string; content?: unknown }>;
			expect(items.map((item) => item.type ?? item.role)).toEqual([
				"function_call",
				"function_call",
				"function_call_output",
				"function_call_output",
				"user",
				"user",
				"user",
			]);
			for (const [index, image] of images.entries()) {
				expect(items[4 + index].content).toEqual([
					{
						type: "input_text",
						text: `Tool result image source: ${JSON.stringify({ toolCallId: ids[index] })}`,
					},
					{ type: "input_image", image_url: `data:image/png;base64,${image.base64}` },
				]);
			}
			expect(items[6].content).toEqual([
				attachmentIdentity(video, ids[0], "input_text"),
				{ type: "input_video", video_url: `data:video/mp4;base64,${video.base64}` },
			]);
		}
	});

	test("Codex WebSocket request retains original per-result image ordering", async () => {
		const provider = await createResponsesProvider({ apiMode: "codex" });
		const builder = provider as unknown as {
			buildCodexWebSocketRequest(params: ChatParams): { input: unknown[] };
		};
		const request = builder.buildCodexWebSocketRequest(
			params({ history: calls, toolResults: results }),
		);
		expectParallelImages(request.input);
	});
});

describe("parallel tool video identity across Chat and Ark Responses", () => {
	test("named and unnamed identical videos retain their originating call in current and historical results", async () => {
		const ref = await saveMedia(
			"parallel-label-owner",
			new File([Buffer.from(video.base64, "base64")], "clip.mp4", { type: "video/mp4" }),
		);
		const { filename: _filename, ...unnamed } = video;
		// Persisted media is validated against its filename extension; unnamed media is
		// exercised in the current tool-result lane instead.
		const blocks = [
			{ ...ref, type: "video" },
			{ ...ref, type: "video" },
		] as MediaContentBlock[];
		const media = [video, unnamed];
		for (const [kind, provider] of [
			["chat", qwenChatProvider()],
			["responses", await createResponsesProvider()],
		] as const) {
			const ids = ["parallel-named", "parallel-unnamed"];
			const rows: DbMessage[] = [
				{
					...dbMessage("parallel-history", "assistant", []),
					toolCalls: ids.map((toolUseId, index) => ({
						toolUseId,
						toolName: "Read",
						inputJson: {},
						status: "success",
						outputJson: { _text: "read", _media: [blocks[index]] },
					})),
				},
			];
			const requests = capture(kind);
			const toolResults = ids.map((id, index) =>
				kind === "chat"
					? { tool_call_id: id, content: "read", _nativeMedia: [media[index]] }
					: {
							type: "function_call_output",
							call_id: id,
							output: "read",
							_nativeMedia: [media[index]],
						},
			);
			await drain(provider, { model: doubaoResponsesModel, toolResults });
			const built = await provider.buildHistory(rows, doubaoResponsesModel);
			await drain(provider, { model: doubaoResponsesModel, history: built.history });
			for (const [requestIndex, request] of requests.entries()) {
				const items = request[kind === "chat" ? "messages" : "input"] as Array<{
					role?: string;
					content?: unknown;
				}>;
				const user = items.find((item) => item.role === "user" && Array.isArray(item.content));
				if (!user) throw new Error("Missing media user message");
				const parts = user.content as Array<{ type: string }>;
				expect(parts).toHaveLength(4);
				for (const [index, id] of ids.entries()) {
					expectIdentity(
						parts[index * 2],
						requestIndex === 0 ? media[index] : { ...video, filename: ref.filename },
						kind === "chat" ? "text" : "input_text",
						id,
					);
					expect(parts[index * 2 + 1].type).toBe(kind === "chat" ? "video_url" : "input_video");
				}
			}
		}
	});
});

describe("Doubao Responses native video", () => {
	test("current MP4 uses input_video with a string data URL and redacted diagnostics", async () => {
		const provider = await createResponsesProvider();
		const requests = capture("responses");
		expect(provider.supportsNativeMediaInput(video, doubaoResponsesModel)).toBe(true);
		const dump = new ApiRequestDumpCollector();
		await drain(provider, { model: doubaoResponsesModel, media: [video], requestDump: dump });
		expect(requests[0].model).toBe("doubao-seed-2-1-lite-260915");
		const input = requests[0].input as Array<{ role: string; content: unknown[] }>;
		expect(input).toHaveLength(1);
		expect(input[0].role).toBe("user");
		expect(input[0].content).toHaveLength(2);
		expectIdentity(input[0].content[0], video, "input_text");
		expect(input[0].content[1]).toEqual({
			type: "input_video",
			video_url: `data:video/mp4;base64,${video.base64}`,
		});
		expect(occurrence(requests[0], video.base64)).toBe(1);
		expect(JSON.stringify(dump.lastRequestBody())).not.toContain(video.base64);
		expect(JSON.stringify(dump.lastRequestBody())).toContain("native media omitted");
	});
	test("canonical history and parallel Read results answer all calls before native video user input", async () => {
		const { buildAdapterHistory } = await import("../history-build");
		const provider = await createResponsesProvider();
		const ref = await saveMedia(
			"doubao-responses-owner",
			new File([Buffer.from(video.base64, "base64")], "clip.mp4", { type: "video/mp4" }),
		);
		const block: MediaContentBlock = { ...ref, type: "video" };
		const split = splitNativeMediaReferences([ref], doubaoResponsesModel, provider);
		expect(split.nativeRefs).toEqual([block]);
		expect(split.fallbackText).toBe("");
		expect(split.warnings).toEqual([]);
		const rows: DbMessage[] = [
			dbMessage("responses-video-user", "user", [block]),
			{
				...dbMessage("responses-parallel-read", "assistant", []),
				toolCalls: ["read-one", "read-two"].map((toolUseId) => ({
					toolUseId,
					toolName: "Read",
					inputJson: { file_path: "clip.mp4" },
					status: "success",
					outputJson: { _text: "Read original video", _media: [block] },
				})),
			},
		];
		const original = JSON.stringify(rows);
		const built = await buildAdapterHistory(
			provider,
			rows,
			{ provider: "media-test", model: doubaoResponsesModel },
			{ narratorId: "wrong-owner" },
		);
		expect(built.mediaFallbackWarnings ?? []).toEqual([]);
		const requests = capture("responses");
		const dump = new ApiRequestDumpCollector();
		await drain(provider, {
			model: doubaoResponsesModel,
			history: built.history,
			media: [video],
			requestDump: dump,
		});
		const input = requests[0].input as Array<{
			type?: string;
			role?: string;
			call_id?: string;
			content?: unknown;
		}>;
		expect(input.map((item) => item.type ?? item.role)).toEqual([
			"user",
			"function_call",
			"function_call",
			"function_call_output",
			"function_call_output",
			"user",
			"user",
		]);
		expect(input.slice(3, 5).map((item) => item.call_id)).toEqual(["read-one", "read-two"]);
		const historical = input[0].content as unknown[];
		const toolMedia = input[5].content as unknown[];
		const current = input[6].content as unknown[];
		expectIdentity(historical[0], video, "input_text");
		expectIdentity(current[0], video, "input_text");
		expect(toolMedia).toHaveLength(4);
		for (const [index, id] of ["read-one", "read-two"].entries()) {
			expectIdentity(toolMedia[index * 2], video, "input_text", id);
			expect(toolMedia[index * 2 + 1]).toEqual({
				type: "input_video",
				video_url: `data:video/mp4;base64,${video.base64}`,
			});
		}
		expect(occurrence(requests[0], video.base64)).toBe(4);
		expect(JSON.stringify(requests[0])).not.toContain("_nativeMedia");
		expect(JSON.stringify(requests[0])).not.toContain("回退到一般文件");
		expect(JSON.stringify(dump.lastRequestBody())).not.toContain(video.base64);
		expect(JSON.stringify(rows)).toBe(original);
		await drain(provider, { model: doubaoResponsesModel, history: built.history });
		expect(occurrence(requests[1], video.base64)).toBe(3);
		const tail = await buildAdapterHistory(provider, [rows[0]], {
			provider: "media-test",
			model: doubaoResponsesModel,
		});
		await drain(provider, { model: doubaoResponsesModel, history: tail.history });
		expect(occurrence(requests[2], video.base64)).toBe(1);
	});
	test("current function_call_output media follows every parallel result without leaking private fields", async () => {
		const provider = await createResponsesProvider();
		const requests = capture("responses");
		const calls = ["read-one", "read-two"];
		await drain(provider, {
			model: doubaoResponsesModel,
			history: calls.map((call_id) => ({
				type: "function_call",
				call_id,
				name: "Read",
				arguments: "{}",
			})),
			toolResults: calls.map((call_id) => ({
				type: "function_call_output",
				call_id,
				output: "Read original video",
				_nativeMedia: [video],
			})),
		});
		const input = requests[0].input as Array<{ type?: string; role?: string; content?: unknown }>;
		expect(input.map((item) => item.type ?? item.role)).toEqual([
			"function_call",
			"function_call",
			"function_call_output",
			"function_call_output",
			"user",
		]);
		expect(input.slice(2, 4)).toEqual(
			calls.map((call_id) => ({
				type: "function_call_output",
				call_id,
				output: "Read original video",
			})),
		);
		const toolMedia = input[4].content as unknown[];
		expect(toolMedia).toHaveLength(4);
		for (const [index, id] of calls.entries()) {
			expectIdentity(toolMedia[index * 2], video, "input_text", id);
			expect(toolMedia[index * 2 + 1]).toEqual({
				type: "input_video",
				video_url: `data:video/mp4;base64,${video.base64}`,
			});
		}
		expect(JSON.stringify(requests[0])).not.toContain("_nativeMedia");
	});
	test("video opt-in stays scoped to Doubao Responses or the official Ark endpoint and never enables audio or Codex", async () => {
		const provider = await createResponsesProvider();
		expect(provider.supportsNativeMediaInput(video, doubaoResponsesModel)).toBe(true);
		expect(provider.supportsNativeMediaInput(video, model)).toBe(false);
		const official = await createResponsesProvider({
			baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		});
		expect(official.supportsNativeMediaInput(video, "media-test:unknown-ark-deployment")).toBe(
			true,
		);
		const requests = capture("responses");
		await drain(official, { model: "media-test:unknown-ark-deployment", media: [video] });
		expect(occurrence(requests[0], video.base64)).toBe(1);
		requests.length = 0;
		for (const adapter of [provider, official]) {
			expect(adapter.supportsNativeMediaInput(audio, doubaoResponsesModel)).toBe(false);
			await expect(
				drain(adapter, { model: doubaoResponsesModel, media: [audio] }),
			).rejects.toThrow();
		}
		await expect(drain(provider, { model, media: [video] })).rejects.toThrow();
		const codex = await createResponsesProvider({
			apiMode: "codex",
			baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		});
		expect(codex.supportsNativeMediaInput(video, doubaoResponsesModel)).toBe(false);
		await expect(drain(codex, { model: doubaoResponsesModel, media: [video] })).rejects.toThrow();
		expect(requests).toHaveLength(0);
	});
	test("an explicit text-only metadata binding rejects Responses video and leaves a visible file fallback", async () => {
		const [{ settings }, { buildAdapterHistory }] = await Promise.all([
			import("../../settings"),
			import("../history-build"),
		]);
		const oldCatalog = settings.agent.modelCatalog;
		const oldProviders = settings.openaiProviders;
		try {
			settings.openaiProviders = [
				...(oldProviders ?? []),
				{
					id: "media-test",
					prefix: "media-test",
					name: "Mock Responses metadata",
					apiKey: "test-only-key",
					baseUrl: "https://responses.example.test/v1",
					defaultModel: "doubao-seed-2-1-lite-260915",
					apiMode: "responses",
				},
			];
			settings.agent.modelCatalog = {
				schemaVersion: 2,
				migrationVersion: 2,
				autoApply: false,
				pinnedVersion: null,
				local: {
					revision: 102,
					models: [{ id: "responses-text-only", metadata: {} }],
					bindings: [
						{
							id: "responses-text-only-binding",
							providerId: "media-test",
							upstreamModelId: "doubao-seed-2-1-lite-260915",
							modelId: "responses-text-only",
							overrides: { supported_modalities: ["text"] },
						},
					],
				},
			};
			const provider = await createResponsesProvider();
			expect(provider.supportsNativeMediaInput(video, doubaoResponsesModel)).toBe(false);
			const requests = capture("responses");
			await expect(
				drain(provider, { model: doubaoResponsesModel, media: [video] }),
			).rejects.toThrow(/does not support video/);
			expect(requests).toHaveLength(0);
			const ref = await saveMedia(
				"responses-text-only-owner",
				new File([Buffer.from(video.base64, "base64")], "clip.mp4", { type: "video/mp4" }),
			);
			const block: MediaContentBlock = { ...ref, type: "video" };
			const split = splitNativeMediaReferences([ref], doubaoResponsesModel, provider);
			expect(split.nativeRefs).toEqual([]);
			expect(split.warnings).toHaveLength(1);
			expect(split.fallbackText).toContain("当前模型未读取");
			const rows = [dbMessage("responses-text-only-user", "user", [block])];
			const built = await buildAdapterHistory(provider, rows, {
				provider: "media-test",
				model: doubaoResponsesModel,
			});
			expect(built.mediaFallbackWarnings).toHaveLength(1);
			await drain(provider, { model: doubaoResponsesModel, history: built.history });
			expect(occurrence(requests[0], video.base64)).toBe(0);
			expect(JSON.stringify(requests[0])).toContain("当前模型未读取");
			expect(rows[0].contentJson).toEqual([block]);
		} finally {
			settings.agent.modelCatalog = oldCatalog;
			settings.openaiProviders = oldProviders;
		}
	});
	test("malformed video bytes, data URLs, MIME and object-valued input_video are rejected before network", async () => {
		const provider = await createResponsesProvider();
		const requests = capture("responses");
		for (const base64 of [
			"",
			"not base64",
			"YQ=",
			"YR==",
			`data:video/mp4;base64,${video.base64}`,
		]) {
			await expect(
				drain(provider, { model: doubaoResponsesModel, media: [{ ...video, base64 }] }),
			).rejects.toThrow();
			await expect(
				drain(provider, {
					model: doubaoResponsesModel,
					toolResults: [
						{
							type: "function_call_output",
							call_id: "r",
							output: "Read",
							_nativeMedia: [{ ...video, base64 }],
						},
					],
				}),
			).rejects.toThrow();
		}
		for (const mediaType of ["video/quicktime", "video/webm", "video/mpeg", "audio/wav"]) {
			expect(provider.supportsNativeMediaInput({ ...video, mediaType }, doubaoResponsesModel)).toBe(
				false,
			);
			await expect(
				drain(provider, { model: doubaoResponsesModel, media: [{ ...video, mediaType }] }),
			).rejects.toThrow();
		}
		for (const video_url of [
			"https://example.invalid/clip.mp4",
			"data:video/mp4;base64,not base64",
			"data:video/mp4;base64,",
			`data:video/quicktime;base64,${video.base64}`,
			`data:video/webm;base64,${video.base64}`,
			`data:audio/wav;base64,${video.base64}`,
			{ url: `data:video/mp4;base64,${video.base64}` },
		])
			await expect(
				drain(provider, {
					model: doubaoResponsesModel,
					history: [{ role: "user", content: [{ type: "input_video", video_url }] }],
				}),
			).rejects.toThrow();
		expect(requests).toHaveLength(0);
	});
});

const baseUrl = "https://gemini.example.test/v1beta";
const resource = { name: "files/media-file", uri: `${baseUrl}/files/media-file`, state: "ACTIVE" };
function mediaBody(data = audio.base64): Record<string, unknown> {
	return { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data } }] }] };
}

describe("Gemini Files API native media", () => {
	test("resumable upload sends real bytes, waits for ACTIVE, and caches only within an instance", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const files = new GeminiMediaFiles({
			baseUrl,
			apiKey: "key-isolated",
			inlineLimitBytes: 1,
			pollIntervalMs: 1,
			fetch: async (input, init) => {
				requests.push({ url: String(input), init });
				if (requests.length === 1)
					return new Response(null, {
						headers: { "x-goog-upload-url": `${baseUrl}/upload-session?token=opaque` },
					});
				if (requests.length === 2)
					return Response.json({ file: { ...resource, state: "PROCESSING" } });
				return Response.json(resource);
			},
		});
		const original = mediaBody();
		const prepared = await files.prepare(original, "generate");
		expect(requests.map((r) => r.url)).toEqual([
			"https://gemini.example.test/upload/v1beta/files",
			`${baseUrl}/upload-session?token=opaque`,
			resource.uri,
		]);
		expect(Buffer.from(requests[1].init?.body as Uint8Array)).toEqual(wav);
		expect(new Headers(requests[0].init?.headers).get("x-goog-api-key")).toBe("key-isolated");
		expect(new Headers(requests[1].init?.headers).get("x-goog-api-key")).toBeNull();
		expect(requests.every((request) => request.init?.redirect === "error")).toBe(true);
		expect(JSON.stringify(prepared)).toContain(
			`"fileData":{"mimeType":"audio/wav","fileUri":"${resource.uri}"}`,
		);
		expect(occurrence(original, audio.base64)).toBe(1);
		await files.prepare(original, "generate");
		expect(requests).toHaveLength(3);
	});
	test("the 33rd Files resource evicts the oldest cache entry without sharing instance state", async () => {
		const uploaded: Buffer[] = [];
		let starts = 0;
		const options = {
			baseUrl,
			apiKey: "cache-isolated",
			inlineLimitBytes: 1,
			fetch: async (_input: string | URL | Request, init?: RequestInit) => {
				if (new Headers(init?.headers).get("X-Goog-Upload-Command") === "start") {
					starts++;
					return new Response(null, {
						headers: { "x-goog-upload-url": `${baseUrl}/upload-session-${starts}` },
					});
				}
				uploaded.push(Buffer.from(init?.body as Uint8Array));
				return Response.json({ file: resource });
			},
		};
		const files = new GeminiMediaFiles(options);
		const bytes = Array.from({ length: 33 }, (_, index) =>
			Buffer.concat([wav, Buffer.from([index])]),
		);
		const bodies = bytes.map((data) => mediaBody(data.toString("base64")));
		for (const body of bodies.slice(0, 32)) await files.prepare(body, "generate");
		expect(starts).toBe(32);
		expect(uploaded).toEqual(bytes.slice(0, 32));
		// Replaying all 32 entries must hit the cache, including the oldest entry.
		for (const body of bodies.slice(0, 32)) await files.prepare(body, "generate");
		expect(starts).toBe(32);
		await files.prepare(bodies[32], "generate");
		expect(starts).toBe(33);
		expect(uploaded[32]).toEqual(bytes[32]);
		// The other 31 original entries and the newly inserted one remain cached.
		for (const body of bodies.slice(1)) await files.prepare(body, "generate");
		expect(starts).toBe(33);
		await files.prepare(bodies[0], "generate");
		expect(starts).toBe(34);
		expect(uploaded[33]).toEqual(bytes[0]);
		// A second provider instance cannot reuse even an identical cached resource.
		await new GeminiMediaFiles(options).prepare(bodies[0], "generate");
		expect(starts).toBe(35);
		expect(uploaded[34]).toEqual(bytes[0]);
		await files.prepare(bodies[0], "generate");
		expect(starts).toBe(35);
	});
	test("Interactions large resources use uri and mime_type, not GenerateContent fileData", async () => {
		let calls = 0;
		const files = new GeminiMediaFiles({
			baseUrl,
			apiKey: "test",
			inlineLimitBytes: 1,
			fetch: async () =>
				++calls === 1
					? new Response(null, { headers: { "x-goog-upload-url": `${baseUrl}/upload` } })
					: Response.json({ file: resource }),
		});
		const body = await files.prepare(
			{
				input: [
					{
						type: "user_input",
						content: [{ type: "video", mime_type: "video/mp4", data: video.base64 }],
					},
				],
			},
			"interactions",
		);
		expect(JSON.stringify(body)).toContain(`"uri":"${resource.uri}"`);
		expect(JSON.stringify(body)).not.toContain("fileData");
		expect(JSON.stringify(body)).not.toContain(video.base64);
	});
	test("100MiB native media is uploaded rather than dropped or forced through inline request guards", async () => {
		const bytes = Buffer.alloc(100 * 1024 * 1024, 49);
		let calls = 0;
		let uploadedBytes = 0;
		const files = new GeminiMediaFiles({
			baseUrl,
			apiKey: "test",
			fetch: async (_input, init) => {
				calls++;
				if (calls === 1)
					return new Response(null, { headers: { "x-goog-upload-url": `${baseUrl}/upload` } });
				uploadedBytes = (init?.body as Uint8Array).byteLength;
				return Response.json({ file: resource });
			},
		});
		const body = await files.prepare(mediaBody(bytes.toString("base64")), "generate");
		expect(uploadedBytes).toBe(100 * 1024 * 1024);
		expect(JSON.stringify(body).length).toBeLessThan(1024);
	}, 20_000);
	test("both native providers upload oversized bytes and then generate using Files resources", async () => {
		const data = Buffer.alloc(40 * 1024 * 1024, 49).toString("base64");
		for (const { kind, provider } of createProviders().filter((item) => item.kind !== "chat")) {
			let uploadedBytes = 0;
			let generated: Record<string, unknown> | undefined;
			let calls = 0;
			setFetch(async (input, init) => {
				calls++;
				if (String(input).includes("/upload/v1beta/files"))
					return new Response(null, {
						headers: { "x-goog-upload-url": `${baseUrl}/upload-session` },
					});
				if (String(input).endsWith("/upload-session")) {
					uploadedBytes = (init?.body as Uint8Array).byteLength;
					return Response.json({ file: resource });
				}
				generated = JSON.parse(String(init?.body));
				return done(kind);
			});
			await drain(provider, { media: [{ ...audio, base64: data }] });
			expect(uploadedBytes).toBe(40 * 1024 * 1024);
			expect(calls).toBe(3);
			expect(JSON.stringify(generated)).toContain(resource.uri);
			expect(JSON.stringify(generated).length).toBeLessThan(1024);
		}
	}, 20_000);
	test("cross-host upload destinations never receive media or credentials", async () => {
		let calls = 0;
		const files = new GeminiMediaFiles({
			baseUrl,
			apiKey: "never-leak",
			inlineLimitBytes: 1,
			fetch: async () => {
				calls++;
				return new Response(null, {
					headers: { "x-goog-upload-url": "https://attacker.invalid/upload" },
				});
			},
		});
		await expect(files.prepare(mediaBody(), "generate")).rejects.toThrow(/cross-origin/);
		expect(calls).toBe(1);
	});
	test("upload HTTP failure and processing failure abort without generating", async () => {
		for (const failAt of [1, 2, 3]) {
			let calls = 0;
			const files = new GeminiMediaFiles({
				baseUrl,
				apiKey: "test",
				inlineLimitBytes: 1,
				pollIntervalMs: 1,
				fetch: async () => {
					calls++;
					if (calls === failAt)
						return failAt === 3
							? Response.json({ ...resource, state: "FAILED" })
							: new Response("secret upstream error", { status: 403 });
					if (calls === 1)
						return new Response(null, { headers: { "x-goog-upload-url": `${baseUrl}/upload` } });
					return Response.json({ file: { ...resource, state: "PROCESSING" } });
				},
			});
			await expect(files.prepare(mediaBody(), "generate")).rejects.toThrow(/failed/i);
			expect(calls).toBe(failAt);
		}
	});
	test("upload and processing metadata are byte-bounded and cancel oversized streams", async () => {
		for (const overflowAt of [2, 3]) {
			let calls = 0;
			let cancelled = false;
			const files = new GeminiMediaFiles({
				baseUrl,
				apiKey: "test",
				inlineLimitBytes: 1,
				pollIntervalMs: 1,
				fetch: async () => {
					if (++calls === 1)
						return new Response(null, { headers: { "x-goog-upload-url": `${baseUrl}/upload` } });
					if (calls === overflowAt)
						return new Response(
							new ReadableStream({
								start(controller) {
									controller.enqueue(new Uint8Array(GEMINI_FILES_METADATA_MAX_BYTES + 1));
								},
								cancel() {
									cancelled = true;
								},
							}),
						);
					return Response.json({ file: { ...resource, state: "PROCESSING" } });
				},
			});
			await expect(files.prepare(mediaBody(), "generate")).rejects.toThrow(/metadata.*limit/);
			expect(cancelled).toBe(true);
			expect(calls).toBe(overflowAt);
		}
	});
	test("processing wait observes cancellation and finite timeout", async () => {
		for (const cancel of [true, false]) {
			let calls = 0;
			const controller = new AbortController();
			const files = new GeminiMediaFiles({
				baseUrl,
				apiKey: "test",
				inlineLimitBytes: 1,
				processingTimeoutMs: 30,
				pollIntervalMs: 5,
				fetch: async () => {
					if (++calls === 1)
						return new Response(null, { headers: { "x-goog-upload-url": `${baseUrl}/upload` } });
					if (cancel) controller.abort(new Error("cancel media upload"));
					return calls === 2
						? Response.json({ file: { ...resource, state: "PROCESSING" } })
						: Response.json({ ...resource, state: "PROCESSING" });
				},
			});
			await expect(files.prepare(mediaBody(), "generate", controller.signal)).rejects.toThrow(
				cancel ? /cancel media upload/ : /time(?:d)?\s*out/i,
			);
		}
	});
	test("small media stays inline and an aborted request never uploads", async () => {
		let calls = 0;
		const files = new GeminiMediaFiles({
			baseUrl,
			apiKey: "test",
			fetch: async () => {
				calls++;
				throw new Error("unexpected upload");
			},
		});
		const body = mediaBody();
		expect(await files.prepare(body, "generate")).toBe(body);
		const controller = new AbortController();
		controller.abort();
		await expect(files.prepare(body, "generate", controller.signal)).rejects.toThrow();
		expect(calls).toBe(0);
	});
});
