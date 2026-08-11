/**
 * render-registry.tsx — Render dispatch for the pretext vlist, symmetric to
 * registry.ts's `measureElement`. Given an element kind + its MeasuredElement
 * (+ per-kind extra props), returns the matching RenderXxx副本 as a React node.
 *
 * The prop shapes here mirror exactly what VListHarness proved wires correctly
 * for each RenderXxx (role / kind / label / isSearching / injection slots …).
 * Injection slots that need app-level callbacks (avatarSlot, resolveImageSrc,
 * onOpenEntry, labels) are passed through `extra` by the integration layer; the
 * dispatch never fabricates them.
 *
 * This is a .tsx module (returns JSX) and is imported only by the render layer /
 * PretextMessageList — never statically from outside vlist/ (isolation guard).
 */

import type { MeasuredElement } from "./prepared-block";
import type { VListElementKind } from "./registry";
import { RenderAskInPassing } from "./render/RenderAskInPassing";
import { RenderMarkdown } from "./render/RenderMarkdown";
import { RenderMedia } from "./render/RenderMedia";
import { RenderMessageBubble } from "./render/RenderMessageBubble";
import { RenderPruneDivider } from "./render/RenderMisc";
import { RenderAskUserQuestion, RenderInlinePermission } from "./render/RenderPermission";
import { RenderPlanCard } from "./render/RenderPlanCard";
import { RenderReasoning } from "./render/RenderReasoning";
import { RenderSidecar } from "./render/RenderSidecar";
import { RenderSubagent } from "./render/RenderSubagent";
import { RenderSubagentRecovery } from "./render/RenderSubagentRecovery";
import { RenderSystemList } from "./render/RenderSystemList";
import { RenderSystemSimple } from "./render/RenderSystemSimple";
import { RenderSystemText } from "./render/RenderSystemText";
import { RenderToolCall, RenderToolCallGroup } from "./render/RenderToolCall";
import {
	RenderToolRun,
	RenderTraceCountLine,
	type TraceRowCardSlot,
	type TraceRowInteractionSlot,
	type TraceRowLiveTails,
} from "./render/RenderToolRun";
import { RenderTurnUsage } from "./render/RenderTurnUsage";
import { RenderWebSearch } from "./render/RenderWebSearch";

/**
 * Per-kind extra props supplied by the integration layer. Kept as an open record
 * because each RenderXxx has its own domain props; the dispatch casts narrowly.
 */
export type RenderExtra = Record<string, unknown>;

// biome-ignore lint/suspicious/noExplicitAny: render dispatch boundary normalizes typed props
type AnyMeasured = any;

/**
 * Derive the per-kind `extra` render props from an element spec's kind + data.
 * Single source of truth mirroring both the adapter's data shape and what
 * renderElement reads — keeping the two in sync (a mismatch here silently drops
 * props like web-search's isSearching). Pure + testable.
 */
export function resolveRenderExtra(spec: {
	kind: VListElementKind;
	data: unknown;
	opts?: Record<string, unknown>;
}): RenderExtra {
	const data = (spec.data ?? {}) as Record<string, unknown>;
	const extra: RenderExtra = {};
	if (spec.opts?.labels) extra.labels = spec.opts.labels;
	if (spec.opts?.onToggle) extra.onToggle = spec.opts.onToggle;
	if (spec.opts?.onToggleItems) extra.onToggleItems = spec.opts.onToggleItems;
	if (spec.opts?.onToggleEarlier) extra.onToggleEarlier = spec.opts.onToggleEarlier;
	if (spec.opts?.onToggleRow) extra.onToggleRow = spec.opts.onToggleRow;
	if (spec.opts?.onToggleTranslation) extra.onToggleTranslation = spec.opts.onToggleTranslation;
	switch (spec.kind) {
		case "message-bubble":
			if ("role" in data) extra.role = data.role;
			// User bubbles carry a header (avatar + name + time). Forward the raw
			// creator/createdAt + hasHeader so the integration layer can build the
			// header node (the render/ layer never imports UserAvatar directly).
			if ("hasHeader" in data) extra.hasHeader = data.hasHeader;
			if ("creator" in data) extra.creator = data.creator;
			if ("createdAt" in data) extra.createdAt = data.createdAt;
			// Attribution for messages not typed into this session. Height-neutral:
			// the badge lives inside the already-reserved header row.
			if ("origin" in data) extra.origin = data.origin;
			if ("originLabel" in data) extra.originLabel = data.originLabel;
			// Slash-command bubbles fold their expansion behind a toggle; mark them so
			// the integration layer wires onToggle (plain bubbles get no toggle).
			if ("commandText" in data && data.commandText) extra.commandText = data.commandText;
			break;
		case "web-search":
			// isSearching must be DERIVED from status (anything not "completed" is
			// in-flight) — else a running search renders as done.
			extra.isSearching = typeof data.status === "string" && data.status !== "completed";
			break;
		case "media":
			// image_generation reserves a loader slot in the header while generating,
			// and the MEASURE layer derives that same flag from `status` (see
			// measure-media's isGeneratingStatus). Deriving it identically here keeps
			// the painted header aligned with the reserved geometry; without it the
			// loader was never drawn even though its width was reserved.
			extra.generating = typeof data.status === "string" && data.status !== "completed";
			break;
		case "system-text":
		case "ask-in-passing":
			if ("kind" in data) {
				extra.kind = data.kind;
				extra.data = data;
			}
			break;
		case "sidecar":
			// The card's payload is fully composed by the adapter (source label /
			// preview / full text); the fold toggle comes through opts and the copy
			// tooltip through the standard render labels bundle (`extra.labels`).
			extra.data = data;
			break;
		case "subagent-recovery":
			// The measured block already carries the full payload; only the live
			// callbacks come through opts (mutations live outside vlist/).
			if (spec.opts?.onResume) extra.onResume = spec.opts.onResume;
			break;
		case "plan-card":
			if (typeof data.label === "string") extra.label = data.label;
			break;
		case "tool-run-count":
		case "reasoning-count":
			// Count lines carry their localized header text as data (the adapter
			// composes it with the live count), so map it onto the render labels.
			if (typeof data.headerLabel === "string" || typeof data.headerCount === "string") {
				extra.labels = {
					...(typeof data.headerLabel === "string" ? { label: data.headerLabel } : {}),
					...(typeof data.headerCount === "string" ? { count: data.headerCount } : {}),
				};
			}
			break;
		case "activity-trace": {
			// Live reasoning tails, read from the FRESH spec rather than the measured
			// payload: the trace's measured result is cache-served and its key ignores
			// the tail by design (see shared/pretext-layout/reasoning-live-tail.ts), so
			// the measured rows can carry a stale tail while `spec.data` is rebuilt on
			// every delta.
			const tails = collectRowLiveTails(data.items);
			if (tails) extra.rowLiveTails = tails;
			break;
		}
		case "subagent-card":
			if ("description" in data) extra.description = data.description;
			if ("agentType" in data) extra.agentType = data.agentType;
			if ("model" in data) extra.model = data.model;
			if ("reasoningEffort" in data) extra.reasoningEffort = data.reasoningEffort;
			if ("isBackground" in data) extra.isBackground = data.isBackground;
			if ("resultPreview" in data) extra.resultPreview = data.resultPreview;
			if ("resultText" in data) extra.resultText = data.resultText;
			// RenderSubagent reads the prompt body via `promptText` (not `prompt`).
			if ("prompt" in data) extra.promptText = data.prompt;
			if ("recentCallNames" in data) extra.recentCallNames = data.recentCallNames;
			// The recent-call summaries / categories live on the MEASURED payload (sliced
			// to the drawn rows), so the renderer reads them there rather than through
			// `extra` — nothing to forward here. `recentCallNames` remains an extra
			// because the measure layer only needs the row COUNT.
			if ("isActive" in data) extra.isActive = data.isActive;
			if ("status" in data) extra.status = data.status;
			break;
		default:
			break;
	}
	return extra;
}

/**
 * Index an activity trace's rows by key → live tail, or undefined when no row has
 * one (the overwhelmingly common case: a settled trace, or a live one whose text is
 * still short). Returning undefined keeps `extra` free of an empty map so the
 * render props stay referentially simple for non-streaming traces.
 */
function collectRowLiveTails(items: unknown): TraceRowLiveTails | undefined {
	if (!Array.isArray(items)) return undefined;
	let map: Map<string, { charCount: number; tail: string }> | undefined;
	for (const item of items) {
		if (item == null || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		const tail = row.liveTail;
		if (tail == null || typeof tail !== "object") continue;
		const { charCount, tail: text } = tail as Record<string, unknown>;
		if (typeof charCount !== "number" || typeof text !== "string") continue;
		if (typeof row.key !== "string") continue;
		map ??= new Map();
		map.set(row.key, { charCount, tail: text });
	}
	return map;
}

/**
 * Render one vlist element by kind. Returns null for kinds whose render props
 * are incomplete (defensive; the integration layer should always pass what a
 * kind needs — see the harness for the reference prop shapes).
 */
export function renderElement(
	kind: VListElementKind,
	measured: MeasuredElement,
	extra: RenderExtra = {},
): React.ReactNode {
	const m = measured as AnyMeasured;
	switch (kind) {
		case "markdown":
			return (
				<RenderMarkdown
					measured={m}
					// Per-body source toggle. Without this forward the row's action bar
					// flipped shell state that nothing read, so "view source" was inert on
					// every plain markdown message.
					showSource={extra.showSource as boolean | undefined}
					sourceText={extra.sourceText as string | undefined}
					onUnknownHeight={extra.onUnknownHeight as ((h: number) => void) | undefined}
					animateStreaming={extra.animateStreaming as boolean | undefined}
					animKeyBase={extra.animKeyBase as string | undefined}
				/>
			);
		case "message-bubble":
			return (
				<RenderMessageBubble
					role={(extra.role as "assistant" | "user") ?? "assistant"}
					measured={m}
					header={extra.header as React.ReactNode}
					hasHeader={extra.hasHeader as boolean | undefined}
					narratorId={extra.narratorId as string | undefined}
					onUnknownHeight={extra.onUnknownHeight as ((h: number) => void) | undefined}
					onToggle={extra.onToggle as (() => void) | undefined}
					onOpenAttachment={extra.onOpenAttachment as ((filePath: string) => void) | undefined}
					openAttachmentLabel={extra.openAttachmentLabel as string | undefined}
				/>
			);
		case "reasoning":
			return (
				<RenderReasoning
					measured={m}
					labels={extra.labels as never}
					// Same per-body source toggle as markdown (expanded form only).
					showSource={extra.showSource as boolean | undefined}
					sourceText={extra.sourceText as string | undefined}
					onToggle={extra.onToggle as (() => void) | undefined}
					onToggleTranslation={extra.onToggleTranslation as (() => void) | undefined}
					onUnknownHeight={extra.onUnknownHeight as ((h: number) => void) | undefined}
					animateStreaming={extra.animateStreaming as boolean | undefined}
					animKeyBase={extra.animKeyBase as string | undefined}
				/>
			);
		case "media":
			return (
				<RenderMedia
					measured={m}
					resolveImageSrc={extra.resolveImageSrc as never}
					generating={extra.generating as boolean | undefined}
					narratorId={extra.narratorId as string | undefined}
				/>
			);
		case "web-search":
			return <RenderWebSearch measured={m} isSearching={(extra.isSearching as boolean) ?? false} />;
		case "system-simple":
			return (
				<RenderSystemSimple
					measured={m}
					avatarSlot={extra.avatarSlot as React.ReactNode}
					onOpenCompact={extra.onOpenCompact as (() => void) | undefined}
					onCancelCompact={extra.onCancelCompact as (() => void) | undefined}
					cancelCompactTitle={extra.cancelCompactTitle as string | undefined}
				/>
			);
		case "system-text":
			return (
				<RenderSystemText
					measured={m}
					kind={extra.kind as never}
					data={extra.data as never}
					actions={extra.specCarryoverActions as never}
					errorActions={extra.errorNoticeActions as never}
				/>
			);
		case "sidecar":
			return (
				<RenderSidecar
					measured={m}
					onToggle={extra.onToggle as (() => void) | undefined}
					labels={extra.labels as never}
				/>
			);
		case "knowledge-hint":
			return <RenderSystemList measured={m} onOpenEntry={extra.onOpenEntry as never} />;
		case "plan-card":
			return (
				<RenderPlanCard
					measured={m}
					label={(extra.label as string) ?? "plan"}
					onUnknownHeight={extra.onUnknownHeight as ((h: number) => void) | undefined}
				/>
			);
		case "ask-in-passing":
			return (
				<RenderAskInPassing
					kind={(extra.kind as "pending" | "resolved") ?? "pending"}
					measured={m}
					labels={extra.labels as never}
					// The pending form's real interactive component (state + fork/send
					// mutation + cancel) is mounted as a slot; the resolved card's arrow
					// needs the route to its answer narrator. Without these the card
					// painted correctly but could neither be typed into nor opened.
					formSlot={extra.askInPassingFormSlot as React.ReactNode}
					onOpen={extra.onOpenAskInPassingTarget as (() => void) | undefined}
				/>
			);
		case "subagent-recovery":
			return (
				<RenderSubagentRecovery
					measured={m}
					onToggleRow={extra.onToggleRow as ((rowIndex: number) => void) | undefined}
					onResume={extra.onResume as ((mode: "notify" | "await") => void) | undefined}
				/>
			);
		case "tool-call":
			return (
				<RenderToolCall
					measured={m}
					labels={extra.labels as never}
					narratorId={extra.narratorId as string | undefined}
					onToggle={extra.onToggle as (() => void) | undefined}
					onTerminate={extra.onTerminate as (() => void) | undefined}
					onUpdateTimeout={extra.onUpdateTimeout as ((timeoutMs: number) => void) | undefined}
					permissionSlot={extra.permissionSlot as React.ReactNode}
					onReflectionTakeOver={extra.onReflectionTakeOver as (() => void) | undefined}
					// Per-body viewer wiring (copy / wrap / source / fullscreen action bar).
					// The shell derives the targets from the MEASURED card, so without this
					// forward every body inside a tool card lost its action bar.
					viewTargets={extra.viewTargets as never}
					viewControls={extra.viewControls as never}
				/>
			);
		case "tool-call-group":
			return (
				<RenderToolCallGroup
					measured={m}
					label={extra.label as string}
					statusColor={extra.statusColor as never}
					statusLabel={extra.statusLabel as string}
					narratorId={extra.narratorId as string | undefined}
					timingLabels={extra.timingLabels as never}
				/>
			);
		case "tool-run-summary":
		case "activity-trace":
		case "reasoning-steps":
			return (
				<RenderToolRun
					measured={m}
					labels={extra.labels as never}
					onToggleItems={extra.onToggleItems as (() => void) | undefined}
					onToggleEarlier={extra.onToggleEarlier as (() => void) | undefined}
					onToggleRow={extra.onToggleRow as ((index: number, rowKey: string) => void) | undefined}
					rowInteraction={extra.rowInteraction as TraceRowInteractionSlot | undefined}
					// Drilled-in rows nest a real tool card. Supplied through `extra` (NOT
					// spec.opts): the shell owns the labels / narrator / viewer wiring a card
					// needs, and spec.opts feeds the measure cache key — putting a React
					// factory there would digest as `?function` and blur the key's meaning.
					rowCard={extra.rowCard as TraceRowCardSlot | undefined}
					rowLiveTails={extra.rowLiveTails as TraceRowLiveTails | undefined}
				/>
			);
		case "tool-run-count":
		case "reasoning-count":
			return <RenderTraceCountLine measured={m} labels={extra.labels as never} />;
		case "ask-user-question":
			return <RenderAskUserQuestion measured={m} labels={extra.labels as never} />;
		case "inline-permission":
			return (
				<RenderInlinePermission
					measured={m}
					labels={extra.labels as never}
					includeTopMargin={false}
				/>
			);
		case "subagent-card":
			return (
				<RenderSubagent
					measured={m}
					description={(extra.description as string) ?? ""}
					agentType={extra.agentType as string | undefined}
					isBackground={extra.isBackground as boolean | undefined}
					model={extra.model as string | undefined}
					reasoningEffort={extra.reasoningEffort as string | undefined}
					resultPreview={extra.resultPreview as string | undefined}
					promptText={extra.promptText as string | undefined}
					recentCallNames={extra.recentCallNames as string[] | undefined}
					isActive={extra.isActive as boolean | undefined}
					status={extra.status as string | undefined}
					labels={extra.labels as never}
					onToggle={extra.onToggle as (() => void) | undefined}
					onTogglePrompt={extra.onTogglePrompt as (() => void) | undefined}
					onOpenSession={extra.onOpenSession as (() => void) | undefined}
					onResolveOverride={extra.onResolveOverride as (() => void) | undefined}
					permissionSlot={extra.permissionSlot as React.ReactNode}
					// Same viewer wiring as the tool card: the prompt / result bodies own
					// their action bars, so the shell's targets + controls must reach them.
					viewTargets={extra.viewTargets as never}
					viewControls={extra.viewControls as never}
				/>
			);
		case "prune-divider":
			return <RenderPruneDivider measured={m} data={(extra.data as never) ?? { label: "" }} />;
		case "turn-usage":
			// Fully self-describing: the measured payload carries the exact lines to
			// paint (composed by the adapter from the shared usage formatter), so this
			// kind needs no `extra` at all.
			return <RenderTurnUsage measured={m} />;
	}
}
