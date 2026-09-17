/**
 * mock-stream-corpus.ts — The FIXED content the harness streams.
 *
 * TEMPORARY MODULE (see ./README-REMOVAL.md).
 *
 * Fixed, not generated. A calibration harness is only useful if two runs are
 * byte-identical, and "one markdown body that contains every element" is more
 * valuable than random filler: a single run then exercises every measurer in
 * `vlist/measure/` and every branch of `shared/pretext-layout/parse-markdown.ts`
 * at once.
 *
 * Coverage of the markdown pipeline's block kinds:
 *   - headings h1..h4 (each has its own font size + margin rule)
 *   - paragraphs with inline code, bold, italic, links, CJK/latin mixing
 *   - INLINE math (`$…$`) — measured by katex-geometry inside the line box
 *   - DISPLAY math (`$$…$$`) — its own unknown-height block
 *   - fenced code, multi-line, with a language (Shiki-highlighted, 11px/1.55)
 *   - mermaid fence — an UNKNOWN-height block that reports its real height after
 *     paint (the CONTRACT's controlled exception; the single most interesting
 *     case for scroll-anchor tuning)
 *   - tables, including column alignment, inline code in cells and math in cells
 *   - unordered / ordered / nested lists
 *   - blockquote (padding + inline border)
 *   - thematic break
 *
 * Tool bodies are shaped for the REAL classifiers in
 * `shared/pretext-layout/tool-detail.ts`: a `Read` output is file text, an `Edit`
 * carries `old_string`/`new_string` so the card renders a diff, a `Write` to
 * `spec://tasks.json` renders the task board, `ExitPlanMode` renders markdown.
 * Feeding shapes the classifiers do not recognise would fall through to a JSON
 * dump and the harness would be measuring the wrong card.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Reasoning (plain prose — reasoning is never markdown-rendered)
// ─────────────────────────────────────────────────────────────────────────────

export const REASONING_ROUNDS: readonly string[] = [
	"Let me work out what this request actually needs. The user wants one body that contains every markdown element, so the corpus has to cover headings, inline and display math, fenced code, a mermaid diagram, tables with alignment, and the three list shapes. I should also check how the measurement path treats an unknown-height block, because mermaid reports its real height only after paint and that is where the scroll anchor is most likely to jump.",
	"The first two tool calls came back with what I expected. The file is smaller than I assumed, which means the edit can be a single hunk rather than a rewrite. Before touching it I want to confirm the call sites, otherwise a signature change would break the callers silently. 混排一段中文来验证换行与宽度结算：当一行里同时出现中文、latin words 和 `inline_code` 时，行盒高度必须由最高的那个 run 决定。",
	"Two things stand out from the search results. First, the pattern appears in more places than the issue described, so a narrow fix would leave the same bug in the other two call sites. Second, one of those sites is inside a hot loop, which changes the trade-off: the straightforward fix allocates per iteration. I will write the shared helper first and then route all three sites through it.",
	"That covers the implementation. Worth restating what is verified versus assumed: the type checker and the unit tests both pass, and I read the diff back to confirm the hunk landed where intended. What I have not verified is behaviour under a real workload, because that needs the running server, so the performance claim stays an expectation rather than a measurement.",
];

// ─────────────────────────────────────────────────────────────────────────────
// Assistant text — one markdown element inventory, split across rounds
// ─────────────────────────────────────────────────────────────────────────────

/** Round 1: headings, paragraphs, inline code/emphasis/links, lists, blockquote. */
const TEXT_ROUND_1 = `# Layout calibration pass

Reading the request back: one markdown body that exercises **every** element, with
*multi-round* structure so a tool call is followed by more reasoning. The entry point
is \`PretextExactMessageList\`, and heights come from \`measure-markdown.ts\` — see the
[layout contract](https://example.invalid/contract) for the invariants.

## What this covers

- Inline code such as \`useVListStreamingMessage\` and \`narratorWSManager\`
- Emphasis: **bold**, *italic*, ***both***, and ~~struck through~~
- 中英混排：一行里同时出现 \`inline_code\`、latin words 和中文字符
- A link that wraps mid-paragraph rather than sitting on its own line

### Ordered steps

1. Parse the source into prepared blocks
2. Measure each block against the available width
3. Reserve the row height before the row is ever painted
   1. Predictable blocks resolve purely
   2. Unknown-height blocks report back after paint

> A prediction that disagrees with the browser is a bug, not a tolerance.
> The harness exists so that disagreement is reproducible.

---

#### Next

The sections below add math, code, a diagram and tables.`;

/** Round 2: fenced code + mermaid (the unknown-height block). */
const TEXT_ROUND_2 = `## Implementation shape

The accumulator folds one delta at a time and returns where it landed, so the caller
can stamp the row with the lane still being written:

\`\`\`ts
export function applyStreamingDelta(
	blocks: StreamingBlock[],
	event: StreamDeltaEvent | undefined,
	isSubagent: boolean,
): StreamDeltaResult {
	if (!event || event.type !== "content_block_delta") return NOT_APPLIED;
	// A text delta carries its lane on the EVENT; reasoning on the DELTA.
	const outputIndex =
		typeof event.outputIndex === "number" ? event.outputIndex : undefined;
	return { applied: true, blockIndex: findStreamingInsertIndex(blocks, outputIndex) };
}
\`\`\`

And a shell block, which highlights under a different grammar:

\`\`\`bash
bun test frontend/components/narrator/vlist --coverage
bunx tsgo --noEmit | tail -20
\`\`\`

### Frame flow

A mermaid fence is the interesting case: its height is intrinsic to the rendered SVG,
so it is reserved as a placeholder and corrected after paint.

\`\`\`mermaid
graph TD
    A[stream_event] --> B{delta type}
    B -->|text_delta| C[text lane]
    B -->|reasoning_delta| D[reasoning lane]
    C --> E[buildStreamingMsg]
    D --> E
    E --> F[measure row]
    F --> G[paint canvas]
    G --> H{height matches?}
    H -->|yes| I[settled]
    H -->|no| J[correct + reflow]
\`\`\``;

/** Round 3: inline + display math, tables with alignment and mixed cell content. */
const TEXT_ROUND_3 = `## Cost model

Let $n$ be the number of loaded rows and $w$ the content width. A naive relayout is
$O(n)$ per frame, so with $n \\approx 4000$ the frame budget of $16.7\\,\\mathrm{ms}$ is
gone before paint. The incremental path keeps it at $O(\\log n)$ amortised.

The settled cost of one streaming frame, as a multi-line \`aligned\` block:

$$
\\begin{aligned}
C_{\\text{frame}} &= \\underbrace{c_{\\text{parse}} \\cdot \\Delta}_{\\text{new}} +
 \\underbrace{\\sum_{i \\in D} m(b_i, w)}_{\\text{dirty}} \\\\
 &\\quad + c_{\\text{paint}} \\cdot |V|
\\end{aligned}
$$

where $D$ is the dirty set and $V$ the visible window. A second display formula, to
check vertical rhythm between two stacked blocks:

$$
\\frac{\\partial H}{\\partial w} = \\sum_{i=1}^{n} \\left\\lceil \\frac{L_i}{w} \\right\\rceil \\cdot h_{\\text{line}}
$$

### Measured stages

| Stage | Budget | Actual | Notes |
| :--- | ---: | :---: | --- |
| Parse | 2.0 ms | 1.4 ms | \`parse-markdown\` |
| Measure | 6.0 ms | $5.2$ ms | cache hit rate $0.93$ |
| Paint | 8.0 ms | 7.1 ms | visible window only |
| **Total** | **16.7 ms** | **13.7 ms** | 中文列也要对齐 |

A second table with no alignment row and wider cells:

| Element | Height source |
| --- | --- |
| Paragraph | pure arithmetic over the font metrics |
| Fenced code | line count × 11px/1.55 line box |
| Display math | \`katex-geometry\`, exact |
| Mermaid | unknown until painted |`;

/** Round 4: closing prose + a compact recap table. */
const TEXT_ROUND_4 = `## Result

The pass is complete. Predicted and actual heights agree within tolerance for every
block kind except the mermaid diagram, which by design reports its height after paint
and is corrected in the same frame.

| Check | Status |
| --- | :---: |
| \`bunx tsgo --noEmit\` | pass |
| \`bun test frontend/\` | pass |
| Height delta $\\le 4\\,\\mathrm{px}$ | pass |

One caveat worth stating plainly: the frame-budget numbers above come from a scripted
replay, not from a real model turn, so they describe *this harness* rather than
production latency.`;

export const TEXT_ROUNDS: readonly string[] = [
	TEXT_ROUND_1,
	TEXT_ROUND_2,
	TEXT_ROUND_3,
	TEXT_ROUND_4,
];

// ─────────────────────────────────────────────────────────────────────────────
// Tool calls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One scripted tool call.
 *
 * `streamFields` is the ORDER in which the model writes the arguments — the card
 * renders a different provisional body per field (an `Edit` shows a matching-phase
 * diff while `old_string` arrives and a replacing-phase diff once `new_string`
 * starts), so the order is part of what is being exercised.
 */
export interface MockToolSpec {
	toolName: string;
	/** Resolved arguments, as `tool_started` delivers them. */
	input: Record<string, unknown>;
	/** Argument fields streamed before `tool_started`, in write order. */
	streamFields: readonly string[];
	/**
	 * Terminal output. A plain STRING, matching the real wire format
	 * (`narrator-session.ts` sends `result.output`, or `{_text,_metadata}` when it
	 * has metadata) — an array here would be JSON-dumped by `resolveDisplayText`
	 * and the card would show structure instead of content.
	 */
	output: string;
	/** Terminal status; `fail` exercises the error-tinted card. */
	status?: "success" | "fail";
	/** Extra `tool_completed.metadata`, e.g. `totalLines` for a Read header. */
	metadata?: Record<string, unknown>;
	/** Whether stdout should stream incrementally before completion (bash-like). */
	streamOutput?: boolean;
}

const SAMPLE_FILE = "frontend/components/narrator/vlist/measure-cache.ts";

const READ_OUTPUT = `/**
 * measure-cache.ts — Memoized block measurement keyed by content + width.
 */

export interface MeasureCacheKey {
	blockId: string;
	width: number;
	lod: RenderLod;
}

export function createMeasureCache(budget: number): MeasureCache {
	const entries = new Map<string, CachedMeasure>();
	let bytes = 0;

	function evictUntilUnderBudget(): void {
		for (const [key, entry] of entries) {
			if (bytes <= budget) break;
			entries.delete(key);
			bytes -= entry.bytes;
		}
	}

	return {
		get(key) {
			return entries.get(serializeKey(key));
		},
		set(key, value) {
			entries.set(serializeKey(key), value);
			bytes += value.bytes;
			evictUntilUnderBudget();
		},
	};
}`;

const GREP_OUTPUT = `frontend/components/narrator/vlist/measure-cache.ts:41:	const cached = cache.get(key);
frontend/components/narrator/vlist/measure-cache.ts:88:	cache.set(key, measured);
frontend/components/narrator/vlist/pretext-layout-coordinator.ts:512:	const cached = cache.get(rowKey);
frontend/components/narrator/vlist/pretext-layout-coordinator.ts:604:		cache.set(rowKey, next);
frontend/components/narrator/vlist/usePretextDocument.ts:233:	const cached = cache.get(documentKey);

5 matches across 3 files`;

const BASH_OUTPUT = `bun test v1.3.14 (0d9b296a)

frontend/components/narrator/vlist/measure-cache.test.ts:
(pass) measure cache > returns a cached measurement for an identical key
(pass) measure cache > misses when the width changes
(pass) measure cache > misses when the LOD changes
(pass) measure cache > evicts the oldest entry once over budget
(pass) measure cache > reports its byte footprint

frontend/components/narrator/vlist/pretext-layout-coordinator.test.ts:
(pass) layout coordinator > reuses cached heights for untouched rows
(pass) layout coordinator > re-measures only the dirty set

 7 pass
 0 fail
 34 expect() calls
Ran 7 tests across 2 files. [412.00ms]`;

const WEB_SEARCH_OUTPUT = `1. Virtual scrolling with variable row heights — https://example.invalid/a
   Discusses measure-then-place versus estimate-then-correct, and why an
   estimate that is wrong in the visible window costs a visible jump.

2. Scroll anchoring in practice — https://example.invalid/b
   Browser-level anchoring interacts badly with a manually positioned canvas;
   the recommendation is to own the anchor rather than fight it.

3. Incremental text measurement — https://example.invalid/c
   Prefix caching for growing strings; matches the streaming-block-cache
   approach of measuring only the new suffix.`;

const AGENT_OUTPUT = `Traced every consumer of the measure cache.

Findings:
- 3 call sites read it: measure-cache.ts (own API), pretext-layout-coordinator.ts
  (row heights) and usePretextDocument.ts (document-level layout).
- Only the coordinator writes on the hot path; the other two write once per
  document load.
- The width key is a float in one site and rounded in another, so the same row
  can occupy two cache entries at widths that differ by a sub-pixel amount.

That last point is the actual bug behind the reported cache-miss rate.`;

const PLAN_BODY = `## Approach

Route all three call sites through one \`resolveMeasureKey()\` helper that rounds the
width to an integer before serializing.

### Steps

1. Add \`resolveMeasureKey()\` to \`measure-cache.ts\` (pure, unit-tested)
2. Replace the inline key construction in \`pretext-layout-coordinator.ts\`
3. Replace the inline key construction in \`usePretextDocument.ts\`
4. Add a regression test: two widths differing by $0.4\\,\\mathrm{px}$ must hit the
   same entry

### Risk

Rounding changes which entry a lookup finds, so a stale entry measured at the
unrounded width could be reused. Mitigated by bumping the cache's schema tag, which
drops every pre-existing entry on first load.`;

const SPEC_TASKS_CONTENT = `{
	"tasks": [
		{ "text": "Add resolveMeasureKey() with width rounding", "status": "done" },
		{ "text": "Route the coordinator through the shared key helper", "status": "doing" },
		{ "text": "Route usePretextDocument through the shared key helper", "status": "todo" },
		{ "text": "Add a sub-pixel width regression test", "status": "todo" },
		{ "text": "Run tsgo + biome + the vlist suite and fix fallout", "status": "todo", "protected": true }
	]
}`;

const EDIT_OLD = `	const cached = cache.get({ blockId, width: contentWidth, lod });
	if (cached) return cached.height;
	const measured = measureBlock(block, contentWidth, lod);
	cache.set({ blockId, width: contentWidth, lod }, measured);
	return measured.height;`;

const EDIT_NEW = `	// A sub-pixel width difference must not split one row across two entries:
	// the container reports a fractional width and the same row then measured
	// twice, which is the whole of the reported cache-miss rate.
	const key = resolveMeasureKey(blockId, contentWidth, lod);
	const cached = cache.get(key);
	if (cached) return cached.height;
	const measured = measureBlock(block, contentWidth, lod);
	cache.set(key, measured);
	return measured.height;`;

const WRITE_CONTENT = `/**
 * resolve-measure-key.ts — One canonical cache key for a measured block.
 */

import type { RenderLod } from "../lod/RenderLodCtx";
import type { MeasureCacheKey } from "./measure-cache";

/**
 * Build a measurement key with the width rounded to whole pixels.
 *
 * The container's reported width is fractional, so two frames of the same layout
 * can differ by a fraction of a pixel and produce two entries for one row. A row
 * never renders differently for a 0.4px width change, so rounding is lossless
 * here and removes the duplicate.
 */
export function resolveMeasureKey(
	blockId: string,
	width: number,
	lod: RenderLod,
): MeasureCacheKey {
	return { blockId, width: Math.round(width), lod };
}`;

/**
 * Tool calls per round, chosen so each round exercises DIFFERENT card bodies:
 * a code box, a match list, a diff, a terminal transcript, a markdown plan, a
 * task board, and a failing call.
 */
export const TOOL_ROUNDS: readonly (readonly MockToolSpec[])[] = [
	// Round 1 — locate and read.
	[
		{
			toolName: "Glob",
			input: { pattern: "frontend/components/narrator/vlist/measure*.ts" },
			streamFields: ["pattern"],
			output: `frontend/components/narrator/vlist/measure-cache.ts
frontend/components/narrator/vlist/measure-cache.test.ts

2 files`,
		},
		{
			toolName: "Read",
			input: { file_path: SAMPLE_FILE },
			streamFields: ["file_path"],
			output: READ_OUTPUT,
			metadata: { totalLines: 34 },
		},
		{
			toolName: "Grep",
			input: { pattern: "cache\\.(get|set)\\(", path: "frontend/components/narrator/vlist" },
			streamFields: ["pattern", "path"],
			output: GREP_OUTPUT,
		},
	],
	// Round 2 — delegate, then edit.
	[
		{
			toolName: "Agent",
			input: {
				subagent_type: "explore",
				description: "Trace measure cache consumers",
				prompt:
					"Find every consumer of the measure cache in the vlist directory. Report which sites read versus write, which are on the hot path, and whether the cache key is constructed consistently. Return findings, not file contents.",
			},
			streamFields: ["subagent_type", "description", "prompt"],
			output: AGENT_OUTPUT,
		},
		{
			toolName: "Edit",
			input: { file_path: SAMPLE_FILE, old_string: EDIT_OLD, new_string: EDIT_NEW },
			// Edit writes old_string first: the card shows a matching-phase diff, then
			// flips to replacing once new_string starts arriving.
			streamFields: ["file_path", "old_string", "new_string"],
			output: "Edited frontend/components/narrator/vlist/measure-cache.ts (1 hunk, +8 -3)",
			metadata: { startLine: 41 },
		},
	],
	// Round 3 — write, verify, research; includes one failure.
	[
		{
			toolName: "Write",
			input: {
				file_path: "frontend/components/narrator/vlist/resolve-measure-key.ts",
				content: WRITE_CONTENT,
			},
			streamFields: ["file_path", "content"],
			output: "Wrote 812 bytes to frontend/components/narrator/vlist/resolve-measure-key.ts",
		},
		{
			toolName: "Bash",
			input: {
				command: "bun test frontend/components/narrator/vlist/measure-cache.test.ts",
				description: "Run the measure cache suite",
			},
			streamFields: ["command"],
			output: BASH_OUTPUT,
			streamOutput: true,
		},
		{
			toolName: "Bash",
			input: {
				command: "bunx tsgo --noEmit --strictNullChecks=false",
				description: "Type check with an unsupported flag",
			},
			streamFields: ["command"],
			output:
				"error: unknown option '--strictNullChecks=false'\n\nUse `bunx tsgo --help` to see available options.",
			status: "fail",
			streamOutput: true,
		},
		{
			toolName: "WebSearch",
			input: { query: "variable row height virtual list scroll anchoring 2026" },
			streamFields: ["query"],
			output: WEB_SEARCH_OUTPUT,
		},
	],
	// Round 4 — plan card + task board.
	[
		{
			toolName: "Write",
			input: { file_path: "spec://tasks.json", content: SPEC_TASKS_CONTENT },
			streamFields: ["file_path", "content"],
			output: "Wrote 421 bytes to spec://tasks.json",
		},
		{
			toolName: "ExitPlanMode",
			input: { plan: PLAN_BODY },
			streamFields: ["plan"],
			output: "Plan approved.",
		},
	],
];

/** How many rounds the fixed script defines. */
export const MOCK_ROUND_COUNT = Math.max(
	REASONING_ROUNDS.length,
	TEXT_ROUNDS.length,
	TOOL_ROUNDS.length,
);
