import {
	ActionIcon,
	Avatar,
	Badge,
	Box,
	Button,
	CloseButton,
	Group,
	Image,
	Indicator,
	Loader,
	Menu,
	Modal,
	NativeSelect,
	Popover,
	SegmentedControl,
	Skeleton,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
	IconArchive,
	IconArrowDown,
	IconArrowLeft,
	IconArrowsMinimize,
	IconBolt,
	IconCheck,
	IconCode,
	IconCodeOff,
	IconEraser,
	IconExternalLink,
	IconFile,
	IconFolderPlus,
	IconLock,
	IconLockOpen,
	IconPaperclip,
	IconPencil,
	IconPhoto,
	IconShield,
	IconSparkles,
	IconTerminal,
	IconTrash,
	IconUpload,
	IconX,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChapter } from "../../hooks/useChapters";
import { useNarratorCommands } from "../../hooks/useCommands";
import { useInputHistory } from "../../hooks/useInputHistory";
import { useLocalPref } from "../../hooks/useLocalPref";
import { useAllModels } from "../../hooks/useModels";
import {
	DEFAULT_MESSAGES_AROUND_AFTER,
	DEFAULT_MESSAGES_AROUND_BEFORE,
	getNarratorMessagesQueryKey,
	useArchiveNarrator,
	useBlacklistDirs,
	useCmdBlacklist,
	useCmdWhitelist,
	useCreateBlacklistDir,
	useCreateCmdBlacklist,
	useCreateCmdWhitelist,
	useCreateWhitelistDir,
	useDeleteBlacklistDir,
	useDeleteCmdBlacklist,
	useDeleteCmdWhitelist,
	useDeleteWhitelistDir,
	useForkNarrator,
	useInterruptNarrator,
	useNarrator,
	useNarratorMessages,
	useUpdateBlacklistDir,
	useUpdateCmdBlacklist,
	useUpdateCmdWhitelist,
	useUpdateFastMode,
	useUpdateModel,
	useUpdatePermissionMode,
	useUpdatePruneEnabled,
	useUpdateReasoningEffort,
	useUpdateRelaxedPlan,
	useUpdateWhitelistDir,
	useWhitelistDirs,
} from "../../hooks/useNarrator";
import { useGlobalOverseer } from "../../hooks/useOverseers";
import { useNarratorTerminals } from "../../hooks/useTerminals";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api, type TreeMessage } from "../../lib/api";
import {
	FOLLOW_DEFAULT_MODEL,
	type ModelOption,
	NARRATOR_STATUS_COLORS,
} from "../../lib/constants";
import { PathInputWithBrowse } from "../common/PathInputWithBrowse";
import { SelectionPopover } from "../common/SelectionPopover";
import { UserAvatar } from "../UserAvatar";
import { BlurInOnAppearProvider } from "./BlurInOnAppear";
import { BroadMessageList, type BroadMessageListHandle } from "./BroadMessageList";
import { collectBlurInAnimationIdsFromMessages } from "./blur-in-ids";
import { ChapterBar } from "./ChapterBar";
import { CommandParamHelper } from "./CommandParamHelper";
import { type CommandItem, CommandPopover } from "./CommandPopover";
import { ContentViewerEnvironmentProvider } from "./ContentViewer";
import {
	type RenderedTreeElementMeta,
	RenderProgress,
	renderTreeMessagesWithKeys,
} from "./MessageRenderer";
import {
	MessageSelectionCtx,
	type MessageSelectionState,
	resolveBlockRange,
} from "./MessageSelectionCtx";
import { buildStreamingMsg } from "./message-segments";
import { evictOldestPages, findMsgByToolUseIdInTree } from "./message-tree-utils";
import { NarratorPanelSkeleton } from "./NarratorPanelSkeleton";
import { revokeContentBlockPreviewUrls } from "./narrator-message-helpers";
import type {
	ContentBlock,
	MessagesQueryData,
	NarratorMsg,
	NarratorPanelProps,
	TodoItem,
} from "./narrator-panel-types";
import {
	ACCEPTED_TYPES,
	formatFileSize,
	isTextFile,
	MAX_IMAGE_LONG_EDGE,
	MAX_IMAGE_SIZE,
	MAX_TEXT_FILE_SIZE,
	PERM_MODE_ICONS,
	PERM_MODES,
	STREAMING_CHUNKS_MSG_ID,
} from "./narrator-panel-types";
import { ScrollbarUserMarkers } from "./ScrollbarUserMarkers";
import { getGlobalCloseSwipe, setGlobalOnSelectionRange, setGlobalSwipeAnchor } from "./swipeState";
import { LatestTodosToolUseIdCtx } from "./ToolCallCard";
import { useNarratorPanelWS } from "./useNarratorPanelWS";

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
	const provLabels: Record<string, string> = {
		openai: "OpenAI",
		__default__: "Default",
	};
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

const ACCESS_LEVELS = ["readOnly", "readWrite", "full"] as const;
const DENY_LEVELS = ["denyWrite", "denyAll"] as const;

/**
 * Resize an image file using an offscreen canvas if its long edge exceeds maxEdge.
 * Returns the original file if no resize is needed.
 */
function resizeImageIfNeeded(file: File, maxEdge: number): Promise<File> {
	return new Promise((resolve, reject) => {
		const img = document.createElement("img");
		const url = URL.createObjectURL(file);
		img.onload = () => {
			URL.revokeObjectURL(url);
			const { naturalWidth: w, naturalHeight: h } = img;
			if (Math.max(w, h) <= maxEdge) {
				resolve(file);
				return;
			}
			const scale = maxEdge / Math.max(w, h);
			const nw = Math.round(w * scale);
			const nh = Math.round(h * scale);
			const canvas = document.createElement("canvas");
			canvas.width = nw;
			canvas.height = nh;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				resolve(file);
				return;
			}
			ctx.drawImage(img, 0, 0, nw, nh);
			// Use the real content type for output (PNG stays PNG, others become JPEG)
			const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
			canvas.toBlob(
				(blob) => {
					if (!blob) {
						resolve(file);
						return;
					}
					resolve(new File([blob], file.name, { type: outputType }));
				},
				outputType,
				0.85,
			);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("Failed to load image"));
		};
		img.src = url;
	});
}

function CmdPatternInput({
	placeholder,
	onConfirm,
}: {
	placeholder: string;
	onConfirm: (pattern: string) => void;
}) {
	const [value, setValue] = useState("");
	return (
		<>
			<TextInput
				size="xs"
				placeholder={placeholder}
				value={value}
				onChange={(e) => setValue(e.currentTarget.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && value.trim()) {
						onConfirm(value.trim());
						setValue("");
					}
				}}
				style={{ flex: 1 }}
			/>
			<Button
				size="xs"
				variant="light"
				disabled={!value.trim()}
				onClick={() => {
					if (value.trim()) {
						onConfirm(value.trim());
						setValue("");
					}
				}}
			>
				+
			</Button>
		</>
	);
}

function PathRulesPopover({ narratorId, t }: { narratorId: string; t: (key: string) => string }) {
	const isMobile = useMediaQuery("(max-width: 768px)") ?? false;
	const { data: wlDirs = [] } = useWhitelistDirs(narratorId);
	const createWl = useCreateWhitelistDir();
	const updateWl = useUpdateWhitelistDir(narratorId);
	const deleteWl = useDeleteWhitelistDir(narratorId);

	const { data: blDirs = [] } = useBlacklistDirs(narratorId);
	const createBl = useCreateBlacklistDir();
	const updateBl = useUpdateBlacklistDir(narratorId);
	const deleteBl = useDeleteBlacklistDir(narratorId);

	const { data: cmdWl = [] } = useCmdWhitelist(narratorId);
	const createCmdWl = useCreateCmdWhitelist();
	const updateCmdWl = useUpdateCmdWhitelist(narratorId);
	const deleteCmdWl = useDeleteCmdWhitelist(narratorId);

	const { data: cmdBl = [] } = useCmdBlacklist(narratorId);
	const createCmdBl = useCreateCmdBlacklist();
	const updateCmdBl = useUpdateCmdBlacklist(narratorId);
	const deleteCmdBl = useDeleteCmdBlacklist(narratorId);

	const [opened, { toggle, close }] = useDisclosure(false);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const badgeCount = wlDirs.length + blDirs.length + cmdWl.length + cmdBl.length;

	// Custom click-outside handler that ignores clicks on portal children
	// (Combobox dropdowns, Modals) which live outside the Popover DOM tree.
	useEffect(() => {
		if (!opened) return;
		const handler = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			// Ignore clicks inside the popover dropdown itself
			if (dropdownRef.current?.contains(target)) return;
			// Ignore clicks inside any Mantine portal overlay (Modal, Combobox dropdown, etc.)
			if (target.closest(".mantine-Modal-root, .mantine-Modal-overlay, .mantine-Combobox-dropdown"))
				return;
			close();
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [opened, close]);

	const trigger = (
		<Tooltip label={t("path_rules")}>
			<ActionIcon variant="subtle" color="gray" size="sm" onClick={toggle}>
				<IconFolderPlus size={16} />
				{badgeCount > 0 && (
					<Text size="8px" fw={700} c="indigo" style={{ position: "absolute", top: -2, right: -4 }}>
						{badgeCount}
					</Text>
				)}
			</ActionIcon>
		</Tooltip>
	);

	const content = (
		<Stack gap={10}>
			{/* ── Whitelist ── */}
			<Text size="xs" fw={600}>
				{t("whitelist_dirs_title")}
			</Text>
			{wlDirs.length === 0 && (
				<Text size="xs" c="dimmed">
					{t("whitelist_dirs_empty")}
				</Text>
			)}
			{wlDirs.map((dir) => (
				<Group key={dir.id} gap={6} wrap="nowrap" align="center">
					<Switch
						size="xs"
						checked={dir.enabled}
						onChange={(e) => updateWl.mutate({ dirId: dir.id, enabled: e.currentTarget.checked })}
					/>
					<Text
						size="xs"
						style={{
							flex: 1,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							opacity: dir.enabled ? 1 : 0.5,
						}}
						title={dir.path}
					>
						{dir.path}
					</Text>
					<SegmentedControl
						size="xs"
						value={dir.accessLevel}
						onChange={(v) =>
							updateWl.mutate({
								dirId: dir.id,
								accessLevel: v as (typeof ACCESS_LEVELS)[number],
							})
						}
						data={ACCESS_LEVELS.map((l) => ({
							value: l,
							label: t(`whitelist_access_${l}`),
						}))}
						style={{ flexShrink: 0 }}
					/>
					<ActionIcon
						variant="subtle"
						color="red"
						size="xs"
						onClick={() => deleteWl.mutate(dir.id)}
					>
						<IconTrash size={14} />
					</ActionIcon>
				</Group>
			))}
			<PathInputWithBrowse
				placeholder={t("whitelist_dirs_placeholder")}
				onConfirm={(path) => createWl.mutate({ narratorId, path })}
			/>

			{/* ── Blacklist ── */}
			<Text size="xs" fw={600} mt={4}>
				{t("blacklist_dirs_title")}
			</Text>
			{blDirs.length === 0 && (
				<Text size="xs" c="dimmed">
					{t("blacklist_dirs_empty")}
				</Text>
			)}
			{blDirs.map((dir) => (
				<Group key={dir.id} gap={6} wrap="nowrap" align="center">
					<Switch
						size="xs"
						checked={dir.enabled}
						onChange={(e) => updateBl.mutate({ dirId: dir.id, enabled: e.currentTarget.checked })}
					/>
					<Text
						size="xs"
						style={{
							flex: 1,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							opacity: dir.enabled ? 1 : 0.5,
						}}
						title={dir.path}
					>
						{dir.path}
					</Text>
					<SegmentedControl
						size="xs"
						value={dir.denyLevel}
						onChange={(v) =>
							updateBl.mutate({
								dirId: dir.id,
								denyLevel: v as (typeof DENY_LEVELS)[number],
							})
						}
						data={DENY_LEVELS.map((l) => ({
							value: l,
							label: t(`blacklist_deny_${l}`),
						}))}
						style={{ flexShrink: 0 }}
					/>
					<ActionIcon
						variant="subtle"
						color="red"
						size="xs"
						onClick={() => deleteBl.mutate(dir.id)}
					>
						<IconTrash size={14} />
					</ActionIcon>
				</Group>
			))}
			<PathInputWithBrowse
				placeholder={t("blacklist_dirs_placeholder")}
				onConfirm={(path) => createBl.mutate({ narratorId, path })}
			/>

			{/* ── Command Whitelist ── */}
			<Text size="xs" fw={600} mt={4}>
				{t("cmd_whitelist_title")}
			</Text>
			{cmdWl.length === 0 && (
				<Text size="xs" c="dimmed">
					{t("cmd_whitelist_empty")}
				</Text>
			)}
			{cmdWl.map((cmd) => (
				<Group key={cmd.id} gap={6} wrap="nowrap" align="center">
					<Switch
						size="xs"
						checked={cmd.enabled}
						onChange={(e) =>
							updateCmdWl.mutate({ entryId: cmd.id, enabled: e.currentTarget.checked })
						}
					/>
					<Text
						size="xs"
						style={{
							flex: 1,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							opacity: cmd.enabled ? 1 : 0.5,
						}}
						title={cmd.pattern}
					>
						{cmd.pattern}
					</Text>
					<ActionIcon
						variant="subtle"
						color="red"
						size="xs"
						onClick={() => deleteCmdWl.mutate(cmd.id)}
					>
						<IconTrash size={14} />
					</ActionIcon>
				</Group>
			))}
			<Group gap={4} wrap="nowrap">
				<CmdPatternInput
					placeholder={t("cmd_whitelist_placeholder")}
					onConfirm={(pattern) => createCmdWl.mutate({ narratorId, pattern })}
				/>
			</Group>

			{/* ── Command Blacklist ── */}
			<Text size="xs" fw={600} mt={4}>
				{t("cmd_blacklist_title")}
			</Text>
			{cmdBl.length === 0 && (
				<Text size="xs" c="dimmed">
					{t("cmd_blacklist_empty")}
				</Text>
			)}
			{cmdBl.map((cmd) => (
				<Group key={cmd.id} gap={6} wrap="nowrap" align="center">
					<Switch
						size="xs"
						checked={cmd.enabled}
						onChange={(e) =>
							updateCmdBl.mutate({ entryId: cmd.id, enabled: e.currentTarget.checked })
						}
					/>
					<Text
						size="xs"
						style={{
							flex: 1,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							opacity: cmd.enabled ? 1 : 0.5,
						}}
						title={cmd.pattern}
					>
						{cmd.pattern}
					</Text>
					{cmd.denyPrompt && (
						<Text size="xs" c="dimmed" title={cmd.denyPrompt}>
							💬
						</Text>
					)}
					<ActionIcon
						variant="subtle"
						color="red"
						size="xs"
						onClick={() => deleteCmdBl.mutate(cmd.id)}
					>
						<IconTrash size={14} />
					</ActionIcon>
				</Group>
			))}
			<Group gap={4} wrap="nowrap">
				<CmdPatternInput
					placeholder={t("cmd_blacklist_placeholder")}
					onConfirm={(pattern) => createCmdBl.mutate({ narratorId, pattern })}
				/>
			</Group>
		</Stack>
	);

	if (isMobile) {
		return (
			<>
				{trigger}
				<Modal opened={opened} onClose={close} title={t("path_rules")} size="full">
					{content}
				</Modal>
			</>
		);
	}

	return (
		<Popover
			opened={opened}
			onClose={close}
			position="top-end"
			width={420}
			shadow="md"
			withinPortal
			closeOnClickOutside={false}
		>
			<Popover.Target>{trigger}</Popover.Target>
			<Popover.Dropdown ref={dropdownRef}>{content}</Popover.Dropdown>
		</Popover>
	);
}

type ReasoningEffortValue = "none" | "low" | "medium" | "high" | "xhigh";

const DEFAULT_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"low",
	"medium",
	"high",
];

const CODEX_REASONING_OPTIONS_BY_MODEL: Record<string, readonly ReasoningEffortValue[]> = {
	// Extracted from codex-reversed model catalog (supported_reasoning_levels).
	// Includes "none" for UI display (disables reasoning). The backend counterpart
	// (openai-provider CODEX_MODEL_REASONING_LEVELS) omits "none" because it is
	// handled separately before the table lookup.
	"gpt-5.3-codex": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.2-codex": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.1-codex-max": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.1-codex": ["none", "low", "medium", "high"],
	"gpt-5.1-codex-mini": ["none", "medium", "high"],
	"gpt-5.2": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.4": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.4-mini": ["none", "low", "medium", "high", "xhigh"],
};

function getCodexReasoningEffortOptions(model?: string): readonly ReasoningEffortValue[] {
	const bareModel = model?.split(":").slice(1).join(":") ?? "";
	return CODEX_REASONING_OPTIONS_BY_MODEL[bareModel] ?? DEFAULT_REASONING_EFFORT_OPTIONS;
}

function ReasoningEffortMenuItems({
	currentEffort,
	options,
	onSelect,
	t,
}: {
	currentEffort: string | null | undefined;
	options: readonly ReasoningEffortValue[];
	onSelect: (effort: string | null) => void;
	t: (key: string) => string;
}) {
	return (
		<>
			<Menu.Label>{t("reasoningEffort")}</Menu.Label>
			{(["", ...options] as const).map((effort) => {
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
	compact,
	onMinimize,
	onBack,
	onViewSubagentSession,
	isResizing,
	onHeaderPointerDown,
	onClose,
	onOpenTerminalPanel,
}: NarratorPanelProps) {
	const navigate = useNavigate();
	const { data: fetchedNarrator } = useNarrator(narratorId);
	const narrator = narratorProp ?? fetchedNarrator;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const chapterId = (narrator as any)?.chapterId as string | null | undefined;
	const { data: chapterData } = useChapter(chapterId ?? "");
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const chapterStatus = (chapterData as any)?.status as string | undefined;
	const isChapterMerged = chapterStatus === "merged";
	const forkNarratorMutation = useForkNarrator();
	const aroundOptions = useMemo(
		() =>
			highlightMessageId
				? {
						messageId: highlightMessageId,
						before: DEFAULT_MESSAGES_AROUND_BEFORE,
						after: DEFAULT_MESSAGES_AROUND_AFTER,
					}
				: undefined,
		[highlightMessageId],
	);
	const {
		data: messagesData,
		isLoading: messagesLoading,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
		hasPreviousPage,
		fetchPreviousPage,
		isFetchingPreviousPage,
	} = useNarratorMessages(narratorId, aroundOptions);
	const interruptMutation = useInterruptNarrator();
	const archiveMutation = useArchiveNarrator();
	const permModeMutation = useUpdatePermissionMode();
	const reasoningEffortMutation = useUpdateReasoningEffort();
	const fastModeMutation = useUpdateFastMode();
	const relaxedPlanMutation = useUpdateRelaxedPlan();
	const modelMutation = useUpdateModel();
	const pruneEnabledMutation = useUpdatePruneEnabled();
	const { visibleWithDefault: allModels, defaultModelValue, settingsData } = useAllModels();
	const { data: userPrefs } = useUserPreferences();
	const autoLoadEnabled = userPrefs?.autoLoadOlderMessages ?? true;
	const isMobileViewport = useMediaQuery("(max-width: 768px)") ?? false;
	const contentViewerEnvironment = useMemo(
		() => ({
			isMobile: isMobileViewport,
			defaultWraps: {
				markdown: userPrefs?.wordWrapMarkdown ?? true,
				code: userPrefs?.wordWrapCode ?? true,
				diff: userPrefs?.wordWrapDiff ?? true,
			},
		}),
		[
			isMobileViewport,
			userPrefs?.wordWrapCode,
			userPrefs?.wordWrapDiff,
			userPrefs?.wordWrapMarkdown,
		],
	);
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const { t: tt } = useTranslation("terminal");
	const { t: tn } = useTranslation("nav");
	const qc = useQueryClient();

	// Overseer title: if this narrator is the global overseer's narrator, show i18n title + #id
	const { data: globalOverseer } = useGlobalOverseer();
	const isOverseerNarrator = !!globalOverseer && globalOverseer.narratorId === narratorId;
	const displayTitle = isOverseerNarrator
		? `${tn("overseer")} #${narratorId}`
		: narrator?.title || t("untitled");
	// Resolve the effective model: when following default, use the actual default model value
	const resolvedModel = useMemo(() => {
		const m = narrator?.model;
		if (!m || m === FOLLOW_DEFAULT_MODEL) return defaultModelValue;
		return m;
	}, [narrator?.model, defaultModelValue]);

	const codexCapableProviders = useMemo(() => {
		const providers = new Set<string>();
		if (settingsData?.codexAvailable) providers.add("codex");
		for (const provider of settingsData?.openaiProviders ?? []) {
			if (provider?.prefix && (provider.apiMode ?? "responses") === "codex") {
				providers.add(provider.prefix);
			}
		}
		return providers;
	}, [settingsData]);
	const supportsCodexControls = useMemo(() => {
		const providerPrefix = resolvedModel?.split(":")[0];
		return !!providerPrefix && codexCapableProviders.has(providerPrefix);
	}, [codexCapableProviders, resolvedModel]);

	// Reasoning effort is supported by both Codex and Anthropic providers
	const supportsReasoningEffort = useMemo(() => {
		const providerPrefix = resolvedModel?.split(":")[0];
		if (!providerPrefix) return false;
		if (codexCapableProviders.has(providerPrefix)) return true;
		// Check Anthropic providers
		const anthropicProviders = settingsData?.anthropicProviders ?? [];
		return anthropicProviders.some((p: { prefix?: string }) => p.prefix === providerPrefix);
	}, [codexCapableProviders, settingsData?.anthropicProviders, resolvedModel]);
	const reasoningEffortOptions = useMemo(() => {
		if (!resolvedModel) return DEFAULT_REASONING_EFFORT_OPTIONS;
		const providerPrefix = resolvedModel.split(":")[0];
		if (providerPrefix && codexCapableProviders.has(providerPrefix)) {
			return getCodexReasoningEffortOptions(resolvedModel);
		}
		return DEFAULT_REASONING_EFFORT_OPTIONS;
	}, [codexCapableProviders, resolvedModel]);

	// Active terminal count for badge indicator
	const { data: narratorTerminals } = useNarratorTerminals(narratorId);
	const activeTerminalCount = useMemo(
		() => narratorTerminals?.filter((t) => t.status === "running").length ?? 0,
		[narratorTerminals],
	);

	const messagesQueryKey = useMemo(
		() => getNarratorMessagesQueryKey(narratorId, aroundOptions),
		[narratorId, aroundOptions],
	);

	// --- Message operations ---
	const setContextPercentRef =
		useRef<React.Dispatch<React.SetStateAction<number | null>>>(undefined);
	const setUnreadCountRef = useRef<React.Dispatch<React.SetStateAction<number>>>(undefined);
	const handleDeleteBlock = useCallback(
		async (messageId: string, blockIndex: number) => {
			const prev = qc.getQueryData<MessagesQueryData>(messagesQueryKey);
			qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
				if (!old?.pages?.length) return old;
				const pages = old.pages.map((page) => ({
					...page,
					messages: page.messages
						.map((m: NarratorMsg) => {
							if (m.id !== messageId) return m;
							const blocks = Array.isArray(m.contentJson) ? [...m.contentJson] : [];
							blocks.splice(blockIndex, 1);
							if (blocks.length === 0) return null;
							return { ...m, contentJson: blocks };
						})
						.filter(Boolean) as NarratorMsg[],
				}));
				return { ...old, pages };
			});
			try {
				await api.deleteMessageBlock(narratorId, messageId, blockIndex);
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

	const handleRegenerate = useCallback(
		async (messageId: string) => {
			try {
				await api.regenerateFromMessage(narratorId, messageId);
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to regenerate";
				notifications.show({ title: t("regenerateFailed"), message, color: "red" });
			}
		},
		[narratorId, t],
	);

	const handleEditAndRegenerate = useCallback(
		async (messageId: string, newContent: string, rollback: boolean) => {
			try {
				await api.editAndRegenerate(narratorId, messageId, newContent, rollback);
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to edit and regenerate";
				notifications.show({ title: t("editFailed"), message, color: "red" });
			}
		},
		[narratorId, t],
	);

	// --- Input management ---
	const [input, setInput] = useState(
		() => sessionStorage.getItem(`narrafork_draft_${narratorId}`) ?? "",
	);
	const inputHistory = useInputHistory(`narrafork_input_history_${narratorId}`);
	useEffect(() => {
		if (input) {
			sessionStorage.setItem(`narrafork_draft_${narratorId}`, input);
		} else {
			sessionStorage.removeItem(`narrafork_draft_${narratorId}`);
		}
	}, [input, narratorId]);

	// --- Command popover ---
	const { data: commandsList } = useNarratorCommands(narratorId);
	// Show command popover only when typing command name (no space yet),
	// or when typing "/load <tool>" sub-completion.
	// Suppress when browsing input history so arrow keys keep navigating history.
	const commandPopoverVisible =
		input.startsWith("/") &&
		!input.includes("\n") &&
		(!input.includes(" ") || /^\/load\s\S*$/i.test(input)) &&
		(commandsList?.length ?? 0) > 0 &&
		!inputHistory.isBrowsing;
	// Matched command for param helper (after space is typed)
	const matchedCommand = useMemo(() => {
		if (!input.startsWith("/") || !commandsList?.length) return null;
		const spaceIdx = input.indexOf(" ");
		if (spaceIdx === -1) return null;
		const cmdName = input.slice(1, spaceIdx);
		return (
			commandsList.find(
				(c) => c.name.toLowerCase() === cmdName.toLowerCase() && c.type === "command",
			) ?? null
		);
	}, [input, commandsList]);
	const handleCommandSelect = useCallback((cmd: CommandItem) => {
		if (cmd.type === "skill") {
			// Skill selected — insert a prompt that tells the AI to load this skill
			setInput(`Please load the "${cmd.name}" skill and apply it to: `);
		} else if (cmd.type === "tool" && !cmd.name.includes(" ")) {
			// Parent /load entry — expand to show sub-items
			setInput(`/${cmd.name} `);
		} else {
			// Always keep command format — user can continue typing or press space for params
			setInput(`/${cmd.name}`);
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
	const [attachedTextFiles, setAttachedTextFiles] = useState<File[]>([]);
	const [isDragging, setIsDragging] = useState(false);
	const dragCounterRef = useRef(0);

	// --- Scroll state ---
	const [isAtBottom, setIsAtBottom] = useState(true);
	const viewportRef = useRef<HTMLDivElement>(null);
	// Whether older messages are currently being prepended. When true, the
	// virtual list adjusts scrollTop to compensate for prepended content.
	const [shifting, setShifting] = useState(false);
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

		const prefix = narrator?.model?.split(":")[0];
		if (!prefix) return null;
		if (!cfg) return null;
			| Record<string, { quotaBalance: number | null }>
			| undefined;
		return {
			providerId: cfg.id,
			quotaBalance: quotas?.[cfg.id]?.quotaBalance ?? null,
		};

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
		topLevelStreamingChunks,
		webSearchRef,
		renderPermCb,
		queuedMessages,
		setQueuedMessages,
		isCompacting,
		contextPercent,
		promptTokens,
		contextWindow,
		isEstimated,
		pruneBoundaryMessageId,
		prunedPercent,
		retryInfo,
		currentTodos,
		todosToolUseId,
		expandedToolUseId,
		setExpandedToolUseId,
		editExpandOverride,
		setEditExpandOverride,
		unreadCount,
		setUnreadCount,
		viewers,
	} = wsState;
	setContextPercentRef.current = wsState.setContextPercent;
	setUnreadCountRef.current = setUnreadCount;

	const [archiveConfirmOpened, { open: openArchiveConfirm, close: closeArchiveConfirm }] =
		useDisclosure(false);

	const isWorking = narrator?.status === "thinking";
	const isActive = narrator?.status === "thinking" || narrator?.status === "waiting";
	const isWaiting = narrator?.status === "waiting";
	const isPlanning = narrator?.permissionMode === "plan" && narrator?.status === "thinking";
	const isRetrying = !!retryInfo;
	const showWorkIndicator = !!(isWorking || isWaiting || isCompacting || isRetrying);

	// --- Turn elapsed timer ---
	const turnStartedAt = narrator?.turnStartedAt as string | null | undefined;
	const narratorUpdatedAt = narrator?.updatedAt as string | null | undefined;
	const [turnElapsed, setTurnElapsed] = useState<number | null>(null);
	useEffect(() => {
		if (!turnStartedAt) {
			setTurnElapsed(null);
			return;
		}
		const startMs = new Date(turnStartedAt).getTime();
		if (showWorkIndicator) {
			// Live ticking while working
			const update = () => setTurnElapsed(Math.floor((Date.now() - startMs) / 1000));
			update();
			const id = setInterval(update, 1000);
			return () => clearInterval(id);
		}
		// Terminal state: compute duration from turnStartedAt → updatedAt
		const endMs = narratorUpdatedAt ? new Date(narratorUpdatedAt).getTime() : Date.now();
		setTurnElapsed(Math.max(0, Math.floor((endMs - startMs) / 1000)));
	}, [turnStartedAt, showWorkIndicator, narratorUpdatedAt]);
	const turnElapsedText = useMemo(() => {
		if (turnElapsed == null) return null;
		const m = Math.floor(turnElapsed / 60);
		const s = turnElapsed % 60;
		return `${m}:${s.toString().padStart(2, "0")}`;
	}, [turnElapsed]);

	const todosCtxValue = useMemo(
		() => ({ toolUseId: todosToolUseId, isThinking: !!isWorking }),
		[todosToolUseId, isWorking],
	);

	// --- Retry countdown ---
	const [retryCountdown, setRetryCountdown] = useState<number>(0);
	useEffect(() => {
		if (!retryInfo) {
			setRetryCountdown(0);
			return;
		}
		const tick = () => {
			const remaining = Math.max(0, Math.ceil((retryInfo.retryAt - Date.now()) / 1000));
			setRetryCountdown(remaining);
		};
		tick();
		const id = setInterval(tick, 1000);
		return () => clearInterval(id);
	}, [retryInfo]);

	const activeTodo = useMemo(() => {
		if (!Array.isArray(currentTodos) || !currentTodos.length) return null;
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
	const sendingRef = useRef(false);

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
		const onTouchEnd = () => handleInterruptMouseUpRef.current();
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
	const handleInterruptMouseUp = useCallback(() => {
		if (!interruptFiredRef.current && interruptTimerRef.current) {
			notifications.show({
				message: t("interruptHoldHint"),
				color: "yellow",
			});
		}
		clearInterruptTimer();
	}, [clearInterruptTimer, t]);
	const handleInterruptMouseUpRef = useRef(handleInterruptMouseUp);
	handleInterruptMouseUpRef.current = handleInterruptMouseUp;

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
		for (let i = firstPage.messages.length - 1; i >= 0; i--) {
			const msg = firstPage.messages[i];
			if (!msg || msg.id === STREAMING_CHUNKS_MSG_ID) continue;
			// Skip error system messages so they don't hide the retry button
			if (
				msg.role === "system" &&
				Array.isArray(msg.contentJson) &&
				msg.contentJson.some((b: { type: string }) => b.type === "error")
			) {
				continue;
			}
			return msg;
		}
		return null;
	}, [hydrated, messagesData]);

	const narratorIsIdle =
		narrator?.status === "idle" ||
		narrator?.status === "done" ||
		narrator?.status === "error" ||
		narrator?.status === "interrupted";

	const canRetryLastUserMessage =
		!!lastMessage &&
		lastMessage.role === "user" &&
		!String(lastMessage.id).startsWith("optimistic-") &&
		narratorIsIdle;

	const canContinueNarrator =
		!!lastMessage &&
		lastMessage.role === "assistant" &&
		!String(lastMessage.id).startsWith("optimistic-") &&
		narratorIsIdle;

	// Find the last user message ID for edit confirmation logic
	const lastUserMessageId = useMemo(() => {
		if (!hydrated || !messagesData?.pages) return undefined;
		for (const page of messagesData.pages) {
			const msgs = page.messages;
			if (!msgs) continue;
			for (let i = msgs.length - 1; i >= 0; i--) {
				const msg = msgs[i];
				if (msg?.role === "user" && !String(msg.id).startsWith("optimistic-")) {
					return msg.id;
				}
			}
		}
		return undefined;
	}, [hydrated, messagesData]);

	const hasChapter = !!narrator?.chapterId;

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
	// Chapter-bound: use onForkFromMessage (direct fork with auto-generated name)
	// Standalone: use handleStandaloneFork (direct narrator fork)
	const forkHandler = narrator?.chapterId ? onForkFromMessage : handleStandaloneFork;

	// --- Virtualization setup ---
	const highlightScrolledRef = useRef(false);
	const highlightStartTimerRef = useRef<number | null>(null);
	const highlightClearTimerRef = useRef<number | null>(null);
	const initialScrollDoneRef = useRef(false);
	const [initialScrollDone, setInitialScrollDone] = useState(false);
	const [highlightedId, setHighlightedId] = useState<string | null>(null);
	const virtualListRef = useRef<BroadMessageListHandle>(null);

	const clearHighlightTimers = useCallback(() => {
		if (highlightStartTimerRef.current != null) {
			window.clearTimeout(highlightStartTimerRef.current);
			highlightStartTimerRef.current = null;
		}
		if (highlightClearTimerRef.current != null) {
			window.clearTimeout(highlightClearTimerRef.current);
			highlightClearTimerRef.current = null;
		}
	}, []);

	const scheduleHighlight = useCallback(
		(messageId: string, delayMs: number) => {
			clearHighlightTimers();
			highlightStartTimerRef.current = window.setTimeout(() => {
				setHighlightedId(messageId);
				highlightClearTimerRef.current = window.setTimeout(() => {
					setHighlightedId((current) => (current === messageId ? null : current));
					highlightClearTimerRef.current = null;
				}, 1600);
				highlightStartTimerRef.current = null;
			}, delayMs);
		},
		[clearHighlightTimers],
	);

	const stableToolRunKeyByTargetIdRef = useRef<Map<string, string>>(new Map());
	const nextStableToolRunKeyRef = useRef(1);
	const prevNarratorIdRef = useRef(narratorId);
	if (prevNarratorIdRef.current !== narratorId) {
		prevNarratorIdRef.current = narratorId;
		if (initialScrollDoneRef.current) {
			initialScrollDoneRef.current = false;
			setInitialScrollDone(false);
		}
		stableToolRunKeyByTargetIdRef.current.clear();
		nextStableToolRunKeyRef.current = 1;
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: narratorId/highlightMessageId are used to reset one-shot highlight state when the active target changes
	useEffect(() => {
		highlightScrolledRef.current = false;
		clearHighlightTimers();
		setHighlightedId(null);
	}, [narratorId, highlightMessageId, clearHighlightTimers]);

	useEffect(() => clearHighlightTimers, [clearHighlightTimers]);

	const getStableRenderElementKey = useCallback(
		(rawKey: string, targetIds: string[], pageKey?: string, usedKeys?: Set<string>) => {
			if (!rawKey.includes("tool-run-")) {
				return pageKey ? `${pageKey}-${rawKey}` : rawKey;
			}
			if (targetIds.length === 0) {
				return pageKey ? `${pageKey}-${rawKey}` : rawKey;
			}

			let stableKey: string | undefined;
			for (const targetId of targetIds) {
				stableKey = stableToolRunKeyByTargetIdRef.current.get(targetId);
				if (stableKey) break;
			}
			// If the found key is already used in this render batch (e.g. same msg.id
			// produced multiple tool-run segments split by content blocks), allocate
			// a fresh key to avoid duplicate React keys.
			if (stableKey && usedKeys?.has(stableKey)) {
				stableKey = undefined;
			}
			if (!stableKey) {
				stableKey = `tool-run-stable-${nextStableToolRunKeyRef.current++}`;
			}
			for (const targetId of targetIds) {
				stableToolRunKeyByTargetIdRef.current.set(targetId, stableKey);
			}
			return stableKey;
		},
		[],
	);

	// Pre-render trim: on mount (key={narratorId} causes full remount on switch),
	// if the incoming narrator already has too many cached pages from a previous
	// visit, drop the oldest ones before the first paint to avoid a heavy render.
	const mountTrimmedRef = useRef(false);
	if (!mountTrimmedRef.current) {
		mountTrimmedRef.current = true;
		const MAX_MOUNT_MESSAGES = 60;
		const cached = qc.getQueryData<MessagesQueryData>(messagesQueryKey);
		if (cached?.pages && cached.pages.length > 1) {
			const trimmed = evictOldestPages(cached, MAX_MOUNT_MESSAGES);
			if (trimmed !== cached) {
				qc.setQueryData(messagesQueryKey, trimmed);
			}
		}
	}

	// With virtualization there is no progressive rendering phase — always done.
	const renderDone = true;

	// Trim message cache on unmount / narrator switch
	useEffect(() => {
		const keyToTrim = messagesQueryKey;
		return () => {
			const MAX_CACHED_MESSAGES = 200;
			qc.setQueryData(keyToTrim, (old: MessagesQueryData | undefined) => {
				if (!old?.pages?.length || old.pages.length <= 1) return old;
				return evictOldestPages(old, MAX_CACHED_MESSAGES) as MessagesQueryData;
			});
		};
	}, [messagesQueryKey, qc]);

	// --- Multi-select state ---
	const [selectionMode, setSelectionMode] = useState(false);
	const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(new Set());
	const [anchorBlockId, setAnchorBlockId] = useState<string | null>(null);

	const exitSelection = useCallback(() => {
		setSelectionMode(false);
		setSelectedBlockIds(new Set());
		setAnchorBlockId(null);
		setGlobalSwipeAnchor(null);
		// Close any open swipe
		const closeFn = getGlobalCloseSwipe();
		if (closeFn) closeFn();
	}, []);

	const deselectBlock = useCallback((blockId: string) => {
		setSelectedBlockIds((prev) => {
			const next = new Set(prev);
			next.delete(blockId);
			if (next.size === 0) {
				setSelectionMode(false);
				setAnchorBlockId(null);
				setGlobalSwipeAnchor(null);
			}
			return next;
		});
	}, []);

	// Register the global range-selection callback so useSwipeMenu instances
	// can trigger multi-select without prop drilling.
	useEffect(() => {
		const handler = (anchor: string, target: string) => {
			const container = contentRef.current;
			if (!container) return;
			const range = resolveBlockRange(container, anchor, target);
			if (!range) return;
			setSelectionMode(true);
			setSelectedBlockIds(range);
			setAnchorBlockId(anchor);
		};
		setGlobalOnSelectionRange(handler);
		return () => setGlobalOnSelectionRange(null);
	}, []);

	// Clear selection when narrator changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: narratorId is intentionally a dependency to reset selection on narrator switch
	useEffect(() => {
		exitSelection();
	}, [narratorId, exitSelection]);

	const selectionCtxValue = useMemo<MessageSelectionState>(
		() => ({
			selectionMode,
			selectedBlockIds,
			anchorBlockId,
			exitSelection,
			deselectBlock,
		}),
		[selectionMode, selectedBlockIds, anchorBlockId, exitSelection, deselectBlock],
	);

	// --- Flat elements for virtualization ---
	const showTokenUsage = userPrefs?.showTokenUsage ?? false;
	const [advancedAnim] = useLocalPref("narrafork_advanced_anim");
	const suppressBlurIn =
		!advancedAnim || isResizing || !initialScrollDone || shifting || isFetchingPreviousPage;
	const blurInSeedIds = useMemo(() => {
		if (!advancedAnim || !suppressBlurIn || !messagesData?.pages?.length) return [];
		const ids = new Set<string>();
		for (const page of messagesData.pages) {
			for (const animationId of collectBlurInAnimationIdsFromMessages(page.messages)) {
				ids.add(animationId);
			}
		}
		return [...ids];
	}, [advancedAnim, suppressBlurIn, messagesData]);
	// Page-level cache: keyed by page reference → rendered elements/keys/targets/meta.
	// Build a synthetic streaming message from the current streaming state.
	// All streaming content (reasoning, text, web_search, tool chunks) is combined
	// into a single message so segmentMessages can apply canonical ordering and
	// merge tool-runs correctly.
	const streamingReasoningCreatedAtRef = useRef<string | null>(null);
	const hasStreamingContent =
		!!streamingRef.current ||
		!!streamingReasoningRef.current ||
		!!topLevelStreamingChunks ||
		!!webSearchRef.current;
	if (hasStreamingContent) {
		if (!streamingReasoningCreatedAtRef.current) {
			streamingReasoningCreatedAtRef.current = new Date().toISOString();
		}
	} else {
		streamingReasoningCreatedAtRef.current = null;
	}

	// Build the streaming message inside useMemo so it only produces a new
	// reference when the actual streaming content changes, not on every render.
	// biome-ignore lint/correctness/useExhaustiveDependencies: refs are read intentionally — streamingVersion forces re-evaluation
	const streamingMsg = useMemo(() => {
		// streamingVersion forces re-read of refs (streamingRef, streamingReasoningRef, webSearchRef)
		void streamingVersion;
		return buildStreamingMsg({
			reasoningText: streamingReasoningRef.current || undefined,
			streamingText: streamingRef.current || undefined,
			webSearch: webSearchRef.current,
			toolChunksMsg: topLevelStreamingChunks,
			narratorId,
			reasoningCreatedAt: streamingReasoningCreatedAtRef.current ?? undefined,
		});
	}, [streamingVersion, topLevelStreamingChunks, narratorId]);

	// When a page object reference doesn't change, we reuse the cached result.
	const pageCacheRef = useRef(
		new WeakMap<
			object,
			{
				elements: React.ReactNode[];
				keys: string[];
				targets: string[][];
				meta: RenderedTreeElementMeta[];
			}
		>(),
	);
	const pruneDividerLabel = t("pruneBoundaryLabel");

	const { flatElements, flatKeys, flatTargets } = useMemo(() => {
		if (isResizing || !messagesData?.pages) {
			return {
				flatElements: [],
				flatKeys: [],
				flatTargets: [],
			};
		}
		const pages = messagesData.pages;
		const pageParams = messagesData.pageParams ?? [];
		const reversed = pages
			.map((page, originalIndex) => ({ page, originalIndex, pageParam: pageParams[originalIndex] }))
			.reverse();
		const cache = pageCacheRef.current;
		const allElements: React.ReactNode[] = [];
		const allKeys: string[] = [];
		const allTargets: string[][] = [];
		const usedKeys = new Set<string>();

		// Build a cache key object per page that includes all render-affecting props.
		// We use the page reference as the primary cache key, but invalidate when
		// other props change by storing a secondary key alongside.
		const permsKey = `${renderPermCb.pendingPermsMap.size}:${[...renderPermCb.pendingPermsMap.keys()].join(",")}`;
		const bgDismissedKey = `${renderPermCb.bgRetryDismissedIds.size}:${[...renderPermCb.bgRetryDismissedIds].join(",")}`;
		const secondaryKey = `${narratorId}|${highlightedId}|${expandedToolUseId}|${editExpandOverride}|${showTokenUsage}|${pruneBoundaryMessageId}|${lastUserMessageId}|${hasChapter}|${permsKey}|${bgDismissedKey}`;

		for (let ri = 0; ri < reversed.length; ri++) {
			const { page, originalIndex, pageParam } = reversed[ri];
			if (!page?.messages?.length) continue;
			const pageCursor =
				typeof pageParam === "object" && pageParam && "cursor" in pageParam
					? String(pageParam.cursor)
					: typeof pageParam === "string"
						? pageParam
						: undefined;
			const pageDirection =
				typeof pageParam === "object" && pageParam && "direction" in pageParam
					? String(pageParam.direction)
					: "older";
			const pageKey =
				pageParam == null
					? `initial:${narratorId}:${highlightMessageId ?? "latest"}`
					: `${pageDirection}:${pageCursor ?? originalIndex}`;

			// The last page in the reversed array (= first/newest page) receives
			// the streaming message so it participates in normal segmentation.
			const isNewestPage = ri === reversed.length - 1;
			const pageStreamingMsg = isNewestPage ? streamingMsg : null;

			// Check cache — skip cache when streaming is active on this page
			const cached = cache.get(page);
			if (
				!pageStreamingMsg &&
				cached &&
				(cached as { _secondaryKey?: string })._secondaryKey === secondaryKey
			) {
				for (let j = 0; j < cached.elements.length; j++) {
					const targetIds = cached.targets[j] ?? [];
					allElements.push(cached.elements[j]);
					const key = getStableRenderElementKey(cached.keys[j], targetIds, pageKey, usedKeys);
					usedKeys.add(key);
					allKeys.push(key);
					allTargets.push(targetIds);
				}
				continue;
			}

			// Compute elements for this page
			const result = renderTreeMessagesWithKeys(
				page.messages,
				narratorId,
				forkHandler,
				highlightedId,
				renderPermCb,
				expandedToolUseId,
				editExpandOverride,
				showTokenUsage,
				pruneBoundaryMessageId,
				pruneDividerLabel,
				handleCompactBefore,
				handleDeleteBlock,
				handleRegenerate,
				handleEditAndRegenerate,
				lastUserMessageId,
				hasChapter,
				onViewSubagentSession,
				pageStreamingMsg,
			);

			// Only cache when there's no streaming message (streaming changes every frame)
			if (!pageStreamingMsg) {
				const entry = { ...result, _secondaryKey: secondaryKey };
				cache.set(page, entry);
			}

			for (let j = 0; j < result.elements.length; j++) {
				const targetIds = result.targets[j] ?? [];
				allElements.push(result.elements[j]);
				const key = getStableRenderElementKey(result.keys[j], targetIds, pageKey, usedKeys);
				usedKeys.add(key);
				allKeys.push(key);
				allTargets.push(targetIds);
			}
		}

		return {
			flatElements: allElements,
			flatKeys: allKeys,
			flatTargets: allTargets,
		};
	}, [
		isResizing,
		messagesData,
		narratorId,
		forkHandler,
		renderPermCb,
		expandedToolUseId,
		editExpandOverride,
		highlightedId,
		highlightMessageId,
		showTokenUsage,
		getStableRenderElementKey,
		handleDeleteBlock,
		handleCompactBefore,
		handleRegenerate,
		handleEditAndRegenerate,
		pruneBoundaryMessageId,
		pruneDividerLabel,
		lastUserMessageId,
		hasChapter,
		onViewSubagentSession,
		streamingMsg,
	]);

	// All streaming content is now handled by segmentMessages via streamingMsg.
	// No separate finalElements pass needed — flatElements is the final output.
	const finalElements = flatElements;
	const finalKeys = flatKeys;
	const finalTargets = flatTargets;

	const targetIndexMap = useMemo(() => {
		const indexMap = new Map<string, number>();
		for (let i = 0; i < finalTargets.length; i++) {
			for (const targetId of finalTargets[i] ?? []) {
				if (targetId && !indexMap.has(targetId)) {
					indexMap.set(targetId, i);
				}
			}
		}
		return indexMap;
	}, [finalTargets]);

	// --- User message markers for scrollbar minimap ---
	const userMessageMarkers = useMemo(() => {
		if (!messagesData?.pages) return [];
		const markers: { index: number; id: string }[] = [];
		for (const page of messagesData.pages) {
			for (const msg of page.messages ?? []) {
				if (msg.role === "user" && msg.id) {
					const idx = targetIndexMap.get(msg.id);
					if (idx != null) markers.push({ index: idx, id: msg.id });
				}
			}
		}
		markers.sort((a, b) => a.index - b.index);
		return markers;
	}, [messagesData, targetIndexMap]);

	const handleMarkerJump = useCallback((elementIndex: number) => {
		virtualListRef.current?.scrollToIndex(elementIndex, { align: "center" });
	}, []);

	// --- Load older / newer ---
	const handleLoadOlder = useCallback(async () => {
		if (isFetchingNextPage) return;
		// Enable shift mode so the virtual list adjusts scrollTop to compensate
		// for prepended content height.
		setShifting(true);
		await fetchNextPage();
		requestAnimationFrame(() => {
			setShifting(false);
		});
	}, [fetchNextPage, isFetchingNextPage]);

	const handleLoadNewer = useCallback(async () => {
		if (isFetchingPreviousPage) return;
		await fetchPreviousPage();
	}, [fetchPreviousPage, isFetchingPreviousPage]);

	const revealLatestMessages = useCallback(async () => {
		for (let attempt = 0; attempt < 20; attempt++) {
			const firstPage = qc.getQueryData<MessagesQueryData>(messagesQueryKey)?.pages?.[0];
			if (!firstPage?.hasMoreAfter || !firstPage.prevCursor) break;
			await fetchPreviousPage();
		}
		scrollToBottom(true);
	}, [fetchPreviousPage, messagesQueryKey, qc, scrollToBottom]);

	const handleLoadOlderRef = useRef(handleLoadOlder);
	handleLoadOlderRef.current = handleLoadOlder;
	useEffect(() => {
		if (!autoLoadEnabled || !hasNextPage || !initialScrollDone || isFetchingNextPage) return;
		const vp = viewportRef.current;
		if (!vp) return;
		const check = () => {
			// Normal scroll direction: scrollTop near 0 = near visual top (older messages).
			// Trigger load-older when within 2x viewport height from the top.
			if (vp.scrollTop < vp.clientHeight * 2 && vp.scrollHeight > vp.clientHeight) {
				handleLoadOlderRef.current();
			}
		};
		check();
		vp.addEventListener("scroll", check, { passive: true });
		return () => vp.removeEventListener("scroll", check);
	}, [autoLoadEnabled, hasNextPage, initialScrollDone, isFetchingNextPage]);

	const handleLoadNewerRef = useRef(handleLoadNewer);
	handleLoadNewerRef.current = handleLoadNewer;
	useEffect(() => {
		if (!autoLoadEnabled || !hasPreviousPage || !initialScrollDone || isFetchingPreviousPage)
			return;
		const vp = viewportRef.current;
		if (!vp) return;
		const check = () => {
			// Normal scroll direction: scrollTop near max = at visual bottom (newest messages).
			// Trigger load-newer when near the bottom.
			const distFromBottom = vp.scrollHeight - vp.scrollTop - vp.clientHeight;
			if (distFromBottom <= 24) {
				handleLoadNewerRef.current();
			}
		};
		vp.addEventListener("scroll", check, { passive: true });
		return () => vp.removeEventListener("scroll", check);
	}, [autoLoadEnabled, hasPreviousPage, initialScrollDone, isFetchingPreviousPage]);

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
	// biome-ignore lint/correctness/useExhaustiveDependencies: renderDone is a state trigger — effect must re-run when it flips to true
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

	// --- Auto-scroll via MutationObserver + ResizeObserver ---
	// MutationObserver detects DOM changes (new messages added) in the scroll
	// container and triggers the follow loop. ResizeObserver on the viewport
	// handles viewport resize (e.g. DevTools toggle).
	// biome-ignore lint/correctness/useExhaustiveDependencies: initialScrollDone is a trigger dep, not read inside
	useEffect(() => {
		const vp = viewportRef.current;
		if (!vp) return;

		// Track whether the *viewport* itself is being resized (e.g. DevTools
		// mobile↔desktop toggle). During a viewport resize both observers fire
		// in rapid succession; using the RAF-based follow loop in that situation
		// causes continuous scrollTop writes that force layout thrashing, block
		// the main thread, and can trigger React's "Maximum update depth" error.
		let vpResizeTimer = 0;

		// Use MutationObserver to detect content changes (new messages, streaming
		// content growth, etc.) instead of ResizeObserver on contentRef. This is
		// more reliable because broad-infinite-list manages its own DOM structure
		// and contentRef may not be set synchronously.
		let mutationRafId = 0;
		const mutationObserver = new MutationObserver(() => {
			if (!initialScrollDoneRef.current) return;
			// Debounce via rAF to batch rapid DOM mutations (e.g. streaming)
			cancelAnimationFrame(mutationRafId);
			mutationRafId = requestAnimationFrame(() => {
				if (resizingRef.current) {
					if (isAtBottomRef.current && !highlightMessageId) {
						programmaticScrollRef.current = true;
						vp.scrollTop = vp.scrollHeight - vp.clientHeight;
					}
					return;
				}
				if (isAtBottomRef.current && !highlightMessageId) {
					startFollowing();
				} else if (!isAtBottomRef.current && !highlightMessageId) {
					if (vp.scrollHeight - vp.scrollTop - vp.clientHeight < 30) {
						isAtBottomRef.current = true;
						setIsAtBottom(true);
					}
				}
			});
		});
		mutationObserver.observe(vp, { childList: true, subtree: true });

		// ResizeObserver on the content wrapper detects height changes that
		// don't add/remove DOM nodes (e.g. text content updates, image loads,
		// code block expansion). Without this, the MutationObserver alone
		// misses cases where existing elements grow taller.
		let contentResizeRafId = 0;
		const contentObserver = new ResizeObserver(() => {
			if (!initialScrollDoneRef.current || resizingRef.current) return;
			cancelAnimationFrame(contentResizeRafId);
			contentResizeRafId = requestAnimationFrame(() => {
				if (resizingRef.current) {
					if (isAtBottomRef.current && !highlightMessageId) {
						programmaticScrollRef.current = true;
						vp.scrollTop = vp.scrollHeight - vp.clientHeight;
					}
					return;
				}
				if (isAtBottomRef.current && !highlightMessageId) {
					startFollowing();
				}
			});
		});
		// Observe the list wrapper (contentRef) — its height changes when
		// any child element grows/shrinks without DOM node count changing.
		const listWrapper = contentRef.current;
		if (listWrapper) {
			contentObserver.observe(listWrapper);
		}

		const vpObserver = new ResizeObserver(() => {
			// Mark that a viewport resize is in progress so the mutation
			// observer takes the synchronous-snap path, and onScroll
			// suppresses all detach checks for the duration.
			resizingRef.current = true;
			clearTimeout(vpResizeTimer);
			vpResizeTimer = window.setTimeout(() => {
				resizingRef.current = false;
			}, 150);

			if (isAtBottomRef.current && !highlightMessageId) {
				programmaticScrollRef.current = true;
				vp.scrollTop = vp.scrollHeight - vp.clientHeight;
			}
		});
		vpObserver.observe(vp);

		return () => {
			clearTimeout(vpResizeTimer);
			cancelAnimationFrame(mutationRafId);
			cancelAnimationFrame(contentResizeRafId);
			resizingRef.current = false;
			mutationObserver.disconnect();
			contentObserver.disconnect();
			vpObserver.disconnect();
			stopFollowing();
		};
	}, [highlightMessageId, initialScrollDone, startFollowing, stopFollowing]);

	const scrollToVirtualTarget = useCallback(
		({
			domIds,
			targetIds,
			highlightId,
		}: {
			domIds: string[];
			targetIds: string[];
			highlightId?: string;
		}) => {
			for (const domId of domIds) {
				const el = document.getElementById(domId);
				if (el) {
					requestAnimationFrame(() => {
						el.scrollIntoView({ behavior: "smooth", block: "center" });
						if (highlightId) {
							scheduleHighlight(highlightId, 400);
						}
					});
					return true;
				}
			}
			const targetIndex = targetIds
				.map((targetId) => targetIndexMap.get(targetId))
				.find((index): index is number => index != null);
			if (targetIndex != null && virtualListRef.current) {
				virtualListRef.current.scrollToIndex(targetIndex, { align: "center" });
				if (domIds.length > 0) {
					window.setTimeout(() => {
						for (const domId of domIds) {
							const el = document.getElementById(domId);
							if (el) {
								el.scrollIntoView({ block: "center" });
								break;
							}
						}
					}, 80);
				}
				if (highlightId) {
					scheduleHighlight(highlightId, 300);
				}
				return true;
			}
			return false;
		},
		[scheduleHighlight, targetIndexMap],
	);

	// --- Scroll to highlighted message ---
	useEffect(() => {
		if (!highlightMessageId || totalMessageCount === 0 || highlightScrolledRef.current) return;
		highlightScrolledRef.current = scrollToVirtualTarget({
			domIds: [`msg-${highlightMessageId}`],
			targetIds: [highlightMessageId],
			highlightId: highlightMessageId,
		});
	}, [highlightMessageId, totalMessageCount, scrollToVirtualTarget]);

	// --- Send / retry message ---
	const submitMessage = async (msg: string, images: File[] = [], textFiles: File[] = []) => {
		streamingRef.current = "";
		streamingReasoningRef.current = "";

		// Detect slash command for optimistic display
		const isSlashCommand = msg.startsWith("/") && /^\/[a-zA-Z0-9_-]+(\s|$)/.test(msg);
		const commandText = isSlashCommand ? msg : null;

		const optimisticBlocks: ContentBlock[] = [
			...images.map((f) => ({
				type: "image",
				filename: f.name,
				mediaType: f.type,
				previewUrl: URL.createObjectURL(f),
			})),
			...textFiles.map((f) => ({
				type: "text_file",
				filename: f.name,
				size: f.size,
			})),
			{ type: "text", text: msg },
		];
		const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const optimisticMsg: TreeMessage = {
			id: optimisticId,
			narratorId,
			parentToolUseId: null,
			role: "user",
			contentJson: optimisticBlocks,
			contentText: msg,
			commandText,
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
			const result = await api.sendNarratorMessage(
				narratorId,
				msg,
				images.length > 0 ? images : undefined,
				textFiles.length > 0 ? textFiles : undefined,
			);
			// Handle /load tool response — not a real message, just a tool load confirmation
			if (result?.loaded) {
				// Remove optimistic message since no real message was created
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					const pages = [...old.pages];
					const firstPage = { ...pages[0] };
					firstPage.messages = firstPage.messages.filter((m: NarratorMsg) => m.id !== optimisticId);
					pages[0] = firstPage;
					return { ...old, pages };
				});
				const toolName = result.toolName ?? "tool";
				notifications.show({
					title: result.alreadyLoaded ? t("toolAlreadyLoaded") : t("toolLoaded"),
					message: toolName,
					color: result.alreadyLoaded ? "yellow" : "green",
				});
			} else if (result?.buffered) {
				// Message was buffered — remove optimistic message,
				// WS buffer_set broadcast will sync the queue state.
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					const pages = [...old.pages];
					const firstPage = { ...pages[0] };
					firstPage.messages = firstPage.messages.filter((m: NarratorMsg) => m.id !== optimisticId);
					pages[0] = firstPage;
					return { ...old, pages };
				});
				scrollToBottom(true);
			} else if (result?.id) {
				// Normal message — replace optimistic message with the real server message
				// so we don't depend solely on WS onUserMessage for dedup.
				const serverMsg: NarratorMsg = {
					...result,
					children: result.children ?? [],
					toolCalls: result.toolCalls ?? [],
				};
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					const pages = [...old.pages];
					const firstPage = { ...pages[0] };
					const idx = firstPage.messages.findIndex((m: NarratorMsg) => m.id === optimisticId);
					if (idx !== -1) {
						// Optimistic message still present — replace it
						const updated = [...firstPage.messages];
						revokeContentBlockPreviewUrls(updated[idx].contentJson);
						updated[idx] = serverMsg;
						firstPage.messages = updated;
					} else if (!firstPage.messages.some((m: NarratorMsg) => m.id === serverMsg.id)) {
						// Optimistic was already replaced by WS, but server msg not yet in cache
						firstPage.messages = [...firstPage.messages, serverMsg];
					}
					pages[0] = firstPage;
					return { ...old, pages };
				});
			}
		} catch (err) {
			qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
				if (!old?.pages?.length) return old;
				const pages = [...old.pages];
				const firstPage = { ...pages[0] };
				const nextMessages = firstPage.messages.filter(
					(existing: NarratorMsg) => existing.id !== optimisticId,
				);
				if (nextMessages.length === firstPage.messages.length) return old;
				firstPage.messages = nextMessages;
				pages[0] = firstPage;
				return { ...old, pages };
			});
			const message = err instanceof Error ? err.message : "Failed to send message";
			notifications.show({ title: "Error", message, color: "red" });
		} finally {
			revokeContentBlockPreviewUrls(optimisticBlocks);
		}
	};

	const handleSend = async () => {
		const msg = input.trim();
		if (!msg || sendingRef.current) return;
		sendingRef.current = true;
		try {
			inputHistory.push(msg);
			if (isActive) {
				// Send via HTTP POST so images/textFiles are uploaded via multipart/form-data
				const images = [...attachedImages];
				const textFiles = [...attachedTextFiles];
				setInput("");
				setAttachedImages([]);
				setAttachedTextFiles([]);
				try {
					const result = await api.sendNarratorMessage(
						narratorId,
						msg,
						images.length > 0 ? images : undefined,
						textFiles.length > 0 ? textFiles : undefined,
					);
					if (result?.buffered) {
						// Don't optimistically insert — the WS buffer_set broadcast
						// from the server will sync the authoritative queue state.
						scrollToBottom(true);
					}
				} catch {
					// Fallback to WebSocket text-only buffer (images/textFiles not supported over WS)
					if (images.length > 0) {
						setAttachedImages(images);
					}
					if (textFiles.length > 0) {
						setAttachedTextFiles(textFiles);
					}
					sendBufferMessage(narratorId, msg);
					// Optimistic: WS buffer_set will sync the real state
					scrollToBottom(true);
				}
				return;
			}
			const images = [...attachedImages];
			const textFiles = [...attachedTextFiles];
			setInput("");
			setAttachedImages([]);
			setAttachedTextFiles([]);
			await submitMessage(msg, images, textFiles);
		} finally {
			sendingRef.current = false;
		}
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

	const handleContinue = async () => {
		if (!canContinueNarrator) return;
		try {
			await api.continueNarrator(narratorId);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to continue";
			notifications.show({ title: "Error", message, color: "red" });
		}
	};

	const handleCancelAllQueued = () => {
		if (queuedMessages.length > 0) {
			cancelBuffer(narratorId);
			// Restore the first queued message text to the input
			setInput(queuedMessages[0].text);
			setQueuedMessages([]);
		}
	};

	const handleRemoveQueued = (messageId: string) => {
		const msg = queuedMessages.find((m) => m.id === messageId);
		const snapshot = queuedMessages;
		setQueuedMessages((prev) => prev.filter((m) => m.id !== messageId));
		// If removing the only message, restore its text to input
		if (queuedMessages.length === 1 && msg) {
			setInput(msg.text);
		}
		api.removeBufferedMessage(narratorId, messageId).catch(() => {
			// Rollback on failure
			setQueuedMessages(snapshot);
			if (queuedMessages.length === 1 && msg) {
				setInput("");
			}
		});
	};

	const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
	const [editingQueuedText, setEditingQueuedText] = useState("");

	const handleStartEditQueued = (msg: { id: string; text: string }) => {
		setEditingQueuedId(msg.id);
		setEditingQueuedText(msg.text);
	};

	const handleSaveEditQueued = () => {
		if (!editingQueuedId || !editingQueuedText.trim()) return;
		const trimmed = editingQueuedText.trim();
		const snapshot = queuedMessages;
		setQueuedMessages((prev) =>
			prev.map((m) =>
				m.id === editingQueuedId
					? { ...m, text: trimmed, bufferedAt: new Date().toISOString() }
					: m,
			),
		);
		setEditingQueuedId(null);
		setEditingQueuedText("");
		api.updateBufferedMessage(narratorId, editingQueuedId, trimmed).catch(() => {
			// Rollback on failure
			setQueuedMessages(snapshot);
		});
	};

	const handleCancelEditQueued = () => {
		setEditingQueuedId(null);
		setEditingQueuedText("");
	};

	const addImages = async (files: File[]) => {
		const valid = files.filter((f) => {
			if (!ACCEPTED_TYPES.includes(f.type)) return false;
			if (f.size > MAX_IMAGE_SIZE) return false;
			return true;
		});
		if (valid.length === 0) return;
		const processed: File[] = [];
		for (const f of valid) {
			// GIF: skip resize (may be animated)
			if (f.type === "image/gif") {
				processed.push(f);
				continue;
			}
			try {
				const resized = await resizeImageIfNeeded(f, MAX_IMAGE_LONG_EDGE);
				processed.push(resized);
			} catch {
				processed.push(f); // fallback to original on error
			}
		}
		setAttachedImages((prev) => [...prev, ...processed]);
	};

	const addTextFiles = (files: File[]) => {
		const valid = files.filter((f) => {
			if (!isTextFile(f.name)) {
				notifications.show({
					title: t("unsupportedFileType"),
					message: f.name,
					color: "yellow",
				});
				return false;
			}
			if (f.size > MAX_TEXT_FILE_SIZE) {
				notifications.show({
					title: t("textFileTooLarge"),
					message: `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`,
					color: "yellow",
				});
				return false;
			}
			return true;
		});
		if (valid.length > 0) {
			setAttachedTextFiles((prev) => [...prev, ...valid]);
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

	const handleDragEnter = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current++;
		if (e.dataTransfer.types.includes("Files")) {
			setIsDragging(true);
		}
	};

	const handleDragLeave = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current--;
		if (dragCounterRef.current === 0) {
			setIsDragging(false);
		}
	};

	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current = 0;
		setIsDragging(false);
		const files = Array.from(e.dataTransfer.files);
		if (files.length === 0) return;
		const imageFiles: File[] = [];
		const textFileList: File[] = [];
		const unsupported: string[] = [];
		for (const f of files) {
			if (ACCEPTED_TYPES.includes(f.type)) {
				imageFiles.push(f);
			} else if (isTextFile(f.name)) {
				textFileList.push(f);
			} else {
				unsupported.push(f.name);
			}
		}
		if (unsupported.length > 0) {
			notifications.show({
				title: t("unsupportedFileType"),
				message: unsupported.join(", "),
				color: "yellow",
			});
		}
		if (imageFiles.length > 0) addImages(imageFiles);
		if (textFileList.length > 0) addTextFiles(textFileList);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		// Let CommandPopover handle arrow/tab/escape keys when visible,
		// but still allow Enter to reach our send handler (CommandPopover
		// calls stopPropagation when it consumes Enter for selection).
		if (commandPopoverVisible && e.key !== "Enter") return;

		const ctrlEnterMode = (userPrefs?.sendMode ?? "enter") === "ctrl+enter";

		if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			if (ctrlEnterMode) {
				// Ctrl+Enter mode: Ctrl/Cmd+Enter sends, plain Enter inserts newline
				if (e.ctrlKey || e.metaKey) {
					e.preventDefault();
					handleSend();
				}
			} else {
				// Enter mode (default): Enter sends, Shift/Ctrl/Cmd+Enter inserts newline
				if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
					e.preventDefault();
					handleSend();
				} else if (e.ctrlKey || e.metaKey) {
					// Ctrl/Cmd+Enter: browsers don't insert a newline by default, do it manually
					e.preventDefault();
					const textarea = e.currentTarget as HTMLTextAreaElement;
					const { selectionStart, selectionEnd } = textarea;
					const before = input.slice(0, selectionStart);
					const after = input.slice(selectionEnd);
					const newValue = `${before}\n${after}`;
					setInput(newValue);
					requestAnimationFrame(() => {
						textarea.selectionStart = textarea.selectionEnd = selectionStart + 1;
					});
				}
			}
			return;
		}
		// 上下箭头翻阅输入历史
		// 需要处理 soft-wrap（长文本自动折行）的情况：
		// 先让浏览器执行默认的光标移动，如果光标位置没变说明已在首/末视觉行，
		// 此时才触发历史导航。
		if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			const textarea = e.currentTarget as HTMLTextAreaElement;
			const posBefore = textarea.selectionStart;
			const direction = e.key === "ArrowUp" ? "up" : "down";
			// 让浏览器先处理默认行为，下一帧再检查光标是否移动
			requestAnimationFrame(() => {
				const posAfter = textarea.selectionStart;
				if (posBefore !== posAfter) return; // 光标移动了，说明还在文本中间行
				const result = inputHistory.navigate(direction, input);
				if (result !== null) {
					setInput(result);
					// 将光标移到末尾
					requestAnimationFrame(() => {
						textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
					});
				}
			});
		}
	};

	if (!narrator || messagesLoading) return <NarratorPanelSkeleton />;

	return (
		<ContentViewerEnvironmentProvider value={contentViewerEnvironment}>
			<Stack
				h="100%"
				gap={0}
				style={{ overflow: "hidden", position: "relative" }}
				onDragEnter={handleDragEnter}
				onDragLeave={handleDragLeave}
				onDragOver={handleDragOver}
				onDrop={handleDrop}
			>
				{/* Drop overlay */}
				{isDragging && (
					<Box
						style={{
							position: "absolute",
							inset: 0,
							zIndex: 100,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							backgroundColor: "rgba(0, 0, 0, 0.5)",
							border: "2px dashed var(--mantine-color-indigo-5)",
							borderRadius: "var(--mantine-radius-md)",
							pointerEvents: "none",
						}}
					>
						<Stack align="center" gap="xs">
							<IconUpload size={40} color="var(--mantine-color-indigo-4)" />
							<Text size="lg" fw={500} c="white">
								{t("dropFilesHere")}
							</Text>
						</Stack>
					</Box>
				)}
				{/* Header */}
				<Group
					justify="space-between"
					py="xs"
					px="md"
					style={{
						borderBottom: "1px solid var(--mantine-color-default-border)",
						flexShrink: 0,
						cursor: onHeaderPointerDown ? "grab" : undefined,
					}}
					onPointerDown={
						onHeaderPointerDown
							? (e: React.PointerEvent) => {
									// Skip drag initiation when clicking interactive elements
									const el = e.target as HTMLElement;
									if (el.closest("button, a, input, select, textarea, [role='button']")) return;
									onHeaderPointerDown(e);
								}
							: undefined
					}
				>
					<Group gap="xs" style={{ flex: 1, minWidth: 0 }}>
						{onMinimize ? (
							<Tooltip label={t("backToGraph")} position="right">
								<ActionIcon size="sm" variant="subtle" color="gray" onClick={onMinimize}>
									<IconArrowsMinimize size={16} />
								</ActionIcon>
							</Tooltip>
						) : onBack ? (
							<ActionIcon size="sm" variant="subtle" color="gray" onClick={onBack}>
								<IconArrowLeft size={16} />
							</ActionIcon>
						) : compact ? (
							<ActionIcon
								size="sm"
								variant="subtle"
								color="gray"
								onClick={() =>
									navigate({
										to: "/narrators/$narratorId",
										params: { narratorId },
										search: { from: "graph" },
									})
								}
							>
								<IconExternalLink size={16} />
							</ActionIcon>
						) : (
							<ActionIcon
								size="sm"
								variant="subtle"
								color="gray"
								onClick={() => navigate({ to: ".." })}
							>
								<IconArrowLeft size={16} />
							</ActionIcon>
						)}
						<Group gap={4} style={{ flex: 1, minWidth: 0 }} wrap="nowrap">
							{editingTitle && !isOverseerNarrator ? (
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
									onDoubleClick={isOverseerNarrator ? undefined : startEditingTitle}
									style={{
										cursor: isOverseerNarrator ? "default" : "pointer",
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
										maxWidth: 500,
									}}
									title={displayTitle}
								>
									{displayTitle}
								</Text>
							)}
							{!isOverseerNarrator && (
								<>
									<ActionIcon
										size="xs"
										variant="subtle"
										onClick={startEditingTitle}
										title={t("editTitle")}
									>
										<IconPencil size={12} />
									</ActionIcon>
									<ActionIcon
										size="xs"
										variant="subtle"
										onClick={handleGenerateTitle}
										loading={generatingTitle}
										title={t("generateTitle")}
									>
										<IconSparkles size={12} />
									</ActionIcon>
								</>
							)}
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
						{onClose && (
							<Tooltip label={t("closePanel")}>
								<ActionIcon size="sm" variant="subtle" color="red" onClick={onClose}>
									<IconX size={16} />
								</ActionIcon>
							</Tooltip>
						)}
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
									if (onClose) {
										onClose();
									} else if (onMinimize) {
										onMinimize();
									} else {
										navigate({ to: "/narrators" });
									}
								}}
							>
								{t("confirmArchive")}
							</Button>
						</Group>
					</Stack>
				</Modal>

				{/* Messages */}
				<Box pos="relative" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
					{isFetchingNextPage && (
						<Box pos="absolute" top={0} left={0} right={0} style={{ zIndex: 1 }}>
							<RenderProgress indeterminate />
						</Box>
					)}
					{/* Skeleton overlay during node resize to prevent jitter */}
					{isResizing && (
						<Box
							pos="absolute"
							top={0}
							left={0}
							right={0}
							bottom={0}
							py="sm"
							px="md"
							style={{
								zIndex: 2,
								backgroundColor: "var(--mantine-color-body)",
							}}
						>
							<Stack gap="md">
								<Group align="flex-start" gap="sm">
									<Skeleton height={28} width={28} circle />
									<Box style={{ flex: 1 }}>
										<Skeleton height={14} width={60} mb={6} radius="sm" />
										<Skeleton height={36} radius="sm" />
									</Box>
								</Group>
								<Group align="flex-start" gap="sm">
									<Skeleton height={28} width={28} circle />
									<Box style={{ flex: 1 }}>
										<Skeleton height={14} width={80} mb={6} radius="sm" />
										<Skeleton height={16} width="95%" mb={4} radius="sm" />
										<Skeleton height={16} width="88%" mb={4} radius="sm" />
										<Skeleton height={16} width="72%" mb={4} radius="sm" />
										<Skeleton height={80} width="100%" mt={8} radius="sm" />
										<Skeleton height={16} width="90%" mt={8} radius="sm" />
										<Skeleton height={16} width="60%" radius="sm" />
									</Box>
								</Group>
								<Group align="flex-start" gap="sm">
									<Skeleton height={28} width={28} circle />
									<Box style={{ flex: 1 }}>
										<Skeleton height={14} width={60} mb={6} radius="sm" />
										<Skeleton height={24} width="70%" radius="sm" />
									</Box>
								</Group>
								<Group align="flex-start" gap="sm">
									<Skeleton height={28} width={28} circle />
									<Box style={{ flex: 1 }}>
										<Skeleton height={14} width={80} mb={6} radius="sm" />
										<Skeleton height={16} width="92%" mb={4} radius="sm" />
										<Skeleton height={16} width="85%" mb={4} radius="sm" />
										<Skeleton height={16} width="45%" radius="sm" />
									</Box>
								</Group>
							</Stack>
						</Box>
					)}
					<Box h="100%" style={{ position: "relative" }}>
						<MessageSelectionCtx.Provider value={selectionCtxValue}>
							<LatestTodosToolUseIdCtx.Provider value={todosCtxValue}>
								{advancedAnim ? (
									<BlurInOnAppearProvider
										scopeKey={narratorId}
										suppress={suppressBlurIn}
										seedIds={blurInSeedIds}
									>
										<BroadMessageList
											ref={virtualListRef}
											elements={finalElements}
											elementKeys={finalKeys}
											scrollRef={viewportCallbackRef}
											contentRef={contentRef}
											shift={shifting}
										/>
									</BlurInOnAppearProvider>
								) : (
									<BroadMessageList
										ref={virtualListRef}
										elements={finalElements}
										elementKeys={finalKeys}
										scrollRef={viewportCallbackRef}
										contentRef={contentRef}
										shift={shifting}
									/>
								)}
							</LatestTodosToolUseIdCtx.Provider>
						</MessageSelectionCtx.Provider>
						<ScrollbarUserMarkers
							markers={userMessageMarkers}
							totalCount={finalElements.length}
							onJump={handleMarkerJump}
							scrollContainerRef={viewportRef}
						/>
					</Box>

					{/* Multi-select floating toolbar */}
					{selectionMode && (
						<Group
							px="md"
							py={6}
							justify="space-between"
							wrap="nowrap"
							style={{
								borderTop: "1px solid var(--mantine-color-default-border)",
								backgroundColor: "var(--mantine-color-indigo-light)",
								flexShrink: 0,
							}}
						>
							<Text size="sm" fw={500}>
								{t("selectedBlocks", { count: selectedBlockIds.size })}
							</Text>
							<Button size="compact-xs" variant="subtle" color="gray" onClick={exitSelection}>
								{tc("cancel")}
							</Button>
						</Group>
					)}

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
							transform: !isAtBottom || hasPreviousPage ? "translateY(0)" : "translateY(80px)",
							opacity: !isAtBottom || hasPreviousPage ? 1 : 0,
							transition: "transform 200ms ease, opacity 200ms ease",
							pointerEvents: !isAtBottom || hasPreviousPage ? "auto" : "none",
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
							onClick={() => (hasPreviousPage ? revealLatestMessages() : scrollToBottom(true))}
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
							<Box
								key={`${file.name}-${file.size}-${file.lastModified}-${file.type}`}
								pos="relative"
								style={{ display: "inline-block" }}
							>
								<Image
									src={imagePreviewUrls[i]}
									alt={file.name}
									radius="sm"
									h={60}
									w={60}
									fit="cover"
									style={{ cursor: "pointer" }}
									onClick={() => window.open(imagePreviewUrls[i], "_blank")}
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

				{/* Text file previews */}
				{attachedTextFiles.length > 0 && (
					<Group
						pt="xs"
						px="md"
						pb={0}
						gap={6}
						wrap="wrap"
						style={{
							borderTop:
								attachedImages.length > 0
									? undefined
									: "1px solid var(--mantine-color-default-border)",
							flexShrink: 0,
						}}
					>
						{attachedTextFiles.map((file, i) => (
							<Group
								key={`${file.name}-${file.size}-${file.lastModified}-${file.type}`}
								gap={6}
								px="xs"
								py={4}
								wrap="nowrap"
								style={{
									borderRadius: "var(--mantine-radius-sm)",
									backgroundColor: "var(--mantine-color-dark-6)",
									fontSize: "var(--mantine-font-size-xs)",
								}}
							>
								<IconFile size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
								<Text size="xs" truncate style={{ maxWidth: 160 }}>
									{file.name}
								</Text>
								<Text size="xs" c="dimmed">
									{formatFileSize(file.size)}
								</Text>
								<CloseButton
									size={16}
									iconSize={12}
									variant="transparent"
									c="dimmed"
									onClick={() => setAttachedTextFiles((prev) => prev.filter((_, j) => j !== i))}
								/>
							</Group>
						))}
					</Group>
				)}

				{/* Queued messages indicator */}
				{queuedMessages.length > 0 && (
					<Stack
						gap={0}
						style={{
							borderTop:
								attachedImages.length > 0
									? undefined
									: "1px solid var(--mantine-color-default-border)",
							flexShrink: 0,
						}}
					>
						{queuedMessages.map((msg, index) => (
							<Group
								key={msg.id}
								px="md"
								py={4}
								gap="xs"
								style={{ backgroundColor: "var(--mantine-color-blue-light)" }}
							>
								{editingQueuedId === msg.id ? (
									<>
										<Text size="xs" c="dimmed" w={16} ta="center">
											{index + 1}
										</Text>
										<Textarea
											size="xs"
											value={editingQueuedText}
											onChange={(e) => setEditingQueuedText(e.currentTarget.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter" && !e.shiftKey) {
													e.preventDefault();
													handleSaveEditQueued();
												}
												if (e.key === "Escape") handleCancelEditQueued();
											}}
											autosize
											minRows={1}
											maxRows={4}
											style={{ flex: 1 }}
											autoFocus
										/>
										<ActionIcon
											size="xs"
											variant="subtle"
											color="green"
											onClick={handleSaveEditQueued}
										>
											<IconCheck size={12} />
										</ActionIcon>
										<ActionIcon
											size="xs"
											variant="subtle"
											color="gray"
											onClick={handleCancelEditQueued}
										>
											<IconX size={12} />
										</ActionIcon>
									</>
								) : (
									<>
										<Text size="xs" c="dimmed" w={16} ta="center">
											{index + 1}
										</Text>
										{msg.creator ? (
											<UserAvatar
												username={msg.creator.username}
												avatarColor={msg.creator.avatarColor}
												avatarImageId={msg.creator.avatarImageId}
												userId={msg.creator.id}
												size={16}
												showTooltip={false}
											/>
										) : (
											<Box w={16} h={16} style={{ flexShrink: 0 }} />
										)}
										<Text size="xs" c="blue" truncate style={{ flex: 1 }}>
											{msg.text}
										</Text>
										{msg.imageCount > 0 && (
											<Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
												<IconPhoto size={14} color="var(--mantine-color-blue-5)" />
												<Text size="xs" c="blue">
													{msg.imageCount}
												</Text>
											</Group>
										)}
										<ActionIcon
											size="xs"
											variant="subtle"
											color="blue"
											onClick={() => handleStartEditQueued(msg)}
											title={tc("edit")}
										>
											<IconPencil size={12} />
										</ActionIcon>
										<CloseButton
											size="xs"
											onClick={() => handleRemoveQueued(msg.id)}
											title={t("cancelBuffer")}
										/>
									</>
								)}
							</Group>
						))}
						{queuedMessages.length > 1 && (
							<Group
								px="md"
								py={2}
								justify="flex-end"
								style={{ backgroundColor: "var(--mantine-color-blue-light)" }}
							>
								<Button
									size="compact-xs"
									variant="subtle"
									color="red"
									onClick={handleCancelAllQueued}
								>
									{t("clearAllQueued")}
								</Button>
							</Group>
						)}
					</Stack>
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
							attachedImages.length > 0 || queuedMessages.length > 0
								? undefined
								: "1px solid var(--mantine-color-default-border)",
						flexShrink: 0,
					}}
				>
					{showWorkIndicator ? (
						<UnstyledButton
							disabled={isRetrying || !activeTodo}
							onClick={async () => {
								if (isRetrying || !activeTodo || !todosToolUseId) return;
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
								scrollToVirtualTarget({
									domIds: [`tool-use-${todosToolUseId}`, `msg-${msg.id}`],
									targetIds: [todosToolUseId, msg.id],
									highlightId: msg.id,
								});
							}}
							style={{ minWidth: 0, flex: 1 }}
						>
							<Group gap={6} wrap="nowrap">
								<Loader
									size={14}
									color={
										isRetrying
											? "yellow"
											: isCompacting
												? "orange"
												: isWaiting
													? "yellow"
													: isPlanning
														? "green"
														: "blue"
									}
									style={{ flexShrink: 0 }}
								/>
								<Text
									size="xs"
									c={
										isRetrying
											? "yellow"
											: isCompacting
												? "orange"
												: isWaiting
													? "yellow"
													: isPlanning
														? "green"
														: "blue"
									}
									truncate
								>
									{isRetrying
										? retryCountdown > 0
											? t("retryingCountdown", {
													count: retryInfo?.retryCount,
													max: retryInfo?.maxRetries === -1 ? "∞" : retryInfo?.maxRetries,
													seconds: retryCountdown,
												})
											: t("retryingNow", {
													count: retryInfo?.retryCount,
													max: retryInfo?.maxRetries === -1 ? "∞" : retryInfo?.maxRetries,
												})
										: isCompacting
											? t("compacting")
											: activeTodo
												? activeTodo.content || activeTodo.activeForm
												: isWaiting
													? t("status_waiting")
													: isPlanning
														? t("planning")
														: t("thinking")}
								</Text>
								{turnElapsedText && (
									<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
										{turnElapsedText}
									</Text>
								)}
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
							{turnElapsedText && (
								<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
									· {t("lastTurnDuration", { duration: turnElapsedText })}
								</Text>
							)}
						</Group>
					)}
					{/* Model & Permission selectors */}
					<Group gap={6} wrap="nowrap" style={{ flexShrink: 1, minWidth: 0 }}>
						{/* Viewers */}
						{viewers.length > 1 && (
							<Tooltip label={`${t("viewingNow")}: ${viewers.map((v) => v.username).join(", ")}`}>
								<Avatar.Group spacing="xs">
									{viewers.slice(0, 3).map((v) => (
										<UserAvatar
											key={v.userId}
											username={v.username}
											avatarColor={v.avatarColor}
											avatarImageId={v.avatarImageId}
											userId={v.userId}
											size={22}
											showTooltip={false}
										/>
									))}
									{viewers.length > 3 && (
										<Avatar size={22} radius="xl">
											+{viewers.length - 3}
										</Avatar>
									)}
								</Avatar.Group>
							</Tooltip>
						)}
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
											{isEstimated && (
												<span style={{ opacity: 0.6, marginLeft: 4 }}>({t("estimated")})</span>
											)}
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
												{isEstimated && (
													<span style={{ opacity: 0.6, marginLeft: 4 }}>({t("estimated")})</span>
												)}
											</Menu.Label>
										)}
										<Menu.Divider />
										<Tooltip
											label={t("pruneEnabledTooltip")}
											multiline
											w={260}
											withArrow
											position="top"
										>
											<Menu.Label>
												<Switch
													size="xs"
													label={t("pruneEnabled")}
													checked={narrator.pruneEnabled ?? true}
													onChange={(e) => {
														pruneEnabledMutation.mutate({
															id: narratorId,
															pruneEnabled: e.currentTarget.checked,
														});
													}}
												/>
											</Menu.Label>
										</Tooltip>
										<Menu.Divider />
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
								<Text size="xs" c="dimmed" style={{ flexShrink: 0, cursor: "default" }}>
								</Text>
							</Tooltip>
						)}
						{/* Desktop selects */}
						{!compact && (
							<Group gap={6} wrap="nowrap" visibleFrom="sm">
								<Tooltip label={t("modelTooltip")}>
									<Menu position="top-end">
										<Menu.Target>
											<NativeSelect
												size="xs"
												data={allModels.map((m) => ({
													value: m.value,
													label:
														m.value === FOLLOW_DEFAULT_MODEL
															? t("followDefault", { model: defaultModelValue })
															: m.provider
																? `${m.provider}:${m.label}`
																: m.label,
												}))}
												value={narrator.model ?? FOLLOW_DEFAULT_MODEL}
												onChange={() => {}}
												onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
												style={{ pointerEvents: "auto" }}
											/>
										</Menu.Target>
										<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
											<ModelMenuItems
												allModels={allModels}
												currentModel={narrator.model}
												totalCostUsd={narrator.totalCostUsd}
												onSelect={(v) => modelMutation.mutate({ id: narratorId, model: v })}
											/>
										</Menu.Dropdown>
									</Menu>
								</Tooltip>
								<Tooltip label={t("permissionMode")}>
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
										<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
											<PermModeMenuItems
												currentMode={narrator.permissionMode ?? "default"}
												onSelect={(m) =>
													permModeMutation.mutate({ id: narratorId, permissionMode: m })
												}
												t={t}
											/>
										</Menu.Dropdown>
									</Menu>
								</Tooltip>
								<PathRulesPopover narratorId={narratorId} t={t} />
								{/* Reasoning Effort (Codex + Anthropic providers) */}
								{supportsReasoningEffort && (
									<Menu position="top-end">
										<Menu.Target>
											<NativeSelect
												size="xs"
												data={[
													{ value: "", label: t("reasoning_auto") },
													...reasoningEffortOptions.map((effort) => ({
														value: effort,
														label: t(`reasoning_${effort}`),
													})),
												]}
												value={narrator.reasoningEffort ?? ""}
												onChange={() => {}}
												onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
												style={{ pointerEvents: "auto" }}
											/>
										</Menu.Target>
										<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
											<ReasoningEffortMenuItems
												currentEffort={narrator.reasoningEffort}
												options={reasoningEffortOptions}
												onSelect={(e) =>
													reasoningEffortMutation.mutate({ id: narratorId, reasoningEffort: e })
												}
												t={t}
											/>
										</Menu.Dropdown>
									</Menu>
								)}
								{/* Fast Mode toggle (only for Codex-mode providers) */}
								{supportsCodexControls && (
									<Tooltip label={t("fast_mode_tooltip")}>
										<ActionIcon
											variant="subtle"
											color={narrator.fastMode ? "yellow" : "gray"}
											size="sm"
											onClick={() =>
												fastModeMutation.mutate({
													id: narratorId,
													fastMode: !narrator.fastMode,
												})
											}
										>
											<IconBolt size={16} />
										</ActionIcon>
									</Tooltip>
								)}
								{/* Relaxed Plan toggle (only visible in plan mode) */}
								{narrator.permissionMode === "plan" && (
									<Tooltip label={t("relaxed_plan_tooltip")}>
										<ActionIcon
											variant="subtle"
											color={narrator.relaxedPlan ? "teal" : "gray"}
											size="sm"
											onClick={() =>
												relaxedPlanMutation.mutate({
													id: narratorId,
													relaxedPlan: !narrator.relaxedPlan,
												})
											}
										>
											{narrator.relaxedPlan ? <IconLockOpen size={16} /> : <IconLock size={16} />}
										</ActionIcon>
									</Tooltip>
								)}
								{(onToggleTerminal || onOpenTerminalPanel) && (
									<Tooltip
										label={
											onOpenTerminalPanel
												? tt("openTerminal")
												: terminalOpen
													? tt("closeTerminal")
													: tt("openTerminal")
										}
									>
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
												onClick={onOpenTerminalPanel ?? onToggleTerminal}
											>
												<IconTerminal size={16} />
											</ActionIcon>
										</Indicator>
									</Tooltip>
								)}
							</Group>
						)}
						{/* Mobile: model & permission */}
						<Group gap={4} wrap="nowrap" {...(compact ? {} : { hiddenFrom: "sm" as const })}>
							<Tooltip label={t("modelTooltip")}>
								<Menu position="bottom-end" withinPortal>
									<Menu.Target>
										<ActionIcon variant="subtle" color="gray" size="sm">
											<Text size="xs" fw={600}>
												{(() => {
													if (narrator.model === FOLLOW_DEFAULT_MODEL || !narrator.model)
														return "D";
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
							</Tooltip>
							<Tooltip label={t("permissionMode")}>
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
											onSelect={(m) =>
												permModeMutation.mutate({ id: narratorId, permissionMode: m })
											}
											t={t}
										/>
									</Menu.Dropdown>
								</Menu>
							</Tooltip>
							<PathRulesPopover narratorId={narratorId} t={t} />
							{/* Reasoning Effort (Codex + Anthropic providers) - Mobile */}
							{supportsReasoningEffort && (
								<Menu position="bottom-end" withinPortal>
									<Menu.Target>
										<ActionIcon variant="subtle" color="gray" size="sm">
											<Text size="xs" fw={600}>
												{(() => {
													const effortMap = {
														none: "O",
														low: "L",
														medium: "M",
														high: "H",
														xhigh: "X",
													};
													return (
														effortMap[narrator.reasoningEffort as keyof typeof effortMap] ?? "A"
													);
												})()}
											</Text>
										</ActionIcon>
									</Menu.Target>
									<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
										<ReasoningEffortMenuItems
											currentEffort={narrator.reasoningEffort}
											options={reasoningEffortOptions}
											onSelect={(e) =>
												reasoningEffortMutation.mutate({ id: narratorId, reasoningEffort: e })
											}
											t={t}
										/>
									</Menu.Dropdown>
								</Menu>
							)}
							{/* Fast Mode toggle (only for Codex-mode providers) - Mobile */}
							{supportsCodexControls && (
								<Tooltip label={t("fast_mode_tooltip")}>
									<ActionIcon
										variant="subtle"
										color={narrator.fastMode ? "yellow" : "gray"}
										size="sm"
										onClick={() =>
											fastModeMutation.mutate({
												id: narratorId,
												fastMode: !narrator.fastMode,
											})
										}
									>
										<IconBolt size={16} />
									</ActionIcon>
								</Tooltip>
							)}
							{/* Relaxed Plan toggle (compact layout, only in plan mode) */}
							{narrator.permissionMode === "plan" && (
								<Tooltip label={t("relaxed_plan_tooltip")}>
									<ActionIcon
										variant="subtle"
										color={narrator.relaxedPlan ? "teal" : "gray"}
										size="sm"
										onClick={() =>
											relaxedPlanMutation.mutate({
												id: narratorId,
												relaxedPlan: !narrator.relaxedPlan,
											})
										}
									>
										{narrator.relaxedPlan ? <IconLockOpen size={16} /> : <IconLock size={16} />}
									</ActionIcon>
								</Tooltip>
							)}
							{(onToggleTerminal || onOpenTerminalPanel) && (
								<Tooltip
									label={
										onOpenTerminalPanel
											? tt("openTerminal")
											: terminalOpen
												? tt("closeTerminal")
												: tt("openTerminal")
									}
								>
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
											onClick={onOpenTerminalPanel ?? onToggleTerminal}
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
				{isChapterMerged ? (
					<Box
						px="md"
						py="sm"
						style={{
							flexShrink: 0,
							backgroundColor: "var(--mantine-color-dark-6)",
							opacity: 0.7,
						}}
					>
						<Text size="sm" c="dimmed" ta="center">
							{t("chapterMergedHint")}
						</Text>
					</Box>
				) : (
					<Box px="md" pb="xs" style={{ flexShrink: 0 }}>
						<input
							ref={fileInputRef}
							type="file"
							multiple
							style={{ display: "none" }}
							onChange={(e) => {
								if (e.target.files) {
									const files = Array.from(e.target.files);
									const imageFiles: File[] = [];
									const textFileList: File[] = [];
									const unsupported: string[] = [];
									for (const f of files) {
										if (ACCEPTED_TYPES.includes(f.type)) {
											imageFiles.push(f);
										} else if (isTextFile(f.name)) {
											textFileList.push(f);
										} else {
											unsupported.push(f.name);
										}
									}
									if (unsupported.length > 0) {
										notifications.show({
											title: t("unsupportedFileType"),
											message: unsupported.join(", "),
											color: "yellow",
										});
									}
									if (imageFiles.length > 0) addImages(imageFiles);
									if (textFileList.length > 0) addTextFiles(textFileList);
									e.target.value = "";
								}
							}}
						/>
						<Group gap="xs" align="end" wrap="nowrap">
							<Tooltip label={t("attachFile")}>
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
								{matchedCommand && (
									<CommandParamHelper
										command={matchedCommand}
										input={input}
										visible={!commandPopoverVisible}
									/>
								)}
								<Textarea
									ref={textareaRef}
									placeholder={t("sendPlaceholder")}
									value={input}
									onChange={(e) => {
										setInput(e.currentTarget.value);
										inputHistory.reset();
									}}
									onKeyDown={handleKeyDown}
									onPaste={handlePaste}
									autosize
									minRows={1}
									maxRows={6}
								/>
							</Box>
							{(() => {
								const hasInput = !!input.trim();
								const hasAttachments = attachedImages.length > 0 || attachedTextFiles.length > 0;
								const showInterrupt = isActive && !hasInput && !hasAttachments;
								const showRetry =
									!showInterrupt && !hasInput && !hasAttachments && canRetryLastUserMessage;
								const showContinue =
									!showInterrupt && !hasInput && !hasAttachments && canContinueNarrator;
								if (showInterrupt) {
									return (
										<Button
											key="interrupt"
											ref={interruptBtnRef}
											color="red"
											variant="light"
											onMouseDown={startInterruptPress}
											onMouseUp={handleInterruptMouseUp}
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
											<span style={{ position: "relative" }}>
												{queuedMessages.length > 0 ? t("interruptCutInLine") : t("interrupt")}
											</span>
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
								if (showContinue) {
									return (
										<Button key="continue" onClick={handleContinue}>
											{t("continue")}
										</Button>
									);
								}
								return (
									<Button key="send" onClick={handleSend} disabled={!hasInput && !hasAttachments}>
										{isActive
											? queuedMessages.length > 0
												? `${t("queue")} (${queuedMessages.length})`
												: t("queue")
											: tc("send")}
									</Button>
								);
							})()}
						</Group>
					</Box>
				)}
			</Stack>
		</ContentViewerEnvironmentProvider>
	);
}
