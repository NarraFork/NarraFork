/**
 * chat-forward-text tests — the exact string a narrator receives.
 *
 * This output becomes a real user message in a model's context, so the properties
 * that matter are not cosmetic:
 *
 *  1. **Attribution.** A transcript without authors is worse than useless when
 *     several people disagree in it.
 *  2. **Reply relationships.** A flat list of utterances loses who was answering
 *     whom, which is precisely what decides whether two lines agree or contradict.
 *     Taken from the stored snapshot, so a quoted message outside the selection is
 *     still named.
 *  3. **Bounded size.** A selection is unbounded; a useful forward is not.
 *  4. **Blockquote framing**, so the model reads it as quoted material rather than
 *     as an instruction addressed to it.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../lib/api/chat";
import {
	buildForwardText,
	CHAT_FORWARD_MAX_CHARS,
	CHAT_FORWARD_PER_MESSAGE_MAX_CHARS,
	CHAT_FORWARD_REPLY_MAX_CHARS,
} from "./chat-forward-text";

const T0 = "2026-01-01T00:00:00.000Z";

function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
	return {
		id: overrides.id,
		roomId: "room",
		seq: overrides.seq ?? 1,
		kind: overrides.kind ?? "text",
		contentText: overrides.contentText ?? "body",
		replyToMessageId: overrides.replyToMessageId ?? null,
		replyToSeq: overrides.replyToSeq ?? null,
		replyToSender: overrides.replyToSender ?? null,
		replyToPreview: overrides.replyToPreview ?? null,
		attachments: overrides.attachments ?? [],
		editedAt: null,
		deletedAt: overrides.deletedAt ?? null,
		createdAt: overrides.createdAt ?? T0,
		sender:
			overrides.sender === undefined
				? { id: "alice", username: "alice", avatarColor: null, avatarImageId: null }
				: overrides.sender,
	};
}

const sender = (id: string) => ({
	id,
	username: id,
	avatarColor: null,
	avatarImageId: null,
});

describe("attribution and framing", () => {
	test("every line is inside a blockquote", () => {
		const text = buildForwardText([msg({ id: "a", contentText: "line one\nline two" })]);
		for (const line of text.split("\n")) {
			expect(line.startsWith(">")).toBe(true);
		}
	});

	test("the author is named", () => {
		const text = buildForwardText([msg({ id: "a", sender: sender("bob") })]);
		expect(text).toContain("**bob**");
	});

	test("guests stay attributed in both the sender and quoted author", () => {
		const guest = { ...sender("guest:original"), username: "固定访客", isGuest: true };
		const text = buildForwardText([
			msg({
				id: "reply",
				sender: guest,
				replyToSender: guest,
				replyToMessageId: "original",
				replyToPreview: "quoted text",
			}),
		]);
		expect(text).toContain("**固定访客 [share guest]**");
		expect(text).toContain("in reply to **固定访客 [share guest]**");
		expect(text).not.toContain("guest:original");
	});

	test("a missing sender degrades to 'unknown' rather than vanishing", () => {
		const text = buildForwardText([msg({ id: "a", sender: null })]);
		expect(text).toContain("unknown");
	});

	test("messages keep the order they were given", () => {
		const text = buildForwardText([
			msg({ id: "a", seq: 1, contentText: "first" }),
			msg({ id: "b", seq: 2, contentText: "second" }),
		]);
		expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
	});

	test("deleted messages are dropped, not rendered as empty quotes", () => {
		const text = buildForwardText([
			msg({ id: "a", contentText: "", deletedAt: T0 }),
			msg({ id: "b", seq: 2, contentText: "kept" }),
		]);
		expect(text).toContain("kept");
		expect(text.split("\n\n")).toHaveLength(1);
	});

	test("an empty selection produces an empty string", () => {
		expect(buildForwardText([])).toBe("");
	});
});

describe("reply context", () => {
	test("a quoted message names its author and content", () => {
		const text = buildForwardText([
			msg({
				id: "b",
				contentText: "I disagree",
				replyToMessageId: "a",
				replyToSeq: 1,
				replyToPreview: "we should use Redis",
				replyToSender: sender("carol"),
			}),
		]);
		expect(text).toContain("in reply to **carol**");
		expect(text).toContain("we should use Redis");
	});

	test("the reply line comes from the snapshot, NOT from the selection", () => {
		// The quoted message is deliberately absent from the selection: resolving
		// against the selection would make the transcript depend on what the user
		// happened to highlight, and would say nothing for the normal case of replying
		// to something further back.
		const text = buildForwardText([
			msg({
				id: "z",
				contentText: "answering",
				replyToMessageId: "not-selected",
				replyToSeq: 3,
				replyToPreview: "the earlier point",
				replyToSender: sender("dave"),
			}),
		]);
		expect(text).toContain("in reply to **dave**");
		expect(text).toContain("the earlier point");
	});

	test("a deleted quote target is stated as such", () => {
		const text = buildForwardText([
			msg({
				id: "b",
				replyToMessageId: "a",
				replyToSeq: 1,
				replyToPreview: "",
				replyToSender: sender("carol"),
			}),
		]);
		expect(text).toContain("message deleted");
	});

	test("a legacy row still records THAT it is a reply", () => {
		// The relationship is known even when the content is not; omitting the line
		// would let the model read an answer as a fresh point.
		const text = buildForwardText([
			msg({ id: "b", replyToMessageId: "a", replyToPreview: null, replyToSender: sender("carol") }),
		]);
		expect(text).toContain("in reply to **carol**");
	});

	test("a non-reply gets no reply line", () => {
		expect(buildForwardText([msg({ id: "a" })])).not.toContain("in reply to");
	});

	test("the quoted excerpt is bounded independently of the body", () => {
		const text = buildForwardText([
			msg({
				id: "b",
				replyToMessageId: "a",
				replyToSeq: 1,
				replyToPreview: "q".repeat(500),
				replyToSender: sender("carol"),
			}),
		]);
		const replyLine = text.split("\n").find((line) => line.includes("in reply to")) ?? "";
		// The reply line identifies WHICH message is answered; it is not a place to
		// reproduce it.
		expect(replyLine.length).toBeLessThan(CHAT_FORWARD_REPLY_MAX_CHARS + 80);
	});

	test("newlines in a quoted excerpt are flattened", () => {
		const text = buildForwardText([
			msg({
				id: "b",
				replyToMessageId: "a",
				replyToSeq: 1,
				replyToPreview: "line one\nline two",
				replyToSender: sender("carol"),
			}),
		]);
		// An unflattened excerpt would emit a line with no `>` prefix, breaking the
		// blockquote and letting the quoted text read as an instruction.
		for (const line of text.split("\n")) {
			expect(line.startsWith(">")).toBe(true);
		}
	});
});

describe("attachments", () => {
	const attachment = (filename: string) => ({
		id: `att-${filename}`,
		kind: "file" as const,
		filename,
		mediaType: "text/plain",
		sizeBytes: 10,
		width: null,
		height: null,
	});

	test("a message's attachment filenames are named in its quote", () => {
		const text = buildForwardText([
			msg({ id: "a", contentText: "see attached", attachments: [attachment("crash.log")] }),
		]);
		expect(text).toContain("crash.log");
	});

	test("an attachment-only message is kept, not skipped as empty", () => {
		// It would otherwise be dropped while its path still appeared in the hint block,
		// leaving the model with a file no quoted line accounts for.
		const text = buildForwardText([
			msg({ id: "a", contentText: "", attachments: [attachment("shot.png")] }),
		]);
		expect(text).toContain("shot.png");
		expect(text).toContain("**alice**");
	});

	test("the hint is appended verbatim, outside the per-message budget", () => {
		const hint = "\n<attached_files>\n- /work/.narrafork/attached/a.log\n</attached_files>";
		const text = buildForwardText([msg({ id: "a", contentText: "body" })], {
			attachmentHint: hint,
		});
		// Truncating it would leave a partial path list the model might try to read.
		expect(text).toContain("<attached_files>");
		expect(text).toContain("/work/.narrafork/attached/a.log");
		expect(text.endsWith("</attached_files>")).toBe(true);
	});

	test("a hint alone is a valid forward", () => {
		const hint = "<attached_files>\n- /work/x.log\n</attached_files>";
		expect(buildForwardText([], { attachmentHint: hint })).toContain("/work/x.log");
	});

	test("a blank hint adds nothing", () => {
		const withBlank = buildForwardText([msg({ id: "a" })], { attachmentHint: "   " });
		expect(withBlank).toBe(buildForwardText([msg({ id: "a" })]));
	});
});

describe("bounds", () => {
	test("one huge message cannot consume the whole budget silently", () => {
		const text = buildForwardText([msg({ id: "a", contentText: "x".repeat(9_000) })]);
		expect(text).toContain("…");
		expect(text.length).toBeLessThan(CHAT_FORWARD_PER_MESSAGE_MAX_CHARS + 200);
	});

	test("the total is capped across many messages", () => {
		const many = Array.from({ length: 400 }, (_, i) =>
			msg({ id: `m${i}`, seq: i + 1, contentText: "y".repeat(100) }),
		);
		expect(buildForwardText(many).length).toBeLessThanOrEqual(CHAT_FORWARD_MAX_CHARS);
	});

	test("the cap does not drop the earliest messages", () => {
		// Truncation must take the TAIL: a transcript missing its beginning reads as if
		// the conversation started mid-argument.
		const many = Array.from({ length: 400 }, (_, i) =>
			msg({ id: `m${i}`, seq: i + 1, contentText: `msg-${i} ${"y".repeat(100)}` }),
		);
		const text = buildForwardText(many);
		expect(text).toContain("msg-0");
		expect(text).not.toContain("msg-399");
	});
});
