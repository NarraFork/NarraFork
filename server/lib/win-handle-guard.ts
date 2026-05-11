import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { logger } from "./logger";

const IS_WINDOWS = process.platform === "win32";
const HANDLE_FLAG_INHERIT = 0x00000001;
const FIRST_NON_STD_HANDLE = 0x0c;
const HANDLE_STEP = 0x04;
const MAX_HANDLE = 0x10000;

const STD_INPUT_HANDLE = 0xfffffff6;
const STD_OUTPUT_HANDLE = 0xfffffff5;
const STD_ERROR_HANDLE = 0xfffffff4;

type GetStdHandleFn = (stdHandle: number) => Pointer | null;
type SetHandleInformationFn = (handle: Pointer, mask: number, flags: number) => number;

let getStdHandle: GetStdHandleFn | null = null;
let setHandleInformation: SetHandleInformationFn | null = null;
let ffiWarningLogged = false;
let successLogged = false;

if (IS_WINDOWS) {
	try {
		const kernel32 = dlopen("kernel32.dll", {
			GetStdHandle: {
				args: [FFIType.u32],
				returns: FFIType.ptr,
			},
			SetHandleInformation: {
				args: [FFIType.ptr, FFIType.u32, FFIType.u32],
				returns: FFIType.i32,
			},
		} as const);

		getStdHandle = kernel32.symbols.GetStdHandle;
		setHandleInformation = kernel32.symbols.SetHandleInformation;
	} catch (error) {
		ffiWarningLogged = true;
		logger.warn("Windows handle guard unavailable", { error: String(error) });
	}
}

/**
 * Clear HANDLE_FLAG_INHERIT on current Windows process handles after server bind.
 *
 * Bun on Windows can spawn children with bInheritHandles=TRUE. If the HTTP
 * server socket remains inheritable, a child process may keep the listening port
 * open after NarraFork exits. The server socket is created only when Bun.serve()
 * binds/re-binds, so callers should run this once immediately after each
 * successful server bind rather than before every spawn.
 */
export function clearInheritableHandlesAfterServerBind(): void {
	if (!setHandleInformation) return;

	try {
		const stdHandles = new Set<number>();
		if (getStdHandle) {
			for (const stdHandle of [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE]) {
				const handle = getStdHandle(stdHandle);
				if (handle != null) stdHandles.add(handle);
			}
		}

		let candidateHandles = 0;
		let updatedHandles = 0;
		for (let handle = FIRST_NON_STD_HANDLE; handle <= MAX_HANDLE; handle += HANDLE_STEP) {
			if (stdHandles.has(handle)) continue;
			candidateHandles++;
			const result = setHandleInformation(handle as Pointer, HANDLE_FLAG_INHERIT, 0);
			if (result !== 0) updatedHandles++;
		}

		if (!successLogged) {
			successLogged = true;
			logger.info("Windows handle guard completed best-effort handle scan after server bind", {
				candidateHandles,
				updatedHandles,
				maxHandle: MAX_HANDLE,
				skippedStdHandles: stdHandles.size,
			});
		}
	} catch (error) {
		// Best-effort workaround only. Never fail server startup because of FFI guard issues.
		if (!ffiWarningLogged) {
			ffiWarningLogged = true;
			logger.warn("Windows handle guard failed after server bind", { error: String(error) });
		}
	}
}
