/**
 * The swallowed-content scan (outline P2 PR 12c; PR 12 design §2.9, owner decision D52): finds
 * the places where a save from the old Spec panel may have swallowed content, and records them
 * for people to look at. READ-ONLY DETECTION: scanning a session reads Dynamic Spec revisions and
 * writes this module's two tables (`loss-store.ts`); it never writes Dynamic Spec and never
 * repairs anything. A pass then hands the open findings of imported sessions to
 * `loss-attach.ts`, which puts each on its file's imported page as a block of its own (owner
 * decision D52: on the page only; no notice, no digest line). What a person does about a
 * finding is `loss-findings.ts`.
 *
 * WHAT IT LOOKS AT
 *
 * Root sessions with a spec namespace that are not driven through the external API, whether they
 * still keep Dynamic Spec or were imported. Of each, the markdown files and the behavior fence
 * (`isSpecLossPath`). For a file, the revisions before its current one along
 * `parent_revision_id` (so revisions a fork shares with its parent are followed), and of those
 * the saves a PERSON made (`created_by = 'user'`: the Spec panel). Each such save is compared
 * with the revision before it and with the current one (`shared/spec-content-loss.ts`); the
 * structures are extracted on the background text worker, never on this thread beyond the
 * channel's inline size. A worker that fails leaves the session unscanned: it is tried again by
 * a later pass, a few times a process, and nothing is computed here instead.
 *
 * WHEN
 *
 * A pass a while after the server started, then at intervals ({@link SPEC_LOSS_JOB}), while the
 * outline is on and `outline.specImport` is not `off`; an administrator may start one from the
 * admin page (answered at once; the pass runs in the background). A pass walks the spec
 * namespaces page by page on their primary key, one session at a time with a pause between
 * scans, at most so many scans a pass (the next goes on from there). A session whose file
 * pointers are the ones last scanned is skipped, so an imported session, whose Dynamic Spec no
 * longer changes, is scanned once.
 *
 * BOUNDS ({@link SPEC_LOSS_LIMITS})
 *
 * Per file: so many revisions back, so many saves of a person. Per session: so many files, so
 * many characters of content read, so many findings; what was left out is said in the scan's
 * `note`. A finding keeps the lost source text up to a size (`truncated` beyond), so it stays
 * whole when Dynamic Spec's revisions are deleted later.
 */
import { createHash } from "node:crypto";
import { catalogError } from "@server/lib/errors";
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import type { OutlineSpecLossScanStatus } from "@shared/outline-spec-import";
import {
	buildSpecLossExcerpt,
	isSpecLossPath,
	lostSpecItems,
	type SpecLossItem,
	specLossKindCounts,
} from "@shared/spec-content-loss";
import { OUTLINE_BACKGROUND_TEXT_LIMITS, processBackgroundText } from "../edit-text-runner";
import { specImportMode, specPointersDigest } from "./importer";
import { attachSpecLossForSession } from "./loss-attach";
import {
	insertSpecLossFinding,
	readSpecLossScan,
	readSpecRevisionChain,
	SPEC_LOSS_STORE_LIMITS,
	type SpecLossScanNote,
	type SpecRevisionMeta,
	writeSpecLossScan,
} from "./loss-store";
import {
	readSpecFilePointers,
	readSpecImportSession,
	readSpecNamespacePage,
	readSpecRevisionContents,
	type SpecImportFilePointer,
	type SpecImportSession,
} from "./read-port";

export const SPEC_LOSS_LIMITS = {
	/** Files of one session looked at. */
	files: 500,
	/** Revisions of one file followed back from its current one. */
	chainRevisions: 500,
	/** A person's saves of one file compared, the most recent first. */
	userSaves: 200,
	/** Characters of revision content one session's scan reads. */
	contentChars: 16_000_000,
	/** UTF-8 bytes of lost source text one finding keeps. */
	excerptBytes: 48 * 1024,
	/** Findings one scan of a session records. */
	findings: 200,
	/** Scans of one session that may fail in this process before it is left alone. */
	attempts: 3,
} as const;

export const SPEC_LOSS_JOB = {
	firstPassMs: 90_000,
	/** After a pass that left nothing. */
	idlePassMs: 3_600_000,
	/** After a pass that left sessions (cut short, or scans that failed). */
	retryPassMs: 600_000,
	/** Between two sessions scanned. */
	pauseMs: 200,
	/** Sessions scanned in one pass. */
	scansPerPass: 200,
} as const;

/** Whether the scan runs at all: the outline is on and imports are not switched off. */
export function specLossScanEnabled(): boolean {
	return specImportMode() !== "off";
}

/** Whether the scan looks at a session: a root session with Dynamic Spec, not an external one. */
export function isSpecLossSession(session: SpecImportSession | null): session is SpecImportSession {
	return (
		session !== null &&
		session.type !== "subagent" &&
		!session.external &&
		session.namespaceId !== null
	);
}

/** A finding's id: the same place found again is the same row. */
export function specLossFindingId(
	narratorId: string,
	path: string,
	beforeRevisionId: string,
): string {
	const digest = createHash("sha256")
		.update([narratorId, path, beforeRevisionId].join("\u0000"))
		.digest("hex");
	return `lf${digest.slice(0, 22)}`;
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** The file's revisions from its current one back, newest first, a page a statement. */
async function readChain(revisionId: string): Promise<SpecRevisionMeta[]> {
	const chain: SpecRevisionMeta[] = [];
	let from: string | null = revisionId;
	while (from !== null && chain.length < SPEC_LOSS_LIMITS.chainRevisions) {
		const page = await readSpecRevisionChain(from);
		if (page.length === 0) break;
		chain.push(...page);
		const last = page[page.length - 1] as SpecRevisionMeta;
		from = page.length === SPEC_LOSS_STORE_LIMITS.chainPage ? last.parentRevisionId : null;
	}
	return chain.slice(0, SPEC_LOSS_LIMITS.chainRevisions);
}

export interface SpecLossScanResult {
	/** A person's saves compared. */
	saves: number;
	/** Places detected (recorded now or before). */
	findings: number;
	/** Of them, rows that are new. */
	added: number;
	note: SpecLossScanNote | null;
}

/**
 * Scan one session's files as `pointers` names them. Rejects when the text worker fails or the
 * scan is aborted: nothing is recorded as scanned then (findings already written stay; the same
 * ones are found again).
 */
export async function scanSpecSessionLoss(
	session: SpecImportSession,
	pointers: readonly SpecImportFilePointer[],
	options: { signal?: AbortSignal } = {},
): Promise<SpecLossScanResult> {
	const result: SpecLossScanResult = { saves: 0, findings: 0, added: 0, note: null };
	let chars = 0;
	/** The structures of the few revisions last read: a save's parent is often the next save. */
	const cache = new Map<string, SpecLossItem[] | null>();
	const itemsOf = async (revisionId: string): Promise<SpecLossItem[] | null> => {
		const cached = cache.get(revisionId);
		if (cached !== undefined) return cached;
		const content = (await readSpecRevisionContents([revisionId])).get(revisionId);
		let items: SpecLossItem[] | null = null;
		if (content !== undefined) {
			chars += content.length;
			if (Buffer.byteLength(content, "utf8") <= OUTLINE_BACKGROUND_TEXT_LIMITS.maxBytes)
				[items = null] = await processBackgroundText(
					{ kind: "specLoss", contents: [content] },
					{ signal: options.signal },
				);
			else result.note = "budget";
		}
		cache.set(revisionId, items);
		while (cache.size > 3) cache.delete(cache.keys().next().value as string);
		return items;
	};
	const files = pointers.filter((p) => p.revisionId !== null && isSpecLossPath(p.path));
	if (files.length > SPEC_LOSS_LIMITS.files) result.note = "files";
	scan: for (const pointer of files.slice(0, SPEC_LOSS_LIMITS.files)) {
		options.signal?.throwIfAborted();
		const chain = await readChain(pointer.revisionId as string);
		const pairs: Array<[SpecRevisionMeta, SpecRevisionMeta]> = [];
		for (let i = 0; i + 1 < chain.length && pairs.length < SPEC_LOSS_LIMITS.userSaves; i++) {
			const after = chain[i] as SpecRevisionMeta;
			const before = chain[i + 1] as SpecRevisionMeta;
			// A revision before it with nothing in it had nothing to lose.
			if (after.createdBy === "user" && before.chars > 0) pairs.push([after, before]);
		}
		if (pairs.length === 0) continue;
		const current = await itemsOf(pointer.revisionId as string);
		if (current === null) continue;
		for (const [after, before] of pairs) {
			options.signal?.throwIfAborted();
			if (chars >= SPEC_LOSS_LIMITS.contentChars) {
				result.note = "budget";
				break scan;
			}
			result.saves++;
			const had = await itemsOf(before.id);
			if (had === null || had.length === 0) continue;
			const has = after.id === pointer.revisionId ? current : await itemsOf(after.id);
			if (has === null) continue;
			const lost = lostSpecItems(had, has, current);
			if (lost.length === 0) continue;
			if (result.findings >= SPEC_LOSS_LIMITS.findings) {
				result.note = "findings";
				break scan;
			}
			const excerpt = buildSpecLossExcerpt(lost, SPEC_LOSS_LIMITS.excerptBytes);
			result.findings++;
			const added = await insertSpecLossFinding({
				id: specLossFindingId(session.narratorId, pointer.path, before.id),
				narratorId: session.narratorId,
				path: pointer.path,
				beforeRevisionId: before.id,
				afterRevisionId: after.id,
				beforeAt: before.createdAt,
				savedAt: after.createdAt,
				kinds: specLossKindCounts(lost),
				items: lost.length,
				parts: excerpt.parts,
				truncated: excerpt.truncated,
			});
			if (added) result.added++;
		}
		await yieldToEventLoop();
	}
	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Passes
// ─────────────────────────────────────────────────────────────────────────────

export interface SpecLossPass {
	/** Sessions the scan looks at that the pass met. */
	sessions: number;
	/** Of them, scanned now (the others were scanned before and did not change). */
	scanned: number;
	/** New findings. */
	found: number;
	/** Findings put on their imported pages (`loss-attach.ts`). */
	attached: number;
	/** Sessions left for the next pass: not reached, their scan failed, or attaches wait. */
	left: number;
}

interface JobState {
	stopped: boolean;
	/** Shutting down: a pass in flight ends after the session in hand. */
	halt: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	running: Promise<SpecLossPass> | null;
	/** The namespace before the session the next pass starts at. */
	after: string | null;
	/** Failed scans per session in this process. */
	failures: Map<string, number>;
	lastPass: OutlineSpecLossScanStatus["lastPass"];
}

const job = hotSafe(
	"narrafork.outline.specLoss.job",
	(): JobState => ({
		stopped: true,
		halt: false,
		timer: null,
		running: null,
		after: null,
		failures: new Map(),
		lastPass: null,
	}),
);

/** Forget where the next pass starts and which scans failed (tests: what a restart does). */
export function resetSpecLossScanState(): void {
	job.after = null;
	job.failures.clear();
	job.lastPass = null;
	job.halt = false;
}

/**
 * Scan one session unless its file pointers are the ones last scanned (`force`: scan anyway).
 * `skipped`: not a session the scan looks at, or unchanged. Rejects as
 * {@link scanSpecSessionLoss} does.
 */
export async function scanSpecSessionLossIfChanged(
	session: SpecImportSession | null,
	options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<SpecLossScanResult | "skipped"> {
	if (!isSpecLossSession(session) || session.namespaceId === null) return "skipped";
	const pointers = await readSpecFilePointers(session.namespaceId);
	const sourceKey = specPointersDigest(pointers);
	if (!options.force && (await readSpecLossScan(session.narratorId))?.sourceKey === sourceKey)
		return "skipped";
	const started = performance.now();
	const result = await scanSpecSessionLoss(session, pointers, options);
	await writeSpecLossScan({
		narratorId: session.narratorId,
		sourceKey,
		saves: result.saves,
		findings: result.findings,
		note: result.note,
		scannedAt: new Date().toISOString(),
	});
	if (result.added > 0 || result.note !== null)
		logger.info("Swallowed-content scan of a Dynamic Spec session", {
			narratorId: session.narratorId,
			...result,
			elapsedMs: Math.round(performance.now() - started),
		});
	return result;
}

/** {@link scanSpecSessionLossIfChanged} by id (tests, and a single session's scan). */
export async function scanSpecSessionLossById(
	narratorId: string,
	options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<SpecLossScanResult | "skipped"> {
	return await scanSpecSessionLossIfChanged(await readSpecImportSession(narratorId), options);
}

/**
 * One pass over the spec namespaces from where the last one stopped (see the module header).
 * Never rejects for one session's scan: a failed one is counted in `left`.
 */
export async function runSpecLossPass(
	options: { stop?: () => boolean; pauseMs?: number; maxScans?: number } = {},
): Promise<SpecLossPass> {
	const pass: SpecLossPass = { sessions: 0, scanned: 0, found: 0, attached: 0, left: 0 };
	const maxScans = options.maxScans ?? SPEC_LOSS_JOB.scansPerPass;
	let cursor = job.after;
	let before = cursor;
	for (;;) {
		if (options.stop?.() || !specLossScanEnabled()) {
			job.after = before;
			return pass;
		}
		const page = await readSpecNamespacePage(cursor);
		for (const session of page.sessions) {
			if (options.stop?.()) {
				job.after = before;
				return pass;
			}
			if (isSpecLossSession(session)) {
				pass.sessions++;
				const failed = job.failures.get(session.narratorId) ?? 0;
				if (failed >= SPEC_LOSS_LIMITS.attempts) pass.left++;
				else if (pass.scanned >= maxScans) {
					// Cut short: the next pass goes on from this session.
					pass.left++;
					job.after = before;
					return pass;
				} else {
					try {
						const result = await scanSpecSessionLossIfChanged(session);
						if (result !== "skipped") {
							pass.scanned++;
							pass.found += result.added;
							job.failures.delete(session.narratorId);
							await new Promise<void>((resolve) => {
								const timer = setTimeout(resolve, options.pauseMs ?? SPEC_LOSS_JOB.pauseMs);
								timer.unref?.();
							});
						}
					} catch (error) {
						// Not scanned: a later pass tries again. Nothing is computed here instead.
						pass.left++;
						job.failures.set(session.narratorId, failed + 1);
						logger.warn("Swallowed-content scan of a session failed", {
							narratorId: session.narratorId,
							error: String(error),
						});
					}
				}
				// What was found, now or by an earlier pass, goes onto the imported pages (only for a
				// session whose tasks are in the outline; bounded per session and per page).
				if (session.taskBackend === "outline") {
					const run = await attachSpecLossForSession(session);
					pass.attached += run.attached;
					if (run.left > 0) pass.left++;
					if (run.attached > 0) await yieldToEventLoop();
				}
			}
			before = session.namespaceId;
		}
		await yieldToEventLoop();
		if (page.next === null) break;
		cursor = page.next;
	}
	// The whole walk done: the next pass starts over (unchanged sessions are skipped).
	job.after = null;
	return pass;
}

function startPass(): Promise<SpecLossPass> {
	const running = runSpecLossPass({ stop: () => job.halt })
		.then((pass) => {
			job.lastPass = { at: new Date().toISOString(), ...pass };
			if (pass.scanned > 0) logger.info("Swallowed-content scan pass finished", { ...pass });
			return pass;
		})
		.finally(() => {
			if (job.running === running) job.running = null;
		});
	job.running = running;
	return running;
}

function schedule(ms: number): void {
	if (job.stopped) return;
	if (job.timer) clearTimeout(job.timer);
	job.timer = setTimeout(() => {
		job.timer = null;
		if (job.stopped) return;
		(job.running ?? startPass())
			.then((pass) =>
				schedule(pass.left > 0 ? SPEC_LOSS_JOB.retryPassMs : SPEC_LOSS_JOB.idlePassMs),
			)
			.catch((error: unknown) => {
				logger.warn("Swallowed-content scan pass failed", { error: String(error) });
				schedule(SPEC_LOSS_JOB.retryPassMs);
			});
	}, ms);
	job.timer.unref?.();
}

/** Start the scan job (idempotent). Each pass checks the settings itself. */
export function startSpecLossScanJob(): void {
	if (!job.stopped) return;
	job.stopped = false;
	job.halt = false;
	schedule(SPEC_LOSS_JOB.firstPassMs);
}

/** Stop the job: the session in hand is finished, then the pass ends (shutdown). */
export async function stopSpecLossScanJob(): Promise<void> {
	job.stopped = true;
	job.halt = true;
	if (job.timer) clearTimeout(job.timer);
	job.timer = null;
	await job.running?.catch(() => {});
}

export function specLossScanStatus(): OutlineSpecLossScanStatus {
	return { running: job.running !== null, lastPass: job.lastPass };
}

/**
 * An administrator's "scan now": starts a pass in the background unless one is running, and
 * answers at once. The pass is never run on the request.
 */
export function requestSpecLossPass(): OutlineSpecLossScanStatus {
	if (!specLossScanEnabled()) throw catalogError("SPEC_IMPORT_OFF");
	if (job.running === null) {
		// Asked for by a person: sessions whose scans failed before are tried again.
		job.failures.clear();
		startPass().catch((error: unknown) =>
			logger.warn("Swallowed-content scan pass failed", { error: String(error) }),
		);
	}
	return specLossScanStatus();
}

/** The pass in flight, if any (tests wait for it). */
export function settleSpecLossPass(): Promise<unknown> {
	return job.running?.catch(() => {}) ?? Promise.resolve();
}
