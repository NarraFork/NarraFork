import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Group,
	Modal,
	NumberInput,
	Paper,
	Select,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { DEFAULT_CONTEXT_THRESHOLDS } from "@shared/context-thresholds";
import { stripErrorDisplayPrefix } from "@shared/retry-rule-keyword";
import {
	IconAlertTriangle,
	IconEye,
	IconHandStop,
	IconPencilCheck,
	IconPlus,
	IconShield,
	IconShieldOff,
	IconTrash,
} from "@tabler/icons-react";
import { type UseMutationResult, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	AutoContinuationMode,
	DangerReflectionLevel,
	DefaultNarratorVisibility,
	DefaultNarratorWriteAudience,
} from "../../hooks/useInstanceSettings";
import { usePlatform, useSettingsFeatureCapability } from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import type {
	CommandBlacklistRuleInput,
	CommandWhitelistRuleInput,
	DirectoryBlacklistRuleInput,
	DirectoryWhitelistRuleInput,
	PathFlavor,
} from "../../lib/api/types";
import { PermissionRuleEditor } from "../permissions/PermissionRuleEditor";

// biome-ignore lint/suspicious/noExplicitAny: dynamic prefs type
type AnyPrefs = any;
// biome-ignore lint/suspicious/noExplicitAny: mutation hook type
type AnyMutation = UseMutationResult<any, any, any, any>;

export interface AgentSectionProps {
	permissionMode: string;
	setPermissionMode: (v: string) => void;
	maxTurns: number;
	setMaxTurns: (v: number) => void;
	legacyEncoding: boolean;
	setLegacyEncoding: (v: boolean) => void;
	freshShellEnv: boolean;
	setFreshShellEnv: (v: boolean) => void;
	translateReasoning: boolean;
	setTranslateReasoning: (v: boolean) => void;
	requestDumpEnabled: boolean;
	setRequestDumpEnabled: (v: boolean) => void;
	requestDumpErrorsOnly: boolean;
	setRequestDumpErrorsOnly: (v: boolean) => void;
	defaultNarratorVisibility: DefaultNarratorVisibility;
	setDefaultNarratorVisibility: (v: DefaultNarratorVisibility) => void;
	defaultNarratorWriteAudience: DefaultNarratorWriteAudience;
	setDefaultNarratorWriteAudience: (v: DefaultNarratorWriteAudience) => void;
	defaultStartInPlanMode: boolean;
	setDefaultStartInPlanMode: (v: boolean) => void;
	defaultRelaxedPlan: boolean;
	setDefaultRelaxedPlan: (v: boolean) => void;
	planModeAllowInlinePlan: boolean;
	setPlanModeAllowInlinePlan: (v: boolean) => void;
	planReflectionAutoApprove: boolean;
	setPlanReflectionAutoApprove: (v: boolean) => void;
	planReflectionAllowAutoCompact: boolean;
	setPlanReflectionAllowAutoCompact: (v: boolean) => void;
	questionReflectionEnabled: boolean;
	setQuestionReflectionEnabled: (v: boolean) => void;
	questionReflectionTimeoutMs: number;
	setQuestionReflectionTimeoutMs: (v: number) => void;
	dangerReflectionLevel: DangerReflectionLevel;
	setDangerReflectionLevel: (v: DangerReflectionLevel) => void;
	dangerReflectionEnabled: boolean;
	setDangerReflectionEnabled: (v: boolean) => void;
	dangerSkipReadOnlyConfirmations: boolean;
	setDangerSkipReadOnlyConfirmations: (v: boolean) => void;
	autoContinuationMode: AutoContinuationMode;
	setAutoContinuationMode: (v: AutoContinuationMode) => void;
	maxTransientRetries: number;
	setMaxTransientRetries: (v: number) => void;
	silentToolCallThreshold: number;
	setSilentToolCallThreshold: (v: number) => void;
	pipelineUnusedToolCallThreshold: number;
	setPipelineUnusedToolCallThreshold: (v: number) => void;
	behaviorFenceInterval: number;
	setBehaviorFenceInterval: (v: number) => void;
	tasksReminderInterval: number;
	setTasksReminderInterval: (v: number) => void;
	behaviorFenceAttachTasks: boolean;
	setBehaviorFenceAttachTasks: (v: boolean) => void;
	retryBackoffCeilMs: number;
	setRetryBackoffCeilMs: (v: number) => void;
	firstTokenTimeoutMs: number;
	setFirstTokenTimeoutMs: (v: number) => void;
	customRetryRules: Array<{
		id: string;
		domain?: string;
		statusCode?: number;
		keyword?: string;
		enabled?: boolean;
		note?: string;
	}>;
	setCustomRetryRules: (
		v: Array<{
			id: string;
			domain?: string;
			statusCode?: number;
			keyword?: string;
			enabled?: boolean;
			note?: string;
		}>,
	) => void;
	contextThresholds: {
		standard: { compactStart: number };
		large: { compactStart: number };
	};
	setContextThresholds: (v: {
		standard: { compactStart: number };
		large: { compactStart: number };
	}) => void;
	autoCompactKeepPairs: number;
	setAutoCompactKeepPairs: (v: number) => void;
	queueDuringCompaction: boolean;
	setQueueDuringCompaction: (v: boolean) => void;
	globalWhitelistDirs: DirectoryWhitelistRuleInput[];
	setGlobalWhitelistDirs: (v: DirectoryWhitelistRuleInput[]) => void;
	globalBlacklistDirs: DirectoryBlacklistRuleInput[];
	setGlobalBlacklistDirs: (v: DirectoryBlacklistRuleInput[]) => void;
	globalCommandWhitelist: CommandWhitelistRuleInput[];
	setGlobalCommandWhitelist: (v: CommandWhitelistRuleInput[]) => void;
	globalCommandBlacklist: CommandBlacklistRuleInput[];
	setGlobalCommandBlacklist: (v: CommandBlacklistRuleInput[]) => void;
	userPrefs: AnyPrefs;
	updateUserPref: AnyMutation;
}

export function AgentSection(props: AgentSectionProps) {
	const { t } = useTranslation("settings");
	const { t: tn } = useTranslation("narrator");
	const settingsFeatureCapability = useSettingsFeatureCapability();
	const platform = usePlatform();
	const serverPathFlavor: PathFlavor = platform === "windows" ? "windows" : "posix";
	const { data: permissionDevices = [] } = useQuery({
		queryKey: ["permission-rule-devices"],
		queryFn: api.listDevices,
		staleTime: 30_000,
	});
	const [dumpWarningOpen, setDumpWarningOpen] = useState(false);

	const handleRequestDumpToggle = (checked: boolean) => {
		if (checked && !props.requestDumpEnabled) {
			setDumpWarningOpen(true);
			return;
		}
		props.setRequestDumpEnabled(checked);
	};

	const confirmRequestDump = () => {
		props.setRequestDumpEnabled(true);
		setDumpWarningOpen(false);
	};

	return (
		<Stack>
			{/* Behavior */}
			<Select
				label={t("permissionMode")}
				data={[
					{ value: "default", label: tn("perm_default") },
					{ value: "acceptEdits", label: tn("perm_acceptEdits") },
					{ value: "bypassPermissions", label: tn("perm_bypassPermissions") },
					{ value: "readOnly", label: tn("perm_readOnly") },
					{ value: "dontAsk", label: tn("perm_dontAsk") },
				]}
				leftSection={
					props.permissionMode === "default" ? (
						<IconShield size={14} />
					) : props.permissionMode === "acceptEdits" ? (
						<IconPencilCheck size={14} />
					) : props.permissionMode === "bypassPermissions" ? (
						<IconShieldOff size={14} />
					) : props.permissionMode === "readOnly" ? (
						<IconEye size={14} />
					) : props.permissionMode === "dontAsk" ? (
						<IconHandStop size={14} />
					) : (
						<IconShield size={14} />
					)
				}
				renderOption={({ option, checked }) => {
					const icons: Record<string, React.ReactNode> = {
						default: <IconShield size={14} />,
						acceptEdits: <IconPencilCheck size={14} />,
						bypassPermissions: <IconShieldOff size={14} />,
						readOnly: <IconEye size={14} />,
						dontAsk: <IconHandStop size={14} />,
					};
					return (
						<Group gap="xs" wrap="nowrap">
							{icons[option.value] ?? <IconShield size={14} />}
							<Text size="sm" fw={checked ? 600 : 400}>
								{option.label}
							</Text>
						</Group>
					);
				}}
				value={props.permissionMode}
				onChange={(v) => props.setPermissionMode(v ?? "default")}
			/>
			<NumberInput
				label={t("maxTurns")}
				description={t("maxTurnsDesc")}
				value={props.maxTurns}
				onChange={(v) => props.setMaxTurns(typeof v === "number" ? v : 1000)}
				min={1}
				max={1000}
			/>
			<Switch
				label={t("legacyEncoding")}
				description={t("legacyEncodingDesc")}
				checked={props.legacyEncoding}
				onChange={(e) => props.setLegacyEncoding(e.currentTarget.checked)}
			/>
			<Switch
				label={t("freshShellEnv")}
				description={t("freshShellEnvDesc")}
				checked={props.freshShellEnv}
				onChange={(e) => props.setFreshShellEnv(e.currentTarget.checked)}
			/>
			<Switch
				label={t("translateReasoning")}
				description={t("translateReasoningDesc")}
				checked={props.translateReasoning}
				onChange={(e) => props.setTranslateReasoning(e.currentTarget.checked)}
			/>
			<Stack id="request-dump-enabled" gap={4}>
				<Switch
					label={t("requestDumpEnabled")}
					description={t("requestDumpEnabledDesc")}
					checked={props.requestDumpEnabled}
					onChange={(e) => handleRequestDumpToggle(e.currentTarget.checked)}
				/>
				<Switch
					label={t("requestDumpErrorsOnly")}
					description={t("requestDumpErrorsOnlyDesc")}
					checked={props.requestDumpErrorsOnly}
					disabled={!props.requestDumpEnabled}
					onChange={(e) => props.setRequestDumpErrorsOnly(e.currentTarget.checked)}
				/>
				<Modal
					opened={dumpWarningOpen}
					onClose={() => setDumpWarningOpen(false)}
					title={t("requestDumpWarningTitle")}
					centered
				>
					<Stack>
						<Alert color="orange" icon={<IconAlertTriangle size={16} />} variant="light">
							<Text size="sm">{t("requestDumpWarningBody")}</Text>
						</Alert>
						<Group justify="flex-end">
							<Button variant="default" onClick={() => setDumpWarningOpen(false)}>
								{t("requestDumpWarningCancel")}
							</Button>
							<Button color="orange" onClick={confirmRequestDump}>
								{t("requestDumpWarningConfirm")}
							</Button>
						</Group>
					</Stack>
				</Modal>
			</Stack>
			<Select
				label={t("defaultNarratorVisibility")}
				description={t("defaultNarratorVisibilityDesc")}
				data={[
					{ value: "auto", label: t("defaultNarratorVisibilityAuto") },
					{ value: "private", label: t("defaultNarratorVisibilityPrivate") },
					{ value: "public", label: t("defaultNarratorVisibilityPublic") },
				]}
				value={props.defaultNarratorVisibility}
				allowDeselect={false}
				onChange={(v) =>
					props.setDefaultNarratorVisibility(v === "private" || v === "public" ? v : "auto")
				}
			/>
			<Select
				label={t("defaultNarratorWriteAudience")}
				description={t("defaultNarratorWriteAudienceDesc")}
				data={[
					{ value: "auto", label: t("defaultNarratorWriteAudienceAuto") },
					{ value: "owner", label: t("defaultNarratorWriteAudienceOwner") },
					{ value: "project", label: t("defaultNarratorWriteAudienceProject") },
					{ value: "public", label: t("defaultNarratorWriteAudiencePublic") },
				]}
				value={props.defaultNarratorWriteAudience}
				allowDeselect={false}
				onChange={(v) =>
					props.setDefaultNarratorWriteAudience(
						v === "owner" || v === "project" || v === "public" ? v : "auto",
					)
				}
			/>
			<Title order={5} mt="sm">
				{t("planAndApprovalSettings")}
			</Title>
			<Switch
				label={t("defaultStartInPlanMode")}
				description={t("defaultStartInPlanModeDesc")}
				checked={props.defaultStartInPlanMode}
				onChange={(e) => props.setDefaultStartInPlanMode(e.currentTarget.checked)}
			/>
			<Switch
				label={t("defaultRelaxedPlan")}
				description={t("defaultRelaxedPlanDesc")}
				checked={props.defaultRelaxedPlan}
				onChange={(e) => props.setDefaultRelaxedPlan(e.currentTarget.checked)}
			/>
			<Switch
				label={t("planModeAllowInlinePlan")}
				description={t("planModeAllowInlinePlanDesc")}
				checked={props.planModeAllowInlinePlan}
				onChange={(e) => props.setPlanModeAllowInlinePlan(e.currentTarget.checked)}
			/>
			<Switch
				label={t("planReflectionAutoApprove")}
				description={t("planReflectionAutoApproveDesc")}
				checked={props.planReflectionAutoApprove}
				onChange={(e) => props.setPlanReflectionAutoApprove(e.currentTarget.checked)}
			/>
			<Switch
				label={t("planReflectionAllowAutoCompact")}
				description={t("planReflectionAllowAutoCompactDesc")}
				checked={props.planReflectionAllowAutoCompact}
				disabled={!props.planReflectionAutoApprove}
				onChange={(e) => props.setPlanReflectionAllowAutoCompact(e.currentTarget.checked)}
			/>
			<Switch
				label={t("questionReflectionEnabled")}
				description={t("questionReflectionEnabledDesc")}
				checked={props.questionReflectionEnabled}
				onChange={(e) => props.setQuestionReflectionEnabled(e.currentTarget.checked)}
			/>
			<NumberInput
				label={t("questionReflectionTimeout")}
				description={t("questionReflectionTimeoutDesc")}
				value={props.questionReflectionTimeoutMs / 1000}
				onChange={(v) =>
					props.setQuestionReflectionTimeoutMs(
						typeof v === "number" ? Math.round(v * 1000) : 300000,
					)
				}
				min={10}
				max={3600}
				step={10}
				decimalScale={0}
				suffix="s"
			/>
			<Title order={5} mt="sm">
				{t("safetyGuardSettings")}
			</Title>
			<Select
				label={t("dangerReflectionLevel")}
				description={t("dangerReflectionLevelDesc")}
				value={props.dangerReflectionLevel}
				onChange={(value) => {
					const level = (value ?? "standard") as DangerReflectionLevel;
					props.setDangerReflectionLevel(level);
					props.setDangerReflectionEnabled(level !== "off");
				}}
				data={[
					{ value: "off", label: t("dangerReflectionLevel_off") },
					{ value: "light", label: t("dangerReflectionLevel_light") },
					{ value: "standard", label: t("dangerReflectionLevel_standard") },
					{ value: "strict", label: t("dangerReflectionLevel_strict") },
				]}
			/>
			<Switch
				label={t("dangerSkipReadOnlyConfirmations")}
				description={t("dangerSkipReadOnlyConfirmationsDesc")}
				checked={props.dangerSkipReadOnlyConfirmations}
				onChange={(e) => props.setDangerSkipReadOnlyConfirmations(e.currentTarget.checked)}
			/>
			<Select
				label={t("autoContinuationMode")}
				description={t("autoContinuationModeDesc")}
				value={props.autoContinuationMode}
				onChange={(value) => {
					props.setAutoContinuationMode((value ?? "protectedOnly") as AutoContinuationMode);
				}}
				data={[
					{ value: "always", label: t("autoContinuationMode_always") },
					{ value: "blockStop", label: t("autoContinuationMode_blockStop") },
					{ value: "protectedOnly", label: t("autoContinuationMode_protectedOnly") },
					{ value: "off", label: t("autoContinuationMode_off") },
				]}
			/>
			<NumberInput
				label={t("maxTransientRetries")}
				description={t("maxTransientRetriesDesc")}
				value={props.maxTransientRetries}
				onChange={(v) => props.setMaxTransientRetries(typeof v === "number" ? v : 10)}
				min={-1}
				max={100}
			/>
			<NumberInput
				label={t("silentToolCallThreshold")}
				description={t("silentToolCallThresholdDesc")}
				value={props.silentToolCallThreshold}
				onChange={(v) => props.setSilentToolCallThreshold(typeof v === "number" ? v : 50)}
				min={-1}
				max={1000}
				step={1}
				decimalScale={0}
			/>
			<NumberInput
				label={t("pipelineUnusedToolCallThreshold")}
				description={t("pipelineUnusedToolCallThresholdDesc")}
				value={props.pipelineUnusedToolCallThreshold}
				onChange={(v) => {
					if (typeof v !== "number") {
						props.setPipelineUnusedToolCallThreshold(10);
						return;
					}
					const next = Math.max(-1, Math.min(1000, Math.trunc(v)));
					props.setPipelineUnusedToolCallThreshold(next === 0 ? 1 : next);
				}}
				min={-1}
				max={1000}
				step={1}
				decimalScale={0}
			/>
			<NumberInput
				label={t("behaviorFenceInterval")}
				description={t("behaviorFenceIntervalDesc")}
				value={props.behaviorFenceInterval}
				onChange={(v) => {
					if (typeof v === "number") {
						const next = Math.trunc(v);
						let clamped = Math.max(-1, Math.min(1000, next));
						if (clamped >= 0 && clamped <= 4) {
							if (props.behaviorFenceInterval < clamped) {
								clamped = 5;
							} else {
								clamped = -1;
							}
						}
						props.setBehaviorFenceInterval(clamped);
					} else {
						props.setBehaviorFenceInterval(-1);
					}
				}}
				min={-1}
				max={1000}
				step={1}
				decimalScale={0}
			/>
			<NumberInput
				label={t("tasksReminderInterval")}
				description={t("tasksReminderIntervalDesc")}
				value={props.tasksReminderInterval}
				onChange={(v) => {
					if (typeof v === "number") {
						const next = Math.trunc(v);
						let clamped = Math.max(-1, Math.min(1000, next));
						if (clamped >= 0 && clamped <= 4) {
							if (props.tasksReminderInterval < clamped) {
								clamped = 5;
							} else {
								clamped = -1;
							}
						}
						props.setTasksReminderInterval(clamped);
					} else {
						props.setTasksReminderInterval(15);
					}
				}}
				min={-1}
				max={1000}
				step={1}
				decimalScale={0}
			/>
			<Switch
				label={t("behaviorFenceAttachTasks")}
				description={t("behaviorFenceAttachTasksDesc")}
				checked={props.behaviorFenceAttachTasks}
				onChange={(e) => props.setBehaviorFenceAttachTasks(e.currentTarget.checked)}
			/>
			<NumberInput
				label={t("retryBackoffCeil")}
				description={t("retryBackoffCeilDesc")}
				value={props.retryBackoffCeilMs / 1000}
				onChange={(v) =>
					props.setRetryBackoffCeilMs(typeof v === "number" ? Math.round(v * 1000) : 20000)
				}
				min={1}
				max={300}
				step={1}
				decimalScale={0}
				suffix="s"
			/>
			<NumberInput
				label={t("firstTokenTimeout")}
				description={t("firstTokenTimeoutDesc")}
				value={props.firstTokenTimeoutMs / 1000}
				onChange={(v) =>
					props.setFirstTokenTimeoutMs(typeof v === "number" ? Math.round(v * 1000) : 60000)
				}
				min={0}
				max={600}
				step={1}
				decimalScale={0}
				suffix="s"
			/>
			{/* Custom Retry Rules */}
			<Title order={5} mt="sm">
				{t("customRetryRules")}
			</Title>
			<Text size="xs" c="dimmed">
				{t("customRetryRulesDesc")}
			</Text>
			{settingsFeatureCapability.retryRules ? (
				<RetryRuleEditor rules={props.customRetryRules} onChange={props.setCustomRetryRules} />
			) : (
				<Alert color="yellow" icon={<IconAlertTriangle size={16} />} variant="light" py={6}>
					{t("customRetryRulesUnsupported")}
				</Alert>
			)}
			{/* Context Thresholds */}
			<Title order={5} mt="sm" id="contextThresholds">
				{t("contextThresholds")}
			</Title>
			<Text size="xs" c="dimmed">
				{t("contextThresholdsDesc")}
			</Text>
			<Group grow>
				<NumberInput
					label={t("autoCompactKeepPairs")}
					description={t("autoCompactKeepPairsDesc")}
					value={props.autoCompactKeepPairs}
					onChange={(v) => props.setAutoCompactKeepPairs(typeof v === "number" ? v : 2)}
					min={1}
					max={25}
					allowDecimal={false}
				/>
			</Group>
			<Switch
				label={t("queueDuringCompaction")}
				description={t("queueDuringCompactionDesc")}
				checked={props.queueDuringCompaction}
				onChange={(e) => props.setQueueDuringCompaction(e.currentTarget.checked)}
			/>
			<Text size="sm" fw={500} mt={4}>
				{t("contextThresholdsStandard")}
			</Text>
			<Group grow>
				<NumberInput
					label={t("compactStart")}
					description={t("compactStartDesc")}
					value={props.contextThresholds.standard.compactStart}
					onChange={(v) =>
						props.setContextThresholds({
							...props.contextThresholds,
							standard: {
								...props.contextThresholds.standard,
								compactStart:
									typeof v === "number" ? v : DEFAULT_CONTEXT_THRESHOLDS.standard.compactStart,
							},
						})
					}
					min={50}
					max={100}
					suffix="%"
				/>
			</Group>
			<Text size="sm" fw={500} mt={4}>
				{t("contextThresholdsLarge")}
			</Text>
			<Group grow>
				<NumberInput
					label={t("compactStart")}
					description={t("compactStartDesc")}
					value={props.contextThresholds.large.compactStart}
					onChange={(v) =>
						props.setContextThresholds({
							...props.contextThresholds,
							large: {
								...props.contextThresholds.large,
								compactStart:
									typeof v === "number" ? v : DEFAULT_CONTEXT_THRESHOLDS.large.compactStart,
							},
						})
					}
					min={10}
					max={100}
					suffix="%"
				/>
			</Group>
			{/* Directory Access Control */}
			<Title order={5} mt="sm">
				{t("globalWhitelistDirs")}
			</Title>
			<Text size="xs" c="dimmed">
				{t("globalWhitelistDirsDesc")}
			</Text>
			<PermissionRuleEditor
				rules={props.globalWhitelistDirs}
				kind="directoryWhitelist"
				devices={permissionDevices}
				serverPathFlavor={serverPathFlavor}
				emptyLabel={t("dirListEmpty")}
				placeholder={t("dirListPlaceholder")}
				onCreate={(rule) =>
					props.setGlobalWhitelistDirs([
						...props.globalWhitelistDirs,
						rule as DirectoryWhitelistRuleInput,
					])
				}
				onUpdate={(index, rule) =>
					props.setGlobalWhitelistDirs(
						props.globalWhitelistDirs.map((item, itemIndex) =>
							itemIndex === index ? (rule as DirectoryWhitelistRuleInput) : item,
						),
					)
				}
				onDelete={(index) =>
					props.setGlobalWhitelistDirs(
						props.globalWhitelistDirs.filter((_, itemIndex) => itemIndex !== index),
					)
				}
			/>
			<Title order={5} mt="sm">
				{t("globalBlacklistDirs")}
			</Title>
			<Text size="xs" c="dimmed">
				{t("globalBlacklistDirsDesc")}
			</Text>
			<PermissionRuleEditor
				rules={props.globalBlacklistDirs}
				kind="directoryBlacklist"
				devices={permissionDevices}
				serverPathFlavor={serverPathFlavor}
				emptyLabel={t("dirListEmpty")}
				placeholder={t("dirListPlaceholder")}
				onCreate={(rule) =>
					props.setGlobalBlacklistDirs([
						...props.globalBlacklistDirs,
						rule as DirectoryBlacklistRuleInput,
					])
				}
				onUpdate={(index, rule) =>
					props.setGlobalBlacklistDirs(
						props.globalBlacklistDirs.map((item, itemIndex) =>
							itemIndex === index ? (rule as DirectoryBlacklistRuleInput) : item,
						),
					)
				}
				onDelete={(index) =>
					props.setGlobalBlacklistDirs(
						props.globalBlacklistDirs.filter((_, itemIndex) => itemIndex !== index),
					)
				}
			/>
			{/* Command Access Control */}
			<Title order={5} mt="sm">
				{t("globalCommandWhitelist")}
			</Title>
			<Text size="xs" c="dimmed">
				{t("globalCommandWhitelistDesc")}
			</Text>
			<PermissionRuleEditor
				rules={props.globalCommandWhitelist}
				kind="commandWhitelist"
				devices={permissionDevices}
				serverPathFlavor={serverPathFlavor}
				emptyLabel={t("cmdListEmpty")}
				placeholder={t("cmdListPlaceholder")}
				onCreate={(rule) =>
					props.setGlobalCommandWhitelist([
						...props.globalCommandWhitelist,
						rule as CommandWhitelistRuleInput,
					])
				}
				onUpdate={(index, rule) =>
					props.setGlobalCommandWhitelist(
						props.globalCommandWhitelist.map((item, itemIndex) =>
							itemIndex === index ? (rule as CommandWhitelistRuleInput) : item,
						),
					)
				}
				onDelete={(index) =>
					props.setGlobalCommandWhitelist(
						props.globalCommandWhitelist.filter((_, itemIndex) => itemIndex !== index),
					)
				}
			/>
			<Title order={5} mt="sm">
				{t("globalCommandBlacklist")}
			</Title>
			<Text size="xs" c="dimmed">
				{t("globalCommandBlacklistDesc")}
			</Text>
			<PermissionRuleEditor
				rules={props.globalCommandBlacklist}
				kind="commandBlacklist"
				devices={permissionDevices}
				serverPathFlavor={serverPathFlavor}
				emptyLabel={t("cmdListEmpty")}
				placeholder={t("cmdListPlaceholder")}
				onCreate={(rule) =>
					props.setGlobalCommandBlacklist([
						...props.globalCommandBlacklist,
						rule as CommandBlacklistRuleInput,
					])
				}
				onUpdate={(index, rule) =>
					props.setGlobalCommandBlacklist(
						props.globalCommandBlacklist.map((item, itemIndex) =>
							itemIndex === index ? (rule as CommandBlacklistRuleInput) : item,
						),
					)
				}
				onDelete={(index) =>
					props.setGlobalCommandBlacklist(
						props.globalCommandBlacklist.filter((_, itemIndex) => itemIndex !== index),
					)
				}
			/>
		</Stack>
	);
}

type RetryRule = {
	id: string;
	domain?: string;
	statusCode?: number;
	keyword?: string;
	enabled?: boolean;
	note?: string;
};

function RetryRuleEditor({
	rules,
	onChange,
}: {
	rules: RetryRule[];
	onChange: (v: RetryRule[]) => void;
}) {
	const { t } = useTranslation("settings");
	const [domain, setDomain] = useState("");
	const [statusCode, setStatusCode] = useState<number | string>("");
	const [keyword, setKeyword] = useState("");
	const [note, setNote] = useState("");

	const handleAdd = () => {
		// Matching runs against the RAW provider message, which has no `Error: ` /
		// `[Error] ` display prefix — strip it so a keyword pasted from an error card
		// can actually fire (see shared/retry-rule-keyword.ts).
		const d = stripErrorDisplayPrefix(domain) || undefined;
		const k = stripErrorDisplayPrefix(keyword) || undefined;
		const sc = typeof statusCode === "number" ? statusCode : undefined;
		if (!d && !sc && !k) return;
		const id = Math.random().toString(36).slice(2, 10);
		onChange([
			...rules,
			{ id, domain: d, statusCode: sc, keyword: k, note: note.trim() || undefined, enabled: true },
		]);
		setDomain("");
		setStatusCode("");
		setKeyword("");
		setNote("");
	};

	const handleRemove = (id: string) => {
		onChange(rules.filter((r) => r.id !== id));
	};

	const handleToggle = (id: string) => {
		onChange(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
	};

	return (
		<Stack gap="xs">
			{rules.length === 0 && (
				<Text size="xs" c="dimmed" fs="italic">
					{t("retryRuleEmpty")}
				</Text>
			)}
			{rules.map((rule) => (
				<Paper key={rule.id} p="xs" withBorder>
					<Group gap="xs" wrap="nowrap" align="center">
						<Switch
							size="xs"
							checked={rule.enabled !== false}
							onChange={() => handleToggle(rule.id)}
							style={{ flexShrink: 0 }}
						/>
						<Group gap={4} style={{ flex: 1, minWidth: 0 }} wrap="wrap">
							{rule.domain && (
								<Badge size="xs" variant="light" color="blue">
									{t("retryRuleDomain")}: {rule.domain}
								</Badge>
							)}
							{rule.statusCode && (
								<Badge size="xs" variant="light" color="orange">
									{t("retryRuleStatusCode")}: {rule.statusCode}
								</Badge>
							)}
							{rule.keyword && (
								<Badge size="xs" variant="light" color="grape" style={{ maxWidth: 300 }}>
									<Text size="xs" truncate="end">
										{t("retryRuleKeyword")}: {rule.keyword}
									</Text>
								</Badge>
							)}
							{rule.note && (
								<Text size="xs" c="dimmed" truncate="end" style={{ maxWidth: 200 }}>
									{rule.note}
								</Text>
							)}
						</Group>
						<ActionIcon
							size="xs"
							variant="subtle"
							color="red"
							onClick={() => handleRemove(rule.id)}
						>
							<IconTrash size={14} />
						</ActionIcon>
					</Group>
				</Paper>
			))}
			<Paper p="xs" withBorder>
				<Stack gap="xs">
					<Group grow>
						<TextInput
							size="xs"
							placeholder={t("retryRuleDomainPlaceholder")}
							value={domain}
							onChange={(e) => setDomain(e.currentTarget.value)}
						/>
						<NumberInput
							size="xs"
							placeholder={t("retryRuleStatusCodePlaceholder")}
							value={statusCode}
							onChange={setStatusCode}
							min={100}
							max={599}
							allowDecimal={false}
						/>
					</Group>
					<Group grow>
						<TextInput
							size="xs"
							placeholder={t("retryRuleKeywordPlaceholder")}
							value={keyword}
							onChange={(e) => setKeyword(e.currentTarget.value)}
						/>
						<TextInput
							size="xs"
							placeholder={t("retryRuleNotePlaceholder")}
							value={note}
							onChange={(e) => setNote(e.currentTarget.value)}
						/>
					</Group>
					<ActionIcon
						variant="light"
						size="sm"
						onClick={handleAdd}
						disabled={!domain.trim() && !keyword.trim() && typeof statusCode !== "number"}
					>
						<IconPlus size={14} />
					</ActionIcon>
				</Stack>
			</Paper>
		</Stack>
	);
}
