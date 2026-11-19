/**
 * Limits shared by the route (main thread) and the parser (worker).
 *
 * Kept in their own module on purpose: the HTTP route must NOT import the parser entry, or
 * every server process would load the ZIP/OOXML reader on the main thread for one constant.
 */

/** Matches the binary preview cap the UI already applies to images and PDFs. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** Per-picture cap; a larger embedded image is reported as omitted instead of extracted. */
export const MAX_DOCUMENT_ASSET_BYTES = 20 * 1024 * 1024;

/**
 * Picture types the preview must not return.
 *
 * `image/svg+xml` is an active document. The client stores asset bytes in a same-origin blob,
 * and a blob does not inherit a response CSP, so those bytes must never leave the server.
 * EMF and WMF are not painted by the browser. The parser omits them; the asset route refuses
 * the same types again so a response body cannot be one of them.
 */
export const OMITTED_DOCUMENT_IMAGE_MIMES: ReadonlySet<string> = new Set([
	"image/svg+xml",
	"image/emf",
	"image/wmf",
]);
