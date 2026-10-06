import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import i18next from "i18next";
import type { editor as Monaco } from "monaco-editor/editor/editor.api";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { getEditorWorkerDiagnostics } from "../frontend/components/narrator/file-editor/editor-worker-client";
import { FileEditorContent } from "../frontend/components/narrator/file-editor/FileEditorContent";
import { loadMonacoLanguage } from "../frontend/components/narrator/file-editor/monaco-languages";
import { loadMonaco } from "../frontend/components/narrator/file-editor/monaco-loader";
import { editorDocumentApi } from "../frontend/lib/api/editor-documents";
import translations from "../frontend/locales/en/narrator.json";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
export async function mountFullFixture(host: HTMLElement, filePath: string) {
	const api = await loadMonaco();
	await loadMonacoLanguage(api, filePath);
	const i18n = i18next.createInstance();
	await i18n.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		resources: { en: { narrator: translations } },
		interpolation: { escapeValue: false },
	});
	let view: Monaco.IStandaloneCodeEditor | undefined;
	let acquiredAt = 0;
	let dirty = false;
	let dirtyEvents = 0;
	const oldSource = editorDocumentApi.source;
	// Observe the real transport decoder's completion, without changing its result.
	editorDocumentApi.source = async (...args) => {
		const text = await oldSource(...args);
		acquiredAt = performance.now();
		return text;
	};
	const created = api.editor.onDidCreateEditor((editor) => {
		view ??= editor as Monaco.IStandaloneCodeEditor;
	});
	const root = createRoot(host);
	const render = () =>
		root.render(
			createElement(
				MantineProvider,
				{ forceColorScheme: "dark" },
				createElement(
					I18nextProvider,
					{ i18n },
					createElement(FileEditorContent, {
						filePath,
						narratorId: "fixture-narrator",
						referenceOrigin: true,
						onDirtyChange: (next) => {
							dirty = next;
							dirtyEvents++;
						},
					}),
				),
			),
		);
	const start = performance.now();
	render();
	while (!view?.getModel() && performance.now() - start < 30_000) await frame();
	if (!view?.getModel())
		throw new Error(`Full fixture did not create a model: ${host.innerText.slice(0, 1000)}`);
	const editor = view;
	const model = editor.getModel();
	if (!model) throw new Error("Full fixture model disappeared");
	const selectedText = () => {
		const selection = editor.getSelection();
		return selection ? model.getValueInRange(selection).slice(0, 100) : "";
	};
	const state = () => ({
		dirty,
		dirtyEvents,
		revision: model.getVersionId(),
		length: model.getValueLength(),
		sourceAcquiredAt: acquiredAt,
		query: host.querySelector<HTMLInputElement>('input[name="search"]')?.value,
		searchText: host.querySelector("[data-editor-search-panel]")?.textContent?.slice(0, 1000),
		searchVisible: !!host.querySelector('input[name="search"]'),
		selectedText: selectedText(),
		alerts: Array.from(host.querySelectorAll('[role="alert"]'))
			.map((node) => node.textContent?.slice(0, 300))
			.slice(0, 8),
	});
	return {
		editor,
		model,
		acquiredAt,
		mountMs: performance.now() - start,
		root,
		render,
		state,
		diagnostics: getEditorWorkerDiagnostics,
		async prepareSave() {
			// Typing above an exact 20MiB source legitimately exceeds the save ceiling.
			// Remove a small suffix as an explicit user edit before the valid-save check.
			const length = model.getValueLength();
			const from = model.getPositionAt(Math.max(0, length - 1024));
			const end = model.getPositionAt(length);
			editor.pushUndoStop();
			editor.executeEdits("fixture-save-budget", [
				{
					range: new api.Range(from.lineNumber, from.column, end.lineNumber, end.column),
					text: "",
				},
			]);
			editor.pushUndoStop();
			await frame();
		},
		async save() {
			host.querySelector<HTMLButtonElement>('[aria-label="Save"]')?.click();
			await frame();
		},
		async preview() {
			const before = model.id;
			const revision = model.getVersionId();
			const renderRadio = host.querySelector<HTMLInputElement>(
				'input[type="radio"]:not([value="raw"])',
			);
			if (!renderRadio) return { supported: false };
			renderRadio.click();
			await frame();
			await frame();
			const preview = !!host.querySelector("[data-file-editor-preview]");
			const budgetNotice =
				host.querySelector("[data-file-editor-preview]")?.textContent?.slice(0, 1000) ?? "";
			host.querySelector<HTMLInputElement>('input[type="radio"][value="raw"]')?.click();
			await frame();
			await frame();
			return {
				supported: true,
				preview,
				modelPreserved: editor.getModel()?.id === before,
				revisionPreserved: model.getVersionId() === revision,
				budgetNotice,
			};
		},
		dispose() {
			created.dispose();
			root.unmount();
			editorDocumentApi.source = oldSource;
		},
	};
}
export type FullFixture = Awaited<ReturnType<typeof mountFullFixture>>;
