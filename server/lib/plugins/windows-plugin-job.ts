import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";

/** Plugin-local jobs never use the server's global, breakaway-enabled child job. */
export interface WindowsPluginJobNative {
	create(name: string): Pointer;
	open(name: string): Pointer;
	assignCurrent(job: Pointer): void;
	terminate(job: Pointer): void;
	activeProcesses(job: Pointer): number;
	close(job: Pointer): void;
}

interface Kernel32 {
	CreateJobObjectW(attributes: null, name: Pointer): Pointer | null;
	OpenJobObjectW(access: number, inherit: number, name: Pointer): Pointer | null;
	SetInformationJobObject(job: Pointer, kind: number, info: Pointer, size: number): number;
	QueryInformationJobObject(
		job: Pointer,
		kind: number,
		info: Pointer,
		size: number,
		returned: null,
	): number;
	OpenProcess(access: number, inherit: number, pid: number): Pointer | null;
	AssignProcessToJobObject(job: Pointer, process: Pointer): number;
	TerminateJobObject(job: Pointer, code: number): number;
	CloseHandle(handle: Pointer): number;
	GetLastError(): number;
}

// Microsoft winnt.h: EXTENDED_LIMIT_INFORMATION on Windows' 64-bit ABI is 144
// bytes; BasicLimitInformation.LimitFlags follows two LARGE_INTEGERs (offset 16).
// BASIC_ACCOUNTING_INFORMATION is four LARGE_INTEGERs and four DWORDs (48 bytes),
// with ActiveProcesses at offset 40. x64 and ARM64 share this Windows ABI.
// https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information
// https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information
const EXTENDED_LIMIT_BYTES = 144;
const BASIC_ACCOUNTING_BYTES = 48;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_ASSIGN_PROCESS = 0x0001;
const PROCESS_SET_QUOTA_AND_TERMINATE = 0x0101;
const ERROR_ALREADY_EXISTS = 183;

export function validWindowsPluginJobName(name: string): boolean {
	return /^Local\\NarraForkPlugin-[a-f0-9-]{36}$/.test(name);
}

let native: WindowsPluginJobNative | undefined;

/** Lazy: importing the worker entry on another platform must not load a DLL. */
export function windowsPluginJobNative(): WindowsPluginJobNative {
	if (native) return native;
	if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
		throw new Error("Plugin Windows job unavailable");
	}
	let api: Kernel32;
	try {
		api = dlopen("kernel32.dll", {
			CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			OpenJobObjectW: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
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
			TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
			GetLastError: { args: [], returns: FFIType.u32 },
		}).symbols as unknown as Kernel32;
	} catch {
		throw new Error("Plugin Windows job unavailable");
	}
	const close = (handle: Pointer) => {
		if (!api.CloseHandle(handle)) throw new Error("Plugin Windows job handle close failed");
	};
	native = {
		create(name) {
			if (!validWindowsPluginJobName(name)) throw new Error("Invalid plugin Windows job");
			const wideName = Buffer.from(`${name}\0`, "utf16le");
			const job = api.CreateJobObjectW(null, ptr(wideName));
			if (!job) throw new Error("Plugin Windows job creation failed");
			// Never adopt an existing job with unknown ownership or limits.
			if (api.GetLastError() === ERROR_ALREADY_EXISTS) {
				close(job);
				throw new Error("Plugin Windows job already exists");
			}
			const limits = Buffer.alloc(EXTENDED_LIMIT_BYTES);
			// No BREAKAWAY_OK or SILENT_BREAKAWAY_OK: every descendant stays owned.
			limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
			if (!api.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength)) {
				close(job); // Still empty: no launcher or plugin has been spawned.
				throw new Error("Plugin Windows job configuration failed");
			}
			return job;
		},
		open(name) {
			if (!validWindowsPluginJobName(name)) throw new Error("Invalid plugin Windows job");
			const wideName = Buffer.from(`${name}\0`, "utf16le");
			const job = api.OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS, 0, ptr(wideName));
			if (!job) throw new Error("Plugin Windows job open failed");
			return job;
		},
		assignCurrent(job) {
			const self = api.OpenProcess(PROCESS_SET_QUOTA_AND_TERMINATE, 0, process.pid);
			if (!self) throw new Error("Plugin Windows launcher process open failed");
			try {
				if (!api.AssignProcessToJobObject(job, self)) {
					throw new Error("Plugin Windows launcher assignment failed");
				}
			} finally {
				close(self);
			}
		},
		terminate(job) {
			if (!api.TerminateJobObject(job, 1)) {
				throw new Error("Plugin Windows job termination failed");
			}
		},
		activeProcesses(job) {
			const accounting = Buffer.alloc(BASIC_ACCOUNTING_BYTES);
			if (!api.QueryInformationJobObject(job, 1, ptr(accounting), accounting.byteLength, null)) {
				throw new Error("Plugin Windows job query failed");
			}
			return accounting.readUInt32LE(40);
		},
		close,
	};
	return native;
}
