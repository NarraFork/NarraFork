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
 * Shared types are the single source for classification, measurement and paint.
 */

import { hasUsablePlanBody } from "../plan-reference";
import { readBackgroundTaskId, stripAwaitAgentEnvelope } from "../subagent-result-text";
import {
	deriveToolProgress,
	formatProgressBytes,
	formatProgressDuration,
	hasRenderableProgress,
	readToolProgressPayload,
} from "../tool-progress";
import {
	communicationSelectors,
	communicationTargetLabel,
	deriveCommunicationState,
	formatCommunicationState,
	resolveCommunicationTargets,
} from "./communication-state";
import {
	countDiffLineStats,
	createDiffDocument,
	type DiffDocument,
	type DiffLineStats,
	type DiffSourcePoint,
	MAX_DIFF_INPUT_CHARS,
} from "./diff-core";
import {
	createSourceText,
	isSourceTextRange,
	normalizeSourceText,
	type SourceTextRange,
} from "./source-text";
import { hasTruncatedLeaf, readLeafText, stringifyForDisplay } from "./tool-io-projection";

// ─────────────────────────────────────────────────────────────────────────────
// Canonical tool-detail bodies and ordered sections.
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
	| "agent-result"
	| "streaming-bash"
	| "streaming";

/**
 * Fallback pixel height for an inline media image (`media` cap `contentPx`)
 * when the payload carries NO intrinsic dimensions.
 *
 * Deliberately the SAME fixed 200px a dimensionless user-message image block
 * occupies (frontend measure-media's `IMAGE_FIXED_HEIGHT`), so a screenshot in
 * a tool card and an image in a chat bubble reserve identical space. The
 * previous 400 was a standalone estimate: a 1280×900 screenshot squeezed to
 * the card width is ~85px shorter than that, so every screenshot row carried a
 * tall empty band and the reserved box dwarfed the picture inside it.
 *
 * When the metadata DOES carry the intrinsic width/height (browser / web-fetch
 * screenshots, image Reads, image shares), the measure layer instead reserves
 * the aspect-ratio-fitted height via `fitImageBox` — pure arithmetic on data,
 * no measurement — so the box matches the painted picture exactly.
 *
 * Keep in sync with measure-media.ts's IMAGE_FIXED_HEIGHT (a shared → frontend
 * import would break this file's purity guard).
 */
export const MEDIA_IMAGE_CONTENT_PX = 200;

/**
 * Image descriptor for a `media` cap. Carries just enough for the render layer
 * to resolve an <img> src the same way the classic card does (direct
 * previewUrl → /api/fs/preview by path → /api/uploads blob by id). The src
 * fields NEVER affect the measured height; `width`/`height` DO — when present,
 * the measure layer reserves the aspect-fitted height instead of the fixed
 * fallback. Keep the fields optional; both sides fall back gracefully when
 * none resolve.
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
	/**
	 * Intrinsic pixel size from the tool payload (screenshot result metadata,
	 * upload record). HEIGHT-RELEVANT: drives the aspect-ratio reservation.
	 */
	width?: number;
	height?: number;
}

export type ToolBodySource = `input.${string}` | `output.${string}`;
export type ToolBodyFormat = "text" | "code" | "markdown" | "diff" | "media";
export type ToolBodyFollowTarget =
	| { kind: "end" }
	| { kind: "diff-row"; focus: DiffSourcePoint | null };

/** One canonical body descriptor. Geometry and viewport reading state live elsewhere. */
export interface ToolCappedDetail {
	kind: "capped";
	id: string;
	source: ToolBodySource;
	format: ToolBodyFormat;
	live: boolean;
	followTarget: ToolBodyFollowTarget;
	range?: SourceTextRange;
	revision?: string | number;
	diffDocument?: DiffDocument;
	/** Height budget only; labels and presentation never derive from it. */
	cap: DetailCapKind;
	/** Estimated content line count (× DETAIL_CONTENT_LINE_HEIGHT). */
	contentLines?: number;
	/** Direct content pixel estimate (media/images); wins over contentLines. */
	contentPx?: number;
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
	 * Image descriptor for `media` caps. When present the render layer paints an
	 * actual image inside the reserved box instead of an empty placeholder. The
	 * src fields are render-only; `width`/`height` are MEASURED (they pick the
	 * aspect-fitted content height over the fixed fallback).
	 */
	media?: ToolMediaRef;
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
	 * RENDER-ONLY: colour this body with a bespoke tokenizer instead of a language
	 * grammar.
	 *
	 * For bodies that are structured REPORTS rather than code. A language grammar
	 * highlights those confidently wrongly — on StructView `outline` rows it painted our
	 * `exported`/`refs:3` annotations with the function-name colour, left `variable`
	 * entirely grey (not a TS keyword), and split `L13-27` into a subtraction.
	 *
	 * A string rather than a boolean so a second report-shaped tool can add its own
	 * tokenizer without another field. Height-neutral, like the two fields above.
	 */
	customHighlight?: "struct-view";
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
	/** Option title (wraps). */
	header: string;
	/** Option description under the header (wraps). */
	description?: string;
	/** Whether the submitted answer selected this option (multi-select aware). */
	selected?: boolean;
}

/** One question of a read-only AskUserQuestion replay. */
export interface ToolAskQuestion {
	/** Full question text (wraps). */
	header: string;
	/** Optional extra context under the header. */
	description?: string;
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
	/**
	 * Render-only tone. `warning` paints the text yellow instead of red, which is
	 * what a DENIED PLAN's reviewer feedback needs: it is the user's own note back
	 * to the model, not a tool failure, and the chunked PlanDetail has always shown
	 * it in yellow. Height-neutral (colour only).
	 */
	tone?: "warning";
}

/** An action control drawn on a meta row (share download / copy link). */
export interface ToolRowAction {
	kind: "download" | "copy";
	/** Target URL: an <a href> for `download`, clipboard text for `copy`. */
	value: string;
}

/**
 * A determinate progress bar drawn on a meta row (a running device transfer).
 *
 * A real bar element, not text: an ASCII `[███░░░]` in a monospace body would
 * make the client re-parse the producer's own formatting to know anything, and it
 * cannot animate, cannot carry a colour, and reads as output rather than as
 * chrome. The height cost is a FIXED reserved row (see META_PROGRESS_ROW), so
 * this is height-stable regardless of how the numbers change.
 *
 * `ratio` null = INDETERMINATE (total genuinely unknown — an upload's sender
 * knows only what it has sent). The render layer must animate rather than paint a
 * 0% bar, because a bar frozen at zero reads as a stalled transfer.
 */
export interface ToolRowProgress {
	/** 0–1 fill, or null for an indeterminate/animated bar. */
	ratio: number | null;
	/** Whole percent shown beside the bar; omitted when indeterminate. */
	percent?: number;
	/**
	 * Figures shown under the bar, already formatted ("20.1 MB / 48.0 MB",
	 * "2.1 MB/s", "ETA 13s"). Pre-formatted because unit choice belongs to the
	 * producer, and this layer has no i18n access.
	 */
	figures?: string[];
	/** Mantine colour for the bar. Height-neutral. */
	color?: string;
	/** True while work continues — drives the animated stripes. Height-neutral. */
	active?: boolean;
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
	/** A determinate progress bar on this row (a running transfer). */
	progress?: ToolRowProgress;
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
	/** Semantic identity, never a path, label, array slot or text revision. */
	key: string;
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

export type ToolDetailData = ToolSectionsDetail;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (mirrored in frontend/components/narrator/tool-call/tool-display.ts — keep
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

// ─────────────────────────────────────────────────────────────────────────────
// `+N -N` line statistics for a file tool's header / folded row.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * File tools whose header can carry a `+N -N` figure.
 *
 * StructSed belongs here for the same reason Edit does: it rewrites part of a file and
 * the server measures both sides at execution time, so the count comes from the
 * authoritative metadata path below. Leaving it out made a structural rewrite read as a
 * lesser kind of step than the equivalent Edit while folded, despite changing the file
 * just as much.
 */
const DIFF_STATS_TOOLS = new Set(["Write", "Edit", "StructSed"]);

/**
 * Added / removed line counts for a Write or Edit, or undefined when unknown.
 *
 * Two sources, in this order:
 *
 *  1. `metadata.linesAdded` / `linesRemoved`, written by the TOOL at execution
 *     time. Authoritative: only the server holds both complete sides.
 *  2. A local diff of `old_string` vs `new_string` — **Edit only**, and only when
 *     neither side was truncated.
 *
 * ⚠️ A WRITE WITHOUT METADATA RESOLVES TO UNDEFINED, and must. Its input carries
 * only `content`; the file's previous state is never sent. A local computation
 * could therefore only ever conclude "every line is new", which would render a
 * rewrite that changed 3 lines as `+240 -0`. The client also cannot tell whether
 * that Write created the file or replaced one, so there is no safe reading of the
 * absence either. Every Write persisted before this feature existed falls here, so
 * this is the common path, not an edge case.
 *
 * Truncated Edit payloads resolve to undefined for the same reason: an 8KB prefix
 * of a longer string yields a smaller count with nothing marking it as partial.
 * Showing no figure is recoverable; showing a wrong one is not.
 */
export function resolveFileDiffStats(
	toolName: string,
	inputJson: unknown,
	metadata: Record<string, unknown> | null | undefined,
): DiffLineStats | undefined {
	if (!DIFF_STATS_TOOLS.has(toolName)) return undefined;
	const fromMetadata = readLineStatsMetadata(metadata);
	// `!== undefined`, not a truthy test. A measured `{added: 0, removed: 0}` is a real
	// answer — the file was rewritten with identical content — and this whole module
	// rests on absent meaning "unknown" rather than "no change". The truthy form
	// happens to work because objects are truthy, which makes it correct by accident
	// in the one place the distinction matters most.
	if (fromMetadata !== undefined) return fromMetadata;
	// Local fallback: Edit only (see the warning above).
	if (toolName !== "Edit") return undefined;
	const input = asObject(inputJson);
	if (!input) return undefined;
	// The overwrite mode (`old_string: ""`) is a whole-file replacement, so it has
	// the same missing-baseline problem a Write does.
	if (!("old_string" in input) || !("new_string" in input)) return undefined;
	if (hasTruncatedLeaf(input.old_string) || hasTruncatedLeaf(input.new_string)) return undefined;
	const oldStr = readLeafText(input.old_string);
	const newStr = readLeafText(input.new_string);
	if (oldStr === undefined || newStr === undefined || oldStr === "") return undefined;
	return countDiffLineStats(oldStr, newStr) ?? undefined;
}

/** Read the tool-written `linesAdded` / `linesRemoved` pair, when both are present. */
function readLineStatsMetadata(
	metadata: Record<string, unknown> | null | undefined,
): DiffLineStats | undefined {
	if (!metadata) return undefined;
	const added = metadata.linesAdded;
	const removed = metadata.linesRemoved;
	// BOTH must be present and finite. A half-written pair would silently read the
	// missing half as zero, understating one direction of the change.
	if (typeof added !== "number" || typeof removed !== "number") return undefined;
	if (!Number.isFinite(added) || !Number.isFinite(removed)) return undefined;
	if (added < 0 || removed < 0) return undefined;
	return { added, removed };
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

export type ClassifyToolDetailInput = ClassifyToolDetailFields &
	({ toolUseId: string; previewId?: never } | { previewId: string; toolUseId?: never });

interface ClassifyToolDetailFields {
	/** Explicit producer-supplied attempt identity; never inferred from a viewport index. */
	occurrence?: string | number;
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
	 * The reviewer's note on a permission decision
	 * (`narrator_tool_calls.permissionDenyMessage`).
	 *
	 * A TOP-LEVEL tool-call column rather than a `_metadata` key, hence its own
	 * field: a denied ExitPlanMode shows this text above the plan body, and reading
	 * it from metadata alone lost every real denial (the user's typed reason simply
	 * did not appear).
	 *
	 * Despite the column name it is NOT denial-only: `narrator-permission.ts` also
	 * stores the feedback typed alongside an APPROVAL there. Consumers must gate on
	 * a failed status before presenting it as a rejection.
	 */
	denyMessage?: string | null;
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

/** Trim a possibly-null string; undefined when absent or blank. */
function nonEmptyTrimmedText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim() || undefined;
}

/** True when the status indicates a failed tool call. */
function isFailStatus(status?: string | null): boolean {
	return status === "fail" || status === "error";
}

/**
 * Classify a tool call into a `ToolDetailData` (or null when there's no
 * meaningful detail body). `category` is the already-resolved ToolCategory
 * string (read|file|bash|search|webSearch|webFetch|tasks|taskOutput|agent|
 * await|send|ask|plan|pipeline|terminal|share|transfer|recall|skill|browser|
 * knowledge|generic).
 */
export function classifyToolDetail(input: ClassifyToolDetailInput): ToolDetailData | null {
	const { toolName, category, status } = input;
	const metadata = asObject(input.metadata);
	const fields =
		asObject(input.inputJson) && !Array.isArray(input.inputJson) && !isTruncated(input.inputJson)
			? toolInputFieldView(input.inputJson)
			: input.inputJson;
	const output = toolOutputValue(input.outputJson, metadata);
	const base = withErrorSection(
		classifyByCategory(toolName, category, status, fields, output, metadata, input),
		input.errorMessage,
		input.outputJson,
	);
	if (!base) return null;
	return {
		kind: "sections",
		sections: base.sections.map((part) => ({
			...part,
			body: part.body.kind === "capped" ? describeToolBody(part.body, input) : part.body,
		})),
	};
}

/** Resolve each field once: current delta > settled stream fields > formal input. */
export function toolInputFieldView(value: unknown): Record<string, unknown> {
	const input = asObject(value) ?? {};
	const settled = asObject(input._streamingFields) ?? {};
	const fields: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(input)) {
		if (!key.startsWith("_streaming")) fields[key] = field;
	}
	Object.assign(fields, settled);
	const name = readLeafText(input._streamingFieldName);
	if (name !== undefined && Object.hasOwn(input, "_streamingFieldValue")) {
		fields[name] = input._streamingFieldValue;
	}
	if (!Object.hasOwn(fields, "file_path") && Object.hasOwn(input, "_streamingFilePath")) {
		fields.file_path = input._streamingFilePath;
	}
	return fields;
}

/** An explicit empty output supersedes an old streaming snapshot. */
export function toolOutputValue(output: unknown, metadata: unknown): unknown {
	return output ?? asObject(metadata)?._streamingOutput;
}

export function toolBodyId(
	callIdentity: string,
	source: ToolBodySource,
	occurrence?: string | number,
): string {
	return JSON.stringify(
		occurrence === undefined ? [callIdentity, source] : [callIdentity, source, occurrence],
	);
}

/** Canonical lifecycle descriptor shared with the real subagent-card adapter. */
export function describeToolBody(
	body: ToolCappedDetail,
	input: ClassifyToolDetailInput,
): ToolCappedDetail {
	const rawInput = asObject(input.inputJson);
	const metadata = asObject(input.metadata);
	const field = body.source.slice("input.".length);
	const currentField = readLeafText(rawInput?._streamingFieldName);
	const inputLive = !isTerminalToolStatus(input.status) && input.isStreaming === true;
	const live = body.source.startsWith("input.")
		? inputLive &&
			(field === "arguments" ||
				currentField === undefined ||
				(field === "edit"
					? currentField === "old_string" || currentField === "new_string"
					: currentField === field))
		: !isTerminalToolStatus(input.status) && !inputLive && metadata?._streamingOutput != null;
	const range = body.source.startsWith("input.")
		? asObject(rawInput?._streamingFieldRanges)?.[field]
		: metadata?._streamingOutputRange;
	return {
		...body,
		id: toolBodyId(input.toolUseId ?? `preview:${input.previewId}`, body.source, input.occurrence),
		live: body.format !== "media" && live,
		...(isSourceTextRange(range) ? { range } : {}),
		...(body.diffDocument
			? {
					revision: body.diffDocument.revision,
					followTarget: { kind: "diff-row", focus: body.diffDocument.focus } as const,
				}
			: {}),
	};
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
			return classifyFile(toolName, inputJson, metadata, input);
		case "tasks":
			return classifyTasks(toolName, inputJson, outputJson, metadata, input);
		case "bash":
			return classifyBash(
				status,
				inputJson,
				outputJson,
				metadata,
				input.isStreaming === true,
				input.labels,
			);
		case "search":
			return classifySearch(status, inputJson, outputJson);
		case "structure":
			return classifyStructure(status, inputJson, outputJson, metadata);
		case "structureEdit":
			return classifyStructureEdit(status, inputJson, outputJson, metadata);
		case "webSearch":
			return classifyWebSearch(inputJson, outputJson);
		case "webFetch":
			return classifyWebFetch(status, inputJson, outputJson, metadata);
		case "taskOutput":
			return classifyTaskOutput(inputJson, outputJson);
		case "agent": {
			const prompt = readLeafText(asObject(inputJson)?.prompt) ?? readLeafText(inputJson);
			if (prompt === undefined) return classifyGeneric(inputJson, outputJson);
			return sections([
				textSection("input.prompt", asObject(inputJson)?.prompt ?? inputJson, "input", {
					text: prompt,
					format: "markdown",
				}),
				textSection("output.main", outputJson, "result", {
					format: "markdown",
				}),
			]);
		}
		case "await":
			return classifyAwait(inputJson, outputJson, metadata);
		case "send":
			return classifySend(inputJson, outputJson, metadata, input.labels, status);
		case "ask":
			return classifyAsk(inputJson, input.hasPendingPermission === true, input.labels);
		case "plan":
			// Only a FAILED call's deny message is denial feedback. The same column
			// carries the note typed alongside an APPROVAL, which reads as a rejection
			// of an accepted plan if forwarded (see classifyPlan).
			return classifyPlan(
				inputJson,
				metadata,
				isFailStatus(status) ? nonEmptyTrimmedText(input.denyMessage) : undefined,
			);
		case "pipeline":
			return classifyPipeline(toolName, inputJson, outputJson, metadata);
		case "terminal":
			return classifyTerminal(status, inputJson, outputJson);
		case "share":
			return classifyShare(inputJson, outputJson, metadata);
		case "transfer":
			return classifyTransfer(status, inputJson, input.outputJson, metadata, input.errorMessage);
		case "recall":
			return classifyRecall(inputJson, outputJson, metadata);
		case "skill":
			return classifySkill(inputJson, outputJson);
		case "browser":
			return classifyBrowser(status, inputJson, outputJson, metadata);
		case "knowledge":
			return classifyKnowledge(toolName, inputJson, outputJson, metadata);
		case "contextAsk":
			return classifyContextAsk(inputJson, outputJson, metadata, status);
		default:
			return classifyGeneric(inputJson, outputJson);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Section / meta-row builders.
// ─────────────────────────────────────────────────────────────────────────────

/** Every detail, including one unlabelled body, has the same production shape. */
function sections(list: Array<ToolDetailSection | null>): ToolDetailData | null {
	const kept = list.filter((s): s is ToolDetailSection => s !== null);
	return kept.length > 0 ? { kind: "sections", sections: kept } : null;
}

function section(
	key: string,
	label: ToolSectionLabel | undefined,
	body: ToolSectionBody | null,
): ToolDetailSection | null {
	if (body === null) return null;
	return { key, ...(label === undefined ? {} : { label }), body };
}

function single(key: string, body: ToolSectionBody): ToolDetailData {
	return { kind: "sections", sections: [{ key, body }] };
}

/** A meta-rows body from the non-empty rows, or null when nothing remains. */
function metaRows(rows: Array<ToolMetaRow | null>): ToolMetaRowsDetail | null {
	const kept = rows.filter(
		(r): r is ToolMetaRow =>
			r !== null &&
			(r.text.length > 0 ||
				(r.badges?.length ?? 0) > 0 ||
				(r.actions?.length ?? 0) > 0 ||
				r.progress != null),
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
	if (base?.sections.some((part) => part.body.kind === "error")) return base;
	// The chunked cards hide the error line once a real output body exists.
	if (outputJson != null && base !== null) return base;
	const errorSection: ToolDetailSection = {
		key: "meta.error",
		label: "error",
		body: { kind: "error", text },
	};
	return { kind: "sections", sections: [...(base?.sections ?? []), errorSection] };
}

type CappedOptions = Omit<
	ToolCappedDetail,
	"kind" | "cap" | "id" | "source" | "live" | "followTarget" | "format"
> &
	Partial<Pick<ToolCappedDetail, "format" | "followTarget">>;

/** Source is mandatory; neither format nor lifecycle is inferred from cap/labels. */
function capped(
	source: ToolBodySource,
	cap: DetailCapKind,
	extras: CappedOptions = {},
): ToolCappedDetail {
	return {
		kind: "capped",
		id: source,
		source,
		cap,
		format: "text",
		live: false,
		followTarget: { kind: "end" },
		...extras,
	};
}

/** One text-section constructor; absence, empty text and truncation keep their own meanings. */
function textSection(
	source: ToolBodySource,
	value: unknown,
	label?: ToolSectionLabel,
	{ cap = "code", ...extras }: CappedOptions & { cap?: DetailCapKind } = {},
): ToolDetailSection | null {
	if (value == null) return null;
	return section(
		source,
		label,
		capped(source, cap, {
			text: extras.text ?? resolveDisplayText(value),
			...truncatedFlag(value),
			...extras,
		}),
	);
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

function classifyGeneric(inputJson: unknown, outputJson: unknown): ToolDetailData {
	const input = resolveDisplayBody(inputJson);
	const output = outputJson != null ? resolveDisplayBody(outputJson) : undefined;
	const list: ToolDetailSection[] = [
		{
			key: "input.arguments",
			label: "input",
			body: capped("input.arguments", "code", {
				text: input.text,
				format: "code",
				codeLang: "json",
				textTruncated: input.truncated,
			}),
		},
	];
	if (output)
		list.push({
			key: "output.main",
			label: "output",
			body: capped("output.main", "code", {
				text: output.text,
				textTruncated: output.truncated,
			}),
		});
	return { kind: "sections", sections: list };
}

/** The read/write file path (mirrors the chunked `getFilePath`). */
function filePathOf(inputJson: unknown): string {
	return extractField(inputJson, "file_path", "path", "filePath");
}

/** Read a positive finite pixel count from an untrusted metadata leaf. */
function readPixelCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Intrinsic image dimensions from tool metadata, when both are present. */
function mediaDimensions(metadata: Record<string, unknown> | null): {
	width?: number;
	height?: number;
} {
	const width = readPixelCount(metadata?.width);
	const height = readPixelCount(metadata?.height);
	return width !== undefined && height !== undefined ? { width, height } : {};
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
			section("meta.file", undefined, metaRows([pathRow(filePath ? `${filePath}${suffix}` : "")])),
			section(
				"output.main",
				undefined,
				capped("output.main", "media", {
					format: "media",
					contentPx: MEDIA_IMAGE_CONTENT_PX,
					media: {
						filePath,
						filename: filePath ? filePath.split(/[\\/]/).pop() : undefined,
						sizeKB,
						imageFormat,
						...mediaDimensions(metadata),
					},
				}),
			),
		]);
	}
	const text = resolveDisplayText(outputJson);
	const body =
		outputJson != null
			? capped("output.main", "code", {
					contentLines: countLines(text),
					text: text || undefined,
					...truncatedFlag(outputJson),
					// Parity with the chunked ReadDetail: `language={getShikiLang(fp)}`.
					...(fp ? { codeLangPath: fp } : {}),
				})
			: null;
	return sections([
		section("meta.file", undefined, metaRows([pathRow(fp)])),
		section("output.main", undefined, body),
	]);
}

/** Legacy snapshots without stream metadata have no append-continuity evidence. */
function untrackedSnapshotRevision(text: string): string {
	const retained = normalizeSourceText(text.slice(-MAX_DIFF_INPUT_CHARS));
	let hash = 0x811c9dc5;
	for (let i = 0; i < retained.length; i++)
		hash = Math.imul(hash ^ retained.charCodeAt(i), 0x01000193);
	return `${text.length}:${hash >>> 0}`;
}

/**
 * A projected string leaf is the HEAD of that field, not a new source version.
 * Existing stream coordinates outrank that default: a projected tail window is
 * still a tail window, and an unknown origin must remain unknown until verified.
 */
export function toolInputFieldRange(
	input: ClassifyToolDetailInput,
	field: string,
): SourceTextRange | undefined {
	const value = toolInputFieldView(input.inputJson)[field];
	const text = readLeafText(value);
	if (text === undefined) return undefined;
	const candidate = asObject(asObject(input.inputJson)?._streamingFieldRanges)?.[field];
	const range = isSourceTextRange(candidate) ? candidate : undefined;
	const truncated = isTruncated(value);
	if (range && !truncated) return range;
	const live = input.isStreaming === true && !isTerminalToolStatus(input.status);
	const sourceId = toolBodyId(
		input.toolUseId ?? `preview:${input.previewId}`,
		`input.${field}`,
		input.occurrence,
	);
	const observed = createSourceText(text, {
		epoch:
			range?.epoch ??
			(live ? `untracked:${sourceId}:${untrackedSnapshotRevision(text)}` : `source:${sourceId}`),
		originKnown: range?.originKnown ?? !live,
		complete: !live && !truncated,
		streaming: live && !truncated,
	}).range;
	if (!range) return observed;
	// The server cut the field at its beginning. Preserve that beginning's source
	// coordinates, while limiting the end to the prefix we actually received.
	return {
		...range,
		complete: false,
		streaming: false,
		endsWithCR: observed.endsWithCR,
		endOffset: range.startOffset + observed.endOffset,
		endLine: range.startLine + observed.endLine,
		endColumn: observed.endLine === 0 ? range.startColumn + observed.endColumn : observed.endColumn,
	};
}

function classifyFile(
	toolName: string,
	inputJson: unknown,
	metadata: Record<string, unknown> | null,
	context: ClassifyToolDetailInput,
): ToolDetailData | null {
	const fields = asObject(inputJson) ?? {};
	const fp = filePathOf(fields);
	const inputLive = context.isStreaming === true && !isTerminalToolStatus(context.status);
	if (toolName === "Edit") {
		if (!("old_string" in fields) && !("new_string" in fields)) {
			return sections([section("meta.file", undefined, metaRows([pathRow(fp)]))]);
		}
		const oldText = readLeafText(fields.old_string) ?? "";
		const replacing = Object.hasOwn(fields, "new_string") || !inputLive;
		const newText = replacing ? (readLeafText(fields.new_string) ?? "") : oldText;
		const oldRange = toolInputFieldRange(context, "old_string");
		const newRange = replacing ? toolInputFieldRange(context, "new_string") : oldRange;
		const startLine = readStartLine(context.inputJson, metadata);
		const diffDocument = createDiffDocument({
			oldText,
			newText,
			oldRange,
			newRange,
			startLine,
			focusSide: replacing && newText.length > 0 ? "new" : "old",
		});
		return sections([
			section(
				"meta.file",
				undefined,
				metaRows([pathRow(fp && startLine != null ? `${fp}:${startLine}` : fp)]),
			),
			textSection("input.edit", fields, undefined, {
				cap: "diff",
				format: "diff",
				diffDocument,
				revision: diffDocument.revision,
				text: JSON.stringify(
					{
						old_string: diffDocument.oldSource.text,
						...(replacing ? { new_string: diffDocument.newSource.text } : {}),
					},
					null,
					2,
				),
				followTarget: { kind: "diff-row", focus: diffDocument.focus },
				textTruncated:
					hasTruncatedLeaf(fields.old_string) ||
					hasTruncatedLeaf(fields.new_string) ||
					diffDocument.truncated,
				...(fp ? { codeLangPath: fp } : {}),
			}),
		]);
	}
	const text = readLeafText(fields.content);
	return sections([
		section("meta.file", undefined, metaRows([pathRow(fp)])),
		textSection("input.content", text === undefined ? undefined : fields.content, "input", {
			cap: inputLive ? "streaming" : "code",
			text,
			format: "code",
			...(fp ? { codeLangPath: fp } : {}),
		}),
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
	input: ClassifyToolDetailInput,
): ToolDetailData | null {
	const tasks = extractSpecTasks(inputJson, outputJson, metadata);
	if (tasks === null) {
		// Not parseable → fall back to the file diff/code branch.
		return classifyFile(toolName, inputJson, metadata, input);
	}
	return single("input.tasks", {
		kind: "spec-tasks",
		tasks: tasks.map((task) => ({
			text: task.text ?? "—",
			status: readLeafText(task.status),
			protected: task.protected === true,
		})),
	});
}

function classifyBash(
	status: string | null | undefined,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
	inputStreaming: boolean,
	labels?: Record<string, string>,
): ToolDetailData | null {
	const awaitParam = isTruncated(inputJson) ? undefined : asObject(inputJson)?.await;
	const awaitObj =
		awaitParam != null && typeof awaitParam === "object" ? asObject(awaitParam) : null;
	const commandStr = awaitObj ? "" : extractField(inputJson, "command");
	const outputStr = resolveDisplayText(outputJson);
	const hasCommand = !awaitObj && Object.hasOwn(asObject(inputJson) ?? {}, "command");
	if (!hasCommand && outputJson == null && !awaitObj) return null;
	const streaming = !isTerminalToolStatus(status) && metadata?._streamingOutput != null;

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
	// Only launch receipts are protocol; never filter arbitrary shell stdout.
	const backgroundTaskId =
		!isFailStatus(status) && asObject(inputJson)?.run_in_background === true
			? readBackgroundTaskId(outputStr)
			: undefined;
	const body = backgroundTaskId ? "" : outputStr;
	return sections([
		section("meta.await", undefined, metaRows([awaitRow])),
		section(
			"meta.background",
			undefined,
			backgroundTaskId
				? metaRows([
						badgeRow(
							chips([chip(backgroundTaskId, "blue")]),
							labels?.backgroundTaskStarted ??
								"Started in the background; see Background tasks for progress.",
						),
					])
				: null,
		),
		textSection(
			"input.command",
			hasCommand ? (asObject(inputJson)?.command ?? "") : undefined,
			"command",
			{
				cap: inputStreaming && !isTerminalToolStatus(status) ? "streaming-bash" : "bash-cmd",
				contentLines: countLines(commandStr),
				text: `$ ${commandStr}`,
				// Shell syntax for the command box. The OUTPUT box below stays
				// unhighlighted: it is program output, not source (the chunked card
				// likewise passes no language for it).
				format: "code",
				codeLang: "shellscript",
			},
		),
		textSection("output.main", backgroundTaskId ? null : outputJson, "output", {
			cap: streaming ? "streaming-bash" : "term",
			contentLines: countLines(body),
			text: body,
		}),
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
		return single("meta.error", {
			kind: "error",
			text: extractField(inputJson, "pattern", "glob") || "Search failed",
		});
	}
	// The chunked card leads with the pattern chip and an `in <path>` line.
	const pattern = extractField(inputJson, "pattern", "glob");
	const searchPath = extractField(inputJson, "path");
	return sections([
		section(
			"meta.query",
			undefined,
			metaRows([
				pattern ? { text: pattern, mono: true } : null,
				searchPath ? { text: `in ${searchPath}`, dimmed: true } : null,
			]),
		),
		textSection("output.main", outputJson, "output", {
			contentLines: countLines(output),
			text: output,
		}),
	]);
}

/** Chip colour per StructView mode, grouped by what the mode is for. */
const STRUCTURE_MODE_COLORS: Record<string, string> = {
	// Reading structure.
	outline: "indigo",
	api: "indigo",
	extract: "indigo",
	imports: "indigo",
	enclosing: "indigo",
	tree: "indigo",
	// Analysing it.
	report: "teal",
	refs: "teal",
	calls: "teal",
	// Raw text, no parsing involved.
	print: "gray",
};

/**
 * Body height cap per StructView mode.
 *
 * The cap is the scroll box's MAX height, so it should match how long a mode's output
 * typically is. Everything used to share `code` (200px, ~13 lines), which put a 68-line
 * report and a 330-line outline into the same small window — defeating the point of
 * `report`, whose whole value is seeing five sections at once.
 *
 * Only the existing cap tiers are reused; adding a per-tool tier would turn
 * `DETAIL_CAPS` into a registry.
 */
const STRUCTURE_MODE_CAPS: Record<string, DetailCapKind> = {
	// Pinpoint lookups: short by construction.
	extract: "code",
	print: "code",
	enclosing: "code",
	imports: "code",
	// Listings: routinely dozens to hundreds of lines. 300px rather than 400 because
	// past a certain point a taller box only costs screen without showing the end.
	outline: "agent-result",
	api: "agent-result",
	refs: "agent-result",
	calls: "agent-result",
	tree: "agent-result",
	// The one mode designed to be read in full.
	report: "knowledge",
};

/**
 * Modes whose body is real source of the target file, so a LANGUAGE grammar applies.
 *
 * Only these two. The `   109│` line-number prefix does not disturb highlighting —
 * verified against the real tokenizer, the remaining tokens come out identical to the
 * un-prefixed text, with `109` merely coloured as a numeric literal, the same thing
 * `Read` already does.
 *
 * Every other mode emits a structured report and goes to the bespoke tokenizer instead.
 * An earlier version sent the table-shaped modes here on the grounds that their rows
 * contain real signature fragments; that held for the simplest row and broke on the rest
 * (`variable flat` uncoloured while `refs` was coloured, `exported` painted as a function
 * name, `L13-27` split on the hyphen).
 */
const STRUCTURE_SOURCE_MODES = new Set(["extract", "print"]);

/** Counts that are meaningful per mode, so a card only shows what its mode produced. */
const STRUCTURE_MODE_COUNTS: Record<string, ReadonlyArray<[string, string]>> = {
	outline: [["declarations", "decl"]],
	api: [["exports", "exports"]],
	imports: [
		["imports", "imports"],
		["exports", "exports"],
	],
	tree: [["elements", "elements"]],
	refs: [
		["declarations", "decl"],
		["singleReference", "refs:1"],
	],
	calls: [["distinctCalls", "callees"]],
	print: [
		["blocks", "blocks"],
		["printedLines", "lines"],
		["totalLines", "of"],
	],
	report: [["declarations", "decl"]],
	extract: [],
	enclosing: [],
};

/**
 * StructView's detail card.
 *
 * Separate from `classifySearch` because the two share no input fields: routing
 * StructView through the search classifier made it read `pattern`/`glob`/`path`, find
 * nothing, and drop its entire header — leaving a bare wall of output with no
 * indication of which file or mode produced it.
 *
 * The counts rendered here all come from metadata the tool already emits, so this adds
 * no server work.
 */
function classifyStructure(
	status: string | null | undefined,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const filePath = filePathOf(inputJson);
	// Absent mode means the tool's default, matching getSummary so the card and the
	// collapsed row cannot disagree while arguments are still streaming.
	const mode = extractField(inputJson, "mode") || "outline";
	const output = resolveDisplayText(outputJson);

	// Three chip colour groups, so one glance separates "which mode" from "with what
	// argument" from "how big the result". Arguments previously split across gray and
	// cyan, which collided with the mode chip and the count chips respectively.
	const detailChips = chips([
		chip(mode, STRUCTURE_MODE_COLORS[mode] ?? "indigo"),
		chip(extractField(inputJson, "symbol"), "grape"),
		chip(extractField(inputJson, "address"), "grape"),
		chip(extractField(inputJson, "position"), "grape"),
		chip(extractField(inputJson, "kind"), "grape"),
		chip(extractField(inputJson, "filter"), "grape"),
		// A degraded result means heuristics, not parsing. That qualifier has to be
		// visible on the card itself — burying it in a trailing note inside the output
		// is how an approximate answer gets read as an exact one.
		metadata?.support === "degraded" ? chip("approximate", "yellow") : null,
		// Several matches means the tool listed candidates instead of extracting one.
		metadata?.ambiguous === true ? chip("ambiguous", "orange") : null,
	]);

	// Only the counts this mode actually produces. Previously every numeric metadata key
	// was tried and zero/absent ones filtered out, which worked but stated no intent —
	// a `print` card would have shown a declaration count if one ever leaked in.
	const statChips = chips(
		(STRUCTURE_MODE_COUNTS[mode] ?? []).map(([key, label]) => countChip(metadata, key, label)),
	);

	// Show the RESULT'S precision, not the parser's internal id. `provider` is "tree-sitter"
	// / "heuristic" — an implementation detail the reader does not need and should not have
	// to decode. `precision` ("exact" / "approximate") is the thing that changes how far to
	// trust the card. Older records without `precision` fall back to the provider string.
	const precisionLabel = nonEmptyString(metadata?.precision) ?? nonEmptyString(metadata?.provider);
	const languageLabel = nonEmptyString(metadata?.languageId);

	// Header first, even on failure: `classifySearch` dropped it entirely when a call
	// failed, which removed the only clue about what had been attempted.
	const headerSection = section(
		"meta.target",
		undefined,
		metaRows([
			pathRow(filePath, { dimmed: false }),
			badgeRow(detailChips),
			statChips.length > 0 ? badgeRow(statChips) : null,
			languageLabel || precisionLabel
				? {
						text: [languageLabel, precisionLabel].filter(Boolean).join(" · "),
						dimmed: true,
					}
				: null,
		]),
	);

	if (isFailStatus(status) && !output) {
		return sections([
			headerSection,
			section("meta.error", undefined, {
				kind: "error",
				text: filePath ? `StructView failed on ${filePath}` : "StructView failed",
			}),
		]);
	}

	// Two highlighting routes, never both: real source gets a language grammar, reports get
	// the tokenizer written for their own grammar.
	const isSource = STRUCTURE_SOURCE_MODES.has(mode);

	return sections([
		headerSection,
		// `format: "code"` throughout: every mode's output is column-aligned, and prose
		// reflowing would destroy the alignment that makes it readable. Highlighting is
		// render-only and height-neutral (it colours characters inside the same box), so
		// neither route affects the cap or the measured height.
		textSection("output.main", outputJson, "output", {
			cap: STRUCTURE_MODE_CAPS[mode] ?? "code",
			contentLines: countLines(output),
			text: output,
			format: "code" as const,
			// The PATH, not a resolved language id: this layer is purity-guarded and cannot
			// import the frontend's `getShikiLang`.
			...(isSource && filePath ? { codeLangPath: filePath } : {}),
			...(isSource ? {} : { customHighlight: "struct-view" as const }),
		}),
	]);
}

/** Chip colour per StructSed command, split by whether the command removes content. */
const STRUCTURE_EDIT_COMMAND_COLORS: Record<string, string> = {
	// Rewrites in place.
	replace: "violet",
	substitute: "violet",
	// Adds without removing — the safest shapes, so they read differently.
	insert: "teal",
	append: "teal",
	// Removal is the one command with no recoverable content in its own input.
	delete: "red",
};

/**
 * StructSed's detail card.
 *
 * Separate from `classifyStructure` because the inputs do not line up: StructSed carries
 * `command`, not `mode`, so reusing that classifier would label every call "outline" — a
 * delete would present as a read.
 *
 * The body is the tool's own report (a dry-run preview, or the applied summary), which is
 * line-numbered and column-aligned, so it takes the same bespoke tokenizer as StructView's
 * reports rather than a language grammar.
 */
function classifyStructureEdit(
	status: string | null | undefined,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const filePath = filePathOf(inputJson);
	const command = extractField(inputJson, "command");
	const output = resolveDisplayText(outputJson);

	// Whichever address form was used; the tool rejects both at once, so at most one shows.
	const symbol = extractField(inputJson, "symbol");
	const address = extractField(inputJson, "address");

	const detailChips = chips([
		chip(command, command ? (STRUCTURE_EDIT_COMMAND_COLORS[command] ?? "violet") : "violet"),
		chip(symbol, "grape"),
		chip(address, "grape"),
		chip(extractField(inputJson, "kind"), "grape"),
		// A preview did not touch the file. That has to be visible on the card: reading an
		// applied edit as a preview (or the reverse) misstates whether the work happened.
		metadata?.dryRun === true ? chip("dry run", "yellow") : null,
	]);

	const statChips = chips([
		countChip(metadata, "replacements", "replaced"),
		lineRangeChip(metadata),
	]);

	const headerSection = section(
		"meta.target",
		undefined,
		metaRows([
			pathRow(filePath, { dimmed: false }),
			badgeRow(detailChips),
			statChips.length > 0 ? badgeRow(statChips) : null,
		]),
	);

	// Header first even on failure, so a failed call still shows what was attempted.
	if (isFailStatus(status) && !output) {
		return sections([
			headerSection,
			section("meta.error", undefined, {
				kind: "error",
				text: filePath ? `StructSed failed on ${filePath}` : "StructSed failed",
			}),
		]);
	}

	// A preview and an applied edit BOTH render diffs — visually identical red/green rows.
	// A dry run therefore leads with an explicit "not written" banner so the diff is not
	// mistaken for a completed change; the applied edit has no banner.
	const dryRunNotice =
		metadata?.dryRun === true
			? section("output.notice", undefined, {
					kind: "error" as const,
					// Yellow, not red: this is a notice, not a failure.
					tone: "warning" as const,
					text: "Preview only — nothing was written. Re-run with dry_run: false to apply.",
				})
			: null;

	// One diff per changed region. Rendering them as real diffs — the widget Edit uses —
	// shows which lines move at a glance, where the struct-view tokenizer (built for the
	// report's line-numbered syntax) would leave the source unhighlighted.
	const hunks = readDiffHunks(metadata);
	if (hunks.length > 0) {
		const omitted = typeof metadata?.diffOmittedHunks === "number" ? metadata.diffOmittedHunks : 0;
		return sections([
			headerSection,
			dryRunNotice,
			...hunks.map((hunk, index) =>
				diffHunkSection(hunk, index, hunks.length, outputJson, output, filePath),
			),
			omitted > 0
				? section("output.omitted", undefined, {
						kind: "error" as const,
						tone: "warning" as const,
						text: `${omitted} more changed region${omitted === 1 ? "" : "s"} not shown.`,
					})
				: null,
		]);
	}

	return sections([
		headerSection,
		textSection("output.main", outputJson, "output", {
			// A dry run prints before AND after, so it needs more room than a one-line
			// applied summary; the taller cap covers the case that actually has content.
			cap: metadata?.dryRun === true ? "agent-result" : "code",
			contentLines: countLines(output),
			text: output,
			format: "code" as const,
			customHighlight: "struct-view" as const,
		}),
	]);
}

/** One changed region of a StructSed diff, as the card reads it from metadata. */
interface StructureEditHunk {
	oldText: string;
	newText: string;
	oldStart?: number;
	newStart?: number;
	/** The server cut the hunk, or the transport projected a side into a truncated leaf. */
	cut: boolean;
}

/**
 * Every hunk the metadata carries, in either shape.
 *
 * `diffHunks` is current. `diffBefore`/`diffAfter`/`diffStartLine` is the retired single
 * window that persisted records still hold; it reads as one hunk with a shared origin.
 *
 * Every text is read through `readLeafText`, never `typeof === "string"`: the server
 * projects tool I/O field by field, so a long side arrives as a `{_truncated, preview}`
 * leaf. A string check read that as "no diff", fell back to the one-line summary, and the
 * truncated payload still reserved the full cap — an applied edit rendered as an empty box.
 */
function readDiffHunks(metadata: Record<string, unknown> | null): StructureEditHunk[] {
	const list = metadata?.diffHunks;
	// Empty array must fall through to the retired single-window fields: a writer that
	// emits `diffHunks: []` while still carrying `diffBefore`/`diffAfter` (or a projection
	// that strips every unreadable entry) would otherwise hide a diff that is present.
	if (Array.isArray(list) && list.length > 0) {
		const hunks: StructureEditHunk[] = [];
		for (const entry of list) {
			const hunk = asObject(entry);
			const oldText = readLeafText(hunk?.oldText);
			const newText = readLeafText(hunk?.newText);
			if (!hunk || oldText === undefined || newText === undefined) continue;
			hunks.push({
				oldText,
				newText,
				...(typeof hunk.oldStart === "number" ? { oldStart: hunk.oldStart } : {}),
				...(typeof hunk.newStart === "number" ? { newStart: hunk.newStart } : {}),
				cut:
					hunk.truncated === true ||
					hasTruncatedLeaf(hunk.oldText) ||
					hasTruncatedLeaf(hunk.newText),
			});
		}
		if (hunks.length > 0) return hunks;
		// Every entry was unreadable after truncation — also try the legacy fields.
	}
	const oldText = readLeafText(metadata?.diffBefore);
	const newText = readLeafText(metadata?.diffAfter);
	if (oldText === undefined || newText === undefined) return [];
	const start = typeof metadata?.diffStartLine === "number" ? metadata.diffStartLine : undefined;
	return [
		{
			oldText,
			newText,
			...(start !== undefined ? { oldStart: start, newStart: start } : {}),
			cut: hasTruncatedLeaf(metadata?.diffBefore) || hasTruncatedLeaf(metadata?.diffAfter),
		},
	];
}

/**
 * One hunk as its own diff body.
 *
 * The first hunk keeps the `output.main` source so the result slot (fullscreen viewer,
 * copy, the reader's payload fetch) still resolves to the tool's primary body; the rest
 * get `output.hunk.N`. Each is a separate section so each sizes to its own rows under
 * the shared diff cap instead of one box sized for the distance between edits.
 */
function diffHunkSection(
	hunk: StructureEditHunk,
	index: number,
	total: number,
	outputJson: unknown,
	output: string,
	filePath: string | undefined,
): ToolDetailSection | null {
	const diffDocument = createDiffDocument({
		oldText: hunk.oldText,
		newText: hunk.newText,
		focusSide: "new",
		...(hunk.oldStart !== undefined ? { startLine: hunk.oldStart } : {}),
		...(hunk.newStart !== undefined ? { newStartLine: hunk.newStart } : {}),
	});
	const source: ToolBodySource = index === 0 ? "output.main" : `output.hunk.${index}`;
	return textSection(source, outputJson, index === 0 ? "output" : undefined, {
		cap: "diff",
		format: "diff",
		diffDocument,
		revision: diffDocument.revision,
		// The body's copy/fullscreen text. The tool's summary line belongs to the first hunk
		// only; later hunks carry their own new side so copying one yields that region.
		text: index === 0 && total === 1 ? output : hunk.newText,
		followTarget: { kind: "diff-row", focus: diffDocument.focus },
		textTruncated: hunk.cut || diffDocument.truncated,
		...(filePath ? { codeLangPath: filePath } : {}),
	});
}

/** `L12-40`-style chip from the resolved range the tool reports. */
function lineRangeChip(metadata: Record<string, unknown> | null): ToolStructuredBadge | null {
	const start = metadata?.startLine;
	const end = metadata?.endLine;
	if (typeof start !== "number" || typeof end !== "number") return null;
	return chip(start === end ? `L${start}` : `L${start}-${end}`, "gray");
}

/** A `12 decl`-style chip from a numeric metadata field, or null when absent/zero. */
function countChip(
	metadata: Record<string, unknown> | null,
	key: string,
	label: string,
): ToolStructuredBadge | null {
	const value = metadata?.[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return { label: `${value} ${label}`, color: "gray" };
}

function classifyWebSearch(inputJson: unknown, outputJson: unknown): ToolDetailData | null {
	const query = extractField(inputJson, "query");
	const output = resolveDisplayText(outputJson);
	if (!output) {
		return single("meta.error", { kind: "error", text: "Web search failed" });
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
			section("meta.query", undefined, metaRows([query ? { text: query, mono: true } : null])),
			section("output.results", undefined, {
				kind: "structured",
				badgeRows: 0,
				bodyLines: [],
				entries,
			}),
		]);
	}
	// Non-structured output is markdown in the chunked card (ContentViewer markdown).
	// `sections()` cannot return null here: the output section's body is built
	// unconditionally, so `kept` always holds at least one entry.
	return sections([
		section("meta.query", undefined, metaRows([query ? { text: query, mono: true } : null])),
		textSection("output.main", outputJson, "output", {
			contentLines: countLines(output),
			text: output,
			format: "markdown",
		}),
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
			section("meta.request", undefined, header),
			section(
				"output.main",
				undefined,
				capped("output.main", "media", {
					format: "media",
					contentPx: MEDIA_IMAGE_CONTENT_PX,
					media: { previewUrl: fetchPreviewUrl, filename: url, ...mediaDimensions(metadata) },
				}),
			),
		]);
	}
	if (isFailStatus(status) && !output) {
		return sections([
			section("meta.request", undefined, header),
			section("meta.error", "error", { kind: "error", text: "Fetch failed" }),
		]);
	}
	// smart / readability outputs are markdown in the chunked card.
	const isMarkdown = mode === "smart" || mode === "readability";
	return sections([
		section("meta.request", undefined, header),
		textSection("output.main", outputJson, "output", {
			contentLines: countLines(output),
			text: output,
			...(isMarkdown ? { format: "markdown" as const } : {}),
		}),
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
		section("meta.task", undefined, header),
		section(
			"meta.retrieval",
			retrievalStatus ? "error" : undefined,
			retrievalStatus ? { kind: "error", text: retrievalStatus } : null,
		),
		textSection("output.main", outputJson, "output", {
			contentLines: countLines(output),
			text: output,
		}),
	]);
}

function classifyAwait(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
): ToolDetailData | null {
	const rawOutput = resolveDisplayText(outputJson);
	const awaitType = extractField(inputJson, "type") || (metadata?.awaitType as string) || "task";
	const output = awaitType === "agent" ? stripAwaitAgentEnvelope(rawOutput) : rawOutput;
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
		section("meta.await", undefined, header),
		textSection("output.main", outputJson, isBash ? "output" : "result", {
			cap: isBash ? "term" : "code",
			contentLines: countLines(output),
			text: output,
			// Non-bash await results are markdown in the chunked card.
			...(isBash ? {} : { format: "markdown" as const }),
		}),
	]);
}

function classifySend(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
	labels: Record<string, string> | undefined,
	status: string | null | undefined,
): ToolDetailData | null {
	const input = asObject(inputJson);
	const message = readLeafText(input?.message);
	const output = resolveDisplayText(outputJson);
	const targets = resolveCommunicationTargets(metadata, metadata?._sendDeliveryTargets);
	const isAwait =
		!isTruncated(inputJson) && typeof input?.await === "boolean"
			? input.await
			: metadata?.await === true;
	const doInterrupt = isTruncated(inputJson)
		? metadata?.doInterrupt === true
		: input?.doInterrupt === true || metadata?.doInterrupt === true;
	const selectors = communicationSelectors(inputJson);
	const state = deriveCommunicationState({
		targets,
		targetCount: metadata?.targetCount,
		selectorCount: Array.isArray(metadata?.targets) ? 0 : selectors.length,
		awaitReply: isAwait,
		status,
	});
	const targetLabels = targets.length > 0 ? targets.map(communicationTargetLabel) : selectors;
	const badges: ToolStructuredBadge[] =
		targetLabels.length > 0
			? targetLabels.map((label) => ({ label: `→ ${label}`, color: "blue" }))
			: [{ label: "Subagent message", color: "blue" }];
	badges.push({
		label: formatCommunicationState(state, labels),
		color: state.outcome ? "red" : "gray",
	});
	if (doInterrupt) badges.push({ label: "interrupt", color: "orange" });

	// Delivery rows keep their per-target structure (status badge + label +
	// interrupted/error suffix) instead of collapsing to "sent · Agent A" text.
	const deliveryEntries: ToolStructuredEntry[] = targets.map((target) => {
		const targetState = deriveCommunicationState({ targets: [target], awaitReply: isAwait });
		return {
			title: communicationTargetLabel(target),
			badges: chips([
				chip(formatCommunicationState(targetState, labels), targetState.outcome ? "red" : "green"),
				chip(target.interrupted === true ? "interrupted" : undefined, "orange"),
			]),
			...(target.error ? { snippet: target.error } : {}),
		};
	});

	return sections([
		section("meta.targets", undefined, metaRows([badgeRow(badges)])),
		textSection("input.message", message === undefined ? undefined : input?.message, "message", {
			contentLines: countLines(message ?? ""),
			text: message,
			format: "markdown",
		}),
		section(
			"output.delivery",
			deliveryEntries.length > 0 ? "delivery" : undefined,
			deliveryEntries.length > 0
				? { kind: "structured", badgeRows: 0, bodyLines: [], entries: deliveryEntries }
				: null,
		),
		textSection("output.main", outputJson, state.replyCount > 0 ? "reply" : "result", {
			contentLines: countLines(output),
			text: output,
			format: "markdown",
		}),
	]);
}

interface AskQuestion {
	header?: string;
	description?: string;
	/** Legacy fields kept only so history still renders. */
	question?: string;
	content?: string;
	id?: string;
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

/** True when a legacy string looks like a machine key rather than display text. */
function isAskKeyLike(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "undefined" || trimmed === "null") return false;
	if (trimmed.length > 40) return false;
	if (/[？?！!：:\n]/.test(trimmed)) return false;
	return /^[A-Za-z0-9][\w.-]*$/.test(trimmed) || trimmed.length <= 24;
}

/**
 * Split a multi-select answer (`"Alpha, Beta"`) into its parts. Mirrors
 * `splitAnswerParts` in frontend/components/narrator/question/ask-user-question-utils.ts
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
 * keyed by the question `header` (the only field the advertised schema guarantees).
 * Legacy keys (`id`, old `question`) and a single-question fallback still work so
 * older stored calls do not render as unanswered.
 */
function resolveAskAnswer(
	q: AskQuestion,
	header: string,
	answers: Record<string, unknown>,
	allowSingleAnswerFallback: boolean,
): string | undefined {
	const byHeader = nonEmptyString(answers[header]);
	if (byHeader) return byHeader;
	const byId = typeof q.id === "string" ? nonEmptyString(answers[q.id]) : undefined;
	if (byId) return byId;
	const byLegacy = typeof q.question === "string" ? nonEmptyString(answers[q.question]) : undefined;
	if (byLegacy) return byLegacy;
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
		// Advertised shape: short header + full description. Legacy bodies may sit in
		// content/question; keep the short title as header when both exist.
		const rawHeader = readLeafText(q.header);
		const rawDescription = readLeafText(q.description);
		const rawContent = readLeafText(q.content);
		const rawLegacyBody =
			typeof q.question === "string" && !isAskKeyLike(q.question) ? q.question : undefined;
		const body = rawDescription || rawContent || rawLegacyBody;
		const header = rawHeader?.trim() ? rawHeader : (body?.split("\n")[0] ?? "Question");
		const description =
			body && body !== header
				? body
				: rawDescription && rawDescription !== header
					? rawDescription
					: undefined;
		const answer = resolveAskAnswer(q, header, answers, omitHeader);
		const rawOptions = Array.isArray(q.options) ? q.options : [];
		const options: ToolAskOption[] = [];
		const optionLabels: string[] = [];
		for (const opt of rawOptions.slice(0, ASK_OPTIONS_MAX)) {
			const o = asObject(opt);
			const optionHeader =
				(o ? readLeafText(o.header) : undefined) ??
				(o ? readLeafText(o.label) : undefined) ??
				(o ? readLeafText(o.title) : undefined) ??
				"";
			// The option DESCRIPTION is half the information in the banner; carrying
			// only the header dropped it entirely.
			const descriptionText = (o ? readLeafText(o.description) : undefined) ?? "";
			if (optionHeader) optionLabels.push(optionHeader);
			options.push({
				header: optionHeader,
				...(descriptionText ? { description: descriptionText } : {}),
				...(askOptionSelected(answer, optionHeader) ? { selected: true } : {}),
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
			...(description && description !== header ? { description } : {}),
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
	return single("output.results", { kind: "ask", questions });
}

/**
 * Deny-message values the SERVER authored, which must never be shown as the
 * reviewer's words.
 *
 * Defensive rather than load-bearing: measured against this repository's database,
 * zero `permission_deny_message` rows hold either value, because
 * `narrator-permission.ts` writes `effectiveDenyMessage ?? null` — the placeholder
 * goes to `errorMessage` only. They are filtered anyway because a future writer
 * that stores the placeholder in this column would attribute an English system
 * string to the user with no error anywhere, and because the chunked
 * `ToolCallCard` filters the same first value (keeping the two paths identical is
 * the point).
 *
 * `Permission reprocessing failed:` IS written to this column (a frozen-target
 * reprocessing failure), so it is matched by prefix.
 */
const PLACEHOLDER_DENY_MESSAGE = "Permission denied by user";
const REPROCESSING_FAILURE_DENY_PREFIX = "Permission reprocessing failed:";

/**
 * True when the deny message came from the server, not from a reviewer.
 *
 * Exported so the chunked `ToolCallCard` shares this exact judgement: the two
 * render paths show the same row, and a value one of them hides while the other
 * prints it as the user's words is a difference no test of either alone can see.
 */
export function isServerAuthoredDenyMessage(text: string): boolean {
	return text === PLACEHOLDER_DENY_MESSAGE || text.startsWith(REPROCESSING_FAILURE_DENY_PREFIX);
}

function classifyPlan(
	inputJson: unknown,
	metadata: Record<string, unknown> | null,
	denyMessage?: string,
): ToolDetailData | null {
	const planText = extractField(inputJson, "plan") || String(asObject(inputJson)?.plan ?? "");
	// `hasUsablePlanBody` rejects our own model-facing plan reference. It reaches
	// this field when a model echoes back the sentence it saw in its stripped
	// history; showing it would present "the plan is saved in <path>" to the user AS
	// the plan. Treated as absent so the caller's pending-permission fallback (which
	// holds the server-resolved body) supplies the real plan instead.
	if (
		!Object.hasOwn(asObject(inputJson) ?? {}, "plan") ||
		(planText.trim().length > 0 && !hasUsablePlanBody(planText))
	)
		return null;
	// Plans are authored in markdown and the chunked card renders them as such
	// (ToolCallCard PlanDetail → ContentViewer markdown), so the vlist must not
	// degrade them to monospace plain text. `_planFile` marks a file-based plan;
	// pass the raw path through and let the render layer localize it.
	const planFile = extractField(inputJson, "_planFile");
	const body = capped("input.plan", "plan", {
		contentLines: countLines(planText),
		text: planText,
		...truncatedFlag(inputJson),
		format: "markdown",
		...(planFile ? { sourcePath: planFile } : {}),
	});
	// A DENIED plan carries the reviewer's feedback above the body.
	//
	// `permissionDenyMessage` is a TOP-LEVEL tool-call column, not part of
	// `_metadata` (see narrator-messages' enrichToolUseBlocks) — which is why the
	// caller forwards it explicitly as `denyMessage`. Reading only the metadata
	// keys meant the vlist path never found it: a plan denied WITH typed feedback
	// rendered as a bare collapsed plan, silently dropping the one thing the user
	// wrote. The metadata keys stay as the first sources so a payload that does
	// carry them (older rows, synthetic fixtures) keeps working.
	//
	// The caller gates `denyMessage` on a FAILED status, because that same column
	// also holds the feedback typed alongside an APPROVAL (narrator-permission's
	// `denyMessage || feedbackText`): 20 of this repository's 162 ExitPlanMode rows
	// with the column set were approvals, and presenting those as denial feedback
	// tells the reader their accepted plan was rejected. The metadata keys are not
	// gated — a payload that carries `denyFeedback` is describing a denial by name.
	const denyFeedback =
		(metadata ? readLeafText(metadata.denyFeedback) : undefined) ||
		(metadata ? readLeafText(metadata.permissionDenyMessage) : undefined) ||
		denyMessage ||
		"";
	// A server-authored value would put a system string where the user's words
	// belong (the chunked PlanDetail filters the same placeholder).
	if (!denyFeedback.trim() || isServerAuthoredDenyMessage(denyFeedback.trim()))
		return single("input.plan", body);
	// Deliberately UNLABELLED: the chunked PlanDetail prints this text bare, and an
	// "Error" heading would file the reviewer's own note under tool failures.
	return {
		kind: "sections",
		sections: [
			{ key: "meta.denial", body: { kind: "error", text: denyFeedback, tone: "warning" } },
			{ key: "input.plan", label: "plan", body },
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
	const hasRule = Object.hasOwn(asObject(inputJson) ?? {}, "rule");
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
		section("meta.pipeline", undefined, metaRows([badgeRow(badges)])),
		textSection("input.rule", hasRule ? (asObject(inputJson)?.rule ?? "") : undefined, "rule", {
			contentLines: countLines(rule),
			text: rule,
			// A pipeline rule is a shell expression (parity with the Pixi renderer).
			format: "code",
			codeLang: "shellscript",
		}),
		section(
			"output.captured",
			captureEntries.length > 0 ? "captured" : undefined,
			captureEntries.length > 0
				? { kind: "structured", badgeRows: 0, bodyLines: [], entries: captureEntries }
				: null,
		),
		textSection("output.main", outputJson, "output", {
			contentLines: countLines(output),
			text: output,
		}),
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
		const hasInput = Object.hasOwn(asObject(inputJson) ?? {}, "input");
		if (isFailStatus(status) && !inp)
			return single("meta.error", { kind: "error", text: "Terminal write failed" });
		return sections([
			section("meta.terminal", undefined, header),
			textSection(
				"input.input",
				hasInput ? (asObject(inputJson)?.input ?? "") : undefined,
				"input",
				{
					cap: "bash-cmd",
					contentLines: countLines(inp),
					text: inp,
					// Terminal stdin is shell input; the read/list OUTPUT below is
					// program output and stays unhighlighted.
					format: "code",
					codeLang: "shellscript",
				},
			),
		]);
	}
	// read / list
	const output = resolveDisplayText(outputJson);
	if (isFailStatus(status) && !output)
		return single("meta.error", { kind: "error", text: "Terminal read failed" });
	return sections([
		section("meta.terminal", undefined, header),
		textSection("output.main", outputJson, "output", {
			cap: "term",
			contentLines: countLines(output),
			text: output,
		}),
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
			section("meta.share", undefined, header),
			section(
				"output.main",
				undefined,
				capped("output.main", "media", {
					format: "media",
					contentPx: MEDIA_IMAGE_CONTENT_PX,
					media: { previewUrl: sharePreviewUrl, filename, ...mediaDimensions(metadata) },
				}),
			),
		]);
	}
	return sections([section("meta.share", undefined, header)]);
}

/** Tool statuses meaning the call is over (no live bar past this point). */
const TERMINAL_TOOL_STATUSES_FOR_PROGRESS = new Set([
	"success",
	"fail",
	"error",
	"cancelled",
	"completed",
]);

function isTerminalToolStatus(status: string | null | undefined): boolean {
	return status != null && TERMINAL_TOOL_STATUSES_FOR_PROGRESS.has(status);
}

/**
 * Build a progress-bar row descriptor from a raw measurement payload.
 *
 * Returns null for a payload describing nothing (no work done, no known total) —
 * an empty bar that never moves is worse than no bar, because it looks like a
 * transfer that has stalled.
 *
 * The figures come PRE-FORMATTED from the producer (`figures` on the payload's
 * sibling channel is not available here), so this layer formats only the byte
 * counts it can reason about generically. Unit choice for bytes is unambiguous,
 * unlike a localized phrase, which is why it is allowed in this i18n-free layer.
 */
function readTransferProgressRow(value: unknown): ToolRowProgress | null {
	const payload = readToolProgressPayload(value);
	if (!payload || !hasRenderableProgress(payload)) return null;
	const view = deriveToolProgress(payload);
	const figures: string[] = [
		payload.total != null
			? `${formatProgressBytes(payload.completed)} / ${formatProgressBytes(payload.total)}`
			: formatProgressBytes(payload.completed),
	];
	if (view.ratePerSecond !== null) figures.push(`${formatProgressBytes(view.ratePerSecond)}/s`);
	if (view.etaSeconds !== null) figures.push(`ETA ${formatProgressDuration(view.etaSeconds)}`);
	if (payload.itemsTotal != null && payload.itemsTotal > 1) {
		const item = payload.currentItem ? ` ${payload.currentItem}` : "";
		figures.push(
			`file ${Math.min((payload.itemsDone ?? 0) + 1, payload.itemsTotal)}/${payload.itemsTotal}${item}`,
		);
	}
	return {
		ratio: view.ratio,
		...(view.percent !== null ? { percent: view.percent } : {}),
		figures,
		color: "blue",
		active: true,
	};
}

/**
 * TransferFile: a device/direction badge header plus the transfer body — the LIVE
 * progress bar while bytes move, the completion figures once they have.
 *
 * Before this existed the tool fell through to `classifyGeneric`, so a transfer
 * rendered as its own raw argument JSON: the reader saw the paths they had just
 * asked for and no indication of whether anything was happening. A multi-minute
 * upload looked identical at 0% and at 99%.
 *
 * The running body is the tool's own `emitOutput` text (already a formatted bar —
 * see server/lib/agent/tools/transfer-progress.ts) rather than a structure rebuilt
 * from numbers here. Two reasons: the progress figures never reach the client as
 * fields (only `tool_output` carries them mid-flight), and keeping ONE formatter
 * means the text a user copies out of the card is the text they saw in it.
 */
function classifyTransfer(
	status: string | null | undefined,
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
	errorMessage?: string | null,
): ToolDetailData | null {
	const direction =
		readLeafText(metadata?.transferDirection) ?? extractField(inputJson, "direction");
	const deviceName = readLeafText(metadata?.deviceName);
	const remotePath = readLeafText(metadata?.remotePath) || extractField(inputJson, "remotePath");
	const localPath = readLeafText(metadata?.localPath) || extractField(inputJson, "localPath");
	const recursive =
		metadata?.recursive === true ||
		(!isTruncated(inputJson) && asObject(inputJson)?.recursive === true);
	const filesTransferred =
		typeof metadata?.filesTransferred === "number" ? metadata.filesTransferred : undefined;
	const liveProgress = readTransferProgressRow(metadata?._structuredProgress);
	// A REAL bar row, built from the measurement the tool emitted. Only while the
	// call is still running: a finished transfer's bar would sit at 100% forever,
	// saying nothing the summary line does not already say.
	const progressRow: ToolMetaRow | null =
		!isTerminalToolStatus(status) && liveProgress ? { text: "", progress: liveProgress } : null;

	const header = metaRows([
		badgeRow(
			chips([
				chip(direction || undefined, "blue"),
				// The device is the whole point of the call — which machine the bytes
				// went to — so it gets a chip of its own rather than being folded into
				// a path line where it would read as part of the filename.
				chip(deviceName, "gray"),
				chip(recursive ? "recursive" : undefined, "violet"),
				chip(readLeafText(metadata?.bytesFormatted), "cyan"),
				chip(readLeafText(metadata?.rateFormatted), "teal"),
				chip(
					filesTransferred != null && filesTransferred > 1
						? `${filesTransferred} files`
						: undefined,
					"lime",
				),
			]),
		),
		// Source → destination in TRANSFER order, not field order: reading "the local
		// file went to that remote path" requires knowing which side is which, and an
		// arrow answers that without a label per line.
		pathRow(
			direction === "upload"
				? [localPath, remotePath].filter(Boolean).join("  →  ")
				: [remotePath, localPath].filter(Boolean).join("  →  "),
		),
		progressRow,
	]);

	// The text form is the fallback for a card with no bar (an older payload, a
	// finished call). It is NOT shown alongside the bar: the two say the same thing.
	const streamingOutput = readLeafText(metadata?._streamingOutput) ?? "";
	const output = resolveDisplayText(outputJson);
	const body = outputJson != null ? output : progressRow ? "" : streamingOutput;
	// A failed transfer with no body still has to say SOMETHING under the paths: a
	// bare header leaves the reader unable to tell "failed" from "still starting".
	//
	// Only a placeholder, and only when there is no real message — `withErrorSection`
	// appends the actual `errorMessage` to this same detail afterwards, so adding one
	// here too would print the failure twice.
	if (isFailStatus(status) && !body && !nonEmptyTrimmedText(errorMessage)) {
		return sections([
			section("meta.transfer", undefined, header),
			section("meta.error", "error", { kind: "error", text: "Transfer failed" }),
		]);
	}
	return sections([
		section("meta.transfer", undefined, header),
		textSection(
			"output.main",
			body ? (outputJson ?? metadata?._streamingOutput) : undefined,
			undefined,
			{
				cap: outputJson != null ? "term" : "streaming-bash",
				contentLines: countLines(body),
				text: body,
			},
		),
	]);
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
			return single("output.results", {
				kind: "structured",
				badgeRows: 0,
				bodyLines: ["No results"],
			});
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
		return single("output.results", {
			kind: "structured",
			badgeRows: 1,
			badges: recallQueryBadges(metadata),
			bodyLines: [],
			entries,
		});
	}
	// read_conversation
	const messages = Array.isArray(metadata.messages) ? (metadata.messages as unknown[]) : [];
	if (messages.length === 0) {
		return single("output.results", {
			kind: "structured",
			badgeRows: 0,
			bodyLines: ["No results"],
		});
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
	return single("output.results", {
		kind: "structured",
		badgeRows: 1,
		badges,
		bodyLines: [],
		entries,
	});
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
			section("meta.skill", undefined, metaRows([badgeRow(chips([chip(skillName, "grape")]))])),
			textSection("output.main", outputJson, undefined, {
				cap: "skill",
				contentLines: countLines(content) + 2,
				text: content,
				...(content ? { format: "markdown" as const } : {}),
			}),
			section(
				"meta.files",
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
			section("meta.browser", undefined, header),
			section(
				"output.main",
				undefined,
				capped("output.main", "media", {
					format: "media",
					contentPx: MEDIA_IMAGE_CONTENT_PX,
					media: {
						previewUrl: browserPreviewUrl,
						filename: url,
						...(savedFilePath ? { filePath: savedFilePath } : {}),
						...mediaDimensions(metadata),
					},
				}),
			),
		]);
	}
	const output = resolveDisplayText(outputJson);
	if (isFailStatus(status) && !output)
		return single("meta.error", { kind: "error", text: "Browser action failed" });
	return sections([
		section("meta.browser", undefined, header),
		textSection("output.main", outputJson, "output", {
			contentLines: countLines(output),
			text: output,
			// Parity with the chunked BrowserDetail: only the `dom` action returns
			// markup; other actions return prose/JSON-ish text.
			...(action === "dom" ? { format: "code" as const, codeLang: "html" } : {}),
		}),
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
		return single("output.results", {
			kind: "structured",
			badgeRows: 1,
			badges: chips([chip(`${results.length} results`, "grape")]),
			bodyLines: [],
			entries,
		});
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
			section("meta.entry", undefined, header),
			textSection("output.main", outputJson ?? "", undefined, {
				cap: "knowledge",
				contentLines: countLines(body) + 2,
				text: body,
				...(body ? { format: "markdown" as const } : {}),
			}),
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
			section("meta.entry", undefined, header),
			section("output.main", undefined, {
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

/**
 * ContextAsk's tool_output while the summary model is still streaming is a bare
 * cumulative character count (`onProgress` → `emitOutput(String(n))`), not a body.
 * Readers want that as a counter; painting it as markdown would show a lone number.
 */
function contextAskLiveOutputChars(
	metadata: Record<string, unknown> | null,
	outputJson: unknown,
): number | null {
	const raw = readLeafText(metadata?._streamingOutput) ?? readLeafText(outputJson);
	if (raw === undefined) return null;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const n = Number(trimmed);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Strip the server-authored heading and trailing source-warning from a ContextAsk
 * result so the card body is the answer alone. Failures return the input unchanged —
 * older rows and localized headings must never make the result disappear.
 */
function stripContextAskEnvelope(text: string): string {
	let body = text;
	// English: `ContextAsk result for <label>:\n\n…`
	body = body.replace(/^ContextAsk result for [^\r\n]*:\r?\n\r?\n/, "");
	// zh-CN: `ContextAsk（<label>）结果：\n\n…`
	body = body.replace(/^ContextAsk（[^\r\n]*）结果：\r?\n\r?\n/, "");
	// Trailing safety warnings (already surfaced as badges).
	body = body.replace(/\n\n(?:Note:|注意：)[^\n]*$/, "");
	return body.trim();
}

function classifyContextAsk(
	inputJson: unknown,
	outputJson: unknown,
	metadata: Record<string, unknown> | null,
	status: string | null | undefined,
): ToolDetailData {
	const input = asObject(inputJson);
	const target = asObject(metadata?.target);
	const targetLabel = readLeafText(target?.title) ?? extractField(inputJson, "id") ?? "subagent";
	const questionsSource = Array.isArray(metadata?.questions)
		? (metadata.questions as unknown[])
		: Array.isArray(input?.questions)
			? (input.questions as unknown[])
			: [];
	const questions = questionsSource
		.map((q) => readLeafText(q) ?? (typeof q === "string" ? q : undefined))
		.filter((q): q is string => q !== undefined && q.trim().length > 0)
		.slice(0, 8);
	const messageCount =
		typeof metadata?.messageCount === "number" ? metadata.messageCount : undefined;
	const contextPercent =
		typeof metadata?.contextPercent === "number" ? metadata.contextPercent : undefined;
	const chunkCount = typeof metadata?.chunkCount === "number" ? metadata.chunkCount : undefined;
	const sourceTruncated = metadata?.sourceTruncated === true;
	const hasMore = metadata?.hasMore === true;
	const toolCallsTruncated = metadata?.toolCallsTruncated === true;

	const liveChars = isTerminalToolStatus(status)
		? null
		: contextAskLiveOutputChars(metadata, outputJson);

	const badges = chips([
		chip(questions.length > 0 ? `${questions.length} questions` : "status summary", "indigo"),
		chip(messageCount != null ? `${messageCount} msgs` : undefined, "gray"),
		chip(contextPercent != null ? `${contextPercent}% ctx` : undefined, "cyan"),
		chip(chunkCount != null && chunkCount > 1 ? `${chunkCount} chunks` : undefined, "gray"),
		chip(sourceTruncated ? "source truncated" : undefined, "orange"),
		chip(toolCallsTruncated ? "tools truncated" : undefined, "orange"),
		chip(hasMore ? "older history omitted" : undefined, "orange"),
	]);

	const questionLines = questions.map((q, i) => `${i + 1}. ${q}`);
	const rawOutput = resolveDisplayText(outputJson);
	const answer = rawOutput ? stripContextAskEnvelope(rawOutput) : "";
	// A bare numeric streaming snapshot must never be painted as the answer body.
	const answerIsLiveCount = liveChars != null && answer !== "" && /^\d+$/.test(answer.trim());
	const answerBody = answerIsLiveCount ? "" : answer;

	return (
		sections([
			section(
				"meta.target",
				undefined,
				metaRows([badgeRow(chips([chip(`→ ${targetLabel}`, "blue"), ...badges]))]),
			),
			section(
				"input.questions",
				"input",
				questionLines.length > 0
					? {
							kind: "structured",
							badgeRows: 0,
							bodyLines: questionLines,
						}
					: null,
			),
			section(
				"output.main",
				"result",
				answerBody
					? capped("output.main", "code", {
							text: answerBody,
							format: "markdown",
							contentLines: countLines(answerBody),
							...truncatedFlag(outputJson),
						})
					: liveChars != null
						? {
								kind: "structured",
								badgeRows: 0,
								bodyLines: [`${liveChars} chars`],
							}
						: null,
			),
		]) ?? { kind: "sections", sections: [] }
	);
}
