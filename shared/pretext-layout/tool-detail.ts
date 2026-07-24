/**
 * tool-detail.ts — PURE classifier: narrator tool call → `ToolDetailData`.
 *
 * This module produces the height-model DATA for a tool call's expanded detail
 * region (line counts / task strings / body lines / pixel estimates). It NEVER
 * measures the DOM and imports nothing from `frontend/` — it lives inside the
 * shared pretext-layout isolation boundary (enforced by shared-core.guard.test).
 *
 * The render layer (ToolCallCard.tsx / measure-tool-call.ts) paints the actual
 * content later; this file only decides which detail variant applies and how
 * many wrapping lines / pixels it will occupy.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TYPE-SYNC NOTE (IMPORTANT):
 * The `ToolDetailData` union + variant types below are a STRUCTURAL COPY of the
 * authoritative definitions in
 *   frontend/components/narrator/vlist/measure/measure-tool-call.ts (~L205-296).
 * They are duplicated here (rather than imported) because importing a frontend
 * module would break this file's purity guard. The two copies MUST stay in sync
 * field-for-field. If you change one, change the other. The adapter passes
 * `data.detail` through the registry's `unknown`-compatible boundary, so
 * structural identity is all that is required.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// Structural mirror of measure-tool-call.ts's detail union (keep in sync).
// ─────────────────────────────────────────────────────────────────────────────

/** Which maxHeight cap a `capped` detail body uses (mirrors DetailCapKind). */
export type DetailCapKind =
	| "code"
	| "term"
	| "diff"
	| "bash-cmd"
	| "media"
	| "skill"
	| "knowledge"
	| "plan"
	| "streaming-bash"
	| "streaming";

/** 🟡 A single maxHeight-capped detail body (code/term/diff/media/skill/…). */
export interface ToolCappedDetail {
	kind: "capped";
	/** Which cap applies (also selects the default label behaviour). */
	cap: DetailCapKind;
	/** Estimated content line count (× DETAIL_CONTENT_LINE_HEIGHT). */
	contentLines?: number;
	/** Direct content pixel estimate (media/images); wins over contentLines. */
	contentPx?: number;
	/** Override the default label presence for this cap kind. */
	hasLabel?: boolean;
	/**
	 * The real body text (code / command / diff / output). RENDER-ONLY: painted
	 * inside the maxHeight-capped scroll box, so it never affects the measured
	 * height (which is driven by contentLines/contentPx + the cap). Absent for
	 * media/image caps (contentPx-only) where there is no text.
	 */
	text?: string;
}

/** 🟡 Generic detail: an input section + an optional output section (cap 200 each). */
export interface ToolGenericDetail {
	kind: "generic";
	inputLines: number;
	outputLines?: number;
	/** Real input/output body text. RENDER-ONLY (painted in the capped box). */
	inputText?: string;
	outputText?: string;
}

/** 🔴 SpecTasks list: one wrapped row per task (task text drives wrapping). */
export interface ToolSpecTasksDetail {
	kind: "spec-tasks";
	tasks: string[];
}

/** 🔴 Structured segment (recall/send/pipeline/web-search): badges + body lines. */
export interface ToolStructuredDetail {
	kind: "structured";
	/** Number of badge header rows (0 = none). */
	badgeRows?: number;
	/** Body text lines (each wraps; monospace when `mono`). */
	bodyLines: string[];
	/** Render the body lines in monospace (recall paths, pipeline ids). */
	mono?: boolean;
}

/** 🔴 Error detail: a leading icon + wrapped error text. */
export interface ToolErrorDetail {
	kind: "error";
	text: string;
}

export type ToolDetailData =
	| ToolCappedDetail
	| ToolGenericDetail
	| ToolSpecTasksDetail
	| ToolStructuredDetail
	| ToolErrorDetail;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (faithful copies of frontend/components/narrator/tool-display.ts
// lines 149-242 — isTruncated / resolveDisplayText / extractField /
// extractNumericField — plus a local countLines helper).
// ─────────────────────────────────────────────────────────────────────────────

/** Type guard for a truncated field wrapper `{ _truncated:true; preview:string; … }`. */
export function isTruncated(val: unknown): val is {
	_truncated: true;
	preview: string;
	fullLength: number;
	_hints?: Record<string, unknown>;
} {
	return (
		typeof val === "object" &&
		val !== null &&
		(val as { _truncated?: unknown })._truncated === true &&
		typeof (val as { preview?: unknown }).preview === "string"
	);
}

/** Resolve a value to a display string (truncated → preview, obj → JSON, …). */
export function resolveDisplayText(val: unknown): string {
	if (val === null || val === undefined) return "";
	if (isTruncated(val)) return val.preview;
	if (typeof val === "string") return val;
	if (typeof val === "object" && val && typeof (val as { _text?: unknown })._text === "string") {
		return (val as { _text: string })._text;
	}
	try {
		return JSON.stringify(val, null, 2);
	} catch {
		return String(val);
	}
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First string field among `keys` (non-truncated obj), else regex-scan preview. */
export function extractField(val: unknown, ...keys: string[]): string {
	if (!val) return "";
	if (!isTruncated(val)) {
		const obj = typeof val === "object" ? (val as Record<string, unknown>) : null;
		if (!obj) return "";
		for (const k of keys) {
			if (typeof obj[k] === "string") return obj[k] as string;
		}
		return "";
	}
	const hints = val._hints;
	if (hints && typeof hints === "object") {
		for (const k of keys) {
			if (typeof (hints as Record<string, unknown>)[k] === "string") {
				return (hints as Record<string, string>)[k];
			}
		}
	}
	for (const k of keys) {
		const re = new RegExp(`"${escapeRegExp(k)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
		const m = val.preview.match(re);
		if (m) {
			try {
				return JSON.parse(`"${m[1]}"`);
			} catch {
				return m[1];
			}
		}
		const reTrunc = new RegExp(`"${escapeRegExp(k)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`);
		const mt = val.preview.match(reTrunc);
		if (mt) {
			try {
				return JSON.parse(`"${mt[1]}"`);
			} catch {
				return mt[1];
			}
		}
	}
	return "";
}

/** First numeric field among `keys` (non-truncated obj), else regex-scan preview. */
export function extractNumericField(val: unknown, ...keys: string[]): number | undefined {
	if (!val) return undefined;
	if (!isTruncated(val)) {
		const obj = typeof val === "object" ? (val as Record<string, unknown>) : null;
		if (!obj) return undefined;
		for (const k of keys) {
			if (typeof obj[k] === "number") return obj[k] as number;
		}
		return undefined;
	}
	const hints = val._hints;
	if (hints && typeof hints === "object") {
		for (const k of keys) {
			if (typeof (hints as Record<string, unknown>)[k] === "number") {
				return (hints as Record<string, number>)[k];
			}
		}
	}
	for (const k of keys) {
		const re = new RegExp(`"${escapeRegExp(k)}"\\s*:\\s*(\\d+)`);
		const m = val.preview.match(re);
		if (m) return Number(m[1]);
	}
	return undefined;
}

/** Count the visual lines in a string: "" → 0; else (newlines + 1). */
export function countLines(str: string): number {
	if (str.length === 0) return 0;
	return (str.match(/\n/g)?.length ?? 0) + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small local field-access helpers (non-truncated object reads).
// ─────────────────────────────────────────────────────────────────────────────

function asObject(val: unknown): Record<string, unknown> | null {
	return typeof val === "object" && val !== null ? (val as Record<string, unknown>) : null;
}

/** Best-effort parse of a value that may be a JSON string. */
function tryParseJson(raw: unknown): unknown {
	if (typeof raw !== "string") return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

interface SpecTaskEntry {
	text?: string;
	status?: string;
	protected?: boolean;
}

/** Extract the spec task list from metadata/input/output (mirrors extractSpecTasks). */
function extractSpecTasks(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): SpecTaskEntry[] | null {
	if (metadata && Array.isArray(metadata.tasks)) {
		return metadata.tasks as SpecTaskEntry[];
	}
	const tryTasks = (raw: unknown): SpecTaskEntry[] | null => {
		const doc = asObject(tryParseJson(raw));
		return doc && Array.isArray(doc.tasks) ? (doc.tasks as SpecTaskEntry[]) : null;
	};
	if (!isTruncated(inputJson)) {
		const input = asObject(inputJson);
		if (input) {
			const fromInput = tryTasks(input.content);
			if (fromInput) return fromInput;
			const fromEdit = tryTasks(input.new_string);
			if (fromEdit) return fromEdit;
		}
	}
	if (!isTruncated(outputJson)) {
		const out = outputJson;
		const raw = typeof out === "string" ? out : asObject(out)?.content;
		const fromOutput = tryTasks(raw);
		if (fromOutput) return fromOutput;
	}
	return null;
}

/** Line count of an array of body strings joined for wrapping estimation. */
function stringArray(val: unknown): string[] {
	return Array.isArray(val) ? val.filter((v): v is string => typeof v === "string") : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-category classifiers. Each mirrors the corresponding ToolCallCard.tsx
// DetailRenderer's dominant height-driving branch.
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassifyToolDetailInput {
	toolName: string;
	category: string;
	status?: string | null;
	inputJson?: unknown;
	outputJson?: unknown;
	/** The tool call's `_metadata` (caller resolves outputJson._metadata ?? tc._metadata). */
	metadata?: unknown;
}

/** True when the status indicates a failed tool call. */
function isFailStatus(status?: string | null): boolean {
	return status === "fail" || status === "error";
}

/** True when the status is still in-flight (running/pending/initializing). */
function isRunningStatus(status?: string | null): boolean {
	return status === "running" || status === "pending" || status === "initializing";
}

/**
 * Classify a tool call into a `ToolDetailData` (or null when there's no
 * meaningful detail body). `category` is the already-resolved ToolCategory
 * string (read|file|bash|search|webSearch|webFetch|tasks|taskOutput|agent|
 * await|send|ask|plan|pipeline|terminal|share|recall|skill|browser|knowledge|
 * generic).
 */
export function classifyToolDetail(input: ClassifyToolDetailInput): ToolDetailData | null {
	const { toolName, category, status, inputJson, outputJson } = input;
	const metadata = asObject(input.metadata);

	switch (category) {
		case "read":
			return classifyRead(outputJson, metadata);
		case "file":
			return classifyFile(toolName, inputJson);
		case "tasks":
			return classifyTasks(toolName, inputJson, outputJson, metadata);
		case "bash":
			return classifyBash(inputJson, outputJson, metadata);
		case "search":
			return classifySearch(status, inputJson, outputJson);
		case "webSearch":
			return classifyWebSearch(outputJson);
		case "webFetch":
			return classifyWebFetch(status, inputJson, outputJson, metadata);
		case "taskOutput":
			return classifyTaskOutput(outputJson);
		case "agent":
			return classifyGeneric(inputJson, outputJson);
		case "await":
			return classifyAwait(inputJson, outputJson, metadata);
		case "send":
			return classifySend(inputJson, outputJson, metadata);
		case "ask":
			return classifyAsk(status, inputJson);
		case "plan":
			return classifyPlan(inputJson);
		case "pipeline":
			return classifyPipeline(inputJson, outputJson);
		case "terminal":
			return classifyTerminal(status, inputJson, outputJson);
		case "share":
			return classifyShare(inputJson, outputJson, metadata);
		case "recall":
			return classifyRecall(inputJson, outputJson, metadata);
		case "skill":
			return classifySkill(inputJson, outputJson);
		case "browser":
			return classifyBrowser(status, inputJson, outputJson, metadata);
		case "knowledge":
			return classifyKnowledge(toolName, inputJson, outputJson, metadata);
		default:
			return classifyGeneric(inputJson, outputJson);
	}
}

function capped(
	cap: DetailCapKind,
	extras: Omit<ToolCappedDetail, "kind" | "cap"> = {},
): ToolCappedDetail {
	return { kind: "capped", cap, ...extras };
}

function classifyGeneric(inputJson: unknown, outputJson: unknown): ToolGenericDetail {
	const inputText = resolveDisplayText(inputJson);
	const outputText = outputJson != null ? resolveDisplayText(outputJson) : undefined;
	return {
		kind: "generic",
		inputLines: countLines(inputText),
		outputLines: outputText != null ? countLines(outputText) : undefined,
		inputText: inputText || undefined,
		outputText: outputText || undefined,
	};
}

function classifyRead(
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData {
	if (metadata?.isImage === true) {
		return capped("media", { contentPx: 400, hasLabel: false });
	}
	const text = resolveDisplayText(outputJson);
	return capped("code", {
		contentLines: countLines(text),
		hasLabel: false,
		text: text || undefined,
	});
}

function classifyFile(toolName: string, inputJson: unknown): ToolDetailData {
	const input = asObject(inputJson);
	const oldString = extractField(inputJson, "old_string");
	const hasOld = oldString.length > 0 || (input != null && "old_string" in input);
	if (toolName === "Edit" && hasOld) {
		const oldStr = extractField(inputJson, "old_string");
		const newStr = extractField(inputJson, "new_string");
		// A simple unified-style diff body (render-only; measure uses contentLines).
		const diffText = [
			...oldStr.split("\n").map((l) => `- ${l}`),
			...newStr.split("\n").map((l) => `+ ${l}`),
		].join("\n");
		return capped("diff", {
			contentLines: countLines(oldStr) + countLines(newStr) + 2,
			text: diffText || undefined,
		});
	}
	// Write (or Edit without an old_string): show the written content.
	const content = extractField(inputJson, "content") || resolveDisplayText(inputJson);
	return capped("code", { contentLines: countLines(content), text: content || undefined });
}

function classifyTasks(
	toolName: string,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData {
	const tasks = extractSpecTasks(inputJson, outputJson, metadata);
	if (tasks === null) {
		// Not parseable → fall back to the file diff/code branch.
		return classifyFile(toolName, inputJson);
	}
	return {
		kind: "spec-tasks",
		tasks: tasks.map((task) => task.text ?? "—"),
	};
}

function classifyBash(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const commandStr = extractField(inputJson, "command");
	const outputStr = resolveDisplayText(outputJson);
	if (!commandStr && !outputStr) return null;
	// Streaming bash uses a smaller cap while running.
	const streaming =
		metadata?._streamingOutput != null ||
		(asObject(inputJson)?._streamingChars != null && !outputStr);
	// Render body: "$ command" then the output (mirrors BashDetail's stacking).
	const text = [commandStr ? `$ ${commandStr}` : "", outputStr].filter(Boolean).join("\n");
	return capped(streaming ? "streaming-bash" : "term", {
		contentLines: countLines(commandStr) + countLines(outputStr),
		text: text || undefined,
	});
}

function classifySearch(
	status: string | null | undefined,
	inputJson: unknown,
	outputJson: unknown,
): ToolDetailData {
	const output = resolveDisplayText(outputJson);
	if (isFailStatus(status) && !output) {
		return { kind: "error", text: extractField(inputJson, "pattern", "glob") || "Search failed" };
	}
	// pattern/path header adds ~2 lines above the output.
	return capped("code", { contentLines: countLines(output) + 2, text: output || undefined });
}

function classifyWebSearch(outputJson: unknown): ToolDetailData {
	const output = resolveDisplayText(outputJson);
	if (!output) {
		return { kind: "error", text: "Web search failed" };
	}
	const parsed = asObject(tryParseJson(output));
	const results = parsed && Array.isArray(parsed.results) ? parsed.results : null;
	if (results) {
		const visible = Math.min(results.length, 10);
		// Each result: title + domain + snippet ≈ 3 lines, plus 1 query header row.
		const bodyLines: string[] = [];
		for (let i = 0; i < visible; i++) {
			const r = asObject(results[i]) ?? {};
			bodyLines.push(
				typeof r.title === "string" ? r.title : typeof r.url === "string" ? r.url : "",
			);
			bodyLines.push(typeof r.domain === "string" ? r.domain : "");
			bodyLines.push(typeof r.snippet === "string" ? r.snippet : "");
		}
		bodyLines.push("");
		return { kind: "structured", badgeRows: 0, bodyLines };
	}
	return capped("code", { contentLines: countLines(output) });
}

function classifyWebFetch(
	status: string | null | undefined,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData {
	const mode = extractField(inputJson, "mode");
	const output = resolveDisplayText(outputJson);
	if (mode === "screenshot" && typeof metadata?.previewUrl === "string") {
		return capped("media", { contentPx: 400 });
	}
	if (isFailStatus(status) && !output) {
		return { kind: "error", text: "Fetch failed" };
	}
	// url + mode badge + selector header ≈ 3 lines above the output.
	return capped("code", { contentLines: countLines(output) + 3, text: output || undefined });
}

function classifyTaskOutput(outputJson: unknown): ToolDetailData {
	const output = resolveDisplayText(outputJson);
	return capped("code", { contentLines: countLines(output) + 1, text: output || undefined });
}

function classifyAwait(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData {
	const output = resolveDisplayText(outputJson);
	const awaitType = extractField(inputJson, "type") || (metadata?.awaitType as string) || "task";
	return capped(awaitType === "bash" ? "term" : "code", {
		contentLines: countLines(output),
		text: output || undefined,
	});
}

function classifySend(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData {
	const input = asObject(inputJson);
	const message = isTruncated(inputJson)
		? inputJson.preview
		: typeof input?.message === "string"
			? input.message
			: "";
	const output = resolveDisplayText(outputJson);
	const targets = Array.isArray(metadata?.targets) ? (metadata.targets as unknown[]) : [];
	const targetLines = targets
		.map((t) => {
			const to = asObject(t) ?? {};
			const label =
				typeof to.title === "string" ? to.title : typeof to.id === "string" ? to.id : "target";
			const st = typeof to.status === "string" ? to.status : "sent";
			return `${st} · ${label}`;
		})
		.filter(Boolean);
	const bodyLines = [
		...(message ? message.split("\n") : []),
		...targetLines,
		...(output ? output.split("\n") : []),
	];
	return { kind: "structured", badgeRows: 1, bodyLines, mono: false };
}

interface AskQuestion {
	header?: string;
	options?: unknown[];
}

function classifyAsk(status: string | null | undefined, inputJson: unknown): ToolDetailData | null {
	// While pending/running, the interactive banner handles the display.
	if (isRunningStatus(status)) return null;
	const input = asObject(inputJson);
	const questions = Array.isArray(input?.questions) ? (input.questions as AskQuestion[]) : [];
	if (questions.length === 0) return null;
	const bodyLines: string[] = [];
	for (const q of questions) {
		bodyLines.push(typeof q.header === "string" ? q.header : "Question");
		const optionCount = Array.isArray(q.options) ? q.options.length : 0;
		for (let i = 0; i < optionCount; i++) bodyLines.push("");
	}
	return { kind: "structured", badgeRows: 0, bodyLines };
}

function classifyPlan(inputJson: unknown): ToolDetailData | null {
	const planText = extractField(inputJson, "plan") || String(asObject(inputJson)?.plan ?? "");
	if (!planText) return null;
	return capped("plan", { contentLines: countLines(planText), text: planText });
}

function classifyPipeline(inputJson: unknown, outputJson: unknown): ToolStructuredDetail {
	const rule = extractField(inputJson, "rule");
	const aliases = stringArray(asObject(inputJson)?.aliases);
	const output = resolveDisplayText(outputJson);
	const bodyLines: string[] = [];
	if (rule) bodyLines.push(rule);
	for (const alias of aliases) bodyLines.push(alias);
	if (output) bodyLines.push(...output.split("\n"));
	return { kind: "structured", badgeRows: 1, bodyLines, mono: true };
}

function classifyTerminal(
	status: string | null | undefined,
	inputJson: unknown,
	outputJson: unknown,
): ToolDetailData {
	const action = extractField(inputJson, "action");
	if (action === "write") {
		const inp = extractField(inputJson, "input");
		if (isFailStatus(status) && !inp) return { kind: "error", text: "Terminal write failed" };
		return capped("bash-cmd", { contentLines: countLines(inp), text: inp || undefined });
	}
	// read / list
	const output = resolveDisplayText(outputJson);
	if (isFailStatus(status) && !output) return { kind: "error", text: "Terminal read failed" };
	return capped("term", { contentLines: countLines(output), text: output || undefined });
}

function classifyShare(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData {
	if (!metadata || typeof metadata.downloadUrl !== "string") {
		// No structured metadata → generic input/output view.
		return classifyGeneric(inputJson, outputJson);
	}
	if (metadata.preview === true && typeof metadata.previewUrl === "string") {
		return capped("media", { contentPx: 400 });
	}
	const filename = typeof metadata.filename === "string" ? metadata.filename : "file";
	return { kind: "structured", badgeRows: 1, bodyLines: [filename] };
}

function classifyRecall(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData {
	const action = metadata?.action as string | undefined;
	if (!metadata || (action !== "search" && action !== "read_conversation")) {
		return classifyGeneric(inputJson, outputJson);
	}
	if (action === "search") {
		const results = Array.isArray(metadata.results) ? (metadata.results as unknown[]) : [];
		if (results.length === 0) {
			return { kind: "structured", badgeRows: 0, bodyLines: ["No results"] };
		}
		const visible = Math.min(results.length, 10);
		// ~4 lines per result (role/title/snippet(2)/id).
		const bodyLines = new Array(visible * 4).fill("");
		return { kind: "structured", badgeRows: 1, bodyLines };
	}
	// read_conversation
	const messages = Array.isArray(metadata.messages) ? (metadata.messages as unknown[]) : [];
	if (messages.length === 0) {
		return { kind: "structured", badgeRows: 0, bodyLines: ["No results"] };
	}
	const visible = Math.min(messages.length, 10);
	// ~5 lines per message.
	const bodyLines = new Array(visible * 5).fill("");
	return { kind: "structured", badgeRows: 1, bodyLines };
}

function classifySkill(inputJson: unknown, outputJson: unknown): ToolDetailData {
	const output = resolveDisplayText(outputJson);
	const match = output.match(/<skill_content\s+name="([^"]+)">/);
	if (match) {
		// Extract the content body between the header and the base-directory marker.
		let content = "";
		const skillTagIdx = output.indexOf("<skill_content");
		if (skillTagIdx !== -1) {
			const contentStart = output.indexOf("\n\n", skillTagIdx);
			const contentEnd = output.indexOf("\nBase directory for this skill:");
			if (contentStart !== -1 && contentEnd !== -1 && contentEnd > contentStart) {
				content = output.slice(contentStart + 2, contentEnd).trim();
			}
		}
		return capped("skill", { contentLines: countLines(content) + 2, text: content || undefined });
	}
	return classifyGeneric(inputJson, outputJson);
}

function classifyBrowser(
	status: string | null | undefined,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData {
	const action = extractField(inputJson, "action");
	if (action === "screenshot" && typeof metadata?.previewUrl === "string") {
		return capped("media", { contentPx: 400 });
	}
	const output = resolveDisplayText(outputJson);
	if (isFailStatus(status) && !output) return { kind: "error", text: "Browser action failed" };
	// action badge + url header ≈ 2 lines above the output.
	return capped("code", { contentLines: countLines(output) + 2, text: output || undefined });
}

function classifyKnowledge(
	toolName: string,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData {
	if (toolName === "KnowledgeSearch" && metadata && Array.isArray(metadata.results)) {
		const results = metadata.results as unknown[];
		const visible = Math.min(results.length, 10);
		// ~3 lines per result.
		const bodyLines = new Array(visible * 3).fill("");
		return { kind: "structured", badgeRows: 1, bodyLines };
	}
	if (toolName === "KnowledgeRead") {
		const body = resolveDisplayText(outputJson);
		return capped("knowledge", {
			contentLines: countLines(body) + 2,
			text: body || undefined,
		});
	}
	// Create/Edit/Review/Admin: prefer the output body as structured lines.
	const output = resolveDisplayText(outputJson);
	if (output) {
		return { kind: "structured", badgeRows: 1, bodyLines: output.split("\n") };
	}
	return classifyGeneric(inputJson, outputJson);
}
