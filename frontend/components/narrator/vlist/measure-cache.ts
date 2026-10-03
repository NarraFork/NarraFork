/**
 * measure-cache.ts — Module-level measurement cache for pretext element heights.
 *
 * The cache eliminates redundant height computation when `buildPretextDocumentLayout`
 * rebuilds the full window on loadOlder (prepend). Items already measured with the
 * same (key, width, lod, opts, dataRevision) hit the cache, reducing rebuild cost
 * from O(window) to O(new items only).
 *
 * Design: plain Map (no per-entry LRU eviction).
 *
 * Why NOT LRU: the layout pipeline does a sequential full-window scan on every
 * rebuild. With a small LRU cap (e.g. 4000), once the window exceeds the cap the
 * scan evicts entries at the front that the NEXT rebuild will need again — classic
 * "LRU thrash on sequential access". The result is 0% hit rate and worse-than-no-
 * cache overhead.
 *
 * Each geometry family retains only its current data revision. In particular,
 * live tool keys are stable (tool-<id>), so they must REPLACE a previous source
 * document rather than accumulating every frame's model until the entry ceiling.
 *
 * The entry ceiling still protects small geometry records. Body models can retain
 * much larger source strings/Diff documents, so they have a separate character
 * admission budget. Once full, existing admitted entries remain reusable on a
 * sequential scan; an uncached new entry never evicts the whole useful cohort.
 *
 * Cache key anatomy:
 *   `${spec.key}|${kind}|${roundedWidth}|${lod}|r:${dataRevision}|${optsDigest}`
 *
 * Streaming items (key contains "__streaming__") are never cached because their
 * content changes between measurements.
 */

import { normalizeFileReferenceContext } from "@shared/file-reference-context";
import type { MeasuredElement } from "./prepared-block";

// ─────────────────────────────────────────────────────────────────────────────
// MeasureCache — Plain Map with high ceiling + bulk-clear fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Source-payload admission budget, independent of the small-geometry entry cap.
 * Revisions of the same geometry family replace one another; it is not an LRU.
 */
export const MEASURE_BODY_SOURCE_CHAR_BUDGET = 4_000_000;

/** Bound Map hashing/equality and retained UTF-16 key lengths independently. */
export const TEXT_SIGNATURE_MAX_TEXT_CHARS = 2048;
export const TEXT_SIGNATURE_MAX_ENTRIES = 8192;
export const TEXT_SIGNATURE_CHAR_BUDGET = 1_048_576;

/** Only the measured body's retained payload, never a stringify/deep walk of user input. */
export function retainedBodySourceChars(value: unknown): number {
	if (!value || typeof value !== "object") return 0;
	const item = value as Record<string, unknown>;
	const model = item.model as Record<string, unknown> | undefined;
	let chars = 0;
	if (model?.kind === "capped") {
		chars += typeof model.text === "string" ? model.text.length : 0;
		const doc = model.diffDocument as
			| { oldSource?: { text?: string }; newSource?: { text?: string } }
			| undefined;
		chars += doc?.oldSource?.text?.length ?? 0;
		chars += doc?.newSource?.text?.length ?? 0;
	}
	for (const key of ["detail", "promptMeasured", "resultMeasured"] as const)
		chars += retainedBodySourceChars(item[key]);
	if (Array.isArray(item.sections))
		for (const section of item.sections) chars += retainedBodySourceChars(section?.measuredBody);
	if (Array.isArray(item.rows))
		for (const row of item.rows) chars += retainedBodySourceChars(row?.cardMeasured);
	if (Array.isArray(item.children))
		for (const child of item.children) chars += retainedBodySourceChars(child);
	return chars;
}

export class MeasureCache {
	private map = new Map<string, { value: MeasuredElement; chars: number; family?: string }>();
	private families = new Map<string, string>();
	private sourceChars = 0;
	private _hits = 0;
	private _misses = 0;
	private textSignatures = new Map<string, string>();
	private textSignatureChars = 0;

	constructor(
		private ceiling: number,
		private sourceBudget = MEASURE_BODY_SOURCE_CHAR_BUDGET,
	) {}

	get(key: string): MeasuredElement | undefined {
		const entry = this.map.get(key);
		if (entry === undefined) {
			this._misses++;
			return undefined;
		}
		this._hits++;
		return entry.value;
	}

	/**
	 * Reuse only an immutable STRING value, never a mutable adapter data object.
	 * Larger keys bypass Map entirely: their hashing/equality could scan the body
	 * before the original fixed-sample signature algorithm even starts.
	 */
	signatureForText(text: string): string {
		if (text.length > TEXT_SIGNATURE_MAX_TEXT_CHARS) return computeTextSignature(text);
		const cached = this.textSignatures.get(text);
		if (cached !== undefined) return cached;
		const signature = computeTextSignature(text);
		// Admission, not eviction: a full sequential scan keeps its admitted cohort
		// hot even when the working set exceeds either limit. Cold strings fall back.
		if (
			this.textSignatures.size < TEXT_SIGNATURE_MAX_ENTRIES &&
			this.textSignatureChars + text.length <= TEXT_SIGNATURE_CHAR_BUDGET
		) {
			this.textSignatures.set(text, signature);
			this.textSignatureChars += text.length;
		}
		return signature;
	}

	get textSignatureEntries(): number {
		return this.textSignatures.size;
	}

	get retainedTextSignatureChars(): number {
		return this.textSignatureChars;
	}

	private remove(key: string): void {
		const entry = this.map.get(key);
		if (!entry) return;
		this.map.delete(key);
		this.sourceChars -= entry.chars;
		if (entry.family && this.families.get(entry.family) === key) this.families.delete(entry.family);
	}

	/** One current source revision per geometry family; old streamed documents are released. */
	set(key: string, value: MeasuredElement, family?: string): void {
		const previous = family ? this.families.get(family) : undefined;
		if (previous && previous !== key) this.remove(previous);
		this.remove(key);
		const chars = retainedBodySourceChars(value);
		if (chars > this.sourceBudget) return;
		if (this.map.size >= this.ceiling) this.clearStorage();
		// Admission, not LRU: keep the retained cohort hot on sequential full-window
		// scans rather than evicting exactly what the NEXT scan is about to visit.
		if (this.sourceChars + chars > this.sourceBudget) return;
		this.map.set(key, { value, chars, family });
		this.sourceChars += chars;
		if (family) this.families.set(family, key);
	}

	private clearStorage(): void {
		this.map.clear();
		this.families.clear();
		this.sourceChars = 0;
		this.textSignatures.clear();
		this.textSignatureChars = 0;
	}
	clear(): void {
		this.clearStorage();
		this.resetStats();
	}
	get size(): number {
		return this.map.size;
	}
	get retainedSourceChars(): number {
		return this.sourceChars;
	}
	get hits(): number {
		return this._hits;
	}
	get misses(): number {
		return this._misses;
	}
	resetStats(): void {
		this._hits = 0;
		this._misses = 0;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache key construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the spec key represents a streaming/transient item whose
 * content is still changing (height would be stale on next measure).
 */
export function isStreamingKey(key: string): boolean {
	return key.includes("__streaming__");
}

/**
 * Build a deterministic cache key from the inputs that affect measured height.
 * Designed to be fast (no JSON.stringify of large objects, no hash).
 */
export function buildCacheKey(
	specKey: string,
	kind: string,
	contentWidth: number,
	lod: number,
	opts: Record<string, unknown> | undefined,
	dataRevision?: string,
): string {
	const w = Math.round(contentWidth);
	let key = `${specKey}|${kind}|${w}|${lod}`;
	if (dataRevision) key += `|r:${dataRevision}`;
	if (opts && !optsIsEmpty(opts)) key += `|${digestOpts(opts)}`;
	return key;
}

/**
 * Extract a lightweight revision string from the data payload that captures
 * height-affecting mutations (status transitions, streaming flags) for items
 * whose spec.key stays stable across state changes.
 *
 * This is intentionally cheap: only pulls primitive fields known to affect
 * measure outcomes. Unknown/complex data gets no revision (safe — only means
 * no invalidation on status transition, but those items typically also change
 * opts which triggers a miss anyway).
 */
export function extractDataRevision(data: unknown): string | undefined {
	if (data == null || typeof data !== "object") return undefined;
	const d = data as Record<string, unknown>;
	// Collect height-affecting primitives that can change for the same spec.key.
	let rev = "";
	if ("status" in d && d.status != null) rev += `s:${d.status}`;
	// Ask-in-passing's adapter uses `kind`, not `status`, while preserving its
	// stable row key. Both the variant and question affect the cached blocks;
	// hash text rather than length so equal-length edits also repaint.
	if (d.kind === "pending" || d.kind === "resolved") {
		rev += `|aip:${d.kind}`;
		if (typeof d.question === "string") rev += `|aq:${textSignature(d.question)}`;
		// The adapter currently resolves navigation separately. Also invalidate if
		// a caller supplies the measure payload's optional navigation target.
		if (typeof d.targetNarratorId === "string") rev += `|at:${textSignature(d.targetNarratorId)}`;
	}
	if ("isStreaming" in d && d.isStreaming) rev += "|st:1";
	if ("isActive" in d && d.isActive) rev += "|ac:1";
	if ("isTerminal" in d && d.isTerminal) rev += "|te:1";
	// Delivery state/id are height-neutral header fields, but ExactRow renders from
	// the cached measured payload. Key them so queued → claimed/materialized/failed,
	// and canonical user edits that carry a new delivery identity, repaint immediately
	// instead of remaining stuck behind the old measured object.
	if (typeof d.deliveryId === "string") rev += `|di:${d.deliveryId}`;
	if (typeof d.deliveryKind === "string") rev += `|dk:${d.deliveryKind}`;
	if (typeof d.deliveryState === "string") rev += `|ds:${d.deliveryState}`;
	// Injection/user header and body passthroughs are painted from `spec.data`, but
	// ExactRow memoizes the measured object. A same-id message update must therefore
	// invalidate the object even when geometry stays equal.
	for (const key of [
		"markdown",
		"modelFacing",
		"speaker",
		"speakerKind",
		"source",
		"origin",
		"originLabel",
		"createdAt",
	] as const) {
		if (typeof d[key] === "string") rev += `|${key}:${textSignature(d[key])}`;
	}
	if (d.creator && typeof d.creator === "object") {
		const creator = d.creator as Record<string, unknown>;
		rev += `|cr:${String(creator.id ?? "")}:${String(creator.username ?? "")}:${String(
			creator.avatarColor ?? "",
		)}:${String(creator.avatarImageId ?? "")}`;
	}
	// Effective timeout — the ONE height-neutral passthrough that needs keying.
	//
	// Height-neutral fields normally may be omitted (the `/ 2m` suffix rides the
	// card's fixed header row), but the cache stores the whole MeasuredElement,
	// including the values the renderer merely PAINTS. Every other passthrough
	// arrives alongside a field that already moves the key — durationMs and the
	// lifecycle stamps come with `tool_completed`'s status change. `timeout_updated`
	// is the exception: it writes the deadline and nothing else, so without this the
	// rebuild serves the pre-update measured payload and the header keeps showing
	// the OLD timeout even though the server already applied the new one.
	if (typeof d.timeoutMs === "number") rev += `|to:${d.timeoutMs}`;
	// Truncated-payload state. Height-AFFECTING (a non-zero count reserves the
	// truncation notice row) and, more importantly, the ONLY key component that
	// moves when a fetched payload lands: `status` is already terminal, and the
	// detail body's own signature can legitimately stay put because a capped box
	// only ever measures a bounded PREFIX — an 8KB preview and the 40KB full text
	// slice to the same measured prefix. Without this the rebuild after the fetch
	// hit the pre-fetch entry, so the card kept `truncatedLeafCount > 0`, the row
	// stayed in the shell's in-flight set, and the notice read "loading full
	// data…" forever. The nested (drilled-in trace row) path already keys it via
	// `|tdn:` — this is the same contract for a standalone card.
	if (typeof d.truncatedLeafCount === "number") rev += `|tp:${d.truncatedLeafCount}`;
	// The live permission form's reserve on a STANDALONE card (the drilled-in card's
	// copy is keyed by `traceRevision`). Height-affecting, and it is the only component
	// that moves when the form's painted height is reported.
	rev += permissionFormRevision(d.permissionForm);
	// Takeover badge. Height-neutral (it rides the fixed header row), and keyed for
	// exactly the reason `timeoutMs` above is: the takeover patch writes this ONE
	// field — `status` cannot move, because the whole point is that the call is
	// STILL running while the user drives its child by hand. Without this the
	// rebuild serves the pre-takeover payload and the header stays silent about why
	// the session stopped.
	if (d.isTakenOver === true) rev += "|tv:1";
	// Queued-behind-upstream shimmer. Height-neutral (a class name / aria label),
	// keyed because an earlier sibling finishing is the ONLY event that clears it
	// while this call's own status stays `initializing`.
	if (d.queuedBehindUpstream === true) rev += "|tq:1";
	// `+N -N` line counts. Height-neutral (a nowrap span in the fixed header row),
	// keyed for the same reason `timeoutMs` and `isTakenOver` are: it is PAINTED from
	// the cached payload and can APPEAR while nothing else in the key moves. Two such
	// moments exist — an on-demand payload fetch resolving a truncated Edit (which
	// only moves `truncatedLeafCount`, and would be a hit-with-stale-figure if that
	// were ever relaxed) and a live patch landing the tool's metadata on an
	// already-terminal status. Omitting this would keep the previous numbers on
	// screen, which is worse than showing none: they look authoritative.
	rev += diffStatsRevision(d.diffStats);
	// A system card's OWN body text (`system-text` and friends paint `data.text`
	// as pre-wrap, so its height is a function of how it wraps). `detailTextRevision`
	// below only reaches `data.detail`, which a system card does not have.
	//
	// This matters because of the compact-marker live-patch channel
	// (PretextExactMessageList's `replaceOrReload`): it swaps the whole message in
	// place while deliberately holding `messageVersion` fixed, so `status` used to
	// be the only thing that could move the key. Two updates with the SAME status
	// and different prose — a `compacted` marker whose summary was rewritten, or two
	// `failed` markers with different error text — would otherwise hit the previous
	// entry and paint the new text inside the old box (CONTRACT.md §4.5 约束 3).
	// O(1) via the sampled signature, same as every other text field here.
	if (typeof d.text === "string") rev += `|sx:${textSignature(d.text)}`;
	// Chat regrouping can add/remove the fixed header without editing the message.
	// Body format also changes geometry while text/id/document version stay equal.
	// Normalize the narrator defaults so omitted and explicit defaults share a key.
	if (d.role === "user") {
		rev += `|uh:${d.hasHeader === false ? 0 : 1}|bf:${d.bodyFormat === "markdown" ? "markdown" : "plain"}`;
	}
	// User-bubble reply quote strip / tombstone form. Both are reserved fixed
	// blocks inside the measured payload, so a reply target resolve (preview
	// landing after the page loads), a soft delete, or an edit of the tombstone
	// label must re-key — otherwise the cached element keeps painting the old
	// strip / keeps the body that a tombstone replaced.
	if (d.quote && typeof d.quote === "object") {
		const quote = d.quote as Record<string, unknown>;
		rev += `|qu:${String(quote.state ?? "")}:${textSignature(String(quote.text ?? ""))}:${textSignature(String(quote.authorName ?? ""))}`;
	}
	if (d.deleted === true) rev += "|del:1";
	if (typeof d.deletedLabel === "string") rev += `|dl:${textSignature(d.deletedLabel)}`;
	// Canonical edit stamp of a user/chat message: an in-place edit keeps the
	// spec.key and usually the role, so without this the measured body stays the
	// pre-edit one (the gap chat's own measure cache key already closed).
	if (typeof d.editedAt === "string") rev += `|ea:${d.editedAt}`;
	// Communication bodies can finish streaming or hydrate without changing status.
	// Re-key the bounded measured text and both independently reserved footer rows.
	if (typeof d.message === "string") {
		rev += `|cm:${textSignature(d.message)}|ct:${d.messageTruncated === true ? 1 : 0}`;
		if (typeof d.error === "string") rev += `|ce:${textSignature(d.error)}`;
		if (typeof d.warning === "string") rev += `|cw:${textSignature(d.warning)}`;
		// ExactRow memoizes by the measured object: navigation-only changes must
		// still repaint the recipient buttons, even when body and height stay equal.
		if (Array.isArray(d.recipients)) {
			rev += `|cr:${JSON.stringify(
				d.recipients.map((recipient) => {
					const r = recipient as Record<string, unknown>;
					return [r.id, r.title, r.label, r.deliveryMessageId, r.injectionConsumedAt];
				}),
			)}|ca:${d.awaitReply === true}|cb:${d.broadcast === true}`;
		}
		// Receipt/reply state is height-neutral but ExactRow also keys paint by this object.
		if (d.deliveryState) rev += `|cs:${JSON.stringify(d.deliveryState)}`;
	}
	if (Array.isArray(d.attachments)) {
		// Locator data is painted/clicked from cached blocks, including equal labels
		// on different devices. The adapter already removed every snapshot body.
		rev += `|ua:${JSON.stringify(
			d.attachments.map((attachment) => {
				const a = attachment as Record<string, unknown>;
				return [
					a.type,
					a.reference,
					a.imageId,
					a.previewUrl,
					a.filename,
					a.size,
					a.width,
					a.height,
					a.filePath,
					a.uploadNarratorId,
					// Domain-endpoint locator (chat attachments): the id lives in the path,
					// so this also re-keys a same-filename re-upload.
					a.fetchUrl,
				];
			}),
		)}`;
	}
	rev += detailTextRevision(d.detail);
	rev += reflectionRevision(d.reflection);
	rev += subagentRevision(d);
	rev += traceRevision(d);
	return rev || undefined;
}

/**
 * Cache-key fragment for a `+N -N` figure, or "" when there is none.
 *
 * Shared by the card-level and row-level revisions so the two cannot disagree
 * about what counts as a change. `added`/`removed` are keyed as VALUES rather than
 * as a mere presence flag: a corrected count (a fetched payload replacing a
 * locally-derived one) keeps the field present while changing what it says.
 */
function diffStatsRevision(value: unknown): string {
	if (value == null || typeof value !== "object") return "";
	const stats = value as { added?: unknown; removed?: unknown };
	if (typeof stats.added !== "number" || typeof stats.removed !== "number") return "";
	return `|df:${stats.added}/${stats.removed}`;
}

/**
 * Revision of a card's live permission-form reserve (`ToolCallData.permissionForm`).
 *
 * O(1): the painted height is one number; the prediction is a flat record of a dozen
 * primitive region flags/counts, so its keys are read directly rather than stringified.
 */
function permissionFormRevision(value: unknown): string {
	if (value == null || typeof value !== "object") return "";
	const form = value as { prediction?: unknown; height?: unknown };
	let rev = "|pf";
	if (typeof form.height === "number") rev += `:h${Math.round(form.height)}`;
	const prediction = form.prediction;
	if (prediction != null && typeof prediction === "object") {
		const p = prediction as Record<string, unknown>;
		for (const key of PERMISSION_PREDICTION_KEYS) {
			const v = p[key];
			if (v === undefined) continue;
			rev += `,${key}=${typeof v === "boolean" ? (v ? 1 : 0) : String(v)}`;
		}
	}
	return rev;
}

/** Every height-bearing field of `InlinePermissionData`, in a fixed order. */
const PERMISSION_PREDICTION_KEYS = [
	"readOnly",
	"hasExecutionTarget",
	"executionCwdLines",
	"executionPathLines",
	"isExitPlanMode",
	"isEditingPlan",
	"planEditRows",
	"planEdited",
	"hasDecisionReason",
	"decisionReasonLines",
	"hasPreviewLoading",
	"feedbackRows",
	"buttonRows",
] as const;

/**
 * Revision of a FOLDED TRACE payload (`activity-trace`, `tool-run-count`,
 * `reasoning-steps`).
 *
 * Why these need their own revision
 * ---------------------------------
 * A trace's spec.key is minted from its FIRST member — `activity-t:<toolUseId>` /
 * `activity-r:<blockId>` for the cross-segment activity fold (see
 * `activityUnitKey`), `toolrun-count-tool-<firstToolUseId>` for a
 * folded batch — while its height is
 * `header + rows(N) + …`, i.e. driven by the members that come AFTER the first.
 * So a fold that GROWS keeps its key, and none of the other key components move
 * either: the append/live-patch paths deliberately hold `messageVersion` fixed
 * (CONTRACT.md §4.5) and the trace's `opts` only carry fold/expand state.
 *
 * That made every low-LOD fold (L1/L2, where the folds exist at all) serve the
 * height AND the measured row list captured when it had one member. The visible
 * symptom: an activity trace stuck on "0 tools · 1 reasoning" with the tool rows
 * clipped away, which only "fixed itself" after an alt+wheel LOD change re-keyed
 * it by `lod` — and came back on return because the stale entry for the original
 * LOD was still cached.
 *
 * Cost is O(rows): a row's title is short (`truncateTitle` caps at 80 chars) and
 * expandable bodies contribute a bounded `textSignature`. Gated on `items`/`steps`
 * being an array so no other kind pays for the walk.
 */
function traceRevision(d: Record<string, unknown>): string {
	const rows = Array.isArray(d.items) ? d.items : Array.isArray(d.steps) ? d.steps : null;
	// `tool-run-count` has no row array at all — only the count and header text.
	if (!rows) return typeof d.count === "number" ? `|tn:${d.count}` : "";
	let rev = `|tc:${rows.length}`;
	// The composed header count ("N reasoning · M tools", "N calls") is what the
	// renderer PAINTS from the cached payload, so it must be keyed even though the
	// header row's height is fixed — this is the "0 tools" text that stayed stale.
	if (typeof d.headerCount === "string") rev += `|th:${d.headerCount}`;
	for (const row of rows) {
		if (row == null || typeof row !== "object") continue;
		const r = row as Record<string, unknown>;
		// Row identity + painted content. Titles are already length-capped upstream.
		if (typeof r.key === "string") rev += `|tk:${r.key}`;
		// Cached rows also carry inspector refs. A retry/COW can change only the
		// persisted identity while keeping every painted and height-bearing field.
		const identity = r.identity as { toolDetailRef?: Record<string, unknown> } | undefined;
		const ref = identity?.toolDetailRef;
		if (ref) {
			rev += `|tref:${JSON.stringify([
				ref.toolCallId ?? null,
				ref.messageId ?? null,
				ref.executionAttempt ?? null,
			])}`;
		}
		// PAINTED as `data-nf-unit` (the LOD morph's pairing identity) and height-neutral,
		// so it needs keying for the same reason `status` does: it can move while `key`
		// and every height-bearing field stay put — a reasoning run gains a cross-level
		// identity the moment its turn persists, and a stale entry would serve rows with
		// no `data-nf-unit`, silently costing exactly the morph it exists to enable.
		if (typeof r.unitId === "string") rev += `|tu:${r.unitId}`;
		if (typeof r.title === "string") rev += `|tt:${textSignature(r.title)}`;
		if (typeof r.status === "string") rev += `|ts:${r.status}`;
		// A gate's status is height-neutral but PAINTED from the cached payload (it picks
		// the row's shimmer colour), so it needs keying for the same reason `status` does:
		// a gate resolving does not necessarily move the tool's own status, and a stale
		// entry would keep a settled row purple.
		if (typeof r.reflectionStatus === "string") rev += `|trs:${r.reflectionStatus}`;
		// Same reason as the card-level `|tq:1` above: painted from the cached payload.
		if (r.queuedBehindUpstream === true) rev += "|trq:1";
		// Per-row `+N -N`, keyed for the same reason the card-level one above is.
		rev += diffStatsRevision(r.diffStats);
		// The row's duration is height-neutral but PAINTED from the cached payload, so
		// it needs the same treatment `timeoutMs` gets above. `status` normally moves
		// with it (running → success arrives together with `durationMs`); this keys the
		// value directly so a duration-only correction cannot serve a stale row.
		if (r.timing != null && typeof r.timing === "object") {
			const duration = (r.timing as Record<string, unknown>).durationMs;
			if (typeof duration === "number") rev += `|tm:${duration}`;
		}
		// The figure actually PAINTED, which for bash is the pure execution time rather
		// than `timing.durationMs` (see `@shared/tool-display-duration`). Keyed
		// separately because it derives from `_metadata.execDurationMs`, which a live
		// patch can land ALONE on an already-terminal status — the same reason
		// `diffStats` above needs its own component. Serving the stale figure would be
		// worse than serving none: a duration looks authoritative.
		if (typeof r.displayDurationMs === "number") rev += `|tmd:${r.displayDurationMs}`;
		// An expandable body is measured as markdown when its row is expanded.
		const body = typeof r.bodyText === "string" ? r.bodyText : r.body;
		if (typeof body === "string") rev += `|tb:${textSignature(body)}`;
		if (r.shimmer === true) rev += "|tw:1";
		// A DRILLED-IN row nests a whole tool card, so the trace's height now depends
		// on that card's own height-bearing fields. `opts.expandedIndices` only tells
		// us WHICH rows are open, not what is inside them — so the one transition it
		// cannot express is the interesting one: loading the full payload replaces the
		// truncated body (which reserved the whole cap) with the exact text, shrinking
		// the card, while spec.key, messageVersion and opts all stay put. Without this
		// the trace would serve the reserved-cap height around exact content.
		//
		// Only expanded rows carry a `card` (the adapter builds nothing for a folded
		// row), so a collapsed fold pays one null check per row.
		// A system-drilled row (live permission form) binds no toggle, so the renderer
		// reads this from the cached payload. It flips with the request while the card
		// payload can stay otherwise identical.
		if (r.pinnedOpen === true) rev += "|tpo:1";
		if (r.card != null && typeof r.card === "object") {
			const card = r.card as Record<string, unknown>;
			if (typeof card.status === "string") rev += `|tds:${card.status}`;
			// The live form's reserve: appears/disappears with the request and grows
			// with the painted height, while status and key can stay put.
			rev += permissionFormRevision(card.permissionForm);
			// A drilled-in card paints its deadline from the cached measured payload.
			// `timeout_updated` changes only this field, so its trace must re-key even
			// though the nested card's height is unchanged.
			if (typeof card.timeoutMs === "number") rev += `|tdto:${card.timeoutMs}`;
			if (typeof card.truncatedLeafCount === "number") rev += `|tdn:${card.truncatedLeafCount}`;
			rev += detailTextRevision(card.detail);
			rev += reflectionRevision(card.reflection);
			// A drilled-in SUBAGENT card is measured with `measureSubagentCard`, so it
			// has the SAME live-patch exposure the standalone card has: the activity /
			// conclusion patches grow it while spec.key, messageVersion and opts all
			// stay put (see `subagentRevision`), and the prompt fold is per-card state
			// the trace's own `opts` never carries. Gated on `agentType` inside, so an
			// ordinary tool card's payload contributes nothing.
			rev += subagentRevision(card);
		}
	}
	return rev;
}

/**
 * Revision of a SubagentCard payload.
 *
 * A subagent card is the one element the LIVE PATCH channel can grow without any
 * of the other key components moving: `spec.key` stays `tool-<toolUseId>`,
 * `applyLivePatch` deliberately keeps `messageVersion` fixed, and the activity /
 * conclusion patches never touch `opts`. Two concrete regressions this closes:
 *
 * - `patchSubagentActivity` writes only `_subagentActivity`, which the adapter
 *   turns into `recentCallCount`. The recent-calls block is pure arithmetic on
 *   that count (measure-subagent's `recentRowCount`), so a card that was measured
 *   with zero calls served a height with the whole block missing — the rows were
 *   then clipped away entirely because the renderer draws `recentCallsHeight`.
 * - `subagentConclusionPatch` writes `outputJson`, which the adapter turns into
 *   `resultText` / `resultPreview`. On a card that is ALREADY `success` with no
 *   error the status does not move, so nothing else in the key changes while the
 *   result preview line (collapsed) or the capped result body (expanded) appears.
 *
 * Gated on `agentType` — required on SubagentCardData and absent from every other
 * element's data — so no other kind pays for the walk.
 *
 * Cost is O(1): primitives plus bounded `textSignature`s (length + 512 sampled
 * chars regardless of body size, see below), and the adapter caps the recent-call
 * names at three short strings. No stringification of the payload.
 */
function subagentRevision(d: Record<string, unknown>): string {
	if (typeof d.agentType !== "string") return "";
	let rev = `|ga:${d.agentType}`;
	// Recent calls: the ROW COUNT is what drives the block height (capped at 3).
	if (typeof d.recentCallCount === "number") rev += `|gn:${d.recentCallCount}`;
	if (Array.isArray(d.recentCallNames)) {
		rev += `|gk:${d.recentCallNames.length}`;
		for (const name of d.recentCallNames) {
			if (typeof name === "string") rev += `|gm:${name}`;
		}
	}
	// Row label detail + category chip. Height-neutral, but PAINTED from the cached
	// payload (the measure layer slices both to the drawn rows), so they need the
	// same treatment `timeoutMs` gets. They are also the ONLY delta in a real case:
	// a live `tool_use_chunk` fills in a call's `inputSummary` while the row count,
	// names and status all stay put — without this the row keeps its bare tool name
	// until the next full rebuild. Bounded: at most 3 short strings each.
	if (Array.isArray(d.recentCallSummaries)) {
		for (const summary of d.recentCallSummaries) {
			if (typeof summary === "string") rev += `|gs:${textSignature(summary)}`;
		}
	}
	if (Array.isArray(d.recentCallCategories)) {
		for (const category of d.recentCallCategories) {
			if (typeof category === "string") rev += `|gc:${category}`;
		}
	}
	if (d.hasRecentCallsButton === true) rev += "|gb:1";
	// Badge labels ride the card's fixed badge row today, so they are height-neutral
	// — keyed anyway because the identity patch writes them ALONE (nothing else in
	// the key would move), which makes them free insurance if that row ever wraps.
	if (typeof d.model === "string") rev += `|go:${d.model}`;
	const inh = d.modelInheritance as { source?: string; model?: string } | undefined;
	if (inh?.source) rev += `|gi:${inh.source}:${inh.model ?? ""}`;
	if (typeof d.reasoningEffort === "string") rev += `|ge:${d.reasoningEffort}`;
	if (d.isBackground === true) rev += "|gg:1";
	// Takeover badge — same fixed badge row as `isBackground`, so height-neutral,
	// but the takeover patch writes it ALONE (the card stays `running` throughout),
	// which makes this the only key component that can move.
	if (d.isTakenOver === true) rev += "|gw:1";
	// Measured bodies: the description wraps when expanded, the prompt and result
	// are measured up to their caps.
	if (typeof d.description === "string") rev += `|gd:${textSignature(d.description)}`;
	if (d.promptBody && typeof d.promptBody === "object")
		rev += leafTextRevision(d.promptBody as Record<string, unknown>);
	if (d.promptOpen === true) rev += "|gq:1";
	// A truncated prompt reserves the full cap, so its height differs from an
	// identical-length complete one; and the flag flips to false when the fetched
	// body lands, which must re-measure the (now exact) block.
	if (d.promptTruncated === true) rev += "|gt:1";
	if (d.resultBody && typeof d.resultBody === "object")
		rev += leafTextRevision(d.resultBody as Record<string, unknown>);
	if (typeof d.resultPreview === "string") rev += `|gv:${textSignature(d.resultPreview)}`;
	if (d.hasResolveOverride === true) rev += "|gx:1";
	// File changes. HEIGHT-AFFECTING (unlike the tool card's `diffStats`): this is a
	// row list, so the count decides the block's height, and the expand flag changes
	// how many rows are drawn. The per-row content is keyed too because the rows are
	// painted from the cached payload — a corrected figure or a reordered list would
	// otherwise keep drawing the previous numbers.
	rev += subagentFileChangesRevision(d.fileChanges);
	if (d.fileChangesExpanded === true) rev += "|gfx:1";
	// Permission blocks force expansion and add their own bodies; presence + count
	// is enough because the bodies themselves are keyed by the permission measure.
	if (d.selfPermission != null) rev += "|gf:1";
	if (Array.isArray(d.pendingPermissions)) rev += `|gz:${d.pendingPermissions.length}`;
	return rev;
}

/**
 * Cache-key fragment for a subagent card's file-change list.
 *
 * The row COUNT is height-bearing; the tallies and per-row figures are painted from
 * the cached payload and so need keying for the same reason `recentCallSummaries`
 * does. Bounded work: the list is already capped by the server's aggregate limit, and
 * each row contributes a short path plus two integers.
 */
function subagentFileChangesRevision(value: unknown): string {
	if (value == null || typeof value !== "object") return "";
	const changes = value as {
		files?: unknown;
		totalFiles?: unknown;
		totalUnmeasured?: unknown;
		bashTouchedCount?: unknown;
		countsTruncated?: unknown;
		attributionScope?: unknown;
		scope?: unknown;
	};
	if (!Array.isArray(changes.files)) return "";
	let rev = `|gfc:${changes.files.length}`;
	// Scope is part of the painted warning/boundary identity, not proof of an
	// attempt. JSON tuples keep delimiters in ids/paths from colliding.
	const scope =
		changes.scope != null && typeof changes.scope === "object"
			? (changes.scope as Record<string, unknown>)
			: null;
	rev += `|gfs:${JSON.stringify([
		changes.attributionScope ?? "legacy_unscoped",
		scope
			? [scope.sourceToolUseId ?? null, scope.startedAt ?? null, scope.completedAt ?? null]
			: null,
	])}`;
	if (typeof changes.totalFiles === "number") rev += `|gft:${changes.totalFiles}`;
	if (typeof changes.totalUnmeasured === "number") rev += `|gfu:${changes.totalUnmeasured}`;
	if (typeof changes.bashTouchedCount === "number") rev += `|gfb:${changes.bashTouchedCount}`;
	if (changes.countsTruncated === true) rev += "|gfr:1";
	for (const file of changes.files) {
		if (file == null || typeof file !== "object") continue;
		const f = file as {
			subagentNarratorId?: unknown;
			deviceId?: unknown;
			workspacePath?: unknown;
			filePath?: unknown;
			linesAdded?: unknown;
			linesRemoved?: unknown;
			editCount?: unknown;
			unmeasuredCount?: unknown;
			outsideParentWorkspace?: unknown;
		};
		rev += `|gfi:${JSON.stringify([
			f.subagentNarratorId ?? null,
			f.deviceId || null,
			f.workspacePath || null,
			f.filePath ?? null,
			f.outsideParentWorkspace ?? null,
		])}`;
		// Written as `a/r` so a corrected figure moves the key; `null` (unmeasured) is
		// deliberately distinct from `0`, matching the data contract.
		rev += `|gfl:${String(f.linesAdded ?? "n")}/${String(f.linesRemoved ?? "n")}`;
		if (typeof f.editCount === "number") rev += `|gfe:${f.editCount}`;
		if (typeof f.unmeasuredCount === "number") rev += `|gfm:${f.unmeasuredCount}`;
	}
	return rev;
}

/**
 * Revision of a measured reflection notice.
 *
 * The notice's height comes from its localized title plus the optional summary /
 * nextSteps lines, all of which change as a gate progresses (running → confirmed
 * rewrites the title and often the summary). Without this the same spec.key would
 * serve the previous status's cached height.
 *
 * `hasTakeOver` is keyed too: the takeover row is measured only when it actually
 * paints (running gates), so it is height-affecting. `status` already moves in
 * lockstep with it today, but keying the flag directly keeps the cache correct if
 * that ever stops being true.
 */
function reflectionRevision(reflection: unknown): string {
	if (reflection == null || typeof reflection !== "object") return "";
	const r = reflection as Record<string, unknown>;
	let rev = "|rf:1";
	if (typeof r.status === "string") rev += `|rs:${r.status}`;
	if (r.hasTakeOver === true) rev += "|rk:1";
	if (typeof r.title === "string") rev += `|rt:${textSignature(r.title)}`;
	if (typeof r.summary === "string") rev += `|ru:${textSignature(r.summary)}`;
	if (typeof r.nextSteps === "string") rev += `|rn:${textSignature(r.nextSteps)}`;
	return rev;
}

/**
 * Capped tool-detail bodies now MEASURE their text (wrapping decides the height),
 * so the same spec.key can legitimately resolve to a different height when the
 * body changes — a plan arriving from a pending permission, an edited plan, or a
 * truncated body replaced by its full text after the async detail fetch.
 *
 * The walk must cover the COMPOSITE shapes too. A multi-part detail keeps its
 * text inside `sections[].body.text` and its result text inside
 * `structured.entries[]`, so reading only the top-level fields would return an
 * empty revision — and a card whose body just grew from a 200-char preview to
 * the full document would hit the stale cache entry and keep the old height,
 * silently defeating the fetch. Cost stays O(sections + entries + rows) with no
 * stringification — each text contributes a bounded `textSignature` rather than
 * being hashed in full.
 */
function detailTextRevision(detail: unknown): string {
	if (detail == null || typeof detail !== "object") return "";
	const d = detail as Record<string, unknown>;
	let rev = "";
	// One production shape; no bare-body or generic detail path.
	if (Array.isArray(d.sections)) {
		rev += `|sc:${d.sections.length}`;
		for (const part of d.sections as unknown[]) {
			if (part == null || typeof part !== "object") continue;
			const p = part as Record<string, unknown>;
			if (typeof p.key === "string") rev += `|sk:${textSignature(p.key)}`;
			if (typeof p.label === "string") rev += `|sl:${p.label}`;
			if (p.body != null && typeof p.body === "object") {
				rev += leafTextRevision(p.body as Record<string, unknown>);
			}
		}
	}
	return rev;
}

/**
 * Content signature of a measured string: exact length plus a sampled hash.
 *
 * Length alone is NOT enough for bodies whose height comes from how the text
 * wraps. `documentRevision` (the message version) covers most in-place content
 * swaps, but not the pending-permission plan injection: that path rebuilds the
 * layout from the SAME loaded input, so the version never moves. Two same-length
 * bodies with different line structure then share a cache key — measured at
 * 104px vs 164px at one width, so one of them is simply wrong.
 *
 * Sampling is STRIDED over the whole string rather than a contiguous prefix. The
 * measure layer parses up to `DETAIL_MARKDOWN_PREFIX_MAX_CHARS` (32KB), so a
 * prefix window smaller than that would leave a blind band where an edit changes
 * the measured height without changing the key. A fixed sample count keeps the
 * cost O(1) even for megabyte bodies (~0.1ms for 2MB) while covering every
 * region the measure layer can read.
 *
 * A miss therefore requires the same length AND the same character at all
 * sampled positions — a collision this cache treats as acceptable, matching how
 * `digestOpts` trades exactness for speed on the scroll path.
 */
const REVISION_HASH_SAMPLES = 512;

function textSignature(text: string): string {
	return measureCache.signatureForText(text);
}

/** Original signature algorithm; cache misses and oversized text take this path. */
function computeTextSignature(text: string): string {
	const len = text.length;
	let hash = 0x811c9dc5;
	const mix = (code: number) => {
		hash ^= code;
		// FNV prime via shifts, kept in 32-bit unsigned range.
		hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
	};
	if (len <= REVISION_HASH_SAMPLES) {
		for (let i = 0; i < len; i++) mix(text.charCodeAt(i));
	} else {
		const stride = len / REVISION_HASH_SAMPLES;
		for (let s = 0; s < REVISION_HASH_SAMPLES; s++) {
			mix(text.charCodeAt(Math.floor(s * stride)));
		}
		// Anchor the tail: a strided walk can stop short of the final characters.
		mix(text.charCodeAt(len - 1));
	}
	return `${len}.${hash.toString(36)}`;
}

/** Source coordinates only; viewport projections, scrollTop and reader anchors never enter keys. */
function sourceRangeRevision(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const range = value as Record<string, unknown>;
	const fields = [
		"epoch",
		"startOffset",
		"endOffset",
		"startLine",
		"startColumn",
		"endLine",
		"endColumn",
		"originKnown",
		"complete",
	];
	let rev = `|range:${fields.map((key) => textSignature(String(range[key]))).join("/")}`;
	if (range.remap && typeof range.remap === "object") {
		const remap = range.remap as Record<string, unknown>;
		rev +=
			"|remap:" +
			[
				"fromEpoch",
				"fromStartOffset",
				"fromEndOffset",
				"fromStartLine",
				"offsetDelta",
				"lineDelta",
				"columnDelta",
			]
				.map((key) => textSignature(String(remap[key])))
				.join("/");
	}
	return rev;
}

function sourcePointRevision(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const point = value as Record<string, unknown>;
	return (
		"|focus:" +
		["side", "epoch", "line", "column", "offset"]
			.map((key) => textSignature(String(point[key])))
			.join("/")
	);
}

/** Content-signature revision of one NON-composite detail body. */
function leafTextRevision(d: Record<string, unknown>): string {
	let rev = "";
	if (d.textDocument && typeof d.textDocument === "object") {
		const doc = d.textDocument as Record<string, unknown>;
		rev += `|doc:${doc.id}:${doc.epoch}:${doc.revision}:${doc.length}:${doc.complete}`;
	}
	if (typeof d.text === "string") rev += `|tx:${textSignature(d.text)}`;
	for (const key of [
		"id",
		"source",
		"format",
		"revision",
		"cap",
		"codeLang",
		"codeLangPath",
		"customHighlight",
		"sourcePath",
		"kind",
	] as const) {
		if (d[key] != null) rev += `|${key}:${textSignature(String(d[key]))}`;
	}
	if (d.textDocumentError === true) rev += "|docError:1";
	if (d.textDocumentSource && typeof d.textDocumentSource === "object") {
		const source = d.textDocumentSource as Record<string, unknown>;
		rev += `|docSource:${source.narratorId}:${source.toolUseId}:${source.toolCallId}:${source.messageId}:${source.executionAttempt}`;
	}
	if (d.live === true) rev += "|live:1";
	if (d.textTruncated === true) rev += "|cut:1";
	if (typeof d.contentLines === "number") rev += `|cl:${d.contentLines}`;
	if (typeof d.contentPx === "number") rev += `|cp:${d.contentPx}`;
	rev += sourceRangeRevision(d.range);
	if (d.diffDocument && typeof d.diffDocument === "object") {
		const doc = d.diffDocument as Record<string, unknown>;
		rev += `|dr:${textSignature(String(doc.revision))}`;
		rev += sourcePointRevision(doc.focus);
		for (const key of ["oldSource", "newSource"] as const) {
			const source = doc[key] as Record<string, unknown> | undefined;
			rev += sourceRangeRevision(source?.range);
		}
	}
	if (d.followTarget && typeof d.followTarget === "object") {
		const target = d.followTarget as Record<string, unknown>;
		rev += `|ft:${target.kind}${sourcePointRevision(target.focus)}`;
	}
	if (d.media && typeof d.media === "object") {
		const media = d.media as Record<string, unknown>;
		for (const key of [
			"width",
			"height",
			"previewUrl",
			"filePath",
			"imageId",
			"filename",
		] as const) {
			if (media[key] != null) rev += `|m${key}:${textSignature(String(media[key]))}`;
		}
	}
	// Structured results: entry count + per-entry title/snippet signatures.
	if (Array.isArray(d.entries)) {
		rev += `|en:${d.entries.length}`;
		for (const entry of d.entries as unknown[]) {
			if (entry == null || typeof entry !== "object") continue;
			const e = entry as Record<string, unknown>;
			if (typeof e.title === "string") rev += `|et:${textSignature(e.title)}`;
			if (typeof e.snippet === "string") rev += `|es:${textSignature(e.snippet)}`;
		}
	}
	// Ask replay: an AskUserQuestion card keeps its spec.key across the whole
	// lifecycle, so the answer landing (or a truncated payload being replaced by the
	// full one) must move the revision — otherwise the answered card serves the
	// unanswered card's cached height and the answer row is clipped away.
	if (Array.isArray(d.questions)) {
		rev += `|aq:${d.questions.length}`;
		for (const question of d.questions as unknown[]) {
			if (question == null || typeof question !== "object") continue;
			const q = question as Record<string, unknown>;
			if (typeof q.header === "string") rev += `|ah:${textSignature(q.header)}`;
			if (q.omitHeader === true) rev += "|ao:1";
			if (typeof q.answer === "string") rev += `|aa:${textSignature(q.answer)}`;
			if (typeof q.customAnswer === "string") rev += `|ac:${textSignature(q.customAnswer)}`;
			if (!Array.isArray(q.options)) continue;
			rev += `|an:${q.options.length}`;
			for (const option of q.options as unknown[]) {
				if (option == null || typeof option !== "object") continue;
				const o = option as Record<string, unknown>;
				if (typeof o.header === "string") rev += `|al:${textSignature(o.header)}`;
				else if (typeof o.label === "string") rev += `|al:${textSignature(o.label)}`;
				if (typeof o.description === "string") rev += `|ad:${textSignature(o.description)}`;
				// Selection is height-neutral on its own, but it flips with the answer and
				// keeping it here makes the revision a faithful digest of the payload.
				if (o.selected === true) rev += "|as:1";
			}
		}
	}
	// Meta rows: row count + per-row text signatures.
	if (Array.isArray(d.rows)) {
		rev += `|mr:${d.rows.length}`;
		for (const row of d.rows as unknown[]) {
			if (row == null || typeof row !== "object") continue;
			const r = row as Record<string, unknown>;
			if (typeof r.text === "string") rev += `|mt:${textSignature(r.text)}`;
		}
	}
	// Body lines: count only (each line is short and the count drives the height).
	if (Array.isArray(d.bodyLines)) rev += `|bl:${d.bodyLines.length}`;
	return rev;
}

function optsIsEmpty(opts: Record<string, unknown>): boolean {
	for (const _k in opts) return false;
	return true;
}

/**
 * Produce a compact, deterministic string digest of the opts record.
 * Opts values are booleans, numbers, small arrays of numbers, or undefined.
 * We sort keys for stability and encode values concisely.
 */
function digestOpts(opts: Record<string, unknown>): string {
	const keys = Object.keys(opts).sort();
	let result = "";
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i];
		if (!k) continue;
		const v = opts[k];
		if (v === undefined) continue;
		if (result.length > 0) result += ";";
		result += `${k}=`;
		if (k === "fileReferenceContext") {
			// Height-neutral provenance still changes the rendered links/memo identity.
			result += JSON.stringify(normalizeFileReferenceContext(v));
		} else if (typeof v === "boolean") {
			result += v ? "1" : "0";
		} else if (typeof v === "number") {
			result += String(v);
		} else if (Array.isArray(v)) {
			// Small sorted array of numbers (expandedIndices, expandedRows)
			const sorted = (v as number[]).slice().sort((a, b) => a - b);
			result += sorted.join(",");
		} else if (v instanceof Set) {
			const sorted = [...v].sort();
			result += sorted.join(",");
		} else if (typeof v === "string") {
			result += v;
		} else {
			// Unknown complex value — include a marker to ensure cache miss
			// rather than a stale hit.
			result += `?${typeof v}`;
		}
	}
	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level singleton
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Module-level cache shared by all measureElement calls.
 *
 * Ceiling 131072 accommodates:
 * - A 30k-message narrator ≈ 60k items (well within ceiling)
 * - Plus stale entries from 1-2 previously-viewed narrators before bulk-clear fires
 *
 * No per-entry eviction. The working set is always fully retained.
 */
export const measureCache = new MeasureCache(131072);
