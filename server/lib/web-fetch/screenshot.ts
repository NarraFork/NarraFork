// Screenshot mode — capture page as PNG image.
// Requires Puppeteer + Chrome. No HTTP fallback possible.

import { tryBrowserPage } from "./http-fetch";

export async function fetchScreenshot(
	url: string,
): Promise<{ base64: string; width: number; height: number }> {
	const page = await tryBrowserPage(url);

	if (!page) {
		throw new Error(
			"Screenshot mode requires a browser (Chrome/Chromium). " +
				"Install Chrome or run `bunx puppeteer browsers install chrome`, then try again.",
		);
	}

	try {
		const viewport = page.viewport();
		const width = viewport?.width ?? 1280;
		const height = viewport?.height ?? 900;

		const buffer = await page.screenshot({
			type: "png",
			fullPage: false,
			encoding: "binary",
		});

		const base64 = Buffer.from(buffer as Uint8Array).toString("base64");

		return { base64, width, height };
	} finally {
		await page.close().catch(() => {});
	}
}
