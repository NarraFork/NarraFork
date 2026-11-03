/**
 * file-download.ts — hand bytes to the browser so it saves them to disk.
 *
 * Two shapes exist, and the difference is who carries the credential:
 *
 *  - `saveBlobAsFile` — for a fetch that already returned the bytes. The URL needed an
 *    `Authorization` header, so the browser could not be pointed at it and the response had
 *    to be buffered into a Blob first. That costs a full copy in page memory and gives up
 *    progress and Range, so it stays the fallback for callers that already hold a Blob.
 *  - ticket download — `openDownloadTab` runs in the click turn, before any `await`, and
 *    `navigateDownloadTab` later points that tab at a URL that carries its own credential.
 *    The server's `Content-Disposition: attachment` is what saves a successful response.
 *    A rejected ticket stays in the tab as HTML. Setting `<a download>` would instead save
 *    that error page under the real filename, which looks like a successful download.
 *
 * Blob downloads still go through a synthetic anchor so the page never navigates away.
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
 * The URL that downloads a file under a ticket minted by `api.fsDownloadTicket`.
 *
 * Built with `apiUrl` rather than string concatenation so a mount prefix (`/nf/`,
 * code-server's `/proxy/7778/`) is applied. The saved name comes from the server's
 * `Content-Disposition`, not from this URL.
 */
export function fsDownloadTicketUrl(ticket: string): string {
	return apiUrl(`/api/fs/download?ticket=${encodeURIComponent(ticket)}`);
}

/**
 * Open a tab in the same turn as the click, before the ticket request is awaited.
 *
 * `window.open` has to happen while the browser still counts the click as a user gesture.
 * Doing it after `await api.fsDownloadTicket()` is what Safari treats as an unsolicited
 * download and silently drops. Returns null when the browser blocked the popup; the caller
 * shows that, rather than navigating the current page away.
 */
export function openDownloadTab(): Window | null {
	if (typeof window === "undefined" || typeof window.open !== "function") return null;
	try {
		return window.open("about:blank", "_blank");
	} catch {
		return null;
	}
}

/**
 * Point a tab opened by `openDownloadTab` at the ticket URL.
 *
 * No `download` attribute: a 200 with `Content-Disposition: attachment` is saved by the
 * browser, and a 403 HTML body stays visible in the tab. `opener` is cleared so that page
 * cannot reach back into the app.
 */
export function navigateDownloadTab(tab: Window, ticket: string): void {
	const url = fsDownloadTicketUrl(ticket);
	tab.location.replace(url);
	try {
		tab.opener = null;
	} catch {
		// The browser may already have sealed `opener`. The navigation itself is done.
	}
}

/** Close a tab that will not be used, for example because minting the ticket failed. */
export function closeDownloadTab(tab: Window): void {
	try {
		tab.close();
	} catch {
		// Already closed.
	}
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
