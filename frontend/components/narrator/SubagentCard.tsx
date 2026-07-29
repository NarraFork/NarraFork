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
import {
	hasSubagentToolInputSummary,
	subagentSummaryToPartialInput,
} from "@shared/subagent-tool-summary";
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
	InlinePermission,
	STATUS_COLORS,
	StatusIcon,
	ToolCallCard,
	ToolCategoryChip,
	ToolTimingArea,
} from "./ToolCallCard";
import { getSummary } from "./tool-display";

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
 * Fixed slot for the decorative status glyph (12×12 — `StatusIcon` and `Loader`
 * both render at size={12}).
 *
 * Two independent effects used to make every glyph-bearing row change height:
 *
 *  1. `StatusIcon` returns `null` for any status outside its known set (`""` and
 *     whatever a provider sends next), so an auto-sized wrapper collapsed to 0×0.
 *     `streaming` used to land here too — the row's very FIRST status rendering as
 *     an empty slot, fixed by folding it into the spinner branch — so the slot has
 *     to stay height-neutral for the unknown-status case that remains.
 *  2. When it DID render, the wrapper was a block box holding an inline `<svg>`,
 *     so its line box came from the ROOT font size (16 × 1.55 = 24.8px), not
 *     from the 12px glyph — inflating the row by ~8px rather than fitting it.
 *
 * A tool call walks `streaming → running → success` during its lifetime, so the
 * row visibly jumped between heights on every transition. Sizing the slot
 * explicitly and laying it out as flex makes the glyph height-neutral in both
 * directions; `flexShrink: 0` keeps the label from eating the reservation.
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
 * Fixed slot for the CATEGORY chip. Same reservation contract as the status slot
 * above, at the chip's own size: {@link ToolCategoryChip} is a 16×16 tinted tile
 * (the tool card's header lane), not a 12px glyph, so reusing the status slot's
 * 12×12 box would clip the tile's tinted edge.
 */
export const SUBAGENT_CATEGORY_SLOT_SIZE = 16;
export const SUBAGENT_CATEGORY_SLOT_STYLE = {
	width: SUBAGENT_CATEGORY_SLOT_SIZE,
	height: SUBAGENT_CATEGORY_SLOT_SIZE,
	flexShrink: 0,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
} as const satisfies CSSProperties;

/**
 * Category chip for an activity row — the SAME mark the tool card's header shows.
 *
 * This used to be a bare `<Icon>` that inherited the row's dimmed text colour, so
 * the identical tool rendered as a grey outline here and as a category-tinted
 * tile on its own card. It now renders {@link ToolCategoryChip}, the shared
 * definition, so glyph, size, tint, and radius cannot drift between the two.
 *
 * `getCategory` takes an optional input so it can reclassify spec-task file writes;
 * the activity row carries no full input, so the category comes from the tool name
 * alone. Only spec-tasks reclassifies on input, so every other tool is unaffected.
 */
function CategoryGlyph({ toolName }: { toolName: string }) {
	return (
		<ToolCategoryChip
			category={getCategory(toolName)}
			toolName={toolName}
			data-testid="subagent-activity-category-chip"
		/>
	);
}

/**
 * Height reservation for rows that combine status/category glyphs, a label and
 * `ToolTimingArea`.
 *
 * Three different line boxes meet in this row: the timing text at line-height
 * 1.55 (18.6px at `xs`), the label at Mantine's 1.4 (16.8px), and — before the
 * glyphs were moved into fixed-size flex slots — an inline `<svg>` whose line
 * box came from the *root* font size, 16 × 1.55 = 24.8px. The row moved by
 * ~1.8px when the timer appeared and by ~8px depending on whether a glyph
 * rendered at all.
 *
 * The slots pinned the glyph contribution, but pinning it to the *smallest* of
 * the three also made every row ~6px shorter than it used to be, which read as
 * cramped. This reserves the original 24.8px line box instead: rows keep their
 * familiar height and still cannot move, because every cell inside is either a
 * fixed-size slot or a single truncating line.
 *
 * Derived from the root font size rather than hard-coded so it tracks the user's
 * font scale, and expressed as `min-height` so content that legitimately grows
 * (a wrapped badge row) still grows instead of being clipped.
 *
 * The 16px category chip still fits inside the 24.8px reservation, so adopting
 * the tool card's chip did not change the row's height — the reservation, not
 * the tallest cell, is what sets it.
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

function isTerminalToolStatus(status: string | undefined): boolean {
	return /^(success|completed|denied|error|fail|failed|cancelled|canceled|aborted|timeout)$/.test(
		status ?? "",
	);
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
 * Row label detail for one recent call: `Bash` → its `description`, `Read` →
 * the file's basename, `Await` → `type: id`.
 *
 * Formatting is delegated to `getSummary`, the SAME formatter the expanded tool
 * card uses, so a row and its card cannot word the same call differently. It is
 * fed a PARTIAL input rebuilt from the whitelisted keys the server projected;
 * verified to degrade cleanly (a `Read` carrying only `file_path` yields
 * `component.tsx`, with no phantom line range).
 *
 * Returns null when there is nothing extra to say, which is what keeps the row
 * from reading `Bash · Bash`. `getSummary` answers with a placeholder rather than
 * an empty string for an input it cannot label (`Bash` → "Bash", `Await` →
 * "task: unknown"), so a summary equal to the tool name — or to that Await
 * placeholder — is treated as "no detail".
 */
export function subagentActivitySummaryText(call: ToolCallData): string | null {
	const summary = call._inputSummary;
	if (!hasSubagentToolInputSummary(summary)) return null;
	const text = getSummary(call.toolName, subagentSummaryToPartialInput(summary)).trim();
	if (!text || text === call.toolName) return null;
	// `Await` with no usable id degrades to this literal; it carries no information
	// beyond the tool name already shown.
	if (text === "task: unknown") return null;
	return text;
}

/**
 * One "recent calls" row: status glyph + tool name + optional summary + timing.
 *
 * The label is available on a call's FIRST appearance, whether it arrived by REST
 * fetch, reconnect catch-up, or a live `tool_started` / `tool_use_chunk` frame —
 * all three now carry the same projected summary, so a row no longer starts as a
 * bare tool name and acquires its detail only on the next page load.
 *
 * Extracted so the row has a single definition that tests and the layout probe
 * can render directly. Its height must not depend on the tool-call status — see
 * {@link SUBAGENT_STATUS_SLOT_STYLE} and {@link SUBAGENT_STATUS_ROW_MIN_HEIGHT} —
 * nor on whether a summary is present or how long it is: the tool name and the
 * summary share one fixed-height flex line, each `truncate`, so a 200-char
 * summary clips instead of wrapping.
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
	return (
		<UnstyledButton
			data-testid="subagent-activity"
			disabled={disabled}
			onClick={(event) => {
				event.stopPropagation();
				onActivate?.();
			}}
			style={{
				width: "100%",
				padding: "5px 7px",
				borderRadius: "var(--mantine-radius-sm)",
				background: "var(--mantine-color-default-hover)",
			}}
		>
			<Group
				gap={6}
				wrap="nowrap"
				data-testid="subagent-activity-row"
				style={{ minHeight: SUBAGENT_STATUS_ROW_MIN_HEIGHT }}
			>
				<Box
					data-testid="subagent-activity-status-slot"
					c={STATUS_COLORS[call.status] ?? "gray"}
					style={SUBAGENT_STATUS_SLOT_STYLE}
				>
					<StatusIcon status={call.status} />
				</Box>
				{/* Category chip, derived from the tool *name* alone — which is all this row
				    has, since the activity summary carries no full input. Its own fixed slot,
				    sized for the 16px chip rather than the 12px status glyph, so it is
				    height-neutral: an unknown tool still occupies the slot rather than
				    collapsing it and shortening the row. No `c` here — the chip carries the
				    category colour itself, and a dimmed inherit is exactly the bug this
				    replaced. */}
				<Box data-testid="subagent-activity-category-slot" style={SUBAGENT_CATEGORY_SLOT_STYLE}>
					<CategoryGlyph toolName={call.toolName} />
				</Box>
				{/* One flex LINE holding name + summary. `minWidth: 0` on both the line and
				    the summary is what lets `truncate` engage instead of the text forcing
				    the row wider (or taller, once it wraps). The tool name never shrinks
				    below its content so a long summary cannot squeeze it away. */}
				<Box
					data-testid="subagent-activity-label"
					style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4 }}
				>
					<Text size="xs" truncate style={{ flexShrink: 0 }}>
						{call.toolName}
					</Text>
					{summaryText && (
						<Text
							data-testid="subagent-activity-summary"
							size="xs"
							c="dimmed"
							truncate
							style={{ flex: 1, minWidth: 0 }}
						>
							{summaryText}
						</Text>
					)}
				</Box>
				<ToolTimingArea toolCall={call} isActive={!isTerminalToolStatus(call.status)} />
			</Group>
		</UnstyledButton>
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
							<Stack gap={4}>
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
