// DOM mode — extract and clean rendered HTML.
// Try Playwright first, fall back to HTTP fetch + linkedom if browser unavailable.

import sanitizeHtml from "sanitize-html";
import { httpFetchHtml, tryBrowserFetch } from "./http-fetch";

const DEFAULT_MAX_LENGTH = 20_000;

/** Tags whose content should be completely discarded. */
const DISCARD_TAGS = ["script", "style", "noscript", "svg", "iframe", "link", "meta", "head"];

/** Attributes worth keeping for content extraction. */
const KEEP_ATTRS: sanitizeHtml.AllowedAttribute[] = [
	"href",
	"src",
	"alt",
	"title",
	"class",
	"id",
	"type",
	"name",
	"value",
	"placeholder",
	"role",
];

export async function fetchDom(
	url: string,
	selector?: string,
	maxLength = DEFAULT_MAX_LENGTH,
): Promise<string> {
	let html: string;

	if (selector) {
		// With selector: try browser first (live DOM), fall back to linkedom
		const { tryBrowserPage } = await import("./http-fetch");
		const page = await tryBrowserPage(url, { waitUntil: "domcontentloaded" });
		if (page) {
			try {
				html = await page
					.locator(selector)
					.evaluateAll((els) => els.map((el) => el.outerHTML).join("\n"));
				if (!html) {
					return `No elements found matching selector: ${selector}`;
				}
			} finally {
				await page
					.context()
					.close()
					.catch(() => {});
			}
		} else {
			const rawHtml = await httpFetchHtml(url);
			const { parseHTML } = await import("linkedom");
			const { document } = parseHTML(rawHtml);
			const els = document.querySelectorAll(selector);
			if (els.length === 0) {
				return `No elements found matching selector: ${selector}`;
			}
			html = Array.from(els)
				.map((el: { outerHTML: string }) => el.outerHTML)
				.join("\n");
		}
	} else {
		// Without selector: fetch full page HTML, extract body
		const fullHtml = (await tryBrowserFetch(url)) ?? (await httpFetchHtml(url));
		const bodyMatch = fullHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
		html = bodyMatch?.[1] ?? fullHtml;
	}

	const cleaned = cleanHtml(html);

	if (cleaned.length > maxLength) {
		return `${cleaned.slice(0, maxLength)}\n\n[DOM truncated at ${maxLength} characters]`;
	}
	return cleaned;
}

/** Clean HTML: remove dangerous/noisy tags, strip non-essential attributes, collapse whitespace. */
export function cleanHtml(html: string): string {
	const result = sanitizeHtml(html, {
		// Allow all tags except the ones we want to discard
		allowedTags: sanitizeHtml.defaults.allowedTags
			.concat(["main", "section", "article", "nav", "header", "footer", "figure", "figcaption"])
			.filter((tag) => !DISCARD_TAGS.includes(tag)),
		allowedAttributes: { "*": KEEP_ATTRS },
		// Completely remove discard tags and their children
		exclusiveFilter: (frame) => DISCARD_TAGS.includes(frame.tag),
		disallowedTagsMode: "discard",
	});

	// Collapse excessive whitespace (but preserve single newlines for structure)
	return result
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
