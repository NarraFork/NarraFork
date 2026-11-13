import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecHandle } from "../backend";

const supported = process.platform === "linux" || process.platform === "darwin";
const home = mkdtempSync(join(tmpdir(), "nf-durable-svc-"));
const previousHome = process.env.NARRAFORK_HOME;

let durable: typeof import("../durable-service");

beforeAll(async () => {
	process.env.NARRAFORK_HOME = home;
	durable = await import("../durable-service");
});

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(home, { recursive: true, force: true });
});

function collect(handle: ExecHandle): () => string {
	let out = "";
	handle.onData((chunk) => {
		out += Buffer.from(chunk).toString("utf8");
	});
	return () => out;
}

function spawnService(taskId: string, command: string) {
	return durable.spawnDurableService({
		taskId,
		command,
		cwd: home,
		env: { PATH: process.env.PATH, HOME: home },
		shellPath: "/bin/sh",
		login: false,
	});
}

describe.skipIf(!supported)("durable background services", () => {
	test("streams output from the log file and reports the exit code", async () => {
		const handle = await spawnService("svc_exit", "echo hello; echo oops >&2; exit 3");
		const output = collect(handle);
		expect(await handle.exited).toBe(3);
		expect(output()).toContain("hello");
		expect(output()).toContain("oops");
		const outcome = await durable.readOrphanedServiceOutcome("svc_exit");
		expect(outcome.exitCode).toBe(3);
		expect(outcome.hasManifest).toBe(true);
	});

	test("a new handle re-attaches to a running service and sees its exit", async () => {
		const original = await spawnService(
			"svc_adopt",
			"echo before; read -t 2 _ </dev/zero 2>/dev/null; sleep 1; echo after; exit 0",
		);
		collect(original);
		// Simulate the old server process going away: stop tailing without touching it.
		(original as InstanceType<typeof durable.DurableServiceHandle>).detach();

		const adopted = await durable.adoptDurableService("svc_adopt");
		expect(adopted).not.toBeNull();
		if (!adopted) return;
		const output = collect(adopted.handle);
		expect(adopted.manifest.pid).toBe(original.pid as number);
		expect(await adopted.handle.exited).toBe(0);
		expect(output()).toContain("re-attached");
		expect(output()).toContain("after");
	});

	test("kill on an adopted handle terminates the whole process group", async () => {
		const original = await spawnService("svc_kill", "sleep 30 & sleep 30; wait");
		(original as InstanceType<typeof durable.DurableServiceHandle>).detach();
		const adopted = await durable.adoptDurableService("svc_kill");
		expect(adopted).not.toBeNull();
		if (!adopted) return;
		await adopted.handle.kill();
		await adopted.handle.exited;
		const pid = adopted.manifest.pid;
		expect(() => process.kill(-pid, 0)).toThrow();
	});

	test("does not adopt a pid whose start token no longer matches", async () => {
		const handle = await spawnService("svc_reuse", "sleep 5");
		const manifest = await durable.readManifest("svc_reuse");
		expect(manifest).not.toBeNull();
		if (!manifest) return;
		expect(await durable.isSameProcess(manifest.pid, manifest.startToken)).toBe(true);
		expect(await durable.isSameProcess(manifest.pid, `${manifest.startToken}x`)).toBe(false);
		await handle.kill();
		await handle.exited;
		expect(await durable.adoptDurableService("svc_reuse")).toBeNull();
	});

	test("a service that ended while nobody watched is settled from its exit file", async () => {
		const handle = await spawnService("svc_orphan", "echo bye; exit 7");
		(handle as InstanceType<typeof durable.DurableServiceHandle>).detach();
		// Wait for the process to finish on its own.
		for (
			let i = 0;
			i < 50 && !(await durable.readOrphanedServiceOutcome("svc_orphan")).exitCode;
			i++
		)
			await Bun.sleep(50);
		expect(await durable.adoptDurableService("svc_orphan")).toBeNull();
		const outcome = await durable.readOrphanedServiceOutcome("svc_orphan");
		expect(outcome.exitCode).toBe(7);
		expect(outcome.logTail).toContain("bye");
	});

	test("survives the server's stdout going away (no SIGPIPE on output)", async () => {
		// Output goes to a file, so writing after the reader stopped must not kill the service.
		const handle = await spawnService(
			"svc_pipe",
			"i=0; while [ $i -lt 20 ]; do echo line$i; i=$((i+1)); sleep 0.05; done; exit 0",
		);
		(handle as InstanceType<typeof durable.DurableServiceHandle>).detach();
		for (
			let i = 0;
			i < 60 && (await durable.readOrphanedServiceOutcome("svc_pipe")).exitCode === null;
			i++
		)
			await Bun.sleep(50);
		const outcome = await durable.readOrphanedServiceOutcome("svc_pipe");
		expect(outcome.exitCode).toBe(0);
		expect(outcome.logTail).toContain("line19");
	});

	test("sweep removes directories not referenced by a running task", async () => {
		const handle = await spawnService("svc_sweep", "exit 0");
		await handle.exited;
		const dir = join(durable.getServicesRoot(), "svc_sweep");
		expect(existsSync(dir)).toBe(true);
		await durable.sweepServiceArtifacts(new Set(["svc_other"]));
		expect(existsSync(dir)).toBe(false);
	});
});
