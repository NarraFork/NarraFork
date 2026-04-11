import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { actions, closeSession, createSession, getSession, listSessions } from "../../browser";
import { generateShortId } from "../../id";
import { logger } from "../../logger";
import { createShare, getShareDir } from "../../shares";
import type { ToolDefinition, ToolResult } from "../types";

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
	"evaluate",
	"wait",
	"navigate",
	"scroll",
	"dom",
	"close",
	"list_sessions",
] as const;

type Action = (typeof ACTIONS)[number];

export const browserTool: ToolDefinition = {
	name: "Browser",
	description:
		"Control a browser for multi-step web interactions. Supports navigation, clicking, " +
		"form filling, screenshots, DOM inspection, and JavaScript execution.\n\n" +
		"Workflow:\n" +
		'1. Use action "launch" with a URL to start a session (returns session_id)\n' +
		"2. Use the session_id for subsequent actions (click, fill, type, etc.)\n" +
		'3. Use action "close" when done, or sessions auto-expire after 10 min of inactivity\n\n' +
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
		'- "evaluate": Execute JavaScript in the page context\n' +
		'- "wait": Wait for an element to appear or become visible\n' +
		'- "navigate": Go to a new URL, or go back/forward\n' +
		'- "scroll": Scroll the page up or down\n' +
		'- "dom": Get cleaned HTML of the page or a specific selector\n' +
		'- "close": Close a browser session\n' +
		'- "list_sessions": List all active browser sessions\n\n' +
		"Parameters:\n" +
		"- action (required): The action to perform\n" +
		"- url (optional): URL for launch/navigate actions\n" +
		"- session_id (optional): Session ID (required for all actions except launch and list_sessions)\n" +
		"- selector (optional): CSS selector for element actions\n" +
		"- value (optional): Value for fill/select/type/evaluate/get_attribute actions\n" +
		"- key (optional): Special key name for type action (e.g. Enter, Tab, Escape, ArrowDown)\n" +
		"- direction (optional): 'back'/'forward' for navigate, 'up'/'down' for scroll\n" +
		"- timeout (optional): Timeout in ms for wait/element actions (default: 10000)\n" +
		"- coordinate (optional): {x, y} for click/scroll at specific position\n" +
		"- max_length (optional): Max output length for dom/get_text/evaluate (default: 20000)\n" +
		"- headless (optional): Set to false to launch a visible browser window with GUI (default: true). " +
		"Useful for debugging, visual inspection, or interacting with pages that require a display.",
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
				description: "Value for fill/select/type/evaluate/get_attribute actions",
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
				description: "Timeout in ms for wait/element actions (default: 10000)",
				type: "number",
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
			max_length: {
				description: "Max output length for dom/get_text/evaluate (default: 20000)",
				type: "number",
			},
			headless: {
				description:
					"Set to false to launch a visible browser window with GUI (default: true). " +
					"Only applies to the launch action.",
				type: "boolean",
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
		value: z.string().optional().describe("Value for fill/select/type/evaluate/get_attribute"),
		key: z.string().optional().describe("Special key name for type action"),
		direction: z
			.enum(["back", "forward", "up", "down"])
			.optional()
			.describe("Direction for navigate/scroll"),
		timeout: z.number().optional().describe("Timeout in ms"),
		coordinate: z
			.object({ x: z.number(), y: z.number() })
			.optional()
			.describe("Coordinates for positional actions"),
		max_length: z.number().optional().describe("Max output length"),
		headless: z
			.boolean()
			.optional()
			.describe("Launch visible browser GUI (default: true = headless)"),
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
			timeout,
			coordinate,
			max_length,
			headless,
		} = args as {
			action: Action;
			url?: string;
			session_id?: string;
			selector?: string;
			value?: string;
			key?: string;
			direction?: "back" | "forward" | "up" | "down";
			timeout?: number;
			coordinate?: { x: number; y: number };
			max_length?: number;
			headless?: boolean;
		};

		logger.info("Browser tool executing", {
			action,
			session_id,
			selector,
			narratorId: ctx.narratorId,
		});

		try {
			switch (action) {
				case "launch":
					return await handleLaunch(ctx.narratorId, url, headless ?? true);
				case "list_sessions":
					return handleListSessions(ctx.narratorId);
				case "close":
					return await handleClose(ctx.narratorId, session_id);
				default:
					return await handleSessionAction(ctx.narratorId, action, {
						session_id,
						selector,
						value,
						key,
						direction,
						timeout,
						coordinate,
						max_length,
						url,
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

async function handleLaunch(
	narratorId: string,
	url?: string,
	headless = true,
): Promise<ToolResult> {
	if (!url) {
		return { output: "url is required for launch action", isError: true };
	}

	try {
		const parsed = new URL(url);
		if (!parsed.protocol.startsWith("http")) {
			return {
				output: "Only http:// and https:// URLs are supported.",
				isError: true,
			};
		}
	} catch {
		return { output: `Invalid URL: ${url}`, isError: true };
	}

	const session = await createSession(narratorId, url, headless);
	const title = await session.page.title();

	return {
		output:
			`Browser session started (${headless ? "headless" : "headed/GUI"}).\n` +
			`Session ID: ${session.id}\n` +
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
			`- ${s.id} | ${s.url} | ${s.headless ? "headless" : "headed"} | last active: ${new Date(s.lastActivity).toISOString()}`,
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

async function handleSessionAction(
	narratorId: string,
	action: Action,
	opts: {
		session_id?: string;
		selector?: string;
		value?: string;
		key?: string;
		direction?: "back" | "forward" | "up" | "down";
		timeout?: number;
		coordinate?: { x: number; y: number };
		max_length?: number;
		url?: string;
	},
): Promise<ToolResult> {
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

			// Save as temporary share for frontend preview
			let metadata: Record<string, unknown> = { sessionId: session.id };
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
					createdBy: "browser",
					expiryHours: 1,
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
				output: `Screenshot captured (${result.width}x${result.height})`,
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
			});
			return {
				output: result.result,
				metadata: { sessionId: session.id },
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
				selector: opts.selector,
				coordinate: opts.coordinate,
			});
			return {
				output: `Scrolled ${scrollDir}\nURL: ${result.snapshot.url}`,
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

		default:
			return { output: `Unknown action: ${action}`, isError: true };
	}
}
