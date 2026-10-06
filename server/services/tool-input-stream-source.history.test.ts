import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type HistoricalWriteDocumentIdentity,
	parseHistoricalWriteDocumentReference,
	streamHistoricalWriteContent,
	ToolInputStreamSourceService,
} from "./tool-input-stream-source";

const identity: HistoricalWriteDocumentIdentity = {
	narratorId: "original-author",
	toolUseId: "provider:id",
	toolName: "Write",
	toolCallId: "exact-row",
	messageId: "exact-message",
	executionAttempt: 2,
};
const reference = {
	toolCallId: identity.toolCallId,
	messageId: identity.messageId,
	executionAttempt: 2,
};
const resources: Array<{
	directory: string;
	service: ToolInputStreamSourceService;
	refs: string[];
}> = [];

async function fixture(text: string, otherInput = "") {
	const directory = await mkdtemp(join(tmpdir(), "nf-source-history-test-"));
	const databasePath = join(directory, "isolated-fixture.sqlite");
	// Deliberately not the user's database: this minimal fixture has no migrations or production writes.
	const database = new Database(databasePath);
	database.run(
		"CREATE TABLE bodies (id TEXT PRIMARY KEY, narrator_id TEXT, message_id TEXT, tool_use_id TEXT, execution_attempt INTEGER, tool_name TEXT, input_json TEXT)",
	);
	database.run("INSERT INTO bodies VALUES (?, ?, ?, ?, ?, ?, ?)", [
		identity.toolCallId,
		identity.narratorId,
		identity.messageId,
		identity.toolUseId,
		identity.executionAttempt,
		"Write",
		JSON.stringify({ content: text, other: otherInput }),
	]);
	// Any accidental full-row/other-field query fails, instead of silently materializing unrelated data.
	database.run(
		"CREATE VIEW narrator_tool_calls AS SELECT *, json('FORBIDDEN_OTHER_FIELD_READ') AS output_json FROM bodies",
	);
	expect(() => database.query("SELECT output_json FROM narrator_tool_calls").get()).toThrow();
	database.close();
	let workers = 0;
	const service = new ToolInputStreamSourceService({
		directory,
		memoryBytes: 64,
		loadHistoricalIdentity: async (narratorId) => {
			if (narratorId !== "reader-with-ref") throw new Error("denied before worker");
			return identity;
		},
		streamHistorical: async (row, sink, signal) => {
			workers++;
			await streamHistoricalWriteContent(databasePath, row, sink, signal);
		},
	});
	const resource = { directory, service, refs: [] as string[] };
	resources.push(resource);
	return { ...resource, databasePath, workers: () => workers };
}

afterEach(async () => {
	for (const resource of resources.splice(0)) {
		for (const ref of resource.refs) await resource.service.discard(ref);
		await rm(resource.directory, { recursive: true, force: true });
	}
});

describe("historical Write regeneration", () => {
	test("readonly Worker selects only input_json, parses once and preserves raw UTF16 across bounded pages", async () => {
		const raw = "首\r\n\ud800\ud83d\ude00尾".repeat(30000);
		const { service, refs, workers } = await fixture(raw, "unrelated".repeat(150000));
		const ref = await service.ensureWriteDocumentSource(
			"reader-with-ref",
			identity.toolUseId,
			reference,
		);
		refs.push(ref.id);
		expect(ref.complete).toBe(true);
		expect(ref.length).toBe(raw.length);
		expect(ref.source?.narratorId).toBe("reader-with-ref");
		for (const offset of [0, 8191, Math.floor(raw.length / 2), raw.length - 64]) {
			expect((await service.getTextDocumentRange("reader-with-ref", ref.id, offset, 64)).text).toBe(
				raw.slice(offset, offset + 64),
			);
		}
		const again = await service.ensureWriteDocumentSource(
			"reader-with-ref",
			identity.toolUseId,
			reference,
		);
		expect(again.id).toBe(ref.id);
		expect(workers()).toBe(1);
		expect(service.usage.memoryBytes).toBeLessThanOrEqual(64);
	});

	test("same-row input rewrite invalidates an in-flight rebuild and retry reads the new full body", async () => {
		const directory = await mkdtemp(join(tmpdir(), "nf-source-generation-test-"));
		let canonical = "old canonical body";
		let release!: () => void;
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		let began!: () => void;
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		let first = true;
		const service = new ToolInputStreamSourceService({
			directory,
			loadHistoricalIdentity: async () => identity,
			streamHistorical: async (_row, sink) => {
				const captured = canonical;
				await sink(captured, 0);
				if (first) {
					first = false;
					began();
					await paused;
				}
			},
		});
		const refs: string[] = [];
		resources.push({ directory, service, refs });
		const oldRequest = service.ensureWriteDocumentSource(
			"reader-with-ref",
			identity.toolUseId,
			reference,
		);
		await started;
		canonical = "new authoritative full body\r\n\ud800";
		const live = service.create(
			{ narratorId: "original-author", toolUseId: identity.toolUseId, field: "content" },
			"live-final-persistence",
		);
		refs.push(live.id);
		await service.append(live.id, canonical, 0, true);
		await service.handoff(live.id, reference, canonical.length, true);
		await expect(oldRequest).rejects.toMatchObject({ code: "TEXT_DOCUMENT_HISTORY_CHANGED" });
		release();
		await new Promise((resolve) => setImmediate(resolve));
		const rebuilt = await service.ensureWriteDocumentSource(
			"reader-with-ref",
			identity.toolUseId,
			reference,
		);
		refs.push(rebuilt.id);
		expect((await service.getTextDocumentRange("reader-with-ref", rebuilt.id)).text).toBe(
			canonical,
		);
	});

	test.each([
		"length-mismatch",
		"pending-tail",
	])("handoff entry fences old historical publication even with %s", async (mode) => {
		const directory = await mkdtemp(join(tmpdir(), "nf-source-entry-fence-test-"));
		let canonical = "old historical bytes";
		let releaseOld!: () => void;
		const oldWorkerGate = new Promise<void>((resolve) => {
			releaseOld = resolve;
		});
		let began!: () => void;
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		let first = true;
		const service = new ToolInputStreamSourceService({
			directory,
			loadHistoricalIdentity: async () => identity,
			streamHistorical: async (_row, sink) => {
				const captured = canonical;
				await sink(captured, 0);
				if (first) {
					first = false;
					began();
					await oldWorkerGate;
				}
			},
		});
		const refs: string[] = [];
		resources.push({ directory, service, refs });
		const oldRequest = service
			.ensureWriteDocumentSource("reader-with-ref", identity.toolUseId, reference)
			.then(
				() => ({ code: "UNEXPECTED_STALE_PUBLICATION" }),
				(error: { code: string }) => error,
			);
		await started;
		canonical = "new complete canonical bytes\r\n\ud800";
		const live = service.create(
			{ narratorId: identity.narratorId, toolUseId: identity.toolUseId, field: "content" },
			"corrected-live-source",
		);
		refs.push(live.id);
		await service.append(live.id, canonical, 0, true);
		let releaseTail!: () => void;
		if (mode === "pending-tail") {
			// Controlled equivalent of an admitted async spill write that has not finished yet.
			const state = (
				service as unknown as { sources: Map<string, { tail: Promise<void> }> }
			).sources.get(live.id);
			if (!state) throw new Error("missing live source");
			state.tail = new Promise<void>((resolve) => {
				releaseTail = resolve;
			});
		}
		let finished = false;
		const handoff = service
			.handoff(live.id, reference, canonical.length + (mode === "length-mismatch" ? 1 : 0), false)
			.then(
				() => {
					finished = true;
					return { code: "SUCCESS" };
				},
				(error: { code: string }) => {
					finished = true;
					return error;
				},
			);
		// Let the OLD extractor finish while handoff is still pending or has already failed validation.
		releaseOld();
		expect(await oldRequest).toMatchObject({ code: "TEXT_DOCUMENT_HISTORY_CHANGED" });
		if (mode === "pending-tail") {
			expect(finished).toBe(false);
			releaseTail();
			expect((await handoff).code).toBe("SUCCESS");
		} else expect((await handoff).code).toBe("TEXT_DOCUMENT_HANDOFF_MISMATCH");
		await new Promise((resolve) => setImmediate(resolve));
		const rebuilt = await service.ensureWriteDocumentSource(
			"reader-with-ref",
			identity.toolUseId,
			reference,
		);
		refs.push(rebuilt.id);
		expect((await service.getTextDocumentRange("reader-with-ref", rebuilt.id)).text).toBe(
			canonical,
		);
	});

	test("expired ref is regenerable by exact persisted identity, not permanently missing", async () => {
		const { service, refs, workers } = await fixture("complete old historical body\r\n\udfff");
		const first = await service.ensureWriteDocumentSource(
			"reader-with-ref",
			identity.toolUseId,
			reference,
		);
		refs.push(first.id);
		await service.cleanupExpired(Date.now() + 25 * 60 * 60 * 1000);
		await expect(service.getTextDocumentRange("reader-with-ref", first.id)).rejects.toMatchObject({
			statusCode: 404,
		});
		const rebuilt = await service.ensureWriteDocumentSource(
			"reader-with-ref",
			identity.toolUseId,
			reference,
		);
		refs.push(rebuilt.id);
		expect(rebuilt.epoch).not.toBe(first.epoch);
		expect((await service.getTextDocumentRange("reader-with-ref", rebuilt.id)).text).toBe(
			"complete old historical body\r\n\udfff",
		);
		expect(workers()).toBe(2);
	});

	test("wrong viewer/row/message/attempt are rejected before any historical payload worker runs", async () => {
		const { service, workers } = await fixture("private body");
		await expect(
			service.ensureWriteDocumentSource("outsider", identity.toolUseId, reference),
		).rejects.toThrow("denied");
		for (const change of [
			{ toolCallId: "wrong-row" },
			{ messageId: "wrong-message" },
			{ executionAttempt: 1 },
		]) {
			await expect(
				service.ensureWriteDocumentSource("reader-with-ref", identity.toolUseId, {
					...reference,
					...change,
				}),
			).rejects.toMatchObject({ statusCode: 404 });
		}
		expect(workers()).toBe(0);
		expect(() =>
			parseHistoricalWriteDocumentReference({ toolCallId: "row", messageId: "msg" }),
		).toThrow();
	});

	test("queued regeneration and cancellation leave no partial published source and permit retry", async () => {
		const { directory } = await fixture("unused fixture");
		let stopped = false;
		let began!: () => void;
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		const service = new ToolInputStreamSourceService({
			directory,
			loadHistoricalIdentity: async () => identity,
			streamHistorical: async (_row, sink, signal) => {
				await sink("partial", 0);
				await new Promise<void>((resolve, reject) => {
					if (stopped) {
						resolve();
						return;
					}
					signal.addEventListener(
						"abort",
						() => {
							stopped = true;
							reject(signal.reason);
						},
						{ once: true },
					);
					began();
				});
			},
		});
		const refs: string[] = [];
		resources.push({ directory, service, refs });
		const controller = new AbortController();
		const cancelled = service.ensureWriteDocumentSource(
			"reader-with-ref",
			identity.toolUseId,
			reference,
			controller.signal,
		);
		await started;
		controller.abort(new Error("user cancel"));
		await expect(cancelled).rejects.toThrow("user cancel");
		await new Promise((resolve) => setImmediate(resolve));
		expect(service.usage.sources).toBe(0);
		expect((await readdir(directory)).filter((name) => name.startsWith("nf-tool-input-"))).toEqual(
			[],
		);
		const retry = await service.ensureWriteDocumentSource(
			"reader-with-ref",
			identity.toolUseId,
			reference,
		);
		refs.push(retry.id);
		expect((await service.getTextDocumentRange("reader-with-ref", retry.id)).text).toBe("partial");
	});

	test("4097 completed aliases use LRU regeneration rather than blocking normal production; active field remains", async () => {
		const directory = await mkdtemp(join(tmpdir(), "nf-source-lru-test-"));
		const service = new ToolInputStreamSourceService({
			directory,
			loadHistoricalIdentity: async (_narrator, toolUseId, ref) => ({
				...ref,
				narratorId: "author",
				toolUseId,
				toolName: "Write",
			}),
			streamHistorical: async (_row, sink) => {
				await sink("x", 0);
			},
		});
		const refs: string[] = [];
		resources.push({ directory, service, refs });
		const active = service.create(
			{ narratorId: "reader", toolUseId: "active-tool", field: "content" },
			"active-session",
		);
		refs.push(active.id);
		await service.append(active.id, "active");
		let firstId = "";
		for (let index = 0; index < 4097; index++) {
			const ref = await service.ensureWriteDocumentSource("reader", "tool", {
				toolCallId: `row-${index}`,
				messageId: "message",
				executionAttempt: 1,
			});
			refs.push(ref.id);
			if (index === 0) firstId = ref.id;
		}
		expect(service.usage.sources).toBeLessThanOrEqual(4096);
		expect((await service.getTextDocumentRange("reader", active.id)).text).toBe("active");
		await expect(service.getTextDocumentRange("reader", firstId)).rejects.toMatchObject({
			statusCode: 404,
		});
		const fresh = await service.ensureWriteDocumentSource("reader", "tool", {
			toolCallId: "row-0",
			messageId: "message",
			executionAttempt: 1,
		});
		refs.push(fresh.id);
		expect(fresh.id).not.toBe(firstId);
		expect((await service.getTextDocumentRange("reader", fresh.id)).text).toBe("x");
	});
});
