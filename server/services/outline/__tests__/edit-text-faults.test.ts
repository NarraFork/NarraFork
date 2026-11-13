/**
 * Fault injection for the edit-text worker channels (CLAUDE.md, worker isolation; outline P2 PR
 * 12b review S3): a worker that does not start (its start rejects, never answers, or worker
 * threads are unavailable), one that crashes in the middle of a job, and one that hangs. Each job
 * fails, and the job is never run on the caller's thread instead (`runEditTextJob` is spied).
 * The Dynamic Spec import over a failing background channel fails and moves nothing; the
 * swallowed-content scan (12c) leaves the session unscanned and attaches nothing.
 *
 * The channels here are made for the test (`createEditTextChannel`) with a fake worker start, so
 * the real channels' workers are not touched.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import * as specLoss from "@shared/spec-content-loss";
import { settings } from "../../../lib/settings";
import { writeSpecFile } from "../../spec-vfs-service";
import { invalidateTaskBackend } from "../../task-source";
import type { EditTextJob } from "../edit-text";
import * as editText from "../edit-text";
import * as runner from "../edit-text-runner";
import {
	createEditTextChannel,
	type EditTextChannelLimits,
	type EditTextWorkerConnect,
	OutlineEditTextError,
	stopEditTextWorker,
} from "../edit-text-runner";
import {
	backendOf,
	commitCount,
	makeSession,
	writeNote,
	writeTasks,
} from "../spec-import/__tests__/fixtures";
import { importSpecSession, resetSpecImportRecords } from "../spec-import/importer";
import { attachSpecLossForSession } from "../spec-import/loss-attach";
import { decideSpecLossFinding, specLossPage } from "../spec-import/loss-findings";
import {
	resetSpecLossScanState,
	runSpecLossPass,
	SPEC_LOSS_LIMITS,
	scanSpecSessionLossById,
} from "../spec-import/loss-scan";
import { readSpecLossScan } from "../spec-import/loss-store";
import { readSpecImportSession } from "../spec-import/read-port";

const LIMITS: EditTextChannelLimits = {
	inlineBytes: 1024,
	maxBytes: 1024 * 1024,
	timeoutMs: 200,
	maxQueued: 2,
	idleMs: 30_000,
	startMs: 100,
};

/** Larger than the inline size: always meant for the worker. */
const job: EditTextJob = { kind: "notes", text: "word ".repeat(1000), continued: "(cont.)" };

/** A stand-in worker: `onPost` decides what happens to a job posted to it. */
class FakeWorker extends EventEmitter {
	terminated = 0;
	posted = 0;
	constructor(private readonly onPost: (worker: FakeWorker) => void) {
		super();
	}
	postMessage(): void {
		this.posted++;
		this.onPost(this);
	}
	unref(): void {}
	async terminate(): Promise<number> {
		this.terminated++;
		return 0;
	}
}

const asWorker = (fake: FakeWorker) => ({ worker: fake as unknown as Worker });

let inline: ReturnType<typeof spyOn>;
let channels = 0;
const channel = (connect: EditTextWorkerConnect) =>
	createEditTextChannel(`.fault-test-${++channels}`, LIMITS, connect);

beforeEach(() => {
	inline = spyOn(editText, "runEditTextJob");
});
afterEach(() => inline.mockRestore());
afterAll(() => stopEditTextWorker());

async function failure(promise: Promise<unknown>): Promise<OutlineEditTextError> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(OutlineEditTextError);
	return error as OutlineEditTextError;
}

describe("a worker that does not start", () => {
	test("its start rejects: the job fails, and is not run here", async () => {
		const ch = channel(async () => {
			throw new Error("No worker entry loaded");
		});
		expect((await failure(ch.run(job))).code).toBe("OUTLINE_TEXT_FAILED");
		expect(inline).not.toHaveBeenCalled();
		ch.stop();
	});

	test("its start never answers: the job times out, and is not run here", async () => {
		const ch = channel(() => new Promise(() => {}));
		expect((await failure(ch.run(job))).code).toBe("OUTLINE_TEXT_TIMEOUT");
		expect(inline).not.toHaveBeenCalled();
		ch.stop();
	});

	test("worker threads are unavailable (disabled): the job fails, and is not run here", async () => {
		const ch = channel(() => {
			throw new Error("Worker threads are disabled in this runtime");
		});
		const error = await failure(ch.run(job));
		expect(error.code).toBe("OUTLINE_TEXT_FAILED");
		expect(inline).not.toHaveBeenCalled();
		ch.stop();
	});
});

describe("a worker that fails while working", () => {
	test("it crashes in the middle of a job: the job fails, and is not run here", async () => {
		let fake: FakeWorker | null = null;
		const ch = channel(async () => {
			fake = new FakeWorker((worker) => worker.emit("exit", 1));
			return asWorker(fake);
		});
		expect((await failure(ch.run(job))).code).toBe("OUTLINE_TEXT_FAILED");
		expect((fake as FakeWorker | null)?.posted).toBe(1);
		expect(inline).not.toHaveBeenCalled();
		ch.stop();
	});

	test("it reports an error: the job fails, and is not run here", async () => {
		const ch = channel(async () =>
			asWorker(new FakeWorker((worker) => worker.emit("error", new Error("out of memory")))),
		);
		expect((await failure(ch.run(job))).code).toBe("OUTLINE_TEXT_FAILED");
		expect(inline).not.toHaveBeenCalled();
		ch.stop();
	});

	test("it hangs: the job times out, the worker is ended, and the job is not run here", async () => {
		const fakes: FakeWorker[] = [];
		const ch = channel(async () => {
			const fake = new FakeWorker(() => {});
			fakes.push(fake);
			return asWorker(fake);
		});
		expect((await failure(ch.run(job))).code).toBe("OUTLINE_TEXT_TIMEOUT");
		expect(fakes[0]?.terminated).toBe(1);
		// The next job starts a fresh worker (which hangs too): never the caller's thread.
		expect((await failure(ch.run(job))).code).toBe("OUTLINE_TEXT_TIMEOUT");
		expect(fakes).toHaveLength(2);
		expect(inline).not.toHaveBeenCalled();
		ch.stop();
	});
});

test("control: the spy sees a job that is small enough to run inline", async () => {
	const ch = channel(async () => {
		throw new Error("never started for an inline job");
	});
	const small: EditTextJob = { kind: "normalize", contents: ["a small text"] };
	expect(await ch.run(small)).toEqual(editText.runEditTextJob(small));
	expect(inline).toHaveBeenCalledTimes(2);
	ch.stop();
});

describe("the Dynamic Spec import over a failing background channel", () => {
	beforeEach(() => {
		settings.outline.enabled = true;
		settings.outline.specImport = "manual";
		invalidateTaskBackend();
		resetSpecImportRecords();
	});

	test("the import fails and moves nothing; no text is converted on the main thread", async () => {
		const background = spyOn(runner, "processBackgroundText").mockImplementation(async () => {
			throw new OutlineEditTextError("OUTLINE_TEXT_FAILED", "worker exited (1)", 500);
		});
		try {
			const { id } = await makeSession();
			await writeTasks(id, [{ text: "a task" }]);
			await writeNote(id, "notes.md", "# Notes\n\nsome text\n");
			const outcome = await importSpecSession(id, { trigger: "manual" });
			expect(outcome).toMatchObject({ status: "failed", attention: false });
			expect(background).toHaveBeenCalled();
			expect(await backendOf(id)).toBe("spec");
			expect(await commitCount(id)).toBe(0);
			expect(inline).not.toHaveBeenCalled();
		} finally {
			background.mockRestore();
		}
	});
});

describe("the swallowed-content scan over a failing background channel", () => {
	const TABLE = "| a | b |\n| --- | --- |\n| 1 | 2 |";
	// Larger than the channel's inline size: the worker's to do, never this thread's.
	const filler = "some text of the file. ".repeat(100);

	beforeEach(() => {
		settings.outline.enabled = true;
		settings.outline.specImport = "manual";
		invalidateTaskBackend();
		resetSpecImportRecords();
		resetSpecLossScanState();
	});

	async function swallowedSession(): Promise<string> {
		const { id } = await makeSession();
		await writeSpecFile(id, "spec://design.md", `${filler}\n\n${TABLE}\n`, {
			actor: "agent",
			createdBy: "assistant",
		});
		await writeNote(id, "design.md", `${filler}\n`);
		return id;
	}

	test("the session is left unscanned, tried again later; nothing is extracted on the main thread", async () => {
		const id = await swallowedSession();
		const extract = spyOn(specLoss, "extractSpecLossItems");
		const background = spyOn(runner, "processBackgroundText").mockImplementation(async () => {
			throw new OutlineEditTextError("OUTLINE_TEXT_TIMEOUT", "timed out", 504);
		});
		try {
			await expect(scanSpecSessionLossById(id)).rejects.toThrow("timed out");
			expect(await readSpecLossScan(id)).toBeNull();
			// A pass counts it as left, and stops trying after a few failures in this process.
			for (let n = 0; n < SPEC_LOSS_LIMITS.attempts + 1; n++)
				expect((await runSpecLossPass({ pauseMs: 0 })).left).toBeGreaterThanOrEqual(1);
			expect(await readSpecLossScan(id)).toBeNull();
			expect(background).toHaveBeenCalled();
			expect(extract).not.toHaveBeenCalled();
			expect(inline).not.toHaveBeenCalled();
		} finally {
			background.mockRestore();
			extract.mockRestore();
		}
		// The worker is back: the session is scanned and the loss found.
		resetSpecLossScanState();
		expect(await scanSpecSessionLossById(id)).toMatchObject({ findings: 1, added: 1 });
	});

	test("a real channel whose worker cannot start fails the job; nothing runs inline", async () => {
		const ch = channel(async () => {
			throw new Error("worker could not be created");
		});
		const job: EditTextJob = { kind: "specLoss", contents: [`${filler}\n\n${TABLE}\n`] };
		await expect(ch.run(job)).rejects.toBeInstanceOf(OutlineEditTextError);
		expect(inline).not.toHaveBeenCalled();
		ch.stop();
	});

	test("attaching a finding: the conversion fails, nothing is written, the finding stays open", async () => {
		const id = await swallowedSession();
		await writeTasks(id, [{ text: "a task" }]);
		expect(await importSpecSession(id, { trigger: "manual" })).toMatchObject({
			status: "imported",
		});
		await scanSpecSessionLossById(id);
		const page = await specLossPage({ status: "open", narratorId: id, canAct: true });
		const findingId = page.items[0]?.id as string;
		const commits = await commitCount(id);
		inline.mockClear();
		const background = spyOn(runner, "processBackgroundText").mockImplementation(async () => {
			throw new OutlineEditTextError("OUTLINE_TEXT_FAILED", "worker exited (1)", 500);
		});
		try {
			await expect(
				decideSpecLossFinding({ id: findingId, narratorId: id, action: "attach", userId: "u" }),
			).rejects.toThrow("worker exited");
			expect(await commitCount(id)).toBe(commits);
			expect(
				(await specLossPage({ status: "open", narratorId: id, canAct: true })).items,
			).toHaveLength(1);
			expect(inline).not.toHaveBeenCalled();
			// The pass's own attach: noted as failed on the finding, nothing written, tried again.
			const session = await readSpecImportSession(id);
			if (!session) throw new Error("no session");
			expect(await attachSpecLossForSession(session)).toEqual({ attached: 0, left: 1 });
			expect(await commitCount(id)).toBe(commits);
			const [open] = (await specLossPage({ status: "open", narratorId: id, canAct: true })).items;
			expect(open).toMatchObject({ status: "open", attachNote: "failed" });
			expect(inline).not.toHaveBeenCalled();
		} finally {
			background.mockRestore();
		}
		// The worker is back: the next pass's attach succeeds.
		const session = await readSpecImportSession(id);
		if (!session) throw new Error("no session");
		expect(await attachSpecLossForSession(session)).toEqual({ attached: 1, left: 0 });
		expect(await commitCount(id)).toBe(commits + 1);
	});
});
