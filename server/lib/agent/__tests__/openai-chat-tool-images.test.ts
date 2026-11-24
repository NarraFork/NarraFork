import { describe, expect, test } from "bun:test";
import { normalizeToolResultImagesMode } from "@shared/tool-result-images";
import { completionsWireHistory, expandChatToolResults, type OAIMessage } from "../openai-provider";
import type { NeutralToolResults } from "../projection/turns";

const PNG = { format: "png", mediaType: "image/png", base64: "aGVsbG8=" };
const JPG = { format: "jpeg", mediaType: "image/jpeg", base64: "d29ybGQ=" };

function toolTurn(
	results: Array<{ wireId: string; text: string; images?: Array<typeof PNG> }>,
): NeutralToolResults {
	return {
		kind: "tool_results",
		envelopeId: "env-1",
		results: results.map((result) => ({
			wireId: result.wireId,
			name: "Read",
			isError: false,
			text: result.text,
			images: result.images ?? [],
		})),
	};
}

function project(mode: "off" | "inline" | "separate", turn: NeutralToolResults) {
	return completionsWireHistory([turn], { strict: true, toolResultImages: mode });
}

function contentText(message: OAIMessage | undefined): string | undefined {
	if (!message) return undefined;
	if (typeof message.content === "string") return message.content;
	const text = (message.content ?? [])
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n");
	return text || undefined;
}

function imageUrls(message: OAIMessage | undefined): string[] {
	if (!message || typeof message.content === "string") return [];
	return (message.content ?? []).flatMap((part) =>
		part.type === "image_url" ? [part.image_url.url] : [],
	);
}

describe("历史投影里的工具图片", () => {
	test("unconfigured tool result images default to off", () => {
		expect(normalizeToolResultImagesMode(undefined)).toBe("off");
		expect(normalizeToolResultImagesMode("invalid")).toBe("off");
	});
	test("off 保持现状：工具消息只有文本，图片不出现", () => {
		const history = project(
			"off",
			toolTurn([{ wireId: "call_1", text: "read ok", images: [PNG] }]),
		);

		expect(history).toHaveLength(1);
		expect(history[0]?.role).toBe("tool");
		expect(history[0]?.content).toBe("read ok");
		expect(history.some((message) => message.role === "user")).toBe(false);
	});

	test("inline 把图片并进同一条工具消息（DeepSeek 扩展）", () => {
		const history = project(
			"inline",
			toolTurn([{ wireId: "call_1", text: "read ok", images: [PNG, JPG] }]),
		);

		expect(history).toHaveLength(1);
		expect(history[0]?.role).toBe("tool");
		expect(history[0]?.tool_call_id).toBe("call_1");
		expect(contentText(history[0])).toBe("read ok");
		expect(imageUrls(history[0])).toEqual([
			"data:image/png;base64,aGVsbG8=",
			"data:image/jpeg;base64,d29ybGQ=",
		]);
	});

	test("separate 让工具消息保持文本，图片单独成条并带归属", () => {
		const history = project(
			"separate",
			toolTurn([
				{ wireId: "call_1", text: "first", images: [PNG] },
				{ wireId: "call_2", text: "second", images: [JPG] },
			]),
		);

		expect(history.map((message) => message.role)).toEqual(["tool", "tool", "user"]);
		expect(history[0]?.content).toBe("first");
		expect(history[1]?.content).toBe("second");
		expect(contentText(history[2])).toContain('"toolCallId":"call_1"');
		expect(contentText(history[2])).toContain('"toolCallId":"call_2"');
		expect(imageUrls(history[2])).toEqual([
			"data:image/png;base64,aGVsbG8=",
			"data:image/jpeg;base64,d29ybGQ=",
		]);
	});

	test("separate 单条结果不需要归属说明", () => {
		const history = project(
			"separate",
			toolTurn([{ wireId: "call_1", text: "only", images: [PNG] }]),
		);

		expect(history.map((message) => message.role)).toEqual(["tool", "user"]);
		expect(contentText(history[1])).toBeUndefined();
		expect(imageUrls(history[1])).toEqual(["data:image/png;base64,aGVsbG8="]);
	});

	test("没有图片时三种模式输出完全相同", () => {
		const turn = toolTurn([{ wireId: "call_1", text: "no images" }]);
		expect(project("inline", turn)).toEqual(project("off", turn));
		expect(project("separate", turn)).toEqual(project("off", turn));
	});

	test("空文本的工具结果不会产生空的 text 块", () => {
		const history = project("inline", toolTurn([{ wireId: "call_1", text: "", images: [PNG] }]));

		expect(history[0]?.content).toEqual([
			{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
		]);
	});
});

describe("当前轮工具结果的图片", () => {
	function result(wireId: string, text: string, images?: Array<typeof PNG>) {
		return {
			tool_call_id: wireId,
			content: text,
			...(images?.length ? { _images: images } : {}),
		};
	}

	test("off 只发文本", () => {
		const messages = expandChatToolResults([result("call_1", "read ok", [PNG])], "off");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toBe("read ok");
	});

	test("inline 内嵌到工具消息", () => {
		const messages = expandChatToolResults([result("call_1", "read ok", [PNG])], "inline");
		expect(messages).toHaveLength(1);
		expect(imageUrls(messages[0])).toEqual(["data:image/png;base64,aGVsbG8="]);
	});

	test("separate 追加独立图片消息", () => {
		const messages = expandChatToolResults([result("call_1", "read ok", [PNG])], "separate");
		expect(messages.map((message) => message.role)).toEqual(["tool", "user"]);
		expect(imageUrls(messages[1])).toEqual(["data:image/png;base64,aGVsbG8="]);
	});

	test("separate groups parallel tool images into one attributed user message", () => {
		const messages = expandChatToolResults(
			[result("call_1", "first", [PNG]), result("call_2", "second", [JPG])],
			"separate",
		);
		expect(messages.map((message) => message.role)).toEqual(["tool", "tool", "user"]);
		expect(messages.slice(0, 2).map((message) => message.content)).toEqual(["first", "second"]);
		expect(contentText(messages[2])).toContain('"toolCallId":"call_1"');
		expect(contentText(messages[2])).toContain('"toolCallId":"call_2"');
		expect(imageUrls(messages[2])).toEqual([
			"data:image/png;base64,aGVsbG8=",
			"data:image/jpeg;base64,d29ybGQ=",
		]);
	});

	test("音频/视频仍然走独立的 user 消息，不受开关影响", () => {
		const audio = { type: "audio" as const, mediaType: "audio/wav", base64: "UklGRg==" };
		const withMedia = { tool_call_id: "call_1", content: "ok", _nativeMedia: [audio] };
		for (const mode of ["off", "inline", "separate"] as const) {
			const messages = expandChatToolResults([withMedia], mode);
			expect(messages.map((message) => message.role)).toEqual(["tool", "user"]);
			expect(messages[1]?.content).toContainEqual({
				type: "input_audio",
				input_audio: { data: "UklGRg==", format: "wav" },
			});
		}
	});

	test("separate keeps native media and parallel images in the same trailing user message", () => {
		const audio = { type: "audio" as const, mediaType: "audio/wav", base64: "UklGRg==" };
		const turn = toolTurn([
			{ wireId: "call_1", text: "first", images: [PNG] },
			{ wireId: "call_2", text: "second", images: [JPG] },
		]);
		const first = turn.results[0];
		if (!first) throw new Error("Missing first tool result");
		first.media = [audio];
		const current = expandChatToolResults(
			[
				{ ...result("call_1", "first", [PNG]), _nativeMedia: [audio] },
				result("call_2", "second", [JPG]),
			],
			"separate",
		);
		const history = project("separate", turn);
		expect(current).toEqual(history);
		expect(current.map((message) => message.role)).toEqual(["tool", "tool", "user"]);
		expect(imageUrls(current[2])).toHaveLength(2);
		expect(current[2]?.content).toContainEqual({
			type: "input_audio",
			input_audio: { data: "UklGRg==", format: "wav" },
		});
	});
});
