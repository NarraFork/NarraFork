import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod/v4";
import {
	actions,
	closeSession,
	createSession,
	DEFAULT_SESSION_TTL_MS,
	getSession,
	listSessions,
	MAX_SESSION_TTL_MS,
	MIN_SESSION_TTL_MS,
	setSessionTtl,
	startNetworkCapture,
	stopNetworkCapture,
} from "../../browser";
import { generateShortId } from "../../id";
import { logger } from "../../logger";
import { createShare, getShareDir, SCREENSHOT_PREVIEW_EXPIRY_HOURS } from "../../shares";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";
import { trackFileChange } from "./track-file-change";

const ACTIONS = [
	"launch",
	"click",
	"fill",
	"select",
	"type",
	"hover",
	"screenshot",
	"get_text",
	"get_attribute",
	"get_console",
	"get_network",
	"network_start",
	"network_stop",
	"evaluate",
	"evaluate_capture",
	"wait",
	"navigate",
	"scroll",
	"dom",
	"close",
	"set_ttl",
	"list_sessions",
	"perf_start",
	"perf_stop",
] as const;

type Action = (typeof ACTIONS)[number];

export const browserTool: ToolDefinition = {
	name: "Browser",
	description:
		"Control a browser for multi-step web interactions. Supports navigation, clicking, " +
		"form filling, screenshots, DOM inspection, JavaScript execution, network debugging, " +
		"and performance profiling.\n\n" +
		"Workflow:\n" +
		'1. Use action "launch" with a URL to start a session (returns session_id)\n' +
		"2. Use the session_id for subsequent actions (click, fill, type, etc.)\n" +
		'3. Use action "close" when done, or sessions auto-expire after the configured inactivity TTL (default 10 min)\n\n' +
		"Actions:\n" +
		'- "launch": Open a URL and create a browser session\n' +
		'- "click": Click an element (by CSS selector)\n' +
		'- "fill": Fill a form field (clears existing value first)\n' +
		'- "select": Select a dropdown option\n' +
		'- "type": Type text character by character, or press a special key (Enter, Tab, Escape, etc.)\n' +
		'- "hover": Hover over an element\n' +
		'- "screenshot": Capture the current page as an image\n' +
		'- "get_text": Get text content of an element\n' +
		'- "get_attribute": Get an attribute value of an element\n' +
		'- "get_console": Get captured console output and page errors\n' +
		'- "get_network": Get captured network requests/responses and failures\n' +
		'- "network_start": Start capturing network requests for this session (optionally clear old captures)\n' +
		'- "network_stop": Stop capturing network requests for this session\n' +
		'- "evaluate": Execute JavaScript in the page context and return the evaluated value\n' +
		'- "evaluate_capture": Execute JavaScript and return both the value and console output emitted during the run\n' +
		"  Prefer evaluate_capture when using JavaScript to interact with the page and inspect logs. " +
		"Use an IIFE/async IIFE for multi-statement scripts and return JSON-serializable data when possible.\n" +
		'- "wait": Wait for an element to appear or become visible\n' +
		'- "navigate": Go to a new URL, or go back/forward\n' +
		'- "scroll": Scroll the page up or down\n' +
		'- "dom": Get cleaned HTML of the page or a specific selector\n' +
		'- "close": Close a browser session\n' +
		'- "set_ttl": Update a session inactivity auto-close TTL in milliseconds\n' +
		'- "list_sessions": List all active browser sessions\n' +
		'- "perf_start": Start performance tracing (records CPU profile, layout, scripting, etc.). ' +
		"Note: the user can stop tracing or close the session from the browser management panel — " +
		"if that happens, a system message will notify you\n" +
		'- "perf_stop": Stop tracing and save trace data to a JSON file (returns file path). ' +
		"The trace file is in Chrome DevTools Trace Event format — " +
		"use grep/bash/python to analyze it, or open it in Chrome DevTools\n\n" +
		"Network capture is OFF by default. Use network_start/network_stop to capture only when needed. " +
		"If you need the initial page-load requests, set capture_network=true on launch.\n\n" +
		"Parameters:\n" +
		"- action (required): The action to perform\n" +
		"- url (optional): URL for launch/navigate actions\n" +
		"- session_id (optional): Session ID (required for all actions except launch and list_sessions)\n" +
		"- selector (optional): CSS selector for element actions\n" +
		"- value (optional): Value for fill/select/type/evaluate/get_attribute actions\n" +
		"- key (optional): Special key name for type action (e.g. Enter, Tab, Escape, ArrowDown)\n" +
		"- direction (optional): 'back'/'forward' for navigate, 'up'/'down' for scroll\n" +
		"- amount (optional): Scroll distance in pixels for scroll action (default: 500)\n" +
		"- timeout (optional): Timeout in ms for wait/element actions and JavaScript execution (default: 10000 for wait)\n" +
		"- ttl_ms (optional): Browser session inactivity auto-close TTL in ms for launch/set_ttl; default 600000, allowed 1000–86400000\n" +
		"- coordinate (optional): {x, y} for click/scroll at specific position\n" +
		"- max_length (optional): Max output length for dom/get_text/evaluate/evaluate_capture/get_console/get_network (default: 20000)\n" +
		"- clear (optional): For get_console/get_network, clear captured output after reading; for evaluate_capture, clear console before running (default: true)\n" +
		"- wait_after_ms (optional): For evaluate_capture, wait this many ms after script execution before collecting console output\n" +
		"- include_details (optional): For get_network, include request/response headers and post data (default: false)\n" +
		"- capture_network (optional): For launch only, start network capture before initial navigation (default: false)\n" +
		"- file_path (optional): For screenshot only, save the PNG to this path; relative paths resolve against cwd\n" +
		"- headless (optional): Set to false to launch a visible browser window with GUI (default: true). " +
		"Useful for debugging, visual inspection, or interacting with pages that require a display.\n" +
		"- categories (optional): Array of Chrome trace categories for perf_start (uses sensible defaults if omitted)",
	rawJsonSchema: {
		type: "object",
		properties: {
			action: {
				description: "The browser action to perform",
				type: "string",
				enum: ACTIONS,
			},
			url: {
				description: "URL for launch/navigate actions",
				type: "string",
			},
			session_id: {
				description:
					"Browser session ID (required for all actions except launch and list_sessions)",
				type: "string",
			},
			selector: {
				description: "CSS selector for element actions",
				type: "string",
			},
			value: {
				description:
					"Value for fill/select/type/evaluate/evaluate_capture/get_attribute actions, or filter for get_network",
				type: "string",
			},
			key: {
				description: "Special key name for type action (e.g. Enter, Tab, Escape, ArrowDown)",
				type: "string",
			},
			direction: {
				description: "Direction: 'back'/'forward' for navigate, 'up'/'down' for scroll",
				type: "string",
				enum: ["back", "forward", "up", "down"],
			},
			timeout: {
				description:
					"Timeout in ms for wait/element actions and JavaScript execution (default: 10000 for wait)",
				type: "number",
			},
			ttl_ms: {
				description: "Browser session inactivity auto-close TTL in milliseconds for launch/set_ttl",
				type: "number",
				minimum: MIN_SESSION_TTL_MS,
				maximum: MAX_SESSION_TTL_MS,
			},
			coordinate: {
				description: "Coordinates for positional click/scroll",
				type: "object",
				properties: {
					x: { type: "number" },
					y: { type: "number" },
				},
				required: ["x", "y"],
			},
			amount: {
				description: "Scroll distance in pixels for scroll action (default: 500)",
				type: "number",
			},
			max_length: {
				description:
					"Max output length for dom/get_text/evaluate/evaluate_capture/get_console/get_network (default: 20000)",
				type: "number",
			},
			clear: {
				description:
					"For get_console/get_network, clear captured output after reading; " +
					"for evaluate_capture, clear console before running",
				type: "boolean",
			},
			wait_after_ms: {
				description:
					"For evaluate_capture, wait this many milliseconds after script execution " +
					"before collecting console output",
				type: "number",
			},
			include_details: {
				description: "For get_network, include headers and post data in output",
				type: "boolean",
			},
			capture_network: {
				description:
					"For launch only, start network capture before initial navigation (default: false)",
				type: "boolean",
			},
			file_path: {
				description:
					"For screenshot only, save the captured PNG to this path. Relative paths resolve against cwd.",
				type: "string",
				minLength: 1,
			},
			headless: {
				description:
					"Set to false to launch a visible browser window with GUI (default: true). " +
					"Only applies to the launch action.",
				type: "boolean",
			},
			categories: {
				description:
					"Array of Chrome trace categories for perf_start " +
					"(uses sensible defaults if omitted)",
				type: "array",
				items: { type: "string" },
			},
		},
		required: ["action"],
		additionalProperties: false,
	},
	parameters: z.object({
		action: z.enum(ACTIONS).describe("The browser action to perform"),
		url: z.string().optional().describe("URL for launch/navigate"),
		session_id: z.string().optional().describe("Browser session ID"),
		selector: z.string().optional().describe("CSS selector"),
		value: z
			.string()
			.optional()
			.describe(
				"Value for fill/select/type/evaluate/evaluate_capture/get_attribute, or filter for get_network",
			),
		key: z.string().optional().describe("Special key name for type action"),
		direction: z
			.enum(["back", "forward", "up", "down"])
			.optional()
			.describe("Direction for navigate/scroll"),
		timeout: looseNumber("Timeout in ms"),
		ttl_ms: looseNumber("Browser session inactivity auto-close TTL in milliseconds"),
		coordinate: z
			.object({ x: z.coerce.number(), y: z.coerce.number() })
			.optional()
			.describe("Coordinates for positional actions"),
		amount: looseNumber("Scroll distance in pixels for scroll action"),
		max_length: looseNumber("Max output length"),
		clear: z
			.boolean()
			.optional()
			.describe(
				"For get_console/get_network, clear captured output after reading; for evaluate_capture, clear console before running",
			),
		wait_after_ms: looseNumber(
			"For evaluate_capture, wait after script execution before collecting console output",
		),
		include_details: z
			.boolean()
			.optional()
			.describe("For get_network, include headers and post data in output"),
		capture_network: z
			.boolean()
			.optional()
			.describe("For launch only, start network capture before initial navigation"),
		file_path: z
			.string()
			.min(1)
			.optional()
			.describe("For screenshot only, save the captured PNG to this path"),
		headless: z
			.boolean()
			.optional()
			.describe("Launch visible browser GUI (default: true = headless)"),
		categories: z.array(z.string()).optional().describe("Chrome trace categories for perf_start"),
	}),

	async execute(args, ctx): Promise<ToolResult> {
		const {
			action,
			url,
			session_id,
			selector,
			value,
			key,
			direction,
			clear,
			include_details,
			capture_network,
			file_path,
			headless,
			categories,
		} = args as {
			action: Action;
			url?: string;
			session_id?: string;
			selector?: string;
			value?: string;
			key?: string;
			direction?: "back" | "forward" | "up" | "down";
			clear?: boolean;
			include_details?: boolean;
			capture_network?: boolean;
			file_path?: string;
			headless?: boolean;
			categories?: string[];
		};

		// Normalize numeric params leniently (float/string/out-of-range → sane int).
		const timeout = normalizeNumber((args as { timeout?: unknown }).timeout, { min: 0 });
		const ttl_ms = normalizeNumber((args as { ttl_ms?: unknown }).ttl_ms, {
			min: MIN_SESSION_TTL_MS,
			max: MAX_SESSION_TTL_MS,
		});
		const amount = normalizeNumber((args as { amount?: unknown }).amount, { min: 1 });
		const max_length = normalizeNumber((args as { max_length?: unknown }).max_length, { min: 1 });
		const wait_after_ms = normalizeNumber((args as { wait_after_ms?: unknown }).wait_after_ms, {
			min: 0,
		});
		// The tool executor validates but does not coerce args, so the raw coordinate
		// may carry string-encoded x/y. Normalize both into finite ints; drop the
		// coordinate entirely if either axis is unusable.
		const rawCoordinate = (args as { coordinate?: { x?: unknown; y?: unknown } }).coordinate;
		const coordinateX = normalizeNumber(rawCoordinate?.x, {});
		const coordinateY = normalizeNumber(rawCoordinate?.y, {});
		const coordinate =
			coordinateX != null && coordinateY != null ? { x: coordinateX, y: coordinateY } : undefined;

		logger.info("Browser tool executing", {
			action,
			session_id,
			selector,
			narratorId: ctx.narratorId,
		});

		try {
			switch (action) {
				case "launch":
					return await handleLaunch(
						ctx.narratorId,
						url,
						headless ?? true,
						ttl_ms,
						capture_network ?? false,
					);
				case "list_sessions":
					return handleListSessions(ctx.narratorId);
				case "close":
					return await handleClose(ctx.narratorId, session_id);
				case "set_ttl":
					return handleSetTtl(ctx.narratorId, session_id, ttl_ms);
				default:
					return await handleSessionAction(ctx, action, {
						session_id,
						selector,
						value,
						key,
						direction,
						timeout,
						ttl_ms,
						coordinate,
						amount,
						max_length,
						clear,
						wait_after_ms,
						include_details,
						file_path,
						url,
						categories,
						signal: ctx.signal,
					});
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn("Browser tool failed", { action, error: msg });
			return { output: `Browser action failed: ${msg}`, isError: true };
		}
	},
};

// ── Action handlers ──

function formatDurationMs(ms: number): string {
	if (ms < 60_000) return `${ms}ms`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}

async function handleLaunch(
	narratorId: string,
	url?: string,
	headless = true,
	ttlMs?: number,
	captureNetwork = false,
): Promise<ToolResult> {
	if (!url) {
		return { output: "url is required for launch action", isError: true };
	}

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

	const session = await createSession(narratorId, url, headless, ttlMs, captureNetwork);
	const title = await session.page.title();

	return {
		output:
			`Browser session started (${headless ? "headless" : "headed/GUI"}).\n` +
			`Session ID: ${session.id}\n` +
			`Auto-close TTL: ${session.ttlMs}ms (${formatDurationMs(session.ttlMs)} of inactivity)\n` +
			`Network capture: ${session.networkCaptureEnabled ? "enabled" : "disabled"}\n` +
			`URL: ${session.page.url()}\n` +
			`Title: ${title}`,
		metadata: { sessionId: session.id },
	};
}

function handleListSessions(narratorId: string): ToolResult {
	const list = listSessions(narratorId);
	if (list.length === 0) {
		return { output: "No active browser sessions." };
	}
	const lines = list.map(
		(s) =>
			`- ${s.id} | ${s.url} | ${s.headless ? "headless" : "headed"} | ` +
			`network: ${s.networkCaptureEnabled ? "capturing" : "off"} (${s.networkRequestCount}) | ` +
			`ttl: ${formatDurationMs(s.ttlMs)} | expires: ${new Date(s.expiresAt).toISOString()} | ` +
			`last active: ${new Date(s.lastActivity).toISOString()}`,
	);
	return {
		output: `Active sessions (${list.length}):\n${lines.join("\n")}`,
	};
}

async function handleClose(narratorId: string, sessionId?: string): Promise<ToolResult> {
	if (!sessionId) {
		return {
			output: "session_id is required for close action",
			isError: true,
		};
	}
	const closed = await closeSession(narratorId, sessionId);
	if (!closed) {
		return {
			output: `Session not found: ${sessionId}`,
			isError: true,
		};
	}
	return { output: `Session ${sessionId} closed.` };
}

function handleSetTtl(narratorId: string, sessionId?: string, ttlMs?: number): ToolResult {
	if (!sessionId) {
		return {
			output: "session_id is required for set_ttl action",
			isError: true,
		};
	}
	if (ttlMs === undefined) {
		return {
			output: `ttl_ms is required for set_ttl action (default is ${DEFAULT_SESSION_TTL_MS}ms)`,
			isError: true,
		};
	}
	const session = setSessionTtl(narratorId, sessionId, ttlMs);
	if (!session) {
		return {
			output: `Session not found or expired: ${sessionId}`,
			isError: true,
		};
	}
	return {
		output:
			`Session ${sessionId} auto-close TTL set to ${session.ttlMs}ms ` +
			`(${formatDurationMs(session.ttlMs)} of inactivity).\n` +
			`Expires at: ${new Date(session.lastActivity + session.ttlMs).toISOString()}`,
		metadata: { sessionId: session.id, ttlMs: session.ttlMs },
	};
}

async function handleSessionAction(
	ctx: ToolContext,
	action: Action,
	opts: {
		session_id?: string;
		selector?: string;
		value?: string;
		key?: string;
		direction?: "back" | "forward" | "up" | "down";
		timeout?: number;
		ttl_ms?: number;
		coordinate?: { x: number; y: number };
		amount?: number;
		max_length?: number;
		clear?: boolean;
		wait_after_ms?: number;
		include_details?: boolean;
		file_path?: string;
		url?: string;
		categories?: string[];
		signal?: AbortSignal;
	},
): Promise<ToolResult> {
	const narratorId = ctx.narratorId;
	if (!opts.session_id) {
		return {
			output: "session_id is required for this action",
			isError: true,
		};
	}

	const session = getSession(narratorId, opts.session_id);
	if (!session) {
		return {
			output: `Session not found or expired: ${opts.session_id}`,
			isError: true,
		};
	}

	switch (action) {
		case "click": {
			if (!opts.selector && !opts.coordinate) {
				return {
					output: "selector or coordinate is required for click",
					isError: true,
				};
			}
			const result = await actions.click(session, opts.selector ?? "", {
				coordinate: opts.coordinate,
				timeout: opts.timeout,
			});
			return {
				output: `Clicked ${opts.selector ?? `(${opts.coordinate?.x},${opts.coordinate?.y})`}\nURL: ${result.snapshot.url}\nTitle: ${result.snapshot.title}`,
				metadata: { sessionId: session.id },
			};
		}

		case "fill": {
			if (!opts.selector) {
				return {
					output: "selector is required for fill",
					isError: true,
				};
			}
			if (opts.value === undefined) {
				return { output: "value is required for fill", isError: true };
			}
			const result = await actions.fill(session, opts.selector, opts.value, {
				timeout: opts.timeout,
			});
			return {
				output: `Filled "${opts.selector}" with "${opts.value}"\nURL: ${result.snapshot.url}`,
				metadata: { sessionId: session.id },
			};
		}

		case "select": {
			if (!opts.selector) {
				return {
					output: "selector is required for select",
					isError: true,
				};
			}
			if (opts.value === undefined) {
				return { output: "value is required for select", isError: true };
			}
			const result = await actions.select(session, opts.selector, opts.value, {
				timeout: opts.timeout,
			});
			return {
				output: `Selected "${opts.value}" in "${opts.selector}"\nURL: ${result.snapshot.url}`,
				metadata: { sessionId: session.id },
			};
		}

		case "type": {
			if (!opts.value && !opts.key) {
				return {
					output: "value or key is required for type",
					isError: true,
				};
			}
			const result = await actions.type(session, {
				selector: opts.selector,
				value: opts.value,
				key: opts.key,
				timeout: opts.timeout,
			});
			return {
				output: `Typed ${opts.key ? `key "${opts.key}"` : `"${opts.value}"`}${opts.selector ? ` in "${opts.selector}"` : ""}\nURL: ${result.snapshot.url}`,
				metadata: { sessionId: session.id },
			};
		}

		case "hover": {
			if (!opts.selector) {
				return {
					output: "selector is required for hover",
					isError: true,
				};
			}
			const result = await actions.hover(session, opts.selector, {
				timeout: opts.timeout,
			});
			return {
				output: `Hovered over "${opts.selector}"\nURL: ${result.snapshot.url}`,
				metadata: { sessionId: session.id },
			};
		}

		case "screenshot": {
			const result = await actions.screenshot(session);
			const buffer = Buffer.from(result.base64, "base64");
			let savedFilePath: string | undefined;

			if (opts.file_path) {
				savedFilePath = resolve(ctx.cwd, opts.file_path);
				await mkdir(dirname(savedFilePath), { recursive: true });
				await writeFile(savedFilePath, buffer);
				await trackFileChange(ctx, savedFilePath);
			}

			// Save as a share so the frontend can preview it. The URL is persisted with
			// the tool call and stays in the conversation forever, so a short expiry
			// silently breaks every screenshot the user scrolls back to — use the
			// screenshot-preview lifetime rather than the 1h "temporary download" one.
			let metadata: Record<string, unknown> = {
				sessionId: session.id,
				...(savedFilePath ? { savedFilePath } : {}),
			};
			try {
				const shareId = generateShortId();
				const shareDir = getShareDir(shareId);
				const filename = "screenshot.png";
				const filePath = resolve(shareDir, filename);
				await writeFile(filePath, buffer);
				createShare({
					id: shareId,
					originalName: filename,
					storagePath: filePath,
					size: buffer.length,
					createdBy: "browser",
					expiryHours: SCREENSHOT_PREVIEW_EXPIRY_HOURS,
				});
				metadata = {
					...metadata,
					screenshotPreview: true,
					previewUrl: `/api/shares/${shareId}/preview`,
					width: result.width,
					height: result.height,
				};
			} catch (e) {
				logger.warn("Failed to create screenshot share", {
					error: e instanceof Error ? e.message : String(e),
				});
			}

			return {
				output:
					`Screenshot captured (${result.width}x${result.height})` +
					(savedFilePath ? `\nSaved to: ${savedFilePath}` : ""),
				images: [{ format: "png", base64: result.base64 }],
				metadata,
			};
		}

		case "get_text": {
			if (!opts.selector) {
				return {
					output: "selector is required for get_text",
					isError: true,
				};
			}
			const result = await actions.getText(session, opts.selector, {
				maxLength: opts.max_length,
				timeout: opts.timeout,
			});
			return {
				output: result.text || "(empty)",
				metadata: { sessionId: session.id },
			};
		}

		case "get_console": {
			const result = await actions.getConsole(session, {
				maxLength: opts.max_length,
				clear: opts.clear,
			});
			return {
				output:
					`${result.output}\n\n` +
					`Captured messages: ${result.count}${opts.clear ? " (cleared)" : ""}\n` +
					`URL: ${result.snapshot.url}`,
				metadata: { sessionId: session.id, consoleMessageCount: result.count },
			};
		}

		case "get_network": {
			const result = await actions.getNetwork(session, {
				maxLength: opts.max_length,
				clear: opts.clear,
				filter: opts.value,
				includeDetails: opts.include_details,
			});
			const filtered = opts.value ? ` matching "${opts.value}"` : "";
			return {
				output:
					`${result.output}\n\n` +
					`Captured requests${filtered}: ${result.count} / ${result.totalCount}${opts.clear ? " (cleared)" : ""}\n` +
					`Network capture: ${session.networkCaptureEnabled ? "enabled" : "disabled"}\n` +
					`URL: ${result.snapshot.url}`,
				metadata: {
					sessionId: session.id,
					networkRequestCount: result.count,
					networkRequestTotalCount: result.totalCount,
					networkCaptureEnabled: session.networkCaptureEnabled,
				},
			};
		}

		case "network_start": {
			const updated = startNetworkCapture(narratorId, session.id, { clear: opts.clear }) ?? session;
			return {
				output:
					`Network capture started for session ${updated.id}.` +
					(opts.clear ? " Existing captured requests were cleared." : ""),
				metadata: {
					sessionId: updated.id,
					networkCaptureEnabled: updated.networkCaptureEnabled,
					networkRequestCount: updated.networkRequests.length,
				},
			};
		}

		case "network_stop": {
			const updated = stopNetworkCapture(narratorId, session.id) ?? session;
			return {
				output: `Network capture stopped for session ${updated.id}. Captured requests are retained for get_network.`,
				metadata: {
					sessionId: updated.id,
					networkCaptureEnabled: updated.networkCaptureEnabled,
					networkRequestCount: updated.networkRequests.length,
				},
			};
		}

		case "get_attribute": {
			if (!opts.selector) {
				return {
					output: "selector is required for get_attribute",
					isError: true,
				};
			}
			if (!opts.value) {
				return {
					output: "value (attribute name) is required for get_attribute",
					isError: true,
				};
			}
			const result = await actions.getAttribute(session, opts.selector, opts.value, {
				timeout: opts.timeout,
			});
			return {
				output:
					result.value !== null
						? `${opts.value}="${result.value}"`
						: `Attribute "${opts.value}" not found on "${opts.selector}"`,
				metadata: { sessionId: session.id },
			};
		}

		case "evaluate": {
			if (!opts.value) {
				return {
					output: "value (JavaScript expression) is required for evaluate",
					isError: true,
				};
			}
			const result = await actions.evaluate(session, opts.value, {
				maxLength: opts.max_length,
				timeout: opts.timeout,
				signal: opts.signal,
			});
			return {
				output: result.result,
				metadata: { sessionId: session.id },
			};
		}

		case "evaluate_capture": {
			if (!opts.value) {
				return {
					output: "value (JavaScript expression) is required for evaluate_capture",
					isError: true,
				};
			}
			const result = await actions.evaluateCapture(session, opts.value, {
				maxLength: opts.max_length,
				timeout: opts.timeout,
				clear: opts.clear,
				waitAfterMs: opts.wait_after_ms,
				signal: opts.signal,
			});
			return {
				output:
					`Return value:\n${result.result}\n\n` +
					`Console messages during script (${result.consoleCount}):\n${result.consoleOutput}\n\n` +
					`URL: ${result.snapshot.url}\n` +
					`Title: ${result.snapshot.title}\n` +
					`Duration: ${result.durationMs}ms`,
				isError: result.isError,
				metadata: {
					sessionId: session.id,
					consoleMessageCount: result.consoleCount,
					durationMs: result.durationMs,
					...(result.error ? { error: result.error } : {}),
				},
			};
		}

		case "wait": {
			const result = await actions.wait(session, {
				selector: opts.selector,
				timeout: opts.timeout,
			});
			return {
				output: opts.selector
					? `Element "${opts.selector}" is now visible\nURL: ${result.snapshot.url}`
					: `Waited ${opts.timeout ?? 10000}ms\nURL: ${result.snapshot.url}`,
				metadata: { sessionId: session.id },
			};
		}

		case "navigate": {
			const navDirection =
				opts.direction === "back" || opts.direction === "forward" ? opts.direction : undefined;
			const result = await actions.navigate(session, {
				url: opts.url,
				direction: navDirection,
			});
			return {
				output: `Navigated to: ${result.snapshot.url}\nTitle: ${result.snapshot.title}`,
				metadata: { sessionId: session.id },
			};
		}

		case "scroll": {
			const scrollDir =
				opts.direction === "up" || opts.direction === "down" ? opts.direction : "down";
			const result = await actions.scroll(session, {
				direction: scrollDir,
				amount: opts.amount,
				selector: opts.selector,
				coordinate: opts.coordinate,
			});
			return {
				output: `Scrolled ${scrollDir}${opts.amount ? ` ${opts.amount}px` : ""}\nURL: ${result.snapshot.url}`,
				metadata: { sessionId: session.id },
			};
		}

		case "dom": {
			const result = await actions.getDom(session, {
				selector: opts.selector,
				maxLength: opts.max_length,
			});
			return {
				output: result.dom,
				title: opts.selector ? `${result.snapshot.url} [${opts.selector}]` : result.snapshot.url,
				metadata: { sessionId: session.id },
			};
		}

		case "perf_start": {
			await actions.perfStart(session, { categories: opts.categories });
			return {
				output: "Performance tracing started. Perform your actions, then use perf_stop.",
				metadata: { sessionId: session.id },
			};
		}

		case "perf_stop": {
			const shareId = generateShortId();
			const shareDir = getShareDir(shareId);
			const filename = `trace-${session.id}-${Date.now()}.json`;
			const filePath = resolve(shareDir, filename);

			const result = await actions.perfStop(session, filePath);

			createShare({
				id: shareId,
				originalName: filename,
				storagePath: filePath,
				size: result.fileSize,
				createdBy: "browser",
				expiryHours: 24,
			});

			return {
				output:
					`Performance tracing stopped.\n` +
					`Duration: ${(result.durationMs / 1000).toFixed(1)}s\n` +
					`Trace file: ${filePath}\n` +
					`Size: ${(result.fileSize / 1024).toFixed(1)} KB\n` +
					`Share URL: /api/shares/${shareId}/download\n` +
					`The trace file is in Chrome DevTools Trace Event format (JSON with traceEvents array).`,
				metadata: {
					sessionId: session.id,
					tracePath: filePath,
					shareId,
					shareUrl: `/api/shares/${shareId}/download`,
				},
			};
		}

		default:
			return { output: `Unknown action: ${action}`, isError: true };
	}
}
