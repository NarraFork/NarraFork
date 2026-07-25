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
import { RenderSubagent } from "./render/RenderSubagent";
import { RenderSystemList } from "./render/RenderSystemList";
import { RenderSystemSimple } from "./render/RenderSystemSimple";
import { RenderSystemText } from "./render/RenderSystemText";
import { RenderToolCall, RenderToolCallGroup } from "./render/RenderToolCall";
import {
	RenderToolRun,
	RenderTraceCountLine,
	type TraceRowInteractionSlot,
} from "./render/RenderToolRun";
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
	switch (spec.kind) {
		case "message-bubble":
			if ("role" in data) extra.role = data.role;
			// User bubbles carry a header (avatar + name + time). Forward the raw
			// creator/createdAt + hasHeader so the integration layer can build the
			// header node (the render/ layer never imports UserAvatar directly).
			if ("hasHeader" in data) extra.hasHeader = data.hasHeader;
			if ("creator" in data) extra.creator = data.creator;
			if ("createdAt" in data) extra.createdAt = data.createdAt;
			break;
		case "web-search":
			// isSearching must be DERIVED from status (anything not "completed" is
			// in-flight) — else a running search renders as done.
			extra.isSearching = typeof data.status === "string" && data.status !== "completed";
			break;
		case "system-text":
		case "ask-in-passing":
			if ("kind" in data) {
				extra.kind = data.kind;
				extra.data = data;
			}
			break;
		case "plan-card":
			if (typeof data.label === "string") extra.label = data.label;
			break;
		case "subagent-card":
			if ("description" in data) extra.description = data.description;
			if ("agentType" in data) extra.agentType = data.agentType;
			if ("model" in data) extra.model = data.model;
			if ("isBackground" in data) extra.isBackground = data.isBackground;
			if ("resultPreview" in data) extra.resultPreview = data.resultPreview;
			if ("resultText" in data) extra.resultText = data.resultText;
			// RenderSubagent reads the prompt body via `promptText` (not `prompt`).
			if ("prompt" in data) extra.promptText = data.prompt;
			if ("recentCallNames" in data) extra.recentCallNames = data.recentCallNames;
			if ("isActive" in data) extra.isActive = data.isActive;
			if ("status" in data) extra.status = data.status;
			break;
		default:
			break;
	}
	return extra;
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
					onUnknownHeight={extra.onUnknownHeight as ((h: number) => void) | undefined}
				/>
			);
		case "reasoning":
			return (
				<RenderReasoning
					measured={m}
					labels={extra.labels as never}
					onToggle={extra.onToggle as (() => void) | undefined}
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
			return <RenderSystemSimple measured={m} avatarSlot={extra.avatarSlot as React.ReactNode} />;
		case "system-text":
			return (
				<RenderSystemText measured={m} kind={extra.kind as never} data={extra.data as never} />
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
				/>
			);
		case "tool-call":
			return (
				<RenderToolCall
					measured={m}
					labels={extra.labels as never}
					narratorId={extra.narratorId as string | undefined}
					onToggle={extra.onToggle as (() => void) | undefined}
					permissionSlot={extra.permissionSlot as React.ReactNode}
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
					onToggleRow={extra.onToggleRow as ((index: number) => void) | undefined}
					rowInteraction={extra.rowInteraction as TraceRowInteractionSlot | undefined}
				/>
			);
		case "tool-run-count":
		case "reasoning-count":
			return <RenderTraceCountLine measured={m} />;
		case "ask-user-question":
			return <RenderAskUserQuestion measured={m} />;
		case "inline-permission":
			return <RenderInlinePermission measured={m} includeTopMargin={false} />;
		case "subagent-card":
			return (
				<RenderSubagent
					measured={m}
					description={(extra.description as string) ?? ""}
					agentType={extra.agentType as string | undefined}
					isBackground={extra.isBackground as boolean | undefined}
					model={extra.model as string | undefined}
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
				/>
			);
		case "prune-divider":
			return <RenderPruneDivider measured={m} data={(extra.data as never) ?? { label: "" }} />;
	}
}
