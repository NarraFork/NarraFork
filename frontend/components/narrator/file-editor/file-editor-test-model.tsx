import type { FileSelection } from "@shared/file-reference";
import type { editor } from "monaco-editor";
import { useEffect, useRef } from "react";
import type { MonacoEditorHandle, MonacoEditorProps } from "./MonacoEditor";

/** Test-only public-model adapter. Real Monaco rendering/IME/navigation is tested in Chromium. */
export class TestEditorModel {
	text: string;
	revision = 1;
	alt = 1;
	undoEntries: { text: string; alt: number }[] = [];
	redoEntries: { text: string; alt: number }[] = [];
	selected: FileSelection | null = null;
	navigation: FileSelection | undefined;
	props: MonacoEditorProps;
	constructor(props: MonacoEditorProps) {
		this.props = props;
		this.text = props.initialValue.replace(/\r\n?/g, "\n");
	}
	getVersionId = () => this.revision;
	getAlternativeVersionId = () => this.alt;
	getValueLength = () => this.text.length;
	getValue = () => this.text;
	createSnapshot = () => {
		let text: string | null = this.text;
		return {
			read() {
				const chunk = text;
				text = null;
				return chunk;
			},
		};
	};
	setValue = (text: string) => {
		this.text = text;
		this.alt = ++this.revision;
		this.undoEntries = [];
		this.redoEntries = [];
		this.selected = null;
		this.props.onSelectionChange?.(null, false);
		this.publish();
	};
	edit(text: string) {
		this.undoEntries.push({ text: this.text, alt: this.alt });
		this.redoEntries = [];
		this.text = text;
		this.alt = ++this.revision;
		this.publish();
	}
	select(next: FileSelection | null) {
		this.selected = next;
		this.props.onSelectionChange?.(next, true);
	}
	undo = () => {
		const previous = this.undoEntries.pop();
		if (!previous) return;
		this.redoEntries.push({ text: this.text, alt: this.alt });
		this.text = previous.text;
		this.alt = previous.alt;
		this.revision++;
		this.publish();
	};
	redo = () => {
		const next = this.redoEntries.pop();
		if (!next) return;
		this.undoEntries.push({ text: this.text, alt: this.alt });
		this.text = next.text;
		this.alt = next.alt;
		this.revision++;
		this.publish();
	};
	publish() {
		this.props.onDocumentChange?.({
			revision: this.revision,
			alternativeVersionId: this.alt,
			length: this.text.length,
			lines: this.text.split("\n").length,
			canUndo: !!this.undoEntries.length,
			canRedo: !!this.redoEntries.length,
			language: "plaintext",
			languageSupported: true,
			longLine: false,
		});
	}
	getModel = () => this as unknown as editor.ITextModel;
	focus = () => {};
	getEditor = () => this as unknown as editor.IStandaloneCodeEditor;
}
export const mountedTestModels = new Map<string, TestEditorModel>();
export function TestMonacoEditor(props: MonacoEditorProps) {
	const ref = useRef<TestEditorModel | null>(null);
	if (!ref.current) ref.current = new TestEditorModel(props);
	const model = ref.current;
	model.props = props;
	useEffect(() => {
		mountedTestModels.set(props.documentKey, model);
		props.onReady?.(model as MonacoEditorHandle);
		model.publish();
		return () => {
			mountedTestModels.delete(props.documentKey);
			model.props.onReady?.(null);
		};
	}, [model, props.documentKey, props.onReady]);
	const navigationKey = JSON.stringify([props.selection, props.navigationRequestId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: navigation is an explicit metadata request
	useEffect(() => {
		model.navigation = props.selection;
		model.selected = null;
		props.onSelectionChange?.(null, false);
	}, [model, navigationKey]);
	return (
		<div
			data-monaco-test-editor
			data-document-key={props.documentKey}
			data-navigation={JSON.stringify(model.navigation)}
		/>
	);
}
