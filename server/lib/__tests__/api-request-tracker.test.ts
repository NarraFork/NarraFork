import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { settings } from "@server/lib/settings";
import {
	type ApiRequestFinishOptions,
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
});
