/**
 * Special-case capture for upstream "malformed request" rejections.
 *
 * Some streaming upstreams answer a structurally invalid body with an
 * opaque envelope that carries no field-level detail:
 *
 * ```json
 * {"__type":"...#ValidationException",
 *  "message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}
 * ```
 *
 * Nothing in that response says *which* part of the request was rejected, so the only way
 * to find the root cause is to keep the exact request body that produced it. This module
 * detects the marker and writes the full request/response to disk (outside SQLite, so the
 * main-thread DB rules still hold) plus a bounded structural summary of the request payload
 * that usually points straight at the offender (orphaned toolResults, empty content,
 * malformed images, reasoning blocks without a signature).
 *
 * ## Privacy
 *
 * A dump is a *verbatim* copy of the rejected request, so it contains the conversation that
 * produced it: the current user message plus the replayed history, and any inline images.
 * Credentials are not included — {@link sanitizeHeaders} masks `Authorization` and friends
 * before the record is written — but the message text itself is deliberately preserved,
 * because a structurally invalid body cannot be diagnosed without it.
 *
 * Consequences for operators:
 *  - Files live under `~/.narrafork/{@link MALFORMED_REQUEST_DUMP_DIR}` on the server host,
 *    readable by the server user. Treat them like conversation data, not like logs.
 *  - Writes only happen on the error path, are capped at
 *    {@link MAX_MALFORMED_DUMP_FILE_BYTES} per file, and only the newest
 *    {@link MAX_MALFORMED_DUMP_FILES} are kept, so the directory cannot grow unbounded.
 *  - Deleting the directory is always safe; nothing reads these files back at runtime.
 */

import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateShortId } from "../id";
import { logger } from "../logger";
import { getNarraforkPath } from "../narrafork-home";
import { sliceToUtf8Budget } from "../utf8-budget";
import { type ApiRequestDump, sanitizeHeaders } from "./request-dump";
import type { ApiRequestDiagnostics } from "./types";

export const MALFORMED_REQUEST_DUMP_SCHEMA = "narrafork.malformed-request-dump.v1" as const;
/** Reason tag stored on the api_requests raw dump so the DB row points at the file. */
export const MALFORMED_REQUEST_CAPTURE_REASON = "malformed_request_body" as const;
/** Directory (under the NarraFork home) holding forced malformed-request dumps. */
export const MALFORMED_REQUEST_DUMP_DIR = "malformed-request-dumps";
/** Hard ceiling for a single dump file. Request bodies with inline images can be large. */
export const MAX_MALFORMED_DUMP_FILE_BYTES = 32 * 1024 * 1024;
/** Keep only the newest N dumps so a repeating failure cannot fill the disk. */
export const MAX_MALFORMED_DUMP_FILES = 20;

/** Lowercased fragments that uniquely identify an upstream malformed-body rejection. */
const MALFORMED_REQUEST_MARKERS = ["request_body_invalid", "improperly formed request"];

const MAX_MATCH_TEXT_CHARS = 32_768;
const MAX_SUMMARY_LIST_ITEMS = 20;
const MAX_ROLE_SEQUENCE_CHARS = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Collect the error text worth matching against, without serializing an entire
 * provider payload: only the message-ish fields of the error, its cause, and any
 * attached diagnostics.
 */
function collectErrorText(value: unknown, depth = 0): string {
	if (value == null || depth > 3) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value instanceof Error) {
		return [
			value.message,
			collectErrorText((value as { cause?: unknown }).cause, depth + 1),
			collectErrorText((value as { diagnostics?: unknown }).diagnostics, depth + 1),
			collectErrorText((value as { responseSnippet?: unknown }).responseSnippet, depth + 1),
		]
			.filter(Boolean)
			.join(" ");
	}
	if (!isRecord(value)) return "";
	const fields = [
		"message",
		"reason",
		"code",
		"errorType",
		"__type",
		"responseSnippet",
		"bodyText",
		"error",
		"cause",
		"diagnostics",
	];
	const parts: string[] = [];
	for (const field of fields) {
		const part = collectErrorText(value[field], depth + 1);
		if (part) parts.push(part);
	}
	return parts.join(" ");
}

/**
 * Whether an error (or raw response text) is an upstream malformed-request-body
 * rejection. Accepts anything: a thrown Error, an invalidState-ish record, or the
 * raw response string.
 */
export function isMalformedRequestBodyError(value: unknown): boolean {
	const text = collectErrorText(value).slice(0, MAX_MATCH_TEXT_CHARS).toLowerCase();
	if (!text) return false;
	return MALFORMED_REQUEST_MARKERS.some((marker) => text.includes(marker));
}

export interface MalformedRequestBodySummary {
	bodyChars?: number;
	topLevelKeys?: string[];
	modelId?: string;
	historyLength?: number;
	/** Role sequence of history + current message, e.g. "UAUAU…C". */
	roleSequence?: string;
	/** History indexes whose `content` is an empty string. */
	emptyContentIndexes?: number[];
	toolUseCount?: number;
	toolResultCount?: number;
	unmatchedToolUseIds?: string[];
	unmatchedToolResultIds?: string[];
	duplicateToolUseIds?: string[];
	imageCount?: number;
	imageBase64Chars?: number;
	emptyImageCount?: number;
	reasoningBlocks?: number;
	reasoningWithoutSignature?: number;
	currentMessageToolResults?: number;
	currentMessageContentChars?: number;
	toolSpecCount?: number;
	notes?: string[];
}

function limitList<T>(values: Iterable<T>): T[] {
	const out: T[] = [];
	for (const value of values) {
		if (out.length >= MAX_SUMMARY_LIST_ITEMS) break;
		out.push(value);
	}
	return out;
}

function countImages(message: Record<string, unknown>, summary: MalformedRequestBodySummary): void {
	const images = message.images;
	if (!Array.isArray(images)) return;
	summary.imageCount = (summary.imageCount ?? 0) + images.length;
	for (const image of images) {
		if (!isRecord(image)) continue;
		const source = isRecord(image.source) ? image.source : undefined;
		const bytes = typeof source?.bytes === "string" ? source.bytes : "";
		summary.imageBase64Chars = (summary.imageBase64Chars ?? 0) + bytes.length;
		if (!bytes) summary.emptyImageCount = (summary.emptyImageCount ?? 0) + 1;
	}
}

/**
 * Build a bounded structural summary of a chat request body. Purely descriptive —
 * it never mutates the body and never copies conversation content, only shapes/counts.
 */
export function summarizeRequestBody(body: unknown): MalformedRequestBodySummary | undefined {
	if (!isRecord(body)) return undefined;
	const summary: MalformedRequestBodySummary = {};
	const notes: string[] = [];
	summary.topLevelKeys = limitList(Object.keys(body));

		summary.notes = notes;
		return summary;
	}

	summary.historyLength = history.length;

	const toolUseIds: string[] = [];
	const toolResultIds = new Set<string>();
	const seenToolUseIds = new Set<string>();
	const duplicateToolUseIds = new Set<string>();
	const emptyContentIndexes: number[] = [];
	let roles = "";

	history.forEach((entry, index) => {
		if (!isRecord(entry)) {
			roles += "?";
			return;
		}
			: undefined;

		if (userMessage) {
			roles += "U";
			if (userMessage.content === "") emptyContentIndexes.push(index);
			if (!summary.modelId && typeof userMessage.modelId === "string") {
				summary.modelId = userMessage.modelId;
			}
			countImages(userMessage, summary);
				: undefined;
			const results = Array.isArray(context?.toolResults) ? context.toolResults : [];
			for (const result of results) {
				if (isRecord(result) && typeof result.toolUseId === "string") {
					toolResultIds.add(result.toolUseId);
				}
			}
			const tools = Array.isArray(context?.tools) ? context.tools : [];
			if (tools.length > 0) summary.toolSpecCount = (summary.toolSpecCount ?? 0) + tools.length;
			return;
		}

		if (assistantMessage) {
			roles += "A";
			if (assistantMessage.content === "") emptyContentIndexes.push(index);
			const uses = Array.isArray(assistantMessage.toolUses) ? assistantMessage.toolUses : [];
			for (const use of uses) {
				if (!isRecord(use) || typeof use.toolUseId !== "string") continue;
				toolUseIds.push(use.toolUseId);
				if (seenToolUseIds.has(use.toolUseId)) duplicateToolUseIds.add(use.toolUseId);
				seenToolUseIds.add(use.toolUseId);
			}
			const reasoning = assistantMessage.reasoning_content;
			if (isRecord(reasoning)) {
				summary.reasoningBlocks = (summary.reasoningBlocks ?? 0) + 1;
				const reasoningText = isRecord(reasoning.reasoningText)
					? reasoning.reasoningText
					: undefined;
				const signature = reasoningText?.signature;
				if (typeof signature !== "string" || signature.length === 0) {
					summary.reasoningWithoutSignature = (summary.reasoningWithoutSignature ?? 0) + 1;
				}
			}
			return;
		}
		roles += "?";
	});

		: undefined;
		: undefined;
	if (currentUser) {
		roles += "C";
		if (typeof currentUser.modelId === "string") summary.modelId = currentUser.modelId;
		summary.currentMessageContentChars =
			typeof currentUser.content === "string" ? currentUser.content.length : 0;
		countImages(currentUser, summary);
			: undefined;
		const results = Array.isArray(context?.toolResults) ? context.toolResults : [];
		summary.currentMessageToolResults = results.length;
		for (const result of results) {
			if (isRecord(result) && typeof result.toolUseId === "string") {
				toolResultIds.add(result.toolUseId);
			}
		}
		const tools = Array.isArray(context?.tools) ? context.tools : [];
		if (tools.length > 0) summary.toolSpecCount = (summary.toolSpecCount ?? 0) + tools.length;
	} else {
	}

	summary.roleSequence =
		roles.length > MAX_ROLE_SEQUENCE_CHARS
			? `${roles.slice(0, MAX_ROLE_SEQUENCE_CHARS)}…`
			: roles || undefined;
	summary.toolUseCount = toolUseIds.length;
	summary.toolResultCount = toolResultIds.size;
	if (emptyContentIndexes.length > 0) {
		summary.emptyContentIndexes = limitList(emptyContentIndexes);
	}
	if (duplicateToolUseIds.size > 0) {
		summary.duplicateToolUseIds = limitList(duplicateToolUseIds);
		notes.push("duplicate toolUseId present in history");
	}

	const unmatchedUses = toolUseIds.filter((id) => !toolResultIds.has(id));
	if (unmatchedUses.length > 0) {
		summary.unmatchedToolUseIds = limitList(new Set(unmatchedUses));
		notes.push("toolUse without a matching toolResult");
	}
	const uniqueUses = new Set(toolUseIds);
	const unmatchedResults = [...toolResultIds].filter((id) => !uniqueUses.has(id));
	if (unmatchedResults.length > 0) {
		summary.unmatchedToolResultIds = limitList(unmatchedResults);
		notes.push("toolResult without a matching toolUse (orphaned result)");
	}
	if (summary.emptyImageCount) notes.push("image with empty source.bytes present");

	if (notes.length > 0) summary.notes = limitList(notes);
	return summary;
}

export interface MalformedRequestDumpInput {
	narratorId?: string;
	requestId?: string;
	provider?: string;
	model?: string;
	errorMessage?: string;
	diagnostics?: ApiRequestDiagnostics;
	dump?: ApiRequestDump;
}

/** Max chars of the upstream response body retained in the small DB-side record. */
const DB_RECORD_RESPONSE_SNIPPET_CHARS = 2048;

export interface MalformedRequestCaptureRecord {
	schema: typeof MALFORMED_REQUEST_DUMP_SCHEMA;
	capture: {
		reason: typeof MALFORMED_REQUEST_CAPTURE_REASON;
		filePath: string | null;
		note: string;
		requestBodyChars?: number;
		summary?: MalformedRequestBodySummary;
	};
	provider?: string;
	model?: string;
	request?: { transport?: string; url?: string; headers?: Record<string, string> };
	response?: { status?: number; bodySnippet?: string; error?: string };
}

/**
 * Build the *small* record stored in `api_requests.raw_dump_json`.
 *
 * The full request body only ever lives in the on-disk dump file: writing a multi-MB
 * body (inline images included) into a SQLite row would violate the main-thread/large-field
 * rules in CLAUDE.md. The DB row keeps the file path, the bounded structural summary, and
 * a short response snippet so the UI can point at the capture.
 */
export function buildMalformedCaptureRecord(
	input: MalformedRequestDumpInput & { filePath: string | null },
): MalformedRequestCaptureRecord {
	const request = input.dump?.request;
	const bodyChars = request?.body != null ? (JSON.stringify(request.body)?.length ?? 0) : undefined;
	const responseBody = input.dump?.response?.bodyText;
	return {
		schema: MALFORMED_REQUEST_DUMP_SCHEMA,
		capture: {
			reason: MALFORMED_REQUEST_CAPTURE_REASON,
			filePath: input.filePath,
			note: input.filePath
				? "Full request body saved to this file on the server (not stored in the database)."
				: "Failed to write the dump file — see server logs for the failure reason.",
			requestBodyChars: bodyChars,
			summary: summarizeRequestBody(request?.body),
		},
		provider: input.provider ?? input.dump?.provider,
		model: input.model ?? input.dump?.model,
		request: request
			? {
					transport: request.transport,
					url: request.url,
					headers: sanitizeHeaders(request.headers),
				}
			: undefined,
		response: input.dump?.response
			? {
					status: input.dump.response.status,
					bodySnippet:
						typeof responseBody === "string"
							? responseBody.slice(0, DB_RECORD_RESPONSE_SNIPPET_CHARS)
							: undefined,
					error: input.dump.response.error,
				}
			: undefined,
	};
}

function buildPayload(input: MalformedRequestDumpInput): Record<string, unknown> {
	const request = input.dump?.request;
	const bodyChars = request?.body != null ? (JSON.stringify(request.body)?.length ?? 0) : undefined;
	const summary = summarizeRequestBody(request?.body);
	return {
		schema: MALFORMED_REQUEST_DUMP_SCHEMA,
		trigger: MALFORMED_REQUEST_CAPTURE_REASON,
		capturedAt: new Date().toISOString(),
		narratorId: input.narratorId,
		requestId: input.requestId,
		provider: input.provider ?? input.dump?.provider,
		model: input.model ?? input.dump?.model,
		errorMessage: input.errorMessage,
		diagnostics: input.diagnostics ?? input.dump?.diagnostics,
		summary: summary ? { ...summary, bodyChars } : { bodyChars },
		request: request
			? {
					transport: request.transport,
					url: request.url,
					headers: sanitizeHeaders(request.headers),
					body: request.body,
				}
			: { missing: true, note: "No request dump collector was active for this provider call." },
		response: input.dump?.response,
	};
}

/**
 * Bytes held back from the body budget for everything around it (metadata, summary,
 * headers, and — for the spill store — the envelope the dump is nested in). Generous on
 * purpose: overshooting costs a few unused KB, undershooting pushes the result back over
 * the ceiling and loses the body entirely.
 */
const SHED_OVERHEAD_RESERVE_BYTES = 4096;

const DROPPED_RESPONSE = {
	dropped: true,
	note: "Dropped to fit the dump file size ceiling.",
} as const;

/**
 * The successive forms a `{ request, response }` dump can take on the way to fitting a byte
 * ceiling, largest-first, so the request body (the whole point of a dump) survives longest.
 *
 * Only the *policy* lives here — what may be shed, in what order, with what body budget.
 * Serialization stays with the caller because the two callers wrap the same payload
 * differently: {@link writeMalformedRequestDump} writes it as the file's top level, while
 * the spill store nests it inside an envelope and must measure the envelope. Sharing the
 * policy while splitting the wrapping is what keeps the two from drifting: a lazily
 * generated candidate is never serialized unless the previous one was too big.
 *
 * The first candidate is the untouched payload (`truncated: false`); every later one is
 * lossy. The last candidate may still exceed the ceiling — a caller that runs out of
 * candidates should keep it anyway, since a too-large record still beats no record.
 */
export function* dumpSheddingCandidates(
	payload: Record<string, unknown>,
	maxBytes: number,
): Generator<{ value: Record<string, unknown>; truncated: boolean }> {
	yield { value: payload, truncated: false };

	// Response payloads (SSE events / body text) are the most expendable part.
	yield { value: { ...payload, response: DROPPED_RESPONSE }, truncated: true };

	// Last resort: keep metadata + summary, store the body as truncated text. Serializing
	// the body to text rather than pruning its object graph is deliberate: which key is
	// oversized varies per provider, and the head of the JSON is what shows the offender.
	const request = isRecord(payload.request) ? payload.request : undefined;
	const bodyText = request?.body != null ? (JSON.stringify(request.body) ?? "") : "";
	const budget = Math.max(0, maxBytes - SHED_OVERHEAD_RESERVE_BYTES);
	yield {
		value: {
			...payload,
			response: DROPPED_RESPONSE,
			request: {
				...request,
				body: undefined,
				bodyTruncated: true,
				bodyChars: bodyText.length,
				bodyText: sliceToUtf8Budget(bodyText, budget),
			},
		},
		truncated: true,
	};
}

/**
 * Serialize within a byte ceiling, shedding the largest optional parts first so the
 * request body (the whole point of the capture) survives as long as possible.
 */
function serializeWithinLimit(
	payload: Record<string, unknown>,
	maxBytes: number,
): { json: string; truncated: boolean; originalBytes: number } {
	const pretty = JSON.stringify(payload, null, 2) ?? "";
	const prettyBytes = Buffer.byteLength(pretty, "utf8");
	if (prettyBytes <= maxBytes)
		return { json: pretty, truncated: false, originalBytes: prettyBytes };

	let originalBytes = prettyBytes;
	let last = { json: pretty, truncated: true, originalBytes };
	for (const candidate of dumpSheddingCandidates(payload, maxBytes)) {
		const json = JSON.stringify(candidate.value) ?? "";
		const bytes = Buffer.byteLength(json, "utf8");
		// The untouched payload's compact size is what "original" means for this file.
		if (!candidate.truncated) originalBytes = bytes;
		if (bytes <= maxBytes) return { json, truncated: candidate.truncated, originalBytes };
		last = { json, truncated: true, originalBytes };
	}
	// Even the smallest form is over the ceiling. Keep it: a too-large record still beats
	// having no record of a rejection that carries no other detail.
	return last;
}

/**
 * Match only the files this module writes: `<ISO stamp>_<suffix>_<shortid>.json`.
 *
 * Pruning deletes files, so it must never consider anything it did not create. A user
 * or another tool dropping an unrelated `.json` here should be left alone rather than
 * counted toward the cap and silently removed.
 */
const DUMP_FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d-]+Z?_.*\.json$/;

async function pruneOldDumps(dir: string): Promise<void> {
	try {
		const names = (await readdir(dir)).filter((name) => DUMP_FILE_NAME_PATTERN.test(name));
		if (names.length <= MAX_MALFORMED_DUMP_FILES) return;

		// Order by mtime rather than by filename. The name embeds a timestamp, but relying
		// on its lexical order silently couples deletion to the exact stamp format — a later
		// format tweak would start deleting the wrong files. mtime is what "oldest" means.
		const withTimes = await Promise.all(
			names.map(async (name) => {
				const mtimeMs = await stat(join(dir, name))
					.then((s) => s.mtimeMs)
					// Unreadable stat: sort it oldest so a stuck file gets reclaimed first.
					.catch(() => 0);
				return { name, mtimeMs };
			}),
		);
		withTimes.sort((a, b) => a.mtimeMs - b.mtimeMs);

		const excess = withTimes.length - MAX_MALFORMED_DUMP_FILES;
		for (const entry of withTimes.slice(0, excess)) {
			await unlink(join(dir, entry.name)).catch(() => {});
		}
	} catch {
		// Pruning is best-effort; never let it fail the capture.
	}
}

/**
 * Persist a full malformed-request capture to disk and return the file path.
 *
 * Returns null when the write fails — callers treat the dump as best-effort and must
 * never fail the request because of it.
 */
export async function writeMalformedRequestDump(
	input: MalformedRequestDumpInput,
): Promise<string | null> {
	const dir = getNarraforkPath(MALFORMED_REQUEST_DUMP_DIR);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	// `requestId` is truncated to its last 24 chars, so two ids sharing a tail collide;
	// on a retry storm two captures can also land in the same millisecond. Either case
	// would make the second `writeFile` silently overwrite the first dump — exactly the
	// evidence someone is trying to collect. A random component makes the name unique.
	const suffix = (input.requestId ?? "unknown").replace(/[^\w.-]/g, "_").slice(-24);
	const filePath = join(dir, `${stamp}_${suffix}_${generateShortId()}.json`);

	try {
		const payload = buildPayload(input);
		const { json, truncated } = serializeWithinLimit(payload, MAX_MALFORMED_DUMP_FILE_BYTES);
		await mkdir(dir, { recursive: true });
		await writeFile(filePath, json, "utf8");
		logger.warn("Captured malformed upstream request body", {
			narratorId: input.narratorId,
			requestId: input.requestId,
			provider: input.provider,
			model: input.model,
			filePath,
			truncated,
			summary: (payload as { summary?: unknown }).summary,
		});
		await pruneOldDumps(dir);
		return filePath;
	} catch (error) {
		logger.warn("Failed to write malformed request dump", {
			narratorId: input.narratorId,
			requestId: input.requestId,
			filePath,
			error: String(error),
		});
		return null;
	}
}
