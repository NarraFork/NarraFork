import { describe, expect, test } from "bun:test";
import {
	MAX_DIAGNOSTIC_JSON_CHARS,
	normalizeApiRequestDiagnostics,
	parseErrorDiagnostics,
} from "../error-diagnostics";
import { ApiRequestDumpCollector, MAX_DUMP_EVENT_COUNT, sanitizeHeaders } from "../request-dump";

describe("ApiRequestDumpCollector.setResponseEventsWithLimit", () => {
	test("keeps all events when under both caps", () => {
		const c = new ApiRequestDumpCollector();
		const events = [{ a: 1 }, { b: 2 }, { c: 3 }];
		c.setResponseEventsWithLimit(events, 100, 1024 * 1024);
		expect(c.snapshot().response?.events).toEqual(events);
	});

	test("truncates by element count and appends a marker", () => {
		const c = new ApiRequestDumpCollector();
		const events = Array.from({ length: 10 }, (_, i) => ({ i }));
		c.setResponseEventsWithLimit(events, 4, 1024 * 1024);
		const stored = c.snapshot().response?.events as unknown[];
		// 4 kept + 1 truncation marker
		expect(stored).toHaveLength(5);
		expect(stored.slice(0, 4)).toEqual(events.slice(0, 4));
		expect(stored[4]).toEqual({ _truncated: 6 });
	});

	test("truncates by byte size from the tail", () => {
		const c = new ApiRequestDumpCollector();
		// Each event serializes to a sizable string; cap bytes so only a few fit.
		const events = Array.from({ length: 20 }, (_, i) => ({ i, pad: "x".repeat(100) }));
		c.setResponseEventsWithLimit(events, MAX_DUMP_EVENT_COUNT, 300);
		const stored = c.snapshot().response?.events as unknown[];
		// At least one event dropped → truncation marker present.
		const marker = stored.at(-1) as { _truncated?: number };
		expect(marker._truncated).toBeGreaterThan(0);
		// Final serialized size is within a small multiple of the cap (kept + marker).
		expect(JSON.stringify(stored).length).toBeLessThan(600);
	});

	test("negative caps disable limiting", () => {
		const c = new ApiRequestDumpCollector();
		const events = Array.from({ length: 5 }, (_, i) => ({ i }));
		c.setResponseEventsWithLimit(events, -1, -1);
		expect(c.snapshot().response?.events).toEqual(events);
	});
});

describe("sanitizeHeaders", () => {
	test("masks provider API-key headers, including Gemini's x-goog-api-key", () => {
		const masked = sanitizeHeaders({
			authorization: "Bearer sk-super-secret-token",
			"x-api-key": "anthropic-secret-key",
			"x-goog-api-key": "AIzaSyGeminiSecretKey123",
			"content-type": "application/json",
		}) as Record<string, string>;
		// Secrets are masked (never stored verbatim in a request dump).
		expect(masked.authorization).not.toContain("super-secret");
		expect(masked["x-api-key"]).not.toContain("anthropic-secret-key");
		expect(masked["x-goog-api-key"]).not.toContain("AIzaSyGeminiSecretKey123");
		expect(masked["x-goog-api-key"]).toContain("********");
		// Non-sensitive headers pass through untouched.
		expect(masked["content-type"]).toBe("application/json");
	});

	test("matches sensitive header names case-insensitively", () => {
		const masked = sanitizeHeaders({ "X-Goog-Api-Key": "AIzaSyAnotherSecretKey" }) as Record<
			string,
			string
		>;
		expect(masked["X-Goog-Api-Key"]).not.toContain("AIzaSyAnotherSecretKey");
		expect(masked["X-Goog-Api-Key"]).toContain("********");
	});
});

describe("error diagnostics", () => {
	test("stores normalized diagnostics on the request dump", () => {
		const collector = new ApiRequestDumpCollector({ provider: "nug" });
		collector.setDiagnostics(
			normalizeApiRequestDiagnostics({
				source: "gateway",
				statusCode: 502,
				requestId: "req-123",
				responseHeaders: {
					"x-request-id": "req-123",
					authorization: "Bearer secret",
				},
			}),
		);
		expect(collector.snapshot().diagnostics).toEqual({
			schema: "narrafork.error-diagnostics.v1",
			source: "gateway",
			statusCode: 502,
			requestId: "req-123",
			responseHeaders: { "x-request-id": "req-123" },
		});
	});

	test("enforces an independent total diagnostics size limit", () => {
		const diagnostics = normalizeApiRequestDiagnostics({
			message: "m".repeat(20_000),
			responseSnippet: "r".repeat(20_000),
			cause: "c".repeat(20_000),
			requestId: "req-123",
		});
		expect(Buffer.byteLength(JSON.stringify(diagnostics), "utf8")).toBeLessThanOrEqual(
			MAX_DIAGNOSTIC_JSON_CHARS,
		);
		expect(diagnostics?.requestId).toBe("req-123");
	});

	test("keeps the byte ceiling with large identity fields and unicode", () => {
		const diagnostics = normalizeApiRequestDiagnostics({
			source: "源".repeat(8192),
			requestId: "请求".repeat(8192),
			providerRequestId: "网关".repeat(8192),
		});
		expect(Buffer.byteLength(JSON.stringify(diagnostics), "utf8")).toBeLessThanOrEqual(
			MAX_DIAGNOSTIC_JSON_CHARS,
		);
	});

	test("preserves the HTTP status supplied as a parser default", () => {
		const diagnostics = parseErrorDiagnostics(
			{ error: { type: "server_error", message: "boom" } },
			{ statusCode: 503, source: "gateway" },
		);
		expect(diagnostics?.statusCode).toBe(503);
	});
});
