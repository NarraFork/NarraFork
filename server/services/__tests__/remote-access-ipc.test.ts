import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RemotePeerInitConfig } from "../../../shared/remote-access/ipc";
import { getNarraforkPath } from "../../lib/narrafork-home";
import { RemotePeerProcess } from "../remote-access-ipc";

const children: RemotePeerProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(children.splice(0).map((peer) => peer.stop()));
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});
async function setup() {
	const directory = await mkdtemp(getNarraforkPath("ipc-test-"));
	directories.push(directory);
	return join(directory, "child.lock");
}
function spawnPeer(path: string, mode = "test:normal", failures: string[] = []) {
	const originalSpawn = Bun.spawn.bind(Bun);
	// Use a real child with pipes, while selecting a platform-neutral Bun fixture executable.
	const spawn = spyOn(Bun, "spawn").mockImplementation(((
		command: string[],
		options: Record<string, unknown>,
	) => {
		if (command[0] !== "ipc-fixture") throw new Error("Unexpected subprocess");
		return originalSpawn(
			[process.execPath, join(import.meta.dir, "remote-peer-ipc-child.fixture.ts")],
			options,
		);
	}) as typeof Bun.spawn);
	try {
		const config: RemotePeerInitConfig = {
			mode: "narrafork",
			signalUrl: mode,
			bridgeUrl: "http://127.0.0.1:1",
			bridgeSecret: "private",
			statePath: path,
			stunUrls: [],
			allowLocalhost: true,
			leaseSeconds: 300,
			backendIdentity: {
				nfVersion: "1.0.0",
				sourceCommit: "abcdef0",
				repository: "example/repo",
				bootstrapAbi: 1,
				apiEpoch: 1,
				wireVersion: 2,
				capabilities: [],
			},
			requestPolicy: [],
		};
		const peer = new RemotePeerProcess(
			"ipc-fixture",
			"test_epoch",
			config,
			() => {},
			(code) => failures.push(code),
		);
		children.push(peer);
		return peer;
	} finally {
		spawn.mockRestore();
	}
}

test("fire-and-forget control messages have bounded matching ACKs and do not poison RPC", async () => {
	const failures: string[] = [];
	const peer = spawnPeer(await setup(), "test:normal", failures);
	await peer.ready;
	peer.send("peer.accept", { peerId: "one" }, "open_event_id");
	peer.send("session.updated", { peerId: "one" });
	expect(await peer.command("grants.list")).toEqual({ ok: true });
	expect(failures).toEqual([]);
	await peer.stop();
	expect(failures).toEqual([]);
});
test("normal shutdown waits for owned child exit before opening the same exclusive state", async () => {
	const path = await setup();
	const first = spawnPeer(path);
	await first.ready;
	expect((await stat(path)).isFile()).toBe(true);
	await first.stop();
	expect(
		await stat(path).then(
			() => true,
			() => false,
		),
	).toBe(false);
	const second = spawnPeer(path);
	await second.ready;
	expect(await second.command("pair.create")).toEqual({ ok: true });
	await second.stop();
});
for (const mode of ["test:eof", "test:bad-epoch", "test:oversize"]) {
	test(`invalidates startup on ${mode} without restarting or leaving an unhandled rejection`, async () => {
		const failures: string[] = [];
		const peer = spawnPeer(await setup(), mode, failures);
		await expect(peer.ready).rejects.toThrow();
		await peer.stop();
		expect(failures).toHaveLength(1);
	});
}
test("malformed command results reject the matching promise instead of leaving it pending", async () => {
	const failures: string[] = [];
	const peer = spawnPeer(await setup(), "test:invalid-result", failures);
	await peer.ready;
	await expect(peer.command("grants.list")).rejects.toThrow("REMOTE_PEER_BAD_IPC");
	await peer.stop();
	expect(failures).toEqual(["REMOTE_PEER_BAD_IPC"]);
});
