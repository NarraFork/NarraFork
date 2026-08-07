export interface BrowserPreviewViewport {
	width: number;
	height: number;
}

export interface BrowserPreviewClientRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export function getBrowserPreviewNavigationUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
	} catch {
		return null;
	}
}

export function translateBrowserPreviewCoordinate(
	rect: BrowserPreviewClientRect,
	viewport: BrowserPreviewViewport,
	clientX: number,
	clientY: number,
): { x: number; y: number } | null {
	if (rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
		return null;
	}
	const x = Math.round(((clientX - rect.left) / rect.width) * viewport.width);
	const y = Math.round(((clientY - rect.top) / rect.height) * viewport.height);
	return {
		x: Math.min(viewport.width - 1, Math.max(0, x)),
		y: Math.min(viewport.height - 1, Math.max(0, y)),
	};
}
