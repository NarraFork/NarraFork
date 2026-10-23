/** Remote terminal runtime: kill acknowledgements never stand in for process wait evidence. */
import type { NativePathDescriptorV2 } from "@shared/target-native-path";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	sendRpc as defaultSendRpc,
	type SendRpcOptions,
} from "../services/device-connection-service";
import type { TerminalRuntime, TerminalSpawnOptions } from "./runtime";

export const REMOTE_PTY_READY_FEATURE = "pty.ready-stream.v1";
export const REMOTE_PTY_CONPTY_FEATURE = "pty.conpty.v1";
export const REMOTE_PTY_LIFECYCLE_FEATURE = "pty.lifecycle-evidence.v1";
export const REMOTE_PTY_BOUNDED_IO_FEATURE = "pty.bounded-io.v1";
const MAX_INPUT_CHUNK_BYTES = 64 * 1024;
const MAX_OUTPUT_CHUNK_BYTES = 32 * 1024;

type SendRpc = (
	deviceId: string,
	method: Parameters<typeof defaultSendRpc>[1],
	params: Record<string, unknown>,
	opts?: SendRpcOptions,
) => Promise<unknown>;
type InputAuthority = () => Promise<unknown>;

export interface RemotePtyDependencies {
	sendRpc?: SendRpc;
	readyTimeoutMs?: number;
	closeTimeoutMs?: number;
	maxQueuedWriteBytes?: number;
	/** Required for native Windows; missing legacy fields are never positive proof. */
	requireLifecycleEvidence?: boolean;
	/** Revalidate original creator/binding for non-WS writes at actual dispatch. */
	beforeInput?: InputAuthority;
	/** Narrator-linked publishers require a real request-bound synchronous final proof. */
	requireInputAuthorityProof?: boolean;
	onFailure?: (error: Error) => void;
	/** Original selected directory identity, never minted from current cwd later. */
	expectedNativeDescriptor?: NativePathDescriptorV2;
}
export interface RemoteTerminalRuntime extends TerminalRuntime {
	/** The queued request keeps its own actor, not the creator or newest writer. */
	writeAuthorized(data: string | Uint8Array, authority: InputAuthority): void;
	resizeAuthorized(cols: number, rows: number, authority: InputAuthority): void;
}

export function spawnRemotePty(
	deviceId: string,
	opts: TerminalSpawnOptions,
	deps: RemotePtyDependencies = {},
): RemoteTerminalRuntime {
	const sendRpc = deps.sendRpc ?? defaultSendRpc;
	const readyTimeoutMs = deps.readyTimeoutMs ?? 15_000;
	const closeTimeoutMs = deps.closeTimeoutMs ?? 10_000;
	const maxQueuedWriteBytes = deps.maxQueuedWriteBytes ?? 1024 * 1024;
	const ptyId = `pty_${generateId()}`;
	const abort = new AbortController();
	let exitedResolve: (code: number | null) => void = () => {};
	const exitedPromise = new Promise<number | null>((resolve) => {
		exitedResolve = resolve;
	});
	let readyResolve: () => void = () => {};
	let readyReject: (error: Error) => void = () => {};
	const readyPromise = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	let exited = false;
	let ready = false;
	let readySettled = false;
	let closing = false;
	let pumping = false;
	const queuedWrites: { bytes: Uint8Array; authority?: InputAuthority }[] = [];
	let queuedWriteBytes = 0;
	let queuedResize: { cols: number; rows: number; authority?: InputAuthority } | null = null;
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(opts.env)) if (value !== undefined) env[key] = value;
	const decoder = new TextDecoder();
	let readyTimer: ReturnType<typeof setTimeout> | null = null;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;
	const clearReadyTimer = () => {
		if (readyTimer) clearTimeout(readyTimer);
		readyTimer = null;
	};
	const clearQueuedInput = () => {
		queuedWrites.length = 0;
		queuedWriteBytes = 0;
		queuedResize = null;
	};
	const rejectReady = (error: Error) => {
		if (readySettled) return;
		readySettled = true;
		clearReadyTimer();
		readyReject(error);
	};
	const finishExited = (code: number | null, readyError?: Error) => {
		if (exited) return;
		exited = true;
		clearReadyTimer();
		if (closeTimer) clearTimeout(closeTimer);
		closeTimer = null;
		clearQueuedInput();
		if (!ready) rejectReady(readyError ?? new Error("Remote PTY exited before becoming ready"));
		const tail = decoder.decode();
		if (tail) opts.onData(tail);
		exitedResolve(code);
	};
	const requestClose = (error: Error) => {
		if (closing || exited) return;
		closing = true;
		clearReadyTimer();
		clearQueuedInput();
		if (!ready) rejectReady(error);
		// Preserve the ORIGINAL long-lived RPC to receive its real process/tree wait.
		// A missing peer or a successful kill RPC is never process-exit evidence.
		void sendRpc(deviceId, "pty.kill", { ptyId }, { timeoutMs: 5_000 }).catch(() => {});
		closeTimer = setTimeout(() => {
			finishExited(null, error);
			abort.abort(); // Only now release a permanently missing original response.
		}, closeTimeoutMs);
	};
	const fail = (error: Error) => {
		deps.onFailure?.(error);
		requestClose(error);
	};
	const assertInputProof = (proof: unknown) => {
		if (
			proof &&
			typeof proof === "object" &&
			"assertStillCurrent" in proof &&
			typeof proof.assertStillCurrent === "function"
		) {
			proof.assertStillCurrent();
		} else if (deps.requireInputAuthorityProof) {
			throw new Error("Terminal input requires a final authority proof");
		}
	};
	const pump = async () => {
		if (pumping || !ready || exited || closing) return;
		pumping = true;
		try {
			while (!exited && !closing && (queuedWrites.length || queuedResize)) {
				const write = queuedWrites.shift();
				if (write) {
					try {
						const proof = await (write.authority ?? deps.beforeInput)?.();
						if (exited || closing) break;
						assertInputProof(proof);
						await sendRpc(
							deviceId,
							"pty.write",
							{ ptyId, dataB64: Buffer.from(write.bytes).toString("base64") },
							{ timeoutMs: 5_000 },
						);
					} finally {
						queuedWriteBytes = Math.max(0, queuedWriteBytes - write.bytes.byteLength);
					}
				} else if (queuedResize) {
					const resize = queuedResize;
					queuedResize = null;
					const proof = await (resize.authority ?? deps.beforeInput)?.();
					if (exited || closing) break;
					assertInputProof(proof);
					await sendRpc(
						deviceId,
						"pty.resize",
						{ ptyId, cols: resize.cols, rows: resize.rows },
						{ timeoutMs: 5_000 },
					);
				}
			}
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		} finally {
			pumping = false;
		}
	};
	const write = (data: string | Uint8Array, authority?: InputAuthority) => {
		if (exited || closing) return;
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		if (queuedWriteBytes + bytes.byteLength > maxQueuedWriteBytes) {
			fail(new Error(`Remote PTY input queue exceeded ${maxQueuedWriteBytes} bytes`));
			return;
		}
		for (let offset = 0; offset < bytes.byteLength; offset += MAX_INPUT_CHUNK_BYTES) {
			const chunk = Uint8Array.from(bytes.subarray(offset, offset + MAX_INPUT_CHUNK_BYTES));
			queuedWrites.push({ bytes: chunk, authority });
			queuedWriteBytes += chunk.byteLength;
		}
		void pump();
	};
	const resize = (cols: number, rows: number, authority?: InputAuthority) => {
		if (exited || closing) return;
		if (
			!Number.isInteger(cols) ||
			!Number.isInteger(rows) ||
			cols < 1 ||
			rows < 1 ||
			cols > 32767 ||
			rows > 32767
		)
			return;
		queuedResize = { cols, rows, authority };
		void pump();
	};
	readyTimer = setTimeout(() => {
		fail(new Error(`Remote PTY did not become ready within ${readyTimeoutMs}ms`));
	}, readyTimeoutMs);
	void sendRpc(
		deviceId,
		"pty.open",
		{
			ptyId,
			cmd: opts.cmd,
			cwd: opts.cwd,
			cols: opts.cols,
			rows: opts.rows,
			env,
			...(deps.expectedNativeDescriptor
				? { expectedNativeDescriptor: structuredClone(deps.expectedNativeDescriptor) }
				: {}),
		},
		{
			signal: abort.signal,
			longLived: true,
			onStream: (channel, chunk) => {
				if (exited) return;
				if (channel === "pty_ready") {
					if (!readySettled && !closing) {
						readySettled = true;
						ready = true;
						clearReadyTimer();
						readyResolve();
						void pump();
					}
					return;
				}
				if (channel === "pty_error") {
					fail(new Error("Remote PTY IO failed or bounded output queue overran"));
					return;
				}
				if (channel !== "pty") return;
				if (chunk.byteLength > MAX_OUTPUT_CHUNK_BYTES) {
					fail(new Error("Remote PTY output chunk exceeded 32KiB"));
					return;
				}
				const text = decoder.decode(chunk, { stream: true });
				if (text) opts.onData(text);
			},
		},
	).then(
		(result) => {
			const evidence = result as {
				exitCode?: unknown;
				processExitObserved?: boolean;
				treeStopped?: boolean;
				cleanupComplete?: boolean;
			} | null;
			const hasEvidence =
				evidence?.processExitObserved !== undefined ||
				evidence?.treeStopped !== undefined ||
				evidence?.cleanupComplete !== undefined;
			const proven =
				(!deps.requireLifecycleEvidence && !hasEvidence) ||
				(evidence?.processExitObserved === true &&
					evidence.treeStopped === true &&
					evidence.cleanupComplete === true);
			const code = evidence?.exitCode;
			finishExited(
				proven &&
					typeof code === "number" &&
					Number.isSafeInteger(code) &&
					code >= 0 &&
					code <= 0xffffffff
					? code
					: null,
			);
		},
		(error) => {
			const normalized = error instanceof Error ? error : new Error(String(error));
			finishExited(null, normalized);
			logger.debug("Remote PTY session ended", { deviceId, ptyId, error: normalized.message });
		},
	);
	return {
		write,
		resize,
		writeAuthorized: write,
		resizeAuthorized: resize,
		close() {
			requestClose(new Error("Remote PTY was closed before becoming ready"));
		},
		kill() {
			requestClose(new Error("Remote PTY was killed before becoming ready"));
		},
		get pid() {
			return null;
		},
		get exited() {
			return exitedPromise;
		},
		get ready() {
			return readyPromise;
		},
	};
}
