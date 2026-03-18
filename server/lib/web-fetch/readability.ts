// Readability mode — extract article content using Mozilla Readability.
// Try Puppeteer first, fall back to HTTP fetch if browser unavailable.

import { httpFetchHtml, tryBrowserFetch } from "./http-fetch";

const DEFAULT_MAX_LENGTH = 20_000;

export async function fetchReadability(
	url: string,
	maxLength = DEFAULT_MAX_LENGTH,
): Promise<{ title: string; content: string; excerpt: string }> {
	// Try browser first, fall back to HTTP
	const html = (await tryBrowserFetch(url)) ?? (await httpFetchHtml(url));

	const { parseHTML } = await import("linkedom");
	const { Readability } = await import("@mozilla/readability");

	const { document } = parseHTML(html);
	const reader = new Readability(document as unknown as Document);
	const article = reader.parse();

	if (!article) {
		return {
			title: "",
			content: "Failed to extract article content — page may not have readable text.",
			excerpt: "",
		};
	}

	let text = article.textContent?.trim() ?? "";
	if (text.length > maxLength) {
		text = `${text.slice(0, maxLength)}\n\n[Content truncated at ${maxLength} characters]`;
	}

	return {
		title: article.title ?? "",
		content: text,
		excerpt: article.excerpt ?? "",
	};
}
