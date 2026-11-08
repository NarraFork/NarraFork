/** Streaming, quota accounting, cancellation and disk-backed attachment claims. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, resolve, win32 } from "node:path";
import {
	discardStagedAttachment,
	findStagedAttachment,
	getStagedAttachmentsDir,
	isStagedAttachment,
	isWithinStagingRoot,
	pendingStagedUploads,
	releaseStagedAttachment,
	STAGED_ATTACHMENT_TTL_MS,
	sanitizeAttachmentFilename,
	setStagedAttachmentCeilingForTests,
	setStagedAttachmentLimitsForTests,
	setStagedAttachmentsDirForTests,
	stageAttachment,
	stagedAttachmentAsFile,
	sweepStagedAttachments,
} from "../attachment-staging";

let root: string;

beforeEach(() => {
	root = mkdtempSync(resolve(tmpdir(), "nf-staging-"));
	setStagedAttachmentsDirForTests(root);
});

afterEach(() => {
	setStagedAttachmentsDirForTests(null);
	// The ceiling override is process-global; leaving it set would shrink the
	// limit for every later test in the same worker.
	setStagedAttachmentCeilingForTests(null);
	setStagedAttachmentLimitsForTests();
	rmSync(root, { recursive: true, force: true });
});

/** A body that yields `chunks` of `chunkSize` bytes, one at a time. */
function chunkedBody(chunks: number, chunkSize: number): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= chunks) {
				controller.close();
				return;
			}
			sent++;
			controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
		},
	});
}

async function stageOf(bytes: number, name = "log.txt") {
	return stageAttachment(chunkedBody(Math.ceil(bytes / 1024), 1024), {
		narratorId: "narr1",
		filename: name,
	});
}

describe("staging a body", () => {
	test("streams an attachment above the old 100 MiB limit", async () => {
		const bytes = 101 * 1024 * 1024;
		const staged = await stageAttachment(chunkedBody(bytes / (64 * 1024), 64 * 1024), {
			narratorId: "narr1",
			filename: "large.bin",
		});
		expect(staged.size).toBe(bytes);
		expect(statSync(staged.path).size).toBe(bytes);
		expect(findStagedAttachment("narr1", staged.uploadId)?.size).toBe(bytes);
	}, 20_000);

	test("writes the streamed bytes and reports the real size", async () => {
		const staged = await stageOf(64 * 1024);
		expect(staged.size).toBe(64 * 1024);
		expect(statSync(staged.path).size).toBe(64 * 1024);
		expect(existsSync(staged.path)).toBe(true);
	});

	test("keeps the declared filename and media type for the claim", async () => {
		const staged = await stageAttachment(chunkedBody(2, 1024), {
			narratorId: "narr1",
			filename: "构建日志.log",
			mediaType: "text/plain",
		});
		expect(staged.filename).toBe("构建日志.log");
		expect(staged.mediaType).toBe("text/plain");

		// The values must survive a fresh lookup, because the claim happens in a
		// different request than the upload and may follow a restart.
		const found = findStagedAttachment("narr1", staged.uploadId);
		expect(found?.filename).toBe("构建日志.log");
		expect(found?.mediaType).toBe("text/plain");
		expect(found?.size).toBe(2048);
	});

	test("rejects an empty body and leaves nothing on disk", async () => {
		await expect(
			stageAttachment(chunkedBody(0, 0), { narratorId: "narr1", filename: "empty.txt" }),
		).rejects.toThrow(/empty/i);
		const dir = resolve(getStagedAttachmentsDir(), "narr1");
		expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
	});

	test("an aborted upload leaves no partial file", async () => {
		const controller = new AbortController();
		const body = new ReadableStream<Uint8Array>({
			pull(stream) {
				// Enough chunks to guarantee the abort lands mid-write.
				stream.enqueue(new Uint8Array(4096).fill(0x61));
				controller.abort();
			},
		});
		await expect(
			stageAttachment(body, {
				narratorId: "narr1",
				filename: "cancel.txt",
				signal: controller.signal,
			}),
		).rejects.toThrow();
		const dir = resolve(getStagedAttachmentsDir(), "narr1");
		const remaining = existsSync(dir)
			? readdirSync(dir).filter((entry) => entry.endsWith(".upload"))
			: [];
		expect(remaining).toEqual([]);
	});
});

describe("ceilings", () => {
	test("counts streamed bytes rather than trusting Content-Length", async () => {
		// The header claims one byte while the body streams past the ceiling. Only
		// the live count is trustworthy, so the header must not be believed.
		setStagedAttachmentCeilingForTests(2048);
		await expect(
			stageAttachment(chunkedBody(4, 1024), {
				narratorId: "narr1",
				filename: "liar.bin",
				declaredLength: 1,
			}),
		).rejects.toThrow(/exceeds/i);
		// The partial write must be gone: a truncated upload is invisible garbage.
		expect(pendingStagedUploads("narr1")).toEqual({ count: 0, bytes: 0 });
	});

	test("a body exactly at the ceiling is accepted", async () => {
		setStagedAttachmentCeilingForTests(4096);
		const staged = await stageAttachment(chunkedBody(4, 1024), {
			narratorId: "narr1",
			filename: "exact.bin",
		});
		expect(staged.size).toBe(4096);
	});

	test("a declared length above the per-file ceiling is refused before any write", async () => {
		const { MAX_TEXT_FILE_SIZE } = await import("@shared/text-file-types");
		await expect(
			stageAttachment(chunkedBody(1, 1024), {
				narratorId: "narr1",
				filename: "huge.bin",
				declaredLength: MAX_TEXT_FILE_SIZE + 1,
			}),
		).rejects.toThrow(/limit/i);
		const dir = resolve(getStagedAttachmentsDir(), "narr1");
		expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
	});

	test("an unparsable declared length is refused", async () => {
		await expect(
			stageAttachment(chunkedBody(1, 1024), {
				narratorId: "narr1",
				filename: "x.bin",
				declaredLength: Number.NaN,
			}),
		).rejects.toThrow(/Content-Length/i);
	});

	test("pending count is bounded", async () => {
		const { MAX_PENDING_STAGED_ATTACHMENTS } = await import("@shared/text-file-types");
		for (let i = 0; i < MAX_PENDING_STAGED_ATTACHMENTS; i++) {
			await stageOf(1024, `f${i}.txt`);
		}
		expect(pendingStagedUploads("narr1").count).toBe(MAX_PENDING_STAGED_ATTACHMENTS);
		await expect(stageOf(1024, "one-too-many.txt")).rejects.toThrow(/Too many pending/i);
	});
});

describe("narrator isolation", () => {
	test("an id staged for one narrator is not visible to another", async () => {
		const staged = await stageOf(1024);
		expect(findStagedAttachment("narr2", staged.uploadId)).toBeNull();
		expect(findStagedAttachment("narr1", staged.uploadId)?.uploadId).toBe(staged.uploadId);
	});

	test("a traversal-shaped upload id resolves to nothing", async () => {
		expect(findStagedAttachment("narr1", "../../etc/passwd")).toBeNull();
		// The discard path is the dangerous one: it deletes rather than reads.
		discardStagedAttachment("narr1", "../../etc/passwd");
		expect(existsSync("/etc/passwd")).toBe(true);
	});
});

describe("disk-backed File", () => {
	test("reports the staged name, size and media type", async () => {
		const staged = await stageAttachment(chunkedBody(3, 2048), {
			narratorId: "narr1",
			filename: "notes.md",
			mediaType: "text/markdown",
		});
		const file = stagedAttachmentAsFile(staged);
		expect(file.name).toBe("notes.md");
		expect(file.size).toBe(6 * 1024);
		expect(file.type).toBe("text/markdown");
		expect(isStagedAttachment(file)).toBe(true);
	});

	test("multipart files are never mistaken for staged ones", () => {
		expect(isStagedAttachment(new File(["x"], "plain.txt"))).toBe(false);
	});

	test("releasing deletes the staged bytes and is idempotent", async () => {
		const staged = await stageOf(4096);
		const file = stagedAttachmentAsFile(staged);
		releaseStagedAttachment(file);
		expect(existsSync(staged.path)).toBe(false);
		expect(findStagedAttachment("narr1", staged.uploadId)).toBeNull();
		// A second release must not throw: retry and cleanup both call it.
		expect(() => releaseStagedAttachment(file)).not.toThrow();
	});
});

describe("sweeping", () => {
	test("reclaims only uploads past the TTL", async () => {
		const stale = await stageOf(2048, "stale.txt");
		const fresh = await stageOf(2048, "fresh.txt");
		const staleAt = new Date(Date.now() - STAGED_ATTACHMENT_TTL_MS - 60_000);
		utimesSync(stale.path, staleAt, staleAt);
		utimesSync(resolve(stale.path.replace(/\.upload$/, ".json")), staleAt, staleAt);

		const result = await sweepStagedAttachments();
		expect(result.removed).toBe(1);
		expect(result.freedBytes).toBe(2048);
		expect(findStagedAttachment("narr1", stale.uploadId)).toBeNull();
		expect(findStagedAttachment("narr1", fresh.uploadId)?.uploadId).toBe(fresh.uploadId);
	});

	test("a sweep with nothing to do reports zero rather than throwing", async () => {
		expect(await sweepStagedAttachments()).toEqual({ removed: 0, freedBytes: 0 });
	});
});

describe("concurrent uploads", () => {
	test("reserves file slots before opening files", async () => {
		setStagedAttachmentLimitsForTests({ count: 2 });
		const uploads = Array.from({ length: 3 }, () =>
			stageAttachment(chunkedBody(1, 4), { narratorId: "narr1", filename: "small.bin" }),
		);
		const results = await Promise.allSettled(uploads);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(pendingStagedUploads("narr1")).toEqual({ count: 2, bytes: 8 });
	});

	test("unknown-length concurrent streams cannot exceed the aggregate ceiling", async () => {
		setStagedAttachmentLimitsForTests({ bytes: 6 });
		const results = await Promise.allSettled([
			stageAttachment(chunkedBody(1, 4), { narratorId: "narr1", filename: "a.bin" }),
			stageAttachment(chunkedBody(1, 4), { narratorId: "narr1", filename: "b.bin" }),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(pendingStagedUploads("narr1")).toEqual({ count: 1, bytes: 4 });
	});

	test("partial files are not counted twice at the aggregate ceiling", async () => {
		setStagedAttachmentLimitsForTests({ bytes: 8 });
		await Promise.all([
			stageAttachment(chunkedBody(2, 2), { narratorId: "narr1", filename: "a.bin" }),
			stageAttachment(chunkedBody(2, 2), { narratorId: "narr1", filename: "b.bin" }),
		]);
		expect(pendingStagedUploads("narr1")).toEqual({ count: 2, bytes: 8 });
	});

	test("reserves declared bytes before the first await", async () => {
		setStagedAttachmentLimitsForTests({ bytes: 6 });
		const first = stageAttachment(chunkedBody(1, 4), {
			narratorId: "narr1",
			filename: "a.bin",
			declaredLength: 4,
		});
		await expect(
			stageAttachment(chunkedBody(1, 4), {
				narratorId: "narr1",
				filename: "b.bin",
				declaredLength: 4,
			}),
		).rejects.toThrow(/staging byte limit/i);
		await first;
	});

	test("reader acquisition failure releases its slot", async () => {
		setStagedAttachmentLimitsForTests({ count: 1 });
		const body = chunkedBody(1, 4);
		const reader = body.getReader();
		await expect(
			stageAttachment(body, { narratorId: "narr1", filename: "locked" }),
		).rejects.toThrow();
		reader.releaseLock();
		expect(pendingStagedUploads("narr1")).toEqual({ count: 0, bytes: 0 });
		await stageAttachment(body, { narratorId: "narr1", filename: "retry" });
	});

	test("filesystem setup failure releases its slot and cancels the body", async () => {
		setStagedAttachmentLimitsForTests({ count: 1 });
		await Bun.write(resolve(root, "narr1"), "not a directory");
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		await expect(
			stageAttachment(body, { narratorId: "narr1", filename: "fail" }),
		).rejects.toThrow();
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
		expect(pendingStagedUploads("narr1")).toEqual({ count: 0, bytes: 0 });
	});
});

describe("stream cancellation", () => {
	test("a source error removes the partial file and releases its slot", async () => {
		let sent = false;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(stream) {
					if (sent) throw new Error("source failed");
					sent = true;
					stream.enqueue(new Uint8Array(2));
				},
			},
			{ highWaterMark: 0 },
		);
		await expect(
			stageAttachment(body, { narratorId: "narr1", filename: "broken" }),
		).rejects.toThrow(/source failed/);
		expect(body.locked).toBe(false);
		expect(readdirSync(resolve(root, "narr1"))).toEqual([]);
		expect(pendingStagedUploads("narr1")).toEqual({ count: 0, bytes: 0 });
	});

	test("abort cancels a hanging read even when source cancellation never resolves", async () => {
		const controller = new AbortController();
		let notifyRead = () => {};
		const reading = new Promise<void>((resolve) => {
			notifyRead = resolve;
		});
		let cancelled = false;
		let sent = false;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(stream) {
					if (!sent) {
						sent = true;
						stream.enqueue(new Uint8Array(2));
						return;
					}
					notifyRead();
					return new Promise(() => {});
				},
				cancel() {
					cancelled = true;
					return new Promise(() => {});
				},
			},
			{ highWaterMark: 0 },
		);
		const upload = stageAttachment(body, {
			narratorId: "narr1",
			filename: "hanging",
			signal: controller.signal,
		});
		void upload.catch(() => {});
		await reading;
		expect(pendingStagedUploads("narr1")).toEqual({ count: 1, bytes: 2 });
		expect(await sweepStagedAttachments(Date.now() + STAGED_ATTACHMENT_TTL_MS * 2)).toEqual({
			removed: 0,
			freedBytes: 0,
		});
		controller.abort();
		await expect(upload).rejects.toThrow();
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
		expect(readdirSync(resolve(root, "narr1"))).toEqual([]);
		expect(pendingStagedUploads("narr1")).toEqual({ count: 0, bytes: 0 });
	});

	test("a hanging stream times out and releases its reservation", async () => {
		setStagedAttachmentLimitsForTests({ timeoutMs: 20, count: 1 });
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		await expect(
			stageAttachment(body, { narratorId: "narr1", filename: "timeout" }),
		).rejects.toThrow(/timed out/i);
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
		expect(pendingStagedUploads("narr1")).toEqual({ count: 0, bytes: 0 });
		expect(readdirSync(resolve(root, "narr1"))).toEqual([]);
	});

	test("exceeding the byte ceiling cancels the source and removes partial data", async () => {
		setStagedAttachmentCeilingForTests(3);
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(stream) {
				stream.enqueue(new Uint8Array(2));
			},
			cancel() {
				cancelled = true;
			},
		});
		await expect(stageAttachment(body, { narratorId: "narr1", filename: "large" })).rejects.toThrow(
			/exceeds/i,
		);
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
		expect(readdirSync(resolve(root, "narr1"))).toEqual([]);
		expect(pendingStagedUploads("narr1")).toEqual({ count: 0, bytes: 0 });
	});
});

describe("path containment", () => {
	for (const paths of [posix, win32]) {
		test(`accepts children and rejects escapes with ${paths.sep} separators`, () => {
			const root = paths.resolve(paths === win32 ? "C:\\staging" : "/staging");
			expect(isWithinStagingRoot(root, paths.join(root, "narr1"), paths)).toBe(true);
			expect(isWithinStagingRoot(root, root, paths)).toBe(true);
			expect(isWithinStagingRoot(root, paths.join(root, "..", "escape"), paths)).toBe(false);
			expect(isWithinStagingRoot(root, `${root}-other`, paths)).toBe(false);
			if (paths === win32) expect(isWithinStagingRoot(root, "D:\\escape", paths)).toBe(false);
		});
	}
});

describe("filename sanitizing", () => {
	test("strips directory separators instead of refusing the upload", () => {
		expect(sanitizeAttachmentFilename("../../etc/passwd")).toBe("passwd");
		expect(sanitizeAttachmentFilename("C:\\temp\\report.csv")).toBe("report.csv");
	});

	test("keeps a non-ASCII name intact", () => {
		expect(sanitizeAttachmentFilename("构建日志.log")).toBe("构建日志.log");
	});

	test("falls back for an unusable name", () => {
		expect(sanitizeAttachmentFilename("")).toBe("attachment");
		expect(sanitizeAttachmentFilename("..")).toBe("attachment");
		expect(sanitizeAttachmentFilename("\u0000\u0001")).toBe("attachment");
	});

	test("bounds a pathological name", () => {
		expect(sanitizeAttachmentFilename("a".repeat(1000)).length).toBe(255);
	});
});
