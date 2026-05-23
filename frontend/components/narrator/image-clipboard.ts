import { ApiError, getToken, readFetchError } from "../../lib/api";

export const MAX_INLINE_IMAGE_SOURCE_CHARS = 16 * 1024 * 1024;
export const MAX_IMAGE_CLIPBOARD_BLOB_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_CLIPBOARD_PIXELS = 32_000_000;

interface CopyGeneratedImageOptions {
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
	return (
		source.startsWith("/api/") || /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#].*)?$/i.test(source)
	);
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
		return source;
	}
	assertInlineImageSourceSafe(source);
	return `data:image/png;base64,${source}`;
}

function getSavedPathPreviewSource(savedPath?: string | null): string | null {
	const path = savedPath?.trim();
	if (!path) return null;
	return `/api/fs/preview?path=${encodeURIComponent(path)}`;
}

function getAuthHeaders(): Record<string, string> {
	const headers: Record<string, string> = {};
	const token = getToken();
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

function clipboardItemSupports(type: string): boolean {
	const clipboardItemCtor = ClipboardItem as unknown as {
		supports?: (type: string) => boolean;
	};
	return clipboardItemCtor.supports ? clipboardItemCtor.supports(type) : type === "image/png";
}

function assertBlobSafe(blob: Blob): void {
	if (blob.size > MAX_IMAGE_CLIPBOARD_BLOB_BYTES) {
		throw new Error("Image blob too large");
	}
}

async function fetchImageBlob({ imageSrc, savedPath }: CopyGeneratedImageOptions): Promise<Blob> {
	const savedPathSource = getSavedPathPreviewSource(savedPath);
	const source = savedPathSource ?? normalizeImageSrc(imageSrc);
	if (!source) throw new Error("No image source");
	const needsAuth = savedPathSource != null || source.startsWith("/api/");

	const response = await fetch(source, needsAuth ? { headers: getAuthHeaders() } : undefined);
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

export async function copyGeneratedImageToClipboard(
	options: CopyGeneratedImageOptions,
): Promise<void> {
	if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
		throw new Error("Image clipboard is not supported");
	}

	const imageBlob = await fetchImageBlob(options);
	const clipboardBlob =
		imageBlob.type && clipboardItemSupports(imageBlob.type)
			? imageBlob
			: await imageBlobToPng(imageBlob);
	assertBlobSafe(clipboardBlob);
	await navigator.clipboard.write([
		new ClipboardItem({ [clipboardBlob.type || "image/png"]: clipboardBlob }),
	]);
}
