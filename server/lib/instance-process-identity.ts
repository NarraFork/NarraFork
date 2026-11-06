import { open, readlink } from "node:fs/promises";

/** Strict instance provenance for cold continuation recovery, separate from startup's fail-open probe. */
export const INSTANCE_PROCESS_PROBE_LIMITS = Object.freeze({ timeoutMs: 1_500, bytes: 64 * 1024 });

export type InstanceProcessDomain = Readonly<{
	platform: "linux" | "win32";
	machine: string;
	boot: string;
	pidNamespace: string;
	/** /proc starttime includes the reader's time-namespace boot offset. */
	timeNamespace: string;
}>;
export type InstanceProcessIdentity = Readonly<{
	version: 1;
	domain: InstanceProcessDomain;
	pid: number;
	/** Linux start ticks or Windows creation time as a UTC FILETIME in µs×10, NEVER JS milliseconds. */
	birth: string;
}>;
export type InstanceProcessObservation =
	| { kind: "present"; identity: InstanceProcessIdentity }
	| { kind: "absent"; domain: InstanceProcessDomain }
	| { kind: "unknown" };

const UNKNOWN = { kind: "unknown" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MACHINE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DIGITS = /^\d{1,24}$/;

export function isInstanceProcessIdentity(value: unknown): value is InstanceProcessIdentity {
	if (!value || typeof value !== "object") return false;
	const v = value as InstanceProcessIdentity;
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

export function sameInstanceProcessDomain(
	a: InstanceProcessDomain,
	b: InstanceProcessDomain,
): boolean {
	return (
		a.platform === b.platform &&
		a.machine === b.machine &&
		a.boot === b.boot &&
		a.pidNamespace === b.pidNamespace &&
		a.timeNamespace === b.timeNamespace
	);
}

export type InstanceProcessEndReason = "pid_absent" | "pid_reused" | "boot_changed";

/** Shared strict comparison; this is a decision helper, not an execution-death capability. */
export function instanceProcessEndReason(
	identity: InstanceProcessIdentity,
	observed: InstanceProcessObservation,
): InstanceProcessEndReason | null {
	if (!isInstanceProcessIdentity(identity) || observed.kind === "unknown") return null;
	const domain = observed.kind === "present" ? observed.identity.domain : observed.domain;
	if (!isInstanceProcessIdentity({ ...identity, domain })) return null;
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
		!sameInstanceProcessDomain(identity.domain, domain)
	)
		return null;
	if (
		observed.kind === "present" &&
		(!isInstanceProcessIdentity(observed.identity) ||
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
		const bytes = Buffer.alloc(INSTANCE_PROCESS_PROBE_LIMITS.bytes + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const result = await file.read(bytes, offset, bytes.length - offset, null);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		if (offset > INSTANCE_PROCESS_PROBE_LIMITS.bytes) throw new Error("identity input too large");
		return bytes.subarray(0, offset).toString("utf8");
	} finally {
		await file.close();
	}
}

export interface InstanceProcessProbeDependencies {
	platform: NodeJS.Platform;
	selfPid: number;
	read(path: string): Promise<string>;
	readlink(path: string): Promise<string>;
	/** Only signal 0; EPERM and all failures except ESRCH are unknown. */
	checkPid(pid: number): "present" | "absent" | "unknown";
	windowsQuery(pid: number): Promise<string | null>;
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

/** Win32 API calls, imported only on Windows (see windows-process-identity.ts). */
async function windowsQuery(pid: number): Promise<string | null> {
	const { queryWindowsProcessIdentity } = await import("./windows-process-identity");
	return queryWindowsProcessIdentity(pid);
}

const defaults: InstanceProcessProbeDependencies = {
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
export function createInstanceProcessProbe(deps: InstanceProcessProbeDependencies = defaults) {
	async function observe(pid: number, signal: AbortSignal): Promise<InstanceProcessObservation> {
		if (!Number.isSafeInteger(pid) || pid <= 0) return UNKNOWN;
		if (deps.platform === "linux") {
			const domain = async (): Promise<InstanceProcessDomain> => {
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
			if (signal.aborted || !sameInstanceProcessDomain(before, await domain())) return UNKNOWN;
			const identity = { version: 1 as const, domain: before, pid, birth: birth ?? "1" };
			if (!isInstanceProcessIdentity(identity)) return UNKNOWN;
			return birth === null ? { kind: "absent", domain: before } : { kind: "present", identity };
		}
		if (deps.platform === "win32") {
			const raw = await deps.windowsQuery(pid);
			if (!raw || Buffer.byteLength(raw) > INSTANCE_PROCESS_PROBE_LIMITS.bytes) return UNKNOWN;
			const value = JSON.parse(raw);
			if (value.pid !== pid || typeof value.found !== "boolean") return UNKNOWN;
			const domain: InstanceProcessDomain = {
				platform: "win32",
				machine: typeof value.machine === "string" ? value.machine.toLowerCase() : "",
				boot: value.boot,
				pidNamespace: "windows-local-cim",
				timeNamespace: "windows-system",
			};
			const identity = { version: 1 as const, domain, pid, birth: value.found ? value.birth : "1" };
			if (!isInstanceProcessIdentity(identity) || (!value.found && value.birth !== null))
				return UNKNOWN;
			return value.found ? { kind: "present", identity } : { kind: "absent", domain };
		}
		return UNKNOWN;
	}
	return async (pid: number): Promise<InstanceProcessObservation> => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<InstanceProcessObservation>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve(UNKNOWN);
			}, INSTANCE_PROCESS_PROBE_LIMITS.timeoutMs);
		});
		try {
			return await Promise.race([observe(pid, controller.signal).catch(() => UNKNOWN), timeout]);
		} finally {
			clearTimeout(timer);
		}
	};
}

export const observeInstanceProcess = createInstanceProcessProbe();
