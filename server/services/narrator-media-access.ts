/**
 * Proof that ONE already-authorized narrator's history references an exact upload
 * (owner narrator + image/media id). The upload routes use it so a fork or COW copy can
 * show its source's uploads to a reader who cannot read the source.
 *
 * The lookup is bounded for the main thread:
 *   - a SQL prefilter (`instr`/`strpos` on the stored JSON text) walks the refs in
 *     fixed windows, so only rows that contain the id at all are decoded in JS;
 *   - hard caps on refs examined, wall time and rows decoded deny (fail closed);
 *   - a per-user and per-process concurrency gate denies when its queue is full.
 *
 * Only structurally decoded values count. Drizzle returns JSON columns already decoded
 * (SQLite JSON mode, the PostgreSQL `jsonText` codec), so a string here is genuine string
 * data, typically a tool's plain-text output. It is never parsed again: text that merely
 * looks like `{"_images":[…]}` is not a reference.
 */
import { toolOutputImages } from "@shared/agent-protocol/tool-output";
import { isMediaContentBlock } from "@shared/media-attachments";
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db, postgresRuntime } from "../db";
import * as pg from "../db/postgres-schema";
import { narratorMessageRefs, narratorMessages, narratorToolCalls } from "../db/schema";
import { logger } from "../lib/logger";
import { contentJsonSql, fillBodies } from "./narrator-body-reads";

/** Refs examined per statement: the unit of synchronous database work. */
const WINDOW = 256;
/** Tool outputs decoded per statement. */
const MAX_TOOLS_PER_PAGE = 64;
/** Upload ids are 8-character nanoids; anything shorter would match too much text. */
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,100}$/;

interface LookupLimits {
	/** Refs one lookup may examine. */
	maxRefs: number;
	/** Wall time one lookup may take. */
	maxMs: number;
	/** Candidate messages plus tool outputs one lookup may decode. */
	maxDecoded: number;
	/** Lookups running at once in this process. */
	processRunning: number;
	/** Lookups running at once for one user. */
	userRunning: number;
	/** Lookups running or waiting for one user; more are denied at once. */
	userPending: number;
	/** Lookups running or waiting in this process; more are denied at once. */
	processPending: number;
}

const DEFAULT_LIMITS: LookupLimits = {
	maxRefs: 100_000,
	maxMs: 2_000,
	maxDecoded: 256,
	processRunning: 4,
	userRunning: 2,
	userPending: 32,
	processPending: 256,
};
let limits = DEFAULT_LIMITS;

/** Test hook: tighten the caps; `null` restores the defaults. */
export function setReferenceLookupLimitsForTests(overrides: Partial<LookupLimits> | null): void {
	limits = overrides ? { ...DEFAULT_LIMITS, ...overrides } : DEFAULT_LIMITS;
}

export interface ReferenceLookupOptions {
	signal?: AbortSignal;
	/** The requesting user; bounds how many lookups one user runs at once. */
	principal?: string;
}

/**
 * Whether one decoded value references the upload being authorized. `fallbackOwner` is
 * the row's own narrator: blocks written before `uploadNarratorId` existed belong to it.
 */
interface UploadReferenceMatcher {
	content(blocks: unknown, fallbackOwner: string): boolean;
	toolOutput(output: unknown, fallbackOwner: string): boolean;
}

/** A decoded JSON object, never a string that happens to contain JSON. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mediaMatcher(owner: string, mediaId: string): UploadReferenceMatcher {
	const matches = (blocks: unknown, fallbackOwner: string) =>
		Array.isArray(blocks) &&
		blocks.some(
			(block) =>
				isMediaContentBlock(block) &&
				block.mediaId === mediaId &&
				(block.uploadNarratorId || fallbackOwner) === owner,
		);
	return {
		content: matches,
		toolOutput: (output, fallbackOwner) =>
			isRecord(output) && matches(output._media, fallbackOwner),
	};
}

function imageMatcher(owner: string, imageId: string): UploadReferenceMatcher {
	return {
		// Persisted user-message image blocks (`imageRefToContentBlock`).
		content: (blocks, fallbackOwner) =>
			Array.isArray(blocks) &&
			blocks.some((block) => {
				if (!isRecord(block)) return false;
				const uploader =
					typeof block.uploadNarratorId === "string" && block.uploadNarratorId
						? block.uploadNarratorId
						: fallbackOwner;
				return block.type === "image" && block.imageId === imageId && uploader === owner;
			}),
		// Images a tool returned (`_images`); stored refs always name their uploader.
		toolOutput: (output) =>
			isRecord(output) &&
			toolOutputImages(output).some(
				(image) =>
					image.imageId === imageId &&
					"uploadNarratorId" in image &&
					image.uploadNarratorId === owner,
			),
	};
}

/** Prove an exact owner/id media reference in ONE already-authorized narrator's refs. */
export function narratorReferencesMedia(
	referencingNarratorId: string,
	uploadNarratorId: string,
	mediaId: string,
	options: ReferenceLookupOptions = {},
): Promise<boolean> {
	return narratorReferencesUpload(
		referencingNarratorId,
		mediaId,
		mediaMatcher(uploadNarratorId, mediaId),
		options,
	);
}

/**
 * Prove an exact owner/id image reference in ONE already-authorized narrator's refs:
 * a user-message image block or a tool output's `_images`.
 */
export function narratorReferencesImage(
	referencingNarratorId: string,
	uploadNarratorId: string,
	imageId: string,
	options: ReferenceLookupOptions = {},
): Promise<boolean> {
	return narratorReferencesUpload(
		referencingNarratorId,
		imageId,
		imageMatcher(uploadNarratorId, imageId),
		options,
	);
}

// ── Concurrency gate ────────────────────────────────────────────────────────

let running = 0;
let pendingTotal = 0;
const runningByUser = new Map<string, number>();
const pendingByUser = new Map<string, number>();
const waiters: Array<{ principal: string; wake: () => void }> = [];

function bump(map: Map<string, number>, key: string, delta: number) {
	const next = (map.get(key) ?? 0) + delta;
	if (next > 0) map.set(key, next);
	else map.delete(key);
}

function mayStart(principal: string): boolean {
	return (
		running < limits.processRunning && (runningByUser.get(principal) ?? 0) < limits.userRunning
	);
}

function markRunning(principal: string) {
	running++;
	bump(runningByUser, principal, 1);
}

function finish(principal: string) {
	running--;
	bump(runningByUser, principal, -1);
	bump(pendingByUser, principal, -1);
	pendingTotal--;
	const next = waiters.findIndex((waiter) => mayStart(waiter.principal));
	if (next >= 0) waiters.splice(next, 1)[0].wake();
}

/** Run `lookup` in a slot, waiting in a bounded queue; a full queue denies at once. */
async function withLookupSlot(
	principal: string,
	signal: AbortSignal | undefined,
	lookup: () => Promise<boolean>,
): Promise<boolean> {
	signal?.throwIfAborted();
	if ((pendingByUser.get(principal) ?? 0) >= limits.userPending) return denied("user queue full");
	if (pendingTotal >= limits.processPending) return denied("process queue full");
	bump(pendingByUser, principal, 1);
	pendingTotal++;
	if (mayStart(principal)) markRunning(principal);
	else {
		try {
			await new Promise<void>((resolve, reject) => {
				const waiter = {
					principal,
					wake: () => {
						signal?.removeEventListener("abort", abort);
						markRunning(principal);
						resolve();
					},
				};
				const abort = () => {
					waiters.splice(waiters.indexOf(waiter), 1);
					reject(signal?.reason);
				};
				waiters.push(waiter);
				signal?.addEventListener("abort", abort, { once: true });
			});
		} catch (error) {
			bump(pendingByUser, principal, -1);
			pendingTotal--;
			throw error;
		}
	}
	try {
		return await lookup();
	} finally {
		finish(principal);
	}
}

function denied(reason: string, detail: Record<string, unknown> = {}): false {
	logger.warn("Upload reference lookup denied", { reason, ...detail });
	return false;
}

// ── Lookup ──────────────────────────────────────────────────────────────────

interface WindowRow {
	refId: string;
	seq: number;
	messageId: string;
	candidate: unknown;
}

/**
 * Prove an exact owner/id reference in ONE already-authorized narrator's refs.
 * COW copies need not retain the original message owner; tool calls are joined
 * by messageId, not narratorId, because forks can share another owner's message.
 * Never searches arbitrary narrators or treats knowledge of an upload id as access.
 *
 * Each window statement reads at most WINDOW refs and tests their stored JSON text for
 * the id in SQL; only those candidates are decoded and matched exactly in JS. The text
 * test can only produce false positives (stale `content_json` beside current block rows,
 * the id inside unrelated text), never false negatives, because upload ids need no JSON
 * escaping and every place a reference is read from is tested.
 */
async function narratorReferencesUpload(
	referencingNarratorId: string,
	uploadId: string,
	matcher: UploadReferenceMatcher,
	{ signal, principal = "" }: ReferenceLookupOptions,
): Promise<boolean> {
	if (!UPLOAD_ID.test(uploadId)) return false;
	return withLookupSlot(principal, signal, () =>
		lookupReference(referencingNarratorId, uploadId, matcher, signal),
	);
}

async function lookupReference(
	referencingNarratorId: string,
	uploadId: string,
	matcher: UploadReferenceMatcher,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	const pgDb = postgresRuntime?.client.db;
	const startedAt = performance.now();
	let examined = 0;
	let decoded = 0;
	let cursor: { seq: number; refId: string } | undefined;

	const readWindow = async (): Promise<WindowRow[]> => {
		if (pgDb) {
			return pgDb
				.select({
					refId: pg.narratorMessageRefs.id,
					seq: pg.narratorMessageRefs.seq,
					messageId: pg.narratorMessageRefs.messageId,
					candidate: sql<boolean>`(strpos(${pg.narratorMessages.contentJson}, ${uploadId}) > 0
						OR EXISTS (SELECT 1 FROM narrator_tool_calls t
							WHERE t.message_id = ${pg.narratorMessages.id}
								AND strpos(t.output_json, ${uploadId}) > 0))`,
				})
				.from(pg.narratorMessageRefs)
				.innerJoin(
					pg.narratorMessages,
					eq(pg.narratorMessages.id, pg.narratorMessageRefs.messageId),
				)
				.where(
					and(
						eq(pg.narratorMessageRefs.narratorId, referencingNarratorId),
						cursor === undefined
							? undefined
							: or(
									gt(pg.narratorMessageRefs.seq, cursor.seq),
									and(
										eq(pg.narratorMessageRefs.seq, cursor.seq),
										gt(pg.narratorMessageRefs.id, cursor.refId),
									),
								),
					),
				)
				.orderBy(pg.narratorMessageRefs.seq, pg.narratorMessageRefs.id)
				.limit(WINDOW);
		}
		return db
			.select({
				refId: narratorMessageRefs.id,
				seq: narratorMessageRefs.seq,
				messageId: narratorMessageRefs.messageId,
				// Block rows hold the body of block-format envelopes, so they are tested too.
				candidate: sql<number>`(instr(${narratorMessages.contentJson}, ${uploadId}) > 0
					OR EXISTS (SELECT 1 FROM narrator_blocks b
						WHERE b.message_id = ${narratorMessages.id} AND instr(b.payload, ${uploadId}) > 0)
					OR EXISTS (SELECT 1 FROM narrator_tool_calls t
						WHERE t.message_id = ${narratorMessages.id} AND instr(t.output_json, ${uploadId}) > 0))`,
			})
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, referencingNarratorId),
					cursor === undefined
						? undefined
						: or(
								gt(narratorMessageRefs.seq, cursor.seq),
								and(
									eq(narratorMessageRefs.seq, cursor.seq),
									gt(narratorMessageRefs.id, cursor.refId),
								),
							),
				),
			)
			.orderBy(narratorMessageRefs.seq, narratorMessageRefs.id)
			.limit(WINDOW);
	};

	const readBodies = async (ids: string[]) => {
		if (pgDb)
			return pgDb
				.select({
					id: pg.narratorMessages.id,
					owner: pg.narratorMessages.narratorId,
					contentJson: contentJsonSql(pg.narratorMessages),
				})
				.from(pg.narratorMessages)
				.where(inArray(pg.narratorMessages.id, ids));
		return fillBodies(
			await db
				.select({
					id: narratorMessages.id,
					owner: narratorMessages.narratorId,
					contentJson: contentJsonSql(),
				})
				.from(narratorMessages)
				.where(inArray(narratorMessages.id, ids)),
		);
	};

	const readCalls = (ids: string[], toolCursor: string | undefined) => {
		if (pgDb)
			return pgDb
				.select({
					id: pg.narratorToolCalls.id,
					messageId: pg.narratorToolCalls.messageId,
					owner: pg.narratorToolCalls.narratorId,
					output: pg.narratorToolCalls.outputJson,
				})
				.from(pg.narratorToolCalls)
				.where(
					and(
						inArray(pg.narratorToolCalls.messageId, ids),
						sql`strpos(${pg.narratorToolCalls.outputJson}, ${uploadId}) > 0`,
						toolCursor === undefined ? undefined : gt(pg.narratorToolCalls.id, toolCursor),
					),
				)
				.orderBy(pg.narratorToolCalls.id)
				.limit(MAX_TOOLS_PER_PAGE);
		return db
			.select({
				id: narratorToolCalls.id,
				messageId: narratorToolCalls.messageId,
				owner: narratorToolCalls.narratorId,
				output: narratorToolCalls.outputJson,
			})
			.from(narratorToolCalls)
			.where(
				and(
					inArray(narratorToolCalls.messageId, ids),
					sql`instr(${narratorToolCalls.outputJson}, ${uploadId}) > 0`,
					toolCursor === undefined ? undefined : gt(narratorToolCalls.id, toolCursor),
				),
			)
			.orderBy(narratorToolCalls.id)
			.limit(MAX_TOOLS_PER_PAGE);
	};

	const refStillExists = async (refId: string, messageId: string) => {
		signal?.throwIfAborted();
		const rows = pgDb
			? await pgDb
					.select({ id: pg.narratorMessageRefs.id })
					.from(pg.narratorMessageRefs)
					.where(
						and(
							eq(pg.narratorMessageRefs.id, refId),
							eq(pg.narratorMessageRefs.narratorId, referencingNarratorId),
							eq(pg.narratorMessageRefs.messageId, messageId),
						),
					)
					.limit(1)
			: await db
					.select({ id: narratorMessageRefs.id })
					.from(narratorMessageRefs)
					.where(
						and(
							eq(narratorMessageRefs.id, refId),
							eq(narratorMessageRefs.narratorId, referencingNarratorId),
							eq(narratorMessageRefs.messageId, messageId),
						),
					)
					.limit(1);
		signal?.throwIfAborted();
		return rows.length > 0;
	};

	/** `false` (deny) once a decode or time cap is exceeded, otherwise null. */
	const overBudget = () => {
		const detail = { referencingNarratorId, examined, decoded };
		if (decoded > limits.maxDecoded) return denied("decode cap", detail);
		if (performance.now() - startedAt > limits.maxMs) return denied("time cap", detail);
		return null;
	};

	/** Decode the window's candidates and match them exactly, in history order. */
	const candidatesReference = async (candidates: WindowRow[]): Promise<boolean | null> => {
		const ids = candidates.map((row) => row.messageId);
		decoded += ids.length;
		const capped = overBudget();
		if (capped !== null) return capped;
		const bodies = new Map((await readBodies(ids)).map((row) => [row.id, row]));
		signal?.throwIfAborted();
		for (const row of candidates) {
			const body = bodies.get(row.messageId);
			if (
				body &&
				matcher.content(body.contentJson, body.owner) &&
				(await refStillExists(row.refId, row.messageId))
			)
				return true;
		}
		let toolCursor: string | undefined;
		while (true) {
			signal?.throwIfAborted();
			const calls = await readCalls(ids, toolCursor);
			signal?.throwIfAborted();
			decoded += calls.length;
			const toolCapped = overBudget();
			if (toolCapped !== null) return toolCapped;
			for (const call of calls) {
				const ref = candidates.find((row) => row.messageId === call.messageId);
				if (
					ref &&
					matcher.toolOutput(call.output, call.owner) &&
					(await refStillExists(ref.refId, call.messageId))
				)
					return true;
			}
			if (calls.length < MAX_TOOLS_PER_PAGE) return null;
			toolCursor = calls[calls.length - 1].id;
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	};

	while (true) {
		signal?.throwIfAborted();
		if (examined >= limits.maxRefs)
			return denied("ref cap", { referencingNarratorId, examined, decoded });
		const capped = overBudget();
		if (capped !== null) return capped;
		const rows = await readWindow();
		signal?.throwIfAborted();
		examined += rows.length;
		const candidates = rows.filter((row) => Boolean(row.candidate));
		if (candidates.length > 0) {
			const found = await candidatesReference(candidates);
			if (found !== null) return found;
		}
		if (rows.length < WINDOW) return false;
		const last = rows[rows.length - 1];
		cursor = { seq: last.seq, refId: last.refId };
		// Yield between windows so HTTP/WS/Agent work can run.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}
