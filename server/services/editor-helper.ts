import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { isAbsolute } from "node:path";
import type { EditorHelperCapabilities } from "../../shared/editor-provider-contracts";
import { helperSourceIdentity } from "../../shared/helper-distribution";
import type { ExecutorPlatform } from "../../shared/remote-executor";
import {
	FEATURE_EDITOR_DURABLE_WRITE_V1,
	FEATURE_EDITOR_HOST_RECEIPT_V1,
} from "../lib/agent/execution/rpc-types";
import { AppError } from "../lib/errors";
import { type ExecutorArtifactLocation, ensureExecutorBinary } from "../lib/executor-binaries";
import { captureHelperSource } from "../lib/helper-distribution-runtime";
import { hotSafe } from "../lib/hot-safe";
import { BUILD_EXECUTOR_DISTRIBUTION } from "../lib/version";

const FRAME_BYTES = 128 * 1024;
const SESSION_BYTES = 40 * 1024 * 1024;
export interface EditorRpc {
	/** A local primary helper reserves one nested metadata helper without competing for root slots. */
	withMetadata?<T>(run: () => Promise<T>): Promise<T>;
	call<T>(method: string, params: object, signal?: AbortSignal): Promise<T>;
	close(): Promise<void>;
}
/** Only verified distribution or a trusted fixture resolver may supply this. No PATH fallback. */
export type EditorHelperResolver = (signal: AbortSignal) => Promise<ExecutorArtifactLocation>;

export const resolveEditorHelper: EditorHelperResolver = async (signal) => {
	const os = process.platform;
	const arch = process.arch === "x64" ? "amd64" : process.arch;
	if (
		!["linux", "darwin", "windows"].includes(os === "win32" ? "windows" : os) ||
		!["amd64", "arm64"].includes(arch)
	)
		throw new Error("Editor helper platform unsupported");
	return ensureExecutorBinary(`${os === "win32" ? "windows" : os}-${arch}` as ExecutorPlatform, {
		signal,
	});
};

export const EDITOR_HELPER_LIMITS = { roots: 2, queue: 16, waitMs: 5000, sessionMs: 30_000 };
type HelperRoot = { references: number; child: boolean; closed: boolean };
type HelperWaiter = {
	signal: AbortSignal;
	grant(root: HelperRoot): void;
	cancel(error: unknown): void;
};
const helperPool = hotSafe("editor.helper.admission.v1", () => ({
	roots: new Set<HelperRoot>(),
	queue: [] as HelperWaiter[],
	processes: 0,
	peak: 0,
}));
const metadataContext = hotSafe(
	"editor.helper.metadata-context.v1",
	() => new AsyncLocalStorage<EditorHelperSession>(),
);
const helperBusy = () =>
	new AppError("Editor helper capacity is busy; retry later", 503, "EDITOR_HELPER_BUSY");
function newHelperRoot() {
	const root: HelperRoot = { references: 1, child: false, closed: false };
	helperPool.roots.add(root);
	return root;
}
function releaseHelper(root: HelperRoot, nested: boolean) {
	if (nested) root.child = false;
	else root.closed = true;
	if (--root.references !== 0) return;
	helperPool.roots.delete(root);
	while (helperPool.roots.size < EDITOR_HELPER_LIMITS.roots && helperPool.queue.length) {
		const waiter = helperPool.queue.shift();
		if (!waiter) break;
		if (waiter.signal.aborted) waiter.cancel(waiter.signal.reason);
		else waiter.grant(newHelperRoot());
	}
}
function acquireHelperRoot(signal: AbortSignal): Promise<HelperRoot> {
	signal.throwIfAborted();
	if (helperPool.roots.size < EDITOR_HELPER_LIMITS.roots) return Promise.resolve(newHelperRoot());
	if (helperPool.queue.length >= EDITOR_HELPER_LIMITS.queue) return Promise.reject(helperBusy());
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout>;
		const detach = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			const index = helperPool.queue.indexOf(waiter);
			if (index >= 0) helperPool.queue.splice(index, 1);
		};
		const waiter: HelperWaiter = {
			signal,
			grant: (root) => {
				detach();
				resolve(root);
			},
			cancel: (error) => {
				detach();
				reject(error);
			},
		};
		const abort = () => waiter.cancel(signal.reason);
		timer = setTimeout(() => waiter.cancel(helperBusy()), EDITOR_HELPER_LIMITS.waitMs);
		signal.addEventListener("abort", abort, { once: true });
		helperPool.queue.push(waiter);
		if (signal.aborted) abort();
	});
}
export function editorHelperDiagnostics() {
	return {
		roots: helperPool.roots.size,
		queued: helperPool.queue.length,
		processes: helperPool.processes,
		peak: helperPool.peak,
	};
}
export function withEditorHelperMetadata<T>(rpc: EditorRpc, run: () => Promise<T>): Promise<T> {
	return rpc.withMetadata ? rpc.withMetadata(run) : run();
}

/** A short-lived, bounded editor-only session. Bodies never appear in argv or a shell. */
export class EditorHelperSession implements EditorRpc {
	private readonly child: ChildProcessWithoutNullStreams;
	private pending?: { id: string; resolve(value: unknown): void; reject(error: Error): void };
	private fault?: Error;
	private buffer = "";
	private outputBytes = 0;
	private inputBytes = 0;
	private stderrBytes = 0;
	private readonly deadline: ReturnType<typeof setTimeout>;
	private readonly ended: Promise<void>;
	private closed = false;
	private readonly cancel = () => this.fail(new Error("Editor helper session cancelled"));
	static async open(
		artifact: ExecutorArtifactLocation | EditorHelperResolver,
		root: string,
		stateDir: string,
		epoch: string,
		options: { hostReceiptsDir?: string; signal?: AbortSignal } = {},
	): Promise<EditorHelperSession> {
		const parent = metadataContext.getStore();
		const signal = AbortSignal.any([
			AbortSignal.timeout(EDITOR_HELPER_LIMITS.sessionMs),
			...(options.signal ? [options.signal] : []),
			...(parent ? [parent.signal] : []),
		]);
		let lease: HelperRoot;
		const nested = !!parent;
		if (parent) {
			if (
				parent.nested ||
				parent.closed ||
				parent.fault ||
				parent.rootLease.closed ||
				parent.rootLease.child
			)
				throw helperBusy();
			lease = parent.rootLease;
			lease.child = true;
			lease.references++;
		} else lease = await acquireHelperRoot(signal);
		try {
			signal.throwIfAborted();
			const verified = typeof artifact === "function" ? await artifact(signal) : artifact;
			signal.throwIfAborted();
			return new EditorHelperSession(
				verified,
				root,
				stateDir,
				epoch,
				lease,
				nested,
				signal,
				options.hostReceiptsDir,
			);
		} catch (error) {
			releaseHelper(lease, nested);
			throw error;
		}
	}
	withMetadata<T>(run: () => Promise<T>): Promise<T> {
		if (this.nested || this.closed || this.fault) return Promise.reject(helperBusy());
		return metadataContext.run(this, run);
	}
	private constructor(
		artifact: ExecutorArtifactLocation,
		root: string,
		stateDir: string,
		epoch: string,
		private readonly rootLease: HelperRoot,
		private readonly nested: boolean,
		readonly signal: AbortSignal,
		hostReceiptsDir?: string,
	) {
		if (
			!isAbsolute(artifact.path) ||
			!isAbsolute(root) ||
			!isAbsolute(stateDir) ||
			(hostReceiptsDir !== undefined && !isAbsolute(hostReceiptsDir))
		)
			throw new Error("Editor helper requires verified absolute paths");
		this.child = spawn(
			artifact.path,
			[
				"editor-stdio",
				"--root",
				root,
				"--state-dir",
				stateDir,
				"--epoch",
				epoch,
				...(hostReceiptsDir ? ["--host-receipts-dir", hostReceiptsDir] : []),
			],
			{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
		);
		helperPool.processes++;
		helperPool.peak = Math.max(helperPool.peak, helperPool.processes);
		this.ended = new Promise((resolve) =>
			this.child.once("close", () => {
				this.closed = true;
				clearTimeout(this.deadline);
				this.signal.removeEventListener("abort", this.cancel);
				this.fail(new Error("Editor helper session ended"));
				helperPool.processes--;
				releaseHelper(this.rootLease, this.nested);
				resolve();
			}),
		);
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderrBytes += chunk.length;
			if (this.stderrBytes > 16 * 1024) this.fail(new Error("Editor helper stderr limit"));
		});
		this.child.on("error", (error) => this.fail(error));
		this.child.stdin.on("error", (error) => this.fail(error));
		this.deadline = setTimeout(
			() => this.fail(new Error("Editor helper session deadline")),
			EDITOR_HELPER_LIMITS.sessionMs,
		);
		this.signal.addEventListener("abort", this.cancel, { once: true });
		if (this.signal.aborted) this.cancel();
	}
	private fail(error: Error) {
		this.fault ??= error;
		this.pending?.reject(this.fault);
		this.pending = undefined;
		if (!this.closed && this.child.exitCode === null) this.child.kill();
	}
	private consume(chunk: string) {
		this.outputBytes += Buffer.byteLength(chunk);
		if (this.outputBytes > 2 * 1024 * 1024 || this.buffer.length + chunk.length > FRAME_BYTES * 2)
			return this.fail(new Error("Editor helper output limit"));
		this.buffer += chunk;
		for (;;) {
			const end = this.buffer.indexOf("\n");
			if (end < 0) {
				if (Buffer.byteLength(this.buffer) > FRAME_BYTES)
					this.fail(new Error("Editor helper frame limit"));
				return;
			}
			const line = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 1);
			try {
				if (Buffer.byteLength(line) > FRAME_BYTES) throw new Error("Editor helper frame limit");
				const frame = JSON.parse(line);
				const pending = this.pending;
				if (
					!pending ||
					frame.type !== "rpc_result" ||
					frame.id !== pending.id ||
					typeof frame.ok !== "boolean"
				)
					throw new Error("Unexpected editor helper reply");
				this.pending = undefined;
				if (frame.ok) pending.resolve(frame.result);
				else
					pending.reject(
						new Error(String(frame.error ?? "Editor helper rejected request").slice(0, 512)),
					);
			} catch (error) {
				this.fail(error as Error);
			}
		}
	}
	async call<T>(method: string, params: object, signal: AbortSignal = this.signal): Promise<T> {
		signal.throwIfAborted();
		if (this.fault) throw this.fault;
		if (this.pending) throw new Error("Editor helper only accepts sequential requests");
		if (
			!/^(editor\.(capabilities|hostReceipt\.(put|get|settle)|stage\.(open|append|seal|abort)|apply|query)|fs\.stat)$/.test(
				method,
			)
		)
			throw new Error("Not an editor helper method");
		const id = randomUUID();
		const line = `${JSON.stringify({ type: "rpc", id, method, params })}\n`;
		this.inputBytes += Buffer.byteLength(line);
		if (Buffer.byteLength(line) > FRAME_BYTES || this.inputBytes > SESSION_BYTES)
			throw new Error("Editor helper input limit");
		const cancel = () => this.fail(new Error("Editor helper request cancelled"));
		const idle = setTimeout(() => this.fail(new Error("Editor helper reply deadline")), 10_000);
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			const reply = new Promise<T>((resolve, reject) => {
				this.pending = { id, resolve: (value) => resolve(value as T), reject };
			});
			// Attach before awaiting backpressure: a reply may arrive before drain.
			void reply.catch(() => {});
			if (!this.child.stdin.write(line))
				await Promise.race([once(this.child.stdin, "drain"), reply]);
			return await reply;
		} finally {
			clearTimeout(idle);
			signal?.removeEventListener("abort", cancel);
		}
	}
	async capabilities(signal?: AbortSignal): Promise<EditorHelperCapabilities> {
		const result = await this.call<EditorHelperCapabilities>("editor.capabilities", {}, signal);
		if (
			result.protocolVersion !== 1 ||
			!Array.isArray(result.features) ||
			!result.features.includes(FEATURE_EDITOR_DURABLE_WRITE_V1) ||
			result.maxChunkBytes !== 65536 ||
			result.maxBytes !== 20 * 1024 * 1024 ||
			typeof result.runtimeEpoch !== "string" ||
			!result.runtimeEpoch ||
			result.runtimeEpoch.length > 128
		)
			throw new Error("Upgrade the verified executor: editor.durable-write.v1 is required");
		return result;
	}
	async close() {
		clearTimeout(this.deadline);
		this.child.stdin.end();
		if (!this.closed && this.child.exitCode === null) this.child.kill();
		await this.ended;
	}
}

const availability = hotSafe("editor.helper.availability.v1", () => ({
	ready: false,
	hostReady: false,
	identity: "",
	retryAt: 0,
	preparing: undefined as Promise<void> | undefined,
}));
/** Read/metadata never waits for a network install. Retry opening after verified preparation. */
export function editorHelperAvailable(): boolean {
	const identity = `${helperSourceIdentity(captureHelperSource())}:${BUILD_EXECUTOR_DISTRIBUTION.version}`;
	if (identity !== availability.identity) {
		availability.identity = identity;
		availability.ready = false;
		availability.hostReady = false;
		availability.retryAt = 0;
	}
	if (!availability.preparing && Date.now() >= availability.retryAt) {
		availability.retryAt = Date.now() + 60_000;
		availability.preparing = resolveEditorHelper(AbortSignal.timeout(120_000))
			.then(async (artifact) => {
				// Feature probing itself happens in the live write session. Distribution presence
				// alone is not advertised as availability: the probe must succeed first.
				const { getNarraforkHome } = await import("../lib/narrafork-home");
				const { join } = await import("node:path");
				const session = await EditorHelperSession.open(
					artifact,
					getNarraforkHome(),
					join(getNarraforkHome(), "editor-native"),
					`probe-${randomUUID()}`,
					{
						hostReceiptsDir:
							process.platform === "win32"
								? join(getNarraforkHome(), "editor-native-operations")
								: undefined,
					},
				);
				try {
					const capabilities = await session.capabilities();
					if (availability.identity === identity) {
						availability.ready = true;
						availability.hostReady = capabilities.features.includes(FEATURE_EDITOR_HOST_RECEIPT_V1);
					}
				} finally {
					await session.close();
				}
			})
			.catch(() => {
				if (availability.identity === identity) availability.ready = false;
			})
			.finally(() => {
				availability.preparing = undefined;
			});
	}
	return availability.ready;
}
export function editorHostReceiptAvailable(): boolean {
	editorHelperAvailable();
	return availability.ready && availability.hostReady;
}
