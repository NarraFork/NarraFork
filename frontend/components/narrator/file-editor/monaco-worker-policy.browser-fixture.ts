import type { Environment, Uri } from "monaco-editor/editor/editor.api";
import { loadMonaco } from "./monaco-loader";
import { installMonacoWorkerPolicy } from "./monaco-worker-policy";

interface Proxy {
	$computeLinks(uri: string): Promise<{ url: string }[]>;
}
interface Client {
	_worker: unknown;
	_modelManager: unknown;
	_getProxy(): Promise<Proxy>;
	workerWithSyncedResources(resources: Uri[]): Promise<Proxy>;
	dispose(): void;
}
const { EditorWorkerClient, EditorWorkerService } = await import(
	"monaco-editor/editor/browser/services/editorWorkerService"
);
const ClientConstructor = EditorWorkerClient as {
	new (descriptor: unknown, keepIdleModels: boolean, models: unknown, workers: unknown): Client;
	prototype: { _createFallbackLocalWorker(): unknown };
};
let originalFallbackCalls = 0;
let synchronousInstances = 0;
const originalFallback = ClientConstructor.prototype._createFallbackLocalWorker;
ClientConstructor.prototype._createFallbackLocalWorker = function () {
	originalFallbackCalls++;
	return originalFallback.call(this);
};
const { EditorWorker } = await import("monaco-editor/editor/common/services/editorWebWorker");
// 0.56.0's constructor assigns this brand. Count *construction*, not just algorithm invocations.
Object.defineProperty(EditorWorker.prototype, "_requestHandlerBrand", {
	configurable: true,
	set() {
		synchronousInstances++;
	},
});
// Positive control: ensure the constructor probe still works after production minification.
// This empty test-only instance executes no editor computation and is not a fallback client.
const ProbeWorker = EditorWorker as unknown as new (foreignModule: null) => { dispose(): void };
const probe = new ProbeWorker(null);
probe.dispose();
if (synchronousInstances !== 1) throw new Error("Monaco synchronous-constructor probe is invalid");
synchronousInstances = 0;
// Only shorten deadlines in this isolated fixture, not in production or dependency sources.
installMonacoWorkerPolicy(EditorWorkerClient, "0.56.0", {
	handshakeTimeoutMs: 5_000,
	requestTimeoutMs: 1_000,
});
const api = await loadMonaco();
const { StandaloneWebWorkerService } = await import(
	"monaco-editor/editor/standalone/browser/services/standaloneWebWorkerService"
);
type Mode = "healthy" | "construct" | "disabled" | "handshake" | "crash";
type Path = "service" | "standalone";
const environment = (globalThis as typeof globalThis & { MonacoEnvironment: Environment })
	.MonacoEnvironment;
const productionGetWorker = environment.getWorker;
if (!productionGetWorker) throw new Error("Missing production Monaco getWorker");

export const fixture = {
	async run(mode: Mode, path: Path) {
		let created = 0;
		let terminated = 0;
		let nativeWorker: Worker | undefined;
		const NativeWorker = globalThis.Worker;
		if (mode === "construct") {
			globalThis.Worker = function UnavailableWorker() {
				throw new Error("injected native Worker constructor failure");
			} as unknown as typeof Worker;
		} else if (mode === "disabled") {
			Object.defineProperty(globalThis, "Worker", {
				configurable: true,
				writable: true,
				value: undefined,
			});
		}
		const getWorker = () => {
			let worker: Worker;
			if (mode === "handshake") {
				worker = new Worker("/monaco-policy-rejected-handshake.js", { type: "module" });
			} else if (path === "standalone") {
				worker = new Worker(new URL("./monaco-worker-policy.browser-worker.ts", import.meta.url), {
					type: "module",
				});
			} else {
				worker = productionGetWorker("", "editorWorkerService") as Worker;
			}
			created++;
			nativeWorker = worker;
			const terminate = worker.terminate.bind(worker);
			worker.terminate = () => {
				terminated++;
				terminate();
			};
			return worker;
		};
		environment.getWorker = getWorker;
		const model = api.editor.createModel("visit https://example.com/first", "plaintext");
		let client: Client | undefined;
		let firstResult: unknown;
		let secondResult: unknown;
		let failure: { name: string; message: string; cause: string } | undefined;
		try {
			if (path === "standalone") {
				const worker = mode === "construct" || mode === "disabled" ? ({} as Worker) : getWorker();
				const standalone = api.editor.createWebWorker<{
					inspect(): Promise<{ dom: string; text: string[] }>;
				}>({ worker });
				client = standalone as unknown as Client;
				const proxy = await standalone.withSyncedResources([model.uri]);
				firstResult = await proxy.inspect();
				if (mode === "crash") nativeWorker?.terminate();
				model.setValue("updated https://example.com/second");
				secondResult = await proxy.inspect();
			} else {
				client = new ClientConstructor(
					EditorWorkerService.workerDescriptor,
					false,
					{ getModel: (uri: Uri) => api.editor.getModel(uri) },
					new StandaloneWebWorkerService(),
				);
				const proxy = await client.workerWithSyncedResources([model.uri]);
				firstResult = await proxy.$computeLinks(model.uri.toString());
				if (mode === "crash") nativeWorker?.terminate();
				model.setValue("updated https://example.com/second");
				secondResult = await proxy.$computeLinks(model.uri.toString());
			}
		} catch (error) {
			const value = error as Error;
			failure = { name: value.name, message: value.message, cause: String(value.cause) };
		} finally {
			client?.dispose();
			model.dispose();
			environment.getWorker = productionGetWorker;
			globalThis.Worker = NativeWorker;
			// Monaco terminates a successfully created transport through a resolved Worker Promise.
			await Promise.resolve();
		}
		return {
			firstResult,
			secondResult,
			failure,
			created,
			terminated,
			originalFallbackCalls,
			synchronousInstances,
			workerCleared: client?._worker === null,
			modelManagerCleared: client?._modelManager === null,
		};
	},
};
(window as unknown as { monacoWorkerFixture: typeof fixture }).monacoWorkerFixture = fixture;
