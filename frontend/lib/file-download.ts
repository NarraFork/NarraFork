/**
 * file-download.ts — hand bytes to the browser so it saves them to disk.
 *
 * Two shapes exist, and the difference is who carries the credential:
 *
 *  - `saveBlobAsFile` — for a fetch that already returned the bytes. The URL needed an
 *    `Authorization` header, so the browser could not be pointed at it and the response had
 *    to be buffered into a Blob first. That costs a full copy in page memory and gives up
 *    progress, Range and resumability, so it is now the fallback rather than the default.
 *  - `fsDownloadUrl` — for a URL that carries its own credential (a single-use
 *    download ticket). Navigating to it lets the browser stream straight to disk: constant
 *    memory, real progress bar, resumable, and no "download not triggered by a user
 *    gesture" interference, because the navigation is the download rather than something
 *    that happens after an `await`.
 *
 * Both go through a synthetic anchor so the page never navigates away.
 */

import { apiUrl } from "@frontend/lib/base-path";

/** Click a synthetic anchor to start a download without navigating away. */
export function triggerBlobDownload(url: string, filename: string): void {
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.rel = "noopener";
	document.body.appendChild(link);
	link.click();
	link.remove();
}

/**
 * The URL that downloads `path` under a ticket minted by `api.fsDownloadTicket`.
 *
 * Built with `apiUrl` rather than string concatenation so a mount prefix (`/nf/`,
 * code-server's `/proxy/7778/`) is applied. `filename` is only a hint: the server's
 * `Content-Disposition` wins, and it is the server that knows the real name.
 */
export function fsDownloadUrl(ticket: string, filename: string): void {
	triggerBlobDownload(apiUrl(`/api/fs/download?ticket=${encodeURIComponent(ticket)}`), filename);
}

/**
 * Save a Blob under `filename`.
 *
 * The object URL is revoked on a timer rather than immediately: revoking in the
 * same tick can cancel a download the browser has not started reading yet.
 */
export function saveBlobAsFile(blob: Blob, filename: string, onReleased?: () => void): void {
	const objectUrl = URL.createObjectURL(blob);
	const release = () => {
		try {
			URL.revokeObjectURL(objectUrl);
		} finally {
			onReleased?.();
		}
	};
	let started = false;
	try {
		triggerBlobDownload(objectUrl, filename);
		started = true;
	} finally {
		if (started) setTimeout(release, 10_000);
		else release();
	}
}
