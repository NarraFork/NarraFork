import { readBoundedBlob } from "@frontend/lib/bounded-blob";
import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { isRemoteInlineImage } from "@frontend/lib/remote-resource-policy";
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

	if (REMOTE_BUILD && (savedPathSource || (!needsAuth && !isRemoteInlineImage(source)))) {
		throw new Error("Image source is unavailable in remote access");
	}
	const signal = AbortSignal.timeout(15_000);
	const response = needsAuth
		? await authorizedFetch(source, { signal })
		: await fetch(source, { signal });
	if (!response.ok) {
		const error = await readFetchError(response, `HTTP ${response.status}`);
		throw new ApiError(error.message, response.status, error.data);
	}
	const blob = await readBoundedBlob(
		response,
		REMOTE_BUILD ? 8 * 1024 * 1024 : MAX_IMAGE_CLIPBOARD_BLOB_BYTES,
		signal,
	);
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

/** Async clipboard writes image/png. Missing APIs fall back to a data-URL selection copy. */
export function canUseImageClipboard(): boolean {
	return (
		typeof navigator !== "undefined" &&
		typeof navigator.clipboard?.write === "function" &&
		typeof ClipboardItem !== "undefined" &&
		(typeof window === "undefined" || window.isSecureContext !== false)
	);
}

/** 选区回退所需的老接口：execCommand、Selection 与 Range 缺一不可。 */
function canUseSelectionClipboard(): boolean {
	return (
		typeof document !== "undefined" &&
		typeof document.execCommand === "function" &&
		typeof window?.getSelection === "function" &&
		typeof document.createRange === "function"
	);
}

/** 选区复制最多等图片加载多久。超时按不可用上报，不能静默卡住，也不能误报复制成功。 */
const SELECTION_IMAGE_LOAD_TIMEOUT_MS = 5000;

function isInlineImageDataUrl(source: string | null | undefined): source is string {
	return typeof source === "string" && source.startsWith("data:image/");
}

/**
 * 选区回退：把已解码的 data:image 放进选区后 execCommand("copy")。
 *
 * 这条老路径在非安全上下文里仍可用，但 Chrome 实际写入的是 text/html，不是
 * image/png。因此只能复制自包含的 data:image；远程或鉴权地址会粘成坏图，却因为
 * 命令返回 true 被当成成功。加载失败、超时、没有选区或命令被拒绝都按不可用上报。
 */
async function copyViaSelection(imageUrl: string): Promise<void> {
	const holder = document.createElement("div");
	holder.contentEditable = "true";
	// 必须真实渲染才能被选中，所以移出视口而不是隐藏。
	holder.style.cssText = "position:fixed;left:-10000px;top:0;";
	const image = document.createElement("img");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const loaded = new Promise<void>((resolve, reject) => {
		timer = setTimeout(() => {
			reject(new ImageClipboardUnavailableError());
		}, SELECTION_IMAGE_LOAD_TIMEOUT_MS);
		image.onload = () => resolve();
		image.onerror = () => reject(new ImageClipboardUnavailableError());
	});
	image.src = imageUrl;
	holder.appendChild(image);
	document.body.appendChild(holder);

	const selection = window.getSelection();
	try {
		await loaded;
		if (!selection) throw new ImageClipboardUnavailableError();
		const range = document.createRange();
		range.selectNodeContents(holder);
		selection.removeAllRanges();
		selection.addRange(range);
		// 焦点落在视口外时不能把查看器滚走。
		if (typeof holder.focus === "function") {
			try {
				holder.focus({ preventScroll: true });
			} catch {
				holder.focus();
			}
		}
		if (!document.execCommand("copy")) throw new ImageClipboardUnavailableError();
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		selection?.removeAllRanges();
		holder.remove();
	}
}

/** 把像素读成 data:image。读不到就返回 null，调用方不能改放远程地址。 */
function readDataUrl(blob: Blob): Promise<string | null> {
	if (typeof FileReader !== "function") return Promise.resolve(null);
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			resolve(typeof result === "string" && isInlineImageDataUrl(result) ? result : null);
		};
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(blob);
	});
}

/**
 * 选区只接受 data:image。能转成 PNG 就转，转不动就用原始图片字节。
 * 取字节失败时，只有页面上已经是 data:image 的地址可以继续用。
 * blob:、http(s) 和鉴权预览地址都不能进入选区。
 */
async function buildSelectionImageSource(
	options: CopyGeneratedImageOptions,
): Promise<string | null> {
	try {
		const blob = await fetchImageBlob(options);
		const png = blob.type === "image/png" ? blob : await imageBlobToPng(blob).catch(() => blob);
		const dataUrl = await readDataUrl(png);
		if (dataUrl) return dataUrl;
	} catch {
		// 取字节失败时再看展示地址是不是已经自包含。
	}
	try {
		const display = normalizeImageSrc(options.imageSrc);
		if (isInlineImageDataUrl(display) && (!REMOTE_BUILD || isRemoteInlineImage(display)))
			return display;
	} catch {
		// 非法 data URL 不能拿来充选区。
	}
	return null;
}

async function copyWithSelection(options: CopyGeneratedImageOptions): Promise<void> {
	// 平台连选区接口都没有时先报不可用，避免白白取一次字节。
	if (!canUseSelectionClipboard()) throw new ImageClipboardUnavailableError();
	const source = await buildSelectionImageSource(options);
	if (!source) throw new ImageClipboardUnavailableError();
	await copyViaSelection(source);
}

export async function copyGeneratedImageToClipboard(
	options: CopyGeneratedImageOptions,
): Promise<void> {
	if (!canUseImageClipboard()) {
		// 非安全上下文（局域网 HTTP）下浏览器不提供异步剪贴板，只能走选区复制；
		// 平台连选区接口都不具备时它按不可用上报，调用方保留降级为下载的原语义。
		await copyWithSelection(options);
		return;
	}

	const imageBlob = fetchImageBlob(options);
	// 下面的分支可能先返回，先接住 rejection 以免留下未处理的 promise。
	void imageBlob.catch(() => {});

	const clipboardBlob = imageBlob.then(async (blob) => {
		const png = blob.type === "image/png" ? blob : await imageBlobToPng(blob);
		assertBlobSafe(png);
		return png;
	});
	// write/ClipboardItem must run before any await to preserve Safari's user activation.
	// The browser consumes the original promise; also handle its rejection if write
	// or the constructor fails before consuming it (e.g. permission was denied).
	void clipboardBlob.catch(() => {});
	try {
		await Promise.all([
			navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardBlob })]),
			clipboardBlob,
		]);
	} catch (error) {
		// 权限被拒或浏览器不支持图片写入时，仍可尝试把 data:image 放进选区。
		// 回退没能完成时抛出原错误：权限拒绝保持红色失败，不降级成下载。
		try {
			await copyWithSelection(options);
		} catch {
			throw error;
		}
	}
}
