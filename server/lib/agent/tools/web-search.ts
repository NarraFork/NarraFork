import { z } from "zod/v4";
import { logger } from "../../logger";
import {
	getFirstNugProvider,
	hasConfiguredNugProvider,
} from "../../settings";
import type { ToolDefinition, ToolResult } from "../types";

function isAbortError(err: unknown): boolean {
	return (
		(err instanceof Error && (err.name === "AbortError" || err.message === "Aborted")) ||
		(typeof DOMException !== "undefined" &&
			err instanceof DOMException &&
			err.name === "AbortError")
	);
}

function createNamedError(message: string, name: "AbortError" | "TimeoutError"): Error {
	if (typeof DOMException !== "undefined") {
		return new DOMException(message, name);
	}
	const err = new Error(message);
	err.name = name;
	return err;
}

function normalizeAbortReason(reason: unknown): Error {
	return reason instanceof Error ? reason : createNamedError("Aborted", "AbortError");
}

/** Per-call timeout for a single web search attempt (ms). */
const WEB_SEARCH_TIMEOUT_MS = 60_000;

/**
 * Run a single search attempt with a hard timeout, while still honouring the
 * caller's abort signal.
 *
 * The timeout races the provider call instead of merely aborting its signal, so
 * fallback can continue even if a lower layer ignores AbortSignal (for example,
 * while queued behind a provider-local concurrency limiter). User interruption
 * is still surfaced as AbortError and must not fall through to another provider.
 */
export async function withSearchTimeout<T>(
	ctxSignal: AbortSignal | undefined,
	fn: (signal: AbortSignal) => Promise<T>,
	timeoutMs = WEB_SEARCH_TIMEOUT_MS,
): Promise<T> {
	if (ctxSignal?.aborted) throw normalizeAbortReason(ctxSignal.reason);

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;

	const operation = Promise.resolve().then(() => fn(controller.signal));
	const timeoutOrAbort = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			const err = createNamedError("Web search timed out", "TimeoutError");
			controller.abort(err);
			reject(err);
		}, timeoutMs);

		if (ctxSignal) {
			onAbort = () => {
				const err = normalizeAbortReason(ctxSignal.reason);
				controller.abort(err);
				reject(err);
			};
			ctxSignal.addEventListener("abort", onAbort, { once: true });
		}
	});

	try {
		return await Promise.race([operation, timeoutOrAbort]);
	} finally {
		if (timer) clearTimeout(timer);
		if (ctxSignal && onAbort) ctxSignal.removeEventListener("abort", onAbort);
	}
}

/** Call MCP search via NUG provider. */
async function nugMcpSearch(query: string, signal?: AbortSignal): Promise<McpResponse> {
	const config = getFirstNugProvider();
	if (!config) throw new Error("No NUG provider configured");

	const baseUrl = config.baseUrl.replace(/\/+$/, "");
	const response = await fetch(`${baseUrl}/v1/mcp/search`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.apiKey}`,
		},
		body: JSON.stringify({ query }),
		signal,
	});

	if (!response.ok) {
		const errText = await response.text().catch(() => "");
		throw new Error(`NUG MCP search error ${response.status}: ${errText}`);
	}

	return (await response.json()) as McpResponse;
}


	const baseUrl = config.baseUrl.replace(/\/+$/, "");
	const response = await fetch(`${baseUrl}/v1/mcp/search`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.apiKey}`,
		},
		body: JSON.stringify({ query }),
		signal,
	});

	if (!response.ok) {
		const errText = await response.text().catch(() => "");
	}

	return (await response.json()) as McpResponse;
}

export const webSearchTool: ToolDefinition = {
	name: "WebSearch",
	description:
		"\n- Allows Claude to search the web and use the results to inform responses\n" +
		"- Provides up-to-date information for current events and recent data\n" +
		"- Returns search result information formatted as search result blocks, including links as markdown hyperlinks\n" +
		"- Use this tool for accessing information beyond Claude's knowledge cutoff\n" +
		"- Searches are performed automatically within a single API call\n" +
		"\nCRITICAL REQUIREMENT - You MUST follow this:\n" +
		'  - After answering the user\'s question, you MUST include a "Sources:" section at the end of your response\n' +
		"  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)\n" +
		"  - This is MANDATORY - never skip including sources in your response\n" +
		"  - Example format:\n\n" +
		"    [Your answer here]\n\n" +
		"    Sources:\n" +
		"    - [Source Title 1](https://example.com/1)\n" +
		"    - [Source Title 2](https://example.com/2)\n" +
		"\nUsage notes:\n" +
		"  - Domain filtering is supported to include or block specific websites\n" +
		"  - Web search is only available in the US\n" +
		"\nIMPORTANT - Use the correct year in search queries:\n" +
		"  - The current month is March 2026. You MUST use this year when searching for recent information, documentation, or current events.\n" +
		'  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year',
	rawJsonSchema: {
		type: "object",
		properties: {
			query: {
				description: "The search query to use",
				type: "string",
				minLength: 2,
			},
			allowed_domains: {
				description: "Only include search results from these domains",
				type: "array",
				items: {
					type: "string",
				},
			},
			blocked_domains: {
				description: "Never include search results from these domains",
				type: "array",
				items: {
					type: "string",
				},
			},
		},
		required: ["query"],
		additionalProperties: false,
	},
	parameters: z.object({
		query: z.string().describe("Search query string"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { query } = args as { query: string };

		const nugUp = hasConfiguredNugProvider();

			return {
				output:
				isError: true,
			};
		}

		try {
			if (ctx.signal.aborted) throw new Error("Aborted");

			// Do not fall back when the failure was caused by narrator interruption;
			// that must unwind immediately so the agent loop can clean up.
			let response: McpResponse | undefined;
				try {
					response = await withSearchTimeout(ctx.signal, (signal) =>
					);
					if (nugUp) {
						});
						try {
							response = await withSearchTimeout(ctx.signal, (signal) =>
								nugMcpSearch(query, signal),
							);
						} catch (nugErr) {
							if (ctx.signal.aborted || isAbortError(nugErr)) throw nugErr;
									error: nugErr instanceof Error ? nugErr.message : String(nugErr),
								});
								response = await withSearchTimeout(ctx.signal, (signal) =>
								);
							} else {
								throw nugErr;
							}
						}
						});
					} else {
					}
				}
			} else if (nugUp) {
				try {
					response = await withSearchTimeout(ctx.signal, (signal) => nugMcpSearch(query, signal));
				} catch (nugErr) {
					if (ctx.signal.aborted || isAbortError(nugErr)) throw nugErr;
							error: nugErr instanceof Error ? nugErr.message : String(nugErr),
						});
					} else {
						throw nugErr;
					}
				}
			} else {
			}

			if (response.error) {
				return {
					output: `Search error: ${response.error.message ?? "Unknown error"}`,
					isError: true,
				};
			}

			if (!response.result?.content?.length) {
				return { output: "No results found" };
			}

			const text = response.result.content
				.filter((c) => c.type === "text" && c.text)
				.map((c) => c.text)
				.join("\n\n");

			return {
				output: text || "No results found",
				isError: response.result.isError,
				title: query.slice(0, 80),
			};
		} catch (err) {
			if (ctx.signal.aborted || isAbortError(err)) {
				return {
					output: "Web search aborted by user",
					isError: true,
				};
			}
			return {
				output: `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
