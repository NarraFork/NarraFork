/**
 * When a Dynamic Spec session is imported into the outline (outline P2 PR 12b; owner decision
 * D52: automatically). Three triggers, one importer (`importer.ts`), all of them idempotent:
 *
 *   1. BEFORE A RUN ({@link importSpecAtRunStart}): a root session that still keeps its tasks in
 *      Dynamic Spec is imported at the start of its next run, in the run's own slot, before its
 *      first request. Only a small session ({@link SPEC_IMPORT_RUN_LIMITS}), within a time limit
 *      checked between commits, while none of its subagents is running (they read its backend),
 *      and once per process: anything else is left to the idle job, and this run goes on as a
 *      Dynamic Spec run.
 *   2. THE IDLE JOB ({@link startSpecImportJob}): a while after the server started, and then at
 *      intervals, the spec namespaces are walked page by page on their primary key, one session
 *      at a time with a pause between them. A session is taken without interrupting it (the
 *      admission a file revert takes, which also covers its subagents): a busy one is skipped and
 *      met again on the next pass. The admission holds the session's messages, so an import holds
 *      it at most {@link SPEC_IMPORT_JOB.budgetMs} and gives way at once when a message for it
 *      arrives (`busy`; the next pass goes on where it stopped). A session that failed
 *      {@link SPEC_IMPORT_JOB.attempts} times in this process, or needs attention, is left to the
 *      button.
 *   3. THE BUTTON ({@link requestSpecImport}): the Spec panel's "Import now" (and its retry). The
 *      request only starts the import and answers at once; the panel reads the state
 *      ({@link specImportStatus}) and hears `spec_changed` when the session was moved.
 *
 * `outline.specImport` chooses: `auto` all three, `manual` (the shipped default, `DEFAULTS`) the
 * button only (the job runs but finds nothing to do), `off` none.
 *
 * On PostgreSQL the session runtime does not run, so there is nothing to wait for: the job and the
 * button import without an admission, and no run starts one.
 */
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import type { OutlineSpecImportReason } from "@shared/outline-spec-import";
import { readTaskSession } from "../../task-source/backend";
import { outlineAccessBackend } from "../access-reads";
import {
	importSpecSession,
	type SpecImportOutcome,
	SpecImportPaused,
	type SpecImportRecord,
	specImportMode,
	specImportRecord,
	specImportSkipReason,
} from "./importer";
import { readSpecImportSession, readSpecNamespacePage } from "./read-port";

/** What a session may hold to be imported at the start of a run. */
export const SPEC_IMPORT_RUN_LIMITS = {
	files: 20,
	/** Characters (not bytes) of all its current files. */
	chars: 262_144,
	/** The import's time limit there; checked between commits. */
	timeoutMs: 3_000,
	/** Sessions remembered as tried at a run start in this process. */
	remembered: 4096,
} as const;

export const SPEC_IMPORT_JOB = {
	/** After the server started. */
	firstPassMs: 60_000,
	/** Between sessions of a pass. */
	pauseMs: 200,
	/** After a pass that left sessions behind (busy, failed). */
	retryPassMs: 10 * 60_000,
	/** After a pass that left none: new spec sessions are rare (a plugin's recruits, forks). */
	idlePassMs: 60 * 60_000,
	/** Failed attempts of one session in this process after which the job leaves it alone. */
	attempts: 3,
	/**
	 * How long one idle import may hold its session (it holds the session's revert admission, so
	 * the session's messages wait): past it the import gives way, and the next pass goes on where
	 * it stopped. Checked between commits, as at the start of a run.
	 */
	budgetMs: 3_000,
	/** The same for an import a person started from the Spec panel. */
	manualBudgetMs: 30_000,
	/** How often an idle import looks for a message that arrived for its session (it gives way). */
	messageCheckMs: 250,
	/** Queued messages of the session one look reads (newest first; ids and who sent them). */
	messageCheckRows: 50,
} as const;

/** The narrator runtime, loaded on first use: this module is reached from it. */
async function runtime() {
	return await import("../../narrator-session");
}

/** Tell the session's clients it was moved: the Spec panel becomes the task board. */
function announce(narratorId: string): void {
	void import("../../spec-broadcast")
		.then(({ broadcastSpecChanged }) =>
			broadcastSpecChanged(
				narratorId,
				{ uri: "spec://tasks.json", path: "tasks.json", revisionId: null },
				"import",
				"system",
			),
		)
		.catch((error: unknown) =>
			logger.warn("Could not announce an imported session", { narratorId, error: String(error) }),
		);
}

/** Take an idle session (and its subagents) for the import; rejects when any of them is busy. */
async function admitIdle(narratorId: string): Promise<() => void> {
	if (outlineAccessBackend() === "postgres") return () => {};
	const { acquireNarratorRevertAdmission } = await runtime();
	return await acquireNarratorRevertAdmission(narratorId, {
		signal: new AbortController().signal,
		interrupt: false,
	});
}

async function loopRunning(): Promise<(narratorId: string) => boolean> {
	return (await runtime()).isLoopRunning;
}

const triedAtRun = hotSafe("narrafork.outline.specImport.triedAtRun", () => new Set<string>());

/**
 * Trigger 1 (see the module header). `subagentsRunning`: whether anything of the session's team
 * besides itself holds work now. Returns the outcome, or null when no import was tried. Never
 * rejects.
 */
export async function importSpecAtRunStart(
	narratorId: string,
	options: { subagentsRunning: () => boolean; timeoutMs?: number },
): Promise<SpecImportOutcome | null> {
	try {
		if (specImportMode() !== "auto") return null;
		// Cached after the first read: an outline session's run costs nothing here.
		const session = await readTaskSession(narratorId);
		if (!session || session.backend !== "spec" || session.subagent) return null;
		if (triedAtRun.has(narratorId)) return null;
		if (options.subagentsRunning()) return null;
		triedAtRun.add(narratorId);
		while (triedAtRun.size > SPEC_IMPORT_RUN_LIMITS.remembered) {
			const oldest = triedAtRun.values().next().value;
			if (oldest === undefined) break;
			triedAtRun.delete(oldest);
		}
		const controller = new AbortController();
		const timeoutMs = options.timeoutMs ?? SPEC_IMPORT_RUN_LIMITS.timeoutMs;
		const timer = setTimeout(
			() => controller.abort(new SpecImportPaused(`the run's time limit of ${timeoutMs} ms`)),
			timeoutMs,
		);
		timer.unref?.();
		return await importSpecSession(narratorId, {
			trigger: "run",
			signal: controller.signal,
			smallOnly: { files: SPEC_IMPORT_RUN_LIMITS.files, chars: SPEC_IMPORT_RUN_LIMITS.chars },
			// The run holds the session: no admission, and what it does stays on the running lease.
			isRunning: () => true,
			onMoved: announce,
		}).finally(() => clearTimeout(timer));
	} catch (error) {
		logger.warn("Dynamic Spec import at the start of a run failed", {
			narratorId,
			error: String(error),
		});
		return null;
	}
}

/** Forget which sessions were tried at a run start (tests). */
export function resetSpecImportRunTries(): void {
	triedAtRun.clear();
}

/**
 * The import as the job and the button run it: on an idle session, without interrupting it, and
 * giving way to it ({@link SpecImportPaused}, outcome `busy`) when its time budget runs out or a
 * message for the session arrives meanwhile (the admission holds the session's messages until it
 * is released): a person's message at the next commit boundary, any other (a team or plugin
 * notice) as the time budget, once the attempt made a commit (review r2 NIT 1), so a stream of
 * notices cannot keep an import from ever getting anywhere. What was written stays; the next
 * attempt goes on from there.
 */
export async function importSpecSessionIdle(
	narratorId: string,
	trigger: "sweep" | "manual",
	options: { budgetMs?: number; messageCheckMs?: number } = {},
): Promise<SpecImportOutcome> {
	const controller = new AbortController();
	const budgetMs =
		options.budgetMs ??
		(trigger === "manual" ? SPEC_IMPORT_JOB.manualBudgetMs : SPEC_IMPORT_JOB.budgetMs);
	// The first reason stands; a person's message makes a pause asked for already urgent.
	const pause = (why: string, urgent: boolean) => {
		const current: unknown = controller.signal.reason;
		if (!controller.signal.aborted) controller.abort(new SpecImportPaused(why, urgent));
		else if (urgent && current instanceof SpecImportPaused) current.urgent = true;
	};
	const timer = setTimeout(() => pause(`its time budget of ${budgetMs} ms`, false), budgetMs);
	timer.unref?.();
	let unwatch: (() => void) | null = null;
	try {
		return await importSpecSession(narratorId, {
			trigger,
			pause: controller.signal,
			admit: async (id) => {
				const release = await admitIdle(id);
				try {
					unwatch = await watchSpecImportMessages(
						id,
						(person) =>
							pause(
								person
									? "a person's message for the session arrived"
									: "a notice for the session arrived",
								person,
							),
						options.messageCheckMs ?? SPEC_IMPORT_JOB.messageCheckMs,
					);
				} catch (error) {
					release();
					throw error;
				}
				return release;
			},
			isRunning: outlineAccessBackend() === "postgres" ? () => false : await loopRunning(),
			onMoved: announce,
		});
	} finally {
		clearTimeout(timer);
		(unwatch as (() => void) | null)?.();
	}
}

/**
 * Call `arrived` when a message is queued for the session that was not queued when this started
 * (a bounded read on the queue's index, newest first, every `everyMs`): `person` when a person
 * sent it (a user's input with its sender), else once for the first other one (a team or plugin
 * notice). Looks on until a person's message arrived; the returned function stops looking. On
 * PostgreSQL the import takes no admission, so nothing waits on it: nothing to watch.
 */
export async function watchSpecImportMessages(
	narratorId: string,
	arrived: (person: boolean) => void,
	everyMs: number,
): Promise<() => void> {
	if (outlineAccessBackend() === "postgres") return () => {};
	const [{ db }, { narratorBufferedMessages }, { and, desc, eq }] = await Promise.all([
		import("../../../db"),
		import("../../../db/schema"),
		import("drizzle-orm"),
	]);
	const queued = () =>
		db
			.select({
				id: narratorBufferedMessages.id,
				kind: narratorBufferedMessages.kind,
				createdBy: narratorBufferedMessages.createdBy,
			})
			.from(narratorBufferedMessages)
			.where(
				and(
					eq(narratorBufferedMessages.narratorId, narratorId),
					eq(narratorBufferedMessages.state, "queued"),
				),
			)
			.orderBy(desc(narratorBufferedMessages.arrivalSeq))
			.limit(SPEC_IMPORT_JOB.messageCheckRows + 1)
			.all();
	const before = new Set(queued().map((row) => row.id));
	let noticed = false;
	const timer = setInterval(() => {
		try {
			const arrivedNow = queued().filter((row) => !before.has(row.id));
			if (arrivedNow.some((row) => row.kind === "user_input" && row.createdBy !== null)) {
				clearInterval(timer);
				arrived(true);
			} else if (arrivedNow.length > 0 && !noticed) {
				noticed = true;
				arrived(false);
			}
		} catch (error) {
			clearInterval(timer);
			logger.warn("Could not look for messages during a Dynamic Spec import", {
				narratorId,
				error: String(error),
			});
		}
	}, everyMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** What the Spec panel shows about a session's import. */
export interface SpecImportStatus {
	/** How imports happen here (`outline.specImport`); `off` hides the banner. */
	mode: "auto" | "manual" | "off";
	/** The session is one the import moves: a root session still in Dynamic Spec. */
	importable: boolean;
	/** `idle`: not tried in this process (or the session is not importable). */
	state: "idle" | SpecImportRecord["status"];
	/** Why the last attempt did not move the session (English, as logged). */
	error: string | null;
	/** The same, for the Spec panel to say in the reader's language. */
	reason: OutlineSpecImportReason | null;
	at: string | null;
}

/** One primary-key read and what this process remembers. */
export async function specImportStatus(narratorId: string): Promise<SpecImportStatus> {
	const mode = specImportMode();
	const session = await readSpecImportSession(narratorId);
	const importable = mode !== "off" && specImportSkipReason(session) === null;
	const record = specImportRecord(narratorId);
	return {
		mode,
		importable,
		state: record?.status ?? "idle",
		error: record?.error ?? null,
		reason: record?.reason ?? null,
		at: record?.at ?? null,
	};
}

const manual = hotSafe("narrafork.outline.specImport.manual", () => new Set<Promise<unknown>>());

/**
 * Trigger 3: start the import of a session now and answer at once with its state. The caller has
 * checked that the person may write the session.
 */
export async function requestSpecImport(narratorId: string): Promise<SpecImportStatus> {
	const before = await specImportStatus(narratorId);
	if (!before.importable || before.state === "running") return before;
	const run = importSpecSessionIdle(narratorId, "manual").catch((error: unknown) =>
		logger.warn("Dynamic Spec import from the Spec panel failed", {
			narratorId,
			error: String(error),
		}),
	);
	manual.add(run);
	let settled = false;
	void run.finally(() => {
		settled = true;
		manual.delete(run);
	});
	await new Promise((resolve) => setImmediate(resolve));
	return settled
		? await specImportStatus(narratorId)
		: { ...before, state: "running", error: null, reason: null };
}

/** Imports the button started, settled (tests, shutdown). */
export async function settleSpecImportRequests(): Promise<void> {
	await Promise.all([...manual]);
}

// ─────────────────────────────────────────────────────────────────────────────
// The idle job
// ─────────────────────────────────────────────────────────────────────────────

export interface SpecImportPass {
	seen: number;
	imported: number;
	/** Busy or failed: met again on a later pass. */
	left: number;
	/** Needs attention, or failed too often: left to the button. */
	givenUp: number;
}

const job: {
	timer: ReturnType<typeof setTimeout> | null;
	running: Promise<void> | null;
	stopped: boolean;
} = { timer: null, running: null, stopped: true };

/**
 * One pass over the spec namespaces (trigger 2). Bounded per step: a page of namespaces by
 * primary key, one session imported at a time, a pause between sessions. `stop` ends it after the
 * session in hand.
 */
export async function runSpecImportPass(
	options: { stop?: () => boolean; pauseMs?: number } = {},
): Promise<SpecImportPass> {
	const pass: SpecImportPass = { seen: 0, imported: 0, left: 0, givenUp: 0 };
	let cursor: string | null = null;
	for (;;) {
		if (options.stop?.() || specImportMode() !== "auto") break;
		const page = await readSpecNamespacePage(cursor);
		for (const session of page.sessions) {
			if (options.stop?.()) break;
			if (specImportSkipReason(session) !== null) continue;
			pass.seen++;
			const record = specImportRecord(session.narratorId);
			if (
				record?.status === "attention" ||
				(record?.status === "failed" && record.failures >= SPEC_IMPORT_JOB.attempts)
			) {
				pass.givenUp++;
				continue;
			}
			const outcome = await importSpecSessionIdle(session.narratorId, "sweep");
			if (outcome.status === "imported") pass.imported++;
			else if (outcome.status === "failed" && outcome.attention) pass.givenUp++;
			else if (outcome.status !== "skipped") pass.left++;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, options.pauseMs ?? SPEC_IMPORT_JOB.pauseMs);
				timer.unref?.();
			});
		}
		if (page.next === null) break;
		cursor = page.next;
	}
	return pass;
}

function schedule(ms: number): void {
	if (job.stopped) return;
	job.timer = setTimeout(() => {
		job.timer = null;
		if (job.stopped || job.running) return;
		job.running = runSpecImportPass({ stop: () => job.stopped })
			.then((pass) => {
				if (pass.seen > 0) logger.info("Dynamic Spec import pass finished", { ...pass });
				schedule(pass.left > 0 ? SPEC_IMPORT_JOB.retryPassMs : SPEC_IMPORT_JOB.idlePassMs);
			})
			.catch((error: unknown) => {
				logger.warn("Dynamic Spec import pass failed", { error: String(error) });
				schedule(SPEC_IMPORT_JOB.retryPassMs);
			})
			.finally(() => {
				job.running = null;
			});
	}, ms);
	job.timer.unref?.();
}

/** Start the idle job (idempotent). Each pass checks the setting itself. */
export function startSpecImportJob(): void {
	if (!job.stopped) return;
	job.stopped = false;
	schedule(SPEC_IMPORT_JOB.firstPassMs);
}

/** Stop the job: the session in hand is finished, then the pass ends (shutdown). */
export async function stopSpecImportJob(): Promise<void> {
	job.stopped = true;
	if (job.timer) clearTimeout(job.timer);
	job.timer = null;
	await Promise.all([job.running, settleSpecImportRequests()]);
}
