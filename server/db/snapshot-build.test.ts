import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshotInSubprocess, closeSnapshotBuilds } from "./snapshot-build";
import { SNAPSHOT_TABLES } from "./snapshot-protocol";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

const input = {
	sourcePath: "/source.sqlite",
	outputPath: "/snapshot.sqlite",
	requests: true,
	sessions: true,
};

describe("dedicated snapshot process", () => {
	test("real process copies selected tables without mutating source", async () => {
		const root = await mkdtemp(join(tmpdir(), "nf-snapshot-worker-"));
		paths.push(root);
		const sourcePath = join(root, "source.sqlite");
		const outputPath = join(root, "output.sqlite");
		const source = new Database(sourcePath);
		for (const table of [...SNAPSHOT_TABLES.requests, ...SNAPSHOT_TABLES.sessions]) {
			source.run(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
			source.run(`INSERT INTO ${table} VALUES ('retained')`);
		}
		source.close();
		await buildSnapshotInSubprocess({ ...input, sourcePath, outputPath });
		const snapshot = new Database(outputPath, { readonly: true });
		try {
			for (const table of [...SNAPSHOT_TABLES.requests, ...SNAPSHOT_TABLES.sessions])
				expect(snapshot.query(`SELECT id FROM ${table}`).get()).toEqual({ id: "retained" });
		} finally {
			snapshot.close();
		}
		const verify = new Database(sourcePath, { readonly: true });
		expect(verify.query(`SELECT id FROM ${SNAPSHOT_TABLES.requests[0]}`).get()).toEqual({
			id: "retained",
		});
		verify.close();
	});

	test("creation failure and missing reports fail closed", async () => {
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("spawn denied");
		});
		try {
			await expect(buildSnapshotInSubprocess(input)).rejects.toThrow("spawn denied");
		} finally {
			spawn.mockRestore();
		}
		const original = Bun.spawn;
		const noReport = spyOn(Bun, "spawn").mockImplementation(
			(_command, options?) =>
				original([process.execPath, "-e", "process.exit(0)"], options as never) as ReturnType<
					typeof Bun.spawn
				>,
		);
		try {
			await expect(buildSnapshotInSubprocess(input)).rejects.toThrow("no report");
		} finally {
			noReport.mockRestore();
		}
	});

	test("real execution timeout and output overflow terminate without copying inline", async () => {
		const original = Bun.spawn;
		let mode = "hang";
		const procs: ReturnType<typeof Bun.spawn>[] = [];
		const spawn = spyOn(Bun, "spawn").mockImplementation((_command, options?) => {
			const code =
				mode === "hang"
					? "await Bun.sleep(60000)"
					: "process.stdout.write('x'.repeat(256*1024)); await Bun.sleep(60000)";
			const proc = original([process.execPath, "-e", code], options as never) as ReturnType<
				typeof Bun.spawn
			>;
			procs.push(proc);
			return proc;
		});
		try {
			await expect(buildSnapshotInSubprocess({ ...input, timeoutMs: 100 })).rejects.toThrow(
				"stopped",
			);
			mode = "overflow";
			await expect(buildSnapshotInSubprocess(input)).rejects.toThrow("stopped");
			expect(procs).toHaveLength(2);
			for (const proc of procs) expect(await proc.exited).not.toBe(0);
		} finally {
			spawn.mockRestore();
		}
	});

	test("close rejects queued jobs and cannot release slots before delayed real exit ACK", async () => {
		const resources: { kills: number; finish(): void }[] = [];
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			const exited = Promise.withResolvers<number>();
			let stdout!: ReadableStreamDefaultController<Uint8Array>;
			const resource = {
				kills: 0,
				finish() {
					stdout.close();
					exited.resolve(0);
				},
			};
			resources.push(resource);
			return {
				stdout: new ReadableStream<Uint8Array>({
					start(controller) {
						stdout = controller;
					},
				}),
				exited: exited.promise,
				kill() {
					resource.kills++;
				},
			} as unknown as ReturnType<typeof Bun.spawn>;
		});
		const jobs = Array.from({ length: 11 }, () => buildSnapshotInSubprocess(input));
		for (const job of jobs) void job.catch(() => {});
		try {
			await turn();
			expect(resources).toHaveLength(2);
			await expect(jobs[10]).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
			let closed = false;
			const closing = closeSnapshotBuilds().then(() => {
				closed = true;
			});
			await turn();
			expect(resources.every((resource) => resource.kills === 1)).toBe(true);
			expect(closed).toBe(false);
			expect(resources).toHaveLength(2);
			for (const resource of resources) resource.finish();
			await closing;
			expect(closed).toBe(true);
			expect((await Promise.allSettled(jobs)).every((job) => job.status === "rejected")).toBe(true);
			await expect(buildSnapshotInSubprocess(input)).rejects.toMatchObject({
				code: "TASK_QUEUE_CLOSED",
			});
		} finally {
			spawn.mockRestore();
		}
	});
});
