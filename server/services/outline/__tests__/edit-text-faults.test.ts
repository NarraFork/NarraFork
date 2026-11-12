/**
 * Fault injection for the edit-text worker channels (CLAUDE.md, worker isolation; outline P2 PR
 * 12b review S3): a worker that does not start (its start rejects, never answers, or worker
 * threads are unavailable), one that crashes in the middle of a job, and one that hangs. Each job
 * fails, and the job is never run on the caller's thread instead (`runEditTextJob` is spied).
 * The Dynamic Spec import over a failing background channel fails and moves nothing.
 *
 * The channels here are made for the test (`createEditTextChannel`) with a fake worker start, so
 * the real channels' workers are not touched.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { settings } from "../../../lib/settings";
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
