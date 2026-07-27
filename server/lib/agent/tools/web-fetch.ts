import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { generateShortId } from "../../id";
import { logger } from "../../logger";
import { shouldUseNativeSearch } from "../../search/native";
import { createShare, getShareDir, SCREENSHOT_PREVIEW_EXPIRY_HOURS } from "../../shares";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

const MODES = ["readability", "screenshot", "dom", "smart"] as const;

const WEB_FETCH_BODY =
	"Modes:\n" +
	'- "readability": Extract article text using Mozilla Readability. Best for articles, docs, blog posts. Works without a browser.\n' +
	'- "screenshot": Capture a viewport screenshot as an image. Requires Chrome/Chromium browser.\n' +
	'- "dom": Extract cleaned HTML DOM structure. Best for structured data, tables, lists. Works without a browser (no JS rendering).\n' +
	'- "smart": Extract DOM then summarize with an AI model. Best for long pages where you only need key information. Works without a browser.\n\n' +
	"Note: readability, dom, and smart modes fall back to HTTP fetch when Chrome is not available. " +
	"This works well for static pages but won't render JavaScript-heavy SPAs.\n\n" +
	"Parameters:\n" +
	"- url (required): The URL to fetch\n" +
	"- mode (optional): One of readability, screenshot, dom, smart. Defaults to readability.\n" +
	"- selector (optional): CSS selector to extract specific elements (dom mode only)\n" +
	"- max_length (optional): Maximum output length in characters (default: 20000, not applicable to screenshot mode)\n" +
	"- purpose (optional): What information you are looking for (smart mode only). When provided, the AI summarizer will prioritize extracting content relevant to this goal instead of producing a generic summary.";

export const webFetchTool: ToolDefinition = {
	name: "WebFetch",
	description(config: AgentConfig) {
		const intro = shouldUseNativeSearch(config.provider, config.model)
			? "Fetch and extract content from a web page URL. Use this after the native web_search tool to get detailed content from specific URLs."
			: "Fetch and extract content from a web page URL. Use this after WebSearch to get detailed content from specific URLs.";
		return `${intro}\n\n${WEB_FETCH_BODY}`;
	},
	rawJsonSchema: {
		type: "object",
		properties: {
			url: {
				description: "The URL to fetch content from",
				type: "string",
			},
			mode: {
				description:
					"Extraction mode: readability (article text), screenshot (page image), dom (cleaned HTML), smart (AI summary)",
				type: "string",
				enum: MODES,
			},
			selector: {
				description: "CSS selector to extract specific elements (only used in dom mode)",
				type: "string",
			},
			max_length: {
				description:
					"Maximum output length in characters (default: 20000, not applicable to screenshot mode)",
				type: "number",
			},
			purpose: {
				description:
					"What information you are looking for (smart mode only). The AI summarizer will prioritize extracting content relevant to this goal.",
				type: "string",
			},
		},
		required: ["url"],
		additionalProperties: false,
	},
	parameters: z.object({
		url: z.string().describe("The URL to fetch"),
		mode: z.enum(MODES).optional().default("readability").describe("Extraction mode"),
		selector: z.string().optional().describe("CSS selector (dom mode)"),
		max_length: looseNumber("Max output chars"),
		purpose: z.string().optional().describe("What to look for (smart mode)"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const {
			url,
			mode = "readability",
			selector,
			purpose,
		} = args as {
			url: string;
			mode?: (typeof MODES)[number];
			selector?: string;
			purpose?: string;
		};
		const max_length = normalizeNumber((args as { max_length?: unknown }).max_length, { min: 1 });

		// Basic URL validation — file:// is intentionally excluded to prevent
		// bypassing the Read tool's path whitelist/blacklist checks.
		const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "data:"]);
		try {
			const parsed = new URL(url);
			if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
				return {
					output: `Unsupported protocol: ${parsed.protocol} — only http://, https://, and data: URLs are supported. Use the Read tool for local files.`,
					isError: true,
				};
			}
		} catch {
			return { output: `Invalid URL: ${url}`, isError: true };
		}

		logger.info("WebFetch executing", { url, mode, selector });

		// Race the actual fetch against the abort signal so the narrator can be interrupted.
		const abortPromise = new Promise<never>((_, reject) => {
			if (ctx?.signal?.aborted) {
				reject(new DOMException("Aborted", "AbortError"));
				return;
			}
			ctx?.signal?.addEventListener(
				"abort",
				() => reject(new DOMException("Aborted", "AbortError")),
				{ once: true },
			);
		});

		try {
			const doFetch = async (): Promise<ToolResult> => {
				switch (mode) {
					case "readability": {
						const { fetchReadability } = await import("../../web-fetch/readability");
						const result = await fetchReadability(url, max_length);
						const header = result.title ? `# ${result.title}\n\n` : "";
						const excerpt = result.excerpt ? `> ${result.excerpt}\n\n` : "";
						return {
							output: `${header}${excerpt}${result.content}`,
							title: result.title || url,
						};
					}
					case "screenshot": {
						const { fetchScreenshot } = await import("../../web-fetch/screenshot");
						const result = await fetchScreenshot(url);

						// Save the screenshot as a share for frontend preview. The URL is
						// persisted with the tool call and stays in the conversation, so a
						// short expiry silently breaks every screenshot the user scrolls
						// back to (see SCREENSHOT_PREVIEW_EXPIRY_HOURS).
						let metadata: Record<string, unknown> | undefined;
						try {
							const shareId = generateShortId();
							const shareDir = getShareDir(shareId);
							const filename = "screenshot.png";
							const filePath = resolve(shareDir, filename);
							const buffer = Buffer.from(result.base64, "base64");
							writeFileSync(filePath, buffer);
							createShare({
								id: shareId,
								originalName: filename,
								storagePath: filePath,
								size: buffer.length,
								createdBy: "webfetch",
								expiryHours: SCREENSHOT_PREVIEW_EXPIRY_HOURS,
							});
							metadata = {
								screenshotPreview: true,
								previewUrl: `/api/shares/${shareId}/preview`,
								width: result.width,
								height: result.height,
							};
						} catch (e) {
							logger.warn("Failed to create screenshot share for preview", {
								error: e instanceof Error ? e.message : String(e),
							});
						}

						return {
							output: `Screenshot of ${url} (${result.width}x${result.height})`,
							images: [{ format: "png", base64: result.base64 }],
							metadata,
							title: url,
						};
					}
					case "dom": {
						const { fetchDom } = await import("../../web-fetch/dom");
						const result = await fetchDom(url, selector, max_length);
						return {
							output: result,
							title: selector ? `${url} [${selector}]` : url,
						};
					}
					case "smart": {
						const { fetchSmart } = await import("../../web-fetch/smart");
						const result = await fetchSmart(url, max_length, purpose);
						return {
							output: result.summary,
							title: result.title || url,
						};
					}
					default:
						return { output: `Unknown mode: ${mode}`, isError: true };
				}
			};

			return await Promise.race([doFetch(), abortPromise]);
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				return { output: "WebFetch was aborted.", isError: true };
			}
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn("WebFetch failed", { url, mode, error: msg });
			return {
				output: `WebFetch failed: ${msg}`,
				isError: true,
			};
		}
	},
};
