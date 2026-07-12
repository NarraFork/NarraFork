import {
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Loader,
	Menu,
	Paper,
	Text,
	ThemeIcon,
	UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
	IconArrowBackUp,
	IconChevronDown,
	IconChevronRight,
	IconChevronUp,
	IconCloudOff,
	IconEye,
	IconMessageQuestion,
	IconPlayerStop,
	IconRobot,
	IconTrash,
} from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNarrator, useSubagentChildren, useToolCallDetail } from "../../hooks/useNarrator";
import { useNarratorSubagentsCapability } from "../../hooks/usePlatform";
import { useSwipeMenu } from "../../hooks/useSwipeMenu";
import { api } from "../../lib/api";
import { formatDurationText } from "../../lib/format";
import { Z } from "../../lib/z-index";
import { BlurInOnAppear } from "./BlurInOnAppear";
import { getToolCallBlurAnimationId } from "./blur-in-ids";
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
import {
	filterChildrenByToolUse,
	hasToolUse,
	resolveAllToolCallsFromMsg,
	resolvePendingPerm,
} from "./narrator-message-helpers";
import type { ContentBlock, NarratorMsg, PermissionCallbacks } from "./narrator-panel-types";
import type { ToolCallData } from "./ToolCallCard";
import {
	ElapsedTimer,
	InlinePermission,
	STATUS_COLORS,
	StatusIcon,
	ToolCallCard,
} from "./ToolCallCard";
import { getFilePath } from "./tool-display";
import { useNearestScrollContainerHeight } from "./useNearestScrollContainerHeight";

const FIXED_MENU_TRANSITION_PROPS = { duration: 0 };

/** Lightweight shape of the subagent narrator data from query cache */
interface SubagentNarratorData {
	status?: string;
	substatus?: string | string[];
	/** Client-only field injected by onSubagentWarning, cleared by onSubagentConclusionUpdated */
	_retryInfo?: {
		message: string;
		retryCount?: number;
		maxRetries?: number;
		retryAt?: number;
	};
}

const SUBAGENT_ID_RE = /<subagent_id>[^<]*<\/subagent_id>/g;
const MAX_SUBAGENT_RESULT_PREVIEW_CHARS = 120_000;
const MAX_SUBAGENT_PROMPT_INLINE_CHARS = 120_000;
const MAX_SUBAGENT_DESCRIPTION_CHARS = 4_000;
const stripSubagentId = (text: string) => text.replace(SUBAGENT_ID_RE, "").trim();

/**
 * Merge two subagent child-message lists by id. Used in the omitted-children
 * mode as a safety net so any WS-delivered realtime children (appended to the
 * `childMessages` prop) survive alongside the lazy-loaded tree — covering the
 * edge where a subagent flips terminal and a late child message arrives. When
 * both sides carry the same id, prefer the entry with non-empty children and
 * merge the shallow fields (WS-live over fetched for freshness).
 */
function mergeChildMessagesById(fetched: NarratorMsg[], live: NarratorMsg[]): NarratorMsg[] {
	if (live.length === 0) return fetched;
	if (fetched.length === 0) return live;
	const byId = new Map<string, NarratorMsg>();
	const order: string[] = [];
	const add = (msg: NarratorMsg) => {
		const id = msg.id;
		if (!id) return;
		const existing = byId.get(id);
		if (!existing) {
			byId.set(id, msg);
			order.push(id);
			return;
		}
		const existingChildren = existing.children ?? [];
		const incomingChildren = msg.children ?? [];
		byId.set(id, {
			...existing,
			...msg,
			children:
				incomingChildren.length >= existingChildren.length ? incomingChildren : existingChildren,
		});
	};
	for (const msg of fetched) add(msg);
	for (const msg of live) add(msg);
	return order.map((id) => byId.get(id)).filter((m): m is NarratorMsg => m != null);
}

function appendLimited(parts: string[], value: string, budget: { remaining: number }) {
	if (budget.remaining <= 0 || value.length === 0) return;
	const chunk = value.length > budget.remaining ? value.slice(0, budget.remaining) : value;
	parts.push(chunk);
	budget.remaining -= chunk.length;
}

function capSubagentResult(text: string, maxChars = MAX_SUBAGENT_RESULT_PREVIEW_CHARS): string {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars);
}

/**
 * Extract the _text value from a truncated JSON preview string.
 * The preview may look like: `{"_text":"actual content here...` (cut mid-string).
 * Falls back to the raw preview if _text is not found.
 */
function extractTextFromPreview(preview: string): string {
	// Try complete _text value first
	const complete = preview.match(/"_text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	if (complete) {
		try {
			return capSubagentResult(JSON.parse(`"${complete[1]}"`));
		} catch {
			return capSubagentResult(complete[1]);
		}
	}
	// Try truncated _text value (no closing quote — preview was cut mid-value)
	const truncated = preview.match(/"_text"\s*:\s*"((?:[^"\\]|\\.)*)/);
	if (truncated) {
		try {
			return capSubagentResult(JSON.parse(`"${truncated[1]}"`));
		} catch {
			return capSubagentResult(truncated[1]);
		}
	}
	return capSubagentResult(preview);
}

/**
 * Build a bounded preview of a generic JSON-like value without first
 * stringifying the whole object.
 */
function appendJsonPreview(
	parts: string[],
	value: unknown,
	budget: { remaining: number },
	seen: WeakSet<object>,
	depth = 0,
) {
	if (budget.remaining <= 0) return;
	if (
		value === null ||
		value === undefined ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		appendLimited(parts, value === undefined ? "undefined" : JSON.stringify(value), budget);
		return;
	}
	if (typeof value === "string") {
		appendLimited(parts, JSON.stringify(capSubagentResult(value, budget.remaining)), budget);
		return;
	}
	if (typeof value !== "object") {
		appendLimited(parts, JSON.stringify(String(value)), budget);
		return;
	}
	if (seen.has(value)) {
		appendLimited(parts, '"[Circular]"', budget);
		return;
	}
	seen.add(value);
	if (Array.isArray(value)) {
		appendLimited(parts, "[", budget);
		for (let i = 0; i < value.length && budget.remaining > 0; i++) {
			if (i > 0) appendLimited(parts, ", ", budget);
			appendJsonPreview(parts, value[i], budget, seen, depth + 1);
		}
		appendLimited(parts, "]", budget);
		return;
	}
	appendLimited(parts, "{", budget);
	let index = 0;
	for (const [key, child] of Object.entries(value)) {
		if (budget.remaining <= 0) break;
		appendLimited(
			parts,
			`${index > 0 ? "," : ""}\n${"\t".repeat(depth + 1)}${JSON.stringify(key)}: `,
			budget,
		);
		appendJsonPreview(parts, child, budget, seen, depth + 1);
		index++;
	}
	if (index > 0) appendLimited(parts, `\n${"\t".repeat(depth)}}`, budget);
	else appendLimited(parts, "}", budget);
}

function stringifyJsonPreview(value: unknown): string {
	const parts: string[] = [];
	appendJsonPreview(parts, value, { remaining: MAX_SUBAGENT_RESULT_PREVIEW_CHARS }, new WeakSet());
	return parts.join("");
}

/**
 * Parse outputJson into a displayable raw string.
 * Handles: plain string, truncated preview, content block array,
 * structured { _text, _metadata }, and generic object fallback.
 */
// biome-ignore lint/suspicious/noExplicitAny: outputJson is untyped
function parseOutputJson(out: any): string {
	if (!out) return "";
	if (typeof out === "string") return capSubagentResult(out);
	if (out._truncated && typeof out.preview === "string") {
		return extractTextFromPreview(out.preview);
	}
	if (Array.isArray(out)) {
		const budget = { remaining: MAX_SUBAGENT_RESULT_PREVIEW_CHARS };
		const parts: string[] = [];
		for (const block of out as ContentBlock[]) {
			if (budget.remaining <= 0) break;
			if (!block.text) continue;
			if (parts.length > 0) appendLimited(parts, "\n", budget);
			appendLimited(parts, block.text, budget);
		}
		return parts.join("");
	}
	if (typeof out._text === "string") return capSubagentResult(out._text);
	if (typeof out === "object") return stringifyJsonPreview(out);
	return "";
}

export interface SubagentCardProps {
	toolCall: ToolCallData;
	childMessages: NarratorMsg[];
	narratorId: string;
	inRun?: boolean;
	isLast?: boolean;
	isSoleInRun?: boolean;
	permCb?: PermissionCallbacks;
	onViewSubagentSession?: (narratorId: string) => void;
	/** Block index within the parent message's contentJson array */
	blockIndex?: number;
}

export const SubagentCard = memo(
	function SubagentCard({
		toolCall,
		childMessages,
		narratorId,
		inRun,
		isLast,
		isSoleInRun,
		permCb,
		onViewSubagentSession,
		blockIndex,
	}: SubagentCardProps) {
		const { t } = useTranslation("narrator");
		const navigate = useNavigate();
		// biome-ignore lint/suspicious/noExplicitAny: loose search params
		const routeSearch = useSearch({ strict: false }) as any;
		const fromParam = routeSearch?.from as string | undefined;
		const input = toolCall.inputJson ?? {};
		const subagentsCapability = useNarratorSubagentsCapability();
		const subagentsSupported = subagentsCapability.supported;
		const canViewSubagentSession = subagentsSupported && subagentsCapability.detachAttach;
		const canDetachToBackground =
			subagentsSupported && subagentsCapability.background && subagentsCapability.detachAttach;
		const canCancelBackground = subagentsSupported && subagentsCapability.background;
		const canResolveOverride = subagentsSupported && subagentsCapability.staleRecovery;
		const isBackground = !!input.background || !!input.run_in_background;
		const agentType = input.subagent_type ?? "agent";
		const isBuiltinType = ["explore", "plan", "general", "agent"].includes(agentType);
		const agentBadgeColor = isBuiltinType ? "indigo" : "teal";
		const isTerminal = /^(success|completed|denied|error|fail|cancelled)$/.test(toolCall.status);
		const isInitializing = toolCall.status === "initializing";
		const soleAndRunning = !!isSoleInRun && !isTerminal;
		const [expanded, setExpanded] = useState(!!isSoleInRun);
		const promptValue = input.prompt ?? (toolCall.toolName === "Send" ? input.message : "");
		const prompt = typeof promptValue === "string" ? promptValue : String(promptValue ?? "");
		const promptPreview = capSubagentResult(prompt, MAX_SUBAGENT_PROMPT_INLINE_CHARS);
		const promptHasLineBreak = prompt.includes("\n");
		const promptShownInHeader = !input.description && !!prompt && !promptHasLineBreak;
		const rawDescription =
			input.description ?? (promptShownInHeader ? prompt : prompt.slice(0, 80));
		const description = capSubagentResult(
			String(rawDescription ?? "Subagent"),
			MAX_SUBAGENT_DESCRIPTION_CHARS,
		);
		const [showPrompt, setShowPrompt] = useState(false);
		const [showCalls, setShowCalls] = useState(soleAndRunning);
		const statusColor = STATUS_COLORS[toolCall.status] ?? "gray";

		// Terminal subagents omit their children from the chunk payload. Only fetch
		// the actual tool list when BOTH the card and its tool-call area are
		// expanded — and paginate (newest 20, scroll up for older). Still-active
		// subagents keep their children inline (childMessages); this stays disabled.
		const childrenOmitted = !!toolCall._subagentChildrenOmitted;
		const {
			data: lazyChildren,
			isLoading: lazyChildrenLoading,
			isFetchingNextPage: lazyFetchingOlder,
			hasNextPage: lazyHasOlder,
			fetchNextPage: lazyFetchOlder,
		} = useSubagentChildren(
			narratorId,
			toolCall.toolUseId ?? "",
			childrenOmitted && expanded && showCalls,
		);
		// Flatten paginated pages (each returned ascending by seq; pages are
		// newest-first, so reverse the page order for a single ascending list).
		const lazyMessages = useMemo(() => {
			if (!lazyChildren?.pages?.length) return [] as NarratorMsg[];
			const out: NarratorMsg[] = [];
			for (let i = lazyChildren.pages.length - 1; i >= 0; i--) {
				out.push(...((lazyChildren.pages[i].messages ?? []) as NarratorMsg[]));
			}
			return out;
		}, [lazyChildren?.pages]);
		// In omitted mode, merge WS-delivered live children (in the prop) with the
		// lazy-loaded window so late realtime updates are never dropped.
		const effectiveChildMessages = useMemo(() => {
			if (!childrenOmitted) return childMessages;
			return mergeChildMessagesById(lazyMessages, childMessages);
		}, [childrenOmitted, lazyMessages, childMessages]);

		const resolvedModel =
			effectiveChildMessages[0]?.subagentModel ??
			toolCall._resolvedModel ??
			toolCall._subagentModel ??
			input.model;

		// Clamp card height to 70% of the nearest scroll container (chat viewport).
		const cardRef = useRef<HTMLDivElement>(null);
		const scrollBoxRef = useRef<HTMLDivElement>(null);
		const vpHeight = useNearestScrollContainerHeight(cardRef, 0.7);
		// When paging OLDER (scroll up), we prepend messages and must keep the
		// viewport anchored to the same content instead of jumping to the bottom.
		const olderPrependAnchorRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
		const prevChildCount = useRef(effectiveChildMessages.length);
		useEffect(() => {
			const el = scrollBoxRef.current;
			if (!el) return;
			const anchor = olderPrependAnchorRef.current;
			if (anchor) {
				// Older band was prepended: restore scroll so the previously-visible
				// content stays put (offset by the newly-added height at the top).
				olderPrependAnchorRef.current = null;
				el.scrollTop = anchor.prevTop + (el.scrollHeight - anchor.prevHeight);
			} else if (effectiveChildMessages.length > prevChildCount.current) {
				// New live child appended at the bottom: follow to bottom.
				el.scrollTop = el.scrollHeight;
			}
			prevChildCount.current = effectiveChildMessages.length;
		}, [effectiveChildMessages.length]);

		// Load the next (older) band: capture current scroll metrics so the effect
		// above can restore the anchored position instead of jumping to the bottom.
		// Shared by the pinned "load earlier" button and the scroll-up trigger.
		const loadOlderCalls = useCallback(() => {
			if (!lazyHasOlder || lazyFetchingOlder) return;
			const el = scrollBoxRef.current;
			if (el) {
				olderPrependAnchorRef.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
			}
			lazyFetchOlder();
		}, [lazyHasOlder, lazyFetchingOlder, lazyFetchOlder]);
		// Scroll-up-to-load-older: also trigger when the list nears the top.
		const handleCallsScroll = useCallback(() => {
			const el = scrollBoxRef.current;
			if (!el || el.scrollTop > 48) return;
			loadOlderCalls();
		}, [loadOlderCalls]);
		// Scroll to bottom after expand animation finishes (LazyCollapse ~200ms)
		useEffect(() => {
			if (!expanded) return;
			const t = setTimeout(() => {
				const el = scrollBoxRef.current;
				if (el) el.scrollTop = el.scrollHeight;
			}, 250);
			return () => clearTimeout(t);
		}, [expanded]);

		// Extract result text from outputJson
		const isTruncatedOutput = toolCall.outputJson?._truncated === true;
		const { data: fullTc } = useToolCallDetail(
			narratorId,
			toolCall.toolUseId ?? "",
			isTruncatedOutput && expanded,
		);
		const resultText = useMemo(() => {
			return stripSubagentId(parseOutputJson(toolCall.outputJson));
		}, [toolCall.outputJson]);
		const fullResultText = useMemo(() => {
			if (!fullTc?.outputJson) return undefined;
			const stripped = stripSubagentId(parseOutputJson(fullTc.outputJson));
			return stripped || undefined;
		}, [fullTc?.outputJson]);

		// Render all subagent results as markdown
		const useMarkdown = true;
		const childToolCalls = useMemo(() => {
			const calls: {
				tc: ToolCallData;
				toolUseId: string | null;
				msgId: string;
				childMsg: NarratorMsg;
			}[] = [];
			for (const cm of effectiveChildMessages) {
				if (!hasToolUse(cm)) continue;
				for (const tc of resolveAllToolCallsFromMsg(cm)) {
					calls.push({ tc, toolUseId: tc.toolUseId ?? null, msgId: cm.id, childMsg: cm });
				}
			}
			return calls;
		}, [effectiveChildMessages]);
		// Header call count. When children are omitted, prefer the marker total
		// (known without loading) so the count shows whether or not the tool list
		// is expanded; fall back to the loaded count for inline subagents. If more
		// tool calls have actually been loaded than the (possibly stale) marker
		// reports, show the larger loaded count.
		const markerCallCount = toolCall._subagentChildToolCallCount ?? 0;
		const childCallCount = childrenOmitted
			? Math.max(markerCallCount, childToolCalls.length)
			: childToolCalls.length;
		const writePathSummary = useMemo(() => {
			const paths: string[] = [];
			for (const { tc } of childToolCalls) {
				if (tc.toolName !== "Write") continue;
				const path = getFilePath(tc.inputJson);
				if (path && !paths.includes(path)) paths.push(path);
			}
			if (paths.length === 0) return "";
			const shown = paths.slice(0, 2).join(", ");
			return paths.length > 2 ? `${shown}, +${paths.length - 2}` : shown;
		}, [childToolCalls]);

		const totalMs = toolCall.durationMs ?? 0;

		// Check if the Task tool call itself has a pending permission (e.g. custom workdir)
		const selfPerm = resolvePendingPerm(
			toolCall,
			permCb?.pendingPermission,
			permCb?.pendingPermsMap,
		);

		// Find the child tool call that has a pending permission (if any)
		const permChild =
			childToolCalls.find((c) => c.tc.status === "pending") ??
			childToolCalls.find((c) => c.tc.toolUseId && permCb?.pendingPermsMap?.has(c.tc.toolUseId)) ??
			(permCb?.pendingPermission?.toolUseId
				? childToolCalls.find((c) => c.tc.toolUseId === permCb.pendingPermission?.toolUseId)
				: null);

		// Auto-expand the subagent card AND tool calls list when a child needs permission,
		// then scroll to bottom after LazyCollapse animation finishes
		const permChildId = permChild?.toolUseId ?? null;
		useEffect(() => {
			if (permChildId) {
				setExpanded(true);
				setShowCalls(true);
				const t = setTimeout(() => {
					const el = scrollBoxRef.current;
					if (el) el.scrollTop = el.scrollHeight;
					// Notify the outer scroll container (NarratorPanel) that this card
					// expanded due to a permission request so it should follow to bottom.
					cardRef.current?.dispatchEvent(
						new CustomEvent("subagent-auto-expand", { bubbles: true }),
					);
				}, 300);
				return () => clearTimeout(t);
			}
		}, [permChildId]);

		// Auto-expand when the Task tool itself needs permission (e.g. custom workdir)
		useEffect(() => {
			if (selfPerm) {
				setExpanded(true);
				// Notify outer scroll container after Collapse animation
				const t = setTimeout(() => {
					cardRef.current?.dispatchEvent(
						new CustomEvent("subagent-auto-expand", { bubbles: true }),
					);
				}, 300);
				return () => clearTimeout(t);
			}
		}, [selfPerm]);

		// When subagent finishes successfully: collapse tool calls list.
		// Keep expanded on failure/cancel for easier debugging.
		useEffect(() => {
			if (isTerminal && toolCall.status === "success") {
				setShowCalls(false);
			}
		}, [isTerminal, toolCall.status]);

		// --- Block ID & multi-select ---
		const saBlockId = toolCall.toolUseId ? `sa-${toolCall.toolUseId}` : undefined;
		const selection = useMessageSelection();
		const isSaSelected = !!(
			saBlockId &&
			selection.selectionMode &&
			selection.selectedBlockIds.has(saBlockId)
		);
		const handleDeselectSa = useCallback(() => {
			if (saBlockId) selection.deselectBlock(saBlockId);
		}, [selection.deselectBlock, saBlockId]);

		// --- Swipe / context-menu for SubagentCard itself ---
		const parentMsgCtx = useMessageContextMenu();
		const hasCardActions = !!(
			parentMsgCtx.onDeleteBlock ||
			parentMsgCtx.onCompactBeforeMessage ||
			parentMsgCtx.onAskInPassing ||
			parentMsgCtx.onRollbackToBlock
		);

		const swipe = useSwipeMenu({
			enabled: hasCardActions,
			blockId: saBlockId,
			onSwipeRight: isSaSelected ? handleDeselectSa : undefined,
		});

		// Desktop: Ctrl/Cmd+Click toggles block, Shift+Click range-selects
		const isMobileSa = useMediaQuery("(max-width: 768px)") ?? false;
		const handleSaBlockClick = useCallback(
			(e: React.MouseEvent) => {
				if (isMobileSa || !saBlockId) return;
				const isModKey = e.metaKey || e.ctrlKey;
				const isShift = e.shiftKey;
				if (!isModKey && !isShift) return;
				if (shouldIgnoreMessageBlockSelection(e.target)) return;
				e.preventDefault();
				if (isShift) {
					selection.rangeSelectTo(saBlockId);
				} else {
					selection.toggleBlock(saBlockId);
				}
			},
			[isMobileSa, saBlockId, selection.toggleBlock, selection.rangeSelectTo],
		);

		// Whether the card should show a highlighted border when collapsed
		// (pending permission inside that the user can't see)
		const hasPendingPerm = !expanded && !!(selfPerm || permChild);

		// Resolve the subagent's own narratorId. Prefer the omission-marker id
		// (present even when children aren't loaded), then derive from children.
		const subagentNarratorId = useMemo(() => {
			if (toolCall._subagentNarratorId) return toolCall._subagentNarratorId;
			for (const cm of effectiveChildMessages) {
				if (cm.narratorId && cm.narratorId !== narratorId) return cm.narratorId;
			}
			return null;
		}, [toolCall._subagentNarratorId, effectiveChildMessages, narratorId]);

		// Query the subagent narrator's status to detect "suspended" state
		const { data: subagentNarrator } = useNarrator(subagentNarratorId ?? "");
		const saNarrator = subagentNarrator as SubagentNarratorData | undefined;
		const saSubstatus: string[] = useMemo(() => {
			if (!saNarrator?.substatus) return [];
			if (Array.isArray(saNarrator.substatus)) return saNarrator.substatus;
			try {
				const parsed = JSON.parse(saNarrator.substatus);
				return Array.isArray(parsed) ? parsed : [];
			} catch {
				return [];
			}
		}, [saNarrator?.substatus]);
		const saIsReasoning = saSubstatus.includes("reasoning");
		const isTakenOverSa = saSubstatus.includes("taken_over");
		const isSuspended =
			saSubstatus.includes("suspended") || saSubstatus.includes("manual_override");

		// --- Subagent status bar data ---
		const saStatus = saNarrator?.status;
		const saIsWorking = saStatus === "working";
		const saIsWaiting = saStatus === "waiting";
		const saRetryInfo = saNarrator?._retryInfo;
		const saIsRetrying = !!saRetryInfo;

		// Retry countdown timer for subagent
		const [saRetryCountdown, setSaRetryCountdown] = useState(0);
		useEffect(() => {
			const retryAt = saRetryInfo?.retryAt;
			if (!retryAt) {
				setSaRetryCountdown(0);
				return;
			}
			let id: ReturnType<typeof setInterval> | undefined;
			const tick = () => {
				const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
				setSaRetryCountdown(remaining);
				if (remaining <= 0 && id != null) {
					clearInterval(id);
					id = undefined;
				}
			};
			tick();
			id = setInterval(tick, 1000);
			return () => {
				if (id != null) clearInterval(id);
			};
		}, [saRetryInfo]);

		// Derive the status text to show next to the spinner
		const saStatusText = useMemo(() => {
			if (!isTerminal && !isInitializing) {
				if (saIsRetrying) {
					const count = saRetryInfo?.retryCount ?? 0;
					const max = saRetryInfo?.maxRetries === -1 ? "∞" : (saRetryInfo?.maxRetries ?? "?");
					return saRetryCountdown > 0
						? t("retryingCountdown", { count, max, seconds: saRetryCountdown })
						: t("retryingNow", { count, max });
				}
				if (saIsWaiting) return t("status_waiting");
			}
			return null;
		}, [isTerminal, isInitializing, saIsRetrying, saRetryInfo, saRetryCountdown, saIsWaiting, t]);

		const handleViewSession = useCallback(() => {
			if (subagentNarratorId && !canViewSubagentSession) return;
			if (subagentNarratorId) {
				if (onViewSubagentSession) {
					onViewSubagentSession(subagentNarratorId);
				} else {
					const search: Record<string, string> = {};
					if (fromParam) search.from = fromParam;
					if (toolCall.resultMessageId) search.scrollTo = toolCall.resultMessageId;
					navigate({
						to: "/narrators/$narratorId",
						params: { narratorId: subagentNarratorId },
						search: Object.keys(search).length > 0 ? search : undefined,
					});
				}
				swipe.closeSwipe();
			} else {
				// Fallback: expand card inline if we can't resolve the subagent narrator
				setExpanded(true);
				setShowCalls(true);
				swipe.closeSwipe();
				setTimeout(() => {
					const el = scrollBoxRef.current;
					if (el) el.scrollTop = el.scrollHeight;
				}, 300);
			}
		}, [
			subagentNarratorId,
			canViewSubagentSession,
			onViewSubagentSession,
			swipe.closeSwipe,
			navigate,
			fromParam,
			toolCall.resultMessageId,
		]);

		const isForegroundWorking = !isTerminal && !isBackground && !isInitializing;

		const handleDetach = useCallback(async () => {
			if (!subagentNarratorId || !canDetachToBackground) return;
			try {
				await api.detachSubagent(subagentNarratorId);
			} catch {
				// Ignore — the subagent may have already finished
			}
		}, [canDetachToBackground, subagentNarratorId]);

		const handleCancelBackground = useCallback(async () => {
			if (!subagentNarratorId || !canCancelBackground) return;
			try {
				await api.cancelBackgroundTask(narratorId, subagentNarratorId);
			} catch {
				// Ignore — task may have already finished
			}
		}, [canCancelBackground, narratorId, subagentNarratorId]);

		const cardMenuItems = (
			<>
				<Menu.Item
					leftSection={<IconEye size={14} />}
					disabled={!!subagentNarratorId && !canViewSubagentSession}
					onClick={handleViewSession}
				>
					{t("viewSubagentSession")}
				</Menu.Item>
				{isForegroundWorking && subagentNarratorId && canDetachToBackground && (
					<Menu.Item
						leftSection={<IconCloudOff size={14} />}
						onClick={() => {
							handleDetach();
							swipe.closeSwipe();
						}}
					>
						{t("detachToBackground")}
					</Menu.Item>
				)}
				{isBackground && !isTerminal && subagentNarratorId && canCancelBackground && (
					<Menu.Item
						color="red"
						leftSection={<IconPlayerStop size={14} />}
						onClick={() => {
							handleCancelBackground();
							swipe.closeSwipe();
						}}
					>
						{t("backgroundTasks.cancel")}
					</Menu.Item>
				)}
				{parentMsgCtx.onRollbackToBlock && blockIndex != null && (
					<Menu.Item
						leftSection={<IconArrowBackUp size={14} />}
						onClick={() => {
							parentMsgCtx.onRollbackToBlock?.(blockIndex);
							swipe.closeSwipe();
						}}
					>
						{t("contextMenu_rollback")}
					</Menu.Item>
				)}
				{parentMsgCtx.onAskInPassing && (
					<Menu.Item
						leftSection={<IconMessageQuestion size={14} />}
						onClick={() => {
							parentMsgCtx.onAskInPassing?.();
							swipe.closeSwipe();
						}}
					>
						{t("contextMenu_askInPassing")}
					</Menu.Item>
				)}
				{parentMsgCtx.onCompactBeforeMessage && (
					<CompactMenuSub
						onCompact={parentMsgCtx.onCompactBeforeMessage}
						onClearContext={parentMsgCtx.onClearContextBefore}
						onManualSummarize={parentMsgCtx.onManualSummarize}
						onClose={() => swipe.closeSwipe()}
					/>
				)}
				{parentMsgCtx.onDeleteBlock && blockIndex != null && (
					<Menu.Item
						color="red"
						leftSection={<IconTrash size={14} />}
						onClick={() => {
							parentMsgCtx.onDeleteBlock?.(blockIndex);
							swipe.closeSwipe();
						}}
					>
						{t("contextMenu_delete")}
					</Menu.Item>
				)}
			</>
		);

		// Prevent child ContentViewers / ToolCallCards from inheriting
		// the parent message's swipe/context-menu actions
		const emptyCtx: MessageContextMenuActions = {};

		const content = (
			<NestedBlockCtx.Provider value={saBlockId ?? null}>
				<MessageContextMenuCtx.Provider value={emptyCtx}>
					<Box ref={cardRef} className={isInitializing ? "tool-card-shimmer" : undefined}>
						{/* Header: two-line collapsed view */}
						<UnstyledButton onClick={() => setExpanded((o) => !o)} w="100%" p="xs">
							{/* Line 1: icon | type | model | calls | status | duration | chevron */}
							<Group gap={5} wrap="nowrap">
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
									<Badge size="xs" variant="light" color="violet">
										{resolvedModel}
									</Badge>
								)}
								{input.reasoning_effort && (
									<Badge size="xs" variant="light" color="grape">
										{input.reasoning_effort}
									</Badge>
								)}
								<Box style={{ flex: 1, minWidth: 0 }} />
								<Group
									gap={4}
									wrap="nowrap"
									style={{ flexShrink: 1, minWidth: 0, overflow: "hidden" }}
								>
									{saStatusText && !isTerminal && (
										<Text
											size="xs"
											c={saIsRetrying ? "yellow" : saIsReasoning ? "grape" : "blue"}
											truncate
											style={{ flexShrink: 1, minWidth: 0 }}
										>
											{saStatusText}
										</Text>
									)}
									{childCallCount > 0 && (
										<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
											{childCallCount} calls
										</Text>
									)}
									{!isTerminal &&
									!isInitializing &&
									(saIsWorking || saIsWaiting || saIsRetrying || saIsReasoning) ? (
										<Loader
											size={12}
											color={
												saIsRetrying
													? "yellow"
													: saIsReasoning
														? "grape"
														: saIsWaiting
															? "yellow"
															: "blue"
											}
											style={{ flexShrink: 0 }}
										/>
									) : (
										<Box c={statusColor} style={{ flexShrink: 0 }}>
											<StatusIcon status={toolCall.status} />
										</Box>
									)}
									{toolCall.startedAt != null && !isTerminal ? (
										<ElapsedTimer startedAt={toolCall.startedAt} />
									) : (
										totalMs > 0 && (
											<Text size="xs" c="dimmed" ff="monospace">
												{formatDurationText(totalMs, { style: "precise" })}
											</Text>
										)
									)}
									{expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
								</Group>
							</Group>
							{/* Line 2: description (truncated when collapsed) */}
							{isTakenOverSa ? (
								<Group gap={6} mt={2} ml={21}>
									<Text size="xs" c="grape">
										{t("subagentTakenOver")}
									</Text>
									{subagentNarratorId && canViewSubagentSession && (
										<Button
											size="compact-xs"
											variant="light"
											color="grape"
											onClick={(e: React.MouseEvent) => {
												e.stopPropagation();
												handleViewSession();
											}}
										>
											{t("openSubagentSession")}
										</Button>
									)}
								</Group>
							) : isSuspended ? (
								<Group gap={6} mt={2} ml={21}>
									<Text size="xs" c="yellow">
										{t("subagentSuspended")}
									</Text>
									{subagentNarratorId && canResolveOverride && (
										<Button
											size="compact-xs"
											variant="light"
											color="yellow"
											onClick={(e: React.MouseEvent) => {
												e.stopPropagation();
												api.updateSubagentConclusion(subagentNarratorId);
											}}
										>
											{t("resolveOverride")}
										</Button>
									)}
								</Group>
							) : (
								<Text
									size="xs"
									c="dimmed"
									mt={2}
									ml={21}
									truncate={!expanded}
									style={expanded ? { whiteSpace: "pre-wrap" } : undefined}
								>
									{description}
								</Text>
							)}
							{/* Collapsed result preview */}
							{!expanded && isTerminal && resultText && (
								<Text size="xs" c="dimmed" mt={2} ml={21} truncate opacity={0.7}>
									→ {resultText.slice(0, 120)}
								</Text>
							)}
						</UnstyledButton>
						<Box>
							<LazyCollapse in={expanded}>
								{/* Permission request for the Task tool itself (e.g. custom workdir) */}
								{selfPerm && (
									<Box mx="xs" mb={4}>
										<InlinePermission
											permission={selfPerm}
											onDecision={permCb?.onPermissionDecision}
											onQuestionSubmit={permCb?.onQuestionSubmit}
											onQuestionReflect={permCb?.onQuestionReflect}
											onQuestionDeny={permCb?.onQuestionDeny}
										/>
									</Box>
								)}
								{/* Prompt — shown first when expanded */}
								{prompt && (
									<Box px="xs" pb={4}>
										<UnstyledButton onClick={() => setShowPrompt((o) => !o)}>
											<Group gap={4}>
												{showPrompt ? (
													<IconChevronDown size={12} />
												) : (
													<IconChevronRight size={12} />
												)}
												<Text size="xs" c="dimmed" fw={500}>
													Prompt
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
													title="Prompt"
												/>
											</Box>
										</LazyCollapse>
									</Box>
								)}
								{/* Child tool calls — in the middle. Gate on the header count so the
								    toggle shows for omitted subagents before their tool list loads. */}
								{childCallCount > 0 && (
									<Box px="xs" pb="xs">
										<UnstyledButton onClick={() => setShowCalls((o) => !o)}>
											<Group gap={4}>
												{showCalls ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
												<Text size="xs" c="dimmed" truncate title={writePathSummary || undefined}>
													{childCallCount} tool calls
													{!showCalls && writePathSummary ? ` · ${writePathSummary}` : ""}
												</Text>
											</Group>
										</UnstyledButton>
										<LazyCollapse in={showCalls}>
											{showCalls ? (
												<Box mt={4}>
													{/* Pinned "load earlier" control — always visible at the top of
													    the list so the user doesn't have to scroll up. Shows a
													    spinner while the initial window or an older band loads. */}
													{childrenOmitted &&
														(lazyHasOlder ||
															lazyFetchingOlder ||
															(lazyChildrenLoading && childToolCalls.length === 0)) && (
															<Box
																pl="xs"
																pb={4}
																style={{
																	borderBottom: "1px solid var(--mantine-color-default-border)",
																	marginBottom: 4,
																}}
															>
																{lazyFetchingOlder ||
																(lazyChildrenLoading && childToolCalls.length === 0) ? (
																	<Group gap={6} justify="center" py={2}>
																		<Loader size={12} />
																		<Text size="xs" c="dimmed">
																			{t("status_waiting")}
																		</Text>
																	</Group>
																) : (
																	<Button
																		size="compact-xs"
																		variant="subtle"
																		color="gray"
																		fullWidth
																		leftSection={<IconChevronUp size={12} />}
																		onClick={loadOlderCalls}
																	>
																		{t("loadOlderCalls")}
																	</Button>
																)}
															</Box>
														)}
													<Box
														ref={scrollBoxRef}
														onScroll={childrenOmitted ? handleCallsScroll : undefined}
														pl="xs"
														style={{
															overflow: "hidden auto",
															maxHeight: vpHeight,
														}}
													>
														{(() => {
															const els: React.ReactNode[] = [];
															let ci = 0;
															while (ci < childToolCalls.length) {
																const item = childToolCalls[ci];
																const subCh = filterChildrenByToolUse(
																	item.childMsg?.children,
																	item.tc.toolUseId,
																);
																const isSub =
																	(subCh && subCh.length > 0) || item.tc.toolName === "Agent";
																if (isSub) {
																	const subAnimId = getToolCallBlurAnimationId({
																		toolUseId: item.toolUseId,
																		messageId: item.msgId,
																		fallbackKey: ci,
																	});
																	els.push(
																		<BlurInOnAppear
																			key={item.toolUseId ?? item.tc.toolName}
																			animationId={subAnimId}
																		>
																			<div
																				id={
																					item.toolUseId
																						? `tool-use-${item.toolUseId}`
																						: `msg-${item.msgId}`
																				}
																			>
																				<SubagentCard
																					toolCall={item.tc}
																					childMessages={subCh ?? []}
																					narratorId={narratorId}
																					permCb={permCb}
																					onViewSubagentSession={onViewSubagentSession}
																				/>
																			</div>
																		</BlurInOnAppear>,
																	);
																	ci++;
																	continue;
																}
																// Collect consecutive non-subagent calls into a run
																const run: typeof childToolCalls = [item];
																let j = ci + 1;
																while (j < childToolCalls.length) {
																	const nx = childToolCalls[j];
																	const nxCh = filterChildrenByToolUse(
																		nx.childMsg?.children,
																		nx.tc.toolUseId,
																	);
																	if ((nxCh && nxCh.length > 0) || nx.tc.toolName === "Agent")
																		break;
																	run.push(nx);
																	j++;
																}
																if (run.length >= 2) {
																	els.push(
																		<Box
																			key={`crun-${run[0].msgId}`}
																			style={{
																				border: "1px solid var(--mantine-color-default-border)",
																				borderRadius: "var(--mantine-radius-sm)",
																				overflow: "hidden",
																			}}
																		>
																			{run.map((r, ri) => {
																				const mp = resolvePendingPerm(
																					r.tc,
																					permCb?.pendingPermission,
																					permCb?.pendingPermsMap,
																				);
																				const runAnimId = getToolCallBlurAnimationId({
																					toolUseId: r.toolUseId,
																					messageId: r.msgId,
																					fallbackKey: ri,
																				});
																				return (
																					<BlurInOnAppear
																						key={r.toolUseId ?? r.tc.toolName}
																						animationId={runAnimId}
																					>
																						<div
																							id={
																								r.toolUseId
																									? `tool-use-${r.toolUseId}`
																									: `msg-${r.msgId}`
																							}
																						>
																							<ToolCallCard
																								toolCall={r.tc}
																								narratorId={narratorId}
																								inRun
																								isLast={ri === run.length - 1}
																								pendingPermission={mp}
																								onPermissionDecision={permCb?.onPermissionDecision}
																								onQuestionSubmit={permCb?.onQuestionSubmit}
																								onQuestionReflect={permCb?.onQuestionReflect}
																								onQuestionDeny={permCb?.onQuestionDeny}
																							/>
																						</div>
																					</BlurInOnAppear>
																				);
																			})}
																		</Box>,
																	);
																} else {
																	const r = run[0];
																	const mp = resolvePendingPerm(
																		r.tc,
																		permCb?.pendingPermission,
																		permCb?.pendingPermsMap,
																	);
																	const singleAnimId = getToolCallBlurAnimationId({
																		toolUseId: r.toolUseId,
																		messageId: r.msgId,
																		fallbackKey: ci,
																	});
																	els.push(
																		<BlurInOnAppear
																			key={r.toolUseId ?? r.tc.toolName}
																			animationId={singleAnimId}
																		>
																			<div
																				id={
																					r.toolUseId ? `tool-use-${r.toolUseId}` : `msg-${r.msgId}`
																				}
																			>
																				<ToolCallCard
																					toolCall={r.tc}
																					narratorId={narratorId}
																					pendingPermission={mp}
																					onPermissionDecision={permCb?.onPermissionDecision}
																					onQuestionSubmit={permCb?.onQuestionSubmit}
																					onQuestionReflect={permCb?.onQuestionReflect}
																					onQuestionDeny={permCb?.onQuestionDeny}
																				/>
																			</div>
																		</BlurInOnAppear>,
																	);
																}
																ci = j;
															}
															return els;
														})()}
													</Box>
												</Box>
											) : null}
										</LazyCollapse>
									</Box>
								)}
								{/* Result — shown at the bottom */}
								{resultText && (
									<Box px="xs" pb={4}>
										<ContentViewer
											content={resultText}
											fullContent={fullResultText}
											style={{
												fontSize: 11,
												maxHeight: 300,
												overflow: "auto",
												whiteSpace: "pre-wrap",
											}}
											title={`${agentType} — ${description}`}
											markdown={useMarkdown}
											contentType={useMarkdown ? "markdown" : "code"}
										/>
									</Box>
								)}
							</LazyCollapse>
						</Box>
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
							opacity: swipe.swipeClosing ? 0 : 1,
						}}
					>
						<Menu opened withinPortal={false} position="bottom-start">
							<Menu.Dropdown style={{ position: "relative", width: 180 }}>
								{cardMenuItems}
							</Menu.Dropdown>
						</Menu>
					</Box>,
					document.body,
				);
			})();

		const ctxMenu = hasCardActions && (
			<Menu
				opened={swipe.ctxMenuOpened}
				onChange={swipe.setCtxMenuOpened}
				position="bottom-start"
				withinPortal
				transitionProps={FIXED_MENU_TRANSITION_PROPS}
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
				<Menu.Dropdown>{cardMenuItems}</Menu.Dropdown>
			</Menu>
		);

		const buildSelectionStyle = (): React.CSSProperties => {
			const selOffset = isMobileSa && isSaSelected && !swipe.swipeRevealed ? 180 : 0;
			const effTransform =
				swipe.swipeOffset > 0
					? undefined
					: selOffset > 0
						? `translateX(-${selOffset}px)`
						: undefined;
			return {
				...swipe.swipeStyle,
				...(effTransform ? { transform: effTransform } : {}),
				...(isSaSelected
					? {
							outline: "2px solid var(--mantine-color-indigo-6)",
							outlineOffset: -2,
							borderRadius: 4,
						}
					: {}),
			};
		};

		if (inRun) {
			return (
				<>
					<Box
						ref={swipe.swipeBoxRef}
						onContextMenu={swipe.handleContextMenu}
						onClick={handleSaBlockClick}
						style={{
							...buildSelectionStyle(),
							...(hasPendingPerm
								? {
										outline: "1px solid var(--mantine-color-yellow-6)",
										outlineOffset: -1,
									}
								: {}),
						}}
						{...(saBlockId ? { [BLOCK_ID_ATTR]: saBlockId } : {})}
						{...(parentMsgCtx.messageId ? { "data-message-id": parentMsgCtx.messageId } : {})}
						{...(blockIndex != null ? { "data-block-index": String(blockIndex) } : {})}
					>
						{content}
					</Box>
					{swipeMenu}
					{ctxMenu}
				</>
			);
		}

		return (
			<>
				<Box
					ref={swipe.swipeBoxRef}
					onContextMenu={swipe.handleContextMenu}
					onClick={handleSaBlockClick}
					style={buildSelectionStyle()}
					{...(saBlockId ? { [BLOCK_ID_ATTR]: saBlockId } : {})}
					{...(parentMsgCtx.messageId ? { "data-message-id": parentMsgCtx.messageId } : {})}
					{...(blockIndex != null ? { "data-block-index": String(blockIndex) } : {})}
				>
					<Paper
						withBorder={!inRun}
						radius={inRun ? 0 : "sm"}
						style={{
							overflow: "hidden",
							...(selfPerm || hasPendingPerm
								? { borderColor: "var(--mantine-color-yellow-6)" }
								: {}),
						}}
					>
						{content}
					</Paper>
				</Box>
				{swipeMenu}
				{ctxMenu}
			</>
		);
	},
	(prev, next) =>
		prev.toolCall === next.toolCall &&
		prev.childMessages === next.childMessages &&
		prev.narratorId === next.narratorId &&
		prev.inRun === next.inRun &&
		prev.isLast === next.isLast &&
		prev.isSoleInRun === next.isSoleInRun &&
		prev.onViewSubagentSession === next.onViewSubagentSession &&
		prev.permCb?.pendingPermsMap === next.permCb?.pendingPermsMap,
);
