import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { FileSelection } from "@shared/file-reference";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fileReferenceApi } from "../../../lib/api/file-references";
import { narratorAttachmentApi } from "../../../lib/api/narrator-attachments";
import { ImageViewerContext } from "../../common/image-viewer-context";
import { FileReferenceScopeProvider } from "../composer/FileReferenceScope";
import {
	availableModes,
	FileViewerContent,
	fileReferenceDirectory,
	fileViewerReadMode,
} from "./FileViewerContent";

// Only the browser Monaco widget is a seam; the viewer hooks/API routing/readonly scope stay real.
mock.module("../file-editor/MonacoEditor", () => ({
	MonacoEditor: (props: { initialValue: string; readOnly: boolean }) =>
		createElement("pre", { "data-snapshot-readonly": String(props.readOnly) }, props.initialValue),
}));

const selection: FileSelection = {
	startLineNumber: 1,
	startColumn: 1,
	endLineNumber: 2,
	endColumn: 1,
};

describe("file reference source viewer", () => {
	test("inheriting narrator scope does not upgrade a legacy local preview", () => {
		expect(fileViewerReadMode(undefined)).toBe("legacy");
		expect(fileViewerReadMode("narrator", "local", false)).toBe("legacy");
	});

	test("references and remote files use only a narrator-scoped reader", () => {
		expect(fileViewerReadMode("narrator", "local", true)).toBe("scoped");
		expect(fileViewerReadMode("narrator", "Remote", false)).toBe("scoped");
		expect(fileViewerReadMode(undefined, "local", true)).toBe("missing-context");
		expect(fileViewerReadMode(undefined, "Remote", false)).toBe("missing-context");
	});

	test("line navigation forces source without changing ordinary previews", () => {
		for (const path of ["/repo/a.md", "/repo/a.json", "/repo/a.ts"]) {
			expect(availableModes(path, selection)).toEqual(["raw"]);
		}
		expect(availableModes("/repo/a.md")).toEqual(["preview", "raw"]);
		expect(availableModes("/repo/a.json")).toEqual(["node", "raw"]);
	});

	test("nested markdown resolves relative to its file directory including drive roots", () => {
		expect(fileReferenceDirectory("/repo/docs/readme.md")).toBe("/repo/docs");
		expect(fileReferenceDirectory("/readme.md")).toBe("/");
		expect(fileReferenceDirectory("C:\\docs\\readme.md")).toBe("C:/docs");
		expect(fileReferenceDirectory("C:\\readme.md")).toBe("C:/");
		expect(fileReferenceDirectory("C:/docs\\readme.md")).toBe("C:/docs");
		expect(fileReferenceDirectory("/work/a\\b.md")).toBe("/work");
		expect(fileReferenceDirectory("/work/a\\b/readme.md")).toBe("/work/a\\b");
		expect(fileReferenceDirectory("readme.md")).toBe("");
	});

	test("navigation source is read-only and inherits the parent's internal opener", async () => {
		const source = await Bun.file(new URL("./FileViewerContent.tsx", import.meta.url)).text();
		expect(source).toContain("<MonacoEditor");
		expect(source).toContain("readOnly");
		expect(source).toContain("navigationRequestId={highlightRequestId}");
		expect(source).toContain("onOpenFileTarget ?? parentScope.openFile");
		expect(source).toContain("controller.abort()");
		expect(source).toContain("fileReferenceApi.preview");
		expect(source).toContain('deviceId !== "local"');
		expect(source).not.toContain("fsWrite");
		expect(source).toContain('referenceOrigin && previewType !== "text"');
		expect(source).toContain('readerMode === "missing-context"');
		expect(source).toContain("if (scopedNarratorId)");
		expect(source).toContain("load.hash && sourceSelection && !load.truncated");
		expect(source).toContain('!referenceOrigin && deviceId === "local"');
	});
});

describe("mounted immutable snapshot viewer", () => {
	let root: Root;
	let container: HTMLDivElement;
	let previous: Map<string, PropertyDescriptor | undefined>;
	const globalKeys = [
		"window",
		"document",
		"navigator",
		"HTMLElement",
		"Element",
		"Node",
		"Text",
		"getComputedStyle",
		"matchMedia",
		"IS_REACT_ACT_ENVIRONMENT",
		"requestAnimationFrame",
		"cancelAnimationFrame",
		"fetch",
	];
	let snapshotSpy: ReturnType<typeof spyOn<typeof fileReferenceApi, "snapshot">>;
	let previewSpy: ReturnType<typeof spyOn<typeof fileReferenceApi, "preview">>;
	let selectionSpy: ReturnType<typeof mock>;
	let fetchSpy: ReturnType<typeof mock>;
	beforeEach(() => {
		previous = new Map(
			globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
		);
		const { window } = parseHTML("<!doctype html><html><body></body></html>");
		Object.defineProperty(window, "navigator", {
			configurable: true,
			value: { platform: "Linux", userAgent: "Chrome", maxTouchPoints: 0 },
		});
		Object.assign(window, {
			getComputedStyle: () => ({
				getPropertyValue: () => "",
				marginLeft: "0px",
				marginRight: "0px",
				paddingLeft: "0px",
				paddingRight: "0px",
				direction: "ltr",
			}),
		});
		Object.assign(globalThis, {
			window,
			document: window.document,
			navigator: { platform: "Linux", userAgent: "Chrome", maxTouchPoints: 0, vendor: "" },
			HTMLElement: window.HTMLElement,
			Element: window.Element,
			Node: window.Node,
			Text: window.Text,
			getComputedStyle: window.getComputedStyle,
			matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
			IS_REACT_ACT_ENVIRONMENT: true,
			requestAnimationFrame: (callback: FrameRequestCallback) =>
				setTimeout(() => callback(performance.now()), 0),
			cancelAnimationFrame: (handle: number) => clearTimeout(handle),
		});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		selectionSpy = mock(() => {});
		fetchSpy = mock(async () => {
			throw new Error("Snapshot must not fetch a live file");
		});
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		previewSpy = spyOn(fileReferenceApi, "preview").mockImplementation(async () => {
			throw new Error("Snapshot must never fall back to live preview");
		});
		snapshotSpy = spyOn(fileReferenceApi, "snapshot");
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		snapshotSpy.mockRestore();
		previewSpy.mockRestore();
		for (const [key, value] of previous) {
			if (value) Object.defineProperty(globalThis, key, value);
			else Reflect.deleteProperty(globalThis, key);
		}
	});
	function response(text: string, referenceId = "ref") {
		return {
			source: "captured_snapshot" as const,
			readOnly: true as const,
			content: text,
			hash: "a".repeat(64),
			capturedAt: "2026-10-12",
			reference: {
				id: referenceId,
				deviceId: "local",
				path: "/original/file.txt",
				label: "file.txt",
			},
		};
	}
	async function render(narratorId = "n1", messageId = "m1", attachment = false) {
		await act(async () =>
			root.render(
				createElement(
					MantineProvider,
					{ env: "test" },
					createElement(
						ImageViewerContext.Provider,
						{ value: { open() {} } },
						createElement(FileReferenceScopeProvider, {
							value: { narratorId, setSelection: selectionSpy },
							// biome-ignore lint/correctness/noChildrenProp: the provider requires children in its typed props.
							children: createElement(FileViewerContent, {
								narratorId,
								filePath: "/original/file.txt",
								deviceId: "local",
								referenceOrigin: true,
								capturedSnapshot: attachment ? undefined : { messageId, referenceId: "ref" },
								attachmentPreview: attachment
									? { messageId, attachmentId: "attachment" }
									: undefined,
								onFileReferenceSelectionChange: selectionSpy,
							}),
						}),
					),
				),
			),
		);
	}
	test("original attachment uses only occurrence client and is readonly without save or live fallback", async () => {
		const attachmentSpy = spyOn(narratorAttachmentApi, "preview").mockResolvedValue({
			content: "attachment original bytes",
			size: 25,
			truncated: false,
		});
		try {
			await render("n1", "m1", true);
			expect(attachmentSpy.mock.calls[0].slice(0, 2)).toEqual([
				"n1",
				{ messageId: "m1", attachmentId: "attachment" },
			]);
			expect(container.querySelector('[data-snapshot-readonly="true"]')?.textContent).toBe(
				"attachment original bytes",
			);
			expect(previewSpy).not.toHaveBeenCalled();
			expect(snapshotSpy).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(selectionSpy).not.toHaveBeenCalled();
			expect(container.querySelector('[aria-label="fileViewer.download"]')).toBeNull();
		} finally {
			attachmentSpy.mockRestore();
		}
	});

	test("requests only the frozen occurrence and renders readonly without live preview/download or composer selection", async () => {
		snapshotSpy.mockResolvedValue(response("captured bytes"));
		await render();
		expect(snapshotSpy.mock.calls[0].slice(0, 2)).toEqual([
			"n1",
			{ messageId: "m1", referenceId: "ref" },
		]);
		expect(container.querySelector('[data-snapshot-readonly="true"]')?.textContent).toBe(
			"captured bytes",
		);
		expect(previewSpy).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(selectionSpy).not.toHaveBeenCalled();
	});
	test("unknown source is explicitly unavailable and has no live fallback", async () => {
		snapshotSpy.mockRejectedValue(new Error("Original captured reference unavailable"));
		await render();
		expect(container.textContent).toContain("unavailable");
		expect(previewSpy).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
	test("late bytes from the prior narrator/message cannot overwrite the new snapshot", async () => {
		let release!: (value: ReturnType<typeof response>) => void;
		const first = new Promise<ReturnType<typeof response>>((resolve) => {
			release = resolve;
		});
		snapshotSpy.mockImplementation((narratorId) =>
			narratorId === "n1" ? first : Promise.resolve(response("new captured bytes")),
		);
		await render("n1", "m1");
		const originalSignal = snapshotSpy.mock.calls[0][2];
		await render("n2", "m2");
		expect(originalSignal?.aborted).toBe(true);
		await act(async () => {
			release(response("late old bytes"));
			await first;
		});
		expect(container.textContent).toContain("new captured bytes");
		expect(container.textContent).not.toContain("late old bytes");
		expect(previewSpy).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
