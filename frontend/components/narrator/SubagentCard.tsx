import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import {
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Loader,
	Menu,
	Paper,
	Stack,
	Text,
	ThemeIcon,
	UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
	hasTruncatedLeaf,
	readLeafText,
	stringifyForDisplay,
} from "@shared/pretext-layout/tool-io-projection";
import { isTerminalToolRowStatus } from "@shared/tool-row-status";
import {
	IconArrowBackUp,
	IconChevronDown,
	IconChevronRight,
	IconCloudOff,
	IconEye,
	IconGitFork,
	IconMessageQuestion,
	IconPlayerStop,
	IconRobot,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNarrator, useToolCallDetail } from "../../hooks/useNarrator";
import { useNarratorSubagentsCapability } from "../../hooks/usePlatform";
import { useSwipeMenu } from "../../hooks/useSwipeMenu";
import { api, type SubagentToolCallHeader, type SubagentToolInputSummary } from "../../lib/api";
import { Z } from "../../lib/z-index";
import type { PendingPermission } from "../../types/narrator";
import {
	TRACE_ROW_GAP,
	TRACE_ROW_LINE_HEIGHT,
	TRACE_ROW_MIN_HEIGHT,
	TraceChevronSlot,
	TraceIconSlot,
	TraceRowDot,
	TraceStatusSlot,
} from "./CollapsibleTrace";
import { CompactMenuSub } from "./CompactMenuSub";
import { ContentViewer } from "./ContentViewer";
import { LazyCollapse } from "./LazyCollapse";
import {
	type MessageContextMenuActions,
	MessageContextMenuCtx,
	useMessageContextMenu,
} from "./MessageContextMenuCtx";
import {
	BLOCK_ID_ATTR,
	NestedBlockCtx,
	shouldIgnoreMessageBlockSelection,
	useMessageSelection,
} from "./MessageSelectionCtx";
import { resolvePendingPerm } from "./narrator-message-helpers";
import type { PermissionCallbacks } from "./narrator-panel-types";
import { useRenderLod } from "./RenderLodCtx";
import type { ToolCallData as BaseToolCallData } from "./ToolCallCard";
import {
	getCategory,
	getCategoryColor,
	getCategoryIcon,
	InlinePermission,
	STATUS_COLORS,
	StatusIcon,
	ToolCallCard,
	ToolTimingArea,
} from "./ToolCallCard";
import { subagentRecentCallSummary, traceRowTitle } from "./tool-display";

/**
 * `ToolCallData` plus the activity-row-only summary projection.
 *
 * Declared here rather than on `ToolCallData` itself because the field is
 * meaningful ONLY for the "recent calls" rows: every other consumer of a tool
 * call has the real `inputJson` and calls `getSummary` on that directly. Widening
 * the shared type would invite code elsewhere to read a field that is empty in
 * every other context.
 */
type ToolCallData = BaseToolCallData & {
	/** Whitelisted short input keys projected in SQL (see `SubagentActivityRow`). */
	_inputSummary?: SubagentToolInputSummary;
};

/**
 * Fixed slot for the card HEADER's status glyph (12×12 — `StatusIcon` and `Loader`
 * both render at size={12}).
 *
 * Two independent effects used to make every glyph-bearing lane change height:
 *
 *  1. `StatusIcon` returns `null` for any status outside its known set (`""` and
 *     whatever a provider sends next), so an auto-sized wrapper collapsed to 0×0.
 *     `streaming` used to land here too — the very FIRST status rendering as an
 *     empty slot, fixed by folding it into the spinner branch — so the slot has to
 *     stay height-neutral for the unknown-status case that remains.
 *  2. When it DID render, the wrapper was a block box holding an inline `<svg>`,
 *     so its line box came from the ROOT font size (16 × 1.55 = 24.8px), not
 *     from the 12px glyph — inflating the lane by ~8px rather than fitting it.
 *
 * A tool call walks `streaming → running → success` during its lifetime, so the
 * header visibly jumped between heights on every transition. Sizing the slot
 * explicitly and laying it out as flex makes the glyph height-neutral in both
 * directions; `flexShrink: 0` keeps the label from eating the reservation.
 *
 * The activity ROWS use `CollapsibleTrace`'s {@link TraceStatusSlot}, which is the
 * same contract at the same size — one definition per render path.
 */
const STATUS_SLOT_SIZE = 12;
export const SUBAGENT_STATUS_SLOT_STYLE = {
	width: STATUS_SLOT_SIZE,
	height: STATUS_SLOT_SIZE,
	flexShrink: 0,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
} as const satisfies CSSProperties;

/**
 * Glyph size inside a trace row's 14px category chip.
 *
 * Matches what `ActivityTrace` / `ToolRunSummary` pass (`<Icon size={9} />`): the
 * inset is what makes the tint read as a chip rather than a box drawn tight around
 * the icon.
 */
const TRACE_ROW_GLYPH_SIZE = 9;

/**
 * Category chip for an activity row — the SAME mark a folded trace row shows.
 *
 * The row is now assembled from {@link TraceIconSlot}, so the chip is the trace
 * lane's 14px tinted `ThemeIcon` around a 9px glyph rather than the tool card
 * header's 16px tile. That is deliberate: the activity row and the low-LOD trace
 * row are one shape, and the chip has to come from the same definition or the two
 * drift the way this row's earlier bare grey `<Icon>` did.
 *
 * `getCategory` takes an optional input so it can reclassify spec-task file writes;
 * the activity row carries no full input, so the category comes from the tool name
 * alone. Only spec-tasks reclassifies on input, so every other tool is unaffected.
 */
function categoryGlyph(toolName: string) {
	const Icon = getCategoryIcon(getCategory(toolName), toolName);
	return <Icon size={TRACE_ROW_GLYPH_SIZE} data-testid="subagent-activity-category-chip" />;
}

/**
 * Height reservation for the card HEADER's status / timing lane.
 *
 * Three different line boxes meet there: the timing text at line-height 1.55
 * (18.6px at `xs`), the badges at Mantine's 1.4 (16.8px), and — for a status glyph
 * outside a fixed-size slot — an inline `<svg>` whose line box comes from the
 * *root* font size, 16 × 1.55 = 24.8px. Reserving that largest box keeps the
 * header from moving by ~1.8px when the timer appears or by ~8px depending on
 * whether a glyph renders at all.
 *
 * Derived from the root font size rather than hard-coded so it tracks the user's
 * font scale, and expressed as `min-height` so content that legitimately grows
 * (a wrapped badge row) still grows instead of being clipped.
 *
 * The activity ROWS no longer use this: they are trace rows now and follow
 * {@link TRACE_ROW_MIN_HEIGHT} (18px), which is what makes them the same shape as
 * a folded trace row.
 */
export const SUBAGENT_STATUS_ROW_MIN_HEIGHT = "calc(1rem * var(--mantine-line-height))";

const SUBAGENT_ID_RE = /<subagent_id>[^<]*<\/subagent_id>/g;
const MAX_SUBAGENT_RESULT_PREVIEW_CHARS = 120_000;
const MAX_SUBAGENT_PROMPT_INLINE_CHARS = 120_000;
const MAX_SUBAGENT_DESCRIPTION_CHARS = 4_000;
const SWIPE_REVEAL_WIDTH = 180;

interface SubagentNarratorData {
	status?: string;
	substatus?: string | string[];
	model?: string | null;
	reasoningEffort?: string | null;
	_retryInfo?: {
		message: string;
		retryCount?: number;
		maxRetries?: number;
		retryAt?: number;
	};
}

function capText(text: string, maxChars: number): string {
	return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

export function resolveSubagentModel(
	narratorModel: unknown,
	activityModel: unknown,
	inputModel: unknown,
): string | undefined {
	return (
		nonEmptyString(narratorModel) ?? nonEmptyString(activityModel) ?? nonEmptyString(inputModel)
	);
}

export function resolveSubagentReasoningEffort(
	narratorReasoningEffort: unknown,
	activityReasoningEffort: unknown,
	input: Record<string, unknown>,
): string | undefined {
	return (
		nonEmptyString(narratorReasoningEffort) ??
		nonEmptyString(activityReasoningEffort) ??
		nonEmptyString(input.reasoning_effort) ??
		nonEmptyString(input.reasoningEffort)
	);
}

function stripSubagentId(text: string): string {
	return text.replace(SUBAGENT_ID_RE, "").trim();
}

/**
 * Whether a tool status means "no longer running".
 *
 * Delegates to `@shared/tool-row-status`, which the folded trace rows and the vlist
 * copies also read — this used to be a local regex listing the same spellings, i.e.
 * a third definition of one rule. NOTE the deliberate difference from the empty
 * string: the shared helper treats `""`/absent as terminal (a historical row must
 * not spin forever), which is what the old regex did too.
 */
function isTerminalToolStatus(status: string | undefined): boolean {
	return isTerminalToolRowStatus(status);
}

function parseOutputJson(output: unknown): string {
	if (typeof output === "string") return capText(output, MAX_SUBAGENT_RESULT_PREVIEW_CHARS);
	if (!output || typeof output !== "object") return "";
	const record = output as Record<string, unknown>;
	// `_text` is checked FIRST (and unwrapped if it is itself a truncated leaf), so a
	// `{_text, _metadata}` output whose text was cut shows the text rather than the
	// literal `{"_text":"…` the old ordering produced.
	const textField = readLeafText(record._text);
	if (textField !== undefined) return capText(textField, MAX_SUBAGENT_RESULT_PREVIEW_CHARS);
	const leaf = readLeafText(record);
	if (leaf !== undefined) return capText(leaf, MAX_SUBAGENT_RESULT_PREVIEW_CHARS);
	if (Array.isArray(output)) {
		return capText(
			output
				.map((block) =>
					block &&
					typeof block === "object" &&
					typeof (block as { text?: unknown }).text === "string"
						? ((block as { text: string }).text ?? "")
						: "",
				)
				.filter(Boolean)
				.join("\n"),
			MAX_SUBAGENT_RESULT_PREVIEW_CHARS,
		);
	}
	return capText(stringifyForDisplay(output), MAX_SUBAGENT_RESULT_PREVIEW_CHARS);
}

/**
 * Row label detail for one recent call.
 *
 * Thin wrapper over the shared {@link subagentRecentCallSummary} (which lives
 * beside `getSummary` so the vlist path can reach the same formatter). Kept as an
 * export because it is the row's own vocabulary and several tests drive it
 * directly.
 */
export function subagentActivitySummaryText(call: ToolCallData): string | null {
	return subagentRecentCallSummary(call.toolName, call._inputSummary);
}

/** `Tool · summary` for one recent call — the SAME title a folded trace row shows. */
export function subagentActivityRowTitle(call: ToolCallData): string {
	return traceRowTitle(call.toolName, subagentActivitySummaryText(call));
}

/**
 * One "recent calls" row, drawn as a TRACE ROW: dot + category chip + a single
 * `Tool · summary` line + status glyph + timing.
 *
 * WHY IT IS A TRACE ROW
 * This used to be a tinted 28px button, so the same tool call looked like two
 * different things depending on the render level — a chunky card row inside a
 * subagent card, a slim trace line once the reader dropped to a low LOD. The row
 * is now assembled from `CollapsibleTrace`'s exported slots
 * ({@link TraceChevronSlot} / {@link TraceIconSlot} / {@link TraceStatusSlot}) and
 * its 18px reservation, so "same shape" is enforced by shared definitions rather
 * than by two layouts that happen to agree.
 *
 * The dot (not a chevron) is correct here: an activity row has nothing to expand —
 * clicking it opens the child session.
 *
 * The label is available on a call's FIRST appearance, whether it arrived by REST
 * fetch, reconnect catch-up, or a live `tool_started` / `tool_use_chunk` frame —
 * all three carry the same projected summary, so a row no longer starts as a bare
 * tool name and acquires its detail only on the next page load.
 *
 * Its height must not depend on the tool-call status (which walks
 * `streaming → running → success` while the call executes) nor on whether a
 * summary is present or how long it is: every cell is either a fixed-size slot or
 * a single truncating line inside {@link TRACE_ROW_MIN_HEIGHT}.
 */
export function SubagentActivityRow({
	call,
	disabled,
	onActivate,
}: {
	call: ToolCallData;
	disabled?: boolean;
	onActivate?: () => void;
}) {
	const summaryText = subagentActivitySummaryText(call);
	const activate = (event: React.SyntheticEvent) => {
		if (disabled) return;
		event.stopPropagation();
		onActivate?.();
	};
	return (
		// `role="button"` on a Box rather than an UnstyledButton: the row CONTAINS the
		// timing area, which is itself a button (its popover trigger), and a nested
		// <button> is invalid HTML — React warns and browsers reparent the markup. The
		// card header solves the same problem the same way.
		<Box
			data-testid="subagent-activity"
			role="button"
			tabIndex={disabled ? -1 : 0}
			aria-disabled={disabled || undefined}
			onClick={activate}
			onKeyDown={(event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				activate(event);
			}}
			style={{ display: "block", width: "100%", cursor: disabled ? "default" : "pointer" }}
		>
			<Group
				gap={TRACE_ROW_GAP}
				wrap="nowrap"
				align="center"
				py={1}
				data-testid="subagent-activity-row"
				style={{ minHeight: TRACE_ROW_MIN_HEIGHT }}
			>
				{/* No chevron: nothing to expand in place. */}
				<TraceChevronSlot>
					<TraceRowDot />
				</TraceChevronSlot>
				{/* Category chip, derived from the tool *name* alone — all this row has,
				    since the activity summary carries no full input. The slot is fixed-size,
				    so an unknown tool still occupies it rather than collapsing it and
				    shortening the row. */}
				<TraceIconSlot
					icon={categoryGlyph(call.toolName)}
					color={getCategoryColor(getCategory(call.toolName))}
				/>
				{/* ONE truncating line. The tool name and summary are separate spans purely
				    so each remains addressable; they share a single line box, so a 200-char
				    summary clips instead of wrapping the row taller.

				    `flex: 0 1 auto` (not `flex: 1`) keeps the status + duration HUGGING this
				    label instead of pinned to the row's right edge — same layout as a folded
				    trace row, whose definition this row shares. */}
				<Text
					data-trace-title
					data-testid="subagent-activity-label"
					size="xs"
					c="dimmed"
					truncate
					style={{ flex: "0 1 auto", minWidth: 0, lineHeight: TRACE_ROW_LINE_HEIGHT }}
				>
					<span>{call.toolName === "Task" ? "Agent" : call.toolName}</span>
					{summaryText && (
						<>
							{" · "}
							<span data-testid="subagent-activity-summary">{summaryText}</span>
						</>
					)}
				</Text>
				<TraceStatusSlot status={call.status} />
				<ToolTimingArea toolCall={call} isActive={!isTerminalToolStatus(call.status)} />
				{/* Absorbs the slack so the cells above stay left-packed. */}
				<Box style={{ flex: 1, minWidth: 0 }} />
			</Group>
		</Box>
	);
}

export function subagentHeaderToToolCallData(header: SubagentToolCallHeader): ToolCallData {
	return {
		id: header.toolCallId ?? undefined,
		toolUseId: header.toolUseId,
		toolName: header.toolName,
		// Still `{}`: the activity list never carries the real tool input (that is
		// the whole point of the SQL projection). The row label reads
		// `_inputSummary` instead.
		inputJson: {},
		...(header.inputSummary ? { _inputSummary: header.inputSummary } : {}),
		status: header.status,
		createdAt: header.createdAt,
		startedAt:
			typeof header.timing?.startedAt === "number"
				? header.timing.startedAt
				: typeof header.timing?.streamStartedAt === "number"
					? header.timing.streamStartedAt
					: undefined,
		streamStartedAt: header.timing?.streamStartedAt,
		permissionStartedAt: header.timing?.permissionStartedAt,
		executionStartedAt: header.timing?.executionStartedAt,
		completedAt: header.timing?.completedAt,
		durationMs: header.timing?.durationMs ?? undefined,
	};
}

export function subagentPermissionToToolCallData(permission: PendingPermission): ToolCallData {
	return {
		id: permission.id,
		toolUseId: permission.toolUseId,
		toolName: permission.toolName,
		inputJson: permission.inputJson ?? {},
		status: "pending",
		executionDeviceId: permission.executionDeviceId,
		executionCwd: permission.executionCwd,
		resolvedFilePath: permission.resolvedFilePath,
		executionTarget: permission.executionTarget,
		executionTargets: permission.executionTargets,
		deviceSelectionSource: permission.deviceSelectionSource,
		permissionDecisionReason: permission.decisionReason,
		permissionSuggestions: permission.suggestions ?? null,
	};
}

export function getSubagentPendingPermissions(
	permissions: PendingPermission[] | undefined,
	parentToolUseId: string | undefined,
): PendingPermission[] {
	if (!parentToolUseId) return [];
	return (permissions ?? []).filter((permission) => permission.parentToolUseId === parentToolUseId);
}

export interface SubagentCardProps {
	toolCall: ToolCallData;
	narratorId: string;
	inRun?: boolean;
	isLast?: boolean;
	isSoleInRun?: boolean;
	permCb?: PermissionCallbacks;
	onViewSubagentSession?: (narratorId: string) => void;
	blockIndex?: number;
	isRecent?: boolean;
}

export const SubagentCard = memo(function SubagentCard({
	toolCall,
	narratorId,
	inRun,
	isLast,
	isSoleInRun,
	permCb,
	onViewSubagentSession,
	blockIndex,
	isRecent = true,
}: SubagentCardProps) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const navigate = useNavigate();
	// biome-ignore lint/suspicious/noExplicitAny: loose route search parameters
	const routeSearch = useSearch({ strict: false }) as any;
	const fromParam = routeSearch?.from as string | undefined;
	const input = toolCall.inputJson ?? {};
	const activity = toolCall._subagentActivity;
	const subagentNarratorId = activity?.subagentNarratorId ?? null;
	const activityHeaders = useMemo(
		() => (activity?.latestToolCalls ?? []).slice(-3),
		[activity?.latestToolCalls],
	);
	const latestActivityCalls = useMemo(
		() => activityHeaders.map(subagentHeaderToToolCallData),
		[activityHeaders],
	);
	const pendingPermissions = useMemo(
		() => getSubagentPendingPermissions(permCb?.pendingPermissions, toolCall.toolUseId),
		[permCb?.pendingPermissions, toolCall.toolUseId],
	);
	const activityCalls = useMemo(() => {
		const pendingIds = new Set(pendingPermissions.map((permission) => permission.id));
		const pendingToolUseIds = new Set(
			pendingPermissions
				.map((permission) => permission.toolUseId)
				.filter((toolUseId): toolUseId is string => !!toolUseId),
		);
		return latestActivityCalls.filter(
			(call) =>
				(!call.id || !pendingIds.has(call.id)) &&
				(!call.toolUseId || !pendingToolUseIds.has(call.toolUseId)),
		);
	}, [latestActivityCalls, pendingPermissions]);

	const subagentsCapability = useNarratorSubagentsCapability();
	const canDetachToBackground =
		subagentsCapability.supported &&
		subagentsCapability.background &&
		subagentsCapability.detachAttach;
	const canCancelBackground = subagentsCapability.supported && subagentsCapability.background;
	const canResolveOverride = subagentsCapability.supported && subagentsCapability.staleRecovery;
	const isBackground = !!input.background || !!input.run_in_background;
	const agentType = String(
		input.subagent_type ?? (toolCall.toolName === "Send" ? "send" : "agent"),
	);
	const agentBadgeColor = ["explore", "plan", "general", "agent", "send"].includes(agentType)
		? "indigo"
		: "teal";
	const isTerminal = isTerminalToolStatus(toolCall.status);
	const [expanded, setExpanded] = useState(!!isSoleInRun);
	const [showPrompt, setShowPrompt] = useState(false);
	const promptValue = input.prompt ?? (toolCall.toolName === "Send" ? input.message : "");
	const prompt = typeof promptValue === "string" ? promptValue : String(promptValue ?? "");
	const promptPreview = capText(prompt, MAX_SUBAGENT_PROMPT_INLINE_CHARS);
	const rawDescription =
		input.description ?? (prompt.includes("\n") ? prompt.slice(0, 80) : prompt);
	const description = capText(
		String(rawDescription ?? t("subagentBadge")),
		MAX_SUBAGENT_DESCRIPTION_CHARS,
	);
	const resultText = useMemo(
		() => stripSubagentId(parseOutputJson(toolCall.outputJson)),
		[toolCall.outputJson],
	);
	// Recursive probe: after field-level projection the ROOT of an object output is a
	// plain object, so a root-level `_truncated` check would report "complete" for a
	// payload whose body is still a preview.
	const isTruncatedOutput = hasTruncatedLeaf(toolCall.outputJson);
	const { data: fullToolCall } = useToolCallDetail(
		narratorId,
		toolCall.toolUseId ?? "",
		isTruncatedOutput && expanded,
	);
	const fullResultText = useMemo(
		() =>
			fullToolCall?.outputJson
				? stripSubagentId(parseOutputJson(fullToolCall.outputJson)) || undefined
				: undefined,
		[fullToolCall?.outputJson],
	);

	const selfPermission = resolvePendingPerm(
		toolCall,
		permCb?.pendingPermission,
		permCb?.pendingPermissions,
	);
	useEffect(() => {
		if (selfPermission || pendingPermissions.length > 0) setExpanded(true);
	}, [selfPermission, pendingPermissions.length]);

	// Render LOD layering (mirrors ToolCallCard): L6 always expanded; L5 expands
	// only recent cards; L4 collapses all to headers; L3-L1 are handled upstream
	// by the tool-run gate. Active / permission cards stay expanded (exempt).
	const renderLod = useRenderLod();
	const isActive = !isTerminal;
	const lodExempt = isActive || !!selfPermission || pendingPermissions.length > 0;
	const [lodUserOverride, setLodUserOverride] = useState(false);
	// Reset on level change via compare-during-render (lint-clean, synchronous).
	const [prevRenderLod, setPrevRenderLod] = useState(renderLod);
	if (prevRenderLod !== renderLod) {
		setPrevRenderLod(renderLod);
		setLodUserOverride(false);
	}
	const collapsesByLod = !lodExempt && (renderLod === 4 || (renderLod === 5 && !isRecent));
	const effectiveExpanded =
		lodExempt || lodUserOverride
			? true
			: renderLod >= 6
				? true
				: renderLod === 5
					? isRecent
						? expanded
						: false
					: renderLod === 4
						? false
						: expanded;
	const handleHeaderToggle = collapsesByLod
		? () => setLodUserOverride((v) => !v)
		: () => setExpanded((v) => !v);

	const { data: subagentNarrator } = useNarrator(subagentNarratorId ?? "");
	const narratorData = subagentNarrator as SubagentNarratorData | undefined;
	const modelIdentity = `${narratorId}:${subagentNarratorId ?? ""}:${String(
		toolCall.toolUseId ?? toolCall.id ?? toolCall.toolName,
	)}`;
	const currentResolvedModel = resolveSubagentModel(
		narratorData?.model,
		activity?.model,
		input.model,
	);
	const stableModelRef = useRef<{ identity: string; model?: string }>({ identity: modelIdentity });
	if (stableModelRef.current.identity !== modelIdentity) {
		stableModelRef.current = { identity: modelIdentity };
	}
	if (currentResolvedModel) stableModelRef.current.model = currentResolvedModel;
	const resolvedModel = currentResolvedModel ?? stableModelRef.current.model;
	const reasoningEffort = resolveSubagentReasoningEffort(
		narratorData?.reasoningEffort,
		activity?.reasoningEffort,
		input,
	);
	const substatus = useMemo(() => {
		if (Array.isArray(narratorData?.substatus)) return narratorData.substatus;
		if (typeof narratorData?.substatus !== "string") return [];
		try {
			const parsed = JSON.parse(narratorData.substatus);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}, [narratorData?.substatus]);
	const isSuspended = substatus.includes("suspended") || substatus.includes("manual_override");
	const isTakenOver = substatus.includes("taken_over");
	const isWorking = narratorData?.status === "working";
	const isWaiting = narratorData?.status === "waiting";
	/** Live spinner wins over the status glyph while the subagent is still running. */
	const showLiveLoader = (isWorking || isWaiting) && !isTerminal;

	const handleViewSession = useCallback(() => {
		if (!subagentNarratorId) return;
		if (onViewSubagentSession) {
			onViewSubagentSession(subagentNarratorId);
			return;
		}
		const search: Record<string, string> = {};
		if (fromParam) search.from = fromParam;
		if (toolCall.resultMessageId) search.scrollTo = toolCall.resultMessageId;
		navigate({
			to: "/narrators/$narratorId",
			params: { narratorId: subagentNarratorId },
			search: Object.keys(search).length > 0 ? search : undefined,
		});
	}, [subagentNarratorId, onViewSubagentSession, fromParam, toolCall.resultMessageId, navigate]);

	const handleDetach = useCallback(async () => {
		if (!subagentNarratorId || !canDetachToBackground) return;
		try {
			await api.detachSubagent(subagentNarratorId);
		} catch {
			// The subagent may have already completed.
		}
	}, [subagentNarratorId, canDetachToBackground]);
	const handleCancelBackground = useCallback(async () => {
		if (!subagentNarratorId || !canCancelBackground) return;
		try {
			await api.cancelBackgroundTask(narratorId, subagentNarratorId);
		} catch {
			// The background task may have already completed.
		}
	}, [subagentNarratorId, canCancelBackground, narratorId]);

	const parentMessageContext = useMessageContextMenu();
	const emptyContext: MessageContextMenuActions = {};
	const blockId = toolCall.toolUseId ? `sa-${toolCall.toolUseId}` : undefined;
	const selection = useMessageSelection();
	const isSelected = !!(
		blockId &&
		selection.selectionMode &&
		selection.selectedBlockIds.has(blockId)
	);
	const hasCardActions = !!(
		subagentNarratorId ||
		parentMessageContext.onDeleteBlock ||
		parentMessageContext.onCompactBeforeMessage ||
		parentMessageContext.onAskInPassing ||
		parentMessageContext.onForkFromMessage ||
		parentMessageContext.onRollbackToBlock
	);
	const swipe = useSwipeMenu({
		enabled: hasCardActions,
		touchEnabled: hasCardActions,
		blockId,
		onSwipeRight: isSelected && blockId ? () => selection.deselectBlock(blockId) : undefined,
	});
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const handleBlockClick = useCallback(
		(event: React.MouseEvent) => {
			if (isMobile || !blockId || shouldIgnoreMessageBlockSelection(event.target)) return;
			if (!event.metaKey && !event.ctrlKey && !event.shiftKey) return;
			event.preventDefault();
			if (event.shiftKey) selection.rangeSelectTo(blockId);
			else selection.toggleBlock(blockId);
		},
		[isMobile, blockId, selection],
	);

	const menuItems = hasCardActions ? (
		<>
			{subagentNarratorId && (
				<Menu.Item
					leftSection={<IconEye size={14} />}
					onClick={() => {
						handleViewSession();
						swipe.closeSwipe();
					}}
				>
					{t("openFullSubagentSession")}
				</Menu.Item>
			)}
			{!isBackground && !isTerminal && canDetachToBackground && subagentNarratorId && (
				<Menu.Item
					leftSection={<IconCloudOff size={14} />}
					onClick={() => {
						void handleDetach();
						swipe.closeSwipe();
					}}
				>
					{t("detachToBackground")}
				</Menu.Item>
			)}
			{isBackground && !isTerminal && canCancelBackground && subagentNarratorId && (
				<Menu.Item
					color="red"
					leftSection={<IconPlayerStop size={14} />}
					onClick={() => {
						void handleCancelBackground();
						swipe.closeSwipe();
					}}
				>
					{t("backgroundTasks.cancel")}
				</Menu.Item>
			)}
			{parentMessageContext.onRollbackToBlock && blockIndex != null && (
				<Menu.Item
					leftSection={<IconArrowBackUp size={14} />}
					onClick={() => {
						parentMessageContext.onRollbackToBlock?.(blockIndex);
						swipe.closeSwipe();
					}}
				>
					{t("contextMenu_rollback")}
				</Menu.Item>
			)}
			{parentMessageContext.onForkFromMessage && (
				<Menu.Item
					leftSection={<IconGitFork size={14} />}
					onClick={() => {
						parentMessageContext.onForkFromMessage?.();
						swipe.closeSwipe();
					}}
				>
					{t("contextMenu_fork")}
				</Menu.Item>
			)}
			{parentMessageContext.onAskInPassing && (
				<Menu.Item
					leftSection={<IconMessageQuestion size={14} />}
					onClick={() => {
						parentMessageContext.onAskInPassing?.();
						swipe.closeSwipe();
					}}
				>
					{t("contextMenu_askInPassing")}
				</Menu.Item>
			)}
			{parentMessageContext.onCompactBeforeMessage && (
				<CompactMenuSub
					onCompact={parentMessageContext.onCompactBeforeMessage}
					onClearContext={parentMessageContext.onClearContextBefore}
					onManualSummarize={parentMessageContext.onManualSummarize}
					onClose={swipe.closeSwipe}
				/>
			)}
			{parentMessageContext.onDeleteBlock && blockIndex != null && (
				<Menu.Item
					color="red"
					leftSection={<IconTrash size={14} />}
					onClick={() => {
						void parentMessageContext.onDeleteBlock?.(blockIndex);
						swipe.closeSwipe();
					}}
				>
					{t("contextMenu_delete")}
				</Menu.Item>
			)}
			<Menu.Divider />
			<Menu.Item leftSection={<IconX size={14} />} onClick={swipe.closeSwipe}>
				{tc("cancel")}
			</Menu.Item>
		</>
	) : null;

	const card = (
		<NestedBlockCtx.Provider value={blockId ?? null}>
			<MessageContextMenuCtx.Provider value={emptyContext}>
				<Box
					{...(blockId ? { [BLOCK_ID_ATTR]: blockId } : {})}
					onClick={handleBlockClick}
					style={
						isSelected
							? { outline: "2px solid var(--mantine-color-indigo-5)", outlineOffset: -2 }
							: undefined
					}
				>
					<Box
						p="xs"
						role="button"
						tabIndex={0}
						aria-expanded={effectiveExpanded}
						onClick={handleHeaderToggle}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								handleHeaderToggle();
							}
						}}
						style={{ cursor: "pointer" }}
					>
						<Group gap={5} wrap="nowrap" align="flex-start">
							<Group
								data-testid="subagent-header-tags"
								gap={5}
								wrap="wrap"
								style={{ flex: 1, minWidth: 0, flexWrap: "wrap" }}
							>
								<ThemeIcon size={16} variant="light" color="indigo" radius="sm">
									<IconRobot size={10} />
								</ThemeIcon>
								<Badge size="xs" variant="light" color={agentBadgeColor}>
									{agentType}
								</Badge>
								{isBackground && (
									<Badge size="xs" variant="light" color="blue">
										{t("backgroundBadge")}
									</Badge>
								)}
								{resolvedModel && (
									<Badge data-testid="subagent-model" size="xs" variant="light" color="violet">
										{resolvedModel}
									</Badge>
								)}
								{reasoningEffort && (
									<Badge
										data-testid="subagent-reasoning-effort"
										size="xs"
										variant="light"
										color="cyan"
									>
										{reasoningEffort}
									</Badge>
								)}
							</Group>
							<Group
								gap={5}
								wrap="nowrap"
								style={{ flexShrink: 0, minHeight: SUBAGENT_STATUS_ROW_MIN_HEIGHT }}
							>
								{pendingPermissions.length > 0 && (
									<Badge size="xs" color="yellow" variant="light">
										{t("subagentWaitingPermission", { count: pendingPermissions.length })}
									</Badge>
								)}
								<Box
									data-testid="subagent-header-status-slot"
									c={showLiveLoader ? undefined : (STATUS_COLORS[toolCall.status] ?? "gray")}
									style={SUBAGENT_STATUS_SLOT_STYLE}
								>
									{showLiveLoader ? (
										<Loader size={12} color={isWaiting ? "yellow" : "blue"} />
									) : (
										<StatusIcon status={toolCall.status} />
									)}
								</Box>
								<ToolTimingArea toolCall={toolCall} isActive={!isTerminal} />
								{effectiveExpanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
							</Group>
						</Group>
						<Text size="xs" c="dimmed" mt={2} ml={21} truncate={!effectiveExpanded}>
							{isTakenOver
								? t("subagentTakenOver")
								: isSuspended
									? t("subagentSuspended")
									: description}
						</Text>
						{!effectiveExpanded && isTerminal && resultText && (
							<Text size="xs" c="dimmed" mt={2} ml={21} truncate opacity={0.7}>
								→ {resultText.slice(0, 120)}
							</Text>
						)}
					</Box>

					{activityCalls.length > 0 && (
						<Box px="xs" pb="xs">
							<Group justify="space-between" mb={4}>
								<Text size="xs" c="dimmed" fw={500}>
									{t("subagentRecentCalls")}
								</Text>
								{subagentNarratorId && (
									<Button
										size="compact-xs"
										variant="subtle"
										onClick={(event) => {
											event.stopPropagation();
											handleViewSession();
										}}
									>
										{t("openFullSubagentSession")}
									</Button>
								)}
							</Group>
							{/* No gap: trace rows sit flush against each other, and these ARE trace
							    rows now — a 4px seam was part of the old tinted-button look. */}
							<Stack gap={0}>
								{activityCalls.map((call) => (
									<SubagentActivityRow
										key={call.id ?? call.toolUseId}
										call={call}
										disabled={!subagentNarratorId}
										onActivate={handleViewSession}
									/>
								))}
							</Stack>
						</Box>
					)}

					<LazyCollapse in={effectiveExpanded}>
						{selfPermission && (
							<Box mx="xs" mb="xs" onClick={(event) => event.stopPropagation()}>
								<InlinePermission
									permission={selfPermission}
									onDecision={permCb?.onPermissionDecision}
									onQuestionSubmit={permCb?.onQuestionSubmit}
									onQuestionReflect={permCb?.onQuestionReflect}
									onQuestionDeny={permCb?.onQuestionDeny}
								/>
							</Box>
						)}

						{prompt && (
							<Box px="xs" pb="xs">
								<UnstyledButton onClick={() => setShowPrompt((value) => !value)}>
									<Group gap={4}>
										{showPrompt ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
										<Text size="xs" c="dimmed" fw={500}>
											{t("subagentPrompt")}
										</Text>
									</Group>
								</UnstyledButton>
								<LazyCollapse in={showPrompt}>
									<Box mt={4}>
										<ContentViewer
											content={promptPreview}
											fullContent={prompt}
											style={{
												fontSize: 11,
												maxHeight: 200,
												overflow: "auto",
												whiteSpace: "pre-wrap",
											}}
											title={t("subagentPrompt")}
										/>
									</Box>
								</LazyCollapse>
							</Box>
						)}

						{pendingPermissions.length > 0 && (
							<Box px="xs" pb="xs">
								<Text size="xs" c="yellow" fw={500} mb={4}>
									{t("subagentWaitingPermission", { count: pendingPermissions.length })}
								</Text>
								<Stack gap={4}>
									{pendingPermissions.map((permission) => (
										<Box
											key={permission.id}
											onClick={(event) => event.stopPropagation()}
											style={{ border: "1px solid var(--mantine-color-yellow-6)", borderRadius: 4 }}
										>
											<ToolCallCard
												toolCall={subagentPermissionToToolCallData(permission)}
												narratorId={permission.ownerNarratorId ?? narratorId}
												pendingPermission={permission}
												isRecent={isRecent}
												onPermissionDecision={permCb?.onPermissionDecision}
												onQuestionSubmit={permCb?.onQuestionSubmit}
												onQuestionReflect={permCb?.onQuestionReflect}
												onQuestionDeny={permCb?.onQuestionDeny}
											/>
										</Box>
									))}
								</Stack>
							</Box>
						)}

						{isSuspended && subagentNarratorId && canResolveOverride && (
							<Box px="xs" pb="xs">
								<Button
									size="compact-xs"
									variant="light"
									color="yellow"
									onClick={(event) => {
										event.stopPropagation();
										api.updateSubagentConclusion(subagentNarratorId);
									}}
								>
									{t("resolveOverride")}
								</Button>
							</Box>
						)}

						{resultText && (
							<Box px="xs" pb="xs">
								<ContentViewer
									content={resultText}
									fullContent={fullResultText}
									style={{ fontSize: 11, maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap" }}
									title={`${agentType} — ${description}`}
									markdown
									contentType="markdown"
								/>
							</Box>
						)}
					</LazyCollapse>
					{inRun && !isLast && <Divider color="var(--mantine-color-default-border)" size={1} />}
				</Box>
			</MessageContextMenuCtx.Provider>
		</NestedBlockCtx.Provider>
	);

	const swipeMenu =
		hasCardActions &&
		(swipe.swipeOffset > 0 || swipe.swipeClosing) &&
		(() => {
			const menuEl = swipe.swipeMenuRef.current;
			const pos = swipe.getSwipeMenuPosition(menuEl?.offsetHeight);
			return createPortal(
				<Box
					ref={swipe.swipeMenuRef}
					style={{
						position: "fixed",
						left: pos.left,
						top: pos.top,
						transform: "translateY(-50%)",
						zIndex: Z.popover,
						transition: swipe.swipeMenuTransition,
						pointerEvents: swipe.swipeClosing ? "none" : "auto",
					}}
				>
					<Menu opened withinPortal={false} position="bottom-start">
						<Menu.Dropdown style={{ position: "relative", width: SWIPE_REVEAL_WIDTH }}>
							{menuItems}
						</Menu.Dropdown>
					</Menu>
				</Box>,
				document.body,
			);
		})();

	const ctxMenu = hasCardActions && swipe.ctxMenuOpened && (
		<Menu
			opened={swipe.ctxMenuOpened}
			onChange={swipe.setCtxMenuOpened}
			position="bottom-start"
			withinPortal
			styles={{
				dropdown: {
					position: "fixed",
					left: swipe.ctxMenuPos.x,
					...(swipe.ctxMenuPos.flipY
						? { bottom: window.innerHeight - swipe.ctxMenuPos.y, top: "auto" }
						: { top: swipe.ctxMenuPos.y }),
				},
			}}
		>
			<Menu.Target>
				<div
					style={{
						position: "fixed",
						left: swipe.ctxMenuPos.x,
						top: swipe.ctxMenuPos.y,
						pointerEvents: "none",
					}}
				/>
			</Menu.Target>
			<Menu.Dropdown>{menuItems}</Menu.Dropdown>
		</Menu>
	);

	const renderedCard = inRun ? (
		card
	) : (
		<Paper
			withBorder
			radius="sm"
			style={{
				overflow: "hidden",
				borderColor:
					selfPermission || pendingPermissions.length > 0
						? "var(--mantine-color-yellow-6)"
						: undefined,
			}}
		>
			{card}
		</Paper>
	);

	return (
		<>
			<Box ref={swipe.swipeBoxRef} onContextMenu={swipe.handleContextMenu} style={swipe.swipeStyle}>
				{renderedCard}
			</Box>
			{swipeMenu}
			{ctxMenu}
		</>
	);
});
