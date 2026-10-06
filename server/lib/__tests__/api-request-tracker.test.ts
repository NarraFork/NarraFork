import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { apiRequests, userUsageTotals } from "@server/db/schema";
import {
	clearRememberedSpills,
	RAW_DUMP_INLINE_MAX_BYTES,
	REQUEST_DUMP_SPILL_DIR,
	REQUEST_DUMP_SPILL_POINTER_SCHEMA,
} from "@server/lib/api-request-dump-store";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import { DEFAULTS, settings } from "@server/lib/settings";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("@server/db")) };
mock.module("@server/db", () => ({ ...realDbModule, db, sqlite }));

import {
	type ApiRequestFinishOptions,
	FORCED_DUMP_HARD_MAX_BYTES,
	finishApiRequest,
	isRequestDumpEnabled,
	serializeRawDump,
	serializeRawDumpWithSpill,
	shouldCollectRequestDump,
	shouldPersistRawDump,
	spillThresholdBytes,
	startApiRequest,
} from "../api-request-tracker";

const spillDir = getNarraforkPath(REQUEST_DUMP_SPILL_DIR);

afterEach(() => {
	cleanDb(sqlite);
});

// Snapshot the three dump-related agent settings so each test can toggle them freely
// without leaking state into sibling tests (settings is a mutable singleton).
const original = {
	enabled: settings.agent.requestDumpEnabled,
	errorsOnly: settings.agent.requestDumpErrorsOnly,
	maxSize: settings.agent.requestDumpMaxSize,
};

beforeEach(async () => {
	settings.agent.requestDumpEnabled = false;
	settings.agent.requestDumpErrorsOnly = false;
	settings.agent.requestDumpMaxSize = 1024 * 1024;
	// Spill files and the reuse memo are process-global; a leftover of either would make a
	// "how many files did this produce" assertion depend on test order.
	clearRememberedSpills();
	await rm(spillDir, { recursive: true, force: true }).catch(() => {});
});

afterEach(async () => {
	settings.agent.requestDumpEnabled = original.enabled;
	settings.agent.requestDumpErrorsOnly = original.errorsOnly;
	settings.agent.requestDumpMaxSize = original.maxSize;
	clearRememberedSpills();
	await rm(spillDir, { recursive: true, force: true }).catch(() => {});
});

describe("live dump settings helpers", () => {
	test("isRequestDumpEnabled / shouldCollectRequestDump follow the singleton", () => {
		settings.agent.requestDumpEnabled = false;
		expect(isRequestDumpEnabled()).toBe(false);
		expect(shouldCollectRequestDump()).toBe(false);
		expect(shouldCollectRequestDump(true)).toBe(true);

		settings.agent.requestDumpEnabled = true;
		expect(isRequestDumpEnabled()).toBe(true);
		expect(shouldCollectRequestDump()).toBe(true);
		expect(shouldCollectRequestDump(false)).toBe(true);
	});

	test("persist gate re-reads settings at finish (mid-request enable still persists)", () => {
		// Collector already ran (e.g. leak detection or a request that started after a
		// toggle); master switch flipped on before finish → must persist.
		settings.agent.requestDumpEnabled = false;
		settings.agent.requestDumpErrorsOnly = false;
		expect(shouldPersistRawDump({ rawDump: { a: 1 } })).toBe(false);
		settings.agent.requestDumpEnabled = true;
		expect(shouldPersistRawDump({ rawDump: { a: 1 } })).toBe(true);
		// And flipping off before finish discards a collected dump.
		settings.agent.requestDumpEnabled = false;
		expect(shouldPersistRawDump({ rawDump: { a: 1 } })).toBe(false);
	});
});

describe("shouldPersistRawDump", () => {
	test("returns false when there is no dump", () => {
		expect(shouldPersistRawDump({ rawDump: null })).toBe(false);
		expect(shouldPersistRawDump({})).toBe(false);
	});

	test("does NOT persist a successful request when dumping is disabled (the regression)", () => {
		// This is the exact scenario that ballooned the DB: dumping off, but a dump object
		// still arrives (leak-detection collector). It must not be written.
		settings.agent.requestDumpEnabled = false;
		expect(shouldPersistRawDump({ rawDump: { big: "x" } })).toBe(false);
	});

	test("persists all requests when enabled and not errors-only", () => {
		settings.agent.requestDumpEnabled = true;
		settings.agent.requestDumpErrorsOnly = false;
		expect(shouldPersistRawDump({ rawDump: { a: 1 } })).toBe(true);
	});

	test("persists only failed requests when errors-only is set", () => {
		settings.agent.requestDumpEnabled = true;
		settings.agent.requestDumpErrorsOnly = true;
		expect(shouldPersistRawDump({ rawDump: { a: 1 } })).toBe(false);
		expect(shouldPersistRawDump({ rawDump: { a: 1 }, errorMessage: "boom" })).toBe(true);
		// Whitespace-only error message is treated as "no error".
		expect(shouldPersistRawDump({ rawDump: { a: 1 }, errorMessage: "   " })).toBe(false);
	});

	test("forceDumpPersist overrides the disabled gate (leak detection)", () => {
		settings.agent.requestDumpEnabled = false;
		expect(shouldPersistRawDump({ rawDump: { a: 1 }, forceDumpPersist: true })).toBe(true);
	});

	test("persists bounded diagnostics even when full dumping is disabled", () => {
		settings.agent.requestDumpEnabled = false;
		expect(
			shouldPersistRawDump({
				rawDump: { secretRequest: "must-not-be-required" },
				diagnostics: {
					schema: "narrafork.error-diagnostics.v1",
					statusCode: 502,
					requestId: "req-123",
				},
			}),
		).toBe(true);
	});
});

describe("serializeRawDump", () => {
	test("serializes a normal dump under the size cap", () => {
		const opts: ApiRequestFinishOptions = { rawDump: { hello: "world" } };
		expect(serializeRawDump(opts)).toBe(JSON.stringify({ hello: "world" }));
	});

	test("replaces an oversized dump with truncation metadata", () => {
		settings.agent.requestDumpMaxSize = 32;
		const opts: ApiRequestFinishOptions = { rawDump: { pad: "x".repeat(500) } };
		const out = serializeRawDump(opts);
		expect(out).not.toBeNull();
		const parsed = JSON.parse(out as string) as {
			truncated: boolean;
			originalBytes: number;
			maxBytes: number;
		};
		expect(parsed.truncated).toBe(true);
		expect(parsed.maxBytes).toBe(32);
		expect(parsed.originalBytes).toBeGreaterThan(32);
	});

	test("does not cap force-persisted (leak) dumps", () => {
		settings.agent.requestDumpMaxSize = 8;
		const opts: ApiRequestFinishOptions = {
			rawDump: { pad: "x".repeat(500) },
			forceDumpPersist: true,
		};
		const out = serializeRawDump(opts);
		expect(out).toBe(JSON.stringify({ pad: "x".repeat(500) }));
	});

	test("maxSize = -1 disables the cap", () => {
		settings.agent.requestDumpMaxSize = -1;
		const opts: ApiRequestFinishOptions = { rawDump: { pad: "x".repeat(500) } };
		expect(serializeRawDump(opts)).toBe(JSON.stringify({ pad: "x".repeat(500) }));
	});

	test("keeps diagnostics when even a shrunken dump cannot fit", () => {
		// 32 bytes cannot hold any request/response envelope, so the bounded
		// diagnostics summary is the only thing that survives.
		settings.agent.requestDumpMaxSize = 32;
		const out = serializeRawDump({
			rawDump: { pad: "x".repeat(500) },
			diagnostics: {
				schema: "narrafork.error-diagnostics.v1",
				statusCode: 502,
				requestId: "req-123",
			},
		});
		expect(JSON.parse(out as string)).toEqual({
			diagnostics: {
				schema: "narrafork.error-diagnostics.v1",
				statusCode: 502,
				requestId: "req-123",
			},
		});
	});

	/**
	 * The reported bug: dumping was enabled and the request failed with an upstream 400,
	 * yet the downloaded dump had `request: null` / `response: null` and carried nothing
	 * but diagnostics — making the feature useless precisely when it is needed.
	 *
	 * Two facts combine to make this the *normal* outcome rather than an edge case:
	 * a failing request always has diagnostics (the agent loop builds them
	 * unconditionally), and a request body replaying conversation history routinely
	 * exceeds the 1MB default ceiling. The old code answered that pair by discarding
	 * the whole dump.
	 */
	test("preserves the rejected request body when an oversized dump has diagnostics", () => {
		settings.agent.requestDumpMaxSize = 1024 * 1024;
		const out = serializeRawDump({
			errorMessage: "OpenAI API error 400: missing `input.content.text`",
			diagnostics: {
				schema: "narrafork.error-diagnostics.v1",
				statusCode: 400,
				reason: "BadRequest",
			},
			rawDump: {
				provider: "volcengine",
				request: {
					transport: "http",
					url: "https://example.invalid/responses",
					body: { input: "X".repeat(4_000_000) },
				},
				response: { status: 400, bodyText: "missing input.content.text" },
			},
		});

		const parsed = JSON.parse(out as string) as {
			provider?: string;
			diagnostics?: unknown;
			request?: {
				url?: string;
				bodyChars?: number;
				bodyTextTruncated?: boolean;
				bodyText?: string;
			};
			response?: { status?: number; bodyText?: string };
		};

		// The whole point: the request survives, so the malformed part is inspectable.
		expect(parsed.request?.url).toBe("https://example.invalid/responses");
		expect(parsed.request?.bodyTextTruncated).toBe(true);
		expect(parsed.request?.bodyChars).toBeGreaterThan(4_000_000);
		expect(parsed.request?.bodyText).toContain("XXX");
		// Upstream's reply and the diagnostics summary are both retained.
		expect(parsed.response?.status).toBe(400);
		expect(parsed.response?.bodyText).toBe("missing input.content.text");
		expect(parsed.diagnostics).toBeDefined();
		// And the row still respects the configured ceiling.
		expect((out as string).length).toBeLessThanOrEqual(1024 * 1024);
	});

	/**
	 * The budget must scale with the ceiling. A fixed truncation length would let a 1MB
	 * ceiling yield a tiny body — spending none of the budget the operator granted, which
	 * is the same "dump is technically present but useless" failure in a quieter form.
	 */
	test("spends the available budget on the body instead of a fixed slice", () => {
		const body = { input: "X".repeat(4_000_000) };
		const dump = {
			request: { url: "https://example.invalid/responses", body },
			response: { status: 400, bodyText: "bad request" },
		};

		settings.agent.requestDumpMaxSize = 256 * 1024;
		const small = serializeRawDump({ rawDump: structuredClone(dump) }) as string;
		settings.agent.requestDumpMaxSize = 2 * 1024 * 1024;
		const large = serializeRawDump({ rawDump: structuredClone(dump) }) as string;

		// The body may survive either as the original object (when it fits) or as
		// truncated text, so measure whichever form carries it.
		const retainedBodyChars = (json: string) => {
			const req = (JSON.parse(json) as { request?: { body?: unknown; bodyText?: string } }).request;
			if (req?.body !== undefined) return (JSON.stringify(req.body) ?? "").length;
			return req?.bodyText?.length ?? 0;
		};

		expect(retainedBodyChars(large)).toBeGreaterThan(retainedBodyChars(small) * 4);
		expect(small.length).toBeLessThanOrEqual(256 * 1024);
		expect(large.length).toBeLessThanOrEqual(2 * 1024 * 1024);
	});

	test("keeps a whole real-world request body under the default ceiling", () => {
		// A dump-worthy request is full conversation history; at the default ceiling it
		// must survive untouched rather than arrive pre-truncated.
		settings.agent.requestDumpMaxSize = DEFAULTS.agent.requestDumpMaxSize;
		const out = serializeRawDump({
			errorMessage: "upstream 400",
			diagnostics: { schema: "narrafork.error-diagnostics.v1", statusCode: 400 },
			rawDump: {
				request: {
					url: "https://example.invalid/responses",
					body: { input: "X".repeat(8_000_000) },
				},
				response: { status: 400, bodyText: "bad request" },
			},
		});

		const parsed = JSON.parse(out as string) as {
			request?: { body?: unknown; bodyTextTruncated?: boolean };
		};
		expect(parsed.request?.bodyTextTruncated).toBeUndefined();
		expect(parsed.request?.body).toBeDefined();
	});

	test("drops bulky SSE events before touching the request body", () => {
		settings.agent.requestDumpMaxSize = 200 * 1024;
		const out = serializeRawDump({
			errorMessage: "stream failed",
			rawDump: {
				request: { url: "https://example.invalid/v1", body: { model: "m", input: "short" } },
				response: {
					status: 200,
					events: Array.from({ length: 5000 }, (_, i) => ({ i, pad: "y".repeat(200) })),
				},
			},
		});

		const parsed = JSON.parse(out as string) as {
			request?: { body?: { input?: string }; bodyTextTruncated?: boolean };
			response?: { events?: { dropped?: boolean; count?: number } };
		};

		expect(parsed.response?.events?.dropped).toBe(true);
		expect(parsed.response?.events?.count).toBe(5000);
		// The small request body was under the shrink threshold, so it is untouched.
		expect(parsed.request?.body?.input).toBe("short");
		expect(parsed.request?.bodyTextTruncated).toBeUndefined();
	});

	test("shrinks rather than drops when force-persisting past the hard ceiling", () => {
		const out = serializeRawDump({
			forceDumpPersist: true,
			rawDump: {
				request: {
					url: "https://example.invalid/v1",
					body: { pad: "z".repeat(FORCED_DUMP_HARD_MAX_BYTES + 1024) },
				},
			},
		});

		const parsed = JSON.parse(out as string) as {
			request?: { url?: string; bodyTextTruncated?: boolean };
			truncated?: boolean;
		};
		expect(parsed.truncated).toBeUndefined();
		expect(parsed.request?.url).toBe("https://example.invalid/v1");
		expect(parsed.request?.bodyTextTruncated).toBe(true);
	});

	/**
	 * When the complete dump lives in a file, the row must SAY SO. Without the pointer the
	 * row is indistinguishable from a dump that was simply small, and the download route has
	 * no way to find the file — which is precisely the "opened the dump, got a preview"
	 * failure this work removes.
	 */
	test("carries the spill pointer so the download route can find the full dump", () => {
		settings.agent.requestDumpMaxSize = 256 * 1024;
		const out = serializeRawDump(
			{
				rawDump: {
					request: { url: "https://example.invalid/v1", body: { pad: "z".repeat(900_000) } },
				},
			},
			{
				schema: REQUEST_DUMP_SPILL_POINTER_SCHEMA,
				filePath: "/home/user/.narrafork/request-dumps/dump.json",
				bytes: 900_100,
				inlineTruncated: true,
				note: "full dump on disk",
			},
		);

		const parsed = JSON.parse(out as string) as {
			spill?: { schema?: string; filePath?: string; inlineTruncated?: boolean };
			request?: { url?: string };
		};
		expect(parsed.spill?.schema).toBe(REQUEST_DUMP_SPILL_POINTER_SCHEMA);
		expect(parsed.spill?.filePath).toBe("/home/user/.narrafork/request-dumps/dump.json");
		expect(parsed.spill?.inlineTruncated).toBe(true);
		// The head still carries enough to recognize the request without downloading.
		expect(parsed.request?.url).toBe("https://example.invalid/v1");
	});

	/**
	 * The pointer must survive the very cases that force the smallest row, because those are
	 * exactly the rows whose only complete copy is the file.
	 */
	test("keeps the spill pointer even when only diagnostics fit the row", () => {
		settings.agent.requestDumpMaxSize = 32;
		const out = serializeRawDump(
			{
				rawDump: { pad: "x".repeat(500) },
				diagnostics: { schema: "narrafork.error-diagnostics.v1", statusCode: 400 },
			},
			{
				schema: REQUEST_DUMP_SPILL_POINTER_SCHEMA,
				filePath: "/home/user/.narrafork/request-dumps/dump.json",
				bytes: 512,
				inlineTruncated: true,
				note: "full dump on disk",
			},
		);

		const parsed = JSON.parse(out as string) as { spill?: { filePath?: string } };
		expect(parsed.spill?.filePath).toBe("/home/user/.narrafork/request-dumps/dump.json");
	});
});

/**
 * What decides that a dump goes to a file.
 *
 * This was wired to `agent.requestDumpMaxSize`, which made the whole spill store nearly
 * unreachable: at the 32 MB default a 5 MB body (the common case once the history
 * carries inline images) was judged small enough and written straight into the SQLite row.
 * The row then WAS the dump, so "download" handed back a preview — the exact failure the
 * store exists to remove — while the row grew into the unbounded large field CLAUDE.md
 * forbids on the main thread. Nothing about that outcome was observable, hence these tests.
 */
describe("spillThresholdBytes", () => {
	test("a multi-MB dump spills even though the configured ceiling is far larger", () => {
		settings.agent.requestDumpMaxSize = DEFAULTS.agent.requestDumpMaxSize; // 32 MB
		expect(spillThresholdBytes({})).toBe(RAW_DUMP_INLINE_MAX_BYTES);
	});

	test("a smaller configured ceiling still wins", () => {
		// An operator asking for smaller rows must not be handed larger ones.
		settings.agent.requestDumpMaxSize = 64 * 1024;
		expect(spillThresholdBytes({})).toBe(64 * 1024);
	});

	test('an unlimited ceiling ("-1") spills rather than growing the row without bound', () => {
		// "No limit" is about how much is RETAINED; the file retains all of it.
		settings.agent.requestDumpMaxSize = -1;
		expect(spillThresholdBytes({})).toBe(RAW_DUMP_INLINE_MAX_BYTES);
	});

	test("force-persisted dumps spill on the same threshold", () => {
		// forceDumpPersist raises what may be RETAINED (to the hard ceiling), not what a row
		// may hold — otherwise every leak-detection dump would land in the row at up to 64 MB.
		settings.agent.requestDumpMaxSize = 1024;
		expect(spillThresholdBytes({ forceDumpPersist: true })).toBe(RAW_DUMP_INLINE_MAX_BYTES);
	});
});

/**
 * Every ceiling here is named `*_BYTES` and the spill pointer records `Buffer.byteLength`,
 * but the comparisons were against `String.length` — UTF-16 code units. One CJK character is
 * one unit and three UTF-8 bytes, so a 512 KB budget admitted rows approaching 1.5 MB: the
 * row grew past the ceiling the main-thread rules exist to enforce while every recorded
 * `bytes` claimed otherwise. Invisible in ASCII testing, which is why these tests are CJK.
 */
describe("byte-accurate size accounting", () => {
	/** ~600 KB of UTF-8, but only ~200 K UTF-16 units — under the old char-based budget. */
	const cjkBody = "内容".repeat(100_000);

	test("a CJK dump over the byte ceiling is not admitted by its char count", () => {
		settings.agent.requestDumpMaxSize = 512 * 1024;
		const out = serializeRawDump({ rawDump: { request: { body: { text: cjkBody } } } }) as string;

		// The decisive assertion: measured in BYTES, which is what the ceiling means.
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(512 * 1024);
		// And it is genuinely over the line by chars alone, so the old code let it through.
		expect(cjkBody.length).toBeLessThan(512 * 1024);
	});

	test("the spill decision is made in bytes too", async () => {
		// 240 K units ≈ 720 KB UTF-8: under RAW_DUMP_INLINE_MAX_BYTES by chars, over by bytes.
		// The old comparison kept this in the row; it must reach a file instead.
		settings.agent.requestDumpMaxSize = DEFAULTS.agent.requestDumpMaxSize;
		const nearlyInline = "内容".repeat(120_000);
		expect(nearlyInline.length).toBeLessThan(RAW_DUMP_INLINE_MAX_BYTES);
		expect(Buffer.byteLength(nearlyInline, "utf8")).toBeGreaterThan(RAW_DUMP_INLINE_MAX_BYTES);

		const row = await serializeRawDumpWithSpill(
			{ rawDump: { request: { body: nearlyInline } }, forceDumpPersist: true },
			spillMeta("req-cjk-spill"),
		);
		expect(readSpill(row)?.filePath).toBeTruthy();
	});

	test("a genuinely small dump still stays inline", async () => {
		settings.agent.requestDumpMaxSize = DEFAULTS.agent.requestDumpMaxSize;
		const row = await serializeRawDumpWithSpill(
			{ rawDump: { request: { body: "内容" } }, forceDumpPersist: true },
			spillMeta("req-cjk-inline"),
		);
		expect(readSpill(row)).toBeUndefined();
	});
});

/**
 * A failed spill write is the one path that reaches the row WITHOUT a pointer while the dump
 * is already known not to fit a row. It used to be indistinguishable from "the dump was small
 * enough to stay inline", so it was handed the CONFIGURED ceiling — 32 MB by default — and a
 * multi-MB dump went straight into the SQLite row: the unbounded large field CLAUDE.md forbids
 * on the main thread, reintroduced through the failure path of the store built to prevent it.
 *
 * The failure is provoked for real (the spill directory's path is occupied by a FILE, so
 * `mkdir` cannot create it) rather than by stubbing the writer, because the assertion is about
 * what the production call chain produces when the disk refuses.
 */
describe("a failed spill write still bounds the row", () => {
	/** ~2.7 MB serialized: far above the row ceiling, far below the 32 MB default. */
	const oversizedDump = {
		request: { url: "https://example.invalid/v1", body: { pad: "P".repeat(2_700_000) } },
	};

	beforeEach(async () => {
		await rm(spillDir, { recursive: true, force: true }).catch(() => {});
		// Occupying the directory path with a file makes `mkdir(dir)` throw ENOTDIR/EEXIST.
		await mkdir(dirname(spillDir), { recursive: true });
		await writeFile(spillDir, "not a directory", "utf8");
	});

	afterEach(async () => {
		await rm(spillDir, { force: true }).catch(() => {});
	});

	test("clamps to the row ceiling instead of the configured 32 MB", async () => {
		settings.agent.requestDumpMaxSize = DEFAULTS.agent.requestDumpMaxSize; // 32 MB
		const row = await serializeRawDumpWithSpill(
			{ rawDump: structuredClone(oversizedDump), forceDumpPersist: true },
			spillMeta("req-spill-failed"),
		);

		expect(row).not.toBeNull();
		// No pointer: the file does not exist, so nothing may claim it does.
		expect(readSpill(row)).toBeUndefined();
		// The decisive assertion — the row is bounded even though the ceiling was 32 MB.
		expect(Buffer.byteLength(row as string, "utf8")).toBeLessThanOrEqual(RAW_DUMP_INLINE_MAX_BYTES);
		// And the bounded row is still a usable diagnosis, not a stub: shrinking kept the
		// request identity and said so, rather than dropping to `{ truncated: true }`.
		const parsed = JSON.parse(row as string) as {
			request?: { url?: string; bodyTextTruncated?: boolean };
		};
		expect(parsed.request?.url).toBe("https://example.invalid/v1");
		expect(parsed.request?.bodyTextTruncated).toBe(true);
	});
});

/**
 * Replays of one rejected request are byte-identical, and each attempt inserts its own row
 * with its own force-persisted dump. Without a shared token each attempt spilled another
 * multi-MB near-duplicate into a directory pruned to the newest N — spending three slots on
 * one request and evicting unrelated captures to do it. The malformed-dump directory was
 * already guarded; this is the same guarantee for the spill directory.
 */
describe("spill file reuse across replays of one request", () => {
	const bigDump = { request: { body: { pad: "R".repeat(900_000) } } };

	test("attempts sharing a token share one file, and each row still points at it", async () => {
		const rows = await Promise.all(
			["attempt-1", "attempt-2", "attempt-3"].map(async (requestId) =>
				serializeRawDumpWithSpill(
					{
						rawDump: structuredClone(bigDump),
						forceDumpPersist: true,
						dumpSpillReuseToken: "malformed:turn-1",
					},
					spillMeta(requestId),
				),
			),
		);

		const pointers = rows.map((row) => readSpill(row));
		// No attempt may look like a failure with no evidence.
		expect(pointers.every((p) => typeof p?.filePath === "string")).toBe(true);

		const files = (await readdir(spillDir)).filter((name) => name.endsWith(".json"));
		expect(files).toHaveLength(1);
		expect(new Set(pointers.map((p) => p?.filePath)).size).toBe(1);
	});

	test("without a token each dump gets its own file", async () => {
		// The token is opt-in precisely because sharing a file across unrelated requests would
		// make a download answer for the wrong request.
		for (const requestId of ["solo-1", "solo-2"]) {
			await serializeRawDumpWithSpill(
				{ rawDump: structuredClone(bigDump), forceDumpPersist: true },
				spillMeta(requestId),
			);
		}
		const files = (await readdir(spillDir)).filter((name) => name.endsWith(".json"));
		expect(files).toHaveLength(2);
	});

	test("different tokens do not share a file", async () => {
		for (const token of ["malformed:turn-a", "malformed:turn-b"]) {
			await serializeRawDumpWithSpill(
				{
					rawDump: structuredClone(bigDump),
					forceDumpPersist: true,
					dumpSpillReuseToken: token,
				},
				spillMeta(`req-${token}`),
			);
		}
		const files = (await readdir(spillDir)).filter((name) => name.endsWith(".json"));
		expect(files).toHaveLength(2);
	});
});

function spillMeta(requestId: string) {
	return {
		requestId,
		// null on purpose: a narratorId would send `resolveSpillIdentity` to the database, and
		// these tests are about the spill decision, not about title joins.
		narratorId: null,
		kind: "narrator",
		provider: "nug2",
		model: "nug2:anthropic:claude-opus-5",
		credentialId: null,
		errorMessage: "Improperly formed request.",
		createdAt: "2026-08-19T10:47:10.832Z",
	};
}

function readSpill(row: string | null): { filePath?: string } | undefined {
	if (!row) return undefined;
	return (JSON.parse(row) as { spill?: { filePath?: string } }).spill;
}

describe("request occupancy snapshot persistence", () => {
	test("actual request insertion maps bounded occupancy metadata without changing billing", async () => {
		const handle = startApiRequest({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
		const snapshot = {
			requestId: "logical-request",
			startedAt: "2026-10-05T00:00:00Z",
			source: "upstream" as const,
			percentage: 92.6,
			contextWindow: 1_000_000,
			occupiedTokens: 926000,
			inputCharacters: { totalChars: 1_000_000, systemChars: 0, toolsChars: 0 },
			composition: null,
		};
		await finishApiRequest(handle, {
			usage: { inputTokens: 510800, outputTokens: 10 },
			contextPercent: 92.6,
			contextSnapshot: snapshot,
		});
		const row = db.select().from(apiRequests).where(eq(apiRequests.id, handle.id)).get();
		expect(row?.contextUsageSnapshotJson).toEqual(snapshot);
		expect(row?.inputTokens).toBe(510800);
	});
	test("historical omission remains null; oversized metadata is not inserted", async () => {
		for (const contextSnapshot of [
			undefined,
			{
				requestId: "x".repeat(17000),
				startedAt: "2026-10-05T00:00:00Z",
				source: "estimate" as const,
				percentage: null,
				contextWindow: null,
				occupiedTokens: null,
				inputCharacters: null,
				composition: null,
			},
		]) {
			const handle = startApiRequest({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
			await finishApiRequest(handle, { contextSnapshot });
			expect(
				db.select().from(apiRequests).where(eq(apiRequests.id, handle.id)).get()
					?.contextUsageSnapshotJson,
			).toBeNull();
		}
	});
});

describe("request user attribution", () => {
	test("completion persists frozen user and rolls up once, including unknown-cost failures", async () => {
		const userId = "tracker-user-rollup-test";
		const handle = startApiRequest({ provider: "test", model: "unknown", userId });
		try {
			await finishApiRequest(handle, { usage: { inputTokens: 100, outputTokens: 20 } });
			await finishApiRequest(handle, { usage: { inputTokens: 100, outputTokens: 20 } });
			expect(db.select().from(apiRequests).where(eq(apiRequests.id, handle.id)).get()?.userId).toBe(
				userId,
			);
			expect(
				db.select().from(userUsageTotals).where(eq(userUsageTotals.userId, userId)).get(),
			).toMatchObject({
				requestCount: 1,
				inputTokens: 100,
				outputTokens: 20,
				unpricedRequestCount: 1,
			});
			const failed = startApiRequest({ provider: "test", model: "unknown", userId });
			await finishApiRequest(failed, { errorMessage: "upstream rejected" });
			expect(
				db.select().from(userUsageTotals).where(eq(userUsageTotals.userId, userId)).get(),
			).toMatchObject({ requestCount: 2, inputTokens: 100, unpricedRequestCount: 2 });
		} finally {
			db.delete(apiRequests).where(eq(apiRequests.userId, userId)).run();
			db.delete(userUsageTotals).where(eq(userUsageTotals.userId, userId)).run();
		}
	});
	test("captures the initiating user before shared options change", () => {
		const options = { provider: "test", model: "test", userId: "alice" };
		const first = startApiRequest(options);
		options.userId = "bob";
		const second = startApiRequest(options);
		expect(first.userId).toBe("alice");
		expect(second.userId).toBe("bob");
	});

	test("unknown initiators stay null even with a narrator", () => {
		expect(
			startApiRequest({ provider: "test", model: "test", narratorId: "shared" }).userId,
		).toBeNull();
		expect(startApiRequest({ provider: "test", model: "test", userId: null }).userId).toBeNull();
	});
});
