/**
 * A loop's transcript holds the rows the host would have stored, and its requests are
 * the same projection a rebuild runs (loop-transcript.ts, history-build.ts).
 */

import { describe, expect, test } from "bun:test";
import type { MediaContentBlock } from "@shared/media-attachments";
import { AnthropicProvider } from "../anthropic-provider";
import { buildAdapterHistory, historyTail } from "../history-build";
import { LoopTranscript } from "../loop-transcript";
import { projectHistory } from "../projection";

const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const TARGET = { strict: false };

function toolStep(transcript: LoopTranscript, ids: string[]) {
	transcript.appendStep([
		{ type: "text", text: "Checking." },
		...ids.map((id) => ({
			type: "tool_use" as const,
			toolUseId: id,
			name: "Read",
			input: { file_path: `${id}.txt` },
		})),
	]);
}

describe("loop transcript", () => {
	const media: MediaContentBlock = {
		type: "audio",
		mediaId: "durable-audio",
		filename: "recording.wav",
		mediaType: "audio/wav",
		size: 46,
		uploadNarratorId: "original-owner",
	};

	test("media-only input keeps durable original refs without storing provider bytes", () => {
		const transcript = new LoopTranscript();
		const pending = transcript.withInput("", undefined, [media]);
		expect(transcript.rows).toEqual([]);
		expect(pending[0]?.contentJson).toEqual([media]);
		transcript.appendInput("", undefined, [media]);
		expect(transcript.rows[0]?.contentJson).toEqual([media]);
		media.filename = "changed-after-snapshot.wav";
		expect(pending[0]?.contentJson).toMatchObject([{ filename: "recording.wav" }]);
		media.filename = "recording.wav";
		expect(JSON.stringify(transcript.rows)).not.toContain("base64");
	});

	test("settled media is stored in the canonical tool output envelope and broken calls omit it", () => {
		const transcript = new LoopTranscript();
		toolStep(transcript, ["media", "bad"]);
		const before = transcript.rows;
		transcript.settleTool("media", { output: "audio read", mediaRefs: [media] });
		transcript.settleTool("bad", { output: "broken", broken: true, mediaRefs: [media] });
		expect(before[0]?.toolCalls?.[0]?.outputJson).toBeNull();
		expect(transcript.rows[0]?.toolCalls?.[0]?.outputJson).toEqual({
			_text: "audio read",
			_media: [media],
		});
		expect(transcript.rows[0]?.toolCalls?.[1]?.outputJson).toEqual({
			_text: "broken",
			_broken: true,
		});
	});

	test("a call reaches the model only together with its result, in call order", async () => {
		const transcript = new LoopTranscript();
		transcript.appendInput("read both");
		toolStep(transcript, ["a", "b"]);
		const open = await projectHistory(transcript.rows, TARGET);
		expect(open.turns.map((turn) => turn.kind)).toEqual(["input", "assistant"]);

		transcript.settleTool("b", { output: "second" });
		transcript.settleTool("a", { output: "first", isError: true });
		const settled = await projectHistory(transcript.rows, TARGET);
		const results = settled.turns.at(-1);
		expect(results).toMatchObject({
			kind: "tool_results",
			results: [
				{ wireId: "a", text: "first", isError: true },
				{ wireId: "b", text: "second", isError: false },
			],
		});
		expect(historyTail(transcript.rows)).toEqual({ toolResults: true, input: true });
	});

	test("a snapshot keeps describing the request it was taken for", () => {
		const transcript = new LoopTranscript();
		toolStep(transcript, ["a"]);
		const before = transcript.rows;
		transcript.settleTool("a", { output: "done" });
		transcript.appendInput("next");
		expect(before).toHaveLength(1);
		expect(before[0]?.toolCalls?.[0]?.status).toBe("running");
		expect(transcript.rows[0]?.toolCalls?.[0]?.status).toBe("success");
	});

	test("an input not answered yet is part of the request, not of the transcript", () => {
		const transcript = new LoopTranscript();
		transcript.appendInput("first");
		const request = transcript.withInput("pending");
		expect(request).toHaveLength(2);
		expect(transcript.rows).toHaveLength(1);
		expect(transcript.withInput("")).toEqual(transcript.rows);
	});

	test("a broken call and its result are left out", async () => {
		const transcript = new LoopTranscript();
		toolStep(transcript, ["ok", "bad"]);
		transcript.settleTool("ok", { output: "fine" });
		transcript.settleTool("bad", { output: "invalid input", isError: true, broken: true });
		const { turns } = await projectHistory(transcript.rows, TARGET);
		expect(JSON.stringify(turns)).not.toContain('"bad"');
		expect(turns.at(-1)).toMatchObject({ results: [{ wireId: "ok", text: "fine" }] });
	});

	test("images carry their bytes: inputs and tool results reach the projection", async () => {
		const transcript = new LoopTranscript();
		transcript.appendInput("look", [{ format: "png", base64: PNG }]);
		toolStep(transcript, ["shot"]);
		transcript.settleTool("shot", { output: "captured", images: [{ format: "png", base64: PNG }] });
		const { turns } = await projectHistory(transcript.rows, TARGET);
		expect(turns[0]).toMatchObject({
			kind: "input",
			items: [{ text: "look", images: [{ mediaType: "image/png", base64: PNG }] }],
		});
		expect(turns.at(-1)).toMatchObject({
			results: [{ wireId: "shot", images: [{ mediaType: "image/png", base64: PNG }] }],
		});
	});

	test("the input is sent as written, without a sender marker", async () => {
		const provider = new AnthropicProvider({
			id: "transcript",
			name: "Transcript",
			prefix: "transcript",
			apiKey: "unused",
			baseUrl: "https://example.invalid",
			defaultModel: "claude-sonnet-4",
		});
		const transcript = new LoopTranscript();
		transcript.appendInput("exactly this");
		const built = await buildAdapterHistory(provider, transcript.rows, {
			provider: "transcript",
			model: "claude-sonnet-4",
		});
		expect(built.history).toEqual([{ role: "user", content: "exactly this" }]);
	});
});
