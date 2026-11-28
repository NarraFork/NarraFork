/**
 * The PDF preview frame must NOT be sandboxed.
 *
 * Chrome renders PDFs with its built-in viewer, and that viewer refuses to run inside a
 * sandboxed iframe for ANY sandbox value — even the empty `sandbox=""`. The frame then shows
 * Chrome's bare "This page has been blocked by Chrome" error page instead of the document.
 * Verified in a real Chrome by rendering the same blob PDF twice: sandboxed → blocked icon,
 * unsandboxed → viewer toolbar.
 *
 * The sandbox attribute looked like cheap defense-in-depth but bought nothing here: the PDF
 * viewer already runs in its own sandboxed process, and the server serves these bytes as
 * `application/pdf` with `nosniff`. `ShareFilePreview` (the share page) has always done it this
 * way for PDF and only sandboxes HTML — this test pins the file viewer and the preview modal to
 * that same rule, because the failure is invisible in unit tests that never launch a browser.
 *
 * If a future change adds a NON-PDF iframe to either component, tighten this test to assert per
 * branch instead of per file.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCES = {
	"file viewer": join(import.meta.dir, "FileViewerContent.tsx"),
	"preview modal": join(import.meta.dir, "..", "file-panel", "FilePreviewModal.tsx"),
};

/** Every `<iframe …>` tag in a file, with the text of the tag only. */
function iframeTags(source: string): string[] {
	return source.match(/<iframe\b[\s\S]*?\/>/g) ?? [];
}

describe("PDF preview iframes", () => {
	for (const [label, path] of Object.entries(SOURCES)) {
		test(`${label} renders its PDF frame without a sandbox attribute`, () => {
			const source = readFileSync(path, "utf8");
			const tags = iframeTags(source);
			expect(tags.length).toBeGreaterThan(0);
			for (const tag of tags) {
				expect(tag).not.toContain("sandbox");
			}
		});
	}

	test("the share page keeps sandboxing HTML but not PDF", () => {
		// The precedent this fix follows: an HTML payload is sandboxed, a PDF is not.
		const source = readFileSync(
			join(import.meta.dir, "..", "vlist", "render", "ShareFilePreview.tsx"),
			"utf8",
		);
		expect(source).toContain('sandbox={preview.kind === "html" ? "" : undefined}');
	});
});
