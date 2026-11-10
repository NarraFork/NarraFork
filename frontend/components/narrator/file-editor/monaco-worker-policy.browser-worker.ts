// Test-only real foreign-module Worker: exercise Monaco's standalone createWebWorker subclass.
import { initialize } from "monaco-editor/editor/editor.worker";

initialize((context) => ({
	inspect: () => ({
		dom: typeof (globalThis as { document?: unknown }).document,
		text: context.getMirrorModels().map((model) => model.getValue()),
	}),
}));
