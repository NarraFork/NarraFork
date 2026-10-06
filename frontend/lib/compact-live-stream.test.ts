import { describe, expect, test } from "bun:test";
import { type CompactLiveStreamEvent, consumeCompactLiveStream } from "./compact-live-stream";

function responseFromChunks(chunks: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

describe("consumeCompactLiveStream", () => {
	test("parses split SSE frames and delivers only deltas/counts", async () => {
		const events: CompactLiveStreamEvent[] = [];
		await consumeCompactLiveStream(
			responseFromChunks([
				'event: delta\ndata: {"kind":"delta","channel":"output","delta":"hel',
				'lo","outputChars":5,"thinkingChars":0}\n\n',
				'event: heartbeat\ndata: {"kind":"heartbeat","outputChars":5,"thinkingChars":0}\n\n',
				'event: finished\ndata: {"kind":"finished","status":"compacted"}\n\n',
			]),
			(event) => events.push(event),
		);

		expect(events).toEqual([
			{ kind: "delta", channel: "output", delta: "hello", outputChars: 5, thinkingChars: 0 },
			{ kind: "heartbeat", outputChars: 5, thinkingChars: 0 },
			{ kind: "finished", status: "compacted" },
		]);
	});
});
