/**
 * Which Word file extensions route to the document preview.
 *
 * Shared by the preview-type classifier (`FilePreviewModal`) and the viewer's mode list
 * (`file-viewer-modes`) so the two cannot drift: a path classified as a document must also
 * expose exactly one mode (preview), never `raw` — a ZIP container read as text is garbage.
 *
 * Extension only decides the CLIENT route. The server re-decides the real format from the
 * bytes (a `.docx` that is actually an OLE file is refused there, never parsed).
 */

const DOCX_EXTENSIONS = new Set(["docx", "docm"]);
const LEGACY_DOC_EXTENSIONS = new Set(["doc", "dot"]);

function extensionOf(filePath: string): string | null {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return null;
	return filePath.slice(dot + 1).toLowerCase();
}

/** OOXML Word document: a ZIP the server can render read-only. */
export function isDocumentFilePath(filePath: string): boolean {
	const extension = extensionOf(filePath);
	return extension !== null && DOCX_EXTENSIONS.has(extension);
}

/** Legacy binary Word file (OLE): refused with a reason, never read as text. */
export function isLegacyDocumentFilePath(filePath: string): boolean {
	const extension = extensionOf(filePath);
	return extension !== null && LEGACY_DOC_EXTENSIONS.has(extension);
}

/**
 * URL scheme for a picture embedded in a document.
 *
 * A DOCX picture is a ZIP entry, not a file the client may read, so the parser writes
 * `nf-doc-asset:?doc=<document path>&id=<asset id>` into the Markdown. The document path rides
 * in the URL because markdown images are rendered by a react-markdown callback with no channel
 * for props — the component must be able to resolve the picture from the `src` alone.
 */
export const DOCUMENT_ASSET_SCHEME = "nf-doc-asset:";

export function buildDocumentAssetUrl(documentPath: string, assetId: string): string {
	return `${DOCUMENT_ASSET_SCHEME}?doc=${encodeURIComponent(documentPath)}&id=${encodeURIComponent(assetId)}`;
}

export function isDocumentAssetUrl(url: string | undefined): boolean {
	return !!url?.startsWith(DOCUMENT_ASSET_SCHEME);
}
