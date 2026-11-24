import { afterEach, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Worker } from "node:worker_threads";
import type { GitStagingDiff, GitStagingSummary } from "../../../shared/git-staging-lists";
import * as compiled from "../../lib/compiled-worker";
import { WorkerCleanupError, WorkerHandle } from "../../lib/worker-runtime/lifecycle";
import { IndependentGitStagingKernel } from "../git-staging-kernel";
import { createGitStagingListsService, executeGitStagingWork } from "../git-staging-lists-service";
import { GitStatusPageService } from "../git-status-page";

function injectedConnection(
	worker: EventEmitter & { terminate(): Promise<number> },
): compiled.ConnectedWorker {
	const resource = worker as unknown as Worker;
	return {
		worker: resource,
		specifier: "injected-worker",
		handle: new WorkerHandle(
			resource,
			new Promise<number>((resolve) => worker.once("exit", resolve)),
			() => worker.terminate(),
		),
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

interface InjectedMessage {
	action: string;
	id?: number;
	taskId?: string;
}

/** A stop request and a real exit are separate, just as they are for a native Worker. */
class ControlledWorker extends EventEmitter {
	readonly messages: InjectedMessage[] = [];
	readonly terminating = deferred();
	readonly activeReads = new Set<number>();
	exitOnTerminate = true;
	stopError?: Error;
	onPost?: (message: InjectedMessage) => void;

	postMessage(message: InjectedMessage) {
		this.messages.push(message);
		if (message.action === "read" && message.id !== undefined) this.activeReads.add(message.id);
		this.emit("posted");
		this.onPost?.(message);
		if (message.action === "close") {
			for (const id of this.activeReads) this.rejectRead(id, "GIT_STATUS_PAGE_CLOSED");
			this.emit("message", { action: "closed" });
		}
	}

	async terminate() {
		this.terminating.resolve();
		if (this.stopError) throw this.stopError;
		if (this.exitOnTerminate) this.exit();
		return 0;
	}

	exit() {
		this.emit("exit", 0);
	}
	ref() {}
	unref() {}

	async waitFor(action: string, count = 1) {
		if (this.messages.filter((message) => message.action === action).length >= count) return;
		await new Promise<void>((resolve) => {
			const posted = () => {
				if (this.messages.filter((message) => message.action === action).length < count) return;
				this.off("posted", posted);
				resolve();
			};
			this.on("posted", posted);
		});
	}

	resolveRead(id: number) {
		this.activeReads.delete(id);
		this.emit("message", { action: "result", id, value: true });
	}

	rejectRead(id: number, code: string) {
		this.activeReads.delete(id);
		this.emit("message", { action: "error", id, code, message: code });
	}
}

const scopeRequest = {
	scope: { actorId: "alice", workspaceKey: "workspace", queryKey: "query" },
	source: { kind: "local" as const, cwd: "/not-executed" },
	proof: { snapshotId: "fixture", filter: [], section: "unstaged" as const },
	files: ["file"],
};

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
});
for (const method of ["action", "baseline"] as const)
	for (const failure of ["disabled", "creation", "runtime", "exit", "timeout", "cancel"] as const) {
		test(`Worker ${failure} never executes ${method} on the main thread`, async () => {
			const main = spyOn(IndependentGitStagingKernel.prototype, method);
			restores.push(() => main.mockRestore());
			let posts = 0;
			const controller = new AbortController();
			class FailedWorker extends EventEmitter {
				postMessage(message: { action: string }) {
					posts++;
					if (message.action !== "execute") return;
					if (failure === "runtime")
						queueMicrotask(() => this.emit("error", new Error("injected runtime failure")));
					if (failure === "exit") queueMicrotask(() => this.emit("exit", 1));
					if (failure === "cancel") queueMicrotask(() => controller.abort(new Error("cancelled")));
				}
				async terminate() {
					this.emit("exit", 0);
					return 0;
				}
			}
			const connection = spyOn(compiled, "connectCompiledWorker").mockImplementation(async () => {
				if (failure === "creation") throw new Error("injected creation failure");
				return injectedConnection(new FailedWorker());
			});
			restores.push(() => connection.mockRestore());
			if (failure === "disabled") {
				const previous = process.env.NARRAFORK_DISABLE_GIT_STAGING_WORKER;
				process.env.NARRAFORK_DISABLE_GIT_STAGING_WORKER = "1";
				restores.push(() => {
					if (previous === undefined) delete process.env.NARRAFORK_DISABLE_GIT_STAGING_WORKER;
					else process.env.NARRAFORK_DISABLE_GIT_STAGING_WORKER = previous;
				});
			}
			if (failure === "timeout" || failure === "cancel") {
				const original = globalThis.setTimeout;
				const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
					handler: (...args: unknown[]) => void,
					delay?: number,
					...args: unknown[]
				) =>
					original(
						handler,
						delay === 125_000 || delay === 20_000 || delay === 5_000 ? 1 : delay,
						...args,
					)) as typeof setTimeout);
				restores.push(() => timer.mockRestore());
			}
			await expect(
				executeGitStagingWork(
					{
						cwd: "/not-executed",
						workspaceKey: "workspace",
						...(method === "action"
							? { method, request: { action: "sync" as const } }
							: { method }),
					},
					controller.signal,
				),
			).rejects.toMatchObject({ code: "GIT_STAGING_WORKER_UNAVAILABLE" });
			expect(main).not.toHaveBeenCalled();
			expect(posts).toBe(
				failure === "creation" || failure === "disabled"
					? 0
					: failure === "timeout" || failure === "cancel"
						? 2
						: 1,
			);
		});
	}

test("commit Worker crash returns an unknown outcome without retry", async () => {
	let posts = 0;
	class FailedWorker extends EventEmitter {
		postMessage() {
			posts++;
			queueMicrotask(() => this.emit("exit", 1));
		}
		async terminate() {
			this.emit("exit", 0);
			return 0;
		}
	}
	const connection = spyOn(compiled, "connectCompiledWorker").mockResolvedValue(
		injectedConnection(new FailedWorker()),
	);
	restores.push(() => connection.mockRestore());
	await expect(
		executeGitStagingWork({
			cwd: "/not-executed",
			workspaceKey: "workspace",
			method: "action",
			request: {
				action: "commit",
				listId: "A",
				message: "commit",
				expectedGeneration: 1,
				observationId: "observed",
			},
		}),
	).rejects.toMatchObject({ code: "GIT_STAGING_COMMIT_UNKNOWN" });
	expect(posts).toBe(1);
});

test("staging admission retains all four native slots after stop returns until real exit", async () => {
	const workers: ControlledWorker[] = [];
	const started = deferred();
	const connection = spyOn(compiled, "connectCompiledWorker").mockImplementation(async () => {
		const worker = new ControlledWorker();
		worker.exitOnTerminate = false;
		worker.onPost = (message) => {
			if (message.action === "execute")
				queueMicrotask(() =>
					worker.emit("message", { action: "result", taskId: message.taskId, value: "done" }),
				);
		};
		workers.push(worker);
		if (workers.length === 4) started.resolve();
		return injectedConnection(worker);
	});
	restores.push(() => connection.mockRestore());
	const request = { cwd: "/not-executed", workspaceKey: "workspace", method: "baseline" as const };
	let completed = 0;
	const running = Array.from({ length: 4 }, () =>
		executeGitStagingWork(request).then((value) => {
			completed++;
			return value;
		}),
	);
	let replacement: Promise<unknown> | undefined;
	try {
		await started.promise;
		await Promise.all(workers.map((worker) => worker.terminating.promise));
		expect(completed).toBe(0);
		await expect(executeGitStagingWork(request)).rejects.toMatchObject({
			code: "GIT_STAGING_BUSY",
		});
		expect(connection).toHaveBeenCalledTimes(4);
		workers[0]?.exit();
		expect(await running[0]).toBe("done");
		replacement = executeGitStagingWork(request);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(connection).toHaveBeenCalledTimes(5);
		expect(completed).toBe(1);
	} finally {
		for (const worker of workers) worker.exit();
		await Promise.all([...running, replacement]);
	}
});

test("staging startup cleanup failures quarantine native capacity until actual exit", async () => {
	const workers: ControlledWorker[] = [];
	const handles: WorkerHandle<Worker>[] = [];
	const stopError = new Error("injected stop failure");
	const connection = spyOn(compiled, "connectCompiledWorker").mockImplementation(async () => {
		const worker = new ControlledWorker();
		const connected = injectedConnection(worker);
		workers.push(worker);
		handles.push(connected.handle);
		if (workers.length <= 4) {
			worker.stopError = stopError;
			await connected.handle.close().catch(() => {});
			throw new WorkerCleanupError(connected.handle, stopError);
		}
		worker.onPost = (message) => {
			if (message.action === "execute")
				queueMicrotask(() =>
					worker.emit("message", { action: "result", taskId: message.taskId, value: "done" }),
				);
		};
		return connected;
	});
	restores.push(() => connection.mockRestore());
	const request = { cwd: "/not-executed", workspaceKey: "workspace", method: "baseline" as const };
	try {
		const failed = await Promise.all(
			Array.from({ length: 4 }, () => executeGitStagingWork(request).catch((error) => error)),
		);
		expect(failed.every((error) => error === stopError)).toBe(true);
		await expect(executeGitStagingWork(request)).rejects.toMatchObject({
			code: "GIT_STAGING_BUSY",
		});
		expect(connection).toHaveBeenCalledTimes(4);
		workers[0]?.exit();
		await handles[0]?.exited;
		expect(await executeGitStagingWork(request)).toBe("done");
		expect(connection).toHaveBeenCalledTimes(5);
	} finally {
		for (const worker of workers) worker.exit();
		await Promise.all(handles.map((handle) => handle.exited));
	}
});

test("paging queue retains cancelled active permits until Worker acknowledgement", async () => {
	const worker = new ControlledWorker();
	const connection = spyOn(compiled, "connectCompiledWorker").mockResolvedValue(
		injectedConnection(worker),
	);
	restores.push(() => connection.mockRestore());
	const service = new GitStatusPageService();
	const controllers = Array.from({ length: 18 }, () => new AbortController());
	const reads = controllers.map((controller) =>
		service.assertScope({ ...scopeRequest, signal: controller.signal }).catch((error) => error),
	);
	try {
		await worker.waitFor("read", 2);
		expect(worker.messages.filter((message) => message.action === "read")).toHaveLength(2);
		const first = worker.messages.find((message) => message.action === "read");
		if (first?.id === undefined) throw new Error("Missing first request");
		controllers[0]?.abort(new Error("viewport replaced"));
		await worker.waitFor("cancel");
		await expect(service.assertScope(scopeRequest)).rejects.toMatchObject({
			code: "GIT_STATUS_PAGE_BUSY",
		});
		expect(worker.messages.filter((message) => message.action === "read")).toHaveLength(2);
		worker.rejectRead(first.id, "GIT_STATUS_PAGE_CANCELLED");
		expect(await reads[0]).toMatchObject({ message: "viewport replaced" });
		await worker.waitFor("read", 3);
		controllers[17]?.abort();
		expect(await reads[17]).toMatchObject({ name: "AbortError" });
		worker.onPost = (message) => {
			if (message.action === "read" && message.id !== undefined)
				queueMicrotask(() => worker.resolveRead(message.id as number));
		};
		for (const id of worker.activeReads) worker.resolveRead(id);
		await Promise.all(reads);
		expect(worker.messages.filter((message) => message.action === "read")).toHaveLength(17);
		expect(connection).toHaveBeenCalledTimes(1);
	} finally {
		await service.close();
		await Promise.all(reads);
	}
});

test("paging close waits for native exit after its owned-resource acknowledgement", async () => {
	const worker = new ControlledWorker();
	worker.exitOnTerminate = false;
	worker.onPost = (message) => {
		if (message.action === "read" && message.id !== undefined)
			queueMicrotask(() => worker.resolveRead(message.id as number));
	};
	const connection = spyOn(compiled, "connectCompiledWorker").mockResolvedValue(
		injectedConnection(worker),
	);
	restores.push(() => connection.mockRestore());
	const service = new GitStatusPageService();
	await service.assertScope(scopeRequest);
	let closed = false;
	const closing = service.close().then(() => {
		closed = true;
	});
	try {
		await worker.terminating.promise;
		expect(closed).toBe(false);
		await expect(service.assertScope(scopeRequest)).rejects.toMatchObject({
			code: "GIT_STATUS_PAGE_CLOSED",
		});
	} finally {
		worker.exit();
		await closing;
	}
	expect(closed).toBe(true);
	expect(connection).toHaveBeenCalledTimes(1);
});

for (const failure of ["runtime", "startup-cleanup"] as const) {
	test(`paging ${failure} replacement waits for the previous owner's actual exit`, async () => {
		const previous = new ControlledWorker();
		previous.exitOnTerminate = false;
		const previousConnection = injectedConnection(previous);
		const replacement = new ControlledWorker();
		replacement.onPost = (message) => {
			if (message.action === "read" && message.id !== undefined)
				queueMicrotask(() => replacement.resolveRead(message.id as number));
		};
		const startupError = new WorkerCleanupError(
			previousConnection.handle,
			new Error("stop failed"),
		);
		const connection = spyOn(compiled, "connectCompiledWorker").mockImplementation(async () => {
			if (connection.mock.calls.length > 1) return injectedConnection(replacement);
			if (failure === "startup-cleanup") {
				previous.stopError = startupError;
				await previousConnection.handle.close().catch(() => {});
				throw startupError;
			}
			return previousConnection;
		});
		restores.push(() => connection.mockRestore());
		const service = new GitStatusPageService();
		const first = service.assertScope(scopeRequest).catch((error) => error);
		let next: Promise<void> | undefined;
		try {
			if (failure === "runtime") {
				await previous.waitFor("read");
				previous.emit("error", new Error("runtime failed"));
				expect(await first).toMatchObject({ code: "GIT_STATUS_PAGE_SOURCE_FAILED" });
			} else expect(await first).toBe(startupError);
			await previous.terminating.promise;
			next = service.assertScope(scopeRequest);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(connection).toHaveBeenCalledTimes(1);
			expect(replacement.messages).toHaveLength(0);
			previous.exit();
			await next;
			expect(connection).toHaveBeenCalledTimes(2);
		} finally {
			previous.exit();
			await next?.catch(() => {});
			await service.close();
		}
	});
}

test("real Worker initializes and returns backend units while reads retain their observation", async () => {
	const root = await mkdtemp(join(tmpdir(), "nf-changelist-worker-"));
	const previous = process.env.NARRAFORK_DISABLE_GIT_STAGING_WORKER;
	delete process.env.NARRAFORK_DISABLE_GIT_STAGING_WORKER;
	try {
		const git = (...args: string[]) =>
			promisify(execFile)(
				"git",
				[
					"-c",
					"user.name=Fixture",
					"-c",
					"user.email=fixture@example.test",
					"-c",
					"commit.gpgSign=false",
					...args,
				],
				{ cwd: root, timeout: 10_000, maxBuffer: 32_768 },
			);
		await git("init", "--quiet");
		await writeFile(join(root, "f"), "base\nold\n");
		await git("add", "f");
		await git("commit", "--quiet", "-m", "base");
		await writeFile(join(root, "f"), "base\nnew\n");
		const native = await readFile(join(root, ".git", "index"));
		const service = createGitStagingListsService({
			workspaceKey: "workspace",
			rootPath: root,
			beforeWrite: async () => {},
		});
		expect((await service.summary()).initialized).toBe(false);
		await service.action({ action: "init" });
		const summary: GitStagingSummary = await service.summary();
		const list = summary.lists[0];
		if (!list) throw new Error("Missing Changes");
		expect(list.name).toBe("Changes");
		const diff: GitStagingDiff = await service.diff(list.id, { path: "f" });
		expect(diff.units.length).toBeGreaterThan(0);
		expect(diff.units.every((unit) => unit.listId === list.id)).toBe(true);
		await writeFile(join(root, "f"), "base\nfurther edit\n");
		expect((await service.summary()).observationId).toBe(summary.observationId);
		expect((await service.diff(list.id, { path: "f" })).diff).toBe(diff.diff);
		expect(await readFile(join(root, ".git", "index"))).toEqual(native);
	} finally {
		if (previous === undefined) delete process.env.NARRAFORK_DISABLE_GIT_STAGING_WORKER;
		else process.env.NARRAFORK_DISABLE_GIT_STAGING_WORKER = previous;
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
