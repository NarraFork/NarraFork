import { isAbsolute, resolve } from "node:path";
import {
	WORKSPACE_ATTACHMENT_CHUNK_BYTES,
	WORKSPACE_ATTACHMENT_OPERATION_TIMEOUT_MS,
	type WorkspaceAttachmentBackend,
	type WorkspaceAttachmentBinding,
	type WorkspaceAttachmentOperation,
	type WorkspaceAttachmentOperations,
} from "@shared/workspace-attachment-protocol";
import { withFileHistoryWrite } from "./file-history-locks";
import type {
	LocalAttachmentWorkerRequest,
	LocalAttachmentWorkerResponse,
} from "./local-workspace-attachment-worker";

export interface LocalWorkspaceAttachmentOptions {
	/** Real verified runtime scope, root object identity and held fence; never inferred from a pathname. */
	binding: WorkspaceAttachmentBinding;
	/** Existing private protocol directory, separate from the user workspace. */
	privateRoot: string;
	/** Mandatory live namespace/fence/lease check, supplied by the server's runtime composition. */
	assertCurrent(signal: AbortSignal): Promise<void>;
	/** Mandatory authenticated actor/project/path write authority, not primitive-issued permission. */
	authorizePath(canonicalPath: string, signal: AbortSignal): Promise<void>;
}
export interface LocalWorkspaceAttachmentProvider extends WorkspaceAttachmentBackend {
	close(): Promise<void>;
}
function sameBinding(a: WorkspaceAttachmentBinding, b: WorkspaceAttachmentBinding): boolean {
	return (
		a.sourceInstanceId === b.sourceInstanceId &&
		a.workspaceInstanceId === b.workspaceInstanceId &&
		a.scopeId === b.scopeId &&
		a.root === b.root &&
		a.rootIdentity === b.rootIdentity &&
		a.fence === b.fence
	);
}
interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
	signal: AbortSignal;
	cancel: Int32Array;
	removeAbort(): void;
}

/** No history blob limit is changed: this is an independent, bounded native publisher. */
export async function createLocalWorkspaceAttachmentBackend(
	options: LocalWorkspaceAttachmentOptions,
): Promise<LocalWorkspaceAttachmentProvider> {
	if (typeof options.assertCurrent !== "function" || typeof options.authorizePath !== "function")
		throw new Error(
			"Local attachment native resolver requires live authority and a real held namespace/fence",
		);
	const binding = Object.freeze(structuredClone(options.binding));
	if (
		!isAbsolute(binding.root) ||
		!isAbsolute(options.privateRoot) ||
		!binding.sourceInstanceId ||
		!binding.workspaceInstanceId ||
		!binding.scopeId ||
		!binding.rootIdentity ||
		!Number.isSafeInteger(binding.fence) ||
		binding.fence < 0
	)
		throw new Error("Local attachment real runtime binding is incomplete");
	const privateRoot = resolve(options.privateRoot);
	const assertCurrent = options.assertCurrent;
	const authorizePath = options.authorizePath;
	const worker = new Worker(
		new URL("./local-workspace-attachment-worker.ts", import.meta.url).href,
	);
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let closed = false;
	let failed: Error | undefined;
	let readyResolve: (() => void) | undefined;
	let readyReject: ((error: Error) => void) | undefined;
	const ready = new Promise<void>((resolveReady, rejectReady) => {
		readyResolve = resolveReady;
		readyReject = rejectReady;
	});
	const readyTimer = setTimeout(() => {
		readyReject?.(new Error("Local attachment native helper startup timed out"));
		worker.terminate();
	}, 5_000);
	worker.onerror = (event) => {
		failed = new Error(
			`Local attachment native helper unavailable; dispatched evidence retained: ${event.message}`,
		);
		clearTimeout(readyTimer);
		readyReject?.(failed);
		for (const job of pending.values()) {
			job.removeAbort();
			job.reject(failed);
		}
		pending.clear();
	};
	worker.onmessage = (event: MessageEvent<LocalAttachmentWorkerResponse | string>) => {
		const frame: LocalAttachmentWorkerResponse =
			typeof event.data === "string" ? JSON.parse(event.data) : event.data;
		if (frame.type === "ready") {
			clearTimeout(readyTimer);
			if (!frame.supported) {
				failed = new Error(
					`Complete local attachment native metadata unsupported on ${process.platform}; no proof or cleanup`,
				);
				readyReject?.(failed);
			} else readyResolve?.();
			return;
		}
		const job = pending.get(frame.id);
		if (!job) return;
		if (frame.type === "guard") {
			void (async () => {
				try {
					job.signal.throwIfAborted();
					await assertCurrent(job.signal);
					await authorizePath(frame.path, job.signal);
					await assertCurrent(job.signal);
					job.signal.throwIfAborted();
					worker.postMessage({ type: "guard_reply", guardId: frame.guardId, ok: true });
				} catch (error) {
					worker.postMessage({
						type: "guard_reply",
						guardId: frame.guardId,
						ok: false,
						error:
							error instanceof Error
								? error.message.slice(0, 1024)
								: "Local attachment authority denied",
					});
				}
			})();
			return;
		}
		pending.delete(frame.id);
		job.removeAbort();
		if (frame.error) job.reject(new Error(frame.error.slice(0, 2048)));
		else job.resolve(frame.result);
	};
	try {
		await ready;
	} catch (error) {
		worker.terminate();
		throw error;
	}
	let tail: Promise<void> = Promise.resolve();
	const execute = async <K extends WorkspaceAttachmentOperation>(
		operation: K,
		request: WorkspaceAttachmentOperations[K]["request"],
		callerSignal?: AbortSignal,
	): Promise<WorkspaceAttachmentOperations[K]["result"]> => {
		if (closed || failed) throw failed ?? new Error("Local attachment namespace is closed");
		const timeout = AbortSignal.timeout(WORKSPACE_ATTACHMENT_OPERATION_TIMEOUT_MS);
		const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
		signal.throwIfAborted();
		if (!sameBinding(binding, request.binding))
			throw new Error("Local attachment request is outside its real verified binding");
		if (
			"contentBase64" in request &&
			request.contentBase64.length > Math.ceil(WORKSPACE_ATTACHMENT_CHUNK_BYTES / 3) * 4
		)
			throw new Error("Local attachment worker input chunk budget");
		if (Buffer.byteLength(JSON.stringify(request)) > 2 * WORKSPACE_ATTACHMENT_CHUNK_BYTES + 16384)
			throw new Error("Local attachment worker request byte budget");
		await assertCurrent(signal);
		const id = nextId++;
		const cancellation = new SharedArrayBuffer(4);
		const cancel = new Int32Array(cancellation);
		const result = new Promise<unknown>((resolveResult, reject) => {
			const abort = () => Atomics.store(cancel, 0, 1);
			signal.addEventListener("abort", abort, { once: true });
			pending.set(id, {
				resolve: resolveResult,
				reject,
				signal,
				cancel,
				removeAbort: () => signal.removeEventListener("abort", abort),
			});
			if (signal.aborted) abort();
			worker.postMessage({
				id,
				operation,
				request: structuredClone(request),
				binding,
				privateRoot,
				cancel: cancellation,
				deadline: Date.now() + WORKSPACE_ATTACHMENT_OPERATION_TIMEOUT_MS,
			} satisfies LocalAttachmentWorkerRequest);
		});
		// Cancellation never races dispatched filesystem IO or frees the runtime lease early.
		return (await result) as WorkspaceAttachmentOperations[K]["result"];
	};
	return {
		supportsWorkspaceAttachment: true,
		async workspaceAttachment<K extends WorkspaceAttachmentOperation>(
			operation: K,
			request: WorkspaceAttachmentOperations[K]["request"],
			signal?: AbortSignal,
		): Promise<WorkspaceAttachmentOperations[K]["result"]> {
			let release: (() => void) | undefined;
			const prior = tail;
			tail = new Promise<void>((resolveTail) => {
				release = resolveTail;
			});
			await prior;
			try {
				if (operation === "commit" || operation === "cleanup")
					return await withFileHistoryWrite(
						{
							deviceId: "local",
							pathFlavor: process.platform === "win32" ? "windows" : "posix",
							canonicalPath: binding.root,
						},
						() => execute(operation, request, signal),
						signal,
					);
				return await execute(operation, request, signal);
			} finally {
				release?.();
			}
		},
		async close() {
			closed = true;
			await tail;
			if (pending.size)
				throw new Error("Local attachment IO has not settled; worker/lease must remain retained");
			worker.terminate();
		},
	};
}
