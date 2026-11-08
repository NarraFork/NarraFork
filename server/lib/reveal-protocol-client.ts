/**
 * The short-lived `narrafork://reveal/<token>` instance (see reveal-protocol.ts).
 *
 * `server/index.ts` routes here before any server initialization: claim the path from the running
 * server, open Explorer, exit. No settings, database or port.
 */

import { dlopen, FFIType } from "bun:ffi";
import { spawn } from "node:child_process";
import { parseRevealActivation, REVEAL_CLAIM_PATH } from "./reveal-protocol";

const ASFW_ANY = 0xffffffff;
const CLAIM_TIMEOUT_MS = 5_000;

function loadWin32() {
	const kernel32 = dlopen("kernel32.dll", { FreeConsole: { args: [], returns: FFIType.bool } });
	const user32 = dlopen("user32.dll", {
		AllowSetForegroundWindow: { args: [FFIType.u32], returns: FFIType.bool },
	});
	return { ...kernel32.symbols, ...user32.symbols };
}

export async function runRevealProtocolClient(argv: string[]): Promise<void> {
	const win32 = loadWin32();
	// The exe is a console program, so activation gave it a console window; drop it at once.
	win32.FreeConsole();

	const activation = parseRevealActivation(argv);
	if (!activation?.token || !activation.server) return;
	const response = await fetch(
		`${activation.server}${REVEAL_CLAIM_PATH}/${encodeURIComponent(activation.token)}`,
		{
			method: "POST",
			signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
			// A loopback call to the origin the server registered itself; its certificate may be
			// self-signed.
			tls: { rejectUnauthorized: false },
		},
	);
	if (!response.ok) throw new Error(`Reveal token rejected (${response.status})`);
	const { path, selectFile } = (await response.json()) as { path: string; selectFile: boolean };

	// Launched by the foreground browser, this process may set the foreground — but the Explorer
	// window is created by the shell's own process, so pass the right on before launching it.
	win32.AllowSetForegroundWindow(ASFW_ANY);
	await new Promise<void>((resolve, reject) => {
		const child = spawn("explorer", selectFile ? ["/select,", path] : [path], {
			detached: true,
			stdio: "ignore",
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
