// Only the private module consumed by the version-checked adapter. Never imply a public API.
declare module "monaco-editor/editor/browser/services/editorWorkerService" {
	export const EditorWorkerClient: unknown;
	export const EditorWorkerService: { workerDescriptor: unknown };
}
declare module "monaco-editor/editor/standalone/browser/services/standaloneWebWorkerService" {
	export class StandaloneWebWorkerService {
		createWorkerClient(descriptor: unknown): unknown;
	}
}
declare module "monaco-editor/editor/common/services/editorWebWorker" {
	export const EditorWorker: { prototype: object };
}
declare module "monaco-editor/editor/editor.worker" {
	export function initialize(
		callback: (context: { getMirrorModels(): { getValue(): string }[] }) => object,
	): void;
}
