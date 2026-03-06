import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Center,
	CloseButton,
	Group,
	Image,
	Indicator,
	Loader,
	Menu,
	Modal,
	NativeSelect,
	ScrollArea,
	Stack,
	Text,
	Textarea,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
	IconArchive,
	IconArrowDown,
	IconArrowLeft,
	IconArrowsMinimize,
	IconCheck,
	IconCode,
	IconCodeOff,
	IconEraser,
	IconPaperclip,
	IconShield,
	IconSparkles,
	IconTerminal,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorCommands } from "../../hooks/useCommands";
import { useAllModels } from "../../hooks/useModels";
import {
	useArchiveNarrator,
	useForkNarrator,
	useInterruptNarrator,
	useNarrator,
	useNarratorMessages,
	useUpdateModel,
	useUpdatePermissionMode,
	useUpdateReasoningEffort,
} from "../../hooks/useNarrator";
import { useNarratorTerminals } from "../../hooks/useTerminals";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api, type TreeMessage } from "../../lib/api";
import type { ModelOption } from "../../lib/constants";
import { NARRATOR_STATUS_COLORS } from "../../lib/constants";
import { SelectionPopover } from "../common/SelectionPopover";
import { ChapterBar } from "./ChapterBar";
import { type CommandItem, CommandPopover } from "./CommandPopover";
import {
	MemoizedPageElements,
	RenderProgress,
	renderToolRun,
	StreamingBubble,
} from "./MessageRenderer";
import { findMsgByToolUseIdInTree } from "./message-tree-utils";
import type {
	ContentBlock,
	MessagesQueryData,
	NarratorMsg,
	NarratorPanelProps,
	TodoItem,
} from "./narrator-panel-types";
import {
	ACCEPTED_TYPES,
	MAX_IMAGE_SIZE,
	PERM_MODE_ICONS,
	PERM_MODES,
	STREAMING_CHUNKS_MSG_ID,
} from "./narrator-panel-types";
import { LatestTodosToolUseIdCtx } from "./ToolCallCard";
import { useNarratorPanelWS } from "./useNarratorPanelWS";
import { useProgressiveMessageCount } from "./useProgressiveMessageCount";

/* ── Shared menu-item renderers (desktop NativeSelect + mobile ActionIcon share these) ── */

const PERM_MODE_DATA = PERM_MODES.map((m) => ({ value: m, label: `perm_${m}` }));

function ModelMenuItems({
	allModels,
	currentModel,
	totalCostUsd,
	onSelect,
	label,
}: {
	allModels: ModelOption[];
	currentModel: string | null | undefined;
	totalCostUsd: number | null | undefined;
	onSelect: (model: string) => void;
	label?: string;
}) {
	const groups = new Map<string, ModelOption[]>();
	for (const m of allModels) {
		if (!groups.has(prov)) groups.set(prov, []);
		groups.get(prov)?.push(m);
	}
	const entries = [...groups.entries()];
	return (
		<>
			{totalCostUsd != null && totalCostUsd > 0 && (
				<>
					<Menu.Label ta="right">${totalCostUsd.toFixed(4)}</Menu.Label>
					<Menu.Divider />
				</>
			)}
			{label && <Menu.Label>{label}</Menu.Label>}
			{entries.map(([prov, models], gi) => (
				<span key={prov}>
					{gi > 0 && <Menu.Divider />}
					<Menu.Label>{provLabels[prov] ?? prov}</Menu.Label>
					{models.map((m) => {
						const selected = currentModel === m.value;
						return (
							<Menu.Item
								key={m.value}
								onClick={() => onSelect(m.value)}
								rightSection={
									<Group gap={4} wrap="nowrap">
										{m.rateMultiplier != null && (
											<Badge size="xs" variant="outline" color="gray">
												×{m.rateMultiplier}
											</Badge>
										)}
										<IconCheck size={14} style={{ visibility: selected ? "visible" : "hidden" }} />
									</Group>
								}
								fw={selected ? 600 : 400}
							>
								{m.label}
							</Menu.Item>
						);
					})}
				</span>
			))}
		</>
	);
}

function PermModeMenuItems({
	currentMode,
	onSelect,
	t,
}: {
	currentMode: string;
	onSelect: (mode: string) => void;
	t: (key: string) => string;
}) {
	return (
		<>
			{PERM_MODES.map((mode) => {
				const selected = currentMode === mode;
				return (
					<Menu.Item
						key={mode}
						leftSection={PERM_MODE_ICONS[mode]}
						onClick={() => onSelect(mode)}
						rightSection={
							<IconCheck size={14} style={{ visibility: selected ? "visible" : "hidden" }} />
						}
						fw={selected ? 600 : 400}
					>
						{t(`perm_${mode}`)}
					</Menu.Item>
				);
			})}
		</>
	);
}

function ReasoningEffortMenuItems({
	currentEffort,
	onSelect,
	t,
}: {
	currentEffort: string | null | undefined;
	onSelect: (effort: string | null) => void;
	t: (key: string) => string;
}) {
	return (
		<>
			<Menu.Label>{t("reasoningEffort")}</Menu.Label>
			{(["", "low", "medium", "high", "xhigh"] as const).map((effort) => {
				const selected = (currentEffort ?? "") === effort || (!currentEffort && effort === "");
				return (
					<Menu.Item
						key={effort}
						onClick={() => onSelect(effort || null)}
						rightSection={
							<IconCheck size={14} style={{ visibility: selected ? "visible" : "hidden" }} />
						}
						fw={selected ? 600 : 400}
					>
						{t(effort ? `reasoning_${effort}` : "reasoning_auto")}
					</Menu.Item>
				);
			})}
		</>
	);
}

export function NarratorPanel({
	narratorId,
	narrator: narratorProp,
	onForkFromMessage,
	highlightMessageId,
	onSendToTerminal,
	appendInputRef,
	terminalOpen,
	onToggleTerminal,
}: NarratorPanelProps) {
	const navigate = useNavigate();
	const { data: fetchedNarrator } = useNarrator(narratorId);
	const narrator = narratorProp ?? fetchedNarrator;
	const forkNarratorMutation = useForkNarrator();
	const {
		data: messagesData,
		isLoading: messagesLoading,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
	} = useNarratorMessages(narratorId, highlightMessageId);
	const interruptMutation = useInterruptNarrator();
	const archiveMutation = useArchiveNarrator();
	const permModeMutation = useUpdatePermissionMode();
	const reasoningEffortMutation = useUpdateReasoningEffort();
	const modelMutation = useUpdateModel();
	const { visibleModels: allModels } = useAllModels();
	const { data: userPrefs } = useUserPreferences();
	const autoLoadEnabled = userPrefs?.autoLoadOlderMessages ?? true;
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const { t: tt } = useTranslation("terminal");
	const qc = useQueryClient();

	// Active terminal count for badge indicator
	const { data: narratorTerminals } = useNarratorTerminals(narratorId);
	const activeTerminalCount = useMemo(
		() => narratorTerminals?.filter((t) => t.status === "running").length ?? 0,
		[narratorTerminals],
	);

	const messagesQueryKey = useMemo(
		() => ["narrators", narratorId, "messages", { around: highlightMessageId }],
		[narratorId, highlightMessageId],
	);

	// --- Message operations ---
	const setContextPercentRef =
		useRef<React.Dispatch<React.SetStateAction<number | null>>>(undefined);
	const setUnreadCountRef = useRef<React.Dispatch<React.SetStateAction<number>>>(undefined);
	const handleDeleteMessage = useCallback(
		async (messageId: string) => {
			const prev = qc.getQueryData<MessagesQueryData>(messagesQueryKey);
			qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
				if (!old?.pages?.length) return old;
				const pages = old.pages.map((page) => ({
					...page,
					messages: page.messages.filter((m: NarratorMsg) => m.id !== messageId),
				}));
				let foundCp: number | null = null;
				for (const page of pages) {
					for (let i = page.messages.length - 1; i >= 0; i--) {
						const cp = (page.messages[i] as unknown as Record<string, unknown>).contextPercent;
						if (cp != null) {
							foundCp = cp as number;
							break;
						}
					}
					if (foundCp != null) break;
				}
				setContextPercentRef.current?.(foundCp);
				return { ...old, pages };
			});
			try {
				await api.deleteMessage(narratorId, messageId);
			} catch {
				qc.setQueryData(messagesQueryKey, prev);
				notifications.show({
					title: t("deleteMessageFailed"),
					message: t("deleteMessageFailedDesc"),
					color: "red",
					autoClose: 5000,
				});
			}
		},
		[qc, messagesQueryKey, narratorId, t],
	);

	const handleCompactBefore = useCallback(
		(messageId: string) => {
			api.triggerCompact(narratorId, messageId).catch(() => {
				notifications.show({
					title: t("compactFailed"),
					message: t("compactFailedDesc"),
					color: "red",
					autoClose: 5000,
				});
			});
		},
		[narratorId, t],
	);

	// --- Input management ---
	const [input, setInput] = useState(
		() => sessionStorage.getItem(`narrafork_draft_${narratorId}`) ?? "",
	);
	useEffect(() => {
		if (input) {
			sessionStorage.setItem(`narrafork_draft_${narratorId}`, input);
		} else {
			sessionStorage.removeItem(`narrafork_draft_${narratorId}`);
		}
	}, [input, narratorId]);

	// --- Command popover ---
	const { data: commandsList } = useNarratorCommands(narratorId);
	const commandPopoverVisible =
		input.startsWith("/") && !input.includes("\n") && (commandsList?.length ?? 0) > 0;
	const handleCommandSelect = useCallback((cmd: CommandItem) => {
		if (cmd.type === "skill") {
			// Skill selected — insert a prompt that tells the AI to load this skill
			setInput(`Please load the "${cmd.name}" skill and apply it to: `);
		} else if (cmd.prompt.includes("{{input}}")) {
			// Place cursor where {{input}} would go
			setInput(`/${cmd.name} `);
		} else {
			setInput(cmd.prompt);
		}
	}, []);
	const closeCommandPopover = useCallback(() => {
		setInput("");
	}, []);
	useEffect(() => {
		if (appendInputRef) {
			appendInputRef.current = (text: string) =>
				setInput((prev) => (prev ? `${prev}\n${text}` : text));
		}
		return () => {
			if (appendInputRef) appendInputRef.current = null;
		};
	}, [appendInputRef]);
	const [attachedImages, setAttachedImages] = useState<File[]>([]);

	// --- Scroll state ---
	const [isAtBottom, setIsAtBottom] = useState(true);
	const viewportRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const isAtBottomRef = useRef(isAtBottom);
	isAtBottomRef.current = isAtBottom;

	// --- Scroll helpers ---
	const followRafRef = useRef(0);
	const followingRef = useRef(false);
	// Suppress detachFromBottom for programmatic scrollTop changes.
	// - `programmaticScrollRef` is a one-shot flag for individual scrollTop writes
	//   (e.g. scrollToBottom instant, startFollowing final snap).
	// - `resizingRef` is a sustained flag that stays true for the entire duration
	//   of a viewport resize (set by vpObserver, cleared after a 150ms debounce).
	//   During a resize, multiple scroll events fire from multiple programmatic
	//   scrollTop writes; a one-shot flag can't cover them all, so we need this
	//   sustained flag to prevent the oscillation loop.
	const programmaticScrollRef = useRef(false);
	const resizingRef = useRef(false);

	const lastFollowScrollTop = useRef(0);

	const startFollowing = useCallback(() => {
		if (followingRef.current) return;
		const step = () => {
			const vp = viewportRef.current;
			if (!vp) {
				followingRef.current = false;
				return;
			}
			// If scrollTop decreased since last frame, user scrolled up — stop following
			if (vp.scrollTop < lastFollowScrollTop.current) {
				followingRef.current = false;
				return;
			}
			const target = vp.scrollHeight - vp.clientHeight;
			const gap = target - vp.scrollTop;
			if (gap < 1.5) {
				programmaticScrollRef.current = true;
				vp.scrollTop = target;
				followingRef.current = false;
				if (!isAtBottomRef.current) {
					isAtBottomRef.current = true;
					setIsAtBottom(true);
					setUnreadCountRef.current?.(0);
				}
				return;
			}
			vp.scrollTop += Math.max(gap * 0.25, 1.5);
			lastFollowScrollTop.current = vp.scrollTop;
			followRafRef.current = requestAnimationFrame(step);
		};
		followingRef.current = true;
		lastFollowScrollTop.current = viewportRef.current?.scrollTop ?? 0;
		followRafRef.current = requestAnimationFrame(step);
	}, []);

	const stopFollowing = useCallback(() => {
		followingRef.current = false;
		cancelAnimationFrame(followRafRef.current);
	}, []);

	const scrollToBottom = useCallback(
		(instant?: boolean) => {
			const vp = viewportRef.current;
			if (!vp) return;
			if (!isAtBottomRef.current) {
				isAtBottomRef.current = true;
				setIsAtBottom(true);
			}
			setUnreadCountRef.current?.(0);
			if (instant) {
				programmaticScrollRef.current = true;
				vp.scrollTop = vp.scrollHeight;
			} else {
				startFollowing();
			}
		},
		[startFollowing],
	);

	// --- WebSocket + real-time state ---
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const isSubagent = (fetchedNarrator as any)?.type === "subagent";
	const wsState = useNarratorPanelWS({
		narratorId,
		narratorStatus: narrator?.status,
		narratorErrorMessage: narrator?.errorMessage ?? null,
		messagesData,
		messagesQueryKey,
		isAtBottomRef,
		scrollToBottom,
		narratorTodosJson: narrator?.todosJson,
		narratorTodosToolUseId: narrator?.todosToolUseId,
		isSubagent,
	});
	const {
		disconnected,
		reconnect,
		sendBufferMessage,
		cancelBuffer,
		streamingRef,
		streamingReasoningRef,
		streamingVersion,
		renderPermCb,
		bufferedText,
		setBufferedText,
		isCompacting,
		contextPercent,
		promptTokens,
		contextWindow,
		pruneBoundaryMessageId,
		prunedPercent,
		currentTodos,
		todosToolUseId,
		expandedToolUseId,
		setExpandedToolUseId,
		editExpandOverride,
		setEditExpandOverride,
		unreadCount,
		setUnreadCount,
	} = wsState;
	setContextPercentRef.current = wsState.setContextPercent;
	setUnreadCountRef.current = setUnreadCount;

	const [archiveConfirmOpened, { open: openArchiveConfirm, close: closeArchiveConfirm }] =
		useDisclosure(false);

	const isWorking = narrator?.status === "thinking";
	const isActive = narrator?.status === "thinking" || narrator?.status === "waiting";
	const isWaiting = narrator?.status === "waiting";
	const isPlanning = narrator?.planMode && narrator?.status === "thinking";
	const showWorkIndicator = !!(isWorking || isWaiting || isCompacting);

	const activeTodo = useMemo(() => {
		if (!currentTodos?.length) return null;
		return currentTodos.find((t: TodoItem) => t.status === "in_progress") ?? null;
	}, [currentTodos]);

	// --- Image management ---
	const imagePreviewUrls = useMemo(
		() => attachedImages.map((f) => URL.createObjectURL(f)),
		[attachedImages],
	);
	useEffect(() => {
		return () => {
			for (const url of imagePreviewUrls) URL.revokeObjectURL(url);
		};
	}, [imagePreviewUrls]);

	// --- Title editing ---
	const [editingTitle, setEditingTitle] = useState(false);
	const [titleValue, setTitleValue] = useState("");
	const [generatingTitle, setGeneratingTitle] = useState(false);
	const titleInputRef = useRef<HTMLInputElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Force react-textarea-autosize to recalculate after viewport width
	// changes (e.g. DevTools mobile↔desktop toggle). The library recalculates
	// on window "resize" but can read stale layout during rapid toggles.
	// Bumping a counter triggers a React re-render → useLayoutEffect inside
	// TextareaAutosize fires resizeTextarea() with the final layout values.
	const [, setTextareaResizeTick] = useState(0);
	useEffect(() => {
		const ta = textareaRef.current;
		if (!ta) return;
		let prevWidth = ta.clientWidth;
		let timer = 0;
		const ro = new ResizeObserver(() => {
			const w = ta.clientWidth;
			if (w !== prevWidth) {
				prevWidth = w;
				clearTimeout(timer);
				// Wait for layout to settle before triggering re-render
				timer = window.setTimeout(() => {
					setTextareaResizeTick((n) => n + 1);
				}, 100);
			}
		});
		ro.observe(ta);
		return () => {
			clearTimeout(timer);
			ro.disconnect();
		};
	}, []);

	const startEditingTitle = () => {
		setTitleValue(narrator?.title || "");
		setEditingTitle(true);
	};
	useEffect(() => {
		if (editingTitle) {
			titleInputRef.current?.focus();
			titleInputRef.current?.select();
		}
	}, [editingTitle]);
	const saveTitle = async () => {
		if (generatingTitle) return;
		const trimmed = titleValue.trim();
		if (trimmed && trimmed !== narrator?.title) {
			await api.updateNarratorTitle(narratorId, trimmed);
			qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
		}
		setEditingTitle(false);
	};
	const handleGenerateTitle = async () => {
		setGeneratingTitle(true);
		try {
			const { title } = await api.generateNarratorTitle(narratorId);
			setTitleValue(title);
			qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
		} finally {
			setGeneratingTitle(false);
		}
	};
	const handleTitleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			saveTitle();
		} else if (e.key === "Escape") {
			setEditingTitle(false);
		}
	};

	// --- Long-press interrupt ---
	const [interruptProgress, setInterruptProgress] = useState(0);
	const interruptTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const interruptFiredRef = useRef(false);
	const clearInterruptTimer = useCallback(() => {
		if (interruptTimerRef.current) {
			clearInterval(interruptTimerRef.current);
			interruptTimerRef.current = null;
		}
		setInterruptProgress(0);
		interruptFiredRef.current = false;
	}, []);
	const interruptMutationRef = useRef(interruptMutation);
	interruptMutationRef.current = interruptMutation;
	const narratorIdRef = useRef(narratorId);
	narratorIdRef.current = narratorId;
	const clearInterruptTimerRef = useRef(clearInterruptTimer);
	clearInterruptTimerRef.current = clearInterruptTimer;

	const startInterruptPress = useCallback((_e: React.MouseEvent) => {
		interruptFiredRef.current = false;
		const start = Date.now();
		const duration = 600;
		interruptTimerRef.current = setInterval(() => {
			const elapsed = Date.now() - start;
			const pct = Math.min(elapsed / duration, 1);
			setInterruptProgress(pct);
			if (pct >= 1 && !interruptFiredRef.current) {
				interruptFiredRef.current = true;
				if (interruptTimerRef.current != null) clearInterval(interruptTimerRef.current);
				interruptTimerRef.current = null;
				interruptMutationRef.current.mutate(narratorIdRef.current);
			}
		}, 16);
	}, []);
	const interruptBtnCleanupRef = useRef<(() => void) | null>(null);
	const interruptBtnRef = useCallback((btn: HTMLButtonElement | null) => {
		if (interruptBtnCleanupRef.current) {
			interruptBtnCleanupRef.current();
			interruptBtnCleanupRef.current = null;
		}
		if (!btn) return;
		const onTouchStart = (e: TouchEvent) => {
			e.preventDefault();
			interruptFiredRef.current = false;
			const start = Date.now();
			const duration = 600;
			interruptTimerRef.current = setInterval(() => {
				const elapsed = Date.now() - start;
				const pct = Math.min(elapsed / duration, 1);
				setInterruptProgress(pct);
				if (pct >= 1 && !interruptFiredRef.current) {
					interruptFiredRef.current = true;
					if (interruptTimerRef.current != null) clearInterval(interruptTimerRef.current);
					interruptTimerRef.current = null;
					interruptMutationRef.current.mutate(narratorIdRef.current);
				}
			}, 16);
		};
		const onTouchEnd = () => clearInterruptTimerRef.current();
		const onTouchCancel = () => clearInterruptTimerRef.current();
		btn.addEventListener("touchstart", onTouchStart, { passive: false });
		btn.addEventListener("touchend", onTouchEnd);
		btn.addEventListener("touchcancel", onTouchCancel);
		interruptBtnCleanupRef.current = () => {
			btn.removeEventListener("touchstart", onTouchStart);
			btn.removeEventListener("touchend", onTouchEnd);
			btn.removeEventListener("touchcancel", onTouchCancel);
		};
	}, []);
	useEffect(() => clearInterruptTimer, [clearInterruptTimer]);

	// --- Hydration & message counting ---
	const [hydrated, setHydrated] = useState(false);
	useEffect(() => {
		const id = requestAnimationFrame(() => {
			startTransition(() => setHydrated(true));
		});
		return () => cancelAnimationFrame(id);
	}, []);

	// Lightweight derived values — avoid full reverse().flatMap() on every update.
	const totalMessageCount = useMemo(() => {
		if (!hydrated || !messagesData?.pages) return 0;
		return messagesData.pages.reduce((sum, p) => sum + (p.messages?.length ?? 0), 0);
	}, [hydrated, messagesData]);

	const lastMessage = useMemo<NarratorMsg | null>(() => {
		if (!hydrated || !messagesData?.pages?.length) return null;
		const firstPage = messagesData.pages[0]; // newest page
		if (!firstPage?.messages?.length) return null;
		return firstPage.messages[firstPage.messages.length - 1] ?? null;
	}, [hydrated, messagesData]);

	const deferredStreamingChunks = useMemo(() => {
		if (!lastMessage) return null;
		if (lastMessage.id === STREAMING_CHUNKS_MSG_ID && lastMessage._noMerge) return lastMessage;
		return null;
	}, [lastMessage]);

	const canRetryLastUserMessage =
		!!lastMessage &&
		lastMessage.role === "user" &&
		!String(lastMessage.id).startsWith("optimistic-") &&
		(narrator?.status === "idle" || narrator?.status === "done" || narrator?.status === "error");

	// --- Fork handler ---
	// Standalone narrators: fork narrator directly (no git involved)
	const handleStandaloneFork = useCallback(
		(messageUuid: string) => {
			forkNarratorMutation.mutate(
				{ narratorId, forkMessageUuid: messageUuid },
				{
					onSuccess: (newNarrator: { id: string }) => {
						navigate({ to: "/narrators/$narratorId", params: { narratorId: newNarrator.id } });
					},
				},
			);
		},
		[narratorId, forkNarratorMutation.mutate, navigate],
	);
	// Chapter-bound: use onForkFromMessage (opens ChapterForkModal)
	// Standalone: use handleStandaloneFork (direct narrator fork)
	const forkHandler = narrator?.chapterId ? onForkFromMessage : handleStandaloneFork;

	// --- Progressive rendering ---
	const highlightScrolledRef = useRef(false);
	const initialScrollDoneRef = useRef(false);
	const [initialScrollDone, setInitialScrollDone] = useState(false);
	const [highlightedId, setHighlightedId] = useState<string | null>(null);

	const prevNarratorIdRef = useRef(narratorId);
	if (prevNarratorIdRef.current !== narratorId) {
		prevNarratorIdRef.current = narratorId;
		if (initialScrollDoneRef.current) {
			initialScrollDoneRef.current = false;
			setInitialScrollDone(false);
		}
	}
	const skipProgressive = !!highlightMessageId;
	const { visibleCount, done: renderDone } = useProgressiveMessageCount(
		totalMessageCount,
		20,
		skipProgressive,
		narratorId,
		viewportRef,
	);

	// Trim message cache on unmount / narrator switch
	useEffect(() => {
		const keyToTrim = messagesQueryKey;
		return () => {
			const MAX_CACHED_MESSAGES = 200;
			qc.setQueryData(keyToTrim, (old: MessagesQueryData | undefined) => {
				if (!old?.pages?.length || old.pages.length <= 1) return old;
				let total = 0;
				let keepCount = 0;
				for (const page of old.pages) {
					total += page.messages?.length ?? 0;
					keepCount++;
					if (total >= MAX_CACHED_MESSAGES) break;
				}
				if (keepCount >= old.pages.length) return old;
				return {
					...old,
					pages: old.pages.slice(0, keepCount),
					pageParams: old.pageParams.slice(0, keepCount),
				};
			});
		};
	}, [messagesQueryKey, qc]);

	// --- Visible elements ---
	const showTokenUsage = userPrefs?.showTokenUsage ?? false;
	const visibleElements = useMemo(() => {
		if (!messagesData?.pages || visibleCount === 0) return [];
		const pages = messagesData.pages;
		const reversed = [...pages].reverse();
		if (visibleCount >= totalMessageCount) {
			return reversed.map((page, i) => (
				<MemoizedPageElements
					key={`page-${pages.length - 1 - i}`}
					page={page}
					narratorId={narratorId}
					onForkFromMessage={forkHandler}
					highlightedId={highlightedId}
					permCb={renderPermCb}
					expandedToolUseId={expandedToolUseId}
					editExpandOverride={editExpandOverride}
					showTokenUsage={showTokenUsage}
					onDeleteMessage={handleDeleteMessage}
					onCompactBeforeMessage={handleCompactBefore}
					pruneBoundaryMessageId={pruneBoundaryMessageId}
				/>
			));
		}
		const result: React.ReactNode[] = [];
		let remaining = visibleCount;
		for (let i = reversed.length - 1; i >= 0 && remaining > 0; i--) {
			const page = reversed[i];
			const pageLen = page.messages.length;
			const maxMsg = Math.min(remaining, pageLen);
			result.unshift(
				<MemoizedPageElements
					key={`page-${pages.length - 1 - i}`}
					page={page}
					narratorId={narratorId}
					onForkFromMessage={forkHandler}
					highlightedId={highlightedId}
					permCb={renderPermCb}
					expandedToolUseId={expandedToolUseId}
					editExpandOverride={editExpandOverride}
					showTokenUsage={showTokenUsage}
					maxMessages={maxMsg < pageLen ? maxMsg : undefined}
					onDeleteMessage={handleDeleteMessage}
					onCompactBeforeMessage={handleCompactBefore}
					pruneBoundaryMessageId={pruneBoundaryMessageId}
				/>,
			);
			remaining -= maxMsg;
		}
		return result;
	}, [
		messagesData,
		totalMessageCount,
		visibleCount,
		narratorId,
		forkHandler,
		renderPermCb,
		expandedToolUseId,
		editExpandOverride,
		highlightedId,
		showTokenUsage,
		handleDeleteMessage,
		handleCompactBefore,
		pruneBoundaryMessageId,
	]);

	// --- Load older ---
	const handleLoadOlder = useCallback(() => {
		if (isFetchingNextPage) return;
		fetchNextPage();
	}, [fetchNextPage, isFetchingNextPage]);

	const handleLoadOlderRef = useRef(handleLoadOlder);
	handleLoadOlderRef.current = handleLoadOlder;
	useEffect(() => {
		if (!autoLoadEnabled || !hasNextPage || !initialScrollDone || !renderDone || isFetchingNextPage)
			return;
		const vp = viewportRef.current;
		if (!vp) return;
		const check = () => {
			const st = vp.scrollTop;
			if (st > 0 && st < vp.clientHeight * 2 && vp.scrollHeight > vp.clientHeight) {
				handleLoadOlderRef.current();
			}
		};
		check();
		vp.addEventListener("scroll", check, { passive: true });
		return () => vp.removeEventListener("scroll", check);
	}, [autoLoadEnabled, hasNextPage, initialScrollDone, renderDone, isFetchingNextPage]);

	// --- Scroll state: user-input driven ---
	const lastTouchYRef = useRef(0);
	const cleanupRef = useRef<(() => void) | null>(null);
	const viewportCallbackRef = useCallback((node: HTMLDivElement | null) => {
		cleanupRef.current?.();
		cleanupRef.current = null;
		(viewportRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
		if (!node) return;

		const checkAtBottom = () => {
			const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 30;
			if (atBottom && !isAtBottomRef.current) {
				isAtBottomRef.current = true;
				setIsAtBottom(true);
				setUnreadCountRef.current?.(0);
			}
		};
		const detachFromBottom = () => {
			if (isAtBottomRef.current) {
				isAtBottomRef.current = false;
				setIsAtBottom(false);
			}
		};

		const onWheel = (e: WheelEvent) => {
			if (e.deltaY < 0) detachFromBottom();
		};
		const onTouchStart = (e: TouchEvent) => {
			if (e.touches.length > 0) lastTouchYRef.current = e.touches[0].clientY;
		};
		const onTouchMove = (e: TouchEvent) => {
			if (e.touches.length === 0) return;
			const cur = e.touches[0].clientY;
			const delta = lastTouchYRef.current - cur;
			lastTouchYRef.current = cur;
			if (delta < 0) detachFromBottom();
		};

		let lastScrollTop = node.scrollTop;
		const onScroll = () => {
			const cur = node.scrollTop;
			// During a viewport resize, suppress all detach checks — multiple
			// programmatic scrollTop writes fire multiple scroll events and a
			// one-shot flag can't cover them all.
			if (resizingRef.current) {
				lastScrollTop = cur;
				return;
			}
			// One-shot suppression for individual programmatic scrollTop writes
			// outside of a resize (e.g. scrollToBottom instant).
			if (programmaticScrollRef.current) {
				programmaticScrollRef.current = false;
				lastScrollTop = cur;
				return;
			}
			if (!followingRef.current && cur < lastScrollTop) {
				detachFromBottom();
			}
			lastScrollTop = cur;
		};
		const onScrollEnd = () => {
			if (followingRef.current || resizingRef.current) return;
			checkAtBottom();
		};

		node.addEventListener("wheel", onWheel, { passive: true });
		node.addEventListener("touchstart", onTouchStart, { passive: true });
		node.addEventListener("touchmove", onTouchMove, { passive: true });
		node.addEventListener("scroll", onScroll, { passive: true });
		node.addEventListener("scrollend", onScrollEnd, { passive: true });
		cleanupRef.current = () => {
			node.removeEventListener("wheel", onWheel);
			node.removeEventListener("touchstart", onTouchStart);
			node.removeEventListener("touchmove", onTouchMove);
			node.removeEventListener("scroll", onScroll);
			node.removeEventListener("scrollend", onScrollEnd);
		};
	}, []);

	// --- Initial scroll ---
	useEffect(() => {
		if (
			!initialScrollDoneRef.current &&
			totalMessageCount > 0 &&
			renderDone &&
			!highlightMessageId &&
			isAtBottomRef.current
		) {
			initialScrollDoneRef.current = true;
			setInitialScrollDone(true);
			scrollToBottom(true);
		}
		if (
			!initialScrollDoneRef.current &&
			totalMessageCount > 0 &&
			renderDone &&
			!isAtBottomRef.current
		) {
			initialScrollDoneRef.current = true;
			setInitialScrollDone(true);
		}
	}, [totalMessageCount, renderDone, scrollToBottom, highlightMessageId]);

	// --- Auto-scroll via ResizeObserver ---
	// biome-ignore lint/correctness/useExhaustiveDependencies: initialScrollDone is a trigger dep, not read inside
	useEffect(() => {
		const content = contentRef.current;
		if (!content) return;

		// Track whether the *viewport* itself is being resized (e.g. DevTools
		// mobile↔desktop toggle). During a viewport resize both observers fire
		// in rapid succession; using the RAF-based follow loop in that situation
		// causes continuous scrollTop writes that force layout thrashing, block
		// the main thread, and can trigger React's "Maximum update depth" error.
		let vpResizeTimer = 0;

		const vp = viewportRef.current;

		const contentObserver = new ResizeObserver(() => {
			if (!initialScrollDoneRef.current) return;
			// During a viewport resize, only do synchronous snaps — no setState,
			// no follow loop. setState during ResizeObserver can cause layout →
			// render → layout loops that hit React's max update depth.
			if (resizingRef.current) {
				if (isAtBottomRef.current && !highlightMessageId && vp) {
					programmaticScrollRef.current = true;
					vp.scrollTop = vp.scrollHeight - vp.clientHeight;
				}
				return;
			}
			if (isAtBottomRef.current && !highlightMessageId) {
				startFollowing();
			} else if (!isAtBottomRef.current && !highlightMessageId) {
				if (vp && vp.scrollHeight - vp.scrollTop - vp.clientHeight < 30) {
					isAtBottomRef.current = true;
					setIsAtBottom(true);
				}
			}
		});
		contentObserver.observe(content);

		const vpObserver = new ResizeObserver(() => {
			// Mark that a viewport resize is in progress so the content
			// observer takes the synchronous-snap path, and onScroll
			// suppresses all detach checks for the duration.
			resizingRef.current = true;
			clearTimeout(vpResizeTimer);
			vpResizeTimer = window.setTimeout(() => { resizingRef.current = false; }, 150);

			if (isAtBottomRef.current && !highlightMessageId && vp) {
				programmaticScrollRef.current = true;
				vp.scrollTop = vp.scrollHeight - vp.clientHeight;
			}
		});
		if (vp) vpObserver.observe(vp);

		return () => {
			clearTimeout(vpResizeTimer);
			resizingRef.current = false;
			contentObserver.disconnect();
			vpObserver.disconnect();
			stopFollowing();
		};
	}, [highlightMessageId, startFollowing, stopFollowing, initialScrollDone]);

	// --- Scroll to highlighted message ---
	useEffect(() => {
		if (!highlightMessageId || totalMessageCount === 0 || highlightScrolledRef.current) return;
		const el = document.getElementById(`msg-${highlightMessageId}`);
		if (!el) return;
		highlightScrolledRef.current = true;
		requestAnimationFrame(() => {
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			setTimeout(() => {
				setHighlightedId(highlightMessageId);
				setTimeout(() => setHighlightedId(null), 1600);
			}, 400);
		});
	}, [highlightMessageId, totalMessageCount]);

	// --- Send / retry message ---
	const submitMessage = async (msg: string, images: File[] = []) => {
		streamingRef.current = "";
		streamingReasoningRef.current = "";

		const optimisticBlocks: ContentBlock[] = [
			...images.map((f) => ({
				type: "image",
				filename: f.name,
				mediaType: f.type,
				previewUrl: URL.createObjectURL(f),
			})),
			{ type: "text", text: msg },
		];
		const optimisticMsg: TreeMessage = {
			id: `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			narratorId,
			parentToolUseId: null,
			role: "user",
			contentJson: optimisticBlocks,
			contentText: msg,
			toolCalls: [],
			createdAt: new Date().toISOString(),
			children: [],
		};
		qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
			if (!old?.pages?.length) {
				return {
					pages: [{ messages: [optimisticMsg], hasMore: false, nextCursor: null }],
					pageParams: [undefined],
				};
			}
			const pages = [...old.pages];
			const firstPage = { ...pages[0] };
			firstPage.messages = [...firstPage.messages, optimisticMsg];
			pages[0] = firstPage;
			return { ...old, pages };
		});
		scrollToBottom(true);
		try {
			await api.sendNarratorMessage(narratorId, msg, images.length > 0 ? images : undefined);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to send message";
			notifications.show({ title: "Error", message, color: "red" });
		}
	};

	const handleSend = async () => {
		const msg = input.trim();
		if (!msg) return;
		if (isActive) {
			sendBufferMessage(narratorId, msg);
			setBufferedText(msg);
			setInput("");
			scrollToBottom(true);
			return;
		}
		const images = [...attachedImages];
		setInput("");
		setAttachedImages([]);
		await submitMessage(msg, images);
	};

	const handleRetry = async () => {
		if (!canRetryLastUserMessage) return;
		try {
			await api.retryLastMessage(narratorId);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to retry";
			notifications.show({ title: "Error", message, color: "red" });
		}
	};

	const handleCancelBuffer = () => {
		if (bufferedText) {
			cancelBuffer(narratorId);
			setInput(bufferedText);
			setBufferedText(null);
		}
	};

	const addImages = (files: File[]) => {
		const valid = files.filter((f) => {
			if (!ACCEPTED_TYPES.includes(f.type)) return false;
			if (f.size > MAX_IMAGE_SIZE) return false;
			return true;
		});
		if (valid.length > 0) {
			setAttachedImages((prev) => [...prev, ...valid]);
		}
	};

	const handlePaste = (e: React.ClipboardEvent) => {
		const items = e.clipboardData.items;
		const imageFiles: File[] = [];
		for (const item of items) {
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) imageFiles.push(file);
			}
		}
		if (imageFiles.length > 0) {
			addImages(imageFiles);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		// Let CommandPopover handle keys when visible
		if (commandPopoverVisible) return;
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			handleSend();
		}
	};

	if (!narrator || messagesLoading)
		return (
			<Center h="100%">
				<Loader />
			</Center>
		);

	return (
		<Stack h="100%" gap={0} style={{ overflow: "hidden" }}>
			{/* Header */}
			<Group
				justify="space-between"
				py="xs"
				px="md"
				style={{ borderBottom: "1px solid var(--mantine-color-default-border)", flexShrink: 0 }}
			>
				<Group gap="xs" style={{ flex: 1, minWidth: 0 }}>
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						onClick={() => navigate({ to: ".." })}
					>
						<IconArrowLeft size={16} />
					</ActionIcon>
					<Group gap={4} style={{ flex: 1, minWidth: 0 }} wrap="nowrap">
						{editingTitle ? (
							<TextInput
								ref={titleInputRef}
								value={titleValue}
								onChange={(e) => setTitleValue(e.currentTarget.value)}
								onKeyDown={handleTitleKeyDown}
								onBlur={saveTitle}
								size="xs"
								style={{ flex: 1, maxWidth: 500 }}
							/>
						) : (
							<Text
								size="sm"
								fw={500}
								onDoubleClick={startEditingTitle}
								style={{
									cursor: "pointer",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
									maxWidth: 500,
								}}
								title={narrator.title || t("untitled")}
							>
								{narrator.title || t("untitled")}
							</Text>
						)}
						<ActionIcon
							size="xs"
							variant="subtle"
							onClick={handleGenerateTitle}
							loading={generatingTitle}
							title={t("generateTitle")}
						>
							<IconSparkles size={12} />
						</ActionIcon>
					</Group>
					{disconnected && (
						<Badge
							size="xs"
							variant="dot"
							color="red"
							style={{ cursor: "pointer" }}
							onClick={reconnect}
							title={t("reconnect")}
						>
							{t("disconnected")}
						</Badge>
					)}
				</Group>
				<Group gap="xs">
					<Tooltip label={editExpandOverride === false ? t("expandEdits") : t("collapseEdits")}>
						<ActionIcon
							size="sm"
							variant="subtle"
							color="gray"
							onClick={() =>
								setEditExpandOverride((prev) => (prev === true ? false : prev === false))
							}
						>
							{editExpandOverride === false ? <IconCode size={16} /> : <IconCodeOff size={16} />}
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("archiveNarrator")}>
						<ActionIcon
							size="sm"
							variant="subtle"
							color="orange"
							loading={archiveMutation.isPending}
							onClick={() => {
								openArchiveConfirm();
							}}
						>
							<IconArchive size={16} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Group>

			<Modal
				opened={archiveConfirmOpened}
				onClose={closeArchiveConfirm}
				title={t("archiveConfirmTitle")}
				centered
			>
				<Stack>
					<Text size="sm">{t("archiveActiveWarning")}</Text>
					<Group justify="flex-end">
						<Button variant="default" onClick={closeArchiveConfirm}>
							{t("cancel")}
						</Button>
						<Button
							color="orange"
							onClick={async () => {
								if (isActive) {
									await interruptMutation.mutateAsync(narratorId);
								}
								archiveMutation.mutate(narratorId);
								closeArchiveConfirm();
							}}
						>
							{t("confirmArchive")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			{/* Messages */}
			<Box pos="relative" style={{ flex: 1, minHeight: 0 }}>
				{(isFetchingNextPage || !renderDone) && (
					<Box pos="absolute" top={0} left={0} right={0} style={{ zIndex: 1 }}>
						<RenderProgress
							indeterminate={isFetchingNextPage}
							value={
								!isFetchingNextPage && totalMessageCount > 0
									? visibleCount / totalMessageCount
									: undefined
							}
						/>
					</Box>
				)}
				<ScrollArea
					h="100%"
					type="always"
					viewportRef={viewportCallbackRef}
					py="sm"
					px="md"
					scrollbars="y"
					styles={{
						viewport: {
							overscrollBehavior: "contain",
							overflowAnchor: renderDone ? "auto" : "none",
						},
						scrollbar: renderDone
							? undefined
							: { pointerEvents: "none", opacity: 0, transition: "opacity 150ms ease" },
					}}
				>
					<LatestTodosToolUseIdCtx.Provider value={todosToolUseId}>
						<Stack gap="sm" ref={contentRef}>
							{visibleElements}
							<StreamingBubble
								narratorId={narratorId}
								streamingRef={streamingRef}
								streamingReasoningRef={streamingReasoningRef}
								version={streamingVersion}
							/>
							{deferredStreamingChunks &&
								renderToolRun([deferredStreamingChunks], narratorId, renderPermCb)}
						</Stack>
					</LatestTodosToolUseIdCtx.Provider>
				</ScrollArea>

				{onSendToTerminal && (
					<SelectionPopover
						containerRef={contentRef}
						onAction={onSendToTerminal}
						label={tt("sendToTerminal")}
					/>
				)}

				{/* Scroll to bottom button */}
				<Box
					style={{
						position: "absolute",
						bottom: 12,
						right: 24,
						zIndex: 10,
						transform: isAtBottom ? "translateY(80px)" : "translateY(0)",
						opacity: isAtBottom ? 0 : 1,
						transition: "transform 200ms ease, opacity 200ms ease",
						pointerEvents: isAtBottom ? "none" : "auto",
					}}
				>
					{unreadCount > 0 && (
						<Badge
							size="sm"
							circle
							color="indigo"
							style={{
								position: "absolute",
								top: -6,
								right: -6,
								zIndex: 1,
								pointerEvents: "none",
							}}
						>
							{unreadCount > 99 ? "99+" : unreadCount}
						</Badge>
					)}
					<ActionIcon
						variant="filled"
						color="gray"
						radius="xl"
						size="lg"
						onClick={() => scrollToBottom()}
						title={
							unreadCount > 0
								? t("scrollToBottomWithCount", { count: unreadCount })
								: t("scrollToBottom")
						}
					>
						<IconArrowDown size={18} />
					</ActionIcon>
				</Box>
			</Box>

			{/* Image previews */}
			{attachedImages.length > 0 && (
				<Group
					pt="xs"
					px="md"
					pb={0}
					gap="xs"
					style={{ borderTop: "1px solid var(--mantine-color-default-border)", flexShrink: 0 }}
				>
					{attachedImages.map((file, i) => (
						<Box key={`${file.name}-${i}`} pos="relative" style={{ display: "inline-block" }}>
							<Image
								src={imagePreviewUrls[i]}
								alt={file.name}
								radius="sm"
								h={60}
								w={60}
								fit="cover"
							/>
							<CloseButton
								size="xs"
								radius="xl"
								variant="filled"
								color="dark"
								style={{ position: "absolute", top: -6, right: -6 }}
								onClick={() => setAttachedImages((prev) => prev.filter((_, j) => j !== i))}
								title={t("removeImage")}
							/>
						</Box>
					))}
				</Group>
			)}

			{/* Buffered message indicator */}
			{bufferedText && (
				<Group
					px="md"
					py={4}
					gap="xs"
					style={{
						borderTop:
							attachedImages.length > 0
								? undefined
								: "1px solid var(--mantine-color-default-border)",
						backgroundColor: "var(--mantine-color-blue-light)",
						flexShrink: 0,
					}}
				>
					<Loader size={14} color="blue" />
					<Text size="xs" c="blue" truncate style={{ flex: 1 }}>
						{t("bufferedMessage")}: {bufferedText}
					</Text>
					<CloseButton size="xs" onClick={handleCancelBuffer} title={t("cancelBuffer")} />
				</Group>
			)}

			{/* Chapter bar */}
			{narrator.chapterId && <ChapterBar chapterId={narrator.chapterId} />}

			{/* Status bar */}
			<Group
				px="md"
				pt="xs"
				pb="xs"
				gap="xs"
				justify="space-between"
				wrap="nowrap"
				style={{
					borderTop:
						attachedImages.length > 0 || bufferedText
							? undefined
							: "1px solid var(--mantine-color-default-border)",
					flexShrink: 0,
				}}
			>
				{showWorkIndicator ? (
					<UnstyledButton
						disabled={!activeTodo}
						onClick={async () => {
							if (!activeTodo || !todosToolUseId) return;
							// Search across all pages without flattening
							let msg: NarratorMsg | null = null;
							for (const page of messagesData?.pages ?? []) {
								msg = findMsgByToolUseIdInTree(page.messages, todosToolUseId);
								if (msg) break;
							}
							if (!msg) {
								try {
									await qc.refetchQueries({ queryKey: messagesQueryKey });
									const freshData = qc.getQueryData<MessagesQueryData>(messagesQueryKey);
									for (const page of freshData?.pages ?? []) {
										msg = findMsgByToolUseIdInTree(page.messages, todosToolUseId);
										if (msg) break;
									}
								} catch {
									return;
								}
							}
							if (!msg) return;
							setExpandedToolUseId(todosToolUseId);
							const el =
								document.getElementById(`tool-use-${todosToolUseId}`) ??
								document.getElementById(`msg-${msg.id}`);
							if (el) {
								el.scrollIntoView({ behavior: "smooth", block: "center" });
								setTimeout(() => {
									setHighlightedId(msg.id);
									setTimeout(() => setHighlightedId(null), 1600);
								}, 400);
							}
						}}
						style={{ minWidth: 0, flex: 1 }}
					>
						<Group gap={6} wrap="nowrap">
							<Loader
								size={14}
								color={
									isCompacting ? "orange" : isWaiting ? "yellow" : isPlanning ? "green" : "blue"
								}
								style={{ flexShrink: 0 }}
							/>
							<Text
								size="xs"
								c={isCompacting ? "orange" : isWaiting ? "yellow" : isPlanning ? "green" : "blue"}
								truncate
							>
								{isCompacting
									? t("compacting")
									: activeTodo
										? activeTodo.content || activeTodo.activeForm
										: isWaiting
											? t("status_waiting")
											: isPlanning
												? t("planning")
												: t("thinking")}
							</Text>
						</Group>
					</UnstyledButton>
				) : (
					<Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
						<Box
							w={8}
							h={8}
							style={{
								borderRadius: "50%",
								backgroundColor: `var(--mantine-color-${
									NARRATOR_STATUS_COLORS[narrator.status] ?? "gray"
								}-filled)`,
								flexShrink: 0,
							}}
						/>
						<Text size="xs" c="dimmed">
							{t(`status_${narrator.status}`)}
						</Text>
					</Group>
				)}
				{/* Model & Permission selectors */}
				<Group gap={6} wrap="nowrap" style={{ flexShrink: 1, minWidth: 0 }}>
					{/* Context usage indicator */}
					{(() => {
						if (contextPercent == null) return null;
						const pct = Math.min(contextPercent, 100);
						const r = 9;
						const circ = 2 * Math.PI * r;
						const offset = circ * (1 - pct / 100);
						const color =
							pct >= 99
								? "var(--mantine-color-red-6)"
								: pct >= 95
									? "var(--mantine-color-yellow-6)"
									: "var(--mantine-color-blue-6)";
						return (
							<Menu position="top-start">
								<Menu.Target>
									<Box
										style={{
											position: "relative",
											width: 24,
											height: 24,
											flexShrink: 0,
											cursor: "pointer",
										}}
										className="context-ring"
									>
										<svg
											width={24}
											height={24}
											viewBox="0 0 24 24"
											role="img"
											aria-label={`Context: ${contextPercent.toFixed(1)}%`}
										>
											<title>{`Context: ${contextPercent.toFixed(1)}%`}</title>
											<circle
												cx={12}
												cy={12}
												r={r}
												fill="none"
												stroke="light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))"
												strokeWidth={2.5}
											/>
											<circle
												cx={12}
												cy={12}
												r={r}
												fill="none"
												stroke={color}
												strokeWidth={2.5}
												strokeDasharray={circ}
												strokeDashoffset={offset}
												strokeLinecap="round"
												transform="rotate(-90 12 12)"
												style={{ transition: "stroke-dashoffset 0.3s ease" }}
											/>
										</svg>
									</Box>
								</Menu.Target>
								<Menu.Dropdown>
									{prunedPercent != null && (
										<Menu.Label>{t("prunedPercent", { percent: prunedPercent })}</Menu.Label>
									)}
									<Menu.Label>
										{t("contextUsagePercent", { percent: contextPercent.toFixed(1) })}
									</Menu.Label>
									{promptTokens != null && (
										<Menu.Label>
											{contextWindow != null
												? t("contextUsageTokensWithWindow", {
														tokens: promptTokens.toLocaleString(),
														window: contextWindow.toLocaleString(),
													})
												: t("contextUsageTokens", {
														tokens: promptTokens.toLocaleString(),
													})}
										</Menu.Label>
									)}
									<Menu.Item
										leftSection={<IconArrowsMinimize size={14} />}
										onClick={() => {
											api.triggerCompact(narratorId).catch(() => {});
										}}
									>
										{t("triggerCompact")}
									</Menu.Item>
									<Menu.Item
										leftSection={<IconEraser size={14} />}
										onClick={() => {
											api.clearContext(narratorId).catch(() => {});
										}}
									>
										{t("clearContext")}
									</Menu.Item>
								</Menu.Dropdown>
							</Menu>
						);
					})()}
					{/* Desktop selects */}
					<Group gap={6} wrap="nowrap" visibleFrom="sm">
						<Menu position="top-end">
							<Menu.Target>
								<NativeSelect
									size="xs"
									data={allModels.map((m) => ({ value: m.value, label: m.label }))}
									value={narrator.model ?? ""}
									onChange={() => {}}
									onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
									style={{ pointerEvents: "auto" }}
								/>
							</Menu.Target>
							<Menu.Dropdown>
								<ModelMenuItems
									allModels={allModels}
									currentModel={narrator.model}
									totalCostUsd={narrator.totalCostUsd}
									onSelect={(v) => modelMutation.mutate({ id: narratorId, model: v })}
								/>
							</Menu.Dropdown>
						</Menu>
						<Menu position="top-end">
							<Menu.Target>
								<NativeSelect
									size="xs"
									leftSection={
										PERM_MODE_ICONS[narrator.permissionMode ?? "default"] ?? (
											<IconShield size={14} />
										)
									}
									data={PERM_MODE_DATA.map((d) => ({ value: d.value, label: t(d.label) }))}
									value={narrator.permissionMode ?? "default"}
									onChange={() => {}}
									onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
									style={{ pointerEvents: "auto" }}
								/>
							</Menu.Target>
							<Menu.Dropdown>
								<PermModeMenuItems
									currentMode={narrator.permissionMode ?? "default"}
									onSelect={(m) => permModeMutation.mutate({ id: narratorId, permissionMode: m })}
									t={t}
								/>
							</Menu.Dropdown>
						</Menu>
						{/* Reasoning Effort (only for models containing "codex") */}
						{narrator.model?.toLowerCase().includes("codex") && (
							<Menu position="top-end">
								<Menu.Target>
									<NativeSelect
										size="xs"
										data={[
											{ value: "", label: t("reasoning_auto") },
											{ value: "low", label: t("reasoning_low") },
											{ value: "medium", label: t("reasoning_medium") },
											{ value: "high", label: t("reasoning_high") },
											{ value: "xhigh", label: t("reasoning_xhigh") },
										]}
										value={narrator.reasoningEffort ?? ""}
										onChange={() => {}}
										onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
										style={{ pointerEvents: "auto" }}
									/>
								</Menu.Target>
								<Menu.Dropdown>
									<ReasoningEffortMenuItems
										currentEffort={narrator.reasoningEffort}
										onSelect={(e) =>
											reasoningEffortMutation.mutate({ id: narratorId, reasoningEffort: e })
										}
										t={t}
									/>
								</Menu.Dropdown>
							</Menu>
						)}
						{onToggleTerminal && (
							<Tooltip label={terminalOpen ? tt("closeTerminal") : tt("openTerminal")}>
								<Indicator
									label={activeTerminalCount}
									size={14}
									disabled={activeTerminalCount === 0}
									offset={2}
									color="blue"
								>
									<ActionIcon
										variant="subtle"
										color={terminalOpen ? "blue" : "gray"}
										size="sm"
										onClick={onToggleTerminal}
									>
										<IconTerminal size={16} />
									</ActionIcon>
								</Indicator>
							</Tooltip>
						)}
					</Group>
					{/* Mobile: model & permission */}
					<Group gap={4} wrap="nowrap" hiddenFrom="sm">
						<Menu position="bottom-end" withinPortal>
							<Menu.Target>
								<ActionIcon variant="subtle" color="gray" size="sm">
									<Text size="xs" fw={600}>
										{(() => {
											const m = allModels.find((x) => x.value === narrator.model);
											return (m?.label ?? narrator.model ?? "?")[0].toUpperCase();
										})()}
									</Text>
								</ActionIcon>
							</Menu.Target>
							<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
								<ModelMenuItems
									allModels={allModels}
									currentModel={narrator.model}
									totalCostUsd={narrator.totalCostUsd}
									onSelect={(v) => modelMutation.mutate({ id: narratorId, model: v })}
									label={t("modelTooltip")}
								/>
							</Menu.Dropdown>
						</Menu>
						<Menu position="bottom-end" withinPortal>
							<Menu.Target>
								<ActionIcon variant="subtle" color="gray" size="sm">
									{PERM_MODE_ICONS[narrator.permissionMode ?? "default"] ?? (
										<IconShield size={16} />
									)}
								</ActionIcon>
							</Menu.Target>
							<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
								<Menu.Label>{t("permissionMode")}</Menu.Label>
								<PermModeMenuItems
									currentMode={narrator.permissionMode ?? "default"}
									onSelect={(m) => permModeMutation.mutate({ id: narratorId, permissionMode: m })}
									t={t}
								/>
							</Menu.Dropdown>
						</Menu>
						{/* Reasoning Effort (only for Codex models) - Mobile */}
						{narrator.model?.startsWith("codex:") && (
							<Menu position="bottom-end" withinPortal>
								<Menu.Target>
									<ActionIcon variant="subtle" color="gray" size="sm">
										<Text size="xs" fw={600}>
											{(() => {
												const effortMap = { low: "L", medium: "M", high: "H", xhigh: "X" };
												return effortMap[narrator.reasoningEffort as keyof typeof effortMap] ?? "A";
											})()}
										</Text>
									</ActionIcon>
								</Menu.Target>
								<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
									<ReasoningEffortMenuItems
										currentEffort={narrator.reasoningEffort}
										onSelect={(e) =>
											reasoningEffortMutation.mutate({ id: narratorId, reasoningEffort: e })
										}
										t={t}
									/>
								</Menu.Dropdown>
							</Menu>
						)}
						{onToggleTerminal && (
							<Tooltip label={terminalOpen ? tt("closeTerminal") : tt("openTerminal")}>
								<Indicator
									label={activeTerminalCount}
									size={14}
									disabled={activeTerminalCount === 0}
									offset={2}
									color="blue"
								>
									<ActionIcon
										variant="subtle"
										color={terminalOpen ? "blue" : "gray"}
										size="sm"
										onClick={onToggleTerminal}
									>
										<IconTerminal size={16} />
									</ActionIcon>
								</Indicator>
							</Tooltip>
						)}
					</Group>
				</Group>
			</Group>

			{/* Input */}
			<Box px="md" pb="xs" style={{ flexShrink: 0 }}>
				<input
					ref={fileInputRef}
					type="file"
					accept="image/png,image/jpeg,image/gif,image/webp"
					multiple
					style={{ display: "none" }}
					onChange={(e) => {
						if (e.target.files) {
							addImages(Array.from(e.target.files));
							e.target.value = "";
						}
					}}
				/>
				<Group gap="xs" align="end" wrap="nowrap">
					<Tooltip label={t("attachImage")}>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => fileInputRef.current?.click()}
							mb={4}
						>
							<IconPaperclip size={18} />
						</ActionIcon>
					</Tooltip>
					<Box style={{ position: "relative", flex: 1 }}>
						<CommandPopover
							commands={commandsList ?? []}
							input={input}
							visible={commandPopoverVisible}
							onSelect={handleCommandSelect}
							onClose={closeCommandPopover}
						/>
						<Textarea
							ref={textareaRef}
							placeholder={t("sendPlaceholder")}
							value={input}
							onChange={(e) => setInput(e.currentTarget.value)}
							onKeyDown={handleKeyDown}
							onPaste={handlePaste}
							autosize
							minRows={1}
							maxRows={6}
						/>
					</Box>
					{(() => {
						const hasInput = !!input.trim();
						const showInterrupt = isActive && !hasInput;
						const showRetry =
							!showInterrupt && !hasInput && attachedImages.length === 0 && canRetryLastUserMessage;
						if (showInterrupt) {
							return (
								<Button
									key="interrupt"
									ref={interruptBtnRef}
									color="red"
									variant="light"
									onMouseDown={startInterruptPress}
									onMouseUp={clearInterruptTimer}
									onMouseLeave={clearInterruptTimer}
									onContextMenu={(e) => e.preventDefault()}
									loading={interruptMutation.isPending}
									style={{
										position: "relative",
										overflow: "hidden",
										userSelect: "none",
										touchAction: "none",
									}}
								>
									{interruptProgress > 0 && interruptProgress < 1 && (
										<div
											style={{
												position: "absolute",
												inset: 0,
												background: "var(--mantine-color-red-filled)",
												opacity: 0.25,
												transformOrigin: "left",
												transform: `scaleX(${interruptProgress})`,
												pointerEvents: "none",
											}}
										/>
									)}
									<span style={{ position: "relative" }}>{t("interrupt")}</span>
								</Button>
							);
						}
						if (showRetry) {
							return (
								<Button key="retry" onClick={handleRetry}>
									{t("retry")}
								</Button>
							);
						}
						return (
							<Button
								key="send"
								onClick={handleSend}
								disabled={!hasInput || (isActive && !!bufferedText)}
							>
								{isActive ? t("queue") : tc("send")}
							</Button>
						);
					})()}
				</Group>
			</Box>
		</Stack>
	);
}
