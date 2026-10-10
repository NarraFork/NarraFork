import { ApiError, authorizedFetch, readFetchError } from "../../../lib/api";
import { apiUrl, isApiUrl, resolveServerUrl } from "../../../lib/base-path";

export const MAX_INLINE_IMAGE_SOURCE_CHARS = 16 * 1024 * 1024;
export const MAX_IMAGE_CLIPBOARD_BLOB_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_CLIPBOARD_PIXELS = 32_000_000;

export interface CopyGeneratedImageOptions {
	imageSrc?: string | null;
	savedPath?: string | null;
}

function assertInlineImageSourceSafe(source: string): void {
	if (source.length > MAX_INLINE_IMAGE_SOURCE_CHARS) {
		throw new Error("Image data too large");
	}
	if (source.startsWith("data:") && !source.startsWith("data:image/")) {
		throw new Error("Unsupported image data URL");
	}
}

function isRelativeImageUrl(source: string): boolean {
	return isApiUrl(source) || /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#].*)?$/i.test(source);
}

function normalizeImageSrc(imageSrc?: string | null): string | null {
	const source = imageSrc?.trim();
	if (!source) return null;
	if (
		source.startsWith("data:") ||
		source.startsWith("blob:") ||
		source.startsWith("http://") ||
		source.startsWith("https://") ||
		isRelativeImageUrl(source)
	) {
		if (source.startsWith("data:")) assertInlineImageSourceSafe(source);
		// A rooted `/api/…` here is a server-minted, PERSISTED value (a screenshot's
		// `previewUrl`), so it must be re-pointed at the mount prefix before it is fetched.
		// Unlike the `<img>` path there is no fallback chain to rescue it: copy and download
		// simply fail, and under a prefix the proxy answers with HTML, so the failure reads
		// as a corrupt image rather than a wrong URL.
		return resolveServerUrl(source);
	}
	assertInlineImageSourceSafe(source);
	return `data:image/png;base64,${source}`;
}

function getSavedPathPreviewSource(savedPath?: string | null): string | null {
	const path = savedPath?.trim();
	if (!path) return null;
	return `${apiUrl("/fs/preview")}?path=${encodeURIComponent(path)}`;
}

const capabilityErrors = new WeakSet<object>();

export class ImageClipboardUnavailableError extends Error {
	constructor() {
		super("Image clipboard is not supported");
		this.name = "ImageClipboardUnavailableError";
		capabilityErrors.add(this);
	}
}

/** Match only our capability guard, not permission errors or cross-realm Error prototypes. */
export function isImageClipboardUnavailableError(
	error: unknown,
): error is ImageClipboardUnavailableError {
	return typeof error === "object" && error !== null && capabilityErrors.has(error);
}

function assertBlobSafe(blob: Blob): void {
	if (blob.size > MAX_IMAGE_CLIPBOARD_BLOB_BYTES) {
		throw new Error("Image blob too large");
	}
}

export async function fetchImageBlob({
	imageSrc,
	savedPath,
}: CopyGeneratedImageOptions): Promise<Blob> {
	const savedPathSource = getSavedPathPreviewSource(savedPath);
	const source = savedPathSource ?? normalizeImageSrc(imageSrc);
	if (!source) throw new Error("No image source");
	const needsAuth = savedPathSource != null || isApiUrl(source);

	const response = needsAuth ? await authorizedFetch(source) : await fetch(source);
	if (!response.ok) {
		const error = await readFetchError(response, `HTTP ${response.status}`);
		throw new ApiError(error.message, response.status, error.data);
	}
	const blob = await response.blob();
	assertBlobSafe(blob);
	if (blob.type.startsWith("image/")) return blob;
	return new Blob([blob], { type: "image/png" });
}

async function imageBlobToPng(blob: Blob): Promise<Blob> {
	const objectUrl = URL.createObjectURL(blob);
	try {
		const image = await new Promise<HTMLImageElement>((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error("Failed to load image"));
			img.src = objectUrl;
		});
		const pixels = image.naturalWidth * image.naturalHeight;
		if (!Number.isFinite(pixels) || pixels <= 0 || pixels > MAX_IMAGE_CLIPBOARD_PIXELS) {
			throw new Error("Image dimensions too large");
		}
		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas is not supported");
		ctx.drawImage(image, 0, 0);
		const pngBlob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (blob) resolve(blob);
				else reject(new Error("Failed to encode image"));
			}, "image/png");
		});
		assertBlobSafe(pngBlob);
		return pngBlob;
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

/** Binary image copy needs ClipboardItem; plain HTTP and old browsers cannot fall back to execCommand. */
export function canUseImageClipboard(): boolean {
	return (
		typeof navigator !== "undefined" &&
		typeof navigator.clipboard?.write === "function" &&
		typeof ClipboardItem !== "undefined" &&
		(typeof window === "undefined" || window.isSecureContext !== false)
	);
}

export async function copyGeneratedImageToClipboard(
	options: CopyGeneratedImageOptions,
): Promise<void> {
	if (!canUseImageClipboard()) {
		throw new ImageClipboardUnavailableError();
	}

	const clipboardBlob = fetchImageBlob(options).then(async (imageBlob) => {
		const png = imageBlob.type === "image/png" ? imageBlob : await imageBlobToPng(imageBlob);
		assertBlobSafe(png);
		return png;
	});
	// write/ClipboardItem must run before any await to preserve Safari's user activation.
	// The browser consumes the original promise; also handle its rejection if write
	// or the constructor fails before consuming it (e.g. permission was denied).
	void clipboardBlob.catch(() => {});
	await Promise.all([
		navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardBlob })]),
		clipboardBlob,
	]);
}
