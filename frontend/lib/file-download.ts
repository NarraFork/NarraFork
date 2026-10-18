/**
 * file-download.ts — save a fetched Blob to disk.
 *
 * Every authenticated download in the app has the same shape: the URL needs an
 * `Authorization` header, so the browser cannot be pointed at it directly and the
 * bytes must be fetched, wrapped in an object URL, and handed to a synthetic
 * anchor. This module owns that dance so call sites do not each re-implement it
 * (and re-forget the revoke).
 */

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
