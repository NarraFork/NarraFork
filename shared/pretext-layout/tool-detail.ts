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

import {
	computeDiffCached,
	diffLineNoWidth as computeDiffLineNoWidth,
	type DiffLine,
} from "./diff-core";

import { hasTruncatedLeaf, readLeafText, stringifyForDisplay } from "./tool-io-projection";

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

/**
 * Reserved pixel height for an inline media image (`media` cap `contentPx`).
 *
 * Deliberately the SAME fixed 200px a user message's image block occupies
 * (frontend measure-media's `IMAGE_FIXED_HEIGHT`), so a screenshot in a tool card
 * and an image in a chat bubble reserve identical space. The previous 400 was a
 * standalone estimate: a 1280×900 screenshot squeezed to the card width is ~85px
 * shorter than that, so every screenshot row carried a tall empty band and the
 * reserved box dwarfed the picture inside it.
 *
 * Keep in sync with measure-media.ts's IMAGE_FIXED_HEIGHT (a shared → frontend
 * import would break this file's purity guard).
 */
export const MEDIA_IMAGE_CONTENT_PX = 200;

/**
 * RENDER-ONLY image descriptor for a `media` cap. Carries just enough for the
 * render layer to resolve an <img> src the same way the classic card does
 * (direct previewUrl → /api/fs/preview by path → /api/uploads blob by id). It
 * NEVER affects the measured height (media caps use contentPx). Keep the fields
 * optional; the render layer falls back gracefully when none resolve.
 */
export interface ToolMediaRef {
	/** A ready-to-use image URL (blob:/http[s]/data:) — the fast path. */
	previewUrl?: string;
	/** A server file path → fetched via /api/fs/preview. */
	filePath?: string;
	/** An uploaded image id → fetched via /api/uploads/:narratorId/:imageId. */
	imageId?: string;
	/** Filename (alt text / image viewer title). */
	filename?: string;
	/** Optional size (KB) + format label shown above an image read. */
	sizeKB?: number;
	imageFormat?: string;
}

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
	 * The real body text (code / command / diff / output), painted inside the
	 * maxHeight-capped scroll box.
	 *
	 * MEASURED, not render-only: the measure layer derives the body height from
	 * how this text wraps at the available width, because `contentLines` counts
	 * hard newlines only and therefore under-reports every soft-wrapped line (a
	 * long single-line body used to collapse into one 15px row and get clipped).
	 * The measurement is bounded and the cap still clamps the result, so carrying
	 * a large string here stays cheap. Absent for media/image caps (contentPx-
	 * only) where there is no text.
	 */
	text?: string;
	/**
	 * RENDER-ONLY image descriptor for `media` caps. When present the render
	 * layer paints an actual image inside the reserved contentPx box instead of
	 * an empty placeholder. Height-neutral.
	 */
	media?: ToolMediaRef;
	/**
	 * Render `text` as MARKDOWN instead of plain monospace (ExitPlanMode plans,
	 * matching the chunked card's `ContentViewer markdown`). The measure layer
	 * parses/measures the body as markdown; the render layer paints it with
	 * RenderMarkdown inside the same maxHeight-capped scroll box.
	 */
	markdown?: boolean;
	/**
	 * True when `text` is only a PREFIX of the real body (a truncated leaf).
	 *
	 * MEASURED: the measure layer reserves the full cap for such a body instead of
	 * sizing the box to the prefix it happens to hold. Without this the height
	 * depends on how much text the server's budget happened to include — a wider
	 * layout wraps the prefix into fewer lines, the box shrinks, and the remaining
	 * (scrollable) content has nowhere to go. Reserving the cap can leave a few
	 * lines of slack on very wide layouts, but it can never CLIP: the box scrolls,
	 * and the user shrinks it back to exact by loading the full payload.
	 */
	textTruncated?: boolean;
	/**
	 * Provenance path for a file-based body (ExitPlanMode's `_planFile`), shown as
	 * a leading dimmed line.
	 *
	 * This is the RAW path only — never a localized string. `shared/pretext-layout`
	 * is a purity-guarded layer with no i18n access, so the render layer owns the
	 * `t("planSourceFile", { file })` formatting (its localized text enters the
	 * measure cache key via the shell's labelsRevision).
	 */
	sourcePath?: string;
	/**
	 * RENDER-ONLY explicit syntax-highlighting language id (e.g. `"json"`,
	 * `"bash"`, `"diff"`) for bodies whose language is known without a file path.
	 * Height-neutral: highlighting only colours characters.
	 */
	codeLang?: string;
	/**
	 * RENDER-ONLY raw file path whose extension implies the highlighting language.
	 *
	 * Only the PATH travels here, never a resolved language id: the resolver
	 * (`getShikiLang`) lives in `frontend/lib`, and this purity-guarded layer must
	 * not import frontend modules — the same split `sourcePath` uses for i18n.
	 * Height-neutral.
	 */
	codeLangPath?: string;
	/**
	 * The structured diff model for a `diff` cap: real context / removed / added
	 * rows with their old and new line numbers and word-level changes.
	 *
	 * MEASURED, not render-only. `text` remains the plain fallback (and the copy
	 * source), but when this is present the height comes from these rows wrapped
	 * at the available width MINUS the fixed gutter, because the gutter narrows
	 * every code line. The render layer draws the two-column line-number gutter,
	 * the per-line +/- background and the word-level tints from it.
	 */
	diffLines?: DiffLine[];
	/**
	 * Character width of ONE line-number column in the diff gutter, so both
	 * columns align. Absent when the diff has no known start line (no gutter).
	 * MEASURED: it determines how much horizontal room the code column loses.
	 */
	diffLineNoWidth?: number;
	/**
	 * Placeholder prefix for provisional line numbers (streaming Edit before the
	 * match location is known) — the chunked card's `lineNumberPrefix`.
	 */
	diffLineNumberPrefix?: string;
}

/** 🟡 Generic detail: an input section + an optional output section (cap 200 each). */
export interface ToolGenericDetail {
	kind: "generic";
	inputLines: number;
	outputLines?: number;
	/**
	 * Real input/output body text painted in the capped box. MEASURED when
	 * present (wrapped at the available width, bounded); `inputLines`/
	 * `outputLines` are the fallback when no text is carried.
	 */
	inputText?: string;
	outputText?: string;
	/** `inputText` is only a prefix → reserve the full cap (see textTruncated). */
	inputTruncated?: boolean;
	/** `outputText` is only a prefix → reserve the full cap. */
	outputTruncated?: boolean;
}

/** One SpecTasks row: text drives wrapping; status/protected drive the glyph. */
export interface SpecTaskLine {
	text: string;
	/** todo | doing | done | blocked (drives the leading status icon). */
	status?: string;
	/** Protected commitment → a small lock glyph before the text. */
	protected?: boolean;
}

/** 🔴 SpecTasks list: one wrapped row per task (task text drives wrapping). */
export interface ToolSpecTasksDetail {
	kind: "spec-tasks";
	tasks: SpecTaskLine[];
}

/** A structured badge chip (render-only label + colour). Height-neutral. */
export interface ToolStructuredBadge {
	label: string;
	/** Mantine colour name (defaults to a neutral tint in the render layer). */
	color?: string;
}

/**
 * Defensive ceilings on a read-only AskUserQuestion replay. The tool schema
 * already bounds these (1-4 questions, 2-4 options), but a malformed provider
 * payload must never turn into unbounded measurement work — same rationale as
 * ENTRY_MAX / META_ROWS_MAX.
 */
export const ASK_QUESTIONS_MAX = 8;
export const ASK_OPTIONS_MAX = 8;

/** One option of a read-only AskUserQuestion replay. */
export interface ToolAskOption {
	/** Option label (wraps). */
	label: string;
	/** Option description under the label (wraps). */
	description?: string;
	/** Whether the submitted answer selected this option (multi-select aware). */
	selected?: boolean;
}

/** One question of a read-only AskUserQuestion replay. */
export interface ToolAskQuestion {
	/** Question header (wraps). */
	header: string;
	/**
	 * True when the card's own header summary already shows this exact text (the
	 * single-question case), so the detail region must not repeat it.
	 */
	omitHeader?: boolean;
	/** multiSelect → checkbox glyphs; otherwise → radio glyphs. */
	multiSelect?: boolean;
	options: ToolAskOption[];
	/**
	 * The submitted answer, already prefixed with the localized "Answer:" label so
	 * the string that gets MEASURED is the string that gets painted.
	 */
	answer?: string;
	/**
	 * A free-text answer matching no option, already prefixed with the localized
	 * "Custom answer:" label. Mutually exclusive with `answer`.
	 */
	customAnswer?: string;
}

/**
 * 🔴 Read-only AskUserQuestion replay: the completed question banner the classic
 * card renders via `AskUserQuestionBanner readOnly` (ToolCallCard AskDetail).
 *
 * Previously this was flattened into `structured` entries shared with recall /
 * web-search results, which lost the radio/checkbox semantics, showed untranslated
 * uppercase ANSWERED / CHOSEN chips and left the answer as an unlabelled mono line.
 */
export interface ToolAskDetail {
	kind: "ask";
	questions: ToolAskQuestion[];
}

/**
 * 🔴 One structured RESULT entry (a recall hit, a knowledge entry, a web-search
 * result, a send delivery row): several fields that belong on the SAME visual
 * row/card instead of being flattened into unrelated body lines.
 *
 * The classic cards render each result as its own little block (role badge +
 * title + timestamp + snippet), so a flat `bodyLines` list loses the entire
 * structure. Height is still pure arithmetic: title row + optional meta row +
 * clamped snippet + optional badge row.
 */
export interface ToolStructuredEntry {
	/** Primary title line (wraps; clickable when `href` is set). */
	title: string;
	/** External link for the title (render layer draws an <a>). Height-neutral. */
	href?: string;
	/** Secondary info shown after/below the title (domain / time / seq). */
	meta?: string;
	/** Body excerpt (wraps, clamped to a fixed number of lines). */
	snippet?: string;
	/** Badge chips for this entry (role, status, tags). */
	badges?: ToolStructuredBadge[];
	/** Mantine colour hint for the entry tone (user vs assistant). Height-neutral. */
	tone?: string;
}

/** 🔴 Structured segment (recall/send/pipeline/web-search): badges + body lines. */
export interface ToolStructuredDetail {
	kind: "structured";
	/** Number of badge header rows (0 = none). Drives the reserved header height. */
	badgeRows?: number;
	/**
	 * RENDER-ONLY badge chips painted in the reserved badge header row(s). When
	 * absent the header row stays blank (legacy behaviour). Height-neutral: the
	 * measured header height is driven by `badgeRows`, not this array.
	 */
	badges?: ToolStructuredBadge[];
	/** Body text lines (each wraps; monospace when `mono`). */
	bodyLines: string[];
	/** Render the body lines in monospace (recall paths, pipeline ids). */
	mono?: boolean;
	/**
	 * Structured result entries. When present these REPLACE `bodyLines` as the
	 * body (keep `bodyLines` empty), so each result keeps its own title / meta /
	 * snippet / badges instead of being flattened.
	 */
	entries?: ToolStructuredEntry[];
}

/** 🔴 Error detail: a leading icon + wrapped error text. */
export interface ToolErrorDetail {
	kind: "error";
	text: string;
}

/** An action control drawn on a meta row (share download / copy link). */
export interface ToolRowAction {
	kind: "download" | "copy";
	/** Target URL: an <a href> for `download`, clipboard text for `copy`. */
	value: string;
}

/**
 * 🔴 One meta row: the header information the classic cards show ABOVE the body
 * — a file path, a fetched URL, a terminal id, mode/action badges, and the
 * share card's download / copy-link buttons.
 */
export interface ToolMetaRow {
	/** Row text (wraps). May be empty when the row only carries badges/actions. */
	text: string;
	/** Monospace text (paths, ids, URLs). */
	mono?: boolean;
	/** Turns the text into an external link. Height-neutral. */
	href?: string;
	/** Badge chips on this row (mode, action, size, expiry). */
	badges?: ToolStructuredBadge[];
	/** Interactive controls on this row (download / copy link). */
	actions?: ToolRowAction[];
	/** Dimmed secondary styling (the default for paths/provenance). */
	dimmed?: boolean;
}

/**
 * 🔴 Meta rows region: the leading information block of a detail (paths, URLs,
 * ids, badge rows, action buttons). Previously unrepresentable — which is why
 * every one of those rows was missing from the vlist cards.
 */
export interface ToolMetaRowsDetail {
	kind: "meta-rows";
	rows: ToolMetaRow[];
}

/**
 * Semantic id of a section label. A CLOSED union (never a free string) so the
 * render layer's lookup table is exhaustive and a missing translation is a
 * compile error rather than a silently untranslated card.
 */
export type ToolSectionLabel =
	| "input"
	| "output"
	| "command"
	| "message"
	| "delivery"
	| "reply"
	| "result"
	| "rule"
	| "captured"
	| "files"
	| "plan"
	| "error";

/** A body a section can host: every leaf kind EXCEPT `sections` (no nesting). */
export type ToolSectionBody =
	| ToolCappedDetail
	| ToolStructuredDetail
	| ToolErrorDetail
	| ToolSpecTasksDetail
	| ToolMetaRowsDetail
	| ToolAskDetail;

/** One labelled section inside a multi-part detail. */
export interface ToolDetailSection {
	/** Localized by the render layer via its label table; omitted = no label row. */
	label?: ToolSectionLabel;
	body: ToolSectionBody;
}

/**
 * 🔴 A multi-part detail: an ordered list of labelled sections.
 *
 * This is the kind that fixes the "whole block missing" reports: the classic
 * cards are "meta header + one or more labelled body sections", a shape the
 * previous single-block union simply could not express, so everything except the
 * dominant body silently disappeared.
 */
export interface ToolSectionsDetail {
	kind: "sections";
	sections: ToolDetailSection[];
}

export type ToolDetailData =
	| ToolCappedDetail
	| ToolGenericDetail
	| ToolSpecTasksDetail
	| ToolStructuredDetail
	| ToolErrorDetail
	| ToolMetaRowsDetail
	| ToolAskDetail
	| ToolSectionsDetail;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (mirrored in frontend/components/narrator/tool-display.ts — keep
// the two copies in sync). Truncation is FIELD-LEVEL: the wrapper shape is
// unchanged but it now sits on the oversized string LEAF, so these readers work
// on ordinary fields instead of scraping a preview blob.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type guard for a truncated LEAF `{ _truncated:true; preview:string; … }`.
 *
 * Still exported and still the same shape, but note where it applies: after
 * field-level projection an OBJECT payload's root is a plain object, so probing
 * the root reports "not truncated". Use `hasTruncatedLeaf` to ask whether a
 * payload contains truncated data anywhere.
 */
export function isTruncated(val: unknown): val is {
	_truncated: true;
	preview: string;
	fullLength: number;
} {
	return (
		typeof val === "object" &&
		val !== null &&
		(val as { _truncated?: unknown })._truncated === true &&
		typeof (val as { preview?: unknown }).preview === "string"
	);
}

/**
 * Resolve a value to a display string.
 *
 * `_text` is unwrapped BEFORE the truncated-leaf check on purpose: tool output is
 * persisted as `{_text, _metadata}`, and testing the wrapper first meant a
 * projected output rendered as the literal `{"_text":"line1\nline2…` — quotes,
 * escapes and all. The `_text` value may itself be a truncated leaf, so it goes
 * through `readLeafText`.
 *
 * The object fallback uses `stringifyForDisplay`, which renders any nested
 * truncated leaf as its preview text rather than dumping the wrapper's own JSON
 * structure into the user's view.
 */
export function resolveDisplayText(val: unknown): string {
	if (val === null || val === undefined) return "";
	if (typeof val === "string") return val;
	if (typeof val === "object" && val && "_text" in val) {
		const text = readLeafText((val as { _text: unknown })._text);
		if (text !== undefined) return text;
	}
	const leaf = readLeafText(val);
	if (leaf !== undefined) return leaf;
	return stringifyForDisplay(val);
}

/**
 * Resolve a display string together with whether it was truncated.
 *
 * The `truncated` flag travels into `ToolCappedDetail.textTruncated`, which makes
 * the measure layer reserve the full cap: a body that is only a PREFIX must never
 * be measured as if it were complete, or the box is sized to the prefix and the
 * remaining (scrollable) content has nowhere to go.
 */
export function resolveDisplayBody(val: unknown): { text: string; truncated: boolean } {
	return { text: resolveDisplayText(val), truncated: hasTruncatedLeaf(val) };
}

/**
 * First string field among `keys`.
 *
 * Field-level projection keeps every key in place, so this is a plain field read —
 * no `_hints` whitelist, no regex scraping of a preview blob. A field whose own
 * value was truncated resolves to its preview via `readLeafText`.
 */
export function extractField(val: unknown, ...keys: string[]): string {
	if (!val || typeof val !== "object") return "";
	const obj = val as Record<string, unknown>;
	for (const k of keys) {
		const text = readLeafText(obj[k]);
		if (text !== undefined) return text;
	}
	return "";
}

/** First numeric field among `keys`. Numbers are never truncated. */
export function extractNumericField(val: unknown, ...keys: string[]): number | undefined {
	if (!val || typeof val !== "object") return undefined;
	const obj = val as Record<string, unknown>;
	for (const k of keys) {
		if (typeof obj[k] === "number") return obj[k] as number;
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
	if (!Array.isArray(val)) return [];
	// A `typeof v === "string"` filter would silently DROP any element the
	// projection wrapped, so tags/keywords would vanish from the card entirely.
	const out: string[] = [];
	for (const item of val) {
		const text = readLeafText(item);
		if (text !== undefined) out.push(text);
	}
	return out;
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
	/**
	 * True while the tool INPUT is still streaming. Routes to the streaming-input
	 * classifier, which mirrors the chunked `StreamingInputDetail` (live Edit diff /
	 * written code / shell command / streamed markdown). Without this the whole
	 * streaming preview was missing from the vlist.
	 */
	isStreaming?: boolean;
	/** Tool error text; appended as a trailing error section when nothing else shows it. */
	errorMessage?: string | null;
	/**
	 * True when a live permission form is mounted for this call. Ask cards suppress
	 * their read-only question summary in that case (the interactive banner owns
	 * the display), which is the ONLY reason `ask` should render nothing.
	 */
	hasPendingPermission?: boolean;
	/**
	 * Injected chrome labels (the adapter forwards `ctx.labels`). Only the strings
	 * that participate in MEASUREMENT belong here — currently the ask replay's
	 * "Answer:" / "Custom answer:" prefixes, which wrap with their answer text and
	 * therefore cannot be substituted by the render layer.
	 */
	labels?: Record<string, string>;
}

/** True when the status indicates a failed tool call. */
function isFailStatus(status?: string | null): boolean {
	return status === "fail" || status === "error";
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

	// Streaming input owns the whole detail region while it lasts, and it owns it
	// EXCLUSIVELY: the chunked card swaps DetailRenderer for StreamingInputDetail
	// (ToolCallCard.tsx:5740) and renders nothing when there is no preview yet.
	//
	// Falling through to the category classifiers here leaked NarraFork's internal
	// stream markers into the UI. A Write whose `content` arrives before its
	// `file_path` has no real `content` field yet (the text lives only in
	// `_streamingFieldValue`), so `classifyFile` hit its `resolveDisplayText`
	// fallback and dumped `{_streamingChars, _streamingFieldName, ...}` into the
	// card as JSON, labelled "Input".
	if (input.isStreaming) {
		return classifyStreamingInput(toolName, category, inputJson, metadata);
	}

	const base = classifyByCategory(
		toolName,
		category,
		status,
		inputJson,
		outputJson,
		metadata,
		input,
	);
	return withErrorSection(base, input.errorMessage, outputJson);
}

function classifyByCategory(
	toolName: string,
	category: string,
	status: string | null | undefined,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
	input: ClassifyToolDetailInput,
): ToolDetailData | null {
	switch (category) {
		case "read":
			return classifyRead(inputJson, outputJson, metadata);
		case "file":
			return classifyFile(toolName, inputJson, metadata);
		case "tasks":
			return classifyTasks(toolName, inputJson, outputJson, metadata);
		case "bash":
			return classifyBash(inputJson, outputJson, metadata);
		case "search":
			return classifySearch(status, inputJson, outputJson);
		case "webSearch":
			return classifyWebSearch(inputJson, outputJson);
		case "webFetch":
			return classifyWebFetch(status, inputJson, outputJson, metadata);
		case "taskOutput":
			return classifyTaskOutput(inputJson, outputJson);
		case "agent":
			return classifyGeneric(inputJson, outputJson);
		case "await":
			return classifyAwait(inputJson, outputJson, metadata);
		case "send":
			return classifySend(inputJson, outputJson, metadata);
		case "ask":
			return classifyAsk(inputJson, input.hasPendingPermission === true, input.labels);
		case "plan":
			return classifyPlan(inputJson, metadata);
		case "pipeline":
			return classifyPipeline(toolName, inputJson, outputJson, metadata);
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

// ─────────────────────────────────────────────────────────────────────────────
// Section / meta-row builders.
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap an ordered section list, collapsing the single-section case to its body. */
function sections(list: Array<ToolDetailSection | null>): ToolDetailData | null {
	const kept = list.filter((s): s is ToolDetailSection => s !== null);
	if (kept.length === 0) return null;
	// One unlabelled section is just that body — keeps the simple cards (and all
	// their existing height tests) on the original single-block path.
	const only = kept[0];
	if (kept.length === 1 && only && only.label === undefined) return only.body;
	return { kind: "sections", sections: kept };
}

/** A section, or null when its body is absent. */
function section(
	label: ToolSectionLabel | undefined,
	body: ToolSectionBody | null,
): ToolDetailSection | null {
	if (body === null) return null;
	return label === undefined ? { body } : { label, body };
}

/** A meta-rows body from the non-empty rows, or null when nothing remains. */
function metaRows(rows: Array<ToolMetaRow | null>): ToolMetaRowsDetail | null {
	const kept = rows.filter(
		(r): r is ToolMetaRow =>
			r !== null &&
			(r.text.length > 0 || (r.badges?.length ?? 0) > 0 || (r.actions?.length ?? 0) > 0),
	);
	return kept.length > 0 ? { kind: "meta-rows", rows: kept } : null;
}

/** A dimmed monospace meta row (paths, ids, URLs), or null when text is empty. */
function pathRow(text: string, extra: Partial<ToolMetaRow> = {}): ToolMetaRow | null {
	if (!text) return null;
	return { text, mono: true, dimmed: true, ...extra };
}

/** A badge-only meta row, or null when there are no chips. */
function badgeRow(badges: ToolStructuredBadge[], text = ""): ToolMetaRow | null {
	if (badges.length === 0) return null;
	return { text, badges, dimmed: true };
}

/** A badge chip, or null when the label is empty. */
function chip(label: string | undefined, color: string): ToolStructuredBadge | null {
	return label ? { label, color } : null;
}

/** Drop the nulls from a chip list. */
function chips(list: Array<ToolStructuredBadge | null>): ToolStructuredBadge[] {
	return list.filter((b): b is ToolStructuredBadge => b !== null);
}

/**
 * Append a trailing error section when the tool failed and no body already shows
 * the message. The chunked cards all render this red line; the vlist dropped it
 * for every category whose classifier only looked at the output.
 */
function withErrorSection(
	base: ToolDetailData | null,
	errorMessage: string | null | undefined,
	outputJson: unknown,
): ToolDetailData | null {
	const text = typeof errorMessage === "string" ? errorMessage.trim() : "";
	if (!text) return base;
	// An error-only detail already IS the message.
	if (base?.kind === "error") return base;
	// The chunked cards hide the error line once a real output body exists.
	if (outputJson != null && base !== null) return base;
	const errorSection: ToolDetailSection = { label: "error", body: { kind: "error", text } };
	if (base === null) return { kind: "sections", sections: [errorSection] };
	if (base.kind === "sections") {
		return { kind: "sections", sections: [...base.sections, errorSection] };
	}
	if (base.kind === "generic") {
		// Generic keeps its own two-section shape; wrap it as one section.
		return { kind: "sections", sections: [{ body: toCappedInput(base) }, errorSection] };
	}
	return { kind: "sections", sections: [{ body: base }, errorSection] };
}

/** Represent a generic detail's input half as a capped body (section wrapping). */
function toCappedInput(detail: ToolGenericDetail): ToolCappedDetail {
	return capped("code", {
		contentLines: detail.inputLines,
		hasLabel: false,
		...(detail.inputText ? { text: detail.inputText } : {}),
	});
}

function capped(
	cap: DetailCapKind,
	extras: Omit<ToolCappedDetail, "kind" | "cap"> = {},
): ToolCappedDetail {
	return { kind: "capped", cap, ...extras };
}

/**
 * `{ textTruncated: true }` when the payload a body was derived from carries a
 * truncated leaf; otherwise `{}` (so the field stays absent).
 *
 * Spread into the `capped(...)` that renders that body. Each box gets the flag for
 * ITS OWN source — a bash card whose command fits but whose output was cut must
 * reserve the cap for the output box only.
 */
function truncatedFlag(source: unknown): { textTruncated?: true } {
	return hasTruncatedLeaf(source) ? { textTruncated: true } : {};
}

/**
 * Build a `diff` capped body from the two sides of an edit.
 *
 * The real line diff is computed here (not a naive "all old lines removed, all
 * new lines added" concatenation) so both render paths show the same thing: the
 * unchanged context, per-row old/new line numbers, and the word-level changes
 * inside a modified pair.
 *
 * `text` stays as the plain fallback and the copy/selection source, formatted the
 * way a unified diff reads. `diffLines` is what the renderer actually draws when
 * present, and what the measure layer measures.
 *
 * The gutter only exists when the edit's real position is known (`startLine`) or
 * a placeholder prefix is supplied — matching the chunked DiffView, which shows a
 * bare marker column otherwise.
 */
function diffBody(
	oldStr: string,
	newStr: string,
	startLine: number | undefined,
	extras: Omit<ToolCappedDetail, "kind" | "cap"> = {},
	lineNumberPrefix?: string,
): ToolCappedDetail {
	// Memoized: this runs on the synchronous layout path for every Edit card on
	// every rebuild, while the payload it diffs never changes. The rows are shared
	// with previous callers and are read-only from here on.
	const lines = computeDiffCached(oldStr, newStr, startLine ?? 1);
	// Plain-text fallback / copy source: a readable unified-style body.
	const text = lines
		.map(
			(line) =>
				`${line.type === "removed" ? "-" : line.type === "added" ? "+" : " "}${line.content}`,
		)
		.join("\n");
	const showGutter = startLine != null || lineNumberPrefix != null;
	return capped("diff", {
		contentLines: lines.length,
		...(text ? { text } : {}),
		diffLines: lines,
		...(showGutter ? { diffLineNoWidth: computeDiffLineNoWidth(lines, lineNumberPrefix) } : {}),
		...(lineNumberPrefix ? { diffLineNumberPrefix: lineNumberPrefix } : {}),
		...extras,
	});
}

function classifyGeneric(inputJson: unknown, outputJson: unknown): ToolGenericDetail {
	const input = resolveDisplayBody(inputJson);
	const output = outputJson != null ? resolveDisplayBody(outputJson) : undefined;
	return {
		kind: "generic",
		inputLines: countLines(input.text),
		outputLines: output != null ? countLines(output.text) : undefined,
		inputText: input.text || undefined,
		outputText: output?.text || undefined,
		...(input.truncated ? { inputTruncated: true } : {}),
		...(output?.truncated ? { outputTruncated: true } : {}),
	};
}

/** The read/write file path (mirrors the chunked `getFilePath`). */
function filePathOf(inputJson: unknown): string {
	return extractField(inputJson, "file_path", "path", "filePath");
}

function classifyRead(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const fp = filePathOf(inputJson);
	if (metadata?.isImage === true) {
		const filePath =
			readLeafText(metadata.filePath) ?? readLeafText(metadata.fp) ?? (fp || undefined);
		const sizeKB = typeof metadata.sizeKB === "number" ? metadata.sizeKB : undefined;
		const imageFormat = readLeafText(metadata.imageFormat);
		// The chunked card shows "path (12 KB, png)" above the image.
		const suffix = sizeKB != null && imageFormat ? ` (${sizeKB} KB, ${imageFormat})` : "";
		return sections([
			section(undefined, metaRows([pathRow(filePath ? `${filePath}${suffix}` : "")])),
			section(
				undefined,
				capped("media", {
					contentPx: MEDIA_IMAGE_CONTENT_PX,
					hasLabel: false,
					media: {
						filePath,
						filename: filePath ? filePath.split(/[\\/]/).pop() : undefined,
						sizeKB,
						imageFormat,
					},
				}),
			),
		]);
	}
	const text = resolveDisplayText(outputJson);
	const body =
		outputJson != null
			? capped("code", {
					contentLines: countLines(text),
					hasLabel: false,
					text: text || undefined,
					...truncatedFlag(outputJson),
					// Parity with the chunked ReadDetail: `language={getShikiLang(fp)}`.
					...(fp ? { codeLangPath: fp } : {}),
				})
			: null;
	return sections([section(undefined, metaRows([pathRow(fp)])), section(undefined, body)]);
}

function classifyFile(
	toolName: string,
	inputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const input = asObject(inputJson);
	const oldString = extractField(inputJson, "old_string");
	const hasOld = oldString.length > 0 || (input != null && "old_string" in input);
	const fp = filePathOf(inputJson);
	if (toolName === "Edit" && hasOld) {
		const oldStr = extractField(inputJson, "old_string");
		const newStr = extractField(inputJson, "new_string");
		// The chunked EditDiffBlock labels the diff with the path + original line.
		const startLine = readStartLine(inputJson, metadata);
		const header = fp ? (startLine != null ? `${fp}:${startLine}` : fp) : "";
		return sections([
			section(undefined, metaRows([pathRow(header)])),
			section(
				undefined,
				// Parity with the chunked EditDiffBlock: the edited file's own language
				// colours the diff body (the +/- tint is layered on top).
				diffBody(oldStr, newStr, startLine, fp ? { codeLangPath: fp } : {}),
			),
		]);
	}
	// Write (or Edit without an old_string): show the written content.
	const writtenContent = extractField(inputJson, "content");
	const content = writtenContent || resolveDisplayText(inputJson);
	return sections([
		section(undefined, metaRows([pathRow(fp)])),
		section(
			undefined,
			capped("code", {
				contentLines: countLines(content),
				text: content || undefined,
				...truncatedFlag(inputJson),
				// The written file content takes the file's own language (chunked
				// FileDetail Write branch). Without a `content` field the body is a JSON
				// dump of the input instead, which the chunked card highlights as JSON.
				...(writtenContent && fp
					? { codeLangPath: fp }
					: writtenContent
						? {}
						: { codeLang: "json" }),
			}),
		),
	]);
}

/** Original file line an Edit applies at (metadata wins, then streaming metadata). */
function readStartLine(
	inputJson: unknown,
	metadata: Record<string, unknown> | null,
): number | undefined {
	if (typeof metadata?.startLine === "number") return metadata.startLine;
	const streaming = asObject(asObject(inputJson)?._streamingMetadata);
	return typeof streaming?.startLine === "number" ? streaming.startLine : undefined;
}

function classifyTasks(
	toolName: string,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const tasks = extractSpecTasks(inputJson, outputJson, metadata);
	if (tasks === null) {
		// Not parseable → fall back to the file diff/code branch.
		return classifyFile(toolName, inputJson, metadata);
	}
	return {
		kind: "spec-tasks",
		tasks: tasks.map((task) => ({
			text: task.text ?? "—",
			status: readLeafText(task.status),
			protected: task.protected === true,
		})),
	};
}

function classifyBash(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const awaitParam = isTruncated(inputJson) ? undefined : asObject(inputJson)?.await;
	const awaitObj =
		awaitParam != null && typeof awaitParam === "object" ? asObject(awaitParam) : null;
	const commandStr = awaitObj ? "" : extractField(inputJson, "command");
	const outputStr = resolveDisplayText(outputJson);
	const streamingOutput = (metadata ? readLeafText(metadata._streamingOutput) : undefined) ?? "";
	if (!commandStr && !outputStr && !awaitObj && !streamingOutput) return null;
	// Streaming bash uses a smaller cap while running.
	const streaming =
		metadata?._streamingOutput != null ||
		(asObject(inputJson)?._streamingChars != null && !outputStr);

	// Await mode: the chunked card leads with an `await` badge row carrying the
	// task id, timeout and wait_for text — none of which existed in the vlist.
	const awaitRow = awaitObj
		? badgeRow(
				chips([
					{ label: "await", color: "blue" },
					chip(readAwaitTaskId(awaitObj), "gray"),
					chip(formatTimeoutLabel(awaitObj.timeout), "gray"),
				]),
				typeof awaitObj.wait_for_text === "string" && awaitObj.wait_for_text
					? `wait_for: "${awaitObj.wait_for_text}"`
					: "",
			)
		: null;

	// Command and output are SEPARATE capped boxes in the chunked card (60px vs
	// 200px caps, each with its own label); merging them into one string lost the
	// boundary and the "Output" label.
	const body = outputStr || streamingOutput;
	// The output box gets the flag for ITS OWN source: the persisted output, or the
	// streaming snapshot on `_metadata` (which the projection cuts independently).
	// Bash output is among the most frequently truncated payloads, so measuring this
	// prefix as if it were complete is exactly the height instability `textTruncated`
	// exists to prevent.
	const bodyTruncatedFlag = outputStr
		? truncatedFlag(outputJson)
		: truncatedFlag(metadata?._streamingOutput);
	return sections([
		section(undefined, metaRows([awaitRow])),
		section(
			commandStr ? "command" : undefined,
			commandStr
				? capped("bash-cmd", {
						contentLines: countLines(commandStr),
						hasLabel: false,
						text: `$ ${commandStr}`,
						...truncatedFlag(inputJson),
						// Shell syntax for the command box. The OUTPUT box below stays
						// unhighlighted: it is program output, not source (the chunked card
						// likewise passes no language for it).
						codeLang: "shellscript",
					})
				: null,
		),
		section(
			body ? "output" : undefined,
			body
				? capped(streaming ? "streaming-bash" : "term", {
						contentLines: countLines(body),
						hasLabel: false,
						text: body,
						...bodyTruncatedFlag,
					})
				: null,
		),
	]);
}

/** `task_id` / `taskId` off a bash await parameter object. */
function readAwaitTaskId(awaitObj: Record<string, unknown>): string | undefined {
	const id = awaitObj.task_id ?? awaitObj.taskId;
	return typeof id === "string" && id ? id : undefined;
}

/**
 * A timeout badge label. Raw milliseconds are formatted here as a compact
 * `timeout: Ns` string: `shared/` has no i18n, and the value is a plain number
 * with no locale-dependent wording.
 */
function formatTimeoutLabel(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	const seconds = Math.round(value / 1000);
	if (seconds < 60) return `timeout: ${seconds}s`;
	const minutes = Math.round(seconds / 60);
	return minutes < 60 ? `timeout: ${minutes}m` : `timeout: ${Math.round(minutes / 60)}h`;
}

function classifySearch(
	status: string | null | undefined,
	inputJson: unknown,
	outputJson: unknown,
): ToolDetailData | null {
	const output = resolveDisplayText(outputJson);
	if (isFailStatus(status) && !output) {
		return { kind: "error", text: extractField(inputJson, "pattern", "glob") || "Search failed" };
	}
	// The chunked card leads with the pattern chip and an `in <path>` line.
	const pattern = extractField(inputJson, "pattern", "glob");
	const searchPath = extractField(inputJson, "path");
	return sections([
		section(
			undefined,
			metaRows([
				pattern ? { text: pattern, mono: true } : null,
				searchPath ? { text: `in ${searchPath}`, dimmed: true } : null,
			]),
		),
		section(
			output ? "output" : undefined,
			output
				? capped("code", {
						contentLines: countLines(output),
						hasLabel: false,
						text: output,
						...truncatedFlag(outputJson),
					})
				: null,
		),
	]);
}

function classifyWebSearch(inputJson: unknown, outputJson: unknown): ToolDetailData | null {
	const query = extractField(inputJson, "query");
	const output = resolveDisplayText(outputJson);
	if (!output) {
		return { kind: "error", text: "Web search failed" };
	}
	const parsed = asObject(tryParseJson(output));
	const results = parsed && Array.isArray(parsed.results) ? parsed.results : null;
	if (results) {
		const visible = Math.min(results.length, 10);
		// Each result keeps its own title (linked) / domain / snippet instead of
		// being flattened into three unrelated body lines.
		const entries: ToolStructuredEntry[] = [];
		for (let i = 0; i < visible; i++) {
			const r = asObject(results[i]) ?? {};
			const url = readLeafText(r.url);
			entries.push({
				title: readLeafText(r.title) ?? url ?? "",
				...(url ? { href: url } : {}),
				...(readLeafText(r.domain) ? { meta: readLeafText(r.domain) as string } : {}),
				...(readLeafText(r.snippet) ? { snippet: readLeafText(r.snippet) as string } : {}),
			});
		}
		return sections([
			section(undefined, metaRows([query ? { text: query, mono: true } : null])),
			section(undefined, { kind: "structured", badgeRows: 0, bodyLines: [], entries }),
		]);
	}
	// Non-structured output is markdown in the chunked card (ContentViewer markdown).
	// `sections()` cannot return null here: the output section's body is built
	// unconditionally, so `kept` always holds at least one entry.
	return sections([
		section(undefined, metaRows([query ? { text: query, mono: true } : null])),
		section(
			"output",
			capped("code", {
				contentLines: countLines(output),
				hasLabel: false,
				text: output,
				...truncatedFlag(outputJson),
				markdown: true,
			}),
		),
	]);
}

function classifyWebFetch(
	status: string | null | undefined,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const mode = extractField(inputJson, "mode");
	const url = extractField(inputJson, "url");
	const selector = extractField(inputJson, "selector");
	const output = resolveDisplayText(outputJson);
	// The url link + mode badge + selector rows are shown for EVERY mode.
	const header = metaRows([
		url ? { text: url, mono: true, href: url } : null,
		badgeRow(chips([chip(mode, "teal")])),
		selector ? { text: `selector: ${selector}`, mono: true, dimmed: true } : null,
	]);
	const fetchPreviewUrl = readLeafText(metadata?.previewUrl);
	if (mode === "screenshot" && fetchPreviewUrl !== undefined) {
		return sections([
			section(undefined, header),
			section(
				undefined,
				capped("media", {
					contentPx: MEDIA_IMAGE_CONTENT_PX,
					media: { previewUrl: fetchPreviewUrl, filename: url },
				}),
			),
		]);
	}
	if (isFailStatus(status) && !output) {
		return sections([
			section(undefined, header),
			section("error", { kind: "error", text: "Fetch failed" }),
		]);
	}
	// smart / readability outputs are markdown in the chunked card.
	const isMarkdown = mode === "smart" || mode === "readability";
	return sections([
		section(undefined, header),
		section(
			output ? "output" : undefined,
			output
				? capped("code", {
						contentLines: countLines(output),
						hasLabel: false,
						text: output,
						...truncatedFlag(outputJson),
						...(isMarkdown ? { markdown: true } : {}),
					})
				: null,
		),
	]);
}

function classifyTaskOutput(inputJson: unknown, outputJson: unknown): ToolDetailData | null {
	const output = resolveDisplayText(outputJson);
	// The chunked card leads with taskId / status / task_type badges plus the
	// block+timeout parameters — all of which were missing from the vlist.
	const taskId = extractField(inputJson, "task_id", "taskId");
	const taskType = extractField(inputJson, "task_type", "taskType");
	const retrievalStatus = extractField(outputJson, "retrieval_status");
	const outputStatus = extractField(outputJson, "status");
	const header = metaRows([
		badgeRow(
			chips([
				chip(taskId, "indigo"),
				chip(outputStatus, outputStatus === "failed" ? "red" : "green"),
				chip(taskType, "gray"),
				chip(formatTimeoutLabel(extractNumericField(inputJson, "timeout")), "gray"),
			]),
		),
	]);
	return sections([
		section(undefined, header),
		section(
			retrievalStatus ? "error" : undefined,
			retrievalStatus ? { kind: "error", text: retrievalStatus } : null,
		),
		section(
			output ? "output" : undefined,
			output
				? capped("code", {
						contentLines: countLines(output),
						hasLabel: false,
						text: output,
						...truncatedFlag(outputJson),
					})
				: null,
		),
	]);
}

function classifyAwait(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const output = resolveDisplayText(outputJson);
	const awaitType = extractField(inputJson, "type") || (metadata?.awaitType as string) || "task";
	const isBash = awaitType === "bash";
	// Badge row + waitFor / subagent lines (the chunked AwaitDetail header).
	const targetId = extractField(inputJson, "id", "task_id", "taskId");
	const resolvedId = metadata ? readLeafText(metadata.resolvedId) : undefined;
	const awaitStatus = metadata ? readLeafText(metadata.status) : undefined;
	const subagentId = metadata ? readLeafText(metadata.subagentId) : undefined;
	const waitForText = extractField(inputJson, "wait_for_text");
	const header = metaRows([
		badgeRow(
			chips([
				chip(awaitType, "indigo"),
				chip(targetId, "gray"),
				chip(resolvedId ? `→ ${resolvedId}` : undefined, "blue"),
				chip(awaitStatus, awaitStatus === "failed" ? "red" : "green"),
				chip(formatTimeoutLabel(extractNumericField(inputJson, "timeout")), "gray"),
			]),
		),
		waitForText ? { text: `wait_for: "${waitForText}"`, mono: true, dimmed: true } : null,
		subagentId ? pathRow(`subagent: ${subagentId}`) : null,
	]);
	return sections([
		section(undefined, header),
		section(
			output ? (isBash ? "output" : "result") : undefined,
			output
				? capped(isBash ? "term" : "code", {
						contentLines: countLines(output),
						hasLabel: false,
						text: output,
						...truncatedFlag(outputJson),
						// Non-bash await results are markdown in the chunked card.
						...(isBash ? {} : { markdown: true }),
					})
				: null,
		),
	]);
}

function classifySend(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const input = asObject(inputJson);
	const message = isTruncated(inputJson)
		? inputJson.preview
		: typeof input?.message === "string"
			? input.message
			: "";
	const output = resolveDisplayText(outputJson);
	const targets = Array.isArray(metadata?.targets) ? (metadata.targets as unknown[]) : [];
	const isAwait = isTruncated(inputJson)
		? metadata?.await === true
		: input?.await === true || metadata?.await === true;
	const doInterrupt = isTruncated(inputJson)
		? metadata?.doInterrupt === true
		: input?.doInterrupt === true || metadata?.doInterrupt === true;
	const badges: ToolStructuredBadge[] =
		targets.length > 0
			? targets.map((t) => {
					const to = asObject(t) ?? {};
					const label = readLeafText(to.title) ?? readLeafText(to.id) ?? "target";
					return { label: `→ ${label}`, color: "blue" };
				})
			: [{ label: "Subagent message", color: "blue" }];
	badges.push({ label: isAwait ? "await" : "async", color: isAwait ? "indigo" : "gray" });
	if (doInterrupt) badges.push({ label: "interrupt", color: "orange" });

	// Delivery rows keep their per-target structure (status badge + label +
	// interrupted/error suffix) instead of collapsing to "sent · Agent A" text.
	const deliveryEntries: ToolStructuredEntry[] = targets.map((t) => {
		const to = asObject(t) ?? {};
		const label = readLeafText(to.title) ?? readLeafText(to.id) ?? "target";
		const st = readLeafText(to.status) ?? "sent";
		const error = readLeafText(to.error);
		return {
			title: label,
			badges: chips([
				chip(st, st === "failed" || error ? "red" : "green"),
				chip(to.interrupted === true ? "interrupted" : undefined, "orange"),
			]),
			...(error ? { snippet: error } : {}),
		};
	});

	return sections([
		section(undefined, metaRows([badgeRow(badges)])),
		section(
			message ? "message" : undefined,
			message
				? capped("code", {
						contentLines: countLines(message),
						hasLabel: false,
						text: message,
						...truncatedFlag(inputJson),
						markdown: true,
					})
				: null,
		),
		section(
			deliveryEntries.length > 0 ? "delivery" : undefined,
			deliveryEntries.length > 0
				? { kind: "structured", badgeRows: 0, bodyLines: [], entries: deliveryEntries }
				: null,
		),
		section(
			output ? (isAwait ? "reply" : "result") : undefined,
			output
				? capped("code", {
						contentLines: countLines(output),
						hasLabel: false,
						text: output,
						...truncatedFlag(outputJson),
						markdown: true,
					})
				: null,
		),
	]);
}

interface AskQuestion {
	header?: string;
	question?: string;
	options?: unknown[];
	multiSelect?: boolean;
}

/** English fallbacks for the two measured ask-replay prefixes. */
const ASK_ANSWER_PREFIX_FALLBACK = "Answer:";
const ASK_CUSTOM_ANSWER_PREFIX_FALLBACK = "Custom answer:";

/**
 * Join a localized prefix with its value.
 *
 * The prefix and value are concatenated at CLASSIFY time (not render time)
 * because the joined string is what wraps, and therefore what must be measured.
 * A full-width terminal punctuation mark (CJK `：`) already carries its own
 * trailing whitespace in the glyph, so a space after it reads as a gap — Latin
 * prefixes get the space, full-width ones do not.
 */
function joinAskPrefix(prefix: string, value: string): string {
	const last = prefix.at(-1) ?? "";
	// Any non-ASCII terminal char is treated as full-width (CJK colon / ideographic
	// punctuation); ASCII prefixes take a separating space.
	return last.charCodeAt(0) > 0x7f ? `${prefix}${value}` : `${prefix} ${value}`;
}

/** A non-empty trimmed string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim().length > 0 ? value : undefined;
}

/**
 * Split a multi-select answer (`"Alpha, Beta"`) into its parts. Mirrors
 * `splitAnswerParts` in frontend/components/narrator/ask-user-question-utils.ts
 * (which this file cannot import — purity guard).
 */
function askAnswerParts(answer: string): string[] {
	return answer
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

/** Whether `answer` selected `optionLabel` (exact match or one multi-select part). */
function askOptionSelected(answer: string | undefined, optionLabel: string): boolean {
	if (!answer) return false;
	const target = optionLabel.trim();
	if (!target) return false;
	const normalized = answer.trim();
	return normalized === target || askAnswerParts(normalized).includes(target);
}

/**
 * Resolve the submitted answer for one question.
 *
 * Mirrors `resolveSavedAnswer` in ask-user-question-utils.ts: the answers map is
 * keyed by the tool's `question` field, but providers occasionally omit it (the
 * UI then falls back to `header`), and a single-question call whose key drifted
 * still has exactly one answer to show. Reading only `answers[question]` — the
 * previous behaviour — rendered those cases as unanswered.
 */
function resolveAskAnswer(
	q: AskQuestion,
	header: string,
	answers: Record<string, unknown>,
	allowSingleAnswerFallback: boolean,
): string | undefined {
	const byQuestion =
		typeof q.question === "string" ? nonEmptyString(answers[q.question]) : undefined;
	if (byQuestion) return byQuestion;
	const byHeader = nonEmptyString(answers[header]);
	if (byHeader) return byHeader;
	if (allowSingleAnswerFallback) {
		const values = Object.values(answers)
			.map(nonEmptyString)
			.filter((v): v is string => v !== undefined);
		if (values.length === 1) return values[0];
	}
	return undefined;
}

/**
 * Read-only question replay.
 *
 * Only a LIVE permission form suppresses it: the interactive banner then owns
 * the display. Keying off `running` alone (an older behaviour) made an in-flight
 * question render an empty card whenever the form lived elsewhere.
 */
function classifyAsk(
	inputJson: unknown,
	hasPendingPermission: boolean,
	labels: Record<string, string> | undefined,
): ToolDetailData | null {
	if (hasPendingPermission) return null;
	const input = asObject(inputJson);
	const rawQuestions = Array.isArray(input?.questions) ? (input.questions as AskQuestion[]) : [];
	if (rawQuestions.length === 0) return null;
	const answers = asObject(input?.answers) ?? {};
	const answerPrefix = labels?.askAnswerPrefix ?? ASK_ANSWER_PREFIX_FALLBACK;
	const customPrefix = labels?.askCustomAnswerPrefix ?? ASK_CUSTOM_ANSWER_PREFIX_FALLBACK;
	// A single question's header is already the card's own summary line, so the
	// detail region must not repeat it.
	const omitHeader = rawQuestions.length === 1;

	const questions: ToolAskQuestion[] = [];
	for (const q of rawQuestions.slice(0, ASK_QUESTIONS_MAX)) {
		const headerText = readLeafText(q.header);
		const header = headerText?.trim() ? headerText : "Question";
		const answer = resolveAskAnswer(q, header, answers, omitHeader);
		const rawOptions = Array.isArray(q.options) ? q.options : [];
		const options: ToolAskOption[] = [];
		const optionLabels: string[] = [];
		for (const opt of rawOptions.slice(0, ASK_OPTIONS_MAX)) {
			const o = asObject(opt);
			const label = (o ? readLeafText(o.label) : undefined) ?? "";
			// The option DESCRIPTION is half the information in the banner; carrying
			// only the label dropped it entirely.
			const description = (o ? readLeafText(o.description) : undefined) ?? "";
			if (label) optionLabels.push(label);
			options.push({
				label,
				...(description ? { description } : {}),
				...(askOptionSelected(answer, label) ? { selected: true } : {}),
			});
		}
		// An answer matching no option (or no combination of options) is free text.
		const isCustom =
			answer !== undefined &&
			!optionLabels.some((label) => askOptionSelected(answer, label)) &&
			!(
				askAnswerParts(answer).length > 0 &&
				askAnswerParts(answer).every((part) => optionLabels.includes(part))
			);
		questions.push({
			header,
			...(omitHeader ? { omitHeader: true } : {}),
			...(q.multiSelect === true ? { multiSelect: true } : {}),
			options,
			...(answer !== undefined
				? isCustom
					? { customAnswer: joinAskPrefix(customPrefix, answer) }
					: { answer: joinAskPrefix(answerPrefix, answer) }
				: {}),
		});
	}
	return { kind: "ask", questions };
}

function classifyPlan(
	inputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const planText = extractField(inputJson, "plan") || String(asObject(inputJson)?.plan ?? "");
	if (!planText) return null;
	// Plans are authored in markdown and the chunked card renders them as such
	// (ToolCallCard PlanDetail → ContentViewer markdown), so the vlist must not
	// degrade them to monospace plain text. `_planFile` marks a file-based plan;
	// pass the raw path through and let the render layer localize it.
	const planFile = extractField(inputJson, "_planFile");
	const body = capped("plan", {
		contentLines: countLines(planText),
		text: planText,
		...truncatedFlag(inputJson),
		markdown: true,
		...(planFile ? { sourcePath: planFile } : {}),
	});
	// A denied plan carries the reviewer's feedback above the body.
	const denyFeedback =
		(metadata ? readLeafText(metadata.denyFeedback) : undefined) ||
		(metadata ? readLeafText(metadata.permissionDenyMessage) : undefined) ||
		"";
	if (!denyFeedback.trim()) return body;
	return {
		kind: "sections",
		sections: [
			{ label: "error", body: { kind: "error", text: denyFeedback } },
			{ label: "plan", body },
		],
	};
}

function classifyPipeline(
	toolName: string,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const rule = extractField(inputJson, "rule");
	const aliases = stringArray(asObject(inputJson)?.aliases);
	const label = extractField(inputJson, "label");
	const format = extractField(inputJson, "format");
	const output = resolveDisplayText(outputJson);
	const isStart = toolName === "StartPipeline";
	const isExtract = toolName === "ExtractPipeline";
	const stageLabel = isStart ? "start" : isExtract ? "extract" : "end";
	const badges = chips([
		{ label: stageLabel, color: isStart ? "blue" : isExtract ? "teal" : "indigo" },
		chip(label, "gray"),
		// Only the non-start stages show a format chip; only start shows the preview cap.
		chip(!isStart && format ? format : undefined, "gray"),
		chip(formatCharCap(extractNumericField(inputJson, "maxPreviewChars"), "preview"), "gray"),
		chip(formatCharCap(extractNumericField(inputJson, "maxChars"), "max"), "gray"),
		...aliases.map((alias) => chip(alias, "cyan")),
	]);

	// Captured aliases keep their per-entry structure (alias + tool + bytes).
	const captures = Array.isArray(metadata?.captured) ? (metadata.captured as unknown[]) : [];
	const captureEntries: ToolStructuredEntry[] = captures.slice(0, 10).map((c) => {
		const o = asObject(c) ?? {};
		const alias = readLeafText(o.alias) ?? "capture";
		const tool = readLeafText(o.toolName) ?? "";
		const bytes = typeof o.bytes === "number" ? `${o.bytes} B` : "";
		return {
			title: alias,
			badges: chips([chip(tool, "gray")]),
			...(bytes ? { meta: bytes } : {}),
		};
	});

	return sections([
		section(undefined, metaRows([badgeRow(badges)])),
		section(
			rule ? "rule" : undefined,
			rule
				? capped("code", {
						contentLines: countLines(rule),
						hasLabel: false,
						text: rule,
						...truncatedFlag(inputJson),
						// A pipeline rule is a shell expression (parity with the Pixi renderer).
						codeLang: "shellscript",
					})
				: null,
		),
		section(
			captureEntries.length > 0 ? "captured" : undefined,
			captureEntries.length > 0
				? { kind: "structured", badgeRows: 0, bodyLines: [], entries: captureEntries }
				: null,
		),
		section(
			output ? "output" : undefined,
			output
				? capped("code", {
						contentLines: countLines(output),
						hasLabel: false,
						text: output,
						...truncatedFlag(outputJson),
					})
				: null,
		),
	]);
}

/** `preview ≤ N chars` / `max N chars` badge label (numbers only, no i18n). */
function formatCharCap(value: number | undefined, kind: "preview" | "max"): string | undefined {
	if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
	return kind === "preview" ? `preview ≤ ${value} chars` : `max ${value} chars`;
}

function classifyTerminal(
	status: string | null | undefined,
	inputJson: unknown,
	outputJson: unknown,
): ToolDetailData | null {
	const action = extractField(inputJson, "action");
	// The terminal id + action badge row is the chunked card's header.
	const terminalId = extractField(inputJson, "terminalId", "terminal_id", "id");
	const header = metaRows([
		badgeRow(chips([chip(action, "yellow")]), terminalId ? `terminal: ${terminalId}` : ""),
	]);
	if (action === "write") {
		const inp = extractField(inputJson, "input");
		if (isFailStatus(status) && !inp) return { kind: "error", text: "Terminal write failed" };
		return sections([
			section(undefined, header),
			section(
				inp ? "input" : undefined,
				inp
					? capped("bash-cmd", {
							contentLines: countLines(inp),
							hasLabel: false,
							text: inp,
							...truncatedFlag(inputJson),
							// Terminal stdin is shell input; the read/list OUTPUT below is
							// program output and stays unhighlighted.
							codeLang: "shellscript",
						})
					: null,
			),
		]);
	}
	// read / list
	const output = resolveDisplayText(outputJson);
	if (isFailStatus(status) && !output) return { kind: "error", text: "Terminal read failed" };
	return sections([
		section(undefined, header),
		section(
			output ? "output" : undefined,
			output
				? capped("term", {
						contentLines: countLines(output),
						hasLabel: false,
						text: output,
						...truncatedFlag(outputJson),
					})
				: null,
		),
	]);
}

function classifyShare(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	if (!metadata || typeof metadata.downloadUrl !== "string") {
		// No structured metadata → generic input/output view.
		return classifyGeneric(inputJson, outputJson);
	}
	const filename = readLeafText(metadata.filename) ?? "file";
	const downloadUrl = metadata.downloadUrl;
	const sizeFormatted = readLeafText(metadata.sizeFormatted);
	const fileCount = typeof metadata.fileCount === "number" ? metadata.fileCount : undefined;
	const expiryHours = typeof metadata.expiryHours === "number" ? metadata.expiryHours : undefined;
	// The chunked share card is a metadata badge strip + download / copy-link
	// buttons; the vlist previously showed a single filename chip and no controls.
	const header = metaRows([
		{
			text: filename,
			badges: chips([
				chip(sizeFormatted, "gray"),
				chip(metadata.isDirectory === true ? "directory" : undefined, "blue"),
				chip(
					metadata.format === "zip"
						? "zip"
						: metadata.compressed === true
							? "compressed"
							: undefined,
					"violet",
				),
				chip(fileCount != null && fileCount > 0 ? `${fileCount} files` : undefined, "cyan"),
				chip(metadata.preview === true ? "preview" : undefined, "teal"),
				chip(expiryHours != null ? `${expiryHours}h` : undefined, "yellow"),
			]),
			actions: [
				{ kind: "download", value: downloadUrl },
				{ kind: "copy", value: downloadUrl },
			],
		},
	]);
	const sharePreviewUrl = readLeafText(metadata.previewUrl);
	if (metadata.preview === true && sharePreviewUrl !== undefined) {
		return sections([
			section(undefined, header),
			section(
				undefined,
				capped("media", {
					contentPx: MEDIA_IMAGE_CONTENT_PX,
					media: { previewUrl: sharePreviewUrl, filename },
				}),
			),
		]);
	}
	return sections([section(undefined, header)]);
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
		// Each hit is its own card in the chunked view: role badge + narrator title
		// + timestamp + snippet + id. Flattening it lost every field but two.
		const entries: ToolStructuredEntry[] = [];
		for (let i = 0; i < visible; i++) {
			const r = asObject(results[i]) ?? {};
			const role = readLeafText(r.role) ?? "msg";
			const title = readLeafText(r.narratorTitle) ?? "";
			const snippet = readLeafText(r.snippet) ?? "";
			const id = readLeafText(r.id) ?? "";
			const created = readLeafText(r.createdAt) ?? "";
			entries.push({
				title: title || role,
				badges: chips([chip(role, role === "user" ? "blue" : "green")]),
				...(created || id ? { meta: [created, id].filter(Boolean).join(" · ") } : {}),
				...(snippet
					? { snippet: snippet.replace(/>>>/g, "").replace(/<<</g, "").trim().slice(0, 300) }
					: {}),
				tone: role === "user" ? "indigo" : undefined,
			});
		}
		return {
			kind: "structured",
			badgeRows: 1,
			badges: recallQueryBadges(metadata),
			bodyLines: [],
			entries,
		};
	}
	// read_conversation
	const messages = Array.isArray(metadata.messages) ? (metadata.messages as unknown[]) : [];
	if (messages.length === 0) {
		return { kind: "structured", badgeRows: 0, bodyLines: ["No results"] };
	}
	const visible = Math.min(messages.length, 10);
	const entries: ToolStructuredEntry[] = [];
	for (let i = 0; i < visible; i++) {
		const m = asObject(messages[i]) ?? {};
		const role = readLeafText(m.role) ?? "msg";
		const text = readLeafText(m.text) ?? "";
		const created = readLeafText(m.createdAt) ?? "";
		entries.push({
			title: role,
			badges: chips([chip(role, role === "user" ? "blue" : "green")]),
			...(typeof m.seq === "number" || created
				? {
						meta: [typeof m.seq === "number" ? `seq ${m.seq}` : "", created]
							.filter(Boolean)
							.join(" · "),
					}
				: {}),
			...(text ? { snippet: text.slice(0, 300) } : {}),
			tone: role === "user" ? "indigo" : undefined,
		});
	}
	const title = readLeafText(metadata.narratorTitle) ?? "";
	const model = readLeafText(metadata.model) ?? "";
	const badges = chips([chip(title, "gray"), chip(model, "gray")]);
	return { kind: "structured", badgeRows: 1, badges, bodyLines: [], entries };
}

/** Build query badge chips for a recall search (mirrors RecallDetail badges). */
function recallQueryBadges(metadata: Record<string, unknown>): ToolStructuredBadge[] {
	const queries = Array.isArray(metadata.queries)
		? (metadata.queries as unknown[])
		: [metadata.query];
	// `readLeafText` rather than a `typeof` filter: a wrapped query would otherwise
	// be silently dropped and the card would show no query badge at all.
	return queries
		.map(readLeafText)
		.filter((q): q is string => q !== undefined && q.length > 0)
		.slice(0, 5)
		.map((q) => ({ label: q.slice(0, 80), color: "cyan" }));
}

function classifySkill(inputJson: unknown, outputJson: unknown): ToolDetailData | null {
	const output = resolveDisplayText(outputJson);
	const match = output.match(/<skill_content\s+name="([^"]+)">/);
	if (match) {
		const skillName = match[1] ?? "";
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
		// Attached skill files listed after the body.
		const files = parseSkillFiles(output);
		return sections([
			section(undefined, metaRows([badgeRow(chips([chip(skillName, "grape")]))])),
			section(
				undefined,
				// Skill bodies are markdown documents (the chunked card uses
				// ContentViewer markdown); monospace was a visible downgrade.
				capped("skill", {
					contentLines: countLines(content) + 2,
					hasLabel: false,
					text: content || undefined,
					// The body is carved out of the OUTPUT (`resolveDisplayText(outputJson)`),
					// so the flag must describe the output — the input only holds the skill
					// name and args and is never the cut payload here.
					...truncatedFlag(outputJson),
					...(content ? { markdown: true } : {}),
				}),
			),
			section(
				files.length > 0 ? "files" : undefined,
				files.length > 0
					? {
							kind: "structured",
							badgeRows: 1,
							badges: files.slice(0, 10).map((f) => ({ label: f, color: "gray" })),
							bodyLines: [],
						}
					: null,
			),
		]);
	}
	return classifyGeneric(inputJson, outputJson);
}

/** Attached-file names listed in a `<skill_files>` block, if present. */
function parseSkillFiles(output: string): string[] {
	const start = output.indexOf("<skill_files");
	if (start === -1) return [];
	const end = output.indexOf("</skill_files>", start);
	const block = output.slice(start, end === -1 ? undefined : end);
	return block
		.split("\n")
		.slice(1)
		.map((line) => line.trim().replace(/^[-*]\s*/, ""))
		.filter((line) => line.length > 0 && !line.startsWith("<"));
}

function classifyBrowser(
	status: string | null | undefined,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const action = extractField(inputJson, "action");
	const url = extractField(inputJson, "url");
	const sessionId =
		metadata && readLeafText(metadata.sessionId) !== undefined
			? (readLeafText(metadata.sessionId) as string)
			: extractField(inputJson, "sessionId", "session_id");
	// action + session badges and the clickable URL are the chunked card's header.
	const header = metaRows([
		badgeRow(chips([chip(action, "teal"), chip(sessionId, "gray")])),
		url ? { text: url, mono: true, href: url } : null,
	]);
	const browserPreviewUrl = readLeafText(metadata?.previewUrl);
	if (action === "screenshot" && browserPreviewUrl !== undefined) {
		// `savedFilePath` (set when the call passed `file_path`) is the DURABLE source:
		// the share behind previewUrl lives in an in-memory registry that a server
		// restart wipes (and it expires on its own timer), so the render layer needs
		// this to still show a screenshot from an earlier run.
		const savedFilePath = readLeafText(metadata?.savedFilePath);
		return sections([
			section(undefined, header),
			section(
				undefined,
				capped("media", {
					contentPx: MEDIA_IMAGE_CONTENT_PX,
					media: {
						previewUrl: browserPreviewUrl,
						filename: url,
						...(savedFilePath ? { filePath: savedFilePath } : {}),
					},
				}),
			),
		]);
	}
	const output = resolveDisplayText(outputJson);
	if (isFailStatus(status) && !output) return { kind: "error", text: "Browser action failed" };
	return sections([
		section(undefined, header),
		section(
			output ? "output" : undefined,
			output
				? capped("code", {
						contentLines: countLines(output),
						hasLabel: false,
						text: output,
						...truncatedFlag(outputJson),
						// Parity with the chunked BrowserDetail: only the `dom` action returns
						// markup; other actions return prose/JSON-ish text.
						...(action === "dom" ? { codeLang: "html" } : {}),
					})
				: null,
		),
	]);
}

function classifyKnowledge(
	toolName: string,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	if (toolName === "KnowledgeSearch" && metadata && Array.isArray(metadata.results)) {
		const results = metadata.results as unknown[];
		const visible = Math.min(results.length, 10);
		// Each entry is a linked card with tags + personal/behind-main state.
		const entries: ToolStructuredEntry[] = [];
		for (let i = 0; i < visible; i++) {
			const r = asObject(results[i]) ?? {};
			const id = readLeafText(r.id) ?? "";
			const title = readLeafText(r.title) ?? (id || "entry");
			const tags = stringArray(r.tags);
			const snippet = readLeafText(r.snippet) ?? "";
			entries.push({
				title,
				...(id ? { href: knowledgeEntryHref(id) } : {}),
				badges: chips([
					...tags.slice(0, 6).map((tag) => chip(`#${tag}`, "grape")),
					chip(r.isPersonal === true ? "personal" : undefined, "cyan"),
					chip(r.behindMain === true ? "behind main" : undefined, "orange"),
				]),
				...(snippet ? { snippet: snippet.slice(0, 300) } : {}),
			});
		}
		return {
			kind: "structured",
			badgeRows: 1,
			badges: chips([chip(`${results.length} results`, "grape")]),
			bodyLines: [],
			entries,
		};
	}
	if (toolName === "KnowledgeRead") {
		const body = resolveDisplayText(outputJson);
		const entryId =
			(metadata ? readLeafText(metadata.entryId) : undefined) || extractField(inputJson, "entryId");
		const title = (metadata ? readLeafText(metadata.title) : undefined) ?? "";
		const tags = stringArray(metadata?.tags);
		const keywords = stringArray(metadata?.keywords);
		const header = metaRows([
			title || entryId
				? {
						text: title || entryId,
						...(entryId ? { href: knowledgeEntryHref(entryId) } : {}),
						badges: chips([
							chip(metadata?.isPersonal === true ? "personal" : undefined, "cyan"),
							chip(metadata?.behindMain === true ? "behind main" : undefined, "orange"),
						]),
					}
				: null,
			badgeRow(
				chips([
					...tags.slice(0, 8).map((tag) => chip(`#${tag}`, "grape")),
					...keywords.slice(0, 8).map((kw) => chip(kw, "gray")),
				]),
			),
		]);
		return sections([
			section(undefined, header),
			section(
				undefined,
				// Knowledge bodies are markdown documents, like plans.
				capped("knowledge", {
					contentLines: countLines(body) + 2,
					hasLabel: false,
					text: body || undefined,
					// A knowledge entry is one of the largest bodies the projection sees, so
					// the flag matters most here: without it the box is sized to whatever
					// prefix the budget happened to include.
					...truncatedFlag(outputJson),
					...(body ? { markdown: true } : {}),
				}),
			),
		]);
	}
	// Create/Edit/Review/Admin: prefer the output body as structured lines.
	const output = resolveDisplayText(outputJson);
	if (output) {
		const entryId =
			(metadata ? readLeafText(metadata.entryId) : undefined) || extractField(inputJson, "entryId");
		const scope = (metadata ? readLeafText(metadata.scope) : undefined) ?? "";
		const header = metaRows([
			entryId ? { text: entryId, mono: true, href: knowledgeEntryHref(entryId) } : null,
			badgeRow(
				chips([
					chip(scope, "grape"),
					chip(metadata?.conflict === true ? "conflict" : undefined, "red"),
					chip(metadata?.rebased === true ? "rebased" : undefined, "yellow"),
				]),
			),
		]);
		return sections([
			section(undefined, header),
			section(undefined, {
				kind: "structured",
				badgeRows: 0,
				bodyLines: output.split("\n"),
			}),
		]);
	}
	return classifyGeneric(inputJson, outputJson);
}

/** In-app link to a knowledge entry (the chunked EntryLink target). */
function knowledgeEntryHref(entryId: string): string {
	return `/knowledge/${entryId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming input (mirrors ToolCallCard's StreamingInputDetail).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Live preview of a tool's input as it streams in. The chunked card swaps its
 * whole detail region for this while `isStreaming` holds; the vlist rendered
 * nothing at all, so every streaming card looked empty.
 *
 * Returns null for the categories whose header already says everything
 * (read/search) — matching the chunked component's own early returns.
 */
function classifyStreamingInput(
	toolName: string,
	category: string,
	inputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const input = asObject(inputJson);
	if (!input) return null;
	const fields = asObject(input._streamingFields) ?? {};
	const fieldName = readLeafText(input._streamingFieldName) ?? "";
	const fieldValue = readLeafText(input._streamingFieldValue) ?? "";
	// The real `file_path` is the last resort, not an afterthought: a live chunk
	// MERGES into an already-persisted input (mergeToolFields), so a re-streamed
	// call can carry the settled path on the input itself while the stream markers
	// only describe the field in flight. The pixi model already reads all three
	// (pixi-message-model.ts:992); this classifier used to stop at the markers.
	const filePath =
		(readLeafText(input._streamingFilePath) ?? "") ||
		(readLeafText(fields.file_path) ?? "") ||
		filePathOf(inputJson);

	if (category === "file") {
		if (toolName === "Edit") {
			// Edit streams old_string first, then new_string: show the provisional diff.
			// BOTH sides must also consider the field currently streaming — reading
			// only the settled `_streamingFields` misses the in-flight value, and while
			// old_string was still arriving the card fell through to a raw JSON dump
			// instead of the matching-phase preview (chunked getStreamingEditPreview
			// reads `fields.x || (fieldName === "x" ? fieldValue : "")` for each side).
			const oldStr =
				(readLeafText(fields.old_string) ?? "") || (fieldName === "old_string" ? fieldValue : "");
			const newStr =
				(readLeafText(fields.new_string) ?? "") || (fieldName === "new_string" ? fieldValue : "");
			if (oldStr || newStr) {
				const startLine = readStartLine(inputJson, metadata);
				const header = filePath ? (startLine != null ? `${filePath}:${startLine}` : filePath) : "";
				// Mirrors the chunked EditDiffBlock's streaming rules exactly:
				//   phase "replacing" once new_string starts arriving, else "matching"
				//   hasReplacement = phase === "replacing"
				//   while matching, both sides are the same text (an all-context diff)
				//   startLine falls back to 1 so the gutter is always present
				//   lineNumberPrefix = "xx" while matching (positions are provisional)
				const isReplacing = fieldName === "new_string" || newStr.length > 0;
				return sections([
					section(undefined, metaRows([pathRow(header)])),
					section(
						undefined,
						diffBody(
							oldStr,
							isReplacing ? newStr : oldStr,
							startLine ?? 1,
							{ hasLabel: false, ...(filePath ? { codeLangPath: filePath } : {}) },
							isReplacing ? undefined : "xx",
						),
					),
				]);
			}
		}
		const isContentField = fieldName === "content" || fieldName === "new_string";
		if (!isContentField || !fieldValue) return null;
		// A missing path only costs the path row and the syntax language — the
		// streamed body is still the most useful thing on the card. Write emits
		// `content` before `file_path` often enough that gating the whole preview on
		// the path left the card blank for the entire write.
		return sections([
			section(undefined, metaRows([pathRow(filePath)])),
			section(
				undefined,
				capped("streaming", {
					contentLines: countLines(fieldValue),
					hasLabel: false,
					text: fieldValue,
					...(filePath ? { codeLangPath: filePath } : {}),
				}),
			),
		]);
	}

	if (category === "bash") {
		const cmd = fieldName === "command" ? fieldValue : (readLeafText(fields.command) ?? "");
		if (!cmd) return null;
		return capped("streaming-bash", {
			contentLines: countLines(cmd),
			hasLabel: false,
			text: `$ ${cmd}`,
			codeLang: "shellscript",
		});
	}

	// Agent / Send / Plan stream a markdown body.
	const MARKDOWN_STREAM_FIELD: Record<string, string> = {
		agent: "prompt",
		send: "message",
		plan: "plan",
	};
	const expected = MARKDOWN_STREAM_FIELD[category];
	if (expected && fieldName === expected && fieldValue) {
		return capped(category === "plan" ? "plan" : "streaming", {
			contentLines: countLines(fieldValue),
			hasLabel: false,
			text: fieldValue,
			markdown: true,
		});
	}
	return null;
}
