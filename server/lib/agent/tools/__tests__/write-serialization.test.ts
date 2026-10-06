import { describe, expect, test } from "bun:test";
import { LOCAL_DEVICE_ID } from "../../execution/backend";
import {
	BASH_WRITE_LOCK_TIMEOUT_MS,
	decideBashSerialization,
	resolveBashSerializationInput,
	withBashWriteLock,
	withWorkspaceWriteLock,
} from "../write-serialization";

const WORKSPACE = "/tmp/nf-serialization-workspace";
const local = { deviceId: LOCAL_DEVICE_ID };
const remote = { deviceId: "remote-a" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseInput(overrides: Partial<Parameters<typeof decideBashSerialization>[0]> = {}) {
	return {
		cwd: WORKSPACE,
		filePaths: [`${WORKSPACE}/src/a.ts`],
		hasWriteOperation: true,
		allReadOnly: false,
		commandNames: ["rm"],
		commandTokens: [`${WORKSPACE}/src/a.ts`],
		isBackground: false,
		...overrides,
	};
}

describe("bash serialization policy", () => {
	test("serializes a recognised write operation", () => {
		expect(decideBashSerialization(baseInput()).shouldSerialize).toBe(true);
	});

	test("never serializes background commands", () => {
		// Background bash defaults to a 5h timeout and may run for a day; holding the
		// write lock across that would stall every other session on this worktree.
		expect(decideBashSerialization(baseInput({ isBackground: true })).shouldSerialize).toBe(false);
	});

	test("does not serialize read-only commands", () => {
		expect(
			decideBashSerialization(baseInput({ allReadOnly: true, hasWriteOperation: false }))
				.shouldSerialize,
		).toBe(false);
	});

	test("does not serialize commands with unbounded runtime", () => {
		// `bun run build` / `make`: the write is real but the runtime is unbounded, so
		// holding the lock across it would make every other command pay the deadline.
		expect(
			decideBashSerialization(
				baseInput({
					hasWriteOperation: false,
					filePaths: [],
					commandNames: ["bun"],
					commandTokens: ["run", "build"],
				}),
			).shouldSerialize,
		).toBe(false);
	});

	test("does not serialize when any extracted target is outside the workspace", () => {
		expect(
			decideBashSerialization(baseInput({ filePaths: [`${WORKSPACE}/src/a.ts`, "/etc/hosts"] }))
				.shouldSerialize,
		).toBe(false);
	});

	test("accepts the workspace directory itself as a target", () => {
		expect(decideBashSerialization(baseInput({ filePaths: [WORKSPACE] })).shouldSerialize).toBe(
			true,
		);
	});

	test("a sibling directory sharing a name prefix is not inside the workspace", () => {
		expect(
			decideBashSerialization(baseInput({ filePaths: [`${WORKSPACE}-other/a.ts`] }))
				.shouldSerialize,
		).toBe(false);
	});

	test("one unbounded command in a chain disqualifies the whole chain", () => {
		expect(
			decideBashSerialization(
				baseInput({
					hasWriteOperation: false,
					filePaths: [],
					commandNames: ["sed", "bun"],
					commandTokens: ["-i", "s/a/b/", "a.ts", "run", "build"],
				}),
			).shouldSerialize,
		).toBe(false);
	});
});

// The analyzer is the real source of these decisions, so the policy is pinned
// against actual command strings rather than only hand-built inputs.
describe("bash serialization from real command analysis", () => {
	async function decide(command: string, cwd = WORKSPACE) {
		const input = await resolveBashSerializationInput({
			command,
			cwd,
			isBackground: false,
			isChapter: false,
		});
		return decideBashSerialization(input);
	}

	test("serializes an in-place sed on a workspace file", async () => {
		// `hasWriteOperation` only covers checker-tool write flags, and `sed` extracts
		// no filePaths — this is the case the short-mutation list exists for.
		expect((await decide("sed -i s/a/b/ src/a.ts")).shouldSerialize).toBe(true);
		expect((await decide(`sed -i s/a/b/ ${WORKSPACE}/src/a.ts`)).shouldSerialize).toBe(true);
	});

	test("serializes formatter and coreutils mutations", async () => {
		expect((await decide("bunx @biomejs/biome check --write server/")).shouldSerialize).toBe(true);
		expect((await decide("rm src/a.ts")).shouldSerialize).toBe(true);
		expect((await decide("mv a.ts b.ts")).shouldSerialize).toBe(true);
		expect((await decide("chmod 644 src/a.ts")).shouldSerialize).toBe(true);
	});

	test("refuses a short mutation aimed outside the workspace", async () => {
		// A sed script token (`s/a/b/`) must not be mistaken for an in-workspace path.
		expect((await decide("sed -i s/a/b/ /etc/hosts")).shouldSerialize).toBe(false);
		expect((await decide("sed -i s/a/b/ ../outside.ts")).shouldSerialize).toBe(false);
		expect((await decide("rm /etc/passwd")).shouldSerialize).toBe(false);
	});

	test("leaves read-only and unbounded commands concurrent", async () => {
		expect((await decide("cat src/a.ts")).shouldSerialize).toBe(false);
		expect((await decide("bun run build")).shouldSerialize).toBe(false);
		expect((await decide("make")).shouldSerialize).toBe(false);
		expect((await decide("tail -f log.txt")).shouldSerialize).toBe(false);
		expect((await decide("sed -i s/a/b/ a.ts && bun run build")).shouldSerialize).toBe(false);
	});

	test("skips analysis entirely for background commands", async () => {
		const input = await resolveBashSerializationInput({
			command: "sed -i s/a/b/ src/a.ts",
			cwd: WORKSPACE,
			isBackground: true,
			isChapter: false,
		});
		expect(input.isBackground).toBe(true);
		expect(decideBashSerialization(input).shouldSerialize).toBe(false);
	});
});

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

	test("different workspaces do not contend", async () => {
		let active = 0;
		let maxActive = 0;
		const body = async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await sleep(10);
			active--;
		};

		await Promise.all([
			withWorkspaceWriteLock(local, `${WORKSPACE}-a`, body),
			withWorkspaceWriteLock(local, `${WORKSPACE}-b`, body),
		]);
		expect(maxActive).toBe(2);
	});

	test("remote backends bypass the local lock", async () => {
		let active = 0;
		let maxActive = 0;
		const body = async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await sleep(10);
			active--;
		};

		// A remote path is not on this server's filesystem, so a local mutex would be
		// guarding nothing.
		await Promise.all([
			withWorkspaceWriteLock(remote, WORKSPACE, body),
			withWorkspaceWriteLock(remote, WORKSPACE, body),
		]);
		expect(maxActive).toBe(2);
	});

	test("a qualifying bash command serializes against a Write window", async () => {
		const order: string[] = [];
		const writeHolder = withWorkspaceWriteLock(local, WORKSPACE, async () => {
			order.push("write-start");
			await sleep(30);
			order.push("write-end");
		});
		await sleep(5);

		const outcome = await withBashWriteLock(local, baseInput(), async () => {
			order.push("bash");
			return "ok";
		});
		await writeHolder;

		expect(outcome).toEqual({ value: "ok", serialized: true });
		expect(order).toEqual(["write-start", "write-end", "bash"]);
	});

	test("a bash command runs unserialized rather than waiting past the deadline", async () => {
		const order: string[] = [];
		const holder = withWorkspaceWriteLock(local, WORKSPACE, async () => {
			order.push("holder-start");
			await sleep(120);
			order.push("holder-end");
		});
		await sleep(5);

		// The point of the bounded attempt: a long write window must not block bash.
		const outcome = await withBashWriteLock(
			local,
			baseInput(),
			async () => {
				order.push("bash");
				return "ran anyway";
			},
			20,
		);
		expect(outcome).toEqual({ value: "ran anyway", serialized: false });
		// bash ran while the holder was still inside its window.
		expect(order).toEqual(["holder-start", "bash"]);

		await holder;
	});

	test("a non-qualifying bash command does not wait for the lock at all", async () => {
		const order: string[] = [];
		const holder = withWorkspaceWriteLock(local, WORKSPACE, async () => {
			order.push("holder-start");
			await sleep(60);
			order.push("holder-end");
		});
		await sleep(5);

		const started = Date.now();
		const outcome = await withBashWriteLock(
			local,
			baseInput({
				hasWriteOperation: false,
				filePaths: [],
				commandNames: ["bun"],
				commandTokens: ["run", "build"],
			}),
			async () => {
				order.push("build");
				return "built";
			},
		);
		// No lock attempt means no waiting, not even the deadline.
		expect(Date.now() - started).toBeLessThan(20);
		expect(outcome.serialized).toBe(false);
		expect(order).toEqual(["holder-start", "build"]);

		await holder;
	});

	test("the default bash deadline is short enough to stay unnoticed", () => {
		// A regression guard: raising this materially would turn a mis-classified
		// long-running command into a visible stall for other sessions.
		expect(BASH_WRITE_LOCK_TIMEOUT_MS).toBeLessThanOrEqual(3000);
	});
});
