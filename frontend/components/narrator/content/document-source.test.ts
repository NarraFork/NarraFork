import { describe, expect, test } from "bun:test";
import { textDocumentStore } from "@frontend/lib/text-document-store";
import type { TextDocumentRef } from "@shared/pretext-layout/text-document";
import { classifyToolDetail, isTextDocumentRef } from "@shared/pretext-layout/tool-detail";
import { buildTopLevelStreamingChunksMsg } from "../narrator-message-helpers";
import {
	applyStreamingToolChunk,
	applyStreamingToolCompleted,
	applyStreamingToolStarted,
	collectPersistedDocumentPins,
	collectPersistedToolUseIds,
	createStreamingToolStore,
	dropPersistedStreamingTools,
	isTextDocumentPersisted,
	streamingToolChunks,
} from "../vlist/streaming-tool-chunks";
import { documentWriteInput, receiveWriteDocument } from "./document-source";

function ref(id: string, length: number, revision = 1, attempt = 1): TextDocumentRef {
	return {
		id,
		epoch: `${id}:epoch`,
		length,
		revision,
		complete: false,
		originKnown: true,
		source: { narratorId: "n", toolUseId: "same", field: "content", executionAttempt: attempt },
	};
}

describe("complete Write document lane", () => {
	test("over 16k preserves start, middle, tail and keeps hot synthetic payload small", async () => {
		const store = createStreamingToolStore();
		const parts = ["FIRST\r\n", "middle\t中文😀".repeat(5000), "\r\nLAST"];
		let length = 0;
		for (const [i, text] of parts.entries()) {
			const document = ref("large-live", length + text.length, i + 1);
			receiveWriteDocument({ ref: document, offset: length }, text);
			applyStreamingToolChunk(store, {
				toolUseId: "same",
				toolName: "Write",
				inputCharsTotal: length + text.length,
				streamingField: { name: "content", delta: text },
				inputDocument: { ref: document, offset: length },
			});
			length += text.length;
		}
		const document = store.get("same")?.textDocument;
		expect(document).toBeDefined();
		if (!document) throw new Error("missing document");
		expect(await textDocumentStore.readAll(document.id)).toBe(parts.join(""));
		const message = buildTopLevelStreamingChunksMsg(streamingToolChunks(store), "n", null);
		expect(JSON.stringify(message).length).toBeLessThan(6000);
		expect(message?.toolCalls?.[0].inputJson).not.toHaveProperty("content");
	});
	test("seal and late started retain source identity while terminal state never regresses", async () => {
		const store = createStreamingToolStore();
		const document = ref("late-started", 4);
		receiveWriteDocument({ ref: document, offset: 0 }, "a\r\nb");
		applyStreamingToolChunk(store, {
			toolUseId: "same",
			toolName: "Write",
			inputCharsTotal: 20,
			inputDocument: { ref: document, offset: 0 },
		});
		applyStreamingToolCompleted(store, { toolUseId: "same", status: "success" });
		const input = documentWriteInput("n", "same", {
			content: "a\r\nb",
			file_path: "a.ts",
		}) as Record<string, unknown>;
		applyStreamingToolStarted(store, { toolUseId: "same", toolName: "Write", input });
		expect(store.get("same")?._status).toBe("success");
		expect(store.get("same")?.textDocument?.id).toBe(document.id);
		expect(store.get("same")?.textDocument?.epoch).toBe(document.epoch);
		expect(store.get("same")?.textDocument?.complete).toBe(true);
		expect(await textDocumentStore.readAll(document.id)).toBe("a\r\nb");
	});
	test("same provider id different attempt rejects late chunks and started from retired source", () => {
		const store = createStreamingToolStore();
		const first = ref("attempt-1", 3, 1, 1);
		const second = ref("attempt-2", 4, 1, 2);
		for (const document of [first, second])
			applyStreamingToolChunk(store, {
				toolUseId: "same",
				toolName: "Write",
				inputCharsTotal: 10,
				inputDocument: { ref: document, offset: 0 },
			});
		expect(
			applyStreamingToolChunk(store, {
				toolUseId: "same",
				toolName: "Write",
				inputCharsTotal: 50,
				inputDocument: { ref: first, offset: 0 },
			}),
		).toBe(false);
		expect(
			applyStreamingToolStarted(store, {
				toolUseId: "same",
				toolName: "Write",
				input: { content: "old", textDocument: first },
			}),
		).toBe(false);
		expect(store.get("same")?.textDocument?.id).toBe(second.id);
	});
	test("an old persisted attempt cannot retire a new live doc; its exact binding can hand off without deleting source", () => {
		const store = createStreamingToolStore();
		const document = ref("persisted-new-attempt", 4, 1, 2);
		receiveWriteDocument({ ref: document, offset: 0 }, "new!");
		applyStreamingToolChunk(store, {
			toolUseId: "same",
			toolName: "Write",
			inputCharsTotal: 4,
			inputDocument: { ref: document, offset: 0 },
		});
		const old = [
			{
				id: "m-old",
				narratorId: "n",
				toolCalls: [{ id: "pk-old", toolUseId: "same", executionAttempt: 1 }],
			},
		];
		const pins = collectPersistedDocumentPins(old);
		expect(isTextDocumentPersisted(document, pins)).toBe(false);
		expect(
			dropPersistedStreamingTools(
				store,
				collectPersistedToolUseIds(old),
				(chunk) => !!chunk.textDocument && isTextDocumentPersisted(chunk.textDocument, pins),
			),
		).toBe(false);
		const complete = [
			...old,
			{
				id: "m-new",
				narratorId: "n",
				toolCalls: [{ id: "pk-new", toolUseId: "same", executionAttempt: 2 }],
			},
		];
		const bound = {
			...document,
			source: {
				narratorId: "n",
				toolUseId: "same",
				field: "content",
				toolCallId: "pk-new",
				executionAttempt: 2,
			},
		};
		receiveWriteDocument({ ref: bound, offset: 0 });
		applyStreamingToolStarted(store, {
			toolUseId: "same",
			toolName: "Write",
			input: { content: "new!", textDocument: bound },
		});
		const message = buildTopLevelStreamingChunksMsg(streamingToolChunks(store), "n", null);
		expect(message?.toolCalls?.[0].id).toBe("pk-new");
		expect(message?.toolCalls?.[0].executionAttempt).toBe(2);
		const nextPins = collectPersistedDocumentPins(complete);
		expect(
			dropPersistedStreamingTools(
				store,
				collectPersistedToolUseIds(complete),
				(chunk) => !!chunk.textDocument && isTextDocumentPersisted(chunk.textDocument, nextPins),
			),
		).toBe(true);
		expect(textDocumentStore.peekRange(document.id, 0, 4)).toBe("new!");
	});
	test("a changed epoch on the same source id starts a fresh lane and rejects old epoch frames", () => {
		const store = createStreamingToolStore();
		const one = ref("epoch-replace", 3);
		applyStreamingToolChunk(store, {
			toolUseId: "same",
			toolName: "Write",
			inputCharsTotal: 3,
			inputDocument: { ref: one, offset: 0 },
		});
		applyStreamingToolStarted(store, {
			toolUseId: "same",
			toolName: "Write",
			input: { textDocument: one, content: "old" },
		});
		const two = { ...one, epoch: "replacement", revision: 2 };
		expect(
			applyStreamingToolChunk(store, {
				toolUseId: "same",
				toolName: "Write",
				inputCharsTotal: 3,
				inputDocument: { ref: two, offset: 0 },
			}),
		).toBe(true);
		expect(store.get("same")?._started).toBeUndefined();
		expect(
			applyStreamingToolChunk(store, {
				toolUseId: "same",
				toolName: "Write",
				inputCharsTotal: 3,
				inputDocument: { ref: one, offset: 0 },
			}),
		).toBe(false);
	});
	test("short live documents supply a bounded real preview and classify without a formal content field", () => {
		const document = receiveWriteDocument({ ref: ref("short-measure", 5), offset: 0 }, "hello");
		expect(document.preview).toBe("hello");
		const detail = classifyToolDetail({
			toolUseId: "same",
			toolName: "Write",
			category: "file",
			isStreaming: true,
			inputJson: { textDocument: document },
		});
		const body = detail?.sections.find((part) => part.body.kind === "capped")?.body;
		if (!body || body.kind !== "capped") throw new Error("short doc body missing");
		expect(body.text).toBe("hello");
		expect(body.textDocument?.length).toBe(5);
	});
	test("sparse descriptor recovers out-of-order pages while live tail remains exact", async () => {
		const text = `FIRST\r\n${"a".repeat(20000)}TAIL`;
		const document = ref("recovery", text.length, 5);
		const requests: number[] = [];
		receiveWriteDocument(
			{ ref: document, offset: text.length - 4 },
			"TAIL",
			async (snapshot, offset, limit) => {
				requests.push(offset);
				return { ref: snapshot, offset, text: text.slice(offset, offset + limit) };
			},
		);
		receiveWriteDocument(
			{ ref: { ...document, revision: 3 }, offset: 9000 },
			text.slice(9000, 9100),
		);
		expect(await textDocumentStore.readAll(document.id)).toBe(text);
		expect(requests.length).toBeGreaterThan(0);
		expect(textDocumentStore.getSnapshot(document.id)?.revision).toBe(5);
	});
	test("historical imports are memoized and exact row PK prevents provider-id collisions", async () => {
		const input = { content: "history\r\n".repeat(15000), file_path: "a.ts" };
		const one = documentWriteInput("history-n", "same", input, {
			toolCallId: "one",
			executionAttempt: 1,
		}) as { textDocument: TextDocumentRef; content: string };
		const again = documentWriteInput("history-n", "same", input, {
			toolCallId: "one",
			executionAttempt: 1,
		});
		const two = documentWriteInput("history-n", "same", input, {
			toolCallId: "two",
			executionAttempt: 2,
		}) as typeof one;
		expect(again).toBe(one);
		expect(one.textDocument.id).not.toBe(two.textDocument.id);
		expect(one.content.length).toBeLessThanOrEqual(2048);
		expect(await textDocumentStore.readAll(one.textDocument.id)).toBe(input.content);
		const detail = classifyToolDetail({
			toolUseId: "same",
			toolName: "Write",
			category: "file",
			status: "success",
			inputJson: one,
		});
		const body = detail?.sections.find((section) => section.body.kind === "capped")?.body;
		expect(body?.kind).toBe("capped");
		if (body?.kind === "capped") {
			expect(body.textDocument?.id).toBe(one.textDocument.id);
			expect(body.textTruncated).toBe(false);
			expect(body.text?.length).toBeLessThanOrEqual(2048);
		}
	});
	test("malformed and unregistered markers cannot hijack a full Write body", async () => {
		for (const marker of [
			{},
			{ id: 12 },
			{ id: "x", epoch: "e", length: -1, revision: 1, complete: true, originKnown: true },
		]) {
			expect(isTextDocumentRef(marker)).toBe(false);
			const detail = classifyToolDetail({
				toolUseId: "invalid-marker",
				toolName: "Write",
				category: "file",
				inputJson: { content: "real", textDocument: marker },
			});
			const body = detail?.sections.find((part) => part.body.kind === "capped")?.body;
			if (body?.kind === "capped") expect(body.textDocument).toBeUndefined();
		}
		const fake = ref("unregistered-forged", 9999);
		const input = documentWriteInput("forged-n", "same", {
			content: "real",
			textDocument: fake,
		}) as { textDocument: TextDocumentRef };
		expect(input.textDocument.id).not.toBe(fake.id);
		expect(await textDocumentStore.readAll(input.textDocument.id)).toBe("real");
	});
});
