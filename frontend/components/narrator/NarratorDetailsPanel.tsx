import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import {
	Anchor,
	Badge,
	Box,
	Button,
	Checkbox,
	CloseButton,
	Code,
	Collapse,
	Divider,
	Drawer,
	Group,
	MultiSelect,
	Paper,
	ScrollArea,
	SegmentedControl,
	Select,
	SimpleGrid,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
	IconChevronDown,
	IconChevronRight,
	IconDownload,
	IconInfoCircle,
	IconRefresh,
	IconSearch,
	IconUsers,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBrowserSessions } from "../../hooks/useBrowserSessions";
import { useChapter } from "../../hooks/useChapters";
import { useNarratorGroups } from "../../hooks/useChatGroup";
import {
	useBlacklistDirs,
	useClearBlockedSkills,
	useClearDisabledTools,
	useClearSubagentModelRestriction,
	useCmdBlacklist,
	useCmdWhitelist,
	useNarrator,
	useNarratorCustomTraits,
	useNarratorSkills,
	useNarratorUsageStats,
	useRefreshNarratorSkills,
	useUpdateBlockedSkills,
	useUpdateCwd,
	useUpdateDisabledTools,
	useUpdateReflectionOverrides,
	useUpdateSubagentModelRestriction,
	useWhitelistDirs,
} from "../../hooks/useNarrator";
import { usePermissions } from "../../hooks/usePermissions";
import { usePersistedState } from "../../hooks/usePersistedState";
import {
	useNarratorBrowserSessionsCapability,
	useNarratorContainerBrowserToolAutoEnableCapability,
} from "../../hooks/usePlatform";
import { useNarratorTerminals } from "../../hooks/useTerminals";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import type {
	ApiEntity,
	BlacklistCmd,
	BlacklistDir,
	WhitelistCmd,
	WhitelistDir,
} from "../../lib/api";
import { api } from "../../lib/api";
import { FOLLOW_DEFAULT_MODEL, NARRATOR_STATUS_COLORS } from "../../lib/constants";
import {
	SAFE_AREA_DRAWER_BODY_STYLE,
	safeAreaDrawerBodyHeight,
	safeAreaDrawerHeaderHeight,
	safeAreaDrawerHeaderPaddingTop,
} from "../../lib/safe-area";
import { DirectoryPicker } from "../common/DirectoryPicker";
import { UserAvatar } from "../UserAvatar";
import {
	type AdvancedRowInput,
	type AdvancedSessionRow,
	type BooleanOverride,
	collapsedAdvancedRows,
	type DetailsSectionId,
	isSectionOpenByDefault,
	normalizeBooleanOverride,
	resolveActivitySignal,
	resolveAdvancedSubsectionOpen,
	resolveSectionOpen,
	sectionMatches,
	sectionStorageKey,
	shouldPromoteAdvancedRow,
	shouldRenderAdvancedSubsection,
} from "./details-panel-sections";
import { localizeNarratorError } from "./error-localization";
import type { ViewerInfo } from "./useNarratorPanelWS";

export interface NarratorDetailsPanelProps {
	opened: boolean;
	onClose: () => void;
	narratorId: string;
	narrator: ApiEntity;
	viewers: ViewerInfo[];
	defaultModelValue?: string;
	planReflectionAutoApproveGlobal?: boolean;
	dangerReflectionGlobal?: boolean;
	dangerReflectionGlobalLevel?: DangerReflectionLevel;
	/** Desktop route can embed this as a resizable sidebar; other contexts keep a drawer. */
	displayMode?: "drawer" | "inline";
	/**
	 * When true (dock surface), suppress this panel's own title bar — the dock's
	 * ToolPanelShell provides the single header and the status badge is hoisted
	 * there. Only meaningful with displayMode="inline".
	 */
	chromeless?: boolean;
}

export type NarratorDetailsPanelExternalProps = Omit<
	NarratorDetailsPanelProps,
	"opened" | "onClose" | "displayMode"
>;

/**
 * Filter state, shared with every section so the ten call sites do not each have
 * to thread the query and their own match result through props.
 */
const DetailsFilterCtx = createContext<{ query: string }>({ query: "" });

/**
 * A collapsible details section.
 *
 * The header keeps the original typographic treatment, so collapsing does not
 * restyle the panel — it only adds a chevron, an optional badge, and a hit area.
 *
 * `badge` carries more weight than it looks: a collapsed section still has to
 * advertise what it holds, otherwise collapsing merely moves the findability
 * problem instead of solving it. `forceOpen` covers the two cases where the
 * remembered preference must be ignored (an active filter match, or something
 * actionable inside) and is deliberately never written back to storage, so the
 * section snaps back to the user's own choice once the condition clears.
 *
 * `searchableText` holds already-translated labels; a section that misses the
 * active filter removes itself from the tree entirely.
 */
function DetailsPanelSection({
	id,
	title,
	badge,
	badgeColor,
	forceOpen,
	searchableText,
	children,
}: {
	id: DetailsSectionId;
	title: string;
	badge?: number | null;
	badgeColor?: "yellow" | "gray" | null;
	forceOpen?: boolean;
	searchableText?: readonly string[];
	children: React.ReactNode;
}) {
	const { query } = useContext(DetailsFilterCtx);
	const [remembered, setRemembered] = usePersistedState(
		sectionStorageKey(id),
		isSectionOpenByDefault(id),
	);
	const filterActive = query.trim().length > 0;
	const matched = sectionMatches([title, ...(searchableText ?? [])], query);
	if (filterActive && !matched) return null;

	const open = resolveSectionOpen({
		remembered,
		matchedFilter: filterActive && matched,
		forceOpen,
	});
	const bodyId = `details-section-${id}`;

	return (
		<Stack gap="xs">
			<UnstyledButton
				onClick={() => setRemembered(!remembered)}
				aria-expanded={open}
				aria-controls={bodyId}
			>
				<Group gap={6} wrap="nowrap">
					{open ? (
						<IconChevronDown size={12} color="var(--mantine-color-dimmed)" />
					) : (
						<IconChevronRight size={12} color="var(--mantine-color-dimmed)" />
					)}
					<Text size="xs" fw={700} c="dimmed" tt="uppercase">
						{title}
					</Text>
					{badge != null ? (
						<Badge size="xs" variant="light" color={badgeColor ?? "gray"}>
							{badge}
						</Badge>
					) : null}
				</Group>
			</UnstyledButton>
			<Collapse expanded={open} id={bodyId}>
				<Paper withBorder p="sm" radius="md">
					<Stack gap="sm">{children}</Stack>
				</Paper>
			</Collapse>
		</Stack>
	);
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
			<Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
				{label}
			</Text>
			<Box style={{ flex: 1, minWidth: 0, textAlign: "right" }}>{value}</Box>
		</Group>
	);
}

function StatCard({
	label,
	value,
	hint,
}: {
	label: string;
	value: React.ReactNode;
	hint?: string;
}) {
	return (
		<Paper withBorder p="sm" radius="md">
			<Stack gap={4}>
				<Text size="xs" c="dimmed">
					{label}
				</Text>
				<Text fw={700} size="lg">
					{value}
				</Text>
				{hint ? (
					<Text size="xs" c="dimmed">
						{hint}
					</Text>
				) : null}
			</Stack>
		</Paper>
	);
}

// `BooleanOverride` / `normalizeBooleanOverride` moved to ./details-panel-sections,
// where the advanced-row promotion rules that depend on them are unit tested.
const DANGER_REFLECTION_LEVEL_VALUES = ["off", "light", "standard", "strict"] as const;
type DangerReflectionLevel = (typeof DANGER_REFLECTION_LEVEL_VALUES)[number];
const DANGER_REFLECTION_OVERRIDE_VALUES = [
	"inherit",
	"on",
	...DANGER_REFLECTION_LEVEL_VALUES,
] as const;
type DangerReflectionOverride = (typeof DANGER_REFLECTION_OVERRIDE_VALUES)[number];

function normalizeDangerReflectionOverride(value: unknown): DangerReflectionOverride {
	return DANGER_REFLECTION_OVERRIDE_VALUES.includes(value as DangerReflectionOverride)
		? (value as DangerReflectionOverride)
		: "inherit";
}

function resolveBooleanOverride(value: unknown, globalDefault: boolean): boolean {
	const override = normalizeBooleanOverride(value);
	if (override === "inherit") return globalDefault;
	return override === "on";
}

function resolveDangerReflectionLevel(
	override: unknown,
	globalLevel: DangerReflectionLevel,
): DangerReflectionLevel {
	const normalizedOverride = normalizeDangerReflectionOverride(override);
	if (normalizedOverride === "inherit") return globalLevel;
	if (normalizedOverride === "on") return globalLevel === "off" ? "standard" : globalLevel;
	return normalizedOverride;
}

function formatDangerReflectionLevel(level: DangerReflectionLevel, t: (key: string) => string) {
	return t(`dangerReflectionLevel_${level}`);
}

function RuleList({
	items,
	emptyLabel,
	renderItem,
}: {
	items: readonly unknown[] | undefined;
	emptyLabel: string;
	renderItem: (item: unknown, index: number) => React.ReactNode;
}) {
	if (!items?.length) {
		return (
			<Text size="sm" c="dimmed">
				{emptyLabel}
			</Text>
		);
	}

	return <Stack gap="xs">{items.map((item, index) => renderItem(item, index))}</Stack>;
}

export function NarratorDetailsPanel({
	opened,
	onClose,
	narratorId,
	narrator,
	viewers,
	defaultModelValue,
	planReflectionAutoApproveGlobal = false,
	dangerReflectionGlobal = true,
	dangerReflectionGlobalLevel,
	displayMode = "drawer",
	chromeless = false,
}: NarratorDetailsPanelProps) {
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const navigate = useNavigate();
	const { t, i18n } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const { t: tn } = useTranslation("narrators");
	const localizedErrorMessage = localizeNarratorError(
		typeof narrator?.errorMessage === "string" ? narrator.errorMessage : null,
		t,
	);

	const chapterId = narrator?.chapterId ? String(narrator.chapterId) : "";
	const parentNarratorId = narrator?.parentNarratorId ? String(narrator.parentNarratorId) : "";

	const { data: chapter } = useChapter(opened ? chapterId : "");
	const { data: parentNarrator } = useNarrator(opened ? parentNarratorId : "");
	const { data: usageStats } = useNarratorUsageStats(narratorId, true, opened);
	const { data: userPrefs } = useUserPreferences();
	const browserSessionsCapability = useNarratorBrowserSessionsCapability();
	const browserSessionsSupported = browserSessionsCapability.supported !== false;
	const browserSessionsDefaultOff = browserSessionsCapability.defaultEnabled === false;
	const browserSessionsReason = browserSessionsCapability.reason;
	const browserToolAutoEnableCapability = useNarratorContainerBrowserToolAutoEnableCapability();
	const browserToolAutoEnableDefaultOff = browserToolAutoEnableCapability?.defaultEnabled === false;
	const browserToolAutoEnableReason =
		browserToolAutoEnableCapability?.reason ?? t("details.browserToolAutoEnableDisabled");
	const { data: browserSessions } = useBrowserSessions(
		opened && browserSessionsSupported ? narratorId : "",
	);
	const { data: terminals } = useNarratorTerminals(opened ? narratorId : "");
	const { data: pendingPermissions } = usePermissions(opened ? narratorId : "");
	const { data: whitelistDirs } = useWhitelistDirs(opened ? narratorId : "");
	const { data: blacklistDirs } = useBlacklistDirs(opened ? narratorId : "");
	const { data: cmdWhitelist } = useCmdWhitelist(opened ? narratorId : "");
	const { data: cmdBlacklist } = useCmdBlacklist(opened ? narratorId : "");
	const { data: narratorSkills } = useNarratorSkills(narratorId, opened);
	// Named narrators can participate in chat groups — surface them here.
	// biome-ignore lint/suspicious/noExplicitAny: narrator is loosely typed (ApiEntity)
	const isNamed = Array.isArray((narrator as any)?.traits)
		? // biome-ignore lint/suspicious/noExplicitAny: loose
			((narrator as any).traits as string[]).includes("named")
		: false;
	// biome-ignore lint/suspicious/noExplicitAny: narrator is loosely typed (ApiEntity)
	const isKnowledgeSteward = Array.isArray((narrator as any)?.traits)
		? // biome-ignore lint/suspicious/noExplicitAny: loose
			((narrator as any).traits as string[]).includes("knowledge-steward")
		: false;
	const { data: narratorGroupsData } = useNarratorGroups(
		opened && isNamed ? narratorId : undefined,
	);
	const narratorGroups = narratorGroupsData?.groups ?? [];
	const refreshNarratorSkillsMutation = useRefreshNarratorSkills();

	const resolvedModel =
		narrator?.model && narrator.model !== FOLLOW_DEFAULT_MODEL
			? narrator.model
			: defaultModelValue || narrator?.model || t("details.notAvailable");

	const activeTerminalCount = useMemo(
		() => (terminals ?? []).filter((terminal) => terminal.status === "running").length,
		[terminals],
	);

	const enabledTools = Array.isArray(narrator?.enabledTools)
		? (narrator.enabledTools as string[])
		: [];
	const planMode = !!(
		narrator?.planMode ||
		(Array.isArray(narrator?.traits) && (narrator.traits as string[]).includes("plan"))
	);
	const planReflectionAutoApproveOverride = normalizeBooleanOverride(
		narrator?.planReflectionAutoApproveOverride,
	);
	const dangerReflectionOverride = normalizeDangerReflectionOverride(
		narrator?.dangerReflectionOverride,
	);
	const resolvedDangerReflectionGlobalLevel: DangerReflectionLevel =
		dangerReflectionGlobalLevel ?? (dangerReflectionGlobal ? "standard" : "off");
	const planReflectionAutoApproveEffective = resolveBooleanOverride(
		planReflectionAutoApproveOverride,
		planReflectionAutoApproveGlobal,
	);
	const dangerReflectionEffectiveLevel = resolveDangerReflectionLevel(
		dangerReflectionOverride,
		resolvedDangerReflectionGlobalLevel,
	);
	const [cwdValue, setCwdValue] = useState(String(narrator?.cwd ?? ""));
	const [cwdDirty, setCwdDirty] = useState(false);
	const { data: customTraits } = useNarratorCustomTraits(narratorId, opened);
	const updateSubagentModelsMutation = useUpdateSubagentModelRestriction();
	const clearSubagentModelsMutation = useClearSubagentModelRestriction();
	const updateDisabledToolsMutation = useUpdateDisabledTools();
	const clearDisabledToolsMutation = useClearDisabledTools();
	const updateBlockedSkillsMutation = useUpdateBlockedSkills();
	const clearBlockedSkillsMutation = useClearBlockedSkills();
	const updateReflectionOverridesMutation = useUpdateReflectionOverrides();
	const qc = useQueryClient();
	const updateSettingsMutation = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: (data) => {
			qc.setQueryData(["settings"], data);
		},
	});
	const updateCwdMutation = useUpdateCwd();
	const [modelPools, setModelPools] = useState<Record<string, string[]>>({
		explore: [],
		plan: [],
		general: [],
	});
	const [modelPurposes, setModelPurposes] = useState<Record<string, Record<string, string>>>({});
	const [disabledToolSelection, setDisabledToolSelection] = useState<string[]>([]);
	const [blockAllSkills, setBlockAllSkills] = useState(false);
	const [blockedSkillSelection, setBlockedSkillSelection] = useState<string[]>([]);
	const [exportFormat, setExportFormat] = useState<"markdown" | "json">("markdown");
	const [exportIncludeToolIO, setExportIncludeToolIO] = useState(true);
	// Unchecked by default: the export matches what the panel currently shows. The
	// exported file states when this left earlier history out, so the narrower
	// default cannot be mistaken for a complete archive.
	const [exportFullHistory, setExportFullHistory] = useState(false);
	const [exporting, setExporting] = useState(false);

	const modelOptions = useMemo(
		() =>
			(customTraits?.availableModels ?? []).map((item) => ({
				value: item.model,
				label: item.model,
			})),
		[customTraits?.availableModels],
	);
	const toolOptions = useMemo(
		() =>
			(customTraits?.availableTools ?? []).map((tool) => ({
				value: tool.name,
				label: `${tool.category}:${tool.name}`,
			})),
		[customTraits?.availableTools],
	);
	const skillOptions = useMemo(() => {
		const names = new Set<string>();
		for (const skill of narratorSkills?.skills ?? []) names.add(skill.name);
		for (const name of customTraits?.blockedSkills?.names ?? []) names.add(name);
		return [...names]
			.sort((a, b) => a.localeCompare(b))
			.map((name) => ({ value: name, label: name }));
	}, [narratorSkills?.skills, customTraits?.blockedSkills?.names]);
	const blockedSkillNameSet = useMemo(() => {
		const set = new Set<string>(customTraits?.blockedSkills?.names ?? []);
		return set;
	}, [customTraits?.blockedSkills?.names]);
	const allSkillsBlocked = customTraits?.blockedSkills?.all ?? false;

	useEffect(() => {
		const pools = customTraits?.subagentModelRestriction?.pools ?? {};
		setModelPools({
			explore: (pools.explore ?? []).map((entry) => entry.model),
			plan: (pools.plan ?? []).map((entry) => entry.model),
			general: (pools.general ?? []).map((entry) => entry.model),
		});
		const nextPurposes: Record<string, Record<string, string>> = {};
		for (const [type, entries] of Object.entries(pools)) {
			nextPurposes[type] = {};
			for (const entry of entries) {
				if (entry.purpose) nextPurposes[type][entry.model] = entry.purpose;
			}
		}
		setModelPurposes(nextPurposes);
		setDisabledToolSelection(customTraits?.disabledTools?.tools ?? []);
		setBlockAllSkills(customTraits?.blockedSkills?.all ?? false);
		setBlockedSkillSelection(customTraits?.blockedSkills?.names ?? []);
	}, [customTraits]);

	const formatDateTime = (value?: string | null) => {
		if (!value) return t("details.notAvailable");
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return new Intl.DateTimeFormat(i18n.language, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(date);
	};

	const formatBoolean = (value?: boolean | null) => (value ? t("details.on") : t("details.off"));

	// Fast mode is a tri-state: "inherit" resolves against the user's default at
	// request time, so report the effective value and note where it came from.
	const formatFastMode = (override?: "inherit" | "on" | "off" | null) => {
		if (override === "on") return t("details.on");
		if (override === "off") return t("details.off");
		const effective = userPrefs?.fastModeDefault ?? false;
		return t("details.fastModeInherited", {
			state: effective ? t("details.on") : t("details.off"),
		});
	};

	const formatStatNumber = (value?: number | null) =>
		value == null ? "—" : value.toLocaleString(i18n.language);

	const formatCost = (value?: number | null) => `$${Number(value ?? 0).toFixed(4)}`;

	const formatStatus = (status?: string | null) => {
		if (!status) return t("details.notAvailable");
		const key = `status_${status}`;
		const translated = t(key);
		return translated === key ? status : translated;
	};

	const formatPermissionMode = (mode?: string | null) => {
		if (!mode) return t("details.notAvailable");
		const key = `perm_${mode}`;
		const translated = t(key);
		return translated === key ? mode : translated;
	};

	const formatReasoningEffort = (effort?: string | null) => {
		if (!effort) return t("reasoning_auto");
		const key = `reasoning_${effort}`;
		const translated = t(key);
		return translated === key ? effort : translated;
	};

	const formatNarratorType = (type?: string | null) => {
		if (!type) return t("details.notAvailable");
		const key = `details.type_${type}`;
		const translated = t(key);
		return translated === key ? type : translated;
	};

	const formatInheritMode = (mode?: string | null) => {
		if (!mode) return t("details.notAvailable");
		const key = `details.inherit_${mode}`;
		const translated = t(key);
		return translated === key ? mode : translated;
	};

	const formatBackgroundStatus = (status?: string | null) => {
		if (!status) return t("details.notAvailable");
		const key = `details.backgroundStatus_${status}`;
		const translated = t(key);
		return translated === key ? status : translated;
	};

	const formatSkillSource = (source?: string | null) => {
		if (!source) return t("details.notAvailable");
		const key = `details.skillSource_${source}`;
		const translated = t(key);
		return translated === key ? source : translated;
	};

	const skillSourceColor = (source?: string | null) => {
		if (source === "workspace") return "cyan";
		if (source === "project") return "teal";
		return "violet";
	};

	useEffect(() => {
		setCwdValue(String(narrator?.cwd ?? ""));
		setCwdDirty(false);
	}, [narrator?.cwd]);

	const openChapter = () => {
		if (!chapterId) return;
		onClose();
		navigate({ to: "/chapters/$chapterId", params: { chapterId } });
	};

	const openParentNarrator = () => {
		if (!parentNarratorId) return;
		onClose();
		navigate({ to: "/narrators/$narratorId", params: { narratorId: parentNarratorId } });
	};

	const usageStatsHint = usageStats ? t("details.stats.usageHistoryIncludesSubagents") : undefined;
	const displayedCost = usageStats?.totalCost ?? Number(narrator?.totalCostUsd ?? 0);

	const handleSaveCwd = async () => {
		const nextCwd = cwdValue.trim();
		if (!nextCwd) {
			notifications.show({
				title: t("details.cwdUpdateErrorTitle"),
				message: t("details.cwdRequired"),
				color: "red",
			});
			return;
		}
		try {
			const result = await updateCwdMutation.mutateAsync({ id: narratorId, cwd: nextCwd });
			setCwdDirty(false);
			notifications.show({
				title: t("details.cwdUpdatedTitle"),
				message: result.changed ? t("details.cwdUpdated") : t("details.cwdUnchanged"),
				color: result.changed ? "teal" : "blue",
			});
		} catch (error) {
			notifications.show({
				title: t("details.cwdUpdateErrorTitle"),
				message: error instanceof Error ? error.message : t("details.cwdUpdateError"),
				color: "red",
			});
		}
	};

	const handleExport = async () => {
		if (exporting) return;
		setExporting(true);
		let objectUrl: string | null = null;
		try {
			const { blob, fileName } = await api.exportNarratorMessages(narratorId, {
				format: exportFormat,
				scope: exportFullHistory ? "full" : "visible",
				includeToolIO: exportIncludeToolIO,
				lang: i18n.language,
			});
			objectUrl = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = objectUrl;
			// The server proposes a name (title + timestamp); fall back to the id so a
			// missing or unparseable header still produces a sensible file.
			link.download =
				fileName ?? `narrafork-${narratorId}.${exportFormat === "json" ? "json" : "md"}`;
			document.body.append(link);
			link.click();
			link.remove();
			notifications.show({
				title: t("details.exportDoneTitle"),
				message: t("details.exportDone", { file: link.download }),
				color: "teal",
			});
		} catch (error) {
			notifications.show({
				title: t("details.exportErrorTitle"),
				message: error instanceof Error ? error.message : t("details.exportError"),
				color: "red",
			});
		} finally {
			if (objectUrl) URL.revokeObjectURL(objectUrl);
			setExporting(false);
		}
	};

	const handleRefreshSkills = async () => {
		try {
			await refreshNarratorSkillsMutation.mutateAsync(narratorId);
			notifications.show({
				title: t("details.skillsRefreshedTitle"),
				message: t("details.skillsRefreshed"),
				color: "teal",
			});
		} catch (error) {
			notifications.show({
				title: t("details.skillsRefreshErrorTitle"),
				message: error instanceof Error ? error.message : t("details.skillsRefreshError"),
				color: "red",
			});
		}
	};

	const handleSaveSubagentModels = async () => {
		const pools = Object.fromEntries(
			(["explore", "plan", "general"] as const)
				.map((type) => {
					const entries = (modelPools[type] ?? []).map((model) => ({
						model,
						...(modelPurposes[type]?.[model]?.trim()
							? { purpose: modelPurposes[type][model].trim() }
							: {}),
					}));
					return [type, entries] as const;
				})
				.filter(([, entries]) => entries.length > 0),
		);
		await updateSubagentModelsMutation.mutateAsync({ id: narratorId, pools });
		notifications.show({
			title: t("details.customTraitsSaved"),
			message: t("details.customTraitsSaved"),
			color: "teal",
		});
	};

	const handleClearSubagentModels = async () => {
		await clearSubagentModelsMutation.mutateAsync(narratorId);
		notifications.show({
			title: t("details.customTraitsCleared"),
			message: t("details.customTraitsCleared"),
			color: "blue",
		});
	};

	const handleSaveDisabledTools = async () => {
		await updateDisabledToolsMutation.mutateAsync({ id: narratorId, tools: disabledToolSelection });
		notifications.show({
			title: t("details.customTraitsSaved"),
			message: t("details.customTraitsSaved"),
			color: "teal",
		});
	};

	const handleClearDisabledTools = async () => {
		await clearDisabledToolsMutation.mutateAsync(narratorId);
		notifications.show({
			title: t("details.customTraitsCleared"),
			message: t("details.customTraitsCleared"),
			color: "blue",
		});
	};

	const handleSaveBlockedSkills = async () => {
		await updateBlockedSkillsMutation.mutateAsync({
			id: narratorId,
			all: blockAllSkills,
			names: blockedSkillSelection,
		});
		notifications.show({
			title: t("details.customTraitsSaved"),
			message: t("details.customTraitsSaved"),
			color: "teal",
		});
	};

	const handleClearBlockedSkills = async () => {
		await clearBlockedSkillsMutation.mutateAsync(narratorId);
		notifications.show({
			title: t("details.customTraitsCleared"),
			message: t("details.customTraitsCleared"),
			color: "blue",
		});
	};

	// ── Findability: filter, advanced disclosure, activity signal ─────────────

	const [filterQuery, setFilterQuery] = useState("");
	const filterActive = filterQuery.trim().length > 0;
	const [advancedOpen, setAdvancedOpen] = usePersistedState(
		"narrafork_details_session_advanced",
		false,
	);

	const advancedRowInput: AdvancedRowInput = {
		fastModeOverride: narrator?.fastModeOverride,
		relaxedPlan: narrator?.relaxedPlan,
		pruneEnabled: narrator?.pruneEnabled,
		planMode,
		backgroundStatus: narrator?.backgroundStatus,
		pendingModelRestore: narrator?.pendingModelRestore,
		enabledTools,
	};
	const promoted = {
		fastMode: shouldPromoteAdvancedRow("fastMode", advancedRowInput),
		relaxedPlan: shouldPromoteAdvancedRow("relaxedPlan", advancedRowInput),
		pruneEnabled: shouldPromoteAdvancedRow("pruneEnabled", advancedRowInput),
		planMode: shouldPromoteAdvancedRow("planMode", advancedRowInput),
		backgroundStatus: shouldPromoteAdvancedRow("backgroundStatus", advancedRowInput),
		pendingModelRestore: shouldPromoteAdvancedRow("pendingModelRestore", advancedRowInput),
		enabledTools: shouldPromoteAdvancedRow("enabledTools", advancedRowInput),
	};
	const collapsedAdvanced = collapsedAdvancedRows(advancedRowInput);
	const showAdvancedSubsection = shouldRenderAdvancedSubsection(advancedRowInput);

	// Session's own searchable text has to include the advanced labels, otherwise a
	// filter could never reach a row that is one disclosure deeper.
	const sessionSearchableText = [
		t("details.model"),
		t("details.permissionMode"),
		t("details.reasoningEffort"),
		t("details.planReflectionAutoApprove"),
		t("details.dangerReflection"),
		t("details.fastMode"),
		t("details.relaxedPlan"),
		t("details.pruneEnabled"),
		t("details.planMode"),
		t("details.backgroundStatus"),
		t("details.pendingModelRestore"),
		t("details.enabledTools"),
		resolvedModel,
	];
	const sessionMatchedFilter = sectionMatches(
		[t("details.session"), ...sessionSearchableText],
		filterQuery,
	);

	/**
	 * Whether the filter matched anything at all — drives only the "no results"
	 * line, since each section decides its own visibility independently.
	 *
	 * Not memoized: the inputs include freshly built arrays (`sessionSearchableText`
	 * and the skill names), so a dependency list could never stay stable and the
	 * memo would recompute every render anyway while pretending otherwise. The work
	 * is ten `includes` calls over short strings.
	 */
	const anySectionMatches =
		!filterActive ||
		(
			[
				[t("details.basic"), t("details.status"), t("details.id"), t("details.cwd")],
				[t("details.groups")],
				[t("details.skills"), ...(narratorSkills?.skills ?? []).map((s) => s.name)],
				[t("details.session"), ...sessionSearchableText],
				[t("details.export"), t("details.exportFormat"), t("details.exportAction")],
				[t("details.customTraits"), t("details.toolRestriction"), t("details.skillRestriction")],
				[t("details.relationships"), t("details.chapter"), t("details.inheritMode")],
				[t("details.activity"), t("details.viewerNames"), t("details.pendingPermissions")],
				[t("details.rules"), t("details.whitelistDirs"), t("details.cmdBlacklist")],
				[t("details.contextSummary")],
			] as Array<readonly string[]>
		).some((texts) => sectionMatches(texts, filterQuery));
	const advancedSubsectionOpen = resolveAdvancedSubsectionOpen({
		remembered: advancedOpen,
		filterActive,
		sessionMatchedFilter,
	});

	/**
	 * The advanced rows, rendered once and placed either at the top level (when
	 * explicitly configured) or inside the advanced disclosure. Keeping one
	 * definition avoids the two copies drifting apart.
	 */
	const advancedRowNodes: Record<AdvancedSessionRow, React.ReactNode> = {
		fastMode: (
			<DetailRow
				label={t("details.fastMode")}
				value={<Text size="sm">{formatFastMode(narrator?.fastModeOverride)}</Text>}
			/>
		),
		relaxedPlan: (
			<DetailRow
				label={t("details.relaxedPlan")}
				value={<Text size="sm">{formatBoolean(narrator?.relaxedPlan)}</Text>}
			/>
		),
		pruneEnabled: (
			<DetailRow
				label={t("details.pruneEnabled")}
				value={<Text size="sm">{formatBoolean(narrator?.pruneEnabled ?? false)}</Text>}
			/>
		),
		planMode: (
			<DetailRow
				label={t("details.planMode")}
				value={<Text size="sm">{formatBoolean(planMode)}</Text>}
			/>
		),
		backgroundStatus: (
			<DetailRow
				label={t("details.backgroundStatus")}
				value={<Text size="sm">{formatBackgroundStatus(narrator?.backgroundStatus)}</Text>}
			/>
		),
		pendingModelRestore: narrator?.pendingModelRestore ? (
			<DetailRow
				label={t("details.pendingModelRestore")}
				value={<Code>{String(narrator.pendingModelRestore)}</Code>}
			/>
		) : null,
		enabledTools: (
			<DetailRow
				label={t("details.enabledTools")}
				value={
					enabledTools.length ? (
						<Group justify="flex-end" gap={4}>
							{enabledTools.map((tool) => (
								<Badge key={tool} variant="outline" size="sm">
									{tool}
								</Badge>
							))}
						</Group>
					) : (
						<Text size="sm" c="dimmed">
							{t("details.none")}
						</Text>
					)
				}
			/>
		),
	};

	const activitySignal = resolveActivitySignal({
		pendingPermissionCount: pendingPermissions?.length ?? 0,
		browserSessionCount: browserSessions?.length ?? 0,
	});

	// The provider wraps the whole body so every section reads one filter value
	// instead of each call site passing it down.
	const content = (
		<DetailsFilterCtx.Provider value={{ query: filterQuery }}>
			<Stack gap="md">
				<TextInput
					size="xs"
					placeholder={t("details.filterPlaceholder")}
					leftSection={<IconSearch size={14} />}
					value={filterQuery}
					onChange={(event) => setFilterQuery(event.currentTarget.value)}
					aria-label={t("details.filterPlaceholder")}
				/>
				{/* Stat cards are the standing overview, so the filter never hides them —
			    filtering only narrows the labelled sections below. */}
				<SimpleGrid cols={2} spacing="sm">
					<StatCard
						label={t("details.stats.messages")}
						value={(narrator?.messageCount ?? 0).toLocaleString(i18n.language)}
					/>
					<StatCard
						label={t("details.stats.cost")}
						value={formatCost(displayedCost)}
						hint={usageStatsHint}
					/>
					<StatCard
						label={t("details.stats.inputTokens")}
						value={formatStatNumber(usageStats?.totalInputTokens)}
						hint={usageStatsHint}
					/>
					<StatCard
						label={t("details.stats.outputTokens")}
						value={formatStatNumber(usageStats?.totalOutputTokens)}
						hint={usageStatsHint}
					/>
					<StatCard
						label={t("details.stats.cacheReadTokens")}
						value={formatStatNumber(usageStats?.totalCacheReadTokens)}
						hint={usageStatsHint}
					/>
					<StatCard
						label={t("details.stats.viewers")}
						value={viewers.length.toLocaleString(i18n.language)}
					/>
					<StatCard
						label={t("details.stats.terminals")}
						value={activeTerminalCount.toLocaleString(i18n.language)}
					/>
					{/* Browser sessions and pending permissions used to have stat cards here,
				    duplicating the Activity section which lists each one with its url /
				    tool name. Their counts now ride on the Activity header badge, and a
				    pending permission additionally forces that section open — see
				    resolveActivitySignal. */}
				</SimpleGrid>

				<DetailsPanelSection
					id="basic"
					title={t("details.basic")}
					searchableText={[
						t("details.status"),
						t("details.id"),
						t("details.type"),
						t("details.cwd"),
						t("details.createdAt"),
						t("details.updatedAt"),
						t("details.lastMessageAt"),
						t("details.turnStartedAt"),
						String(narrator?.cwd ?? ""),
					]}
				>
					{isKnowledgeSteward ? (
						<DetailRow
							label={tn("knowledgeStewardBadge")}
							value={
								<Group gap="xs">
									<Badge color="grape" variant="light" leftSection="📚">
										{tn("knowledgeStewardBadge")}
									</Badge>
									<Anchor size="sm" onClick={() => navigate({ to: "/knowledge" })}>
										{tn("knowledgeStewardOpenBase")}
									</Anchor>
								</Group>
							}
						/>
					) : null}
					<DetailRow
						label={t("details.status")}
						value={
							<Badge color={NARRATOR_STATUS_COLORS[narrator?.status] ?? "gray"} variant="light">
								{formatStatus(narrator?.status)}
							</Badge>
						}
					/>
					<DetailRow label={t("details.id")} value={<Code>{narrator?.id || narratorId}</Code>} />
					<DetailRow
						label={t("details.type")}
						value={<Text size="sm">{formatNarratorType(narrator?.type)}</Text>}
					/>
					{narrator?.subagentType ? (
						<DetailRow
							label={t("details.subagentType")}
							value={<Badge variant="outline">{String(narrator.subagentType)}</Badge>}
						/>
					) : null}
					<Stack gap="xs">
						<Group justify="space-between" align="center" wrap="nowrap" gap="md">
							<Text size="sm" c="dimmed">
								{t("details.cwd")}
							</Text>
							{narrator?.cwd ? (
								<Tooltip label={String(narrator.cwd)} multiline>
									<Text size="xs" ff="monospace" c="dimmed" truncate maw={260}>
										{String(narrator.cwd)}
									</Text>
								</Tooltip>
							) : null}
						</Group>
						<DirectoryPicker
							value={cwdValue}
							onChange={(value) => {
								setCwdValue(value);
								setCwdDirty(value.trim() !== String(narrator?.cwd ?? "").trim());
							}}
							placeholder={t("details.cwdPlaceholder")}
							description={t("details.cwdDescription")}
							disabled={updateCwdMutation.isPending}
						/>
						<Group justify="flex-end" gap="xs">
							<Button
								variant="default"
								size="xs"
								disabled={!cwdDirty || updateCwdMutation.isPending}
								onClick={() => {
									setCwdValue(String(narrator?.cwd ?? ""));
									setCwdDirty(false);
								}}
							>
								{t("cancel")}
							</Button>
							<Button
								size="xs"
								loading={updateCwdMutation.isPending}
								disabled={!cwdDirty}
								onClick={handleSaveCwd}
							>
								{tc("save")}
							</Button>
						</Group>
					</Stack>
					<DetailRow
						label={t("details.createdAt")}
						value={<Text size="sm">{formatDateTime(narrator?.createdAt)}</Text>}
					/>
					<DetailRow
						label={t("details.updatedAt")}
						value={<Text size="sm">{formatDateTime(narrator?.updatedAt)}</Text>}
					/>
					<DetailRow
						label={t("details.lastMessageAt")}
						value={<Text size="sm">{formatDateTime(narrator?.lastMessageAt)}</Text>}
					/>
					<DetailRow
						label={t("details.turnStartedAt")}
						value={<Text size="sm">{formatDateTime(narrator?.turnStartedAt)}</Text>}
					/>
					{narrator?.apiConversationId ? (
						<DetailRow
							label={t("details.apiConversationId")}
							value={<Code>{String(narrator.apiConversationId)}</Code>}
						/>
					) : null}
					{localizedErrorMessage ? (
						<DetailRow
							label={t("details.errorMessage")}
							value={
								<Text size="sm" c="red" ta="left">
									{localizedErrorMessage}
								</Text>
							}
						/>
					) : null}
				</DetailsPanelSection>

				{isNamed ? (
					<DetailsPanelSection
						id="groups"
						title={t("details.groups")}
						badge={narratorGroups.length || null}
						searchableText={narratorGroups.map((g) => g.title || "")}
					>
						{narratorGroups.length === 0 ? (
							<Text size="sm" c="dimmed">
								{t("details.groupsEmpty")}
							</Text>
						) : (
							<Stack gap="xs">
								{narratorGroups.map((g) => (
									<Button
										key={g.id}
										variant="default"
										size="xs"
										justify="flex-start"
										leftSection={<IconUsers size={14} />}
										onClick={() => navigate({ to: "/groups/$groupId", params: { groupId: g.id } })}
									>
										{g.title || t("details.groupUntitled")}
									</Button>
								))}
							</Stack>
						)}
					</DetailsPanelSection>
				) : null}

				<DetailsPanelSection
					id="skills"
					title={t("details.skills")}
					badge={narratorSkills?.skills.length || null}
					searchableText={(narratorSkills?.skills ?? []).map((skill) => skill.name)}
				>
					<Group justify="space-between" align="flex-start" gap="sm">
						<Text size="sm" c="dimmed" style={{ flex: 1 }}>
							{t("details.skillsDescription", {
								count: narratorSkills?.skills.length ?? 0,
							})}
						</Text>
						<Button
							size="xs"
							variant="default"
							leftSection={<IconRefresh size={14} />}
							loading={refreshNarratorSkillsMutation.isPending}
							onClick={handleRefreshSkills}
						>
							{t("details.refreshSkills")}
						</Button>
					</Group>
					{narratorSkills?.skills.length ? (
						<Stack gap="xs">
							{narratorSkills.skills.map((skill) => (
								<Paper key={`${skill.source}-${skill.location}`} withBorder p="xs" radius="sm">
									<Group justify="space-between" align="flex-start" gap="xs" wrap="nowrap">
										<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
											<Group gap="xs" wrap="nowrap">
												<Text size="sm" fw={600} truncate>
													{skill.name}
												</Text>
												<Badge size="xs" variant="light" color={skillSourceColor(skill.source)}>
													{formatSkillSource(skill.source)}
												</Badge>
												{(allSkillsBlocked || blockedSkillNameSet.has(skill.name)) && (
													<Badge size="xs" variant="light" color="gray">
														{t("details.skillBlockedBadge")}
													</Badge>
												)}
											</Group>
											<Text size="xs" c="dimmed" lineClamp={2}>
												{skill.description}
											</Text>
											<Tooltip label={skill.location} multiline>
												<Text size="xs" ff="monospace" c="dimmed" truncate>
													{skill.location}
												</Text>
											</Tooltip>
										</Stack>
									</Group>
								</Paper>
							))}
						</Stack>
					) : (
						<Text size="sm" c="dimmed">
							{t("details.noSkills")}
						</Text>
					)}
					{narratorSkills?.roots.length ? (
						<>
							<Divider />
							<Stack gap={4}>
								<Text size="xs" fw={700} c="dimmed">
									{t("details.skillRoots")}
								</Text>
								{narratorSkills.roots.map((root) => (
									<Group
										key={`${root.rootKind}-${root.normalizedRootPath}`}
										justify="space-between"
										gap="xs"
										wrap="nowrap"
									>
										<Badge size="xs" variant="light" color={skillSourceColor(root.rootKind)}>
											{formatSkillSource(root.rootKind)}
										</Badge>
										<Tooltip label={root.normalizedRootPath} multiline>
											<Text size="xs" ff="monospace" truncate style={{ flex: 1 }}>
												{root.normalizedRootPath}
											</Text>
										</Tooltip>
										<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
											{t("details.skillRootScanned", {
												time: formatDateTime(root.scannedAt),
											})}
										</Text>
									</Group>
								))}
							</Stack>
						</>
					) : null}
				</DetailsPanelSection>

				<DetailsPanelSection
					id="session"
					title={t("details.session")}
					searchableText={sessionSearchableText}
				>
					<DetailRow
						label={t("details.model")}
						value={
							<Text size="sm" ff="monospace">
								{resolvedModel}
							</Text>
						}
					/>
					<DetailRow
						label={t("details.permissionMode")}
						value={<Text size="sm">{formatPermissionMode(narrator?.permissionMode)}</Text>}
					/>
					<DetailRow
						label={t("details.reasoningEffort")}
						value={<Text size="sm">{formatReasoningEffort(narrator?.reasoningEffort)}</Text>}
					/>
					{promoted.fastMode ? advancedRowNodes.fastMode : null}
					{promoted.relaxedPlan ? advancedRowNodes.relaxedPlan : null}
					<DetailRow
						label={t("details.planReflectionAutoApprove")}
						value={
							<Stack gap={4} align="stretch">
								<SegmentedControl
									size="xs"
									fullWidth
									value={planReflectionAutoApproveEffective ? "on" : "off"}
									onChange={(value) => {
										const checked = value === "on";
										const override =
											checked === planReflectionAutoApproveGlobal
												? "inherit"
												: checked
													? "on"
													: "off";
										updateReflectionOverridesMutation.mutate({
											id: narratorId,
											planReflectionAutoApproveOverride: override as BooleanOverride,
										});
									}}
									disabled={updateReflectionOverridesMutation.isPending}
									data={[
										{ value: "on", label: t("override_on") },
										{ value: "off", label: t("override_off") },
									]}
								/>
								{planReflectionAutoApproveOverride !== "inherit" && (
									<Group justify="space-between" mt={2} wrap="nowrap">
										<Anchor
											component="button"
											type="button"
											size="xs"
											c="dimmed"
											style={{ textDecoration: "underline" }}
											onClick={() =>
												updateReflectionOverridesMutation.mutate({
													id: narratorId,
													planReflectionAutoApproveOverride: "inherit",
												})
											}
										>
											{t("override_followDefault")}
										</Anchor>
										<Anchor
											component="button"
											type="button"
											size="xs"
											c="dimmed"
											style={{ textDecoration: "underline" }}
											onClick={() => {
												updateSettingsMutation.mutate({
													agent: {
														planReflectionAutoApprove: planReflectionAutoApproveEffective,
													},
												});
												updateReflectionOverridesMutation.mutate({
													id: narratorId,
													planReflectionAutoApproveOverride: "inherit",
												});
											}}
										>
											{t("override_setAsDefault")}
										</Anchor>
									</Group>
								)}
							</Stack>
						}
					/>
					<DetailRow
						label={t("details.dangerReflection")}
						value={
							<Stack gap={4} align="stretch">
								<SegmentedControl
									size="xs"
									fullWidth
									value={dangerReflectionEffectiveLevel}
									onChange={(value) => {
										const level = value as DangerReflectionLevel;
										updateReflectionOverridesMutation.mutate({
											id: narratorId,
											dangerReflectionOverride:
												level === resolvedDangerReflectionGlobalLevel ? "inherit" : level,
										});
									}}
									disabled={updateReflectionOverridesMutation.isPending}
									data={DANGER_REFLECTION_LEVEL_VALUES.map((level) => ({
										value: level,
										label: formatDangerReflectionLevel(level, t),
									}))}
								/>
								{dangerReflectionOverride !== "inherit" && (
									<Group justify="space-between" mt={2} wrap="nowrap">
										<Anchor
											component="button"
											type="button"
											size="xs"
											c="dimmed"
											style={{ textDecoration: "underline" }}
											onClick={() =>
												updateReflectionOverridesMutation.mutate({
													id: narratorId,
													dangerReflectionOverride: "inherit",
												})
											}
										>
											{t("override_followDefault")}
										</Anchor>
										<Anchor
											component="button"
											type="button"
											size="xs"
											c="dimmed"
											style={{ textDecoration: "underline" }}
											onClick={() => {
												updateSettingsMutation.mutate({
													agent: {
														dangerReflectionLevel: dangerReflectionEffectiveLevel,
														dangerReflectionEnabled: dangerReflectionEffectiveLevel !== "off",
													},
												});
												updateReflectionOverridesMutation.mutate({
													id: narratorId,
													dangerReflectionOverride: "inherit",
												});
											}}
										>
											{t("override_setAsDefault")}
										</Anchor>
									</Group>
								)}
							</Stack>
						}
					/>
					{promoted.pruneEnabled ? advancedRowNodes.pruneEnabled : null}
					{promoted.planMode ? advancedRowNodes.planMode : null}
					{promoted.backgroundStatus ? advancedRowNodes.backgroundStatus : null}
					{promoted.pendingModelRestore ? advancedRowNodes.pendingModelRestore : null}
					{promoted.enabledTools ? advancedRowNodes.enabledTools : null}
					{narrator?.backgroundResult ? (
						<DetailRow
							label={t("details.backgroundResult")}
							value={
								<Text size="sm" ta="left" style={{ whiteSpace: "pre-wrap" }}>
									{String(narrator.backgroundResult)}
								</Text>
							}
						/>
					) : null}

					{/* Everything still at its default value, tucked behind one more
				    disclosure. A filter match on the parent section opens this too,
				    otherwise searching for an advanced row would expand Session and
				    show nothing. */}
					{showAdvancedSubsection ? (
						<>
							<Divider />
							<Stack gap="xs">
								<UnstyledButton
									onClick={() => setAdvancedOpen(!advancedOpen)}
									aria-expanded={advancedSubsectionOpen}
									aria-controls="details-session-advanced"
								>
									<Group gap={6} wrap="nowrap">
										{advancedSubsectionOpen ? (
											<IconChevronDown size={12} color="var(--mantine-color-dimmed)" />
										) : (
											<IconChevronRight size={12} color="var(--mantine-color-dimmed)" />
										)}
										<Text size="xs" fw={600} c="dimmed">
											{t("details.sessionAdvanced", { count: collapsedAdvanced.length })}
										</Text>
									</Group>
								</UnstyledButton>
								<Collapse expanded={advancedSubsectionOpen} id="details-session-advanced">
									<Stack gap="sm">
										{collapsedAdvanced.map((row) => (
											<React.Fragment key={row}>{advancedRowNodes[row]}</React.Fragment>
										))}
									</Stack>
								</Collapse>
							</Stack>
						</>
					) : null}
				</DetailsPanelSection>

				<DetailsPanelSection
					id="export"
					title={t("details.export")}
					searchableText={[
						t("details.exportFormat"),
						t("details.exportFormatMarkdown"),
						t("details.exportFormatJson"),
						t("details.exportIncludeToolIO"),
						t("details.exportFullHistory"),
						t("details.exportAction"),
					]}
				>
					<Text size="xs" c="dimmed">
						{t("details.exportDescription")}
					</Text>
					<Select
						label={t("details.exportFormat")}
						data={[
							{ value: "markdown", label: t("details.exportFormatMarkdown") },
							{ value: "json", label: t("details.exportFormatJson") },
						]}
						value={exportFormat}
						onChange={(value) => setExportFormat(value === "json" ? "json" : "markdown")}
						allowDeselect={false}
						disabled={exporting}
					/>
					<Checkbox
						label={t("details.exportIncludeToolIO")}
						description={t("details.exportIncludeToolIODescription")}
						checked={exportIncludeToolIO}
						onChange={(event) => setExportIncludeToolIO(event.currentTarget.checked)}
						disabled={exporting}
					/>
					<Checkbox
						label={t("details.exportFullHistory")}
						description={t("details.exportFullHistoryDescription")}
						checked={exportFullHistory}
						onChange={(event) => setExportFullHistory(event.currentTarget.checked)}
						disabled={exporting}
					/>
					<Group justify="flex-end">
						<Button
							size="xs"
							leftSection={<IconDownload size={14} />}
							loading={exporting}
							onClick={handleExport}
						>
							{t("details.exportAction")}
						</Button>
					</Group>
				</DetailsPanelSection>

				<DetailsPanelSection
					id="customTraits"
					title={t("details.customTraits")}
					searchableText={[
						t("details.subagentModelRestriction"),
						t("details.toolRestriction"),
						t("details.skillRestriction"),
						t("details.blockAllSkills"),
						t("details.subagentType_explore"),
						t("details.subagentType_plan"),
						t("details.subagentType_general"),
					]}
				>
					<Stack gap="md">
						<Stack gap="xs">
							<Text size="sm" fw={600}>
								{t("details.subagentModelRestriction")}
							</Text>
							<Text size="xs" c="dimmed">
								{t("details.subagentModelRestrictionDesc")}
							</Text>
							{(["explore", "plan", "general"] as const).map((type) => (
								<Stack key={type} gap={6}>
									<MultiSelect
										label={t(`details.subagentType_${type}`)}
										data={modelOptions}
										searchable
										clearable
										value={modelPools[type] ?? []}
										onChange={(value) => setModelPools((old) => ({ ...old, [type]: value }))}
									/>
									{(modelPools[type] ?? []).map((model) => (
										<Textarea
											key={`${type}-${model}`}
											label={model}
											placeholder={t("details.modelPurposePlaceholder")}
											minRows={2}
											value={modelPurposes[type]?.[model] ?? ""}
											onChange={(event) =>
												setModelPurposes((old) => ({
													...old,
													[type]: { ...(old[type] ?? {}), [model]: event.currentTarget.value },
												}))
											}
										/>
									))}
								</Stack>
							))}
							<Group justify="flex-end" gap="xs">
								<Button
									variant="default"
									size="xs"
									loading={clearSubagentModelsMutation.isPending}
									onClick={handleClearSubagentModels}
								>
									{t("details.clearTrait")}
								</Button>
								<Button
									size="xs"
									loading={updateSubagentModelsMutation.isPending}
									onClick={handleSaveSubagentModels}
								>
									{tc("save")}
								</Button>
							</Group>
						</Stack>
						<Divider />
						<Stack gap="xs">
							<Text size="sm" fw={600}>
								{t("details.toolRestriction")}
							</Text>
							<Text size="xs" c="dimmed">
								{t("details.toolRestrictionDesc")}
							</Text>
							<MultiSelect
								data={toolOptions}
								searchable
								clearable
								value={disabledToolSelection}
								onChange={setDisabledToolSelection}
								placeholder={t("details.disabledToolsPlaceholder")}
							/>
							<Group justify="flex-end" gap="xs">
								<Button
									variant="default"
									size="xs"
									loading={clearDisabledToolsMutation.isPending}
									onClick={handleClearDisabledTools}
								>
									{t("details.clearTrait")}
								</Button>
								<Button
									size="xs"
									loading={updateDisabledToolsMutation.isPending}
									onClick={handleSaveDisabledTools}
								>
									{tc("save")}
								</Button>
							</Group>
						</Stack>
						<Divider />
						<Stack gap="xs">
							<Text size="sm" fw={600}>
								{t("details.skillRestriction")}
							</Text>
							<Text size="xs" c="dimmed">
								{t("details.skillRestrictionDesc")}
							</Text>
							<Switch
								size="sm"
								checked={blockAllSkills}
								onChange={(event) => setBlockAllSkills(event.currentTarget.checked)}
								label={t("details.blockAllSkills")}
							/>
							<MultiSelect
								data={skillOptions}
								searchable
								clearable
								disabled={blockAllSkills}
								value={blockedSkillSelection}
								onChange={setBlockedSkillSelection}
								placeholder={t("details.blockedSkillsPlaceholder")}
							/>
							<Group justify="flex-end" gap="xs">
								<Button
									variant="default"
									size="xs"
									loading={clearBlockedSkillsMutation.isPending}
									onClick={handleClearBlockedSkills}
								>
									{t("details.clearTrait")}
								</Button>
								<Button
									size="xs"
									loading={updateBlockedSkillsMutation.isPending}
									onClick={handleSaveBlockedSkills}
								>
									{tc("save")}
								</Button>
							</Group>
						</Stack>
					</Stack>
				</DetailsPanelSection>

				<DetailsPanelSection
					id="relationships"
					title={t("details.relationships")}
					searchableText={[
						t("details.chapter"),
						t("details.parentNarrator"),
						t("details.inheritMode"),
						t("details.forkMessageId"),
						chapter?.title ?? "",
						parentNarrator?.title ?? "",
					]}
				>
					<DetailRow
						label={t("details.chapter")}
						value={
							chapterId ? (
								<Stack gap={6} align="flex-end">
									<Text size="sm">{chapter?.title || chapterId}</Text>
									<Group gap={6} justify="flex-end">
										<Badge variant="outline">{chapterId.slice(0, 8)}</Badge>
										<Button variant="light" size="compact-xs" onClick={openChapter}>
											{t("details.openChapter")}
										</Button>
									</Group>
								</Stack>
							) : (
								<Text size="sm" c="dimmed">
									{t("details.standalone")}
								</Text>
							)
						}
					/>
					{parentNarratorId ? (
						<DetailRow
							label={t("details.parentNarrator")}
							value={
								<Stack gap={6} align="flex-end">
									<Text size="sm">{parentNarrator?.title || parentNarratorId}</Text>
									<Group gap={6} justify="flex-end">
										<Badge variant="outline">{parentNarratorId.slice(0, 8)}</Badge>
										<Button variant="light" size="compact-xs" onClick={openParentNarrator}>
											{t("details.openNarrator")}
										</Button>
									</Group>
								</Stack>
							}
						/>
					) : null}
					<DetailRow
						label={t("details.inheritMode")}
						value={<Text size="sm">{formatInheritMode(narrator?.inheritMode)}</Text>}
					/>
					<DetailRow
						label={t("details.forkMessageId")}
						value={
							narrator?.forkMessageId ? (
								<Code>{String(narrator.forkMessageId)}</Code>
							) : (
								<Text size="sm" c="dimmed">
									{t("details.none")}
								</Text>
							)
						}
					/>
				</DetailsPanelSection>

				{/* Badge + forceOpen come from resolveActivitySignal: a pending permission
			    blocks the session, so it must not be swallowed by a collapsed section
			    now that its duplicate stat card is gone. */}
				<DetailsPanelSection
					id="activity"
					title={t("details.activity")}
					badge={activitySignal.badgeCount}
					badgeColor={activitySignal.badgeColor}
					forceOpen={activitySignal.forceOpen}
					searchableText={[
						t("details.viewerNames"),
						t("details.browserSessions"),
						t("details.pendingPermissions"),
					]}
				>
					<DetailRow
						label={t("details.viewerNames")}
						value={
							viewers.length ? (
								<Stack gap={6} align="flex-end">
									{viewers.map((viewer) => (
										<Group key={viewer.userId} gap={8} wrap="nowrap">
											<Text size="sm">{viewer.username}</Text>
											<UserAvatar
												username={viewer.username}
												avatarColor={viewer.avatarColor}
												avatarImageId={viewer.avatarImageId}
												userId={viewer.userId}
												size={22}
												showTooltip={false}
											/>
										</Group>
									))}
								</Stack>
							) : (
								<Text size="sm" c="dimmed">
									{t("details.none")}
								</Text>
							)
						}
					/>
					<DetailRow
						label={t("details.browserSessions")}
						value={
							browserSessionsSupported ? (
								browserSessions?.length ? (
									<Stack gap={6} align="flex-end">
										{browserSessions.map((session) => (
											<Group key={session.id} gap={6} justify="flex-end">
												<Badge variant="outline">{session.id.slice(0, 8)}</Badge>
												<Text size="sm" ff="monospace" truncate maw={220} title={session.url}>
													{session.url}
												</Text>
											</Group>
										))}
									</Stack>
								) : (
									<Stack gap={2} align="flex-end">
										<Text size="sm" c="dimmed">
											{t("details.none")}
										</Text>
										{browserSessionsDefaultOff && browserSessionsReason && (
											<Text size="xs" c="dimmed" ta="right" maw={360}>
												{browserSessionsReason}
											</Text>
										)}
									</Stack>
								)
							) : (
								<Text size="sm" c="dimmed">
									{t("details.browserSessionsUnsupported")}
								</Text>
							)
						}
					/>

					{browserToolAutoEnableDefaultOff && (
						<DetailRow
							label={t("details.browserToolAutoEnable")}
							value={
								<Text size="sm" c="dimmed">
									{browserToolAutoEnableReason}
								</Text>
							}
						/>
					)}

					<DetailRow
						label={t("details.pendingPermissions")}
						value={
							pendingPermissions?.length ? (
								<Stack gap={6} align="flex-end">
									{pendingPermissions.map((permission) => (
										<Group key={permission.id} gap={6} justify="flex-end">
											<Badge color="yellow" variant="light">
												{permission.toolName}
											</Badge>
											<Badge variant="outline">{permission.id.slice(0, 8)}</Badge>
										</Group>
									))}
								</Stack>
							) : (
								<Text size="sm" c="dimmed">
									{t("details.none")}
								</Text>
							)
						}
					/>
				</DetailsPanelSection>

				<DetailsPanelSection
					id="rules"
					title={t("details.rules")}
					badge={
						(whitelistDirs?.length ?? 0) +
							(blacklistDirs?.length ?? 0) +
							(cmdWhitelist?.length ?? 0) +
							(cmdBlacklist?.length ?? 0) || null
					}
					searchableText={[
						t("details.whitelistDirs"),
						t("details.blacklistDirs"),
						t("details.cmdWhitelist"),
						t("details.cmdBlacklist"),
					]}
				>
					<Stack gap="xs">
						<Text size="sm" fw={600}>
							{t("details.whitelistDirs")} ·{" "}
							{(whitelistDirs?.length ?? 0).toLocaleString(i18n.language)}
						</Text>
						<RuleList
							items={whitelistDirs}
							emptyLabel={t("details.emptyRules")}
							renderItem={(item) => {
								const rule = item as WhitelistDir;
								return (
									<Paper key={rule.id} withBorder p="xs" radius="sm">
										<Group justify="space-between" align="flex-start" wrap="nowrap">
											<Box style={{ flex: 1, minWidth: 0 }}>
												<Text size="sm" ff="monospace" truncate title={rule.path}>
													{rule.path}
												</Text>
											</Box>
											<Group gap={4}>
												<Badge variant="outline">{t(`whitelist_access_${rule.accessLevel}`)}</Badge>
												{!rule.enabled ? <Badge color="gray">{t("details.off")}</Badge> : null}
											</Group>
										</Group>
									</Paper>
								);
							}}
						/>
					</Stack>

					<Divider />

					<Stack gap="xs">
						<Text size="sm" fw={600}>
							{t("details.blacklistDirs")} ·{" "}
							{(blacklistDirs?.length ?? 0).toLocaleString(i18n.language)}
						</Text>
						<RuleList
							items={blacklistDirs}
							emptyLabel={t("details.emptyRules")}
							renderItem={(item) => {
								const rule = item as BlacklistDir;
								return (
									<Paper key={rule.id} withBorder p="xs" radius="sm">
										<Group justify="space-between" align="flex-start" wrap="nowrap">
											<Box style={{ flex: 1, minWidth: 0 }}>
												<Text size="sm" ff="monospace" truncate title={rule.path}>
													{rule.path}
												</Text>
											</Box>
											<Group gap={4}>
												<Badge variant="outline">{t(`blacklist_deny_${rule.denyLevel}`)}</Badge>
												{!rule.enabled ? <Badge color="gray">{t("details.off")}</Badge> : null}
											</Group>
										</Group>
									</Paper>
								);
							}}
						/>
					</Stack>

					<Divider />

					<Stack gap="xs">
						<Text size="sm" fw={600}>
							{t("details.cmdWhitelist")} ·{" "}
							{(cmdWhitelist?.length ?? 0).toLocaleString(i18n.language)}
						</Text>
						<RuleList
							items={cmdWhitelist}
							emptyLabel={t("details.emptyRules")}
							renderItem={(item) => {
								const rule = item as WhitelistCmd;
								return (
									<Paper key={rule.id} withBorder p="xs" radius="sm">
										<Group justify="space-between" align="flex-start" wrap="nowrap">
											<Text size="sm" ff="monospace" style={{ flex: 1, minWidth: 0 }}>
												{rule.pattern}
											</Text>
											{!rule.enabled ? <Badge color="gray">{t("details.off")}</Badge> : null}
										</Group>
									</Paper>
								);
							}}
						/>
					</Stack>

					<Divider />

					<Stack gap="xs">
						<Text size="sm" fw={600}>
							{t("details.cmdBlacklist")} ·{" "}
							{(cmdBlacklist?.length ?? 0).toLocaleString(i18n.language)}
						</Text>
						<RuleList
							items={cmdBlacklist}
							emptyLabel={t("details.emptyRules")}
							renderItem={(item) => {
								const rule = item as BlacklistCmd;
								return (
									<Paper key={rule.id} withBorder p="xs" radius="sm">
										<Stack gap={6}>
											<Group justify="space-between" align="flex-start" wrap="nowrap">
												<Text size="sm" ff="monospace" style={{ flex: 1, minWidth: 0 }}>
													{rule.pattern}
												</Text>
												{!rule.enabled ? <Badge color="gray">{t("details.off")}</Badge> : null}
											</Group>
											{rule.denyPrompt ? (
												<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
													{rule.denyPrompt}
												</Text>
											) : null}
										</Stack>
									</Paper>
								);
							}}
						/>
					</Stack>
				</DetailsPanelSection>

				{narrator?.contextSummary ? (
					<DetailsPanelSection
						id="contextSummary"
						title={t("details.contextSummary")}
						searchableText={[String(narrator.contextSummary)]}
					>
						<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
							{String(narrator.contextSummary)}
						</Text>
					</DetailsPanelSection>
				) : null}

				{/* Without this, a filter that matches nothing leaves a blank panel that
			    reads as broken rather than as "no results". */}
				{filterActive && !anySectionMatches ? (
					<Text size="sm" c="dimmed" ta="center" py="md">
						{t("details.filterNoResults", { query: filterQuery.trim() })}
					</Text>
				) : null}
			</Stack>
		</DetailsFilterCtx.Provider>
	);

	// Drawer header: title + status badge, with the standard right-side × close
	// (consistent with the terminal / spec mobile drawers). No left-arrow back.
	// Header metrics match the narrator header: py=8 px=16, size="sm" controls,
	// ~45px total, so every panel header aligns.
	const title = (
		<Group gap="xs" wrap="nowrap" style={{ flex: 1 }}>
			<IconInfoCircle size={16} color="var(--mantine-color-dimmed)" />
			<Text size="sm" fw={600} truncate style={{ flex: 1 }}>
				{t("details.title")}
			</Text>
			<Badge size="xs" color={NARRATOR_STATUS_COLORS[narrator?.status] ?? "gray"} variant="light">
				{formatStatus(narrator?.status)}
			</Badge>
		</Group>
	);

	if (displayMode === "drawer" || isMobile) {
		return (
			<Drawer
				opened={opened}
				onClose={onClose}
				position="right"
				size={isMobile ? "100%" : 480}
				title={title}
				closeButtonProps={{ size: "sm" }}
				styles={{
					header: {
						minHeight: safeAreaDrawerHeaderHeight(45),
						paddingTop: safeAreaDrawerHeaderPaddingTop(8),
						paddingBottom: 8,
						paddingLeft: 16,
						paddingRight: 16,
						borderBottom: "1px solid var(--mantine-color-default-border)",
					},
					body: {
						height: safeAreaDrawerBodyHeight(45),
						padding: 0,
						...SAFE_AREA_DRAWER_BODY_STYLE,
					},
				}}
			>
				<ScrollArea h="100%" p="md">
					{content}
				</ScrollArea>
			</Drawer>
		);
	}

	return (
		<Box
			w="100%"
			h="100%"
			style={{
				// In the dock the ToolPanelShell owns the chrome (border, header);
				// only draw our own border/background as a standalone sidebar.
				borderLeft: chromeless ? undefined : "1px solid var(--mantine-color-default-border)",
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
				background: chromeless ? undefined : "var(--mantine-color-body)",
			}}
		>
			{!chromeless && (
				<Group
					gap="xs"
					px="sm"
					py={8}
					wrap="nowrap"
					style={{
						flexShrink: 0,
						borderBottom: "1px solid var(--mantine-color-default-border)",
					}}
				>
					<IconInfoCircle size={16} color="var(--mantine-color-dimmed)" />
					<Text size="sm" fw={600} style={{ flex: 1 }} truncate>
						{t("details.title")}
					</Text>
					<Badge
						size="xs"
						color={NARRATOR_STATUS_COLORS[narrator?.status] ?? "gray"}
						variant="light"
					>
						{formatStatus(narrator?.status)}
					</Badge>
					<CloseButton size="sm" onClick={onClose} />
				</Group>
			)}
			<ScrollArea style={{ flex: 1, minHeight: 0 }} p="sm">
				{content}
			</ScrollArea>
		</Box>
	);
}
