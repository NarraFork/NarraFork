import type { editor as MonacoEditor } from "monaco-editor/editor/editor.api";
// Monaco's package export map hides package.json. Read the installed package, not our desired range.
import { version as installedMonacoVersion } from "../../../../node_modules/monaco-editor/package.json";

export const MONACO_WORKER_POLICY_VERSION = "0.56.0";
export const MONACO_WORKER_HANDSHAKE_TIMEOUT_MS = 15_000;
export const MONACO_WORKER_REQUEST_TIMEOUT_MS = 30_000;
export const MONACO_WORKER_MAX_PENDING_REQUESTS = 256;
const policyKey = Symbol.for("narrafork.monaco.strict-worker-policy.0.56.0.v1");
const factoryKey = Symbol.for("narrafork.monaco.observed-standalone-factory.0.56.0.v1");

interface Disposable {
	dispose(): void;
}
interface WorkerClientState {
	_worker: Disposable | null;
	_modelManager: Disposable | null;
	_store: { delete(value: Disposable): void };
	_disposed: boolean;
}
type GetProxy = (this: WorkerClientState) => Promise<unknown>;
interface WorkerBudgets {
	handshakeTimeoutMs?: number;
	requestTimeoutMs?: number;
}
const notificationMethods = new Set([
	"$acceptNewModel",
	"$acceptModelChanged",
	"$acceptRemovedModel",
]);

/**
 * The standalone subclass eagerly creates _foreignProxy, then withSyncedResources may reject
 * before it ever awaits that Promise. Observe this notification-like rejection while retaining
 * the exact original client and rejected Promise for callers. No extra RPC or recovery is run.
 */
export function observeMonacoStandaloneWorkers(
	editor: Pick<typeof MonacoEditor, "createWebWorker">,
): void {
	const create = editor.createWebWorker;
	if (typeof create !== "function") throw new Error("Unsupported Monaco createWebWorker contract");
	if (Object.getOwnPropertyDescriptor(create, factoryKey)?.value) return;
	function createWebWorker<T extends object>(
		options: Parameters<typeof create>[0],
	): MonacoEditor.MonacoWebWorker<T> {
		const worker = create<T>(options);
		void worker.getProxy().catch(() => {});
		return worker;
	}
	Object.defineProperty(createWebWorker, factoryKey, { value: true });
	Object.defineProperty(editor, "createWebWorker", {
		value: createWebWorker,
		configurable: false,
		writable: false,
	});
}

export class MonacoWorkerUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(`Monaco Worker unavailable: ${message}`, options);
		this.name = "MonacoWorkerUnavailableError";
	}
}

function assertClientState(client: WorkerClientState) {
	if (
		!Object.hasOwn(client, "_worker") ||
		!Object.hasOwn(client, "_modelManager") ||
		typeof client._disposed !== "boolean" ||
		typeof client._store?.delete !== "function"
	) {
		throw new Error("Unsupported Monaco Worker client state; refusing to run");
	}
}

/**
 * Private-API adapter for exactly Monaco 0.56.0. Install BEFORE exposing editor.api.
 * Both EditorWorkerService and standalone createWebWorker inherit this failure boundary.
 * Never call the original fallback: it constructs SynchronousWorkerClient(new EditorWorker(null)).
 * Healthy worker creation, channels, model syncing and computation remain Monaco's own code.
 */
export function installMonacoWorkerPolicy(
	workerClientType: unknown,
	version = installedMonacoVersion,
	budgets: WorkerBudgets = {},
): void {
	const handshakeTimeoutMs = budgets.handshakeTimeoutMs ?? MONACO_WORKER_HANDSHAKE_TIMEOUT_MS;
	const requestTimeoutMs = budgets.requestTimeoutMs ?? MONACO_WORKER_REQUEST_TIMEOUT_MS;
	if (version !== MONACO_WORKER_POLICY_VERSION) {
		throw new Error(`Unsupported Monaco version ${version}; strict Worker policy requires 0.56.0`);
	}
	if (
		![handshakeTimeoutMs, requestTimeoutMs].every((value) => Number.isFinite(value) && value > 0)
	) {
		throw new Error("Monaco Worker deadlines must be positive and finite");
	}
	if (typeof workerClientType !== "function" || !workerClientType.prototype) {
		throw new Error("Unsupported Monaco EditorWorkerClient export");
	}
	const prototype = workerClientType.prototype;
	// Hooks and marker are immutable; HMR only needs to avoid wrapping the prototype twice.
	if (Object.getOwnPropertyDescriptor(prototype, policyKey)?.value) return;
	for (const [name, arity] of [
		["_createFallbackLocalWorker", 0],
		["_getOrCreateWorker", 0],
		["_getProxy", 0],
		["_getOrCreateModelManager", 1],
		["workerWithSyncedResources", 1],
		["dispose", 0],
	] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
		if (
			typeof descriptor?.value !== "function" ||
			descriptor.value.length !== arity ||
			!descriptor.configurable ||
			!descriptor.writable
		) {
			throw new Error(`Unsupported Monaco EditorWorkerClient.${name} contract`);
		}
	}
	if (typeof prototype._register !== "function" || !Object.isExtensible(prototype)) {
		throw new Error("Unsupported Monaco Worker disposal contract");
	}
	const originalGetProxy = prototype._getProxy as GetProxy;
	const originalDispose = prototype.dispose as (this: WorkerClientState) => void;
	const originalModelManager = prototype._getOrCreateModelManager as (
		this: WorkerClientState,
		proxy: unknown,
	) => unknown;
	const failures = new WeakMap<WorkerClientState, MonacoWorkerUnavailableError>();
	const pending = new WeakMap<WorkerClientState, Set<(error: Error) => void>>();
	const proxies = new WeakMap<object, object>();
	function stop(client: WorkerClientState, message: string, cause?: unknown): Error {
		const previous = failures.get(client);
		if (previous) return previous;
		const error = new MonacoWorkerUnavailableError(message, { cause });
		// Latch the failed client: a late ping cannot dispose a replacement transport from a retry.
		failures.set(client, error);
		for (const reject of pending.get(client) ?? []) reject(error);
		pending.delete(client);
		assertClientState(client);
		const resources = [client._modelManager, client._worker];
		client._modelManager = null;
		client._worker = null;
		const cleanupErrors: unknown[] = [];
		for (const resource of resources) {
			if (!resource) continue;
			try {
				// delete() disposes AND unregisters, preventing a second dispose on editor teardown.
				client._store.delete(resource);
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
		}
		if (cleanupErrors.length) error.cause = new AggregateError([cause, ...cleanupErrors]);
		return error;
	}
	function fallback(this: WorkerClientState): never {
		throw stop(this, "worker construction or handshake failed");
	}
	async function request(
		client: WorkerClientState,
		work: () => unknown,
		phase: string,
		timeoutMs: number,
	): Promise<unknown> {
		const previous = failures.get(client);
		if (previous) throw previous;
		assertClientState(client);
		if (client._disposed) throw stop(client, "client disposed");
		const active = pending.get(client) ?? new Set<(error: Error) => void>();
		pending.set(client, active);
		if (active.size >= MONACO_WORKER_MAX_PENDING_REQUESTS) {
			throw stop(client, "pending request limit exceeded");
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let rejectRequest: (error: Error) => void = () => {};
		try {
			// Native Monaco RPC does not reject when a Worker dies or never responds.
			// Race EVERY RPC against a deadline and client cancellation, not just the first $ping.
			const interrupted = new Promise<never>((_resolve, reject) => {
				rejectRequest = reject;
				active.add(reject);
				timer = setTimeout(
					() => reject(new Error(`${phase} timed out after ${timeoutMs}ms`)),
					timeoutMs,
				);
			});
			const running = Promise.resolve().then(() => {
				const failure = failures.get(client);
				if (failure) throw failure;
				return work();
			});
			return await Promise.race([interrupted, running]);
		} catch (cause) {
			throw stop(client, `${phase} failed`, cause);
		} finally {
			clearTimeout(timer);
			active.delete(rejectRequest);
			if (active.size === 0 && pending.get(client) === active) pending.delete(client);
		}
	}
	function wrapProxy(client: WorkerClientState, proxy: unknown): object {
		if (!proxy || typeof proxy !== "object") throw stop(client, "unsupported RPC proxy");
		const cached = proxies.get(proxy);
		if (cached) return cached;
		const methods = new Map<string, (...args: unknown[]) => Promise<unknown>>();
		const wrapped = new Proxy(proxy, {
			get(target, name, receiver) {
				const value = Reflect.get(target, name, receiver);
				if (typeof name !== "string" || !name.startsWith("$") || typeof value !== "function")
					return value;
				let method = methods.get(name);
				if (!method) {
					method = (...args) => {
						const result = request(client, () => value.apply(target, args), name, requestTimeoutMs);
						// Monaco intentionally ignores these three notification Promises. Observe rejection
						// WITHOUT turning it into success: explicit await still rejects; all RPCs fail closed.
						if (notificationMethods.has(name)) void result.catch(() => {});
						return result;
					};
					methods.set(name, method);
				}
				return method;
			},
		});
		proxies.set(proxy, wrapped);
		return wrapped;
	}
	async function getProxy(this: WorkerClientState): Promise<unknown> {
		const proxy = await request(
			this,
			() => originalGetProxy.call(this),
			"handshake",
			handshakeTimeoutMs,
		);
		return wrapProxy(this, proxy);
	}
	function modelManager(this: WorkerClientState, proxy: unknown): unknown {
		// workerWithSyncedResources checks _disposed only BEFORE awaiting _getProxy. Teardown
		// between its await and continuation must not register a new manager in a disposed store.
		const failure = failures.get(this);
		if (failure) throw failure;
		if (this._disposed) throw stop(this, "client disposed");
		return originalModelManager.call(this, proxy);
	}
	function dispose(this: WorkerClientState): void {
		// Settle outstanding work immediately on normal editor teardown as well as on failure.
		stop(this, "client disposed");
		originalDispose.call(this);
	}
	Object.defineProperties(prototype, {
		_createFallbackLocalWorker: { value: fallback, configurable: false, writable: false },
		_getProxy: { value: getProxy, configurable: false, writable: false },
		dispose: { value: dispose, configurable: false, writable: false },
		_getOrCreateModelManager: { value: modelManager, configurable: false, writable: false },
		[policyKey]: { value: true },
	});
}
