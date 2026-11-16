import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	RecordingPinReason,
	RecordingRequest,
	RequestRecording,
	SavedRecording,
} from "@shared/request-recording";
import {
	createRequestRecording,
	RequestRecorderClient,
	requestRecordingSettings,
} from "../../request-recorder";
import {
	REQUEST_RECORDING_SAVED_DIR,
	type RecorderOperation,
} from "../../request-recorder-protocol";
import { RequestRecorderStore } from "../../request-recorder-store";
import { settings } from "../../settings";
import {
	MAX_DIAGNOSTIC_JSON_CHARS,
	normalizeApiRequestDiagnostics,
	parseErrorDiagnostics,
} from "../error-diagnostics";
import {
	ApiRequestDumpCollector,
	BoundedUtf8Capture,
	captureResponseStream,
	HARD_DUMP_MAX_BYTES,
	sanitizeHeaders,
} from "../request-dump";

/** In-memory RequestRecording that keeps every call for assertions. */
function fakeRecording(requestId = "fake") {
	const requests: RecordingRequest[] = [];
	const metas: Record<string, unknown>[] = [];
	const chunks: string[] = [];
	const pins: RecordingPinReason[] = [];
	const recording: RequestRecording = {
		requestId,
		pin: (reason) => pins.push(reason),
		request: (value) => requests.push(value),
		responseMeta: (value) => metas.push(value),
		responseChunk: (value) =>
			chunks.push(typeof value === "string" ? value : new TextDecoder().decode(value)),
		frame: () => {},
		finish: () => {},
	};
	const lastMeta = () => Object.assign({}, ...metas) as Record<string, unknown>;
	return { recording, requests, metas, chunks, pins, lastMeta };
}

async function saveCoreRecording(
	action: (dump: ApiRequestDumpCollector, recording: RequestRecording) => Promise<void>,
) {
	const home = await mkdtemp(join(tmpdir(), "recording-source-test-"));
	const originalEvidence = settings.requestEvidence;
	settings.requestEvidence = {
		ringEnabled: true,
		ringRequestBytes: 1024 * 1024,
		ringResponseBytes: 1024 * 1024,
		autoPin: "off",
	};
	const operations: RecorderOperation[] = [];
	// Capture the core's exact worker messages without starting its singleton worker.
	// Replay them into a real, independently located store to verify saved completeness.
	const configure = spyOn(RequestRecorderClient.prototype, "configure").mockImplementation(
		() => {},
	);
	const capture = spyOn(RequestRecorderClient.prototype, "capture").mockImplementation(
		(operation) => {
			operations.push(operation);
			return true;
		},
	);
	try {
		const store = new RequestRecorderStore(home);
		await store.execute({ type: "configure", settings: requestRecordingSettings() });
		const recording = createRequestRecording({
			requestId: "source-test",
			narratorId: "source-narrator",
			provider: "fixture",
			model: "fixture",
		});
		if (!recording) throw new Error("Recording fixture must be enabled");
		const dump = new ApiRequestDumpCollector(recording);
		await action(dump, recording);
		dump.finish({ status: "completed" });
		for (const operation of operations) await store.execute(operation);
		const saved = (await store.execute({
			type: "save",
			narratorId: "source-narrator",
		})) as SavedRecording;
		const hash = createHash("sha256").update(saved.narratorId).digest("hex");
		const manifest = JSON.parse(
			await readFile(
				join(home, REQUEST_RECORDING_SAVED_DIR, hash, saved.id, "manifest.json"),
				"utf8",
			),
		) as { requests: Array<{ gapReasons: string[]; gaps: { request: number; response: number } }> };
		return { saved, manifest, operations };
	} finally {
		capture.mockRestore();
		configure.mockRestore();
		settings.requestEvidence = originalEvidence;
		await rm(home, { recursive: true, force: true });
	}
}

describe("live request recording", () => {
	test("explicit plugin and host source loss survives collector forwarding and saved summaries", async () => {
		const result = await saveCoreRecording(async (dump, recording) => {
			dump.beginResponseAttempt({ bodyText: "request" });
			for (const direction of ["request", "response"] as const) {
				for (const sourceTruncated of ["plugin", "host"] as const) {
					const frame = { direction, type: "plugin.dump", sourceTruncated };
					dump.frame(frame);
					dump.frame(frame);
				}
			}
			dump.appendResponseText("retained evidence");
			dump.finishResponseCapture(true);
			dump.finish({ status: "completed" });
			// Late diagnostics must not alter an ended recording.
			recording.frame({ direction: "response", type: "late", sourceTruncated: "host" });
		});
		expect(result.saved).toMatchObject({ truncated: true, partial: false });
		const gaps = result.operations.filter((operation) => operation.type === "gap");
		expect(gaps).toHaveLength(4);
		for (const gap of gaps) expect(gap.bytes).toBe(0);
		expect(result.manifest.requests[0].gapReasons).toEqual([
			"plugin source truncated",
			"host source truncated",
		]);
	});

	test("complete SSE beyond 64KiB is saved without truncation", async () => {
		const body = `data: ${"x".repeat(64 * 1024 + 4096)}\n\ndata: [DONE]\n\n`;
		const result = await saveCoreRecording(async (dump) => {
			dump.beginResponseAttempt({ bodyText: "{}" });
			const tap = captureResponseStream(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(body));
						controller.close();
					},
				}),
				dump,
			);
			expect(await new Response(tap.stream).text()).toBe(body);
		});
		expect(result.saved).toMatchObject({ truncated: false, partial: false });
		expect(result.manifest.requests[0].gapReasons).toEqual([]);
		expect(
			result.operations
				.filter(
					(operation): operation is Extract<RecorderOperation, { type: "chunk" }> =>
						operation.type === "chunk" && operation.side === "response",
				)
				.map((operation) => Buffer.from(operation.data).toString())
				.join(""),
		).toBe(body);
	});

	test("serialized request is forwarded without cloning/parsing even across fallback", () => {
		const { recording, requests } = fakeRecording("request-1");
		const dump = new ApiRequestDumpCollector(recording);
		const parse = spyOn(JSON, "parse");
		try {
			const bodyText = '{ "input": "actual serialized bytes" }';
			const body = {
				toJSON: () => {
					throw new Error("request must not be cloned");
				},
			};
			dump.beginResponseAttempt({ url: "https://first.test", body, bodyText });
			dump.beginResponseAttempt({ url: "https://fallback.test", body, bodyText });
			expect(parse).not.toHaveBeenCalledWith(bodyText);
			expect(requests.map((request) => request.bodyText)).toEqual([bodyText, bodyText]);
		} finally {
			parse.mockRestore();
		}
		expect(dump.lastRequestBody()).toEqual({ input: "actual serialized bytes" });
	});

	test("raw chunks are recorded before completion, cancellation remains pull-only", async () => {
		const chunks: Uint8Array[] = [];
		const metas: Record<string, unknown>[] = [];
		let finishCount = 0;
		const recording: RequestRecording = {
			requestId: "request-2",
			pin: () => {},
			request: () => {},
			responseMeta: (value) => metas.push(value),
			frame: () => {},
			responseChunk: (chunk) =>
				chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk.slice()),
			finish: () => {
				finishCount++;
			},
		};
		const dump = new ApiRequestDumpCollector(recording);
		dump.beginResponseAttempt({ bodyText: "{}" });
		let pulls = 0;
		let cancelled = false;
		const tap = captureResponseStream(
			new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						pulls++;
						controller.enqueue(new TextEncoder().encode("abcdef"));
					},
					cancel() {
						cancelled = true;
					},
				},
				{ highWaterMark: 0 },
			),
			dump,
		);
		expect(pulls).toBe(0);
		const reader = tap.stream.getReader();
		await reader.read();
		expect(chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["abcdef"]);
		await reader.read();
		expect(chunks).toHaveLength(2);
		await reader.cancel();
		expect(cancelled).toBe(true);
		expect(pulls).toBe(2);
		expect(metas.at(-1)).toEqual({ bodyIncomplete: true });
		dump.finish({ status: "cancelled" });
		dump.finish();
		expect(finishCount).toBe(1);
	});

	test("recorder failures cannot fail the business stream", async () => {
		const fail = () => {
			throw new Error("diagnostics offline");
		};
		const recording: RequestRecording = {
			requestId: "request-3",
			pin: fail,
			request: fail,
			responseMeta: fail,
			responseChunk: fail,
			frame: fail,
			finish: fail,
		};
		const dump = new ApiRequestDumpCollector(recording);
		dump.beginResponseAttempt({ bodyText: "{}" });
		expect(() => dump.pin("error")).not.toThrow();
		const tap = captureResponseStream(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("ok"));
					controller.close();
				},
			}),
			dump,
		);
		expect(await new Response(tap.stream).text()).toBe("ok");
		expect(() => dump.finish()).not.toThrow();
	});
});

describe("incremental response capture", () => {
	test("UTF8 byte boundaries preserve prefixes and seal on truncation", () => {
		const c = new BoundedUtf8Capture(5);
		c.append("中😀");
		c.append("a");
		expect(c.text()).toBe("中");
		expect(c.received).toBe(8);
		const split = new BoundedUtf8Capture(7);
		const bytes = new TextEncoder().encode("中😀x");
		for (const byte of bytes) split.append(new Uint8Array([byte]));
		expect(split.text()).toBe("中😀");
		expect(split.kept).toBe(7);
		expect(new BoundedUtf8Capture(-1).limit).toBe(HARD_DUMP_MAX_BYTES);
		expect(new BoundedUtf8Capture(Infinity).limit).toBe(HARD_DUMP_MAX_BYTES);
		expect(new BoundedUtf8Capture(0).text()).toBe("");
	});

	test("many tiny chunks stay a correct bounded prefix across storage blocks", () => {
		const capture = new BoundedUtf8Capture(65537);
		for (let i = 0; i < 100000; i++) capture.append(new Uint8Array([97]));
		expect(capture.text()).toBe("a".repeat(65537));
		expect(capture.received).toBe(100000);
		const partial = new BoundedUtf8Capture(5);
		partial.append(new TextEncoder().encode("中😀"));
		expect(partial.text()).toBe("中");
		expect(capture.kept).toBe(65537);
	});

	test("disabled capture does not wrap the source", () => {
		const source = new ReadableStream<Uint8Array>();
		expect(captureResponseStream(source).stream).toBe(source);
	});

	test("HTTP early exit cancels without draining and keeps received bytes", async () => {
		const fake = fakeRecording();
		const dump = new ApiRequestDumpCollector(fake.recording);
		dump.beginResponseAttempt({ transport: "http" });
		let pulls = 0;
		let cancelled = false;
		const capture = captureResponseStream(
			new ReadableStream(
				{
					pull(controller) {
						pulls++;
						controller.enqueue(new TextEncoder().encode("raw中"));
					},
					cancel() {
						cancelled = true;
					},
				},
				{ highWaterMark: 0 },
			),
			dump,
		);
		await capture.stream.getReader().read();
		capture.finish();
		expect(pulls).toBe(1);
		expect(cancelled).toBe(true);
		expect(fake.chunks).toEqual(["raw中"]);
		expect(fake.lastMeta()).toMatchObject({ bodyIncomplete: true });
	});

	test("stream error records the error and every attempt's request and bytes", async () => {
		const fake = fakeRecording();
		const dump = new ApiRequestDumpCollector(fake.recording);
		dump.beginResponseAttempt({ transport: "websocket", body: "first" });
		dump.appendResponseText("abc");
		dump.beginResponseAttempt({ transport: "http", body: "second" });
		let reads = 0;
		const tap = captureResponseStream(
			new ReadableStream(
				{
					pull(controller) {
						if (reads++ === 0) controller.enqueue(new TextEncoder().encode("def"));
						else controller.error(new Error("broken"));
					},
				},
				{ highWaterMark: 0 },
			),
			dump,
		);
		const reader = tap.stream.getReader();
		await reader.read();
		await expect(reader.read()).rejects.toThrow("broken");
		expect(fake.chunks).toEqual(["abc", "def"]);
		expect(fake.lastMeta()).toMatchObject({ error: "broken", bodyIncomplete: true });
		expect(fake.requests).toEqual([
			{ transport: "websocket", bodyText: '"first"' },
			{ transport: "http", bodyText: '"second"' },
		]);
		expect(dump.lastRequestBody()).toBe("second");
	});
});

describe("sanitizeHeaders", () => {
	test("fully redacts Codex turn-state rather than preserving token prefixes", () => {
		expect(sanitizeHeaders({ "X-Codex-Turn-State": "opaque-routing-secret" })).toEqual({
			"X-Codex-Turn-State": "[REDACTED]",
		});
	});

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
