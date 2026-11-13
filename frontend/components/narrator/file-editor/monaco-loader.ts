import type * as Monaco from "monaco-editor/editor/editor.api";
import { installMonacoWorkerPolicy, observeMonacoStandaloneWorkers } from "./monaco-worker-policy";

export type MonacoAPI = typeof Monaco;
let pending: Promise<MonacoAPI> | undefined;

/** Browser-only boundary: importing components/helpers in Bun never evaluates Monaco CSS. */
export function loadMonaco(): Promise<MonacoAPI> {
	if (typeof window === "undefined") return Promise.reject(new Error("Monaco requires a browser"));
	pending ??= (async () => {
		const environment = globalThis as typeof globalThis & {
			MonacoEnvironment?: Monaco.Environment;
		};
		environment.MonacoEnvironment = {
			...environment.MonacoEnvironment,
			getWorker: () =>
				new Worker(new URL("./monaco.worker.ts", import.meta.url), {
					type: "module",
					name: "narrafork-monaco-editor",
				}),
		};
		// getWorker throwing is insufficient: Monaco catches it and otherwise runs synchronously.
		// Patch the shared failure boundary before editor.api can expose ANY service/createWebWorker.
		const { EditorWorkerClient } = await import(
			"monaco-editor/editor/browser/services/editorWorkerService"
		);
		installMonacoWorkerPolicy(EditorWorkerClient);
		const api = await import("monaco-editor/editor/editor.api");
		observeMonacoStandaloneWorkers(api.editor);
		// Only editing features. No find UI, diagnostics, TS server or semantic token workers.
		await Promise.all([
			import("monaco-editor/features/clipboard/register"),
			import("monaco-editor/features/wordOperations/register"),
			import("monaco-editor/features/linesOperations/register"),
			import("monaco-editor/features/bracketMatching/register"),
			import("monaco-editor/features/comment/register"),
			import("monaco-editor/features/multicursor/register"),
			import("monaco-editor/features/indentation/register"),
			import("monaco-editor/features/tokenization/register"),
			import("./monaco-editor.css"),
		]);
		return api;
	})().catch((error) => {
		pending = undefined;
		throw error;
	});
	return pending;
}
