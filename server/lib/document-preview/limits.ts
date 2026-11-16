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
