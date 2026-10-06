import {
	copyGeneratedImageToClipboard,
	fetchImageBlob,
} from "../components/narrator/composer/image-clipboard";

export interface ImageActionSource {
	/** Directly-displayable URL (blob:/data:/http(s)/relative /api path). */
	imageSrc?: string | null;
	/** Optional server file path fetched via /api/fs/preview. */
	savedPath?: string | null;
}

/**
 * Copy an image to the clipboard as a PNG. Thin wrapper over the narrator
 * clipboard helper so non-narrator call sites can share a single import.
 */
export async function copyImageSourceToClipboard(source: ImageActionSource): Promise<void> {
	await copyGeneratedImageToClipboard(source);
}

function ensureExtension(name: string, mime: string): string {
	if (/\.[a-z0-9]{1,5}$/i.test(name)) return name;
	const ext =
		mime === "image/jpeg"
			? "jpg"
			: mime === "image/webp"
				? "webp"
				: mime === "image/gif"
					? "gif"
					: mime === "image/svg+xml"
						? "svg"
						: "png";
	return `${name}.${ext}`;
}

function triggerDownload(url: string, filename: string): void {
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
}

function canDownloadDirectly(source: string): boolean {
	if (source.startsWith("blob:") || source.startsWith("data:")) return true;
	try {
		return new URL(source, window.location.origin).origin === window.location.origin;
	} catch {
		return false;
	}
}

/**
 * Download an image. Directly-downloadable display URLs are triggered during
 * the user gesture; other sources are fetched as blobs so authenticated paths
 * and cross-origin images can still preserve the requested filename.
 */
export async function downloadImageSource(
	source: ImageActionSource & { filename?: string | null },
): Promise<void> {
	const requested = source.filename?.split(/[\\/]/).pop()?.trim() || "image";
	const direct = source.imageSrc?.trim();

	// Blob/data/same-origin URLs are already browser-downloadable. Trigger them in
	// the click handler instead of waiting for a fetch, which can lose user activation.
	if (direct && canDownloadDirectly(direct)) {
		triggerDownload(direct, ensureExtension(requested, "image/png"));
		return;
	}

	try {
		const blob = await fetchImageBlob(source);
		const filename = ensureExtension(requested, blob.type || "image/png");
		const objectUrl = URL.createObjectURL(blob);
		try {
			triggerDownload(objectUrl, filename);
		} finally {
			// Give the browser a tick to start the download before revoking.
			setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
		}
	} catch (err) {
		// Fallback: direct link download for cross-origin sources that block fetch.
		if (direct) {
			triggerDownload(direct, ensureExtension(requested, "image/png"));
			return;
		}
		throw err;
	}
}
