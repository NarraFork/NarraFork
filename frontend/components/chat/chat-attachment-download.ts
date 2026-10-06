/**
 * chat-attachment-download.ts — Authorized blob download for chat attachments.
 *
 * `/api/chat/attachments/:id` sits behind session auth and a room ACL, so the
 * bytes must come through `fetch` (an `<a href>` cannot send the Authorization
 * header) and land in a blob the browser then saves. Extracted from the deleted
 * ChatAttachmentBlock so the vlist-based list and any future surface share one
 * implementation.
 */

import { absorbRenewedToken, clearTokenOnSessionFailure, getToken } from "../../lib/api";
import { apiUrl } from "../../lib/base-path";

/**
 * Ceiling on a DOWNLOAD buffered in the JS heap.
 *
 * The endpoint needs an `Authorization` header, so the bytes must come through
 * `fetch` and land in a blob rather than being handed to the browser's own
 * downloader via a plain link. That makes a download's peak memory the file's
 * full size: at the upload cap a handful of concurrent clicks can take a
 * low-memory tab down. Refusing loudly beats an OOM the user cannot attribute
 * to anything. Set at the upload cap rather than below it so no attachment the
 * product accepts becomes undownloadable.
 */
export const MAX_DOWNLOAD_BLOB_BYTES = 64 * 1024 * 1024;

/**
 * Download an attachment through the authorized endpoint.
 *
 * Returns false when the download did not start, so the caller can say so
 * instead of leaving the reader looking at a button that did nothing.
 */
export async function downloadChatAttachment(fetchUrl: string, filename: string): Promise<boolean> {
	const token = getToken();
	const headers: Record<string, string> = {};
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(apiUrl(fetchUrl), { headers });
	absorbRenewedToken(res, token ?? undefined);
	if (!res.ok) {
		await clearTokenOnSessionFailure(res);
		return false;
	}
	const blob = await res.blob();
	if (blob.size > MAX_DOWNLOAD_BLOB_BYTES) return false;
	const objectUrl = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = objectUrl;
	anchor.download = filename;
	anchor.click();
	// Revoked well after the click rather than on the next tick: a next-tick
	// revoke can beat a slower browser's own read of the URL the click just
	// started, which shows up as a download that silently produces nothing.
	setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
	return true;
}
