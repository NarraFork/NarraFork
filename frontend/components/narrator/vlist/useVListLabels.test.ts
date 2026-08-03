/**
 * useVListLabels.test.ts — Locks the vlist localization contract.
 *
 * The vlist layers cannot import i18n (CONTRACT.md §0), so every user-visible
 * string reaches them through injection. The regressions this guards against are
 * both silent — a kind renders correct-looking ENGLISH instead of the active
 * language, with no type error and no crash:
 *
 *   1. A render kind that paints chrome but has no entry in `renderLabelsForKind`
 *      (and no explicit branch in the shell's injectRenderLabels).
 *   2. An adapter chrome key with no injected translation, silently falling back
 *      to SYSTEM_LABEL_FALLBACKS.
 *
 * The hook itself needs React + i18next, so these tests exercise the PURE parts:
 * the kind→bundle mapping and the adapter-key coverage (read from the module
 * source, which is what the shell actually passes).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	reflectionTitleKeyPrefix,
	reflectionTitleKeySuffix,
} from "@shared/pretext-layout/reflection";
import { VLIST_ELEMENT_KINDS } from "./registry";
import {
	reflectionTitleLabels,
	renderLabelsForKind,
	type VListRenderLabels,
} from "./useVListLabels";

/** A recognizable stub per bundle so mapping errors are visible. */
const STUB_LABELS = {
	reasoning: { tag: "reasoning" },
	toolCall: { tag: "toolCall" },
	toolCallGroup: { label: "group", statusLabel: "pending" },
	trace: { tag: "trace" },
	subagent: { tag: "subagent" },
	permission: { tag: "permission" },
	askUserQuestion: { tag: "askUserQuestion" },
	askInPassing: { tag: "askInPassing" },
	planCard: "plan",
	pruneDivider: "pruned",
} as unknown as VListRenderLabels;

/**
 * Kinds that legitimately receive NO `labels` bundle, with the reason. Anything
 * else must map to a bundle — that is the point of the test below.
 */
const NO_LABELS_KINDS: Record<string, string> = {
	// Pure text/geometry: all display text comes from the measured content.
	"message-bubble": "text comes from measured content",
	markdown: "text comes from measured content",
	media: "filenames / images only",
	"web-search": "query text comes from measured content",
	"system-simple": "card text composed by the adapter (ctx.labels)",
	"system-text": "card text composed by the adapter (ctx.labels)",
	"knowledge-hint": "entry titles come from measured content",
	// Localized through a dedicated shell branch instead of a `labels` bundle.
	"plan-card": "shell injects extra.label",
	"tool-call-group": "shell injects extra.label + extra.statusLabel",
	"prune-divider": "shell injects extra.fallbackLabel",
	// Count lines carry adapter-composed header text as DATA (it embeds the live
	// count), mapped onto render labels by resolveRenderExtra.
	"tool-run-count": "header text arrives as adapter data",
	"reasoning-count": "header text arrives as adapter data",
	// Usage rows are composed entirely by the shared formatter (numbers + fixed
	// ASCII units), so there is no translatable chrome to inject.
	"turn-usage": "lines composed by the shared turn-usage formatter",
	// RenderSubagentRecovery declares no `labels` prop: its card text is composed by
	// the adapter (ctx.labels) and its two buttons read the measured block data.
	"subagent-recovery": "card text composed by the adapter (ctx.labels)",
};

describe("renderLabelsForKind — every chrome-painting kind is localizable", () => {
	it("maps each registered kind to a bundle or a documented exemption", () => {
		const unmapped: string[] = [];
		for (const kind of VLIST_ELEMENT_KINDS) {
			const labels = renderLabelsForKind(kind, STUB_LABELS);
			if (labels === undefined && !(kind in NO_LABELS_KINDS)) unmapped.push(kind);
		}
		expect(unmapped).toEqual([]);
	});

	it("does not hand a bundle to kinds documented as label-free", () => {
		// A stray mapping would send e.g. reasoning labels to a markdown block.
		for (const kind of Object.keys(NO_LABELS_KINDS)) {
			expect(renderLabelsForKind(kind, STUB_LABELS)).toBeUndefined();
		}
	});

	it("routes each chrome kind to its own bundle (no cross-wiring)", () => {
		expect(renderLabelsForKind("reasoning", STUB_LABELS)).toBe(STUB_LABELS.reasoning);
		expect(renderLabelsForKind("tool-call", STUB_LABELS)).toBe(STUB_LABELS.toolCall);
		expect(renderLabelsForKind("subagent-card", STUB_LABELS)).toBe(STUB_LABELS.subagent);
		expect(renderLabelsForKind("inline-permission", STUB_LABELS)).toBe(STUB_LABELS.permission);
		expect(renderLabelsForKind("ask-user-question", STUB_LABELS)).toBe(STUB_LABELS.askUserQuestion);
		expect(renderLabelsForKind("ask-in-passing", STUB_LABELS)).toBe(STUB_LABELS.askInPassing);
		// The three folded-trace kinds share one bundle (same CollapsibleTrace chrome).
		for (const kind of ["tool-run-summary", "activity-trace", "reasoning-steps"] as const) {
			expect(renderLabelsForKind(kind, STUB_LABELS)).toBe(STUB_LABELS.trace);
		}
	});
});

describe("adapter chrome keys — every fallback has an injected translation", () => {
	it("injects every SYSTEM_LABEL_FALLBACKS key", () => {
		// The adapter falls back to English for any key the shell fails to inject,
		// so the fallback table is the authoritative list of what must be injected.
		const adapterSrc = readFileSync(
			join(import.meta.dir, "../../../../shared/pretext-layout/segment-adapter.ts"),
			"utf8",
		);
		const table = adapterSrc.slice(
			adapterSrc.indexOf("const SYSTEM_LABEL_FALLBACKS"),
			adapterSrc.indexOf("/** Resolve a system-card chrome label"),
		);
		const fallbackKeys = [...table.matchAll(/^\t([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]);
		// Sanity-check the extraction itself before asserting on it.
		expect(fallbackKeys.length).toBeGreaterThan(20);
		expect(fallbackKeys).toContain("activityTraceCount");

		const hookSrc = readFileSync(join(import.meta.dir, "useVListLabels.ts"), "utf8");
		const injected = hookSrc.slice(
			hookSrc.indexOf("const adapterLabels"),
			hookSrc.indexOf("const renderLabels"),
		);
		// The reflection titles are injected as a generated MATRIX rather than 24
		// literal entries, so ask the real generator which keys it covers. A kind or
		// status dropped from that matrix still fails this guard.
		const generated = new Set(Object.keys(reflectionTitleLabels((key) => key)));
		const missing = fallbackKeys.filter(
			(key) => !generated.has(key) && !new RegExp(`\\b${key}:`).test(injected),
		);
		expect(missing).toEqual([]);
	});

	it("generates a title for every reflection kind × status the adapter can request", () => {
		// The adapter builds `${prefix}Reflection${Suffix}` from the shared helpers,
		// so the generated bundle must cover their full cross product — a missing key
		// would silently measure the English fallback while painting it too.
		const labels = reflectionTitleLabels((key) => key);
		const kinds = [
			"danger_reflection",
			"plan_reflection",
			"question_reflection",
			"task_reflection",
		] as const;
		const statuses = ["running", "awaiting_user", "confirmed", "cancelled", "aborted"] as const;
		for (const kind of kinds) {
			for (const status of statuses) {
				const key = `${reflectionTitleKeyPrefix(kind)}Reflection${reflectionTitleKeySuffix(status)}`;
				expect(labels[key]).toBe(key);
			}
		}
	});
});
