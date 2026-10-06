import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEXT_DOCUMENT_PACKET_BYTES } from "@shared/pretext-layout/text-document";
import {
	parseTextDocumentRangeQuery,
	ToolInputStreamSourceService,
} from "./tool-input-stream-source";

const directories: string[] = [];
async function create(options: ConstructorParameters<typeof ToolInputStreamSourceService>[0] = {}) {
	const directory = await mkdtemp(join(tmpdir(), "nf-tool-source-test-"));
	directories.push(directory);
	return { directory, service: new ToolInputStreamSourceService({ directory, ...options }) };
}
const identity = { narratorId: "self", toolUseId: "reused", field: "content" };
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

describe("complete tool input source", () => {
	test("raw UTF16 paging preserves CRLF, split surrogate pairs, and lone surrogates after spill", async () => {
		const { service, directory } = await create({ memoryBytes: 8 });
		const ref = service.create(identity, "session/request/occurrence1");
		const raw = "a\r\n\ud83d\ude00\ud800z\udfff";
		await service.append(ref.id, raw.slice(0, 4), 0);
		await service.append(ref.id, raw.slice(4), 4, true);
		let actual = "";
		for (let offset = 0; offset < raw.length; offset += 1) {
			const range = await service.getTextDocumentRange("self", ref.id, offset, 1);
			actual += range.text;
			expect(JSON.stringify(range)).not.toContain(directory);
		}
		expect(actual).toBe(raw);
		expect(service.descriptor(ref.id).complete).toBe(true);
		expect(service.usage.memoryBytes).toBe(0);
		const [name] = await readdir(directory);
		if (!name) throw new Error("Missing spill file");
		expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
		await service.discard(ref.id);
		expect(await readdir(directory)).toEqual([]);
	});

	test("offset-less legacy chunks append; duplicate and overlap are idempotent, gaps explicit", async () => {
		const { service } = await create();
		const ref = service.create(identity, "attempt1");
		await service.append(ref.id, "abc");
		const update = await service.append(ref.id, "def");
		expect(update.offset).toBe(3);
		const revision = update.ref.revision;
		expect((await service.append(ref.id, "def", 3)).ref.revision).toBe(revision);
		await service.append(ref.id, "efghi", 4);
		await expect(service.append(ref.id, "j", 15)).rejects.toMatchObject({
			code: "TEXT_DOCUMENT_OFFSET_GAP",
		});
		await expect(service.append(ref.id, "bad", 0)).rejects.toMatchObject({
			code: "TEXT_DOCUMENT_OFFSET_CONFLICT",
		});
		await service.append(ref.id, "", 9, true);
		expect((await service.getTextDocumentRange("self", ref.id)).text).toBe("abcdefghi");
	});

	test("source identity separates retry/session occurrences despite reused toolUseId", async () => {
		const { service } = await create();
		const first = service.create(identity, "session1/request1/tool1");
		const next = service.create(identity, "session1/request2/tool1");
		expect(first.id).not.toBe(next.id);
		expect(first.epoch).not.toBe(next.epoch);
		await service.append(first.id, "first");
		await service.append(next.id, "second");
		expect((await service.getTextDocumentRange("self", first.id)).text).toBe("first");
		expect((await service.getTextDocumentRange("self", next.id)).text).toBe("second");
	});

	test("parent and unrelated narrator cannot read self source, even with valid refId", async () => {
		const { service } = await create();
		const ref = service.create(identity, "attempt");
		await service.append(ref.id, "private");
		for (const owner of ["parent", "other"]) {
			await expect(service.getTextDocumentRange(owner, ref.id)).rejects.toMatchObject({
				statusCode: 404,
			});
		}
	});

	test("global budget spills before exceeding it; byte-bound queue applies async backpressure", async () => {
		let release!: () => void;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let writes = 0;
		const { service } = await create({
			memoryBytes: 8,
			globalMemoryBytes: 8,
			queueBytes: 4,
			write: async (file, bytes, position) => {
				writes++;
				expect(bytes.length).toBeLessThanOrEqual(4);
				entered();
				await waiting;
				await file.write(bytes, 0, bytes.length, position);
			},
		});
		const a = service.create(identity, "a");
		const b = service.create(identity, "b");
		await service.append(a.id, "1234");
		let done = false;
		const work = service.append(b.id, "567890").then(() => {
			done = true;
		});
		await ready;
		expect(done).toBe(false);
		expect(service.usage.memoryBytes).toBeLessThanOrEqual(8);
		expect(service.usage.queueBytes).toBeLessThanOrEqual(4);
		release();
		await work;
		expect(writes).toBe(3);
		expect((await service.getTextDocumentRange("self", b.id)).text).toBe("567890");
		await service.discard(a.id);
		await service.discard(b.id);
	});

	test("snapshot descriptor watermark can coexist with live deltas and bounded catch-up", async () => {
		const { service } = await create();
		const ref = service.create(identity, "occurrence");
		await service.append(ref.id, "before");
		const snapshot = service.descriptor(ref.id);
		const live = await service.append(ref.id, "after", snapshot.length);
		const catchup = await service.getTextDocumentRange("self", ref.id, 0, snapshot.length);
		expect(`${catchup.text}after`).toBe("beforeafter");
		expect(live.offset).toBe(snapshot.length);
		expect(snapshot.length).toBe(6);
		expect(snapshot).not.toHaveProperty("preview");
	});

	test("handoff aliases exact persisted row only after durable range reading succeeds", async () => {
		const saved = "persisted\r\n\ud800";
		const { service, directory } = await create({
			memoryBytes: 1,
			readPersisted: async (source, offset, limit) => {
				expect(source.toolCallId).toBe("row1");
				expect(source.messageId).toBe("message1");
				expect(source.executionAttempt).toBe(2);
				return { text: saved.slice(offset, offset + limit), length: saved.length };
			},
		});
		const ref = service.create(identity, "attempt2");
		await service.append(ref.id, saved, 0, true);
		await service.handoff(
			ref.id,
			{ toolCallId: "row1", messageId: "message1", executionAttempt: 2 },
			saved.length,
		);
		expect(await readdir(directory)).toEqual([]);
		await service.discardUnpersisted("self");
		expect((await service.getTextDocumentRange("self", ref.id)).text).toBe(saved);
	});

	test("large persisted aliases keep bounded disk seek instead of parsing full SQLite JSON for each range", async () => {
		let detailReads = 0;
		const { service } = await create({
			readPersisted: async () => {
				detailReads++;
				throw new Error("large row must not be read");
			},
		});
		const raw = "中\r\n\ud800".repeat(70000);
		const ref = service.create(identity, "large-final");
		await service.append(ref.id, raw, 0, true);
		await service.handoff(
			ref.id,
			{ toolCallId: "row", messageId: "message", executionAttempt: 1 },
			raw.length,
		);
		for (const offset of [0, Math.floor(raw.length / 2), raw.length - 32]) {
			const result = await service.getTextDocumentRange("self", ref.id, offset, 32);
			expect(result.text).toBe(raw.slice(offset, offset + 32));
		}
		expect(detailReads).toBe(0);
		expect(service.usage.memoryBytes).toBe(0);
		await service.discard(ref.id);
	});

	test("early persistence binds alias without releasing raw bytes while permission edits can mutate the row", async () => {
		let persisted = "same-prefix-before";
		const { service } = await create({
			memoryBytes: 1,
			readPersisted: async (_source, offset, limit) => ({
				text: persisted.slice(offset, offset + limit),
				length: persisted.length,
			}),
		});
		const ref = service.create(identity, "attempt-before-permission");
		await service.append(ref.id, persisted, 0, true);
		await service.handoff(
			ref.id,
			{ toolCallId: "row", messageId: "message", executionAttempt: 1 },
			persisted.length,
			false,
		);
		persisted = "same-prefix-after!";
		expect((await service.getTextDocumentRange("self", ref.id)).text).toBe("same-prefix-before");
		expect(await service.matches(ref.id, persisted)).toBe(false);
		const edited = service.create(identity, "attempt-permission-edited");
		await service.append(edited.id, persisted, 0, true);
		await service.handoff(
			edited.id,
			{ toolCallId: "row", messageId: "message", executionAttempt: 1 },
			persisted.length,
		);
		expect(edited.epoch).not.toBe(ref.epoch);
		expect((await service.getTextDocumentRange("self", edited.id)).text).toBe(persisted);
		await service.discard(ref.id);
	});

	test("read and alias probe deadline are retryable without losing a complete source", async () => {
		let stalled = false;
		const { service } = await create({
			readTimeoutMs: 5,
			readPersisted: async (_source, _offset, _limit, signal) => {
				if (stalled)
					return await new Promise<never>((_resolve, reject) =>
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
					);
				return { text: "x", length: 1 };
			},
		});
		const ref = service.create(identity, "attempt");
		await service.append(ref.id, "x", 0, true);
		await service.handoff(ref.id, { toolCallId: "row", messageId: "message" }, 1);
		stalled = true;
		await expect(service.getTextDocumentRange("self", ref.id)).rejects.toMatchObject({
			code: "TEXT_DOCUMENT_READ_TIMEOUT",
		});
		stalled = false;
		expect((await service.getTextDocumentRange("self", ref.id)).text).toBe("x");
		const pending = service.create(identity, "probe-timeout");
		await service.append(pending.id, "x", 0, true);
		stalled = true;
		await service.handoff(pending.id, { toolCallId: "row2", messageId: "message2" }, 1);
		expect((await service.getTextDocumentRange("self", pending.id)).text).toBe("x");
	});

	test("closed-field to persistence gap keeps complete source; failed handoff never drops it", async () => {
		const { service } = await create({
			memoryBytes: 1,
			readPersisted: async () => {
				throw new Error("detail too large");
			},
		});
		const ref = service.create(identity, "attempt");
		await service.append(ref.id, "complete", 0, true);
		expect((await service.getTextDocumentRange("self", ref.id)).text).toBe("complete");
		await service.handoff(ref.id, { toolCallId: "row", messageId: "message" }, 8);
		expect((await service.getTextDocumentRange("self", ref.id)).text).toBe("complete");
		await service.discard(ref.id);
	});

	test("range packet fits even all lone surrogates and clamps huge requested limit", async () => {
		const { service } = await create();
		const ref = service.create(identity, "attempt");
		await service.append(ref.id, "\ud800".repeat(16000));
		const range = await service.getTextDocumentRange("self", ref.id, 0, 99999);
		expect(range.text.length).toBe(8192);
		expect(Buffer.byteLength(JSON.stringify(range))).toBeLessThan(TEXT_DOCUMENT_PACKET_BYTES);
		expect(parseTextDocumentRangeQuery({})).toEqual({ offset: 0, limit: 8192 });
		for (const offset of ["NaN", "-1", "1.5"])
			expect(() => parseTextDocumentRangeQuery({ offset })).toThrow();
	});

	test("read timeout and abort are retryable and do not drop source", async () => {
		const { service } = await create({
			readTimeoutMs: 5,
			readPersisted: async () => ({ text: "a", length: 1 }),
		});
		const ref = service.create(identity, "attempt");
		await service.append(ref.id, "a");
		await service.handoff(ref.id, { toolCallId: "row", messageId: "message" }, 1);
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			service.getTextDocumentRange("self", ref.id, 0, 1, controller.signal),
		).rejects.toThrow("cancelled");
		expect((await service.getTextDocumentRange("self", ref.id)).text).toBe("a");
	});

	test("startup and lifecycle cleanup only touch dedicated owned files", async () => {
		const { service, directory } = await create({ memoryBytes: 1 });
		await writeFile(join(directory, "user-file.txt"), "not ours");
		const ref = service.create(identity, "cancelled");
		await service.append(ref.id, "body");
		await service.discardUnpersisted("self");
		expect(await readdir(directory)).toEqual(["user-file.txt"]);
		await expect(service.getTextDocumentRange("self", ref.id)).rejects.toMatchObject({
			statusCode: 404,
		});
	});
});
