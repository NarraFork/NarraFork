import { describe, expect, it } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
	createWorkspaceProcessProbe,
	runWorkspaceIdentityCommand,
	type WorkspaceProcessProbeDependencies,
} from "../../../server/lib/workspace-process-identity";

const machine = "1234567890abcdef1234567890abcdef";
const boot = "12345678-1234-1234-1234-123456789012";
function stat(pid: number, birth = "98765432198765432") {
	return `${pid} (name (with) spaces) S ${Array(18).fill("0").join(" ")} ${birth} 0\n`;
}
function linux(overrides: Partial<WorkspaceProcessProbeDependencies> = {}) {
	const files: Record<string, string> = {
		"/etc/machine-id": machine,
		"/proc/sys/kernel/random/boot_id": boot,
		"/proc/self/stat": stat(12),
		"/proc/42/stat": stat(42),
	};
	const deps: WorkspaceProcessProbeDependencies = {
		platform: "linux",
		selfPid: 12,
		read: async (path) => {
			if (files[path] === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return files[path];
		},
		readlink: async (path) => (path.endsWith("/time") ? "time:[789]" : "pid:[123]"),
		checkPid: () => "absent",
		windowsQuery: async () => null,
		...overrides,
	};
	return { files, deps, probe: createWorkspaceProcessProbe(deps) };
}
function windows(raw: unknown) {
	return linux({
		platform: "win32",
		windowsQuery: async () => (typeof raw === "string" ? raw : JSON.stringify(raw)),
	}).probe;
}

describe("strict local OS identity probe", () => {
	it("reads Linux exact ticks without converting to number or wall-clock", async () => {
		expect(await linux().probe(42)).toEqual({
			kind: "present",
			identity: {
				version: 1,
				pid: 42,
				birth: "98765432198765432",
				domain: {
					platform: "linux",
					machine,
					boot,
					pidNamespace: "pid:[123]",
					timeNamespace: "time:[789]",
				},
			},
		});
	});

	it("requires both ENOENT and kernel ESRCH; hidepid/permission failure is unknown", async () => {
		for (const status of ["present", "unknown", "absent"] as const) {
			const l = linux({ checkPid: () => status });
			delete l.files["/proc/42/stat"];
			expect((await l.probe(42)).kind).toBe(status === "absent" ? "absent" : "unknown");
		}
		const l = linux();
		const read = l.deps.read;
		l.deps.read = async (path) => {
			if (path === "/proc/42/stat") throw Object.assign(new Error("denied"), { code: "EACCES" });
			return read(path);
		};
		expect((await l.probe(42)).kind).toBe("unknown");
	});

	it("rejects missing machine identity, malformed stat, and foreign PID namespace mounts", async () => {
		for (const [path, value] of [
			["/etc/machine-id", ""],
			["/proc/self/stat", stat(99)],
			["/proc/42/stat", "broken"],
			["/proc/sys/kernel/random/boot_id", "boot-123456"],
		] as const) {
			const l = linux();
			l.files[path] = value;
			expect((await l.probe(42)).kind).toBe("unknown");
		}
	});

	it("rejects a domain change during observation", async () => {
		let calls = 0;
		const l = linux({
			readlink: async (path) =>
				path.endsWith("/time") ? "time:[789]" : ++calls === 1 ? "pid:[1]" : "pid:[2]",
		});
		expect((await l.probe(42)).kind).toBe("unknown");
	});

	it("keeps Windows CIM FILETIME strings exact, distinguishes empty from errors", async () => {
		const row = {
			machine,
			boot: "133123456780000000",
			pid: 42,
			found: true,
			birth: "133123456789012345",
		};
		expect(await windows(row)(42)).toEqual({
			kind: "present",
			identity: {
				version: 1,
				pid: 42,
				birth: row.birth,
				domain: {
					platform: "win32",
					machine,
					boot: row.boot,
					pidNamespace: "windows-local-cim",
					timeNamespace: "windows-system",
				},
			},
		});
		expect((await windows({ ...row, found: false, birth: null })(42)).kind).toBe("absent");
		for (const broken of [
			"",
			"CIM access denied",
			{},
			{ ...row, birth: Number("133123456789012345") },
			{ ...row, found: null },
			{ ...row, boot: null },
			{ ...row, machine: "unknown" },
			{ ...row, pid: 43 },
			{ ...row, found: false },
		]) {
			expect((await windows(broken)(42)).kind).toBe("unknown");
		}
		expect(
			(
				await linux({
					platform: "win32",
					windowsQuery: async () => {
						throw new Error("CIM unavailable");
					},
				}).probe(42)
			).kind,
		).toBe("unknown");
	});

	it("unsupported platforms and invalid PIDs are unknown", async () => {
		expect((await linux({ platform: "darwin" }).probe(42)).kind).toBe("unknown");
		for (const pid of [0, -1, 1.5, Number.NaN])
			expect((await linux().probe(pid)).kind).toBe("unknown");
	});

	it("bounds an unresponsive async observation to 1.5 seconds", async () => {
		const probe = linux({ platform: "win32", windowsQuery: () => new Promise(() => {}) }).probe;
		const started = performance.now();
		expect((await probe(42)).kind).toBe("unknown");
		expect(performance.now() - started).toBeLessThan(2200);
	});
});

function fakeChild() {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kills: 0,
		kill() {
			this.kills++;
			return true;
		},
	});
	const spawnChild = (() => child) as unknown as typeof spawn;
	return { child, spawnChild };
}
describe("bounded identity child process", () => {
	it("accepts bounded stdout on successful close", async () => {
		const { child, spawnChild } = fakeChild();
		const result = runWorkspaceIdentityCommand(
			"test",
			[],
			new AbortController().signal,
			spawnChild,
		);
		child.stdout.write("ok");
		child.emit("close", 0);
		expect(await result).toBe("ok");
		expect(child.kills).toBe(0);
	});
	it("caps combined stdout/stderr at 64KiB and stops without waiting for child close", async () => {
		const { child, spawnChild } = fakeChild();
		const result = runWorkspaceIdentityCommand(
			"test",
			[],
			new AbortController().signal,
			spawnChild,
		);
		child.stdout.write(Buffer.alloc(32 * 1024));
		child.stderr.write(Buffer.alloc(32 * 1024 + 1));
		expect(await result).toBeNull();
		expect(child.kills).toBe(1);
	});
	it("a child that never closes is terminated at the hard deadline", async () => {
		const { child, spawnChild } = fakeChild();
		const started = performance.now();
		const result = await runWorkspaceIdentityCommand(
			"test",
			[],
			new AbortController().signal,
			spawnChild,
		);
		expect(result).toBeNull();
		expect(child.kills).toBe(1);
		expect(performance.now() - started).toBeLessThan(2200);
	});

	it("abort and spawn errors are unknown, without inspecting or killing real PIDs", async () => {
		const { child, spawnChild } = fakeChild();
		const abort = new AbortController();
		const result = runWorkspaceIdentityCommand("test", [], abort.signal, spawnChild);
		abort.abort();
		expect(await result).toBeNull();
		expect(child.kills).toBe(1);
		const failed = fakeChild();
		const next = runWorkspaceIdentityCommand(
			"test",
			[],
			new AbortController().signal,
			failed.spawnChild,
		);
		failed.child.emit("error", new Error("missing powershell"));
		expect(await next).toBeNull();
	});
});
