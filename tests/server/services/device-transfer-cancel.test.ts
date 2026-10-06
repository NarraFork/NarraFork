/**
 * Cancel and pause both stop a transfer through the same AbortSignal, but they
 * have opposite durability semantics.
 *
 * Pause must keep the local `.nfpart` plus its `.nfmeta` manifest and the remote
 * partial so `resume` continues from the same chunk set. Cancel is terminal: if it
 * kept them, every cancelled download would leave a partial file and manifest on
 * the server (and a partial on the device) that no code path ever removes.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONNECTION_MODULE = "../../../server/services/device-connection-service";
const realConnectionModule = { ...(await import(CONNECTION_MODULE)) };

const DEVICE_ID = "cancel-test-device";

interface RpcCall {
	method: string;
	params: Record<string, unknown>;
}
let rpcCalls: RpcCall[] = [];

mock.module(CONNECTION_MODULE, () => ({
	...realConnectionModule,
	isDeviceOnline: () => true,
	getConnectedDeviceHello: () => ({
		platform: { os: "linux", arch: "x64" },
		defaultCwd: "/remote/work",
	}),
	hasDeviceProtocolFeature: () => true,
	deviceBufferedAmount: () => 0,
	sendChunkFrame: () => true,
	setChunkFrameHandler: () => {},
	sendRpc: async (_deviceId: string, method: string, params: Record<string, unknown>) => {
		rpcCalls.push({ method, params });
		// transfer.begin must resolve without reporting the file complete, so the
		// receive stays registered and the abort below exercises the stop path.
		if (method === "transfer.begin") return { completedChunks: [] };
		return { ok: true };
	},
}));

const {
	downloadFile,
	TRANSFER_CANCELLED_ABORT_REASON,
	isTransferCancelAbort,
	createDeviceTransferTaskManager,
} = await import("../../../server/services/device-transfer-service");

let fileRoot: string;

beforeEach(() => {
	rpcCalls = [];
	fileRoot = mkdtempSync(join(tmpdir(), "narrafork-transfer-cancel-"));
});

afterEach(() => {
	rmSync(fileRoot, { recursive: true, force: true });
});

afterAll(() => {
	mock.module(CONNECTION_MODULE, () => realConnectionModule);
	mock.restore();
});

/**
 * Start a download that will never complete, wait until the receive is registered
 * (its transfer.begin RPC has been observed), then abort it with `reason`.
 */
async function startThenAbort(
	destination: string,
	reason?: string,
): Promise<{ error: unknown; abortRpc: RpcCall | undefined }> {
	const controller = new AbortController();
	const pending = downloadFile({
		deviceId: DEVICE_ID,
		remotePath: "/remote/work/source.bin",
		localDest: destination,
		// Two chunks' worth of a 1 MiB chunk size, so the transfer cannot finalize
		// on its own from the empty completedChunks list.
		remoteSize: 2 * 1024 * 1024,
		remoteMtimeMs: 1_700_000_000_000,
		remotePlatformOs: "linux",
		signal: controller.signal,
	}).catch((err: unknown) => err);

	const deadline = Date.now() + 2_000;
	while (!rpcCalls.some((call) => call.method === "transfer.begin")) {
		if (Date.now() >= deadline) throw new Error("transfer.begin was never issued");
		await Bun.sleep(2);
	}

	controller.abort(reason);
	const error = await pending;
	// The abort RPC is fire-and-forget, so give it a turn to be recorded.
	await Bun.sleep(10);
	return { error, abortRpc: rpcCalls.find((call) => call.method === "transfer.abort") };
}

describe("cancelling a download", () => {
	test("removes the local .nfpart and .nfmeta and tells the device to drop its partial", async () => {
		const destination = join(fileRoot, "cancelled.bin");

		const { error, abortRpc } = await startThenAbort(destination, TRANSFER_CANCELLED_ABORT_REASON);

		expect(String(error)).toContain("transfer cancelled");
		expect(existsSync(`${destination}.nfpart`)).toBe(false);
		expect(existsSync(`${destination}.nfmeta`)).toBe(false);
		// Without preservePartial:false the executor keeps its own partial forever.
		expect(abortRpc?.params.preservePartial).toBe(false);
	});
});

describe("pausing a download", () => {
	test("keeps the local .nfpart and .nfmeta so the transfer can resume", async () => {
		const destination = join(fileRoot, "paused.bin");

		// No abort reason: this is the ordinary pause path, whose semantics must not
		// change now that cancel is distinguished from it.
		const { abortRpc } = await startThenAbort(destination);

		expect(existsSync(`${destination}.nfpart`)).toBe(true);
		expect(existsSync(`${destination}.nfmeta`)).toBe(true);
		expect(abortRpc?.params.preservePartial).toBe(true);
	});
});

describe("transfer task stop intent", () => {
	test("cancel marks the abort as terminal while pause does not", async () => {
		const signals: { started: number; cancelSignal?: AbortSignal; pauseSignal?: AbortSignal } = {
			started: 0,
		};
		// The manager keys its in-flight runs by the id `create` returned, so `claim`
		// must echo that same id back or pause/cancel would find no active run.
		const store = {
			recoverInterrupted: async () => {},
			create: async (values: Record<string, unknown>) => values,
			claim: async (taskId: string, generation: number) => ({
				id: taskId,
				deviceId: DEVICE_ID,
				direction: "download" as const,
				remotePath: "/remote/work/source.bin",
				localPath: join(fileRoot, "stop-intent.bin"),
				recursive: false,
				runGeneration: generation,
			}),
			get: async () => null,
			list: async () => [],
			pause: async () => ({ runGeneration: 0, status: "paused" }),
			cancel: async () => ({ runGeneration: 0, status: "cancelled" }),
			resume: async () => null,
			updateTotals: async () => {},
			updateProgress: async () => {},
			complete: async () => {},
			finishStoppedOrFailed: async () => {},
			// biome-ignore lint/suspicious/noExplicitAny: narrow stub for the manager's store port
		} as any;

		const makeManager = (record: (signal: AbortSignal) => void) =>
			createDeviceTransferTaskManager(store, {
				statRemote: async () => ({ exists: true, isDirectory: false, size: 1, mtimeMs: 0 }),
				downloadFile: async ({ signal }) => {
					signals.started++;
					await new Promise<void>((_resolve, reject) => {
						const onAbort = () => {
							if (signal) record(signal);
							reject(new Error("stopped"));
						};
						if (signal?.aborted) onAbort();
						else signal?.addEventListener("abort", onAbort, { once: true });
					});
					return { transferId: "unreached", bytes: 0 };
				},
				uploadFile: async () => ({ transferId: "unused", bytes: 0 }),
				downloadDirectory: async () => ({ filesTransferred: 0, bytesTransferred: 0 }),
				uploadDirectory: async () => ({ filesTransferred: 0, bytesTransferred: 0 }),
				// biome-ignore lint/suspicious/noExplicitAny: only `size` is read by the manager
				statLocal: (async () => ({ size: 1 })) as any,
			});

		const cancelManager = makeManager((signal) => {
			signals.cancelSignal = signal;
		});
		const cancelTask = await cancelManager.start({
			deviceId: DEVICE_ID,
			direction: "download",
			remotePath: "/remote/work/source.bin",
			localPath: join(fileRoot, "stop-intent.bin"),
		});
		await waitFor(() => signals.started >= 1);
		await cancelManager.cancel(DEVICE_ID, cancelTask.id);
		await waitFor(() => signals.cancelSignal !== undefined);
		expect(isTransferCancelAbort(signals.cancelSignal)).toBe(true);

		const pauseManager = makeManager((signal) => {
			signals.pauseSignal = signal;
		});
		const pauseTask = await pauseManager.start({
			deviceId: DEVICE_ID,
			direction: "download",
			remotePath: "/remote/work/source.bin",
			localPath: join(fileRoot, "stop-intent.bin"),
		});
		await waitFor(() => signals.started >= 2);
		await pauseManager.pause(DEVICE_ID, pauseTask.id);
		await waitFor(() => signals.pauseSignal !== undefined);
		// Pause must stay indistinguishable from its previous behaviour, so the
		// transfer layer keeps preserving its partial.
		expect(isTransferCancelAbort(signals.pauseSignal)).toBe(false);
	});
});

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for transfer state");
		await Bun.sleep(5);
	}
}
