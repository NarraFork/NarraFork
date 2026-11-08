import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SafeSpawnOptions, type SafeSpawnResult, safeSpawn } from "../lib/spawn";
import {
	createDtachRecoveryProbe,
	DTACH_SNAPSHOT_MAX_BYTES,
	DTACH_SNAPSHOT_TIMEOUT_MS,
} from "./dtach-recovery-probe";

const success = (stdout: string): SafeSpawnResult => ({ stdout, stderr: "", exitCode: 0 });
const socket = async () => "alive" as const;
const daemon = (path: string) => `123 dtach dtach -n ${path} -z /bin/bash -li`;

describe("bounded startup dtach snapshot", () => {
	test("matches complete paths literally, including whitespace and regex characters", async () => {
		const path = "/home/test user/[x]+/terminal-a.sock";
		const spawn = mock(async (_options: SafeSpawnOptions) =>
			success(`${daemon(path)}\n${daemon(`${path}-suffix`)}\n`),
		);
		const probe = await createDtachRecoveryProbe(spawn, socket);
		expect(await probe.check(path)).toBe("alive");
		expect(await probe.check(`${path}-suffix`)).toBe("alive");
		expect(await probe.check("/home/test user/xxx/terminal-a.sock")).toBe("dead");
		expect(await probe.check(path.slice(0, -5))).toBe("dead");
		expect(await probe.check(`${path}-suffix-more`)).toBe("dead");
		expect(probe.stats.snapshotComplete).toBe(true);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn.mock.calls[0]).toEqual([
			{
				cmd: ["ps", "-axww", "-o", "pid=,comm=,args="],
				timeout: DTACH_SNAPSHOT_TIMEOUT_MS,
				maxOutputBytes: DTACH_SNAPSHOT_MAX_BYTES,
				maxStderrBytes: 4096,
			},
		]);
	});

	test("a path in another process or only an attach client is not a live daemon", async () => {
		const path = "/tmp/terminal-a.sock";
		const probe = await createDtachRecoveryProbe(
			async () => success(`1 echo echo ${path}\n2 dtach dtach -a ${path} -z\n`),
			socket,
		);
		expect(await probe.check(path)).toBe("dead");
	});

	for (const [name, result] of [
		["nonzero exit", { ...success(""), exitCode: 1 }],
		["truncated positive prefix", { ...success(daemon("/tmp/a.sock")), stdoutTruncated: true }],
		["timeout", { ...success(""), terminationReason: "timeout" }],
		["empty output", success("")],
		["malformed output", success("not a process row")],
		["unrecognized dtach invocation", success("1 dtach dtach -N /tmp/a.sock /bin/sh")],
	] as const) {
		test(`${name} preserves possible live sockets as unknown without per-terminal scans`, async () => {
			const spawn = mock(async () => result);
			const probe = await createDtachRecoveryProbe(spawn, socket);
			for (let id = 0; id < 85; id++) {
				expect(await probe.check(`/tmp/terminal-${id}.sock`)).toBe("unknown");
			}
			expect(await probe.check("/tmp/a.sock")).toBe("unknown");
			expect(probe.stats.snapshotComplete).toBe(false);
			expect(probe.stats.socketChecks).toBe(86);
			expect(spawn).toHaveBeenCalledTimes(1);
		});
	}

	test("spawn rejection does not prove death; missing and non-socket files do", async () => {
		const probe = await createDtachRecoveryProbe(async () => {
			throw new Error("ps unavailable");
		}, socket);
		expect(await probe.check("/any/socket")).toBe("unknown");
		expect(probe.stats.snapshotFailure).toBe("spawn-failed");
		const realStat = await createDtachRecoveryProbe(async () => success(daemon(import.meta.path)));
		expect(await realStat.check(import.meta.path)).toBe("dead");
		expect(await realStat.check(`${import.meta.path}.missing`)).toBe("dead");
	});

	test("ambiguous parsing preserves negative results but permits exact positive evidence", async () => {
		const probe = await createDtachRecoveryProbe(
			async () => success(`${daemon("/tmp/a.sock")}\n2 dtach dtach ???\n`),
			socket,
		);
		expect(await probe.check("/tmp/a.sock")).toBe("alive");
		expect(await probe.check("/tmp/b.sock")).toBe("unknown");
		const inaccessible = await createDtachRecoveryProbe(
			async () => success(daemon("/tmp/a.sock")),
			async () => "unknown",
		);
		expect(await inaccessible.check("/tmp/a.sock")).toBe("unknown");
	});

	test.skipIf(process.platform === "win32" || !Bun.which("dtach"))(
		"native dtach daemon exposes the exact recoverable socket argument (isolated fixture only)",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "nf-dtach-"));
			const socketPath = join(directory, "terminal-[fixture]+.sock");
			const pidFile = join(directory, "pid.json");
			let child: { pid: number; ppid: number } | undefined;
			try {
				const started = await safeSpawn({
					cmd: [
						"dtach",
						"-n",
						socketPath,
						"-z",
						process.execPath,
						"-e",
						`await Bun.write(${JSON.stringify(pidFile)}, JSON.stringify({pid:process.pid,ppid:process.ppid})); setTimeout(() => {}, 20000);`,
					],
					timeout: 1000,
					maxOutputBytes: 4096,
				});
				expect(started.exitCode).toBe(0);
				const deadline = performance.now() + 2000;
				while (!child) {
					try {
						child = JSON.parse(await readFile(pidFile, "utf8"));
					} catch {
						if (performance.now() > deadline) throw new Error("fixture did not start");
						await Bun.sleep(5);
					}
				}
				const daemonPid = child.ppid;
				const probe = await createDtachRecoveryProbe((options) =>
					safeSpawn({
						...options,
						cmd: ["ps", "-ww", "-p", String(daemonPid), "-o", "pid=,comm=,args="],
					}),
				);
				expect(probe.stats.snapshotComplete).toBe(true);
				expect(await probe.check(socketPath)).toBe("alive");
			} finally {
				// Only this fixture's PID is terminated, never any application/server process.
				if (child) {
					try {
						process.kill(child.pid, "SIGTERM");
					} catch {
						/* already exited */
					}
				}
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	test("85-terminal subprocess amortization A/B uses the same bounded process-list fixture", async () => {
		const paths = Array.from({ length: 85 }, (_, id) => `/tmp/terminal-benchmark-${id}.sock`);
		const output = paths.map(daemon).join("\n");
		const scan = mock((options: SafeSpawnOptions) =>
			safeSpawn({
				...options,
				cmd: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`],
			}),
		);
		const before = performance.now();
		for (const path of paths) {
			const perTerminal = await createDtachRecoveryProbe(scan, socket);
			expect(await perTerminal.check(path)).toBe("alive");
		}
		const repeatedMs = Math.round(performance.now() - before);
		expect(scan).toHaveBeenCalledTimes(85);
		scan.mockClear();
		const sharedStarted = performance.now();
		const shared = await createDtachRecoveryProbe(scan, socket);
		for (const path of paths) expect(await shared.check(path)).toBe("alive");
		expect(scan).toHaveBeenCalledTimes(1);
		const sharedMs = Math.round(performance.now() - sharedStarted);
		// Fixture measures scan-launch amortization, not a production cold-start speedup.
		console.info(
			`terminal process-list fixture A/B: repeated=${repeatedMs}ms/85 scans, shared=${sharedMs}ms/1 scan`,
		);
	}, 15_000);

	test("real safeSpawn streams have bounded capture and timeout instead of false death", async () => {
		let captured: SafeSpawnResult | undefined;
		const oversized = await createDtachRecoveryProbe(async (options) => {
			captured = await safeSpawn({
				...options,
				cmd: [process.execPath, "-e", 'process.stdout.write("x".repeat(65536))'],
				maxOutputBytes: 1024,
			});
			return captured;
		}, socket);
		// safeSpawn appends a fixed diagnostic after its bounded retained payload.
		expect(captured?.stdout).toBe(
			`${"x".repeat(1024)}\n\n[safeSpawn output truncated — exceeded capture limit]`,
		);
		expect(captured?.stdoutTruncated).toBe(true);
		expect(await oversized.check("/tmp/a.sock")).toBe("unknown");
		const timedOut = await createDtachRecoveryProbe(async (options) => {
			captured = await safeSpawn({
				...options,
				cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
				timeout: 30,
			});
			return captured;
		}, socket);
		// Legacy safeSpawn capture reports a timeout through its nonzero exit code.
		expect(captured?.exitCode).not.toBe(0);
		expect(timedOut.stats.snapshotComplete).toBe(false);
		expect(await timedOut.check("/tmp/a.sock")).toBe("unknown");
	});
});
