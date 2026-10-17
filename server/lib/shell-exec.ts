/**
 * 交给系统 shell 打开 URL / 文件（仅 Windows 分支使用）。
 *
 * 用 ShellExecuteW 而不是 `cmd /c start`：后者会多起一个控制台中间进程，个别时序下即使
 * windowsHide 也会闪一下黑窗。非 Windows 平台返回 false，由调用方沿用 open / xdg-open。
 */

import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";

const SW_SHOWNORMAL = 1;

let shell32:
	| {
			ShellExecuteW: (
				hwnd: Pointer,
				operation: Pointer,
				file: Pointer,
				params: Pointer,
				directory: Pointer,
				show: number,
			) => Pointer;
	  }
	| undefined;

function loadShell32(): typeof shell32 {
	if (shell32) return shell32;
	if (process.platform !== "win32") return undefined;
	try {
		shell32 = dlopen("shell32.dll", {
			ShellExecuteW: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32],
				returns: FFIType.ptr,
			},
		}).symbols as unknown as typeof shell32;
	} catch {
		shell32 = undefined;
	}
	return shell32;
}

/** UTF-16 以 NUL 结尾。返回的 Buffer 必须活过 ShellExecuteW，调用方在调用之后还要引用它。 */
function wide(text: string): { bytes: Buffer; pointer: Pointer } {
	const bytes = Buffer.from(`${text}\0`, "utf16le");
	return { bytes, pointer: ptr(bytes) as Pointer };
}

/** 打开 URL / 文件；返回是否被 shell 受理（返回值 <= 32 皆为错误码）。 */
export function shellExecute(target: string, params?: string): boolean {
	const lib = loadShell32();
	if (!lib) return false;
	const operation = wide("open");
	const file = wide(target);
	const parameters = params === undefined ? undefined : wide(params);
	const result = lib.ShellExecuteW(
		0n as unknown as Pointer,
		operation.pointer,
		file.pointer,
		parameters === undefined ? (null as unknown as Pointer) : parameters.pointer,
		null as unknown as Pointer,
		SW_SHOWNORMAL,
	);
	// 调用返回前保持缓冲可达。ptr() 不持有 Buffer，提前变成垃圾会被下一次分配回收。
	void operation.bytes;
	void file.bytes;
	void parameters?.bytes;
	return Number(result) > 32;
}

/** 在资源管理器中选中文件。explorer 本身就是要显示的窗口，不能走隐藏控制台的启动方式。 */
export function revealInFolder(filePath: string): boolean {
	return shellExecute("explorer.exe", `/select,"${filePath}"`);
}
