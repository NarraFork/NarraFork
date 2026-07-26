import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getNarraforkPath } from "../../narrafork-home";
import {
	buildMalformedCaptureRecord,
	isMalformedRequestBodyError,
	MALFORMED_REQUEST_CAPTURE_REASON,
	MALFORMED_REQUEST_DUMP_DIR,
	MALFORMED_REQUEST_DUMP_SCHEMA,
	writeMalformedRequestDump,
} from "../malformed-request-dump";
import { ApiError } from "../types";

const UPSTREAM_BODY = JSON.stringify({
	message: "Improperly formed request.",
	reason: "REQUEST_BODY_INVALID",
});

const dumpDir = getNarraforkPath(MALFORMED_REQUEST_DUMP_DIR);
const writtenFiles: string[] = [];

afterAll(async () => {
	for (const file of writtenFiles) {
		await rm(file, { force: true }).catch(() => {});
	}
});

describe("isMalformedRequestBodyError", () => {
	test("detects the raw upstream ValidationException body", () => {
		expect(isMalformedRequestBodyError(UPSTREAM_BODY)).toBe(true);
	});

		const err = new Error(`Error: ${UPSTREAM_BODY}`);
		expect(isMalformedRequestBodyError(err)).toBe(true);
	});

		expect(
			isMalformedRequestBodyError({
				code: "BAD_REQUEST",
				statusCode: 400,
				message: UPSTREAM_BODY,
			}),
		).toBe(true);
	});

	test("detects an ApiError carrying diagnostics from the NUG relay", () => {
		const err = new ApiError(400, "NUG chat error 400", {
			schema: "narrafork.error-diagnostics.v1",
			statusCode: 400,
			reason: "REQUEST_BODY_INVALID",
			responseSnippet: "Improperly formed request.",
		});
		expect(isMalformedRequestBodyError(err)).toBe(true);
	});

	test("detects the invalidState shape the loop builds from a stream error event", () => {
		expect(
			isMalformedRequestBodyError({
				reason: "validation_exception",
				message: "Improperly formed request.",
				diagnostics: { schema: "narrafork.error-diagnostics.v1", statusCode: 400 },
			}),
		).toBe(true);
	});

	test("ignores unrelated errors", () => {
		expect(isMalformedRequestBodyError(new Error("429 Too Many Requests"))).toBe(false);
		expect(isMalformedRequestBodyError({ message: "context length exceeded" })).toBe(false);
		expect(isMalformedRequestBodyError(null)).toBe(false);
		expect(isMalformedRequestBodyError(undefined)).toBe(false);
		expect(isMalformedRequestBodyError("")).toBe(false);
	});
});

	test("flags an orphaned toolResult and a toolUse without a result", () => {
				conversationId: "c1",
				history: [
					{
							content: "",
							toolUses: [{ toolUseId: "tu-1", name: "Bash", input: {} }],
						},
					},
				],
				currentMessage: {
						content: "next",
						modelId: "claude-sonnet-4.5",
							toolResults: [{ toolUseId: "tu-orphan", content: [{ text: "x" }] }],
						},
					},
				},
			},
		});

		expect(summary?.modelId).toBe("claude-sonnet-4.5");
		expect(summary?.historyLength).toBe(2);
		expect(summary?.roleSequence).toBe("UAC");
		expect(summary?.unmatchedToolUseIds).toEqual(["tu-1"]);
		expect(summary?.unmatchedToolResultIds).toEqual(["tu-orphan"]);
		expect(summary?.emptyContentIndexes).toEqual([1]);
		expect(summary?.notes).toContain("toolResult without a matching toolUse (orphaned result)");
	});

	test("flags reasoning blocks without a signature and empty image bytes", () => {
				conversationId: "c2",
				history: [
					{
							content: "thinking done",
							reasoning_content: { reasoningText: { text: "abc" } },
						},
					},
				],
				currentMessage: {
						content: "look",
						modelId: "claude-opus-4.5",
						images: [{ format: "png", source: { bytes: "" } }],
					},
				},
			},
		});

		expect(summary?.reasoningBlocks).toBe(1);
		expect(summary?.reasoningWithoutSignature).toBe(1);
		expect(summary?.imageCount).toBe(1);
		expect(summary?.emptyImageCount).toBe(1);
		expect(summary?.notes).toContain("image with empty source.bytes present");
	});

	});

	test("returns undefined for a non-object body", () => {
	});
});

describe("writeMalformedRequestDump", () => {
	test("persists the full request body to disk and masks credentials", async () => {
		const filePath = await writeMalformedRequestDump({
			narratorId: "n-malformed",
			requestId: "req_test_malformed_1",
			errorMessage: `Error: ${UPSTREAM_BODY}`,
			dump: {
				request: {
					headers: { Authorization: "Bearer super-secret-token", "content-type": "app/json" },
					body: {
							conversationId: "c3",
							currentMessage: {
							},
						},
					},
				},
				response: { status: 400, bodyText: UPSTREAM_BODY },
			},
		});

		expect(filePath).toBeTruthy();
		writtenFiles.push(filePath as string);

		const parsed = JSON.parse(await readFile(filePath as string, "utf8")) as {
			schema: string;
			trigger: string;
			request: { headers: Record<string, string>; body: Record<string, unknown> };
			response: { status: number; bodyText: string };
			summary: { modelId?: string; bodyChars?: number };
		};

		expect(parsed.schema).toBe(MALFORMED_REQUEST_DUMP_SCHEMA);
		expect(parsed.trigger).toBe(MALFORMED_REQUEST_CAPTURE_REASON);
		// The full request body is retained verbatim — that's the whole point of the capture.
		expect(parsed.request.body).toEqual({
				conversationId: "c3",
			},
		});
		// Credentials are never written to the dump file.
		expect(JSON.stringify(parsed.request.headers)).not.toContain("super-secret-token");
		expect(parsed.response.status).toBe(400);
		expect(parsed.summary.modelId).toBe("claude-sonnet-4.5");
		expect(parsed.summary.bodyChars).toBeGreaterThan(0);

		// The file lands in the dedicated dump directory under the NarraFork home.
		const entries = await readdir(dumpDir);
		expect(entries.some((name) => join(dumpDir, name) === filePath)).toBe(true);
	});

	test("records a missing-request marker when no dump collector was active", async () => {
		const filePath = await writeMalformedRequestDump({
			requestId: "req_test_malformed_2",
			provider: "nug",
			errorMessage: "Improperly formed request.",
		});
		expect(filePath).toBeTruthy();
		writtenFiles.push(filePath as string);

		const parsed = JSON.parse(await readFile(filePath as string, "utf8")) as {
			request: { missing?: boolean };
		};
		expect(parsed.request.missing).toBe(true);
	});

	test("two captures sharing a requestId tail do not overwrite each other", async () => {
		// The filename keeps only the last 24 chars of the requestId, so these two ids
		// collapse to the same suffix. Written back-to-back they can also share the
		// millisecond stamp — without a random component the second write would clobber
		// the first, destroying the very evidence being captured.
		const shared = "x".repeat(24);
		const [first, second] = await Promise.all([
			writeMalformedRequestDump({
				requestId: `req_a_${shared}`,
				provider: "nug",
				errorMessage: "first capture",
			}),
			writeMalformedRequestDump({
				requestId: `req_b_${shared}`,
				provider: "nug",
				errorMessage: "second capture",
			}),
		]);

		expect(first).toBeTruthy();
		expect(second).toBeTruthy();
		writtenFiles.push(first as string, second as string);
		expect(first).not.toBe(second);

		// Both files survive with their own content.
		const bodies = await Promise.all([
			readFile(first as string, "utf8"),
			readFile(second as string, "utf8"),
		]);
		const messages = bodies.map(
			(body) => (JSON.parse(body) as { errorMessage?: string }).errorMessage,
		);
		expect(messages).toContain("first capture");
		expect(messages).toContain("second capture");
	});

	test("pruning leaves foreign .json files in the directory alone", async () => {
		const foreign = join(dumpDir, "not-a-dump.json");
		await mkdir(dumpDir, { recursive: true });
		await writeFile(foreign, JSON.stringify({ keep: true }), "utf8");
		writtenFiles.push(foreign);

		const filePath = await writeMalformedRequestDump({
			requestId: "req_test_prune_guard",
			provider: "nug",
			errorMessage: "capture that triggers pruning",
		});
		writtenFiles.push(filePath as string);

		// Pruning only ever considers files this module wrote, so an unrelated .json
		// dropped here by a user or another tool must never be deleted.
		const entries = await readdir(dumpDir);
		expect(entries).toContain("not-a-dump.json");
	});
});

describe("buildMalformedCaptureRecord", () => {
	test("keeps the DB-side record small: no request body, only path + summary", () => {
		const bigContent = "x".repeat(200_000);
		const record = buildMalformedCaptureRecord({
			requestId: "req_test_record",
			filePath: "/home/user/.narrafork/malformed-request-dumps/dump.json",
			dump: {
				request: {
					headers: { Authorization: "Bearer secret-value" },
					body: {
							conversationId: "c4",
							currentMessage: {
							},
						},
					},
				},
				response: { status: 400, bodyText: UPSTREAM_BODY },
			},
		});

		const serialized = JSON.stringify(record);
		// The oversized body never reaches the database row.
		expect(serialized).not.toContain(bigContent);
		expect(serialized.length).toBeLessThan(8192);
		expect(serialized).not.toContain("secret-value");
		expect(record.capture.filePath).toBe("/home/user/.narrafork/malformed-request-dumps/dump.json");
		expect(record.capture.reason).toBe(MALFORMED_REQUEST_CAPTURE_REASON);
		expect(record.capture.requestBodyChars).toBeGreaterThan(200_000);
		expect(record.capture.summary?.modelId).toBe("claude-sonnet-4.5");
		expect(record.response?.bodySnippet).toContain("REQUEST_BODY_INVALID");
	});

	test("notes a failed file write instead of pretending it succeeded", () => {
		const record = buildMalformedCaptureRecord({ requestId: "req_x", filePath: null });
		expect(record.capture.filePath).toBeNull();
		expect(record.capture.note).toContain("Failed to write");
	});
});
