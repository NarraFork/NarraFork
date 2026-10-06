import { spawn } from "node:child_process";
import { open, readlink } from "node:fs/promises";
import { win32 } from "node:path";

/** Not the fail-open startup lock probe. No image-name or wall-clock tolerances. */
export const WORKSPACE_PROCESS_PROBE_LIMITS = Object.freeze({ timeoutMs: 1_500, bytes: 64 * 1024 });

export type WorkspaceProcessDomain = Readonly<{
	platform: "linux" | "win32";
	machine: string;
	boot: string;
	pidNamespace: string;
	/** /proc starttime includes the reader's time-namespace boot offset. */
	timeNamespace: string;
}>;
export type WorkspaceProcessIdentity = Readonly<{
	version: 1;
	domain: WorkspaceProcessDomain;
	pid: number;
	/** Linux start ticks or Windows CIM CreationDate UTC FILETIME, NEVER JS milliseconds. */
	birth: string;
}>;
export type WorkspaceProcessObservation =
	| { kind: "present"; identity: WorkspaceProcessIdentity }
	| { kind: "absent"; domain: WorkspaceProcessDomain }
	| { kind: "unknown" };

const UNKNOWN = { kind: "unknown" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MACHINE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DIGITS = /^\d{1,24}$/;

export function isWorkspaceProcessIdentity(value: unknown): value is WorkspaceProcessIdentity {
	if (!value || typeof value !== "object") return false;
	const v = value as WorkspaceProcessIdentity;
	const d = v.domain;
	return (
		v.version === 1 &&
		Number.isSafeInteger(v.pid) &&
		v.pid > 0 &&
		typeof v.birth === "string" &&
		DIGITS.test(v.birth) &&
		v.birth !== "0" &&
		!!d &&
		typeof d.machine === "string" &&
		MACHINE.test(d.machine) &&
		!/^0+$/.test(d.machine.replaceAll("-", "")) &&
		typeof d.boot === "string" &&
		!/^0+$/.test(d.boot.replaceAll("-", "")) &&
		((d.platform === "linux" &&
			UUID.test(d.boot) &&
			/^pid:\[\d+\]$/.test(d.pidNamespace) &&
			/^time:\[\d+\]$/.test(d.timeNamespace)) ||
			(d.platform === "win32" &&
				DIGITS.test(d.boot) &&
				d.pidNamespace === "windows-local-cim" &&
				d.timeNamespace === "windows-system"))
	);
}

export function sameWorkspaceProcessDomain(
	a: WorkspaceProcessDomain,
	b: WorkspaceProcessDomain,
): boolean {
	return (
		a.platform === b.platform &&
		a.machine === b.machine &&
		a.boot === b.boot &&
		a.pidNamespace === b.pidNamespace &&
		a.timeNamespace === b.timeNamespace
	);
}

export type WorkspaceProcessEndReason = "pid_absent" | "pid_reused" | "boot_changed";

/** Shared strict comparison; this is a decision helper, not an execution-death capability. */
export function workspaceProcessEndReason(
	identity: WorkspaceProcessIdentity,
	observed: WorkspaceProcessObservation,
): WorkspaceProcessEndReason | null {
	if (!isWorkspaceProcessIdentity(identity) || observed.kind === "unknown") return null;
	const domain = observed.kind === "present" ? observed.identity.domain : observed.domain;
	if (!isWorkspaceProcessIdentity({ ...identity, domain })) return null;
	const changedLinuxBoot =
		identity.domain.platform === "linux" &&
		domain.platform === "linux" &&
		identity.domain.machine === domain.machine &&
		identity.domain.pidNamespace === domain.pidNamespace &&
		identity.domain.timeNamespace === domain.timeNamespace &&
		identity.domain.boot !== domain.boot;
	// Windows LastBootUpTime is a wall-clock value, not a boot nonce. A changed
	// value alone cannot prove death, but must not hide a positively absent or
	// replaced PID on the same machine. Still compare exact CreationDate below.
	const sameWindowsMachine =
		identity.domain.platform === "win32" &&
		domain.platform === "win32" &&
		identity.domain.machine === domain.machine &&
		identity.domain.pidNamespace === domain.pidNamespace &&
		identity.domain.timeNamespace === domain.timeNamespace;
	if (
		!changedLinuxBoot &&
		!sameWindowsMachine &&
		!sameWorkspaceProcessDomain(identity.domain, domain)
	)
		return null;
	if (
		observed.kind === "present" &&
		(!isWorkspaceProcessIdentity(observed.identity) ||
			observed.identity.pid !== identity.pid ||
			(!changedLinuxBoot && observed.identity.birth === identity.birth))
	)
		return null;
	return changedLinuxBoot
		? "boot_changed"
		: observed.kind === "absent"
			? "pid_absent"
			: "pid_reused";
}

/** Proc files commonly report size=0; bound actual bytes rather than trusting stat.size. */
async function readBounded(path: string): Promise<string> {
	const file = await open(path, "r");
	try {
		const bytes = Buffer.alloc(WORKSPACE_PROCESS_PROBE_LIMITS.bytes + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const result = await file.read(bytes, offset, bytes.length - offset, null);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		if (offset > WORKSPACE_PROCESS_PROBE_LIMITS.bytes) throw new Error("identity input too large");
		return bytes.subarray(0, offset).toString("utf8");
	} finally {
		await file.close();
	}
}

/** Combined stdout/stderr hard cap. Timeout resolves immediately, not after a child's close. */
export function runWorkspaceIdentityCommand(
	command: string,
	args: string[],
	signal: AbortSignal,
	spawnChild: typeof spawn = spawn,
): Promise<string | null> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve(null);
		let child: ReturnType<typeof spawn>;
		try {
			child = spawnChild(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		} catch {
			return resolve(null);
		}
		let done = false;
		let total = 0;
		const output: Buffer[] = [];
		const finish = (result: string | null, terminate = false) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (terminate) {
				try {
					child.kill();
				} catch {
					/* Already exited. */
				}
				child.stdout?.destroy();
				child.stderr?.destroy();
			}
			resolve(result);
		};
		const abort = () => finish(null, true);
		const timer = setTimeout(abort, WORKSPACE_PROCESS_PROBE_LIMITS.timeoutMs);
		signal.addEventListener("abort", abort, { once: true });
		const receive = (chunk: Buffer | string, stdout: boolean) => {
			if (done) return;
			const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += data.length;
			if (total > WORKSPACE_PROCESS_PROBE_LIMITS.bytes) return finish(null, true);
			if (stdout) output.push(data);
		};
		child.stdout?.on("data", (chunk) => receive(chunk, true));
		child.stderr?.on("data", (chunk) => receive(chunk, false));
		child.once("error", () => finish(null, true));
		child.once("close", (code) =>
			finish(code === 0 ? Buffer.concat(output).toString("utf8") : null),
		);
	});
}

export interface WorkspaceProcessProbeDependencies {
	platform: NodeJS.Platform;
	selfPid: number;
	read(path: string): Promise<string>;
	readlink(path: string): Promise<string>;
	/** Only signal 0; EPERM and all failures except ESRCH are unknown. */
	checkPid(pid: number): "present" | "absent" | "unknown";
	windowsQuery(pid: number, signal: AbortSignal): Promise<string | null>;
}

function parseStat(raw: string): { pid: number; birth: string } | null {
	const first = /^(\d+) \(/.exec(raw);
	const end = raw.lastIndexOf(")");
	if (!first || end < 0) return null;
	const fields = raw
		.slice(end + 1)
		.trim()
		.split(/\s+/);
	const birth = fields[19];
	if (!birth || !DIGITS.test(birth) || birth === "0") return null;
	return { pid: Number(first[1]), birth };
}

async function windowsQuery(pid: number, signal: AbortSignal): Promise<string | null> {
	const root = process.env.SystemRoot;
	if (!root || !win32.isAbsolute(root)) return null;
	// CreationDate and LastBootUpTime stay exact decimal strings, with no JS floating-point loss.
	// ErrorAction=Stop distinguishes failed CIM access from a successful empty process result.
	const script = `$ErrorActionPreference='Stop'; $m=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid; $o=Get-CimInstance Win32_OperatingSystem -ErrorAction Stop; $p=@(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop); if($p.Count -gt 1){throw 'ambiguous process'}; $b=$null; if($p.Count -eq 1){if($null -eq $p[0].CreationDate){throw 'missing birth'}; $b=$p[0].CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}; @{machine=$m; boot=$o.LastBootUpTime.ToUniversalTime().ToFileTimeUtc().ToString(); pid=${pid}; found=($p.Count -eq 1); birth=$b} | ConvertTo-Json -Compress`;
	return runWorkspaceIdentityCommand(
		win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
		signal,
	);
}

const defaults: WorkspaceProcessProbeDependencies = {
	platform: process.platform,
	selfPid: process.pid,
	read: readBounded,
	readlink,
	checkPid(pid) {
		try {
			process.kill(pid, 0);
			return "present";
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown";
		}
	},
	windowsQuery,
};

/** Dependency injection is for tests; production uses only local OS observations. */
export function createWorkspaceProcessProbe(deps: WorkspaceProcessProbeDependencies = defaults) {
	async function observe(pid: number, signal: AbortSignal): Promise<WorkspaceProcessObservation> {
		if (!Number.isSafeInteger(pid) || pid <= 0) return UNKNOWN;
		if (deps.platform === "linux") {
			const domain = async (): Promise<WorkspaceProcessDomain> => {
				const [machine, boot, pidNamespace, self, timeNamespace] = await Promise.all([
					deps.read("/etc/machine-id"),
					deps.read("/proc/sys/kernel/random/boot_id"),
					deps.readlink("/proc/self/ns/pid"),
					deps.read("/proc/self/stat"),
					deps.readlink("/proc/self/ns/time"),
				]);
				// A procfs mounted from another PID namespace must not attest this namespace.
				if (parseStat(self)?.pid !== deps.selfPid) throw new Error("foreign procfs");
				return {
					platform: "linux",
					machine: machine.trim().toLowerCase(),
					boot: boot.trim().toLowerCase(),
					pidNamespace,
					timeNamespace,
				};
			};
			const before = await domain();
			let birth: string | null = null;
			try {
				const stat = parseStat(await deps.read(`/proc/${pid}/stat`));
				if (!stat || stat.pid !== pid) return UNKNOWN;
				birth = stat.birth;
			} catch (error) {
				// hidepid can make a live process ENOENT; require kernel ESRCH as well.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || deps.checkPid(pid) !== "absent")
					return UNKNOWN;
			}
			if (signal.aborted || !sameWorkspaceProcessDomain(before, await domain())) return UNKNOWN;
			const identity = { version: 1 as const, domain: before, pid, birth: birth ?? "1" };
			if (!isWorkspaceProcessIdentity(identity)) return UNKNOWN;
			return birth === null ? { kind: "absent", domain: before } : { kind: "present", identity };
		}
		if (deps.platform === "win32") {
			const raw = await deps.windowsQuery(pid, signal);
			if (!raw || Buffer.byteLength(raw) > WORKSPACE_PROCESS_PROBE_LIMITS.bytes) return UNKNOWN;
			const value = JSON.parse(raw);
			if (value.pid !== pid || typeof value.found !== "boolean") return UNKNOWN;
			const domain: WorkspaceProcessDomain = {
				platform: "win32",
				machine: typeof value.machine === "string" ? value.machine.toLowerCase() : "",
				boot: value.boot,
				pidNamespace: "windows-local-cim",
				timeNamespace: "windows-system",
			};
			const identity = { version: 1 as const, domain, pid, birth: value.found ? value.birth : "1" };
			if (!isWorkspaceProcessIdentity(identity) || (!value.found && value.birth !== null))
				return UNKNOWN;
			return value.found ? { kind: "present", identity } : { kind: "absent", domain };
		}
		return UNKNOWN;
	}
	return async (pid: number): Promise<WorkspaceProcessObservation> => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<WorkspaceProcessObservation>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve(UNKNOWN);
			}, WORKSPACE_PROCESS_PROBE_LIMITS.timeoutMs);
		});
		try {
			return await Promise.race([observe(pid, controller.signal).catch(() => UNKNOWN), timeout]);
		} finally {
			clearTimeout(timer);
		}
	};
}

export const observeWorkspaceProcess = createWorkspaceProcessProbe();
