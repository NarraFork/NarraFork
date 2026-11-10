import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	installMonacoWorkerPolicy,
	MONACO_WORKER_MAX_PENDING_REQUESTS,
	MONACO_WORKER_POLICY_VERSION,
	MonacoWorkerUnavailableError,
	observeMonacoStandaloneWorkers,
} from "./monaco-worker-policy";

// Mirrors the relevant 0.56.0 control flow, including its nested catches and inherited fallback.
function fixture(
	mode:
		| "healthy"
		| "construct"
		| "channel"
		| "ping"
		| "hang"
		| "rpcReject"
		| "rpcHang"
		| "notificationHang" = "healthy",
) {
	const state = { synchronous: 0, disposed: 0, syncedDisposed: 0, created: 0, pings: 0 };
	const proxy = {
		async $ping() {
			state.pings++;
			if (mode === "ping") throw new Error("ping rejected");
			if (mode === "hang") await new Promise(() => {});
		},
		async $computeLinks() {
			if (mode === "rpcReject") throw new Error("worker task rejected");
			if (mode === "rpcHang") await new Promise(() => {});
			return [{ url: "https://example.com" }];
		},
		async $acceptNewModel() {
			if (mode === "notificationHang") await new Promise(() => {});
		},
		async $acceptModelChanged() {},
		async $acceptRemovedModel() {},
	};
	const transport = { proxy, dispose: () => state.disposed++ };
	type Resource = { dispose(): void };
	class Client {
		_worker: typeof transport | null = null;
		_modelManager: Resource | null = null;
		_disposed = false;
		_resources = new Set<Resource>();
		_store = {
			delete: (value: Resource) => {
				this._resources.delete(value);
				value.dispose();
			},
		};
		_register<T extends Resource>(resource: T): T {
			this._resources.add(resource);
			return resource;
		}
		_getOrCreateWorker() {
			if (!this._worker) {
				try {
					state.created++;
					if (mode === "construct") throw new Error("disabled Worker");
					this._worker = this._register(transport);
					if (mode === "channel") throw new Error("channel failed");
				} catch {
					this._worker = this._createFallbackLocalWorker();
				}
			}
			return this._worker;
		}
		async _getProxy() {
			try {
				const result = this._getOrCreateWorker().proxy;
				await result.$ping();
				return result;
			} catch {
				this._worker = this._createFallbackLocalWorker();
				return this._worker.proxy;
			}
		}
		_createFallbackLocalWorker() {
			state.synchronous++;
			return transport;
		}
		_getOrCreateModelManager(_proxy: unknown) {
			this._modelManager ??= this._register({ dispose: () => state.syncedDisposed++ });
			return this._modelManager;
		}
		async workerWithSyncedResources(_resources: unknown[], _forceLargeModels = false) {
			const result = await this._getProxy();
			this._getOrCreateModelManager(result);
			return result;
		}
		dispose() {
			for (const resource of this._resources) resource.dispose();
			this._resources.clear();
			this._disposed = true;
		}
	}
	return { Client, state, proxy, transport };
}

describe("Monaco strict Worker failure boundary", () => {
	test("standalone initialization rejection is observed without replacing the instance or Promise", async () => {
		const failure = new Error("foreign proxy failed");
		const rejected = Promise.reject(failure);
		let creates = 0;
		const worker = {
			getProxy: () => rejected,
			withSyncedResources: () => rejected,
			dispose() {},
		};
		const editor = {
			createWebWorker: () => {
				creates++;
				return worker;
			},
		} as unknown as Parameters<typeof observeMonacoStandaloneWorkers>[0];
		observeMonacoStandaloneWorkers(editor);
		const create = editor.createWebWorker;
		observeMonacoStandaloneWorkers(editor);
		expect(editor.createWebWorker).toBe(create);
		const result = editor.createWebWorker({ worker: {} as Worker });
		expect(result).toBe(worker);
		expect(result.getProxy()).toBe(rejected);
		await expect(result.getProxy()).rejects.toBe(failure);
		expect(creates).toBe(1);
	});
	test("healthy workers keep RPC results, proxy identity, model manager and disposal", async () => {
		const { Client, state } = fixture();
		const createWorker = Client.prototype._getOrCreateWorker;
		const sync = Client.prototype.workerWithSyncedResources;
		installMonacoWorkerPolicy(Client);
		const client = new Client();
		const proxy = await client.workerWithSyncedResources([]);
		expect(await client._getProxy()).toBe(proxy);
		expect(await proxy.$computeLinks()).toEqual([{ url: "https://example.com" }]);
		expect(Client.prototype._getOrCreateWorker).toBe(createWorker);
		expect(Client.prototype.workerWithSyncedResources).toBe(sync);
		expect(state.created).toBe(1);
		expect(state.pings).toBe(2);
		expect(state.disposed).toBe(0);
		client.dispose();
		expect(state.disposed).toBe(1);
		expect(state.syncedDisposed).toBe(1);
		expect(state.synchronous).toBe(0);
	});
	for (const mode of ["construct", "channel", "ping"] as const) {
		test(`${mode} failure rejects, never constructs sync worker, unregisters failed transport`, async () => {
			const { Client, state } = fixture(mode);
			installMonacoWorkerPolicy(Client);
			const client = new Client();
			client._getOrCreateModelManager({});
			await expect(client._getProxy()).rejects.toBeInstanceOf(MonacoWorkerUnavailableError);
			expect(client._worker).toBeNull();
			expect(client._modelManager).toBeNull();
			expect(state.syncedDisposed).toBe(1);
			expect(state.disposed).toBe(mode === "construct" ? 0 : 1);
			expect(state.synchronous).toBe(0);
			await expect(client._getProxy()).rejects.toThrow("Monaco Worker unavailable");
			client.dispose();
			expect(state.created).toBe(1);
			expect(state.syncedDisposed).toBe(1);
			expect(state.disposed).toBe(mode === "construct" ? 0 : 1);
		});
	}
	test("an inherited standalone client uses the same fail-closed boundary", async () => {
		const { Client, state } = fixture("ping");
		class StandaloneClient extends Client {}
		installMonacoWorkerPolicy(Client);
		await expect(new StandaloneClient()._getProxy()).rejects.toThrow("Monaco Worker unavailable");
		expect(state.synchronous).toBe(0);
		expect(state.disposed).toBe(1);
	});
	test("a silent/dead worker has a finite handshake deadline and stays explicitly failed", async () => {
		const { Client, state } = fixture("hang");
		installMonacoWorkerPolicy(Client, MONACO_WORKER_POLICY_VERSION, { handshakeTimeoutMs: 5 });
		const client = new Client();
		let failure: unknown;
		try {
			await client._getProxy();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(MonacoWorkerUnavailableError);
		expect((failure as Error).cause).toEqual(new Error("handshake timed out after 5ms"));
		await expect(client._getProxy()).rejects.toBe(failure);
		expect(state.synchronous).toBe(0);
		expect(state.disposed).toBe(1);
		expect(state.created).toBe(1);
	});
	for (const mode of ["rpcReject", "rpcHang"] as const) {
		test(`ready worker ${mode} settles all pending work and cannot switch to sync`, async () => {
			const { Client, state } = fixture(mode);
			installMonacoWorkerPolicy(Client, MONACO_WORKER_POLICY_VERSION, { requestTimeoutMs: 5 });
			const client = new Client();
			const proxy = await client.workerWithSyncedResources([]);
			const results = await Promise.allSettled([proxy.$computeLinks(), proxy.$computeLinks()]);
			expect(results.every((result) => result.status === "rejected")).toBe(true);
			await expect(client._getProxy()).rejects.toThrow("Monaco Worker unavailable");
			expect(state.disposed).toBe(1);
			expect(state.syncedDisposed).toBe(1);
			expect(state.synchronous).toBe(0);
			client.dispose();
			expect(state.disposed).toBe(1);
		});
	}
	test("ignored model notifications are observed but still reject when explicitly awaited", async () => {
		const { Client, state } = fixture("notificationHang");
		installMonacoWorkerPolicy(Client, MONACO_WORKER_POLICY_VERSION, { requestTimeoutMs: 5 });
		const client = new Client();
		const proxy = await client.workerWithSyncedResources([]);
		void proxy.$acceptNewModel(); // Deliberately ignored, just as Monaco's model manager does.
		await new Promise((resolve) => setTimeout(resolve, 15));
		await expect(proxy.$acceptNewModel()).rejects.toThrow("Monaco Worker unavailable");
		expect(state.disposed).toBe(1);
		expect(state.synchronous).toBe(0);
	});
	test("editor disposal cancels ready-worker RPCs instead of waiting for their deadlines", async () => {
		const { Client, state } = fixture("rpcHang");
		installMonacoWorkerPolicy(Client);
		const client = new Client();
		const proxy = await client.workerWithSyncedResources([]);
		const result = proxy.$computeLinks();
		client.dispose();
		await expect(result).rejects.toThrow("client disposed");
		expect(state.disposed).toBe(1);
		expect(state.syncedDisposed).toBe(1);
		expect(state.synchronous).toBe(0);
	});
	test("teardown at every handshake microtask boundary cannot leave late model managers", async () => {
		for (let ticks = 0; ticks < 16; ticks++) {
			const { Client, state } = fixture();
			installMonacoWorkerPolicy(Client);
			const client = new Client();
			const syncing = client.workerWithSyncedResources([]);
			void syncing.catch(() => {});
			for (let step = 0; step < ticks; step++) await Promise.resolve();
			client.dispose();
			await Promise.allSettled([syncing]);
			expect(client._resources.size).toBe(0);
			expect(state.synchronous).toBe(0);
		}
	});
	test("pending RPC backpressure fails explicitly and cancels the whole failed transport", async () => {
		const { Client, state } = fixture("rpcHang");
		installMonacoWorkerPolicy(Client);
		const client = new Client();
		const proxy = await client._getProxy();
		const calls = Array.from({ length: MONACO_WORKER_MAX_PENDING_REQUESTS + 1 }, () =>
			proxy.$computeLinks(),
		);
		const results = await Promise.allSettled(calls);
		expect(results.every((result) => result.status === "rejected")).toBe(true);
		await expect(proxy.$computeLinks()).rejects.toThrow("pending request limit exceeded");
		expect(state.disposed).toBe(1);
		expect(state.synchronous).toBe(0);
	});
	test("cleanup errors cannot enter sync fallback or leak the other registered resource", async () => {
		const { Client, state } = fixture("ping");
		installMonacoWorkerPolicy(Client);
		const client = new Client();
		client._modelManager = client._register({
			dispose() {
				throw new Error("sync cleanup failed");
			},
		});
		await expect(client._getProxy()).rejects.toBeInstanceOf(MonacoWorkerUnavailableError);
		expect(state.disposed).toBe(1);
		expect(state.synchronous).toBe(0);
		expect(() => client.dispose()).not.toThrow();
	});
	test("HMR is idempotent, while wrong versions and private API shape changes fail closed", () => {
		const { Client } = fixture();
		installMonacoWorkerPolicy(Client);
		const fallback = Client.prototype._createFallbackLocalWorker;
		const getProxy = Client.prototype._getProxy;
		installMonacoWorkerPolicy(Client);
		expect(Client.prototype._createFallbackLocalWorker).toBe(fallback);
		expect(Client.prototype._getProxy).toBe(getProxy);
		expect(() => installMonacoWorkerPolicy(Client, "0.57.0")).toThrow("Unsupported Monaco version");
		expect(() => installMonacoWorkerPolicy({})).toThrow("EditorWorkerClient export");
		const changed = fixture().Client;
		Object.defineProperty(changed.prototype, "_createFallbackLocalWorker", { value: undefined });
		expect(() => installMonacoWorkerPolicy(changed)).toThrow("_createFallbackLocalWorker contract");
		expect(() =>
			installMonacoWorkerPolicy(fixture().Client, "0.56.0", { handshakeTimeoutMs: Infinity }),
		).toThrow("positive and finite");
	});
	test("private instance shape drift rejects before any Worker computation", async () => {
		const { Client, state } = fixture();
		installMonacoWorkerPolicy(Client);
		const client = new Client();
		Object.defineProperty(client, "_store", { value: {} });
		await expect(client._getProxy()).rejects.toThrow("Unsupported Monaco Worker client state");
		expect(state.created).toBe(0);
		expect(state.synchronous).toBe(0);
	});
});

test("installed Monaco private implementation matches the audited 0.56.0 contract", async () => {
	// Hashes deliberately require re-auditing BOTH the ordinary service and standalone subclass.
	for (const [path, digest] of [
		[
			"editor/browser/services/editorWorkerService.js",
			"64bf562c0e82e2a966a05fb64bcbf8750d1ec2092023067876b8fc9969a11058",
		],
		[
			"editor/standalone/browser/standaloneWebWorker.js",
			"7369c056e7b50b81f0891b2c804147b8bd13552edda06335c9dbba69d2f6b28f",
		],
	]) {
		const source = await readFile(
			new URL(`../../../../node_modules/monaco-editor/esm/vs/${path}`, import.meta.url),
			"utf8",
		);
		expect(createHash("sha256").update(source).digest("hex")).toBe(digest);
	}
});
