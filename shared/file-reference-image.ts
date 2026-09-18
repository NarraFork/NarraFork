/** Independent from UI and text-snapshot budgets. SVG is for img loading only. */
export const MAX_FILE_REFERENCE_IMAGE_BYTES = 25 * 1024 * 1024;
export const FILE_REFERENCE_IMAGE_MIME_TYPES = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	ico: "image/x-icon",
	avif: "image/avif",
	svg: "image/svg+xml",
} as const;

export function getFileReferenceImageMimeType(path: string): string | undefined {
	const name = path.split(/[\\/]/).pop() ?? "";
	const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
	if (!name.includes(".")) return undefined;
	return Object.hasOwn(FILE_REFERENCE_IMAGE_MIME_TYPES, extension)
		? FILE_REFERENCE_IMAGE_MIME_TYPES[extension as keyof typeof FILE_REFERENCE_IMAGE_MIME_TYPES]
		: undefined;
}
