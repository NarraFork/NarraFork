import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { outputToText } from "@shared/agent-protocol/tool-output";
import {
	type MediaContentBlock,
	type MediaRef,
	mediaRefToContentBlock,
	type NativeMediaFallbackWarning,
	type NativeMediaInput,
} from "@shared/media-attachments";
import { z } from "zod/v4";
import { AppError } from "../../errors";
import {
	deleteUploadedMedia,
	getMediaPath,
	mediaToBase64,
	saveUploadedMedia,
} from "../../media-uploads";
import { resolveNativeMediaBlocks, toolMediaBlocks } from "../native-media";
import type { ChatParams, DbMessage, ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent, AgentLoopHistory } from "../types";

function wav(): Uint8Array<ArrayBuffer> {
	const bytes = Buffer.alloc(46);
	bytes.write("RIFF", 0);
	bytes.writeUInt32LE(38, 4);
	bytes.write("WAVEfmt ", 8);
	bytes.writeUInt32LE(16, 16);
	bytes.writeUInt16LE(1, 20);
	bytes.writeUInt16LE(1, 22);
	bytes.writeUInt32LE(8000, 24);
	bytes.writeUInt32LE(16000, 28);
	bytes.writeUInt16LE(2, 32);
	bytes.writeUInt16LE(16, 34);
	bytes.write("data", 36);
	bytes.writeUInt32LE(2, 40);
	bytes.writeInt16LE(1234, 44);
	return new Uint8Array(bytes);
}
const audio: NativeMediaInput = {
	type: "audio",
	mediaType: "audio/wav",
	base64: Buffer.from(wav()).toString("base64"),
	filename: "recording.wav",
};
const video: NativeMediaInput = {
	type: "video",
	mediaType: "video/mp4",
	base64: "AAAAEGZ0eXBpc29tAAAAAA==",
	filename: "clip.mp4",
};
const missingRef: MediaContentBlock = {
	type: "audio",
	mediaId: "missing-probe",
	mediaType: "audio/wav",
	filename: "recording.wav",
	size: 46,
	uploadNarratorId: "media-loop-owner",
};
interface ProjectedResult {
	toolUseId: string;
	output: string;
	media: NativeMediaInput[];
}
interface ProjectedRow {
	role: string;
	text: string;
	media: NativeMediaInput[];
	results: ProjectedResult[];
}
let calls: ChatParams[] = [];
let projectedRows: DbMessage[][] = [];
let useTool = true;
let supportsAudio = true;
let supportsVideo = true;
let probeRef = missingRef;
let probeName = "NativeMediaProbe";
let probeCount = 1;
let afterProbe: (() => void) | undefined;
let switchTarget: string | undefined;
let pendingModel: string | undefined;
let initialModel = "test:native-media";
let warnings: NativeMediaFallbackWarning[] = [];
let wireHistoryBuilder: ProviderAdapter["buildHistory"] | undefined;
const savedAssets: MediaRef[] = [];

// The fake adapter only serializes the already-projected rows. Capability fallback
// must happen in the real buildAdapterHistory pipeline, not in this test transport.
const adapter: ProviderAdapter & {
	formatToolResult: () => never;
	pushUserTurn: () => never;
	pushAssistantTurn: () => never;
} = {
	supportsNativeMediaInput: (item, model) =>
		!model.endsWith("unsupported") && (item.type === "audio" ? supportsAudio : supportsVideo),
	formatTools: (tools) => tools,
	buildHistory: async (rows, _model, narratorId) => {
		projectedRows.push(rows);
		if (wireHistoryBuilder) return wireHistoryBuilder(rows, _model, narratorId);
		const history: ProjectedRow[] = [];
		for (const row of rows) {
			const blocks = Array.isArray(row.contentJson) ? row.contentJson : [];
			const results: ProjectedResult[] = [];
			for (const call of row.toolCalls ?? []) {
				if (call.status !== "success" && call.status !== "fail") continue;
				results.push({
					toolUseId: call.toolUseId,
					output: outputToText(call.outputJson),
					media: await resolveNativeMediaBlocks(
						toolMediaBlocks(call.outputJson),
						row.narratorId ?? narratorId,
					),
				});
			}
			const native = await resolveNativeMediaBlocks(blocks, row.narratorId ?? narratorId);
			for (const block of blocks) {
				if (block && typeof block === "object" && "mediaId" in block)
					savedAssets.push(block as MediaRef);
			}
			history.push({
				role: row.role,
				text: blocks
					.map((block) =>
						typeof block === "object" && block && "text" in block ? String(block.text) : "",
					)
					.filter(Boolean)
					.join("\n"),
				media: native,
				results,
			});
		}
		return { history, trailingToolResults: [] };
	},
	injectSystemPrompt: () => {},
	async *chat(params) {
		calls.push(params);
		params.onRequestStart?.();
		if (calls.length === 1 && switchTarget) {
			pendingModel = switchTarget;
			throw new Error("429 rate limit: retry with the newly selected model");
		}
		if (calls.length === 1 && useTool)
			yield {
				toolUses: Array.from({ length: probeCount }, (_, index) => ({
					toolUseId: index ? `native-probe-${index}` : "native-probe",
					name: probeName,
					input: {},
				})),
			};
		else yield { text: "complete" };
	},
	formatToolResult: () => {
		throw new Error(
			"The native main loop must project transcript rows, not restore the old formatToolResult path",
		);
	},
	pushUserTurn: () => {
		throw new Error("The native main loop must not restore pushUserTurn");
	},
	pushAssistantTurn: () => {
		throw new Error("The native main loop must not restore pushAssistantTurn");
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const realProvider = { ...(await import("../provider")) };
mock.module("../provider", () => ({
	getProvider: () => adapter,
	resolveProviderAndModel: (model: string) => ({
		requestedProvider: "test",
		requestedModel: model,
		provider: "test",
		adapter,
		model,
	}),
}));
const { agentLoop } = await import("../loop");
const probe = {
	name: "NativeMediaProbe",
	description: "Return durable native media without embedding bytes in events",
	parameters: z.object({}),
	execute: async () => {
		afterProbe?.();
		return {
			output: "audio read",
			media: [audio],
			mediaRefs: [probeRef],
			metadata: { mediaProbe: true },
		};
	},
};
toolRegistry.register(probe);
beforeEach(() => {
	calls = [];
	projectedRows = [];
	useTool = true;
	supportsAudio = true;
	supportsVideo = true;
	probeRef = missingRef;
	probeName = "NativeMediaProbe";
	probeCount = 1;
	afterProbe = undefined;
	switchTarget = undefined;
	pendingModel = undefined;
	initialModel = "test:native-media";
	warnings = [];
	wireHistoryBuilder = undefined;
});
afterEach(() => {
	for (const ref of savedAssets.splice(0))
		deleteUploadedMedia(ref.uploadNarratorId ?? "media-loop-owner", ref.mediaId);
	for (const warning of warnings) deleteUploadedMedia(warning.uploadNarratorId, warning.mediaId);
});
afterAll(() => {
	mock.module("../provider", () => realProvider);
	toolRegistry.unregister("NativeMediaProbe");
	mock.restore();
});

async function run(
	media: readonly (MediaRef | NativeMediaInput)[],
	options: {
		guidanceSignal?: AbortSignal;
		hostBuilt?: boolean;
		history?: AgentLoopHistory;
		config?: Partial<AgentConfig>;
	} = {},
) {
	const events: AgentEvent[] = [];
	const config: AgentConfig = {
		narratorId: "media-loop-owner",
		conversationId: "media-loop",
		provider: "test",
		model: initialModel,
		getModelOverride: () => pendingModel ?? null,
		cwd: process.cwd(),
		signal: new AbortController().signal,
		guidanceSignal: options.guidanceSignal,
		permissionHandler: async () => ({ behavior: "allow" }),
		onEvent: (event) => {
			if (event.type === "media_fallback") warnings.push(...event.warnings);
			events.push(event);
		},
		...options.config,
	};
	for await (const event of agentLoop(
		config,
		"",
		options.history ?? { rows: [], ...(options.hostBuilt ? { built: [] } : {}) },
		undefined,
		media,
	))
		events.push(event);
	expect(events.filter((event) => event.type === "error")).toEqual([]);
	return events;
}
function rows(call: ChatParams | undefined): ProjectedRow[] {
	return (call?.history ?? []) as ProjectedRow[];
}
function native(call: ChatParams | undefined): NativeMediaInput[] {
	return [
		...(call?.media ?? []),
		...rows(call).flatMap((row) => [
			...row.media,
			...row.results.flatMap((result) => result.media),
		]),
	];
}
function results(call: ChatParams | undefined): ProjectedResult[] {
	return rows(call).flatMap((row) => row.results);
}
function text(call: ChatParams | undefined): string {
	return [
		call?.content ?? "",
		...rows(call).map((row) => row.text),
		...results(call).map((result) => result.output),
	]
		.filter(Boolean)
		.join("\n");
}
function mediaPath(ref: Pick<MediaRef, "mediaId" | "uploadNarratorId">): string {
	const path = getMediaPath(ref.uploadNarratorId ?? "media-loop-owner", ref.mediaId);
	if (!path) throw new Error(`Missing fixture asset: ${ref.mediaId}`);
	return path;
}
function firstWarning(): NativeMediaFallbackWarning {
	const warning = warnings[0];
	if (!warning) throw new Error("Expected media fallback warning");
	return warning;
}
async function durableProbe() {
	const saved = await saveUploadedMedia(
		"media-loop-owner",
		new File([wav()], "recording.wav", { type: "audio/wav" }),
	);
	savedAssets.push(saved);
	probeRef = mediaRefToContentBlock(saved);
	return mediaPath(saved);
}

describe("native media survives the public main transcript loop", () => {
	test("attachment-only input and tool continuation retain original bytes while events retain only refs", async () => {
		await durableProbe();
		const events = await run([audio, video]);
		expect(calls).toHaveLength(2);
		expect(native(calls[0])).toEqual([audio, video]);
		expect(native(calls[1])).toEqual([audio, video, audio]);
		expect(calls.every((call) => call.toolResults.length === 0)).toBe(true);
		expect(results(calls[1])).toContainEqual(expect.objectContaining({ media: [audio] }));
		const event = events.find((item) => item.type === "tool_result");
		expect(event).toMatchObject({
			mediaRefs: [probeRef],
			output: expect.stringContaining("audio read"),
			metadata: expect.objectContaining({ mediaProbe: true }),
		});
		expect(JSON.stringify(event)).not.toContain(audio.base64);
	});

	test("a pure-media transcript input survives canonical visibility and reaches the real Gemini wire builder", async () => {
		useTool = false;
		await durableProbe();
		const { GeminiProvider } = await import("../gemini-provider");
		const real = new GeminiProvider({
			id: "media-wire",
			name: "Media wire",
			prefix: "media-wire",
			apiKey: "unused",
			baseUrl: "https://example.invalid/v1beta",
			defaultModel: "unknown-native-model",
		});
		wireHistoryBuilder = real.buildHistory.bind(real);
		await run([probeRef]);
		expect(calls).toHaveLength(1);
		const request = JSON.stringify(calls[0]?.history);
		expect(request).toContain('"mimeType":"audio/wav"');
		expect(request).toContain(`"data":"${audio.base64}"`);
		expect(request).not.toContain("filePath");
		expect(calls[0]?.content).toBe("");
		expect(calls[0]?.media).toBeUndefined();
	});

	test("host-built current input uses the native current lane without duplicating rows", async () => {
		useTool = false;
		await run([video], { hostBuilt: true });
		expect(calls[0]?.media).toEqual([video]);
		expect(calls[0]?.history).toEqual([]);
	});

	test("unsupported tool media is a real ordinary file only in the request projection", async () => {
		supportsAudio = false;
		const filePath = await durableProbe();
		const events = await run([]);
		expect(calls).toHaveLength(2);
		expect(native(calls[1])).toEqual([]);
		expect(text(calls[1])).toContain(JSON.stringify(filePath));
		expect(text(calls[1])).not.toContain(audio.base64);
		expect(events.find((event) => event.type === "tool_result")).toMatchObject({
			output: "audio read",
			mediaRefs: [probeRef],
			metadata: expect.objectContaining({ mediaProbe: true }),
		});
		expect(warnings).toEqual([
			expect.objectContaining({ model: "test:native-media", mediaId: probeRef.mediaId }),
		]);
		expect(new Uint8Array(readFileSync(filePath))).toEqual(wav());
		expect(await mediaToBase64(probeRef)).toEqual(audio);
		supportsAudio = true;
		calls = [];
		await run([]);
		expect(results(calls[1])).toContainEqual(expect.objectContaining({ media: [audio] }));
	});

	test("parallel-safe media results use the same transcript projection", async () => {
		supportsAudio = false;
		const filePath = await durableProbe();
		const previous = toolRegistry.get("Read");
		toolRegistry.register({ ...probe, name: "Read" });
		probeName = "Read";
		probeCount = 2;
		try {
			const events = await run([]);
			expect(results(calls[1])).toHaveLength(2);
			for (const result of results(calls[1]))
				expect(result).toMatchObject({
					output: expect.stringContaining(JSON.stringify(filePath)),
					media: [],
				});
			expect(events.filter((event) => event.type === "tool_result")).toHaveLength(2);
		} finally {
			if (previous) toolRegistry.register(previous);
			else toolRegistry.unregister("Read");
		}
	});

	test("guidance keeps the actual completed tool refs without inventing another request", async () => {
		await durableProbe();
		supportsAudio = false;
		const controller = new AbortController();
		afterProbe = () => controller.abort();
		const events = await run([], { guidanceSignal: controller.signal });
		expect(calls).toHaveLength(1);
		expect(events.find((event) => event.type === "tool_result")).toMatchObject({
			output: "audio read",
			mediaRefs: [probeRef],
		});
	});

	test("missing tool assets fail rather than producing invented file paths", async () => {
		supportsAudio = false;
		await expect(run([])).rejects.toThrow(/Media asset is missing/);
		expect(calls).toHaveLength(1);
	});

	test.each([
		false,
		true,
	])("bytes-only input is persisted as a real fallback file (hostBuilt=%s)", async (hostBuilt) => {
		useTool = false;
		supportsAudio = false;
		await run([audio], { hostBuilt });
		expect(native(calls[0])).toEqual([]);
		const filePath = mediaPath(firstWarning());
		expect(text(calls[0])).toContain(JSON.stringify(filePath));
		expect(text(calls[0])).not.toContain(audio.base64);
		expect(new Uint8Array(readFileSync(filePath))).toEqual(wav());
	});

	test.each([
		false,
		true,
	])("mixed input only downgrades unsupported modalities (hostBuilt=%s)", async (hostBuilt) => {
		useTool = false;
		supportsAudio = false;
		await run([audio, video], { hostBuilt });
		expect(native(calls[0])).toEqual([video]);
		expect(text(calls[0])).toContain(JSON.stringify(mediaPath(firstWarning())));
	});

	for (const [label, input, pattern] of [
		["invalid base64", { ...audio, base64: "invalid" }, /valid base64/],
		[
			"corrupt bytes",
			{ ...audio, base64: Buffer.from("not a WAV file").toString("base64") },
			/does not match/,
		],
		["mismatched MIME", { ...audio, type: "video" as const }, /MIME type do not match/],
	] as const)
		test(`${label} remains a hard error instead of being disguised as unsupported media`, async () => {
			useTool = false;
			supportsAudio = false;
			await expect(run([input])).rejects.toThrow(pattern);
			expect(calls).toEqual([]);
			expect(warnings).toEqual([]);
		});

	test.each([
		["test:native-media", "test:unsupported", false],
		["test:unsupported", "test:native-media", false],
		["test:native-media", "test:unsupported", true],
		["test:unsupported", "test:native-media", true],
	] as const)("retry rebuilds original current media on %s → %s (hostBuilt=%s)", async (from, to, hostBuilt) => {
		useTool = false;
		initialModel = from;
		switchTarget = to;
		const events = await run([audio], { hostBuilt });
		expect(calls).toHaveLength(2);
		expect(calls[0]?.model).toBe(from);
		expect(calls[1]?.model).toBe(to);
		const supportedCall = to.endsWith("unsupported") ? calls[0] : calls[1];
		const unsupportedCall = to.endsWith("unsupported") ? calls[1] : calls[0];
		expect(native(supportedCall)).toEqual([audio]);
		expect(text(supportedCall)).toBe("");
		expect(native(unsupportedCall)).toEqual([]);
		expect(text(unsupportedCall)).toContain(JSON.stringify(mediaPath(firstWarning())));
		expect(text(unsupportedCall).split("当前模型不支持读取该模态数据")).toHaveLength(2);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "model_switched", model: to, cause: "retry" }),
		);
	});

	test("history replacement forwards its media warnings while preserving host history ownership", async () => {
		useTool = false;
		switchTarget = "test:unsupported";
		await durableProbe();
		const warning: NativeMediaFallbackWarning = {
			model: "test:unsupported",
			filename: probeRef.filename,
			mediaType: probeRef.mediaType,
			type: "audio",
			mediaId: probeRef.mediaId,
			uploadNarratorId: "media-loop-owner",
		};
		await run([], {
			config: {
				onBeforeTurn: async () => ({ history: [], rows: [], mediaFallbackWarnings: [warning] }),
			},
		});
		expect(warnings).toEqual([warning]);
	});

	test("pre-aborted guidance does not activate byte IO or a provider request", async () => {
		const controller = new AbortController();
		controller.abort();
		await run([audio], { guidanceSignal: controller.signal });
		expect(calls).toEqual([]);
		expect(projectedRows).toEqual([]);
		expect(warnings).toEqual([]);
	});
});

describe("runtime model-switch request preparation", () => {
	test.each([
		new AppError("Conversation identity changed", 409),
		new Error("Identity storage unavailable"),
	])("propagates preflight failure without dispatching the prepared first attempt: %s", async (failure) => {
		useTool = false;
		let preparations = 0;
		await expect(
			run([], {
				hostBuilt: true,
				config: {
					getRuntimeSettingsOverride: async () => ({ model: "test:changed" }),
					onBeforeTurn: async (_turn, options) => {
						expect(options).toEqual({ force: true, cause: "model_switch" });
						preparations++;
						throw failure;
					},
				},
			}),
		).rejects.toBe(failure);
		expect(preparations).toBe(1);
		expect(calls).toHaveLength(0);
	});
});

describe("provider request admission without prefix hooks", () => {
	test("awaits admission again for each tool turn", async () => {
		await durableProbe();
		let admissions = 0;
		await run([], {
			config: {
				beforeProviderRequest: async () => {
					expect(calls).toHaveLength(admissions);
					admissions++;
				},
			},
		});
		expect(calls).toHaveLength(2);
		expect(admissions).toBe(2);
	});

	test("propagates admission failure before any provider dispatch", async () => {
		const failure = new AppError("Conversation identity changed", 409);
		await expect(
			run([], {
				config: {
					beforeProviderRequest: async () => {
						throw failure;
					},
				},
			}),
		).rejects.toBe(failure);
		expect(calls).toHaveLength(0);
	});
});
