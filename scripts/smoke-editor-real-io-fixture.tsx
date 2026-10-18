// Browser-only fixture. All document requests use the real route/service;
// the synthetic identity is supplied by the isolated test server, not a JWT test.
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import i18next from "i18next";
import type { editor as Monaco } from "monaco-editor/editor/editor.api";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { editorDocumentRegistry } from "../frontend/components/narrator/file-editor/editor-document-registry";
import { getEditorWorkerDiagnostics } from "../frontend/components/narrator/file-editor/editor-worker-client";
import { FileEditorContent } from "../frontend/components/narrator/file-editor/FileEditorContent";
import { loadMonaco } from "../frontend/components/narrator/file-editor/monaco-loader";
import { FilePanelContent } from "../frontend/components/narrator/file-panel/FilePanelContent";
import translations from "../frontend/locales/en/narrator.json";

declare global {
	interface Window {
		__editorRealIo: {
			state(): {
				ready: boolean;
				dirty: boolean;
				readOnly: boolean;
				revision: number;
				length: number;
				lines: number;
				firstLine: string;
				workers: ReturnType<typeof getEditorWorkerDiagnostics>;
			};
			fingerprint(): Promise<{ bytes: number; sha256: string }>;
			retainedFingerprint(): Promise<{ bytes: number; sha256: string }>;
			invalidateContext(): void;
			reopen(): void;
			commitResponse(index: number): {
				status: number;
				body: string | null;
				error: string | null;
			} | null;
			focus(): void;
			sharedState(): {
				models: number;
				views: number;
				shared: boolean;
				sameText: boolean;
				selections: number[];
				scrolls: number[];
			};
			prepareIndependentViews(): void;
			focusSecondary(): void;
			closeSecondary(): void;
			dispose(): void;
		};
	}
}

const response = await fetch("/api/fixture/config", { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`Fixture config: ${response.status}`);
const config: { path: string; narratorId: string; hostGate?: boolean; deviceId?: string } =
	await response.json();
// The small-file scenario uses the actual ordinary host and unmodified metadata/size gate.
const FilePane = config.hostGate ? FilePanelContent : FileEditorContent;
// Observe actual browser fetch responses, not CDP's evictable response-body cache.
// Only two small commit receipts are cloned; uploads and 20 MiB content are untouched.
const nativeFetch = window.fetch;
const commitResponses: NonNullable<ReturnType<Window["__editorRealIo"]["commitResponse"]>>[] = [];
const receiptReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
window.fetch = Object.assign(async (...args: Parameters<typeof nativeFetch>) => {
	const result = await nativeFetch.apply(window, args);
	const [input, init] = args;
	const method = init?.method ?? (input instanceof Request ? input.method : "GET");
	const url = new URL(result.url);
	if (
		method.toUpperCase() === "POST" &&
		url.origin === window.location.origin &&
		url.pathname.startsWith(
			`/api/narrators/${encodeURIComponent(config.narratorId)}/editor-documents/`,
		) &&
		url.pathname.endsWith("/commit") &&
		commitResponses.length < 2
	) {
		const captured = {
			status: result.status,
			body: null,
			error: null,
		} as (typeof commitResponses)[number];
		commitResponses.push(captured);
		void (async () => {
			const reader = result.clone().body?.getReader();
			if (!reader) throw new Error("Commit receipt has no response body");
			receiptReaders.add(reader);
			const timer = setTimeout(() => {
				captured.error = "Commit receipt exceeded its 10s read budget";
				void reader.cancel().catch(() => {});
			}, 10_000);
			try {
				const decoder = new TextDecoder();
				let bytes = 0;
				let body = "";
				while (true) {
					const { done, value } = await reader.read();
					if (captured.error) throw new Error(captured.error);
					if (done) break;
					bytes += value.byteLength;
					if (bytes > 64 * 1024) throw new Error("Commit receipt exceeded 64 KiB");
					body += decoder.decode(value, { stream: true });
				}
				captured.body = body + decoder.decode();
			} finally {
				clearTimeout(timer);
				receiptReaders.delete(reader);
				void reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		})().catch((error) => {
			captured.error = String(error).slice(0, 400);
		});
	}
	// Observation never substitutes a response or delays the application consuming it.
	return result;
}, nativeFetch);
const api = await loadMonaco();
const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	resources: { en: { narrator: translations } },
	interpolation: { escapeValue: false },
});
let editor: Monaco.IStandaloneCodeEditor | undefined;
let dirty = false;
const views = new Set<Monaco.IStandaloneCodeEditor>();
const created = api.editor.onDidCreateEditor((instance) => {
	const view = instance as Monaco.IStandaloneCodeEditor;
	editor ??= view;
	views.add(view);
	view.onDidDispose(() => {
		views.delete(view);
		if (editor === view) editor = [...views][0];
	});
});
const host = document.getElementById("root");
if (!host) throw new Error("Missing fixture root");
const root = createRoot(host);
let documentGeneration = 0;
// Read-only test observation; never used to construct a golden or perform disk writes.
async function fingerprintModel(model: Monaco.ITextModel | null | undefined) {
	if (!model) throw new Error("Model not ready");
	const bytes = new TextEncoder().encode(model.getValue());
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return {
		bytes: bytes.byteLength,
		sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
			"",
		),
	};
}
function renderViews(secondary = true) {
	root.render(
		<MantineProvider forceColorScheme="dark">
			<I18nextProvider i18n={i18n}>
				<div style={{ display: "flex", height: "100%" }}>
					<div key="primary" style={{ width: "50%", height: "100%" }}>
						<FilePane
							rawProtocol={false}
							key={documentGeneration}
							filePath={config.path}
							narratorId={config.narratorId}
							deviceId={config.deviceId}
							referenceOrigin
							onDirtyChange={(value) => {
								dirty = value;
							}}
						/>
					</div>
					{secondary && (
						<div key="secondary" style={{ width: "50%", height: "100%" }}>
							<FilePane
								rawProtocol={false}
								filePath={config.path}
								narratorId={config.narratorId}
								deviceId={config.deviceId}
								referenceOrigin
							/>
						</div>
					)}
				</div>
			</I18nextProvider>
		</MantineProvider>,
	);
}
// Remote acceptance exercises one ordinary file panel; local scenarios also test shared views.
renderViews(!config.deviceId);
window.__editorRealIo = {
	state() {
		const model = editor?.getModel();
		return {
			ready: !!model,
			dirty,
			readOnly: !!editor?.getRawOptions().readOnly,
			revision: model?.getVersionId() ?? 0,
			length: model?.getValueLength() ?? 0,
			lines: model?.getLineCount() ?? 0,
			firstLine: model?.getLineContent(1).slice(0, 128) ?? "",
			workers: getEditorWorkerDiagnostics(),
		};
	},
	fingerprint() {
		return fingerprintModel(editor?.getModel());
	},
	retainedFingerprint() {
		return fingerprintModel(api.editor.getModels().find((model) => model !== editor?.getModel()));
	},
	invalidateContext() {
		editorDocumentRegistry.invalidateNarrator(
			config.narratorId,
			translations["fileEditor.identityChanged"],
		);
	},
	reopen() {
		documentGeneration++;
		renderViews(false);
	},
	commitResponse(index) {
		return commitResponses[index] ?? null;
	},
	sharedState() {
		const active = [...views];
		return {
			models: api.editor.getModels().length,
			views: active.length,
			shared: active.length === 2 && active[0].getModel() === active[1].getModel(),
			sameText: active.every(
				(view) => view.getModel()?.getLineContent(1) === editor?.getModel()?.getLineContent(1),
			),
			selections: active.map((view) => view.getPosition()?.lineNumber ?? 0),
			scrolls: active.map((view) => view.getScrollTop()),
		};
	},
	prepareIndependentViews() {
		const active = [...views];
		active[0]?.setPosition({ lineNumber: 1, column: 1 });
		active[0]?.setScrollTop(0);
		active[1]?.setPosition({ lineNumber: 40, column: 3 });
		active[1]?.setScrollTop(700);
	},
	focusSecondary() {
		[...views][1]?.focus();
	},
	closeSecondary() {
		renderViews(false);
	},
	focus() {
		editor?.focus();
	},
	dispose() {
		window.fetch = nativeFetch;
		for (const reader of receiptReaders) void reader.cancel().catch(() => {});
		created.dispose();
		root.unmount();
		editorDocumentRegistry.shutdown();
	},
};
