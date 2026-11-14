import { dlopen, FFIType, type Pointer } from "bun:ffi";

interface WindowsReplacementOptions {
	execPath: string;
	args: readonly string[];
	cwd: string;
	env: Record<string, string | undefined>;
}

interface WindowsProcessApi {
	CreateProcessW(
		application: Buffer,
		commandLine: Buffer,
		processAttributes: null,
		threadAttributes: null,
		inheritHandles: number,
		flags: number,
		environment: Buffer,
		cwd: Buffer,
		startupInfo: Buffer,
		processInfo: Buffer,
	): number;
	CloseHandle(handle: Pointer): number;
	GetLastError(): number;
}

let kernel32: WindowsProcessApi | undefined;
function load(): WindowsProcessApi {
	kernel32 ??= dlopen("kernel32.dll", {
		CreateProcessW: {
			args: [
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.i32,
				FFIType.u32,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
			],
			returns: FFIType.i32,
		},
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	}).symbols as unknown as WindowsProcessApi;
	return kernel32;
}

function wide(value: string): Buffer {
	if (value.includes("\0")) throw new Error("NUL in Windows replacement process input");
	return Buffer.from(`${value}\0`, "utf16le");
}

// Windows CRT argv quoting, not cmd escaping: shell metacharacters stay literal.
function quote(value: string): string {
	return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function environmentBlock(env: WindowsReplacementOptions["env"]): Buffer {
	const entries = new Map<string, string>();
	let chars = 2;
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (
			!name ||
			name.includes("\0") ||
			value.includes("\0") ||
			(name.includes("=") && !/^=[a-z]:$/i.test(name))
		) {
			throw new Error("Invalid Windows replacement environment");
		}
		chars += name.length + value.length + 2;
		// Bound preparation even if an unexpectedly large environment reaches this path.
		if (chars > 512 * 1024) throw new Error("Windows replacement environment exceeds 1 MiB");
		entries.set(name.toUpperCase(), `${name}=${value}`);
	}
	const values = [...entries]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, value]) => value);
	return Buffer.from(`${values.join("\0")}\0\0`, "utf16le");
}

/**
 * Only the update successor escapes the server's nested Windows jobs. Bun detached
 * alone does not request CREATE_BREAKAWAY_FROM_JOB and still inherits our child job.
 * Native creation errors propagate before requesting old-server shutdown, without
 * falling back to the unsafe launcher. Third-party outer jobs can still constrain
 * the successor: this escapes our jobs, not arbitrary host lifetime policies.
 */
export function spawnWindowsReplacementProcess(
	options: WindowsReplacementOptions,
	native?: WindowsProcessApi,
): number {
	const application = wide(options.execPath);
	const command = [options.execPath, ...options.args].map(quote).join(" ");
	if (command.length >= 32_767) throw new Error("Windows replacement command line is too long");
	const commandLine = wide(command); // CreateProcessW may mutate this buffer.
	const cwd = wide(options.cwd);
	const environment = environmentBlock(options.env);
	// Both Windows architectures are 64-bit: STARTUPINFOW=104, PROCESS_INFORMATION=24.
	const startupInfo = Buffer.alloc(104);
	startupInfo.writeUInt32LE(104, 0);
	startupInfo.writeUInt32LE(1, 60); // STARTF_USESHOWWINDOW; wShowWindow remains SW_HIDE.
	const processInfo = Buffer.alloc(24);
	const api = native ?? load();
	const flags = 0x01000000 | 0x00000400 | 0x00000200 | 0x00000008;
	// BREAKAWAY_FROM_JOB | UNICODE_ENVIRONMENT | NEW_PROCESS_GROUP | DETACHED_PROCESS.
	if (
		!api.CreateProcessW(
			application,
			commandLine,
			null,
			null,
			0,
			flags,
			environment,
			cwd,
			startupInfo,
			processInfo,
		)
	) {
		throw new Error(`Windows replacement CreateProcessW failed (win32=${api.GetLastError()})`);
	}
	try {
		return processInfo.readUInt32LE(16);
	} finally {
		// No inherited stdio/job handles and no live parent-side handle/ref to keep the old
		// manager alive. Closing these handles does not terminate the replacement.
		api.CloseHandle(Number(processInfo.readBigUInt64LE(8)) as Pointer);
		api.CloseHandle(Number(processInfo.readBigUInt64LE(0)) as Pointer);
	}
}
