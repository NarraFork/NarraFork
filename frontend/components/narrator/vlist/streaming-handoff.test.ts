import { describe, expect, it } from "bun:test";
import {
	commitGrowthSignature,
	type HandoffMessage,
	isStreamingMessageSuperseded,
	STREAMING_MESSAGE_ID,
} from "./streaming-handoff";

function assistant(id: string, text: string): HandoffMessage {
	return { id, role: "assistant", parentToolUseId: null, contentJson: [{ type: "text", text }] };
}

function user(id: string, text: string): HandoffMessage {
	return { id, role: "user", parentToolUseId: null, contentJson: [{ type: "text", text }] };
}

function toolMessage(id: string, toolUseId: string): HandoffMessage {
	return {
		id,
		role: "assistant",
		parentToolUseId: null,
		contentJson: [{ type: "tool_use", id: toolUseId }],
		toolCalls: [{ toolUseId, toolName: "Bash", status: "success" }],
	};
}

function streamingText(text: string): HandoffMessage {
	return {
		id: STREAMING_MESSAGE_ID,
		role: "assistant",
		parentToolUseId: null,
		contentJson: [{ type: "text", text }],
	};
}

function streamingWithTool(toolUseId: string): HandoffMessage {
	return {
		id: STREAMING_MESSAGE_ID,
		role: "assistant",
		parentToolUseId: null,
		contentJson: [
			{ type: "text", text: "正在执行" },
			{ type: "tool_use", id: toolUseId },
		],
		toolCalls: [{ toolUseId, toolName: "Bash", status: "running" }],
	};
}

describe("isStreamingMessageSuperseded", () => {
	it("keeps the row while nothing is published", () => {
		expect(isStreamingMessageSuperseded({ streamingMessage: null, committedMessages: [] })).toBe(
			false,
		);
	});

	it("keeps a text-only row while the document still ends with the user's turn", () => {
		// This is the case the old 3s timeout broke: the reply is not persisted yet, so
		// clearing here would leave the reader with nothing at all.
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingText("正在回答"),
				committedMessages: [user("u1", "问题")],
			}),
		).toBe(false);
	});

	it("retires a text-only row once the assistant reply is the last committed message", () => {
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingText("正在回答"),
				committedMessages: [user("u1", "问题"), assistant("a1", "完整的回答")],
			}),
		).toBe(true);
	});

	it("does NOT whole-row retire a tool-bearing live row when its tool id is persisted", () => {
		// Per-tool hand-off drops the synthetic tool card; reasoning / text / later
		// tools must stay until their own blocks are demonstrably in the document.
		// Whole-row clear on tool id was the bug: tool1 persisted → clearBlocks wiped
		// reasoning+content+tool2 until the next tool finished and reloaded the DB row.
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingWithTool("tool-42"),
				committedMessages: [user("u1", "问题"), toolMessage("a1", "tool-42")],
			}),
		).toBe(false);
	});

	it("keeps the live reasoning/content/tool2 row after tool1 has been persisted", () => {
		// Reported shape: reasoning → content → tool1 → tool2. tool1 landing in the
		// partial must not retire the live row that still owns reasoning, content and
		// the in-flight tool2.
		const live: HandoffMessage = {
			id: STREAMING_MESSAGE_ID,
			role: "assistant",
			parentToolUseId: null,
			contentJson: [
				{ type: "reasoning", text: "**分析**\n\n先确认现状。" },
				{ type: "text", text: "我先定位这段逻辑。" },
				{ type: "tool_use", id: "tool-1" },
				{ type: "tool_use", id: "tool-2" },
			],
			toolCalls: [
				{ toolUseId: "tool-1", toolName: "Read", status: "success" },
				{ toolUseId: "tool-2", toolName: "Bash", status: "running" },
			],
		};
		const committedPartial: HandoffMessage = {
			id: "a1",
			role: "assistant",
			parentToolUseId: null,
			contentJson: [
				{ type: "reasoning", text: "**分析**\n\n先确认现状。" },
				{ type: "text", text: "我先定位这段逻辑。" },
				{ type: "tool_use", id: "tool-1" },
			],
			toolCalls: [{ toolUseId: "tool-1", toolName: "Read", status: "success" }],
		};
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: live,
				committedMessages: [user("u1", "问题"), committedPartial],
			}),
		).toBe(false);
	});

	it("keeps a tool-bearing row when only a DIFFERENT tool is persisted", () => {
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingWithTool("tool-99"),
				committedMessages: [toolMessage("a1", "tool-42")],
			}),
		).toBe(false);
	});

	it("does not whole-row retire on a tool id carried only in contentJson", () => {
		const persisted: HandoffMessage = {
			id: "a1",
			role: "assistant",
			parentToolUseId: null,
			contentJson: [{ type: "tool_use", id: "tool-7" }],
		};
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingWithTool("tool-7"),
				committedMessages: [persisted],
			}),
		).toBe(false);
	});

	it("ignores the streaming row itself when scanning the document", () => {
		// Defensive: if a caller ever includes the synthetic row in the committed list,
		// it must not be treated as its own replacement.
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingWithTool("tool-1"),
				committedMessages: [streamingWithTool("tool-1")],
			}),
		).toBe(false);
	});

	it("does NOT retire on an empty persisted assistant message", () => {
		// A discarded reasoning-only turn persists with no renderable content; retiring
		// there would take live text off screen and show nothing instead.
		const empty: HandoffMessage = {
			id: "a1",
			role: "assistant",
			parentToolUseId: null,
			contentJson: [],
		};
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingText("正在思考的输出"),
				committedMessages: [user("u1", "问题"), empty],
			}),
		).toBe(false);
	});

	it("ignores subagent child messages when deciding a top-level hand-off", () => {
		const child: HandoffMessage = {
			id: "c1",
			role: "assistant",
			parentToolUseId: "tool-parent",
			contentJson: [{ type: "text", text: "子代理输出" }],
		};
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingText("父级输出"),
				committedMessages: [user("u1", "问题"), child],
			}),
		).toBe(false);
	});

	it("retires on a trailing assistant message carrying only a thinking block", () => {
		const persisted: HandoffMessage = {
			id: "a1",
			role: "assistant",
			parentToolUseId: null,
			contentJson: [{ type: "thinking", thinking: "推理内容" }],
		};
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingText("推理"),
				committedMessages: [persisted],
			}),
		).toBe(true);
	});

	it("keeps the row when the last committed message is a fresh user turn", () => {
		// The reader sent a follow-up while output was streaming: the trailing message
		// is theirs, so the previous stream is not yet stored.
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingText("上一轮输出"),
				committedMessages: [assistant("a1", "更早的回答"), user("u2", "追加问题")],
			}),
		).toBe(false);
	});

	// ── Multi-step turns ────────────────────────────────────────────────────────
	//
	// A turn commonly persists several messages: text, then a tool, then MORE text. The
	// rule "a trailing assistant message supersedes the row" is wrong there — the
	// stored message belongs to an EARLIER step, and retiring the row threw away the
	// step currently streaming. That output was never in the document, so it did not
	// appear in history either: it simply vanished.
	it("keeps streaming text the model produced AFTER the last commit", () => {
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingText("第二段回答"),
				committedMessages: [user("u1", "问题"), assistant("a1", "第一段回答")],
				// Text has arrived since a1 landed → this is a new step, not a replay.
				charsSinceLastCommit: 5,
			}),
		).toBe(false);
	});

	it("keeps streaming text that follows a persisted tool message", () => {
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingText("工具之后继续说明"),
				committedMessages: [user("u1", "问题"), toolMessage("a2", "tool-1")],
				charsSinceLastCommit: 8,
			}),
		).toBe(false);
	});

	it("still retires the row when nothing new arrived after the commit", () => {
		// The stored message IS this row's content: the stream ended and persisted.
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingText("完整的回答"),
				committedMessages: [user("u1", "问题"), assistant("a1", "完整的回答")],
				charsSinceLastCommit: 0,
			}),
		).toBe(true);
	});

	it("does not whole-row retire a tool-bearing row even when text arrived after the commit", () => {
		// Tool cards retire individually; the row stays for reasoning/text/tool2.
		expect(
			isStreamingMessageSuperseded({
				streamingMessage: streamingWithTool("tool-42"),
				committedMessages: [toolMessage("a1", "tool-42")],
				charsSinceLastCommit: 120,
			}),
		).toBe(false);
	});
});

// The counter feeding `charsSinceLastCommit` must reset when the document GAINS a
// message and at no other time. Watching the messages array identity for that was a
// real bug: a live lifecycle patch (tool finished, permission decided, reflection
// advanced) rebuilds the array to patch a field in place, several times per turn.
// Resetting on those zeroed the counter, and the multi-step protection above then
// retired live output that had never been persisted.
describe("commitGrowthSignature", () => {
	const turn: HandoffMessage[] = [user("u1", "问题"), assistant("a1", "第一段")];

	it("is unchanged by an in-place patch that rebuilds the array", () => {
		const before = commitGrowthSignature(turn);
		// Exactly what applyLivePatch produces: new array, new message object, same
		// identity set (here: a tool call flipping to success).
		const patched = turn.map((message) =>
			message.id === "a1"
				? { ...message, toolCalls: [{ toolUseId: "t1", status: "success" }] }
				: message,
		);
		expect(patched).not.toBe(turn);
		expect(commitGrowthSignature(patched)).toBe(before);
	});

	it("changes when a message is appended", () => {
		expect(commitGrowthSignature([...turn, assistant("a2", "第二段")])).not.toBe(
			commitGrowthSignature(turn),
		);
	});

	it("changes when the tail message is replaced by a different one", () => {
		const edited = [turn[0] as HandoffMessage, assistant("a9", "改写")];
		expect(commitGrowthSignature(edited)).not.toBe(commitGrowthSignature(turn));
	});

	it("ignores a published streaming row so it cannot mask the persisted tail", () => {
		expect(commitGrowthSignature([...turn, streamingText("正在输出")])).toBe(
			commitGrowthSignature(turn),
		);
	});

	it("is stable while only the streaming row grows", () => {
		const short = commitGrowthSignature([...turn, streamingText("短")]);
		const long = commitGrowthSignature([...turn, streamingText("长得多的一段输出")]);
		expect(long).toBe(short);
	});

	it("handles an empty document", () => {
		expect(commitGrowthSignature([])).toBe("0:");
	});
});
