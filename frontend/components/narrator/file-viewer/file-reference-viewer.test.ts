import { describe, expect, test } from "bun:test";
import type { FileSelection } from "@shared/file-reference";
import { availableModes, fileReferenceDirectory, fileViewerReadMode } from "./FileViewerContent";

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
