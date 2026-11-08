/**
 * Put this process in a Windows Job Object so shutdown can end the whole child tree at once.
 *
 * This replaces the wmic descendant walk (wmic is no longer shipped on recent Windows, where
 * that cleanup silently found nothing). Assigning THIS process, once at startup, is what makes
 * it race-free: every child spawned afterwards is born into the job, and so is anything those
 * children spawn. Assigning each child after `Bun.spawn` instead does NOT work — a shell that
 * runs its profile can create a grandchild before `AssignProcessToJobObject` executes, and that
 * grandchild stays outside the job (reproduced on Windows 11).
 *
 * Flags:
 * - NOT `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: during update handoff the children (terminals,
 *   agent shells, MCP servers) are meant to outlive this process, and that flag would kill them
 *   on every update. Cleanup runs where the old wmic kill ran and is skipped on handoff, so a
 *   crashed process still leaves children behind, exactly as before — this change is about the
 *   cleanup working at all without wmic, not a new lifetime policy.
 * - `JOB_OBJECT_LIMIT_BREAKAWAY_OK`: a child that asks for `CREATE_BREAKAWAY_FROM_JOB` (browsers
 *   do this for their sandboxed helpers) must still be able to start. Such children opt out of
 *   the cleanup, which is fine — they are applications, not tool shells.
 *
 * Best effort: if the job cannot be created, startup continues and the caller's own fallback
 * (the wmic walk) is all that remains. Nothing here may break a spawn.
 */

import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { hotOnce } from "./hot-safe";
import { logger } from "./logger";

const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0000_0800;

interface Kernel32 {
	CreateJobObjectW(securityAttributes: null, name: null): Pointer | null;
	SetInformationJobObject(job: Pointer, infoClass: number, info: Pointer, length: number): number;
	QueryInformationJobObject(
		job: Pointer,
		infoClass: number,
		info: Pointer,
		length: number,
		returnLength: Pointer,
	): number;
	OpenProcess(access: number, inheritHandle: number, pid: number): Pointer | null;
	AssignProcessToJobObject(job: Pointer, process: Pointer): number;
	TerminateProcess(process: Pointer, exitCode: number): number;
	CloseHandle(handle: Pointer): number;
	GetLastError(): number;
}

let kernel32: Kernel32 | undefined;
let job: Pointer | null | undefined;
let unavailableReason: string | undefined;

function load(): Kernel32 {
	return (
		dlopen("kernel32.dll", {
			CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			SetInformationJobObject: {
				args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
				returns: FFIType.i32,
			},
			QueryInformationJobObject: {
				args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
				returns: FFIType.i32,
			},
			OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
			AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
			GetLastError: { args: [], returns: FFIType.u32 },
		}) as unknown as { symbols: Kernel32 }
	).symbols;
}

/**
 * JOBOBJECT_EXTENDED_LIMIT_INFORMATION, 144 bytes on 64-bit Windows 11 (measured: any other
 * size makes SetInformationJobObject fail with ERROR_BAD_LENGTH). Its first field is the basic
 * limit information, whose LimitFlags sits at offset 16; everything else stays zero, meaning no
 * other limits.
 */
const LIMIT_FLAGS_OFFSET = 16;
const EXTENDED_LIMIT_INFORMATION_BYTES = 144;

/**
 * Create the job and put this process in it. Call once, before the first child is spawned
 * (children born earlier cannot be adopted retroactively). Safe to call again on hot reload.
 * Returns whether this process is now in a job.
 */
export function initWindowsChildJob(): boolean {
	if (process.platform !== "win32") return false;
	if (!hotOnce("narrafork.windowsChildJob")) return job != null;
	try {
		kernel32 ??= load();
		const handle = kernel32.CreateJobObjectW(null, null);
		if (!handle) throw new Error(`CreateJobObjectW failed with ${kernel32.GetLastError()}`);
		const info = Buffer.alloc(EXTENDED_LIMIT_INFORMATION_BYTES);
		info.writeUInt32LE(JOB_OBJECT_LIMIT_BREAKAWAY_OK, LIMIT_FLAGS_OFFSET);
		// JobObjectExtendedLimitInformation = 9.
		if (!kernel32.SetInformationJobObject(handle, 9, info as unknown as Pointer, info.byteLength)) {
			throw new Error(`SetInformationJobObject failed with ${kernel32.GetLastError()}`);
		}
		const self = kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, process.pid);
		if (!self) throw new Error(`OpenProcess(self) failed with ${kernel32.GetLastError()}`);
		try {
			if (!kernel32.AssignProcessToJobObject(handle, self)) {
				throw new Error(`AssignProcessToJobObject failed with ${kernel32.GetLastError()}`);
			}
		} finally {
			kernel32.CloseHandle(self);
		}
		job = handle;
		logger.info("Windows child-process job created for this process");
		return true;
	} catch (error) {
		unavailableReason = String(error);
		logger.warn("Windows child-process job unavailable; using the wmic fallback on shutdown", {
			reason: unavailableReason,
		});
		return false;
	}
}

/**
 * JobObjectBasicProcessIdList = 3: two DWORD counts followed by that many ULONG_PTR pids.
 * (Measured on Windows 11; class 3 also happens to be the only list-style query.)
 */
const BASIC_PROCESS_ID_LIST = 3;
const PID_LIST_HEADER_BYTES = 8;
const MAX_TRACKED_PROCESSES = 8192;

function jobProcessIds(native: Kernel32, handle: Pointer): number[] {
	const size = PID_LIST_HEADER_BYTES + MAX_TRACKED_PROCESSES * 8;
	const buffer = Buffer.alloc(size);
	const returnLength = new Uint32Array(1);
	if (
		!native.QueryInformationJobObject(
			handle,
			BASIC_PROCESS_ID_LIST,
			buffer as unknown as Pointer,
			size,
			returnLength as unknown as Pointer,
		)
	) {
		throw new Error(`QueryInformationJobObject failed with ${native.GetLastError()}`);
	}
	const count = buffer.readUInt32LE(4);
	const pids: number[] = [];
	for (let i = 0; i < Math.min(count, MAX_TRACKED_PROCESSES); i++) {
		pids.push(Number(buffer.readBigUInt64LE(PID_LIST_HEADER_BYTES + i * 8)));
	}
	return pids;
}

/**
 * End this process' children and their descendants, WITHOUT ending this process.
 *
 * `TerminateJobObject` would also kill the caller now that the caller is in the job, cutting
 * the remaining shutdown steps (clean-shutdown marker, lock release, log flush). So the job's
 * own process list is walked instead and each other pid is terminated. Returns whether a job
 * existed; `false` means the caller's own fallback is all that is left. Skipped on update
 * handoff, where the children are meant to keep running for the replacement process.
 */
export function terminateWindowsChildren(): boolean {
	if (!job || !kernel32) return false;
	try {
		const pids = jobProcessIds(kernel32, job);
		let terminated = 0;
		for (const pid of pids) {
			if (pid === process.pid) continue;
			const child = kernel32.OpenProcess(PROCESS_TERMINATE, 0, pid);
			if (!child) continue; // Already gone.
			if (kernel32.TerminateProcess(child, 1)) terminated++;
			kernel32.CloseHandle(child);
		}
		logger.info("Terminated Windows child processes through the job object", {
			listed: pids.length,
			terminated,
		});
		return true;
	} catch (error) {
		logger.warn("Could not end the Windows child-process job's members; using the wmic fallback", {
			error: String(error),
		});
		return false;
	}
}

export const __testing = {
	get available() {
		return job != null;
	},
	get unavailableReason() {
		return unavailableReason;
	},
};
