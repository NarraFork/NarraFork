/**
 * tool-io-projection.ts — Pure, dependency-free helpers that shape tool
 * input/output payloads in narrator message trees. Kept out of
 * narrator-messages.ts (which pulls db + services) so both the message pipeline
 * and unit tests can import these without triggering the service init chain.
 *
 * Two related transforms live here:
 *  - `truncateToolIO`: the default list projection. Bodies over `maxLen` chars
 *    become `_truncated` placeholders carrying `_hints` (header fields) and the
 *    original length; full content is fetched on demand via /tool-calls/:id.
 *  - `projectTreeForLite`: the low-LOD (L1–L4) projection. At those levels tool
 *    cards render collapsed or fold into an activity trace, so only the tool
 *    HEADER is shown. This drops the body entirely (maxLen 0) while keeping the
 *    same header hints, and it leaves reasoning/text blocks and inline-detail
 *    tools (plan, subagents, questions, spec tasks) fully intact.
 */

/** Truncate a JSON value to a preview string if it exceeds maxLen characters */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function truncateJson(val: any, maxLen: number): any {
	if (val === null || val === undefined) return val;
	const str = typeof val === "string" ? val : JSON.stringify(val);
	if (str.length <= maxLen) return val;
	return { _truncated: true, preview: str.slice(0, maxLen), fullLength: str.length };
}

/** Tool names whose inputJson/outputJson should never be truncated in message lists */
const SKIP_TRUNCATE_TOOLS = new Set(["ExitPlanMode"]);

/** Tool names whose inputJson should not be truncated */
const SKIP_INPUT_TRUNCATE_TOOLS = new Set(["Agent", "Task", "Send"]);

const SPEC_TASKS_URI = "spec://tasks.json";

/**
 * Whether a tool call is a Write/Edit on the Dynamic Spec task queue
 * (spec://tasks.json). Its input must stay untruncated so the client can render
 * the custom task-list card (SpecTasksDetail) during every phase — including the
 * pending taskReflection window, before the completed output carries the parsed
 * task metadata. tasks.json is small by design, so keeping the full input is cheap.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function isSpecTasksInput(toolName: string, input: any): boolean {
	if (toolName !== "Write" && toolName !== "Edit") return false;
	if (!input || typeof input !== "object") return false;
	const filePath = input.file_path ?? input.filePath ?? input.path;
	return filePath === SPEC_TASKS_URI;
}

/**
 * Extract short header-relevant fields from a tool's inputJson before truncation.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function extractHeaderHints(toolName: string, input: any): Record<string, unknown> | undefined {
	if (!input || typeof input !== "object") return undefined;
	const h: Record<string, unknown> = {};
	const str = (k: string) => (typeof input[k] === "string" ? input[k] : undefined);
	const num = (k: string) => (typeof input[k] === "number" ? input[k] : undefined);

	switch (toolName) {
		case "Write":
		case "Edit":
		case "Read": {
			const fp = str("file_path") ?? str("filePath") ?? str("path");
			if (fp) h.file_path = fp;
			const offset = num("offset");
			if (offset != null) h.offset = offset;
			const limit = num("limit");
			if (limit != null) h.limit = limit;
			break;
		}
		case "Bash": {
			const cmd = str("command");
			if (cmd) h.command = cmd.length > 100 ? cmd.slice(0, 100) : cmd;
			// The card header prefers `description` over `command`; keep it in hints
			// so the low-LOD (body-dropped) projection still shows the bash summary.
			const desc = str("description");
			if (desc) h.description = desc.length > 100 ? desc.slice(0, 100) : desc;
			const timeout = num("timeout");
			if (timeout != null) h.timeout = timeout;
			break;
		}
		case "Glob":
		case "Grep": {
			const pat = str("pattern") ?? str("glob");
			if (pat) h.pattern = pat;
			const p = str("path");
			if (p) h.path = p;
			const g = str("glob");
			if (g) h.glob = g;
			break;
		}
		case "WebSearch": {
			const q = str("query");
			if (q) h.query = q;
			break;
		}
		case "WebFetch": {
			const url = str("url");
			if (url) h.url = url;
			const mode = str("mode");
			if (mode) h.mode = mode;
			break;
		}
		case "Terminal": {
			const action = str("action");
			if (action) h.action = action;
			const tid = str("terminal_id");
			if (tid) h.terminal_id = tid;
			const inp = str("input");
			if (inp) h.input = inp.length > 60 ? inp.slice(0, 60) : inp;
			break;
		}
		case "ShareFile": {
			const fp = str("path");
			if (fp) h.path = fp;
			break;
		}
		case "AskUserQuestion": {
			const qs = input.questions;
			if (Array.isArray(qs) && qs.length > 0 && typeof qs[0]?.header === "string") {
				h._firstHeader = qs[0].header;
			}
			break;
		}
		case "Recall": {
			const action = str("action");
			if (action) h.action = action;
			const q = str("query");
			if (q) h.query = q;
			const nid = str("narrator_id");
			if (nid) h.narrator_id = nid;
			const tcId = str("tool_call_id");
			if (tcId) h.tool_call_id = tcId;
			break;
		}
		case "ApprovePermission":
		case "DenyPermission":
		case "GetNarratorContext":
		case "ListManagedNarrators": {
			const rid = str("requestId");
			if (rid) h.requestId = rid;
			const nid = str("narratorId");
			if (nid) h.narratorId = nid;
			break;
		}
		default:
			return undefined;
	}
	return Object.keys(h).length > 0 ? h : undefined;
}

/**
 * Truncate inputJson with header hints attached.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function truncateInputWithHints(toolName: string, val: any, maxLen: number): any {
	if (val === null || val === undefined) return val;
	const str = typeof val === "string" ? val : JSON.stringify(val);
	if (str.length <= maxLen) return val;
	const hints = extractHeaderHints(toolName, val);
	return {
		_truncated: true,
		preview: str.slice(0, maxLen),
		fullLength: str.length,
		...(hints && { _hints: hints }),
	};
}

/** Recursively truncate large inputJson/outputJson in tool calls within a message tree */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function truncateToolIO(tree: any[], maxLen = 2000): any[] {
	return tree.map((msg) => {
		const msgSideCars = Array.isArray(msg.sideCars) ? msg.sideCars : [];
		return {
			...msg,
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			toolCalls: msg.toolCalls?.map((tc: any) => {
				const toolSideCars = msgSideCars.filter((sc: Record<string, unknown>) => {
					return (
						sc.target === "tool_result" && (sc.toolUseId === tc.toolUseId || sc.toolUseId == null)
					);
				});
				const withSideCars = toolSideCars.length > 0 ? { ...tc, sideCars: toolSideCars } : tc;
				if (SKIP_TRUNCATE_TOOLS.has(tc.toolName)) return withSideCars;
				const skipInput =
					SKIP_INPUT_TRUNCATE_TOOLS.has(tc.toolName) || isSpecTasksInput(tc.toolName, tc.inputJson);
				return {
					...withSideCars,
					inputJson: skipInput
						? tc.inputJson
						: truncateInputWithHints(tc.toolName, tc.inputJson, maxLen),
					outputJson: truncateJson(tc.outputJson, maxLen),
				};
			}),
			children: msg.children?.length ? truncateToolIO(msg.children, maxLen) : msg.children,
		};
	});
}

// ── Low-LOD (L1–L4) field projection ───────────────────────────────────────

/**
 * Tools whose card renders structured input/output INLINE even while collapsed
 * (plan preview, subagent activity, question/answer cards). Their bodies must
 * survive the low-LOD projection so the collapsed card still has data. The
 * spec://tasks.json Write/Edit "Todo" card is handled separately via
 * `isSpecTasksInput` because it is keyed on the file path, not the tool name.
 */
const LITE_INLINE_DETAIL_TOOLS = new Set([
	"ExitPlanMode",
	"Agent",
	"Task",
	"Send",
	"AskUserQuestion",
]);

/** True for a value already replaced by the `truncateToolIO` `_truncated` placeholder. */
function isTruncatedPlaceholder(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { _truncated?: unknown })._truncated === true
	);
}

/**
 * Low-LOD tool input projection: drop the full body but keep the header hints
 * (path / command / pattern / grep / url …) the collapsed tool card reads.
 * Exempt tools (inline-detail + spec tasks) keep their full input. Already
 * truncated inputs are left as-is (they already carry hints + fullLength).
 */
// biome-ignore lint/suspicious/noExplicitAny: message trees are provider-shaped JSON
function liteProjectToolInput(toolName: string, input: any): any {
	if (input == null || isTruncatedPlaceholder(input)) return input;
	if (
		LITE_INLINE_DETAIL_TOOLS.has(toolName) ||
		SKIP_INPUT_TRUNCATE_TOOLS.has(toolName) ||
		SKIP_TRUNCATE_TOOLS.has(toolName) ||
		isSpecTasksInput(toolName, input)
	) {
		return input;
	}
	// maxLen 0 forces a header-hint placeholder without shipping any body chars.
	return truncateInputWithHints(toolName, input, 0);
}

/**
 * Low-LOD tool output projection: collapsed cards never show output, so drop
 * the body to a `_truncated` placeholder (full content stays fetchable via
 * /tool-calls/:toolUseId). Inline-detail tools keep their full output.
 */
// biome-ignore lint/suspicious/noExplicitAny: message trees are provider-shaped JSON
function liteProjectToolOutput(toolName: string, output: any): any {
	if (output == null || isTruncatedPlaceholder(output)) return output;
	if (LITE_INLINE_DETAIL_TOOLS.has(toolName) || SKIP_TRUNCATE_TOOLS.has(toolName)) return output;
	return truncateJson(output, 0);
}

/**
 * Low-LOD (L1–L4) message-tree projection. LOD decides which *fields* the
 * client needs, not string lengths: at low detail the tool cards are collapsed
 * or folded into an activity trace, so only tool headers are rendered. This
 * drops tool input/output bodies (recoverable on demand) while leaving reasoning
 * blocks, assistant/user text, and inline-detail tools fully intact.
 */
// biome-ignore lint/suspicious/noExplicitAny: message trees are provider-shaped JSON
export function projectTreeForLite(tree: any[]): any[] {
	return tree.map((msg) => {
		const contentJson = Array.isArray(msg.contentJson)
			? // biome-ignore lint/suspicious/noExplicitAny: provider-shaped block JSON
				msg.contentJson.map((block: any) => {
					if (!block || block.type !== "tool_use") return block;
					const name = typeof block.name === "string" ? block.name : "";
					return {
						...block,
						inputJson: liteProjectToolInput(name, block.inputJson),
						input: liteProjectToolInput(name, block.input),
						outputJson: liteProjectToolOutput(name, block.outputJson),
					};
				})
			: msg.contentJson;
		const toolCalls = Array.isArray(msg.toolCalls)
			? // biome-ignore lint/suspicious/noExplicitAny: provider-shaped tool-call JSON
				msg.toolCalls.map((tc: any) => ({
					...tc,
					inputJson: liteProjectToolInput(tc.toolName, tc.inputJson),
					outputJson: liteProjectToolOutput(tc.toolName, tc.outputJson),
				}))
			: msg.toolCalls;
		return {
			...msg,
			contentJson,
			toolCalls,
			children: msg.children?.length ? projectTreeForLite(msg.children) : msg.children,
		};
	});
}
