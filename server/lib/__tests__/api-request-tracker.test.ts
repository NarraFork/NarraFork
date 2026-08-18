import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULTS, settings } from "@server/lib/settings";
import {
	type ApiRequestFinishOptions,
	FORCED_DUMP_HARD_MAX_BYTES,
	serializeRawDump,
	shouldPersistRawDump,
} from "../api-request-tracker";

// Snapshot the three dump-related agent settings so each test can toggle them freely
// without leaking state into sibling tests (settings is a mutable singleton).
const original = {
	enabled: settings.agent.requestDumpEnabled,
	errorsOnly: settings.agent.requestDumpErrorsOnly,
	maxSize: settings.agent.requestDumpMaxSize,
};

beforeEach(() => {
	settings.agent.requestDumpEnabled = false;
	settings.agent.requestDumpErrorsOnly = false;
	settings.agent.requestDumpMaxSize = 1024 * 1024;
});

afterEach(() => {
	settings.agent.requestDumpEnabled = original.enabled;
	settings.agent.requestDumpErrorsOnly = original.errorsOnly;
	settings.agent.requestDumpMaxSize = original.maxSize;
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
});
