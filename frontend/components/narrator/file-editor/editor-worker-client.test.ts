import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import type { editor } from "monaco-editor";
import { EditorWorkerRuntime } from "./editor-text.worker";
import {
	applyEditorReplacePlan,
	captureEditorSnapshot,
	computeEditorConflictDiff,
	EditorSearchClient,
	encodeEditorSnapshot,
	getEncodedEditorSnapshotHash,
	hashEditorSnapshot,
	WorkerChannel,
} from "./editor-worker-client";
import {
	bufferToText,
	EDITOR_WORKER_LIMITS as L,
	type ReplacePlan,
	type SearchOptions,
	textToBuffer,
	type WorkerCommand,
	type WorkerReply,
	type WorkerRequest,
} from "./editor-worker-protocol";

const query = (value: string, regexp = false): SearchOptions => ({
	query: value,
	caseSensitive: true,
	wholeWord: false,
	regexp,
});
class Model {
	value: string;
	revision = 1;
	snapshots = 0;
	private listeners = new Set<(event: editor.IModelContentChangedEvent) => void>();
	constructor(value: string) {
		this.value = value;
	}
	getVersionId = () => this.revision;
	getAlternativeVersionId = () => this.revision * 10;
	getValueLength = () => this.value.length;
	getValue = () => {
		throw new Error("full main-thread read forbidden");
	};
	isDisposed = () => false;
	getPositionAt = (offset: number) => ({ lineNumber: 1, column: offset + 1 });
	createSnapshot = () => {
		this.snapshots++;
		let value: string | null = this.value;
		return {
			read: () => {
				const current = value;
				value = null;
				return current;
			},
		};
	};
	onDidChangeContent = (listener: (event: editor.IModelContentChangedEvent) => void) => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};
	edit(offset: number, length: number, text: string) {
		this.value = this.value.slice(0, offset) + text + this.value.slice(offset + length);
		this.revision++;
		for (const listener of this.listeners)
			listener({
				versionId: this.revision,
				changes: [{ rangeOffset: offset, rangeLength: length, text }],
				isFlush: false,
			} as editor.IModelContentChangedEvent);
	}
	asModel(): editor.ITextModel {
		return this as unknown as editor.ITextModel;
	}
}
function protocol(runtime = new EditorWorkerRuntime()) {
	let sequence = 0;
	return {
		runtime,
		send: (command: WorkerCommand, revision = 1, patch: Partial<WorkerRequest> = {}) =>
			runtime.handle({
				docId: "doc",
				revision,
				jobId: "job",
				seq: sequence++,
				...command,
				...patch,
			} as WorkerRequest),
	};
}
async function initialize(send: ReturnType<typeof protocol>["send"], text: string) {
	expect(
		(await send({ type: "begin", mode: "snapshot", length: text.length, baseRevision: -1 })).ok,
	).toBe(true);
	for (let offset = 0; offset < text.length; offset += L.chunkBytes / 2)
		expect(
			(
				await send({
					type: "chunk",
					data: textToBuffer(text.slice(offset, offset + L.chunkBytes / 2)),
				})
			).ok,
		).toBe(true);
	expect((await send({ type: "commit" })).ok).toBe(true);
}

describe("bounded worker runtime protocol", () => {
	test("native UTF16 decoding preserves BOM, nulls, paired and lone/split surrogate code units", () => {
		for (const source of [
			"",
			"\ufeffplain\ufeff",
			"\0a\r\n中😀",
			"\ud800",
			"\udc00",
			"\ud800x\udc00",
			"\udc00\ud800",
			"\udc00😀\ud800",
			"\udc00\ufeffnative after invalid decode\ufeff\ud800",
			`\udc00\ufeff${"x".repeat(32765)}\ud800`,
			`${"a".repeat(32767)}\ud800`,
			`\udc00${"b".repeat(32767)}`,
			"😀".repeat(16384),
		]) {
			expect(bufferToText(textToBuffer(source))).toBe(source);
		}
		// Cover every 16-bit value, including values native decoders would repair.
		for (let base = 0; base < 65536; base += 32768) {
			const units = Uint16Array.from({ length: 32768 }, (_, index) => base + index);
			expect(new Uint16Array(textToBuffer(bufferToText(units.buffer)))).toEqual(units);
		}
	});
	test("rejects sequence gaps, late documents/revisions, oversized metadata and chunks", async () => {
		const { send } = protocol();
		await initialize(send, "abc");
		expect(await send({ type: "encode" }, 1, { docId: "other" })).toMatchObject({
			ok: false,
			error: "EDITOR_STALE",
		});
		expect(await send({ type: "encode" }, 2)).toMatchObject({ ok: false, error: "EDITOR_STALE" });
		expect(await send({ type: "encode" }, 1, { seq: 100 })).toMatchObject({
			ok: false,
			error: "EDITOR_PROTOCOL",
		});
		const oversized = protocol();
		expect(
			await oversized.send({
				type: "search",
				options: query("\u0001".repeat(4096)),
				anchor: 0,
				backwards: false,
				selectAll: false,
			}),
		).toMatchObject({ ok: false, error: "EDITOR_METADATA_LIMIT" });
		const chunks = protocol();
		await chunks.send({ type: "begin", mode: "snapshot", length: 50000, baseRevision: -1 });
		expect(
			await chunks.send({ type: "chunk", data: new ArrayBuffer(L.chunkBytes + 2) }),
		).toMatchObject({ ok: false, error: "EDITOR_PROTOCOL" });
	});
	test("truncated snapshots/edits fail commit and never become searchable", async () => {
		const { send } = protocol();
		await send({ type: "begin", mode: "snapshot", length: 4, baseRevision: -1 });
		await send({ type: "chunk", data: textToBuffer("abc") });
		expect(await send({ type: "commit" })).toMatchObject({ ok: false, error: "EDITOR_PROTOCOL" });
		expect(
			await send({
				type: "search",
				options: query("a"),
				anchor: 0,
				backwards: false,
				selectAll: false,
			}),
		).toMatchObject({ ok: false, error: "EDITOR_PROTOCOL" });
	});
	test("large edit is invisible until a complete revision commit", async () => {
		const { send } = protocol();
		await initialize(send, "abc");
		await send({ type: "begin", mode: "changes", baseRevision: 1, length: 70002 }, 2);
		await send({ type: "edit", edit: { offset: 1, length: 1, textLength: 70000 } }, 2);
		for (const text of ["x".repeat(32768), "x".repeat(32768), "x".repeat(4464)])
			await send({ type: "chunk", data: textToBuffer(text) }, 2);
		expect((await send({ type: "commit" }, 2)).ok).toBe(true);
		expect(
			await send(
				{ type: "search", options: query("xc"), anchor: 0, backwards: false, selectAll: false },
				2,
			),
		).toMatchObject({ ok: true, value: { matches: [{ offset: 70000, length: 2 }] } });
	});
});

describe("real Worker search and immutable snapshot export", () => {
	test("captured export is bounded, fixed during later input and UTF8 encoded in a Worker", async () => {
		const original = `${"a".repeat(32767)}😀中\r\n${"z".repeat(40000)}`;
		const model = new Model(original);
		const snapshot = captureEditorSnapshot(model.asModel());
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(snapshot.revision).toBe(1);
		expect(snapshot.alternativeVersionId).toBe(10);
		model.edit(0, 1, "changed");
		const blob = await encodeEditorSnapshot(snapshot);
		expect(await blob.text()).toBe(original);
		expect(blob.size).toBe(new TextEncoder().encode(original).length);
		expect(snapshot.read()).toBeNull();
	}, 10000);
	test("successive search sends changes only, supports large paste and complete replacement plan", async () => {
		const model = new Model("abc abc");
		const client = new EditorSearchClient(model.asModel());
		try {
			expect((await client.search(query("abc"))).count).toBe(2);
			expect(model.snapshots).toBe(1);
			model.edit(4, 3, `${"x".repeat(70000)}😀abc`);
			expect((await client.search(query("😀abc"))).matches[0].offset).toBe(70004);
			expect(model.snapshots).toBe(1);
			const plan = await client.replace(query("abc"), "中文", true);
			expect(plan.revision).toBe(2);
			expect(plan.edits).toHaveLength(2);
			expect(plan.edits.every((edit) => edit.text === "中文")).toBe(true);
			expect(model.snapshots).toBe(1);
		} finally {
			client.dispose();
		}
	}, 10000);
	test("4096 control characters and Chinese query/replacement remain binary, not huge metadata", async () => {
		const value = "\u0001".repeat(4096);
		const model = new Model(value);
		const client = new EditorSearchClient(model.asModel());
		try {
			expect((await client.search(query(value))).count).toBe(1);
			const plan = await client.replace(query(value), "中".repeat(4096), true);
			expect(plan.edits[0].text).toBe("中".repeat(4096));
		} finally {
			client.dispose();
		}
	}, 10000);
	test("stalled search transport is terminated at two seconds, next query rebuilds the mirror", async () => {
		const model = new Model("abc!");
		const client = new EditorSearchClient(model.asModel());
		const postMessage = Worker.prototype.postMessage as (
			this: Worker,
			message: unknown,
			transfer?: Transferable[] | StructuredSerializeOptions,
		) => void;
		let stalledWorker: Worker | undefined;
		const transport = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			message: unknown,
			transfer?: Transferable[] | StructuredSerializeOptions,
		) {
			// Engine regex optimizations are not a deadline contract. Withhold exactly
			// one search from the real transport; initialization and recovery stay real.
			if (!stalledWorker && (message as WorkerRequest).type === "search") {
				stalledWorker = this;
				return;
			}
			return postMessage.call(this, message, transfer);
		});
		const terminate = spyOn(Worker.prototype, "terminate");
		try {
			const start = performance.now();
			await expect(client.search(query("!"))).rejects.toThrow("EDITOR_SEARCH_TIMEOUT");
			const elapsed = performance.now() - start;
			expect(elapsed).toBeGreaterThanOrEqual(L.searchTimeout);
			expect(elapsed).toBeLessThan(3500);
			expect(stalledWorker).toBeDefined();
			expect(terminate.mock.contexts).toContain(stalledWorker);
			expect((await client.search(query("!"))).count).toBe(1);
			expect(model.snapshots).toBe(2);
		} finally {
			transport.mockRestore();
			terminate.mockRestore();
			client.dispose();
		}
	}, 8000);
	test("cancellation terminates a stuck regex promptly and stale editing rejects results", async () => {
		const model = new Model(`${"a".repeat(100)}!`);
		const client = new EditorSearchClient(model.asModel());
		try {
			await client.search(query("!"));
			const cancel = new AbortController();
			const pending = client.search(query("(a*)*$", true), 0, false, cancel.signal);
			setTimeout(() => cancel.abort(), 30);
			const start = performance.now();
			await expect(pending).rejects.toThrow();
			expect(performance.now() - start).toBeLessThan(300);
			const stale = client.search(query("!"));
			model.edit(0, 0, "x");
			await expect(stale).rejects.toThrow("EDITOR_STALE");
			expect((await client.search(query("!"))).count).toBe(1);
		} finally {
			client.dispose();
		}
	}, 10000);
});

test("unpaired UTF16 remains searchable but export/hash reject without publishing a Blob", async () => {
	const original = `${"valid\n".repeat(12000)}\ud800`;
	const model = new Model(original);
	const client = new EditorSearchClient(model.asModel());
	let published: Blob | null = null;
	try {
		expect((await client.search(query("\ud800"))).matches).toEqual([
			{ offset: original.length - 1, length: 1 },
		]);
		let exportError: unknown;
		try {
			published = await encodeEditorSnapshot(captureEditorSnapshot(model.asModel()));
		} catch (error) {
			exportError = error;
		}
		expect(exportError).toBeInstanceOf(Error);
		expect((exportError as Error).message).toBe("EDITOR_INVALID_UNICODE");
		expect(published).toBeNull();
		await expect(hashEditorSnapshot(captureEditorSnapshot(model.asModel()))).rejects.toThrow(
			"EDITOR_INVALID_UNICODE",
		);
		await expect(client.replace(query("valid"), "still valid", false)).rejects.toThrow(
			"EDITOR_INVALID_UNICODE",
		);
		expect(model.value).toBe(original);
		const replacementCharacter = new Model("\ufffd");
		const blob = await encodeEditorSnapshot(captureEditorSnapshot(replacementCharacter.asModel()));
		expect(await blob.text()).toBe("\ufffd");
		expect(getEncodedEditorSnapshotHash(blob)).toBe(
			createHash("sha256").update("\ufffd").digest("hex"),
		);
	} finally {
		client.dispose();
	}
}, 10000);

test("HTTP contexts without crypto.randomUUID/subtle can search, export and hash fixed snapshots", async () => {
	const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
	const value = `${"x".repeat(32767)}😀中文`;
	const model = new Model(value);
	const client = new EditorSearchClient(model.asModel());
	try {
		expect((await client.search(query("中文"))).count).toBe(1);
		const expected = createHash("sha256").update(value).digest("hex");
		const snapshot = captureEditorSnapshot(model.asModel());
		model.edit(0, 1, "newer");
		expect(await hashEditorSnapshot(snapshot)).toBe(expected);
		const blob = await encodeEditorSnapshot(captureEditorSnapshot(model.asModel()));
		expect(getEncodedEditorSnapshotHash(blob)).toBe(
			createHash("sha256").update(model.value).digest("hex"),
		);
		expect(getEncodedEditorSnapshotHash(new Blob(["unknown"]))).toBeNull();
	} finally {
		client.dispose();
		if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
	}
}, 10000);

describe("same-pool bounded conflict diff", () => {
	test("real Worker returns display rows and marks line/row truncation", async () => {
		const result = await computeEditorConflictDiff("a\nb\n", "a\nc\n");
		expect(result.truncated).toBe(false);
		expect(result.lines.some((line) => line.type === "removed" && line.content === "b")).toBe(true);
		expect(result.lines.some((line) => line.type === "added" && line.content === "c")).toBe(true);
		const rows = await computeEditorConflictDiff("x\n".repeat(400), "y\n".repeat(400));
		expect(rows.lines.length).toBeLessThanOrEqual(300);
		expect(rows.truncated).toBe(true);
		const longLine = await computeEditorConflictDiff("x".repeat(5000), "y".repeat(5000));
		expect(longLine.truncated).toBe(true);
		await expect(computeEditorConflictDiff("x".repeat(32769), "")).rejects.toThrow(
			"EDITOR_TEXT_LIMIT",
		);
	}, 10000);
});

function ack({ docId, revision, jobId, seq }: WorkerRequest): WorkerReply {
	return { docId, revision, jobId, seq, ok: true, value: null };
}

describe("main-thread result guard and atomic edit boundary", () => {
	test("new Worker receives no document command before the explicit ready handshake", async () => {
		class Transport extends EventTarget {
			messages: WorkerRequest[] = [];
			postMessage(value: WorkerRequest) {
				this.messages.push(value);
			}
		}
		const transport = new Transport();
		const channel = new WorkerChannel(transport as unknown as Worker, () => {}, undefined, true);
		try {
			const result = channel.request("doc", 1, {
				type: "begin",
				mode: "snapshot",
				length: 0,
				baseRevision: -1,
			});
			expect(transport.messages).toHaveLength(0);
			expect(channel.diagnostics().waitingForReady).toBe(true);
			transport.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "ready", docId: "$worker", revision: 0, jobId: "$startup", seq: 0 },
				}),
			);
			await Promise.resolve();
			expect(transport.messages).toHaveLength(1);
			transport.dispatchEvent(new MessageEvent("message", { data: ack(transport.messages[0]) }));
			expect(await result).toBeNull();
			expect(channel.diagnostics().phase).toBe("mirror");
		} finally {
			channel.dispose();
		}
	});
	test("late job/doc/revision replies are ignored, a valid ACK resolves", async () => {
		class Transport extends EventTarget {
			messages: WorkerRequest[] = [];
			postMessage(value: WorkerRequest) {
				this.messages.push(value);
			}
		}
		const transport = new Transport();
		let terminated = false;
		const channel = new WorkerChannel(transport as unknown as Worker, () => {
			terminated = true;
		});
		try {
			const result = channel.request("doc", 7, { type: "encode" });
			const request = transport.messages[0];
			for (const patch of [{ jobId: "old" }, { docId: "old" }, { revision: 6 }])
				transport.dispatchEvent(
					new MessageEvent("message", { data: { ...ack(request), ...patch } }),
				);
			transport.dispatchEvent(
				new MessageEvent("message", {
					data: ack(request),
				}),
			);
			expect(await result).toBeNull();
			expect(terminated).toBe(false);
		} finally {
			channel.dispose();
		}
	});
	test("one executeEdits and two undo stops; stale/readonly/overlap rejected before mutation", () => {
		const model = new Model("abc abc");
		const calls: string[] = [];
		const instance = {
			getModel: () => model.asModel(),
			getRawOptions: () => ({ readOnly: false }),
			pushUndoStop: () => calls.push("stop"),
			executeEdits: (_source: string, edits: unknown[]) => {
				calls.push(`edit:${edits.length}`);
				return true;
			},
		} as unknown as editor.IStandaloneCodeEditor;
		const plan: ReplacePlan = {
			revision: 1,
			edits: [
				{ offset: 0, length: 3, text: "x" },
				{ offset: 4, length: 3, text: "y" },
			],
			length: 3,
			utf8Bytes: 3,
		};
		applyEditorReplacePlan(instance, plan, false);
		expect(calls).toEqual(["stop", "edit:2", "stop"]);
		calls.length = 0;
		expect(() => applyEditorReplacePlan(instance, plan, true)).toThrow("EDITOR_READ_ONLY");
		expect(() => applyEditorReplacePlan(instance, { ...plan, revision: 2 }, false)).toThrow(
			"EDITOR_STALE",
		);
		expect(() =>
			applyEditorReplacePlan(instance, { ...plan, edits: [plan.edits[1], plan.edits[0]] }, false),
		).toThrow("EDITOR_PROTOCOL");
		expect(calls).toEqual([]);
	});
});
