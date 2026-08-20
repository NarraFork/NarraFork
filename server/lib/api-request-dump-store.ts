/**
 * api-request-dump-store.ts — on-disk overflow store for API request dumps.
 *
 * ## Why dumps spill to files
 *
 * A dump exists to answer one question: "what exactly did we send, and what came back".
 * That makes it *the* artifact a user opens when a provider rejects a request, so it must
 * never arrive incomplete. But the same completeness makes it large — a full conversation
 * history with replayed tool output and inline images routinely runs to megabytes, and
 * CLAUDE.md forbids growing a SQLite row without bound (the row is read on the HTTP main
 * thread alongside ordinary CRUD).
 *
 * The two requirements are only in conflict while the dump lives in the database. So:
 *
 *  - The database row keeps a bounded, human-readable *head* of the dump plus a
 *    {@link RawDumpSpillPointer} naming the file.
 *  - The complete dump goes to a file under `~/.narrafork/{@link REQUEST_DUMP_SPILL_DIR}`,
 *    and `GET /api/usage-history/:id/raw-dump` serves it verbatim.
 *
 * Nothing in the product reads these files at runtime; deleting the directory is always
 * safe and only costs the ability to download older dumps in full.
 *
 * ## Privacy
 *
 * A dump is a verbatim copy of a request, so it contains the conversation that produced
 * it — the current message, the replayed history, and any inline images. Credentials are
 * masked by `sanitizeHeaders` before a dump ever reaches this module, but the message text
 * is deliberately preserved because a rejected request cannot be diagnosed without it.
 * Treat these files like conversation data, not like logs.
 */

import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
	dumpSheddingCandidates,
	MALFORMED_REQUEST_CAPTURE_REASON,
	MALFORMED_REQUEST_DUMP_DIR,
} from "./agent/malformed-request-dump";
import { generateShortId } from "./id";
import { logger } from "./logger";
import { getNarraforkPath } from "./narrafork-home";
import { isInsidePath } from "./platform-path";

/** Directory (under the NarraFork home) holding spilled request dumps. */
export const REQUEST_DUMP_SPILL_DIR = "request-dumps";

/** Envelope schema of a spilled dump file. */
export const REQUEST_DUMP_SPILL_SCHEMA = "narrafork.api-request-dump.v1" as const;

/** Marker stored on the DB-side dump so the download route can find the file. */
export const REQUEST_DUMP_SPILL_POINTER_SCHEMA = "narrafork.api-request-dump-spill.v1" as const;

/**
 * Size above which a dump is written to a file instead of stored inline.
 *
 * This is the actual spill threshold, independent of `agent.requestDumpMaxSize`: that
 * setting says how much dump an operator wants RETAINED, not how large a SQLite row may
 * grow. Conflating the two meant a 5 MB dump under the 32 MB default never spilled and went
 * into the row whole — the unbounded large field CLAUDE.md forbids on the main thread.
 *
 * Chosen to stay well inside "small, fast row" territory while still leaving the inline
 * head large enough to diagnose most rejections without downloading anything: the shrink
 * pass keeps a body head of this size minus its overhead reserve.
 */
export const RAW_DUMP_INLINE_MAX_BYTES = 512 * 1024;

/**
 * Keep only the newest N spilled dumps.
 *
 * Pruning can outlive the row that points at a file, which is why the download route
 * degrades to the inline head rather than failing when a file is gone.
 */
export const MAX_REQUEST_DUMP_SPILL_FILES = 50;

/**
 * Hard ceiling for a single spill file.
 *
 * {@link MAX_REQUEST_DUMP_SPILL_FILES} alone bounds the file COUNT, not the disk: without
 * this the directory's worst case was "50 × unbounded", and a dump is one request body, a
 * size the server does not choose. Matches `MAX_MALFORMED_DUMP_FILE_BYTES` on purpose —
 * both hold the same kind of artifact, and two different answers to "how large may one
 * dump file be" would only invite the question of which is right.
 */
export const MAX_SPILL_FILE_BYTES = 32 * 1024 * 1024;

/**
 * Pointer left in `api_requests.raw_dump_json` when the dump spilled to disk.
 *
 * `inlineTruncated` is what the UI needs in order to say "this is a head, the full dump
 * is a download away" instead of presenting a truncated body as the whole request.
 */
export interface RawDumpSpillPointer {
	schema: typeof REQUEST_DUMP_SPILL_POINTER_SCHEMA;
	filePath: string;
	bytes: number;
	inlineTruncated: true;
	note: string;
	/**
	 * Set when the FILE itself had to shed parts to fit {@link MAX_SPILL_FILE_BYTES}.
	 *
	 * Distinct from `inlineTruncated`, which is always true and only says the row is a head.
	 * This one says "downloading gets you less than what was sent" — the one case where no
	 * complete copy of the request exists anywhere, so it must be visible rather than
	 * inferred from a file that merely looks whole.
	 */
	truncated?: true;
	/** Serialized byte size of the complete dump before shedding, when `truncated`. */
	originalBytes?: number;
	/** Request id whose attempt actually wrote the file. */
	writtenForRequestId?: string;
	/**
	 * Set when this row points at a file written by an EARLIER attempt of the same turn
	 * (see {@link reuseSpillPointer}).
	 *
	 * The replayed requests are byte-identical, so the file answers this row's question too —
	 * but a downloaded dump must not imply it was captured for this attempt when the file's
	 * own `requestId` says otherwise.
	 */
	reusedFromRequestId?: string;
}

/**
 * Replace an absolute dump path with just its file name.
 *
 * The stored record has to hold an absolute path — that is how the download route finds the
 * file — but the path is a property of the host, not of the request being diagnosed. It
 * carries the OS account name, and a dump is a file users export and forward to whoever is
 * helping them, so the name travels further than the admin session that fetched it. The file
 * NAME is kept because it is what correlates a downloaded dump with a line in the server log.
 */
function withRedactedPath(
	holder: Record<string, unknown>,
): { changed: false } | { changed: true; value: Record<string, unknown> } {
	if (typeof holder.filePath !== "string") return { changed: false };
	const { filePath, ...rest } = holder;
	return { changed: true, value: { ...rest, fileName: basename(filePath) } };
}

/**
 * Strip server-side paths out of a stored dump before it leaves the server.
 *
 * Two record shapes carry a host path and BOTH reach clients through
 * `api_requests.raw_dump_json`:
 *
 *  - the spill pointer (`spill.filePath`), written by this module, and
 *  - the malformed-request capture (`capture.filePath`), written by
 *    `malformed-request-dump.ts` when a rejected body is too large for a row.
 *
 * Handling only the first left the leak half-open: a malformed capture is exactly the kind of
 * dump a user forwards for help, so its path — the one that names the host account — travelled
 * with it. Nothing about that is visible in the UI, which shows the note and not the path.
 *
 * Returns a new object when anything was redacted; the input is never modified.
 */
export function redactSpillPointerPaths<T>(dump: T): T {
	if (dump == null || typeof dump !== "object" || Array.isArray(dump)) return dump;
	const record = dump as Record<string, unknown>;
	let out: Record<string, unknown> | null = null;

	const spill = record.spill;
	if (isRecord(spill) && spill.schema === REQUEST_DUMP_SPILL_POINTER_SCHEMA) {
		const redacted = withRedactedPath(spill);
		if (redacted.changed) out = { ...record, spill: redacted.value };
	}

	// Keyed on the capture reason rather than on "has a filePath": this must not rewrite an
	// unrelated `capture` object that some future dump shape happens to carry.
	const capture = record.capture;
	if (isRecord(capture) && capture.reason === MALFORMED_REQUEST_CAPTURE_REASON) {
		const redacted = withRedactedPath(capture);
		if (redacted.changed) out = { ...(out ?? record), capture: redacted.value };
	}

	return (out ?? dump) as T;
}

export interface RawDumpSpillMeta {
	requestId: string;
	narratorId?: string | null;
	kind?: string | null;
	provider?: string | null;
	model?: string | null;
	credentialId?: string | null;
	errorMessage?: string | null;
	/**
	 * Human-readable identity of what produced the request, resolved by the download route.
	 *
	 * A dump gets forwarded to whoever is helping diagnose it, and `narratorId` alone does
	 * not say which conversation or project it came from. These are joined only on the
	 * detail/download path — the list query must not read them for every row.
	 */
	narratorTitle?: string | null;
	chapterId?: string | null;
	chapterTitle?: string | null;
	projectId?: string | null;
	credentialName?: string | null;
	createdAt: string;
}

/** Truncation facts recorded on an envelope whose FILE had to shed parts. */
interface RawDumpEnvelopeTruncation {
	truncated: true;
	/** Serialized byte size of the envelope before shedding. */
	originalBytes: number;
}

/**
 * Metadata half of the envelope: everything except the dump itself.
 *
 * Split out because {@link composeSpillEnvelopeJson} composes the file from this (tiny) head
 * plus the already-serialized dump, which is what keeps the dump from being serialized twice
 * on the HTTP main thread.
 */
function buildRawDumpEnvelopeHead(
	meta: RawDumpSpillMeta,
	truncation?: RawDumpEnvelopeTruncation,
): Record<string, unknown> {
	return {
		schema: REQUEST_DUMP_SPILL_SCHEMA,
		requestId: meta.requestId,
		createdAt: meta.createdAt,
		narratorId: meta.narratorId ?? null,
		narratorTitle: meta.narratorTitle ?? null,
		chapterId: meta.chapterId ?? null,
		chapterTitle: meta.chapterTitle ?? null,
		projectId: meta.projectId ?? null,
		kind: meta.kind ?? null,
		provider: meta.provider ?? null,
		model: meta.model ?? null,
		credentialId: meta.credentialId ?? null,
		credentialName: meta.credentialName ?? null,
		errorMessage: meta.errorMessage ?? null,
		...(truncation ?? {}),
	};
}

/**
 * Build the envelope written to a spill file (and returned by the download route for
 * dumps small enough to have stayed inline, so both paths hand back the same shape).
 */
export function buildRawDumpEnvelope(
	meta: RawDumpSpillMeta,
	dump: unknown,
	truncation?: RawDumpEnvelopeTruncation,
): Record<string, unknown> {
	// `dump` LAST, and this must stay that way: composeSpillEnvelopeJson relies on the head
	// being a prefix of the serialized envelope.
	return { ...buildRawDumpEnvelopeHead(meta, truncation), dump };
}

/**
 * Match only the files this module writes: `<ISO stamp>_<requestId>_<shortid>.json`.
 *
 * Pruning deletes files, so it must never consider anything it did not create.
 */
const SPILL_FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d-]+Z?_.*\.json$/;

async function pruneOldSpills(dir: string): Promise<void> {
	try {
		const names = (await readdir(dir)).filter((name) => SPILL_FILE_NAME_PATTERN.test(name));
		if (names.length <= MAX_REQUEST_DUMP_SPILL_FILES) return;

		// Order by mtime rather than filename: the name embeds a timestamp, but relying on
		// its lexical order would silently couple deletion to the exact stamp format.
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

		const excess = withTimes.length - MAX_REQUEST_DUMP_SPILL_FILES;
		for (const entry of withTimes.slice(0, excess)) {
			await unlink(join(dir, entry.name)).catch(() => {});
		}
	} catch {
		// Pruning is best-effort; never let it fail a capture.
	}
}

/**
 * Splice an already-serialized dump into the envelope without serializing it again.
 *
 * The dump is the multi-MB part, and it arrives here already stringified because the caller
 * had to measure it to decide that it must spill at all. Handing the OBJECT to
 * `JSON.stringify` a second time would walk that whole graph again on the HTTP main thread —
 * which CLAUDE.md forbids for exactly this size class. The head is a handful of scalars, so
 * serializing it and replacing its closing brace costs nothing measurable.
 *
 * Relies on `buildRawDumpEnvelope` putting `dump` last and on the head having at least one
 * key (it always has `schema`), so `head` is a valid JSON object ending in `}`.
 */
function composeSpillEnvelopeJson(
	meta: RawDumpSpillMeta,
	dumpJson: string,
	truncation?: RawDumpEnvelopeTruncation,
): string {
	const head = JSON.stringify(buildRawDumpEnvelopeHead(meta, truncation)) ?? "{}";
	return `${head.slice(0, -1)},"dump":${dumpJson}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Serialize the envelope so it fits {@link MAX_SPILL_FILE_BYTES}, shedding the same way a
 * malformed-request dump does (SSE events first, then the body down to a truncated head).
 *
 * `dumpJson` is the caller's already-measured serialization of `dump`, reused verbatim for
 * the common case where nothing needs shedding.
 */
function serializeSpillEnvelope(
	meta: RawDumpSpillMeta,
	dump: unknown,
	dumpJson: string,
): { json: string; truncated: boolean; originalBytes: number } {
	const whole = composeSpillEnvelopeJson(meta, dumpJson);
	const originalBytes = Buffer.byteLength(whole, "utf8");
	if (originalBytes <= MAX_SPILL_FILE_BYTES) {
		return { json: whole, truncated: false, originalBytes };
	}
	// Non-object dumps have no request/response to shed; the ceiling is then all the store
	// can offer, and keeping the oversized file is still better than keeping nothing.
	if (!isRecord(dump)) return { json: whole, truncated: false, originalBytes };

	const truncation = { truncated: true, originalBytes } as const;
	let last = whole;
	for (const candidate of dumpSheddingCandidates(dump, MAX_SPILL_FILE_BYTES)) {
		// The untouched form is `whole`, already measured above.
		if (!candidate.truncated) continue;
		const json = composeSpillEnvelopeJson(
			meta,
			JSON.stringify(candidate.value) ?? "null",
			truncation,
		);
		if (Buffer.byteLength(json, "utf8") <= MAX_SPILL_FILE_BYTES) {
			return { json, truncated: true, originalBytes };
		}
		last = json;
	}
	// Even the smallest form is over the ceiling (a single enormous scalar in the body, say).
	// Keep it: a too-large file is recoverable, no evidence is not.
	return { json: last, truncated: true, originalBytes };
}

/**
 * Write the complete dump to disk and return a pointer for the database row.
 *
 * `dumpJson` lets the caller hand over the serialization it already produced in order to
 * decide that the dump must spill; re-stringifying a multi-MB graph on the main thread is
 * what this parameter exists to avoid.
 *
 * Returns null when the write fails, and the caller then keeps the dump inline: losing
 * disk space is recoverable, losing the only copy of a rejected request is not.
 */
export async function writeRawDumpSpill(
	meta: RawDumpSpillMeta,
	dump: unknown,
	dumpJson?: string,
): Promise<RawDumpSpillPointer | null> {
	const dir = getNarraforkPath(REQUEST_DUMP_SPILL_DIR);
	const stamp = (Number.isNaN(Date.parse(meta.createdAt)) ? new Date() : new Date(meta.createdAt))
		.toISOString()
		.replace(/[:.]/g, "-");
	// A random component makes the name unique: two ids sharing a sanitized tail, or two
	// writes in the same millisecond, would otherwise silently overwrite each other —
	// destroying exactly the evidence someone is collecting.
	const suffix = meta.requestId.replace(/[^\w.-]/g, "_").slice(-24);
	const filePath = join(dir, `${stamp}_${suffix}_${generateShortId()}.json`);

	try {
		const serializedDump = dumpJson ?? JSON.stringify(dump);
		if (serializedDump == null) return null;
		const { json, truncated, originalBytes } = serializeSpillEnvelope(meta, dump, serializedDump);
		await mkdir(dir, { recursive: true });
		await writeFile(filePath, json, "utf8");
		await pruneOldSpills(dir);
		if (truncated) {
			logger.warn("Spilled API request dump exceeded the file ceiling and was truncated", {
				requestId: meta.requestId,
				filePath,
				originalBytes,
				maxBytes: MAX_SPILL_FILE_BYTES,
			});
		}
		return {
			schema: REQUEST_DUMP_SPILL_POINTER_SCHEMA,
			filePath,
			bytes: Buffer.byteLength(json, "utf8"),
			inlineTruncated: true,
			note: truncated
				? `The dump exceeded the ${MAX_SPILL_FILE_BYTES} byte file ceiling. The file holds as much of the request as fits; parts were shed and no complete copy exists.`
				: "The dump exceeded the inline row budget. The complete request/response is in this file; download the dump to get it in full.",
			writtenForRequestId: meta.requestId,
			...(truncated ? { truncated: true as const, originalBytes } : {}),
		};
	} catch (error) {
		// Remove whatever landed on disk. A partially written file is referenced by nobody
		// (the pointer never reaches a row) yet still matches SPILL_FILE_NAME_PATTERN, so
		// leaving it would consume one of the MAX_REQUEST_DUMP_SPILL_FILES slots and
		// eventually evict a dump that IS someone's evidence.
		await unlink(filePath).catch(() => {});
		logger.warn("Failed to spill API request dump to disk", {
			requestId: meta.requestId,
			filePath,
			error: String(error),
		});
		return null;
	}
}

/**
 * Spill files already written for a turn-scoped capture token, so the retries of ONE
 * rejection share ONE file.
 *
 * A malformed-body replay re-sends a byte-identical request, and every attempt inserts its
 * own `api_requests` row with its own force-persisted dump. Writing a file per attempt put
 * three near-identical multi-MB copies in a directory pruned to the newest
 * {@link MAX_REQUEST_DUMP_SPILL_FILES} — spending 3 slots on one request and evicting
 * unrelated evidence to do it. (The malformed-dump directory was already guarded this way;
 * this closes the same hole for the spill directory.)
 *
 * Bounded and FIFO-evicted: a token is only useful for the seconds a turn's retries span,
 * and this map must not become a second place where dumps accumulate. Losing an entry early
 * only costs one duplicate file.
 */
const rememberedSpills = new Map<string, Promise<RawDumpSpillPointer | null>>();
const MAX_REMEMBERED_SPILLS = 64;

/**
 * Write the dump for `token`, or point at the file an earlier attempt with the same token
 * already wrote.
 *
 * The memo holds the in-flight PROMISE, not the settled pointer, so two attempts that overlap
 * still share one file. Storing only settled pointers would let both miss the memo, both
 * write, and produce exactly the duplicate this exists to prevent — and "the retries happen
 * sequentially" is an assumption about the caller, not something this module can see.
 *
 * A failed write is memoized as `null` deliberately: the token's attempts describe one
 * request, so a write that failed for the first will fail for the rest, and retrying it per
 * attempt only multiplies the failure. The caller then keeps the dump inline.
 */
export function writeOrReuseSpill(
	token: string | undefined,
	meta: RawDumpSpillMeta,
	dump: unknown,
	dumpJson?: string,
): Promise<RawDumpSpillPointer | null> {
	if (!token) return writeRawDumpSpill(meta, dump, dumpJson);

	const existing = rememberedSpills.get(token);
	if (existing) {
		return existing.then((pointer) =>
			pointer
				? // `filePath` names the file written for an EARLIER attempt of the same turn.
					// Recorded explicitly so a downloaded dump does not silently claim to be this
					// attempt's own capture: the requests are identical, but the row is this
					// attempt's.
					{ ...pointer, reusedFromRequestId: pointer.writtenForRequestId }
				: null,
		);
	}

	// FIFO-bounded: a token is only useful for the seconds a turn's retries span, and this map
	// must not become a second place where dumps accumulate. Evicting early costs one
	// duplicate file, never a capture.
	if (rememberedSpills.size >= MAX_REMEMBERED_SPILLS) {
		const oldest = rememberedSpills.keys().next();
		if (!oldest.done) rememberedSpills.delete(oldest.value);
	}
	const pending = writeRawDumpSpill(meta, dump, dumpJson);
	rememberedSpills.set(token, pending);
	return pending;
}

/** Test seam: drop the memo so a suite cannot inherit another's shared files. */
export function clearRememberedSpills(): void {
	rememberedSpills.clear();
}

/**
 * Directories a dump file is allowed to live in.
 *
 * The download route resolves a path that came out of our own database, so this is
 * defense in depth rather than the primary control: a corrupted or hand-edited row must
 * not be able to turn the route into an arbitrary-file reader.
 */
function allowedDumpDirs(): string[] {
	return [getNarraforkPath(REQUEST_DUMP_SPILL_DIR), getNarraforkPath(MALFORMED_REQUEST_DUMP_DIR)];
}

/**
 * Whether `candidate` is a path this module is willing to serve.
 *
 * Rejects relative paths outright: resolving one against the server's cwd would make the
 * meaning of a stored pointer depend on where the process happens to run.
 */
export function isServableDumpFilePath(candidate: string): boolean {
	if (!candidate || !isAbsolute(candidate)) return false;
	const target = resolve(candidate);
	return allowedDumpDirs().some((dir) => isInsidePath(dir, target));
}
