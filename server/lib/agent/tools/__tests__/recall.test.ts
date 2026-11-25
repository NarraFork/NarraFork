import { beforeEach, expect, mock, test } from "bun:test";
import type { RecallMessagePage } from "../../../recall-contract";
import type { ToolResult } from "../../types";

const hit = (id: string, createdAt = "2026-01-01T00:00:00.000Z") => ({
	messageId: id,
	narratorId: "self",
	narratorTitle: "Self",
	role: "user",
	origin: "user",
	createdAt,
	snippet: `saved ${id}`,
});
let hits = [hit("message")];
const search = mock(async (_input: Record<string, unknown>) => hits);
const conversation = mock(async (_input: Record<string, unknown>) => ({
	narrator: { id: "self", title: "Self", model: "model" },
	messageMissing: false,
	rows: [
		{
			id: "message",
			role: "user",
			origin: "user",
			content_text: "Original request",
			truncated: true,
			created_at: "2026-01-01",
			seq: 10,
		},
	],
	tools: [],
	pagination: {
		hasOlder: true,
		hasNewer: true,
		olderCursor: { seq: 10, messageId: "message" },
		newerCursor: { seq: 10, messageId: "message" },
	},
}));
let body: RecallMessagePage | null;
const message = mock(async (_input: Record<string, unknown>) => body);
let toolResult: ToolResult | null;
const tool = mock(async (_input: Record<string, unknown>) => toolResult);
mock.module("../../../../services/search/backend", () => ({
	searchStore: { searchRecallMessages: search },
}));
mock.module("../../../../services/search/recall-store", () => ({
	recallConversation: conversation,
	recallMessage: message,
	recallToolCallPage: tool,
}));
const { recallTool } = await import("../recall");
function run(input: Record<string, unknown>, signal = new AbortController().signal) {
	return recallTool.execute(input, { narratorId: "self", signal } as never);
}

beforeEach(() => {
	for (const fn of [search, conversation, message, tool]) fn.mockClear();
	hits = [hit("message")];
	search.mockImplementation(async () => hits);
	body = {
		messageId: "message",
		narratorId: "self",
		narratorTitle: "Self",
		seq: 10,
		bodyRevision: 2,
		role: "user",
		origin: "user",
		createdAt: "2026-01-01",
		text: "\u{1F600}中文",
		offset: 8,
		totalChars: 15,
		hasMore: true,
		nextOffset: 11,
		omittedBlocks: ["image"],
	};
	toolResult = {
		output: "Stored answers. permissionDecidedBy=reflection",
		title: "AskUserQuestion",
		metadata: {
			toolUseId: "use",
			toolName: "AskUserQuestion",
			narratorId: "other",
			permissionDecidedBy: "reflection",
			pages: {
				input: { hasMore: true, nextOffset: 8 },
				output: { hasMore: false, nextOffset: null },
			},
		},
	};
});

test("invalid actions and inappropriate fields fail before any data access", async () => {
	for (const input of [{ action: "guess" }, { action: "search", query: "request", offset: 3 }]) {
		expect(await run(input)).toMatchObject({ isError: true });
	}
	expect(search).not.toHaveBeenCalled();
	expect(conversation).not.toHaveBeenCalled();
});

test("foreign IDs never widen scope without explicit cross-narrator permission", async () => {
	for (const input of [
		{ action: "search", query: "request" },
		{ action: "read_conversation" },
		{ action: "read_message", message_id: "message" },
		{ action: "read_tool_call", tool_call_id: "use" },
	])
		expect(await run({ ...input, narrator_id: "other" })).toMatchObject({ isError: true });
	for (const fn of [search, conversation, message, tool]) expect(fn).not.toHaveBeenCalled();
});

test("search forwards author, role, exact scope and UTC date bounds before limiting", async () => {
	await run({
		action: "search",
		query: "request",
		narrator_id: "other",
		all_narrators: true,
		roles: ["user"],
		origins: ["user", "unknown"],
		limit: 1,
		from: "2026-01-01",
		to: "2026-01-01",
		sort: "oldest",
	});
	expect(search.mock.calls[0]?.[0]).toMatchObject({
		narratorId: "other",
		roles: ["user"],
		origins: ["user", "unknown"],
		limit: 2,
		createdFrom: "2026-01-01T00:00:00.000Z",
		createdTo: "2026-01-01T23:59:59.999Z",
		sort: "oldest",
	});
});

test("batch alternatives share a total budget, deduplicate hits and preserve match provenance", async () => {
	search.mockImplementation(async (input) =>
		input.text === "alpha"
			? [hit("shared"), hit("alpha-only"), hit("alpha-more")]
			: [hit("shared"), hit("bravo-only"), hit("bravo-more")],
	);
	const result = await run({ action: "search", query: ["alpha", "bravo", "alpha"], limit: 2 });
	const metadata = result.metadata as {
		results: { id: string; matchedQueries: string[] }[];
		hasMore: boolean;
	};
	expect(metadata.results).toHaveLength(2);
	expect(new Set(metadata.results.map((row) => row.id)).size).toBe(2);
	expect(metadata.results[0]).toMatchObject({ id: "shared", matchedQueries: ["alpha", "bravo"] });
	expect(metadata.hasMore).toBe(true);
	expect(search).toHaveBeenCalledTimes(2);
	expect(result.output).toContain("Total result limit: 2");
});

test("search uses global scope only when explicitly requested without a target", async () => {
	await run({ action: "search", query: "request", all_narrators: true });
	expect(search.mock.calls[0]?.[0].narratorId).toBeNull();
});

test("invalid dates and empty sanitized queries are actionable errors, not unfiltered searches", async () => {
	for (const input of [
		{ action: "search", query: "request", from: "2026-02-31" },
		{ action: "search", query: "request", from: "2026-02-02", to: "2026-01-01" },
		{ action: "search", query: "@@@" },
	])
		expect(await run(input)).toMatchObject({ isError: true });
	expect(search).not.toHaveBeenCalled();
});

test("turn cancellation stops later batch searches", async () => {
	const controller = new AbortController();
	search.mockImplementation(async () => {
		controller.abort();
		return [];
	});
	await expect(
		run({ action: "search", query: ["alpha", "bravo"] }, controller.signal),
	).rejects.toThrow();
	expect(search).toHaveBeenCalledTimes(1);
});

test("conversation defaults are quiet and its continuation preserves filters without the anchor", async () => {
	const result = await run({
		action: "read_conversation",
		message_id: "message",
		roles: ["user"],
		origins: ["user"],
		time_range: "7d",
		limit: 1,
	});
	expect(conversation.mock.calls[0]?.[0]).toMatchObject({
		narratorId: "self",
		messageId: "message",
		direction: "around",
		includeToolCalls: false,
		limit: 1,
		roles: ["user"],
		origins: ["user"],
	});
	expect(result.output).toContain("Preview truncated");
	const olderLine = result.output.split("\n").find((line) => line.startsWith("Older page: "));
	const next = JSON.parse(olderLine?.slice("Older page: ".length) ?? "{}");
	expect(next).toMatchObject({
		action: "read_conversation",
		narrator_id: "self",
		direction: "older",
		cursor: { seq: 10, messageId: "message" },
		roles: ["user"],
		origins: ["user"],
		limit: 1,
	});
	expect(next).not.toHaveProperty("message_id");
	expect(next).not.toHaveProperty("time_range");
	expect(next.from).toBeString();
	expect(next.to).toBeString();
});

test("message pages use Unicode code points and retain source text without sender prefixes", async () => {
	const result = await run({ action: "read_message", message_id: "message", offset: 8 });
	expect(result.output).toContain("[8, 11) of 15");
	expect(result.output).toContain('"offset":11');
	expect(result.metadata?.text).toBe("\u{1F600}中文");
	expect(result.output).not.toContain("<sender");
	expect(result.output).toContain("Non-text blocks: image");
});

test("missing referenced messages fail instead of pretending the original body is empty", async () => {
	body = null;
	expect(await run({ action: "read_message", message_id: "message" })).toMatchObject({
		isError: true,
	});
});

test("tool continuation follows each field and retains cross-scope/decision provenance", async () => {
	const result = await run({ action: "read_tool_call", tool_call_id: "use", all_narrators: true });
	expect(tool.mock.calls[0]?.[0]).toMatchObject({
		narratorId: null,
		part: "both",
		offset: 0,
		maxChars: 8000,
	});
	expect(result.metadata?.permissionDecidedBy).toBe("reflection");
	const line = result.output.split("\n").find((value) => value.startsWith("Continue input: "));
	expect(JSON.parse(line?.slice("Continue input: ".length) ?? "{}")).toMatchObject({
		action: "read_tool_call",
		tool_call_id: "use",
		narrator_id: "other",
		all_narrators: true,
		part: "input",
		offset: 8,
	});
	expect(result.output).not.toContain("Continue output:");
});

test("long async answers remain reachable when the original tool input is already complete", async () => {
	toolResult = {
		output: "Saved async answers (truncated)",
		metadata: {
			narratorId: "self",
			toolUseId: "use",
			pages: { input: { hasMore: false, nextOffset: null } },
			question: { answers: { hasMore: true, nextOffset: 8000 } },
		},
	};
	const result = await run({ action: "read_tool_call", tool_call_id: "use" });
	const line = result.output
		.split("\n")
		.find((value) => value.startsWith("Continue saved answers: "));
	expect(JSON.parse(line?.slice("Continue saved answers: ".length) ?? "{}")).toMatchObject({
		action: "read_tool_call",
		tool_call_id: "use",
		narrator_id: "self",
		part: "input",
		offset: 8000,
	});
});

test("display-only sender labels are not sent to model text or result metadata", async () => {
	if (!body) throw new Error("Missing message fixture");
	Object.assign(body, { originLabel: "Telegram @private-handle / OAuth integration" });
	const result = await run({ action: "read_message", message_id: "message" });
	expect(result.output).not.toContain("Telegram");
	expect(result.output).not.toContain("@private-handle");
	expect(result.metadata).not.toHaveProperty("originLabel");
	expect(result.metadata?.text).toBe(body.text);
});
