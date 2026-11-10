/**
 * archive-viewable.ts — which files open in the archive browser.
 *
 * Kept apart from ArchiveViewerContent so the file panel can decide synchronously
 * without loading the viewer (and Monaco) for every file it routes.
 */

/** Zip-family formats whose entries users routinely want to inspect. */
const ARCHIVE_EXTENSIONS = new Set([
	"zip",
	"jar",
	"war",
	"ear",
	"aar",
	"apk",
	"whl",
	"vsix",
	"nupkg",
	"xpi",
	"epub",
]);

/** Lower-cased final extension of a path in either separator style; "" when there is none. */
export function archiveExtension(filePath: string): string {
	const name = filePath.split(/[\\/]/u).pop()?.toLowerCase() ?? "";
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1);
}

export function isArchiveViewable(filePath: string): boolean {
	return ARCHIVE_EXTENSIONS.has(archiveExtension(filePath));
}
