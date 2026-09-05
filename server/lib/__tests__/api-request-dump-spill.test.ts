/**
 * The contract this suite defends: a dump a user opens must be downloadable in full.
 *
 * Truncating a dump to fit its database row produced the failure that motivated the spill
 * store — a dump that is present, opens fine, and answers nothing, because the request body
 * it exists to show was shed to satisfy a row budget. So the assertions here are about the
 * COMPLETE copy surviving somewhere retrievable, not about the row staying small (that part
 * is a means, and is asserted only to keep the row from regrowing).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	buildRawDumpEnvelope,
	isServableDumpFilePath,
	MAX_SPILL_FILE_BYTES,
	RAW_DUMP_INLINE_MAX_BYTES,
	REQUEST_DUMP_SPILL_DIR,
	REQUEST_DUMP_SPILL_POINTER_SCHEMA,
	redactSpillPointerPaths,
	writeRawDumpSpill,
} from "@server/lib/api-request-dump-store";
import { getNarraforkPath } from "@server/lib/narrafork-home";

const spillDir = getNarraforkPath(REQUEST_DUMP_SPILL_DIR);

const meta = {
	requestId: "req_spill_test",
	narratorId: "n-1",
	kind: "narrator",
	provider: "nug2",
	model: "nug2:anthropic:claude-opus-5",
	credentialId: null,
	errorMessage: "Improperly formed request.",
	createdAt: "2026-08-19T10:47:10.832Z",
};

beforeEach(async () => {
	await rm(spillDir, { recursive: true, force: true }).catch(() => {});
});

afterEach(async () => {
	await rm(spillDir, { recursive: true, force: true }).catch(() => {});
});

describe("writeRawDumpSpill", () => {
	test("writes the dump verbatim and returns a pointer to it", async () => {
		const body = { messages: [{ role: "user", content: "X".repeat(200_000) }] };
		const dump = {
			provider: "nug2",
			request: { transport: "http", url: "https://example.invalid/v1/messages", body },
			response: { status: 200, bodyText: '{"message":"Improperly formed request."}' },
		};

		const pointer = await writeRawDumpSpill(meta, dump);
		expect(pointer).not.toBeNull();
		expect(pointer?.schema).toBe(REQUEST_DUMP_SPILL_POINTER_SCHEMA);
		expect(pointer?.inlineTruncated).toBe(true);
		expect(pointer?.bytes).toBeGreaterThan(200_000);

		const saved = JSON.parse(await readFile(pointer?.filePath as string, "utf8")) as {
			requestId: string;
			errorMessage: string;
			dump: typeof dump;
		};
		// Verbatim: the request body is the whole reason the file exists.
		expect(saved.dump.request.body).toEqual(body);
		expect(saved.dump.response.status).toBe(200);
		expect(saved.requestId).toBe(meta.requestId);
		expect(saved.errorMessage).toBe(meta.errorMessage);
	});

	test("reuses the caller's serialization instead of stringifying the dump again", async () => {
		// The dump is the multi-MB part and the caller already serialized it to decide that it
		// must spill. Re-stringifying that graph is a second full walk on the HTTP main thread,
		// which CLAUDE.md forbids at this size. Asserted through behavior: the string the caller
		// hands over is what lands in the file, byte for byte.
		const dump = { request: { body: { marker: "provided" } } };
		const dumpJson = JSON.stringify({ request: { body: { marker: "reused-verbatim" } } });

		const pointer = await writeRawDumpSpill(meta, dump, dumpJson);
		const text = await readFile(pointer?.filePath as string, "utf8");
		expect(text).toContain('"dump":{"request":{"body":{"marker":"reused-verbatim"}}}}');
		expect(text).not.toContain("provided");
		// And the envelope is still valid JSON with its metadata intact.
		const saved = JSON.parse(text) as { requestId: string; dump: unknown };
		expect(saved.requestId).toBe(meta.requestId);
	});

	test("carries the identity a forwarded dump needs", async () => {
		// A dump file gets sent to whoever is helping diagnose it, and `narratorId` alone does
		// not say which conversation, chapter, project, or account produced the request. The
		// download route's inline path supplies the same fields, so a file missing them would
		// make the two download paths disagree about what a dump contains.
		const pointer = await writeRawDumpSpill(
			{
				...meta,
				narratorTitle: "Fix the spill ceiling",
				chapterId: "ch-1",
				chapterTitle: "request dumps",
				projectId: "proj-1",
				credentialName: "work@example.invalid",
			},
			{ request: { body: {} } },
		);
		const saved = JSON.parse(await readFile(pointer?.filePath as string, "utf8")) as Record<
			string,
			unknown
		>;
		expect(saved.narratorTitle).toBe("Fix the spill ceiling");
		expect(saved.chapterTitle).toBe("request dumps");
		expect(saved.projectId).toBe("proj-1");
		expect(saved.credentialName).toBe("work@example.invalid");
	});

	test("two captures in the same millisecond do not overwrite each other", async () => {
		// Same requestId and createdAt: only the random component distinguishes the names.
		// A collision here would silently destroy the evidence someone is collecting.
		const [a, b] = await Promise.all([
			writeRawDumpSpill(meta, { marker: "first" }),
			writeRawDumpSpill(meta, { marker: "second" }),
		]);
		expect(a?.filePath).not.toBe(b?.filePath);

		const readMarker = async (path: string) =>
			(JSON.parse(await readFile(path, "utf8")) as { dump: { marker: string } }).dump.marker;
		const markers = [
			await readMarker(a?.filePath as string),
			await readMarker(b?.filePath as string),
		].sort();
		expect(markers).toEqual(["first", "second"]);
	});
});

/**
 * MAX_REQUEST_DUMP_SPILL_FILES bounds the file COUNT, not the disk. Without a per-file
 * ceiling the directory's worst case was "50 × unbounded" — and a dump's size is one request
 * body, which the server does not choose. So a file that cannot fit sheds the same way a
 * malformed-request dump does, and SAYS it did: a truncated file that looks whole is worse
 * than one that admits the gap, because it is the only copy the request has left.
 */
describe("spill file size ceiling", () => {
	test("a dump over the ceiling is truncated and both file and pointer say so", async () => {
		// The response is shed first (SSE events / body text are the least diagnostic part),
		// then the request body down to a head. Built just over the ceiling so the first
		// shedding step is the one that decides it.
		const oversizedResponse = {
			request: { url: "https://example.invalid/v1", body: { keep: "K".repeat(1024) } },
			response: {
				status: 400,
				events: [{ pad: "E".repeat(MAX_SPILL_FILE_BYTES + 1024) }],
			},
		};

		const pointer = await writeRawDumpSpill(meta, oversizedResponse);
		expect(pointer).not.toBeNull();
		expect(pointer?.truncated).toBe(true);
		expect(pointer?.originalBytes).toBeGreaterThan(MAX_SPILL_FILE_BYTES);
		// The pointer's `bytes` is what the file actually is, so it must be under the ceiling.
		expect(pointer?.bytes).toBeLessThanOrEqual(MAX_SPILL_FILE_BYTES);
		// `truncated` is distinct from `inlineTruncated` (always true, only about the row).
		expect(pointer?.inlineTruncated).toBe(true);

		const text = await readFile(pointer?.filePath as string, "utf8");
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_SPILL_FILE_BYTES);
		const saved = JSON.parse(text) as {
			truncated?: boolean;
			originalBytes?: number;
			dump?: { request?: { body?: unknown }; response?: { dropped?: boolean } };
		};
		// The file itself must carry the flag: it travels away from the row that pointed at it.
		expect(saved.truncated).toBe(true);
		expect(saved.originalBytes).toBeGreaterThan(MAX_SPILL_FILE_BYTES);
		// Shedding order: the response went, the request body — the point of a dump — stayed.
		expect(saved.dump?.response?.dropped).toBe(true);
		expect(saved.dump?.request?.body).toEqual({ keep: "K".repeat(1024) });
	});

	test("an oversized request body degrades to a truncated head rather than vanishing", async () => {
		const pointer = await writeRawDumpSpill(meta, {
			request: {
				url: "https://example.invalid/v1",
				body: { pad: "B".repeat(MAX_SPILL_FILE_BYTES) },
			},
		});
		expect(pointer?.truncated).toBe(true);
		expect(pointer?.bytes).toBeLessThanOrEqual(MAX_SPILL_FILE_BYTES);

		const saved = JSON.parse(await readFile(pointer?.filePath as string, "utf8")) as {
			dump?: { request?: { bodyTruncated?: boolean; bodyText?: string; url?: string } };
		};
		// Enough of the request survives to recognize it and read the head of its body.
		expect(saved.dump?.request?.url).toBe("https://example.invalid/v1");
		expect(saved.dump?.request?.bodyTruncated).toBe(true);
		expect(saved.dump?.request?.bodyText).toContain("BBB");
	});

	test("a dump under the ceiling is not marked truncated", async () => {
		const pointer = await writeRawDumpSpill(meta, { request: { body: { small: true } } });
		expect(pointer?.truncated).toBeUndefined();
		expect(pointer?.originalBytes).toBeUndefined();
		const saved = JSON.parse(await readFile(pointer?.filePath as string, "utf8")) as {
			truncated?: boolean;
		};
		expect(saved.truncated).toBeUndefined();
	});

	test("a failed write leaves no orphan file behind", async () => {
		// A partial file is referenced by nobody (the pointer never reaches a row) yet still
		// matches the prune pattern, so it would occupy one of the 50 slots and eventually
		// evict a dump that IS someone's evidence.
		//
		// The write is made to fail by putting a FILE where the spill directory must be, so
		// `mkdir` rejects — the realistic shape of "the directory could not be prepared".
		await rm(spillDir, { recursive: true, force: true }).catch(() => {});
		await mkdir(dirname(spillDir), { recursive: true });
		await writeFile(spillDir, "not a directory", "utf8");
		try {
			const pointer = await writeRawDumpSpill(meta, { request: { body: { a: 1 } } });
			expect(pointer).toBeNull();
			// Nothing was created next to the blocker.
			expect((await stat(spillDir)).isFile()).toBe(true);
		} finally {
			await rm(spillDir, { force: true }).catch(() => {});
		}
	});

	test("a partially written file is removed when the write itself fails", async () => {
		// Distinct from the mkdir failure above: here the file IS created and then the write
		// throws mid-stream, which is the case the old `catch` left on disk.
		const failing = {
			request: {
				body: {
					get boom(): never {
						throw new Error("serialization exploded");
					},
				},
			},
		};
		const before = await readdir(spillDir).catch(() => [] as string[]);
		const pointer = await writeRawDumpSpill(meta, failing);
		expect(pointer).toBeNull();
		const after = await readdir(spillDir).catch(() => [] as string[]);
		expect(after).toEqual(before);
	});
});

describe("isServableDumpFilePath", () => {
	test("accepts paths inside the dump directories", () => {
		expect(isServableDumpFilePath(getNarraforkPath(REQUEST_DUMP_SPILL_DIR, "a.json"))).toBe(true);
		expect(isServableDumpFilePath(getNarraforkPath("malformed-request-dumps", "b.json"))).toBe(
			true,
		);
	});

	test("refuses anything else, so a tampered row cannot read arbitrary files", () => {
		expect(isServableDumpFilePath(getNarraforkPath("settings.json"))).toBe(false);
		expect(isServableDumpFilePath("/etc/passwd")).toBe(false);
		// Traversal out of the dump dir resolves outside it and is refused.
		expect(
			isServableDumpFilePath(getNarraforkPath(REQUEST_DUMP_SPILL_DIR, "..", "settings.json")),
		).toBe(false);
		// Relative paths are refused outright: their meaning would depend on the cwd.
		expect(isServableDumpFilePath("request-dumps/a.json")).toBe(false);
		expect(isServableDumpFilePath("")).toBe(false);
	});
});

describe("buildRawDumpEnvelope", () => {
	test("carries the request identity alongside the dump", () => {
		const envelope = buildRawDumpEnvelope(meta, { hello: "world" });
		expect(envelope.requestId).toBe(meta.requestId);
		expect(envelope.provider).toBe("nug2");
		expect(envelope.dump).toEqual({ hello: "world" });
	});
});

describe("RAW_DUMP_INLINE_MAX_BYTES", () => {
	test("leaves the inline head large enough to be useful on its own", () => {
		// The head is what the detail panel shows without a download. Too small and every
		// inspection becomes a download; the value only exists to bound the row.
		expect(RAW_DUMP_INLINE_MAX_BYTES).toBeGreaterThanOrEqual(128 * 1024);
	});
});

/**
 * Absolute paths in a stored dump name the host OS account, and a dump is a file users export
 * and forward to whoever is helping them diagnose a rejection — so it travels much further
 * than the session that fetched it. Redaction is invisible either way (the UI shows the note,
 * not the path), which is why the assertions are on the returned object.
 */
describe("redactSpillPointerPaths", () => {
	const hostPath = "/home/somebody/.narrafork/request-dumps/2026-01-01T00-00-00-000Z_req_x.json";

	test("replaces the spill pointer's path with just the file name", () => {
		const out = redactSpillPointerPaths({
			request: { url: "https://example.invalid" },
			spill: {
				schema: REQUEST_DUMP_SPILL_POINTER_SCHEMA,
				filePath: hostPath,
				bytes: 900_000,
				inlineTruncated: true,
				note: "on disk",
			},
		}) as { spill: Record<string, unknown>; request: unknown };

		expect(out.spill.filePath).toBeUndefined();
		expect(out.spill.fileName).toBe("2026-01-01T00-00-00-000Z_req_x.json");
		// Everything else survives: the pointer still has to explain itself to the UI.
		expect(out.spill.inlineTruncated).toBe(true);
		expect(out.spill.bytes).toBe(900_000);
		expect(out.request).toEqual({ url: "https://example.invalid" });
	});

	/**
	 * The half-open case: `capture.filePath` is written by the malformed-request dump path and
	 * reaches clients through the same `raw_dump_json` column, but only `spill` was redacted.
	 */
	test("replaces the malformed capture's path too", () => {
		const capturePath = "/home/somebody/.narrafork/malformed-request-dumps/2026_req_y.json";
		const out = redactSpillPointerPaths({
			schema: "narrafork.malformed-request-dump.v1",
			capture: {
				reason: "malformed_request_body",
				filePath: capturePath,
				note: "Full request body saved to this file on the server",
				requestBodyChars: 4_000_000,
			},
		}) as { capture: Record<string, unknown> };

		expect(out.capture.filePath).toBeUndefined();
		expect(out.capture.fileName).toBe("2026_req_y.json");
		expect(out.capture.requestBodyChars).toBe(4_000_000);
	});

	test("redacts BOTH shapes when one dump carries them", () => {
		const out = redactSpillPointerPaths({
			capture: { reason: "malformed_request_body", filePath: "/host/a/one.json" },
			spill: {
				schema: REQUEST_DUMP_SPILL_POINTER_SCHEMA,
				filePath: "/host/b/two.json",
				bytes: 1,
				inlineTruncated: true,
				note: "n",
			},
		}) as { capture: Record<string, unknown>; spill: Record<string, unknown> };

		expect(out.capture.fileName).toBe("one.json");
		expect(out.capture.filePath).toBeUndefined();
		expect(out.spill.fileName).toBe("two.json");
		expect(out.spill.filePath).toBeUndefined();
	});

	test("leaves unrelated shapes untouched", () => {
		// Keyed on the schema / capture reason, not on "has a filePath": rewriting an unrelated
		// object that happens to carry one would corrupt a dump instead of protecting it.
		const foreign = { capture: { reason: "something_else", filePath: "/host/keep.json" } };
		expect(redactSpillPointerPaths(foreign)).toBe(foreign);

		const wrongSchema = { spill: { schema: "other.v1", filePath: "/host/keep.json" } };
		expect(redactSpillPointerPaths(wrongSchema)).toBe(wrongSchema);

		// A capture with no path at all (the write failed) has nothing to redact.
		const noPath = { capture: { reason: "malformed_request_body", filePath: null } };
		expect(redactSpillPointerPaths(noPath)).toBe(noPath);
	});

	test("does not mutate its input", () => {
		const input = {
			spill: {
				schema: REQUEST_DUMP_SPILL_POINTER_SCHEMA,
				filePath: hostPath,
				bytes: 1,
				inlineTruncated: true,
				note: "n",
			},
		};
		redactSpillPointerPaths(input);
		expect(input.spill.filePath).toBe(hostPath);
	});

	test("passes through non-objects", () => {
		expect(redactSpillPointerPaths(null)).toBeNull();
		expect(redactSpillPointerPaths("text")).toBe("text");
		expect(redactSpillPointerPaths([1, 2])).toEqual([1, 2]);
	});
});
