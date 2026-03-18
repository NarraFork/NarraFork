// Smart mode — fetch DOM then summarize with the summary model (Haiku).

import { summaryGenerate } from "../agent";
import { fetchDom } from "./dom";

const DEFAULT_MAX_LENGTH = 20_000;

/** Maximum DOM chars to feed into the summary model. */
const MAX_DOM_FOR_SUMMARY = 80_000;

const SYSTEM_PROMPT = `You are a web page content extractor. Given the cleaned HTML of a web page, extract and summarize the key information.

Rules:
- Output a well-structured summary in markdown format
- Preserve important links as markdown links [text](url)
- Preserve code snippets in fenced code blocks
- Preserve tables as markdown tables
- Preserve lists as markdown lists
- Remove navigation, ads, footers, and other boilerplate
- Focus on the main content of the page
- Keep the summary concise but comprehensive
- If the page is a documentation page, preserve the structure and key details
- If the page is an article, extract the main points
- Output in the same language as the page content`;

export async function fetchSmart(
	url: string,
	maxLength = DEFAULT_MAX_LENGTH,
): Promise<{ summary: string; title: string }> {
	// Get cleaned DOM (use a larger limit since we'll summarize it down)
	const dom = await fetchDom(url, undefined, MAX_DOM_FOR_SUMMARY);

	if (dom.length < 100) {
		return {
			summary: dom || "Page has no meaningful content.",
			title: "",
		};
	}

	const prompt = `URL: ${url}\n\nPage HTML content:\n\n${dom}`;

	const result = await summaryGenerate(prompt, SYSTEM_PROMPT);
	let summary = result.text.trim();

	if (summary.length > maxLength) {
		summary = `${summary.slice(0, maxLength)}\n\n[Summary truncated at ${maxLength} characters]`;
	}

	// Try to extract title from the first heading in the summary
	const titleMatch = summary.match(/^#\s+(.+)/m);
	const title = titleMatch?.[1] ?? "";

	return { summary, title };
}
