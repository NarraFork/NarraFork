import "@mantine/core/styles.css";
// Fixture-only folding contribution: production's lightweight editor keeps folding off.
import "monaco-editor/features/folding/register";
import { MantineProvider } from "@mantine/core";
import type { FileSelection } from "@shared/file-reference";
import i18n from "i18next";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { initReactI18next } from "react-i18next";
import narratorEnglish from "../../../locales/en/narrator.json";
import { MonacoEditor, type MonacoEditorHandle } from "./MonacoEditor";
import { loadMonaco } from "./monaco-loader";

const handles: (MonacoEditorHandle | null)[] = [null, null];
const quotes: { index: number; selection: FileSelection }[] = [];
const errors: string[] = [];
const source = Array.from(
	{ length: 180 },
	(_, index) => `line ${index + 1}: alpha beta gamma`,
).join("\n");
let configure: (options: Options) => void;
interface Options {
	text?: string;
	readOnly?: boolean;
	reason?: string | null;
	callback?: boolean;
	owner?: string;
	mounted?: boolean;
}
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
function App() {
	const [options, setOptions] = useState<Options>({});
	configure = setOptions;
	return (
		<MantineProvider forceColorScheme="dark">
			<div style={{ display: "flex", gap: 24, padding: 20 }}>
				{[0, 1].map((index) => (
					<div key={index} data-editor={index} style={{ width: 480, height: 320 }}>
						{(index === 1 || options.mounted !== false) && (
							<MonacoEditor
								initialValue={
									options.text ?? (index === 0 ? source : "second editor\nno selection")
								}
								documentKey={`${index}/${options.owner ?? "a"}`}
								filePath={`${index}.txt`}
								onReady={(handle) => {
									handles[index] = handle;
								}}
								onError={(error) => {
									errors.push(error.message);
								}}
								readOnly={index === 0 && options.readOnly}
								quoteSelectionDisabledReason={index === 0 ? options.reason : null}
								onQuoteSelection={
									options.callback === false
										? undefined
										: (selection) => {
												quotes.push({ index, selection });
											}
								}
							/>
						)}
					</div>
				))}
			</div>
		</MantineProvider>
	);
}
await i18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	defaultNS: "narrator",
	resources: { en: { narrator: narratorEnglish } },
	interpolation: { escapeValue: false },
});
root.render(<App />);
export const fixture = {
	ready: () => handles.every(Boolean),
	configure: (options: Options) => configure(options),
	select(index: number, range: FileSelection) {
		handles[index]?.getEditor()?.setSelection(range);
	},
	focus(index: number) {
		handles[index]?.focus();
	},
	scroll(index: number, top: number) {
		handles[index]?.getEditor()?.setScrollTop(top);
	},
	scrollToOverflow(index: number) {
		const view = handles[index]?.getEditor();
		view?.setScrollLeft(view.getScrollWidth());
		view?.setScrollTop(0);
	},
	async fold(index: number, start: number, end: number) {
		const view = handles[index]?.getEditor();
		if (!view) throw new Error("Missing editor for folding");
		const selection = view.getSelection();
		const top = view.getScrollTop();
		view.updateOptions({ folding: true });
		view.setSelection({ startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 2 });
		const action = view.getAction("editor.createFoldingRangeFromSelection");
		if (!action) throw new Error("Native folding contribution unavailable");
		await action.run();
		if (selection) view.setSelection(selection);
		view.setScrollTop(top);
	},
	async startWorker() {
		await loadMonaco();
		const environment = (
			globalThis as typeof globalThis & {
				MonacoEnvironment: { getWorker(id: string, label: string): Worker };
			}
		).MonacoEnvironment;
		return !!environment.getWorker("", "editorWorkerService");
	},
	snapshot(index = 0) {
		const handle = handles[index];
		const view = handle?.getEditor();
		const model = handle?.getModel();
		const host = document.querySelector(`[data-editor="${index}"]`);
		if (!host) throw new Error("Missing fixture editor host");
		const button = host.querySelector<HTMLButtonElement>("[data-monaco-quote-selection]");
		const rect = button?.getBoundingClientRect();
		const gutter = host.querySelector(".line-numbers")?.getBoundingClientRect();
		const selection = view?.getSelection();
		return {
			modelId: model?.id,
			version: model?.getVersionId(),
			alternativeVersion: model?.getAlternativeVersionId(),
			canUndo: model?.canUndo(),
			renderingLimit: view?.getRawOptions().stopRenderingLineAfter,
			renderedText: host.querySelector(".view-lines")?.textContent ?? "",
			value: model?.getValue(),
			selection: selection
				? {
						startLineNumber: selection.startLineNumber,
						startColumn: selection.startColumn,
						endLineNumber: selection.endLineNumber,
						endColumn: selection.endColumn,
					}
				: null,
			contentLeft: view?.getLayoutInfo().contentLeft,
			contentHeight: view?.getContentHeight(),
			scrollTop: view?.getScrollTop(),
			button:
				button && rect
					? {
							disabled: button.disabled,
							title: button.title,
							label: button.getAttribute("aria-label"),
							left: rect.left,
							right: rect.right,
							top: rect.top,
							visible:
								!!rect.width &&
								!!rect.height &&
								rect.bottom > host.getBoundingClientRect().top &&
								rect.top < host.getBoundingClientRect().bottom,
							lineNumberLeft: gutter?.left,
						}
					: null,
			quotes: [...quotes],
			errors: [...errors],
		};
	},
	unmount: () => root.unmount(),
};
(window as unknown as { monacoQuoteFixture: typeof fixture }).monacoQuoteFixture = fixture;
