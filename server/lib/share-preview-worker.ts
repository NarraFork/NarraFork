import { parentPort } from "node:worker_threads";
import sanitizeHtml from "sanitize-html";
import { SHARE_HTML_MAX_BYTES, SHARE_HTML_OUTPUT_MAX_BYTES } from "../../shared/share-preview";

// Literal, bounded lengths only: no url(), calc(), positioning or active CSS.
const LENGTH_TOKEN = "(?:0|\\d{1,5}(?:\\.\\d{1,4})?(?:px|em|rem|%|vh|vw))";
const CSS_LENGTH = new RegExp(`^${LENGTH_TOKEN}$`);
const CSS_SPACING = new RegExp(`^${LENGTH_TOKEN}(?:\\s+${LENGTH_TOKEN}){0,3}$`);
const CSS_MARGIN = new RegExp(`^-?${LENGTH_TOKEN}(?:\\s+-?${LENGTH_TOKEN}){0,3}$`);
const CSS_MARGIN_LENGTH = new RegExp(`^-?${LENGTH_TOKEN}$`);
const CSS_COLOR = [
	/^#[0-9a-fA-F]{3,8}$/,
	/^rgba?\([\d\s,.%/]+\)$/,
	/^hsla?\([\d\s,.%/degturna]+\)$/,
	/^[a-z]+$/,
];
const CSS_BORDER = [
	/^(0|none)$/,
	/^\d{1,5}(\.\d{1,4})?(px|em|rem)\s+(solid|dashed|dotted|double|none)\s+(#[0-9a-fA-F]{3,8}|[a-z]+|rgba?\([\d\s,.%/]+\)|hsla?\([\d\s,.%/degturna]+\))$/,
];

parentPort?.once("message", async (path: string) => {
	try {
		const file = Bun.file(path);
		if (file.size > SHARE_HTML_MAX_BYTES) throw new Error("HTML preview exceeds 1 MiB");
		const bytes = await file.slice(0, SHARE_HTML_MAX_BYTES + 1).arrayBuffer();
		if (bytes.byteLength > SHARE_HTML_MAX_BYTES) throw new Error("HTML preview exceeds 1 MiB");
		const clean = sanitizeHtml(new TextDecoder().decode(bytes), {
			allowedTags: sanitizeHtml.defaults.allowedTags.concat([
				"img",
				"figure",
				"figcaption",
				"details",
				"summary",
				"mark",
				"time",
				"main",
				"nav",
				"header",
				"footer",
				"section",
				"article",
				"aside",
			]),
			allowedAttributes: {
				...sanitizeHtml.defaults.allowedAttributes,
				img: ["src", "alt", "width", "height"],
				a: ["href", "title"],
				"*": ["class", "id", "style"],
			},
			allowedSchemes: ["data"],
			allowedStyles: {
				"*": {
					color: CSS_COLOR,
					"background-color": CSS_COLOR,
					"font-size": [/^\d+(\.\d+)?(px|em|rem|%)$/],
					"font-weight": [/^\d{3}$/, /^(normal|bold|bolder|lighter)$/],
					"text-align": [/^(left|right|center|justify)$/],
					"text-decoration": [/^(none|underline|line-through|overline)$/],
					width: [CSS_LENGTH],
					height: [CSS_LENGTH],
					"max-width": [CSS_LENGTH],
					"max-height": [CSS_LENGTH],
					margin: [CSS_MARGIN],
					"margin-top": [CSS_MARGIN_LENGTH],
					"margin-right": [CSS_MARGIN_LENGTH],
					"margin-bottom": [CSS_MARGIN_LENGTH],
					"margin-left": [CSS_MARGIN_LENGTH],
					padding: [CSS_SPACING],
					"padding-top": [CSS_LENGTH],
					"padding-right": [CSS_LENGTH],
					"padding-bottom": [CSS_LENGTH],
					"padding-left": [CSS_LENGTH],
					border: CSS_BORDER,
					"border-radius": [CSS_LENGTH],
				},
			},
		});
		if (Buffer.byteLength(clean) > SHARE_HTML_OUTPUT_MAX_BYTES)
			throw new Error("HTML preview output exceeds budget");
		parentPort?.postMessage({ html: clean });
	} catch (error) {
		parentPort?.postMessage({
			error: error instanceof Error ? error.message : "HTML preview failed",
		});
	} finally {
		parentPort?.close();
	}
});
parentPort?.postMessage({ ready: true });
