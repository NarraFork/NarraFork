import { describe, expect, test } from "bun:test";
import { LOCAL_DEVICE_ID } from "../../execution/backend";
import { withBashWriteLock, withWorkspaceWriteLock } from "../write-serialization";

const WORKSPACE = "/tmp/nf-serialization-workspace";
const local = { deviceId: LOCAL_DEVICE_ID };
const remote = { deviceId: "remote-a" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function baseInput() {
	return {
		cwd: WORKSPACE,
		filePaths: [`${WORKSPACE}/src/a.ts`],
		hasWriteOperation: true,
		allReadOnly: false,
		commandNames: ["rm"],
		commandTokens: [`${WORKSPACE}/src/a.ts`],
		isBackground: false,
	};
}

describe("write lock behaviour", () => {
	test("Write/Edit windows on the same workspace run one at a time", async () => {
		let active = 0;
		let maxActive = 0;
		const body = async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await sleep(10);
			active--;
		};
		await Promise.all([
			withWorkspaceWriteLock(local, WORKSPACE, body),
			withWorkspaceWriteLock(local, WORKSPACE, body),
			withWorkspaceWriteLock(local, WORKSPACE, body),
		]);
		expect(maxActive).toBe(1);
	});

	for (const differentWorkspace of [true, false]) {
		test(
			differentWorkspace
				? "different workspaces do not contend"
				: "remote backends bypass the local lock",
			async () => {
				let active = 0;
				let maxActive = 0;
				const body = async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await sleep(10);
					active--;
				};
				const backend = differentWorkspace ? local : remote;
				await Promise.all([
					withWorkspaceWriteLock(backend, WORKSPACE, body),
					withWorkspaceWriteLock(backend, differentWorkspace ? `${WORKSPACE}-b` : WORKSPACE, body),
				]);
				expect(maxActive).toBe(2);
			},
		);
	}

	test("Bash mutations start without waiting for a held Write/Edit lock", async () => {
		const entered = deferred();
		const release = deferred();
		const holder = withWorkspaceWriteLock(local, WORKSPACE, async () => {
			entered.resolve();
			await release.promise;
		});
		try {
			await entered.promise;
			const outcome = await withBashWriteLock(local, baseInput(), async () => "ran", 60_000);
			expect(outcome).toEqual({ value: "ran", serialized: false });
		} finally {
			release.resolve();
			await holder;
		}
	});

	test("a running Bash mutation never blocks a Write/Edit window", async () => {
		const entered = deferred();
		const release = deferred();
		const bash = withBashWriteLock(local, baseInput(), async () => {
			entered.resolve();
			await release.promise;
			return "settled";
		});
		try {
			await entered.promise;
			expect(await withWorkspaceWriteLock(local, WORKSPACE, async () => "written")).toBe("written");
		} finally {
			release.resolve();
			await bash;
		}
		expect(await bash).toEqual({ value: "settled", serialized: false });
	});

	test("Bash compatibility layer preserves failures", async () => {
		const error = new Error("process failed");
		await expect(
			withBashWriteLock(local, baseInput(), async () => {
				throw error;
			}),
		).rejects.toBe(error);
	});

	test("aborting an admitted Write does not release its lock early", async () => {
		const entered = deferred();
		const release = deferred();
		const controller = new AbortController();
		let nextEntered = false;
		const holder = withWorkspaceWriteLock(
			local,
			WORKSPACE,
			async () => {
				entered.resolve();
				await release.promise;
			},
			controller.signal,
		);
		await entered.promise;
		controller.abort();
		const next = withWorkspaceWriteLock(local, WORKSPACE, async () => {
			nextEntered = true;
		});
		try {
			await sleep(10);
			expect(nextEntered).toBe(false);
		} finally {
			release.resolve();
			await Promise.all([holder, next]);
		}
		expect(nextEntered).toBe(true);
	});
});
