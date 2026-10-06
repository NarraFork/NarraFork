// DOM mode — extract and clean rendered HTML.
// Try browser first, fall back to HTTP fetch + linkedom if browser unavailable.

import sanitizeHtml from "sanitize-html";
import { httpFetchHtml, tryBrowserFetch } from "./http-fetch";

const DEFAULT_MAX_LENGTH = 20_000;

/** Tags whose content should be completely discarded. */
const DISCARD_TAGS = ["script", "style", "noscript", "svg", "iframe", "link", "meta", "head"];

/**
 * All tags we want to preserve in the cleaned output.
 * Starts from sanitize-html defaults and adds semantic, form, and media tags.
 */
const ALLOWED_TAGS = [
	// sanitize-html defaults (structural)
	...sanitizeHtml.defaults.allowedTags,
	// Semantic HTML5
	"main",
	"section",
	"article",
	"nav",
	"header",
	"footer",
	"figure",
	"figcaption",
	"aside",
	"details",
	"summary",
	// Form elements
	"form",
	"input",
	"button",
	"textarea",
	"select",
	"option",
	"optgroup",
	"label",
	"fieldset",
	"legend",
	"datalist",
	"output",
	// Media
	"img",
	"video",
	"audio",
	"source",
	"picture",
].filter((tag) => !DISCARD_TAGS.includes(tag));

/** Attributes worth keeping for content extraction — everything else is stripped. */
const KEEP_ATTRS: string[] = [
	// Links & media
	"href",
	"src",
	"alt",
	"title",
	// Identity & semantics
	"class",
	"id",
	"role",
	// Form elements
	"type",
	"name",
	"value",
	"placeholder",
	"for",
	"action",
	"method",
	"disabled",
	"checked",
	"selected",
	"readonly",
	"required",
	// Accessibility (wildcard for all aria-* attributes)
	"aria-*",
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
				html = await page.$$eval(selector, (els) => els.map((el) => el.outerHTML).join("\n"));
				if (!html) {
					return `No elements found matching selector: ${selector}`;
				}
			} finally {
				await page.close().catch(() => {});
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

/**
 * Clean HTML: remove dangerous/noisy tags, strip non-essential attributes,
 * collapse whitespace. Uses sanitize-html for robust HTML parsing.
 * Preserves structural tags including form elements, images, and semantic HTML5.
 */
export function cleanHtml(html: string): string {
	const result = sanitizeHtml(html, {
		allowedTags: ALLOWED_TAGS,
		allowedAttributes: {
			"*": KEEP_ATTRS,
		},
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
