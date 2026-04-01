// Screenshot mode — capture page as PNG image.
// Requires Playwright + Chrome. No HTTP fallback possible.

import { tryBrowserPage } from "./http-fetch";

export async function fetchScreenshot(
	url: string,
): Promise<{ base64: string; width: number; height: number }> {
	const page = await tryBrowserPage(url);

	if (!page) {
		throw new Error(
			"Screenshot mode requires a browser (Chrome/Chromium). " +
				"Install Chrome or run `bunx playwright install chromium`, then try again.",
		);
	}

	try {
		const viewport = page.viewportSize();
		const width = viewport?.width ?? 1280;
		const height = viewport?.height ?? 900;

		const buffer = await page.screenshot({
			type: "png",
			fullPage: false,
		});

		const base64 = buffer.toString("base64");

		return { base64, width, height };
	} finally {
		await page
			.context()
			.close()
			.catch(() => {});
	}
}
