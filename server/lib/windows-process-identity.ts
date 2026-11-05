/**
 * Windows process identity through the Win32 API instead of a PowerShell CIM query.
 *
 * The query took 0.9-4 s per call (PowerShell start-up dominates); these calls take under 1 ms.
 * Values are the same ones CIM reports, so identities written by either path compare equal:
 *
 * - birth: `GetProcessTimes` creation time. CIM's `CreationDate` is a WMI datetime with
 *   microsecond precision, so it reaches PowerShell's `ToFileTimeUtc()` with the last
 *   100 ns digit already zero. The raw FILETIME is truncated the same way.
 * - boot: `NtQuerySystemInformation(SystemTimeOfDayInformation).BootTime`, the value
 *   `Win32_OperatingSystem.LastBootUpTime` is derived from, truncated the same way.
 * - machine: `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` from the 64-bit registry view.
 */

import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { win32 } from "node:path";

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** 1970-01-01 as a FILETIME (100 ns intervals since 1601-01-01). */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const MAX_IMAGE_PATH_CHARS = 32_768;
const ERROR_INVALID_PARAMETER = 87;
/** `(HKEY)(ULONG_PTR)(LONG)0x80000002`, sign-extended to 64 bits. */
const HKEY_LOCAL_MACHINE = 0xffffffff80000002n;
const RRF_RT_REG_SZ = 0x2;
/** RRF_SUBKEY_WOW6464KEY: read the 64-bit view even from a 32-bit process. */
const RRF_SUBKEY_WOW6464KEY = 0x10000;
const SYSTEM_TIME_OF_DAY_INFORMATION = 3;
/** BootTime, CurrentTime, TimeZoneBias (3 × LARGE_INTEGER), TimeZoneId, Reserved, BootTimeBias. */
const SYSTEM_TIME_OF_DAY_BYTES = 48;

function load() {
	const kernel32 = dlopen("kernel32.dll", {
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
		GetProcessTimes: {
			args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		QueryFullProcessImageNameW: {
			args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	}).symbols;
	const advapi32 = dlopen("advapi32.dll", {
		RegGetValueW: {
			args: [
				FFIType.u64,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.u32,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
			],
			returns: FFIType.i32,
		},
	}).symbols;
	const ntdll = dlopen("ntdll.dll", {
		NtQuerySystemInformation: {
			args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
			returns: FFIType.i32,
		},
	}).symbols;
	return { kernel32, advapi32, ntdll };
}

let api: ReturnType<typeof load> | undefined;

/** CIM reports microseconds; drop the 100 ns digit so both sources give the same string. */
function toCimFileTime(value: bigint): string | null {
	if (value <= 0n) return null;
	return ((value / 10n) * 10n).toString();
}

function wide(value: string): Buffer {
	return Buffer.from(`${value}\0`, "utf16le");
}

function readMachineGuid(native: ReturnType<typeof load>): string | null {
	const data = Buffer.alloc(256);
	const size = new Uint32Array([data.byteLength]);
	const status = native.advapi32.RegGetValueW(
		HKEY_LOCAL_MACHINE,
		wide("SOFTWARE\\Microsoft\\Cryptography"),
		wide("MachineGuid"),
		RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
		null,
		data,
		size,
	);
	if (status !== 0) return null;
	return data.toString("utf16le", 0, size[0]).replace(/\0+$/, "");
}

function readBootTime(native: ReturnType<typeof load>): string | null {
	const info = new BigUint64Array(SYSTEM_TIME_OF_DAY_BYTES / 8);
	const status = native.ntdll.NtQuerySystemInformation(
		SYSTEM_TIME_OF_DAY_INFORMATION,
		info,
		SYSTEM_TIME_OF_DAY_BYTES,
		null,
	);
	return status === 0 ? toCimFileTime(info[0] ?? 0n) : null;
}

/**
 * `found: false` only when Windows says the pid names no process. Access denied and every other
 * failure throw, so a live process the caller may not open is never reported as gone.
 */
function readBirth(
	native: ReturnType<typeof load>,
	pid: number,
): { found: true; birth: string } | { found: false } {
	const handle = native.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
	if (!handle) {
		const error = native.kernel32.GetLastError();
		if (error === ERROR_INVALID_PARAMETER) return { found: false };
		throw new Error(`OpenProcess failed with ${error}`);
	}
	try {
		const times = new BigUint64Array(4);
		const ok = native.kernel32.GetProcessTimes(
			handle as Pointer,
			times.subarray(0, 1),
			times.subarray(1, 2),
			times.subarray(2, 3),
			times.subarray(3, 4),
		);
		if (!ok) throw new Error(`GetProcessTimes failed with ${native.kernel32.GetLastError()}`);
		const birth = toCimFileTime(times[0] ?? 0n);
		if (!birth) throw new Error("missing birth");
		return { found: true, birth };
	} finally {
		native.kernel32.CloseHandle(handle as Pointer);
	}
}

/**
 * Start time and image name of a pid, for classifying an existing instance lock. `"absent"` when
 * the pid names no process, `null` when it cannot be read (the caller falls back to tasklist).
 */
export function observeWindowsProcess(
	pid: number,
): { startedAtMs: number; imageName: string | null } | "absent" | null {
	if (process.platform !== "win32") return null;
	try {
		api ??= load();
		const handle = api.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
		if (!handle) {
			return api.kernel32.GetLastError() === ERROR_INVALID_PARAMETER ? "absent" : null;
		}
		try {
			const times = new BigUint64Array(4);
			const ok = api.kernel32.GetProcessTimes(
				handle as Pointer,
				times.subarray(0, 1),
				times.subarray(1, 2),
				times.subarray(2, 3),
				times.subarray(3, 4),
			);
			const created = times[0] ?? 0n;
			if (!ok || created <= FILETIME_UNIX_EPOCH) return null;
			const path = Buffer.alloc(MAX_IMAGE_PATH_CHARS * 2);
			const size = new Uint32Array([MAX_IMAGE_PATH_CHARS]);
			const named = api.kernel32.QueryFullProcessImageNameW(handle as Pointer, 0, path, size);
			const image = named ? path.toString("utf16le", 0, (size[0] ?? 0) * 2) : "";
			return {
				startedAtMs: Number((created - FILETIME_UNIX_EPOCH) / 10_000n),
				imageName: image ? win32.basename(image) : null,
			};
		} finally {
			api.kernel32.CloseHandle(handle as Pointer);
		}
	} catch {
		return null;
	}
}

/**
 * The JSON the identity probe parses, in the shape the PowerShell query produced. `null` when
 * any part cannot be read; the probe then reports the identity as unknown.
 */
export function queryWindowsProcessIdentity(pid: number): string | null {
	if (process.platform !== "win32") return null;
	try {
		api ??= load();
		const machine = readMachineGuid(api);
		const boot = readBootTime(api);
		if (!machine || !boot) return null;
		const process = readBirth(api, pid);
		return JSON.stringify({
			machine,
			boot,
			pid,
			found: process.found,
			birth: process.found ? process.birth : null,
		});
	} catch {
		return null;
	}
}

export const __testing = { toCimFileTime };
