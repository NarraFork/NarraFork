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
import type { UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DangerReflectionLevel } from "../../hooks/useInstanceSettings";
import { useSettingsFeatureCapability } from "../../hooks/usePlatform";
import { CmdListEditor } from "../common/CmdListEditor";
import { DirListEditor } from "../common/DirListEditor";

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
	expandReasoning: boolean;
	setExpandReasoning: (v: boolean) => void;
	defaultStartInPlanMode: boolean;
	setDefaultStartInPlanMode: (v: boolean) => void;
	defaultRelaxedPlan: boolean;
	setDefaultRelaxedPlan: (v: boolean) => void;
	defaultPruneEnabled: boolean;
	setDefaultPruneEnabled: (v: boolean) => void;
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
	maxTransientRetries: number;
	setMaxTransientRetries: (v: number) => void;
	silentToolCallThreshold: number;
	setSilentToolCallThreshold: (v: number) => void;
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
		standard: { pruneStart: number; compactStart: number };
		large: { pruneStart: number; compactStart: number };
	};
	setContextThresholds: (v: {
		standard: { pruneStart: number; compactStart: number };
		large: { pruneStart: number; compactStart: number };
	}) => void;
	autoCompactKeepPairs: number;
	setAutoCompactKeepPairs: (v: number) => void;
	autoCompactPruneThreshold: number;
	setAutoCompactPruneThreshold: (v: number) => void;
	minPruneRatio: number;
	setMinPruneRatio: (v: number) => void;
	globalWhitelistDirs: Array<{ path: string; accessLevel: string; enabled?: boolean }>;
	setGlobalWhitelistDirs: (
		v: Array<{ path: string; accessLevel: string; enabled?: boolean }>,
	) => void;
	globalBlacklistDirs: Array<{ path: string; denyLevel: string; enabled?: boolean }>;
	setGlobalBlacklistDirs: (
		v: Array<{ path: string; denyLevel: string; enabled?: boolean }>,
	) => void;
	globalCommandWhitelist: Array<{ pattern: string; enabled?: boolean }>;
	setGlobalCommandWhitelist: (v: Array<{ pattern: string; enabled?: boolean }>) => void;
	globalCommandBlacklist: Array<{
		pattern: string;
		denyPrompt?: string;
		enabled?: boolean;
	}>;
	setGlobalCommandBlacklist: (
		v: Array<{ pattern: string; denyPrompt?: string; enabled?: boolean }>,
	) => void;
	userPrefs: AnyPrefs;
	updateUserPref: AnyMutation;
}

export function AgentSection(props: AgentSectionProps) {
	const { t } = useTranslation("settings");
	const { t: tn } = useTranslation("narrator");
	const settingsFeatureCapability = useSettingsFeatureCapability();
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
				onChange={(v) => props.setMaxTurns(typeof v === "number" ? v : 200)}
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
			<Switch
				label={t("expandReasoning")}
				description={t("expandReasoningDesc")}
				checked={props.expandReasoning}
				onChange={(e) => props.setExpandReasoning(e.currentTarget.checked)}
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
				label={t("defaultPruneEnabled")}
				description={t("defaultPruneEnabledDesc")}
				checked={props.defaultPruneEnabled}
				onChange={(e) => props.setDefaultPruneEnabled(e.currentTarget.checked)}
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
				onChange={(v) => props.setSilentToolCallThreshold(typeof v === "number" ? v : 20)}
				min={-1}
				max={1000}
				step={1}
				decimalScale={0}
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
				<NumberInput
					label={t("autoCompactPruneThreshold")}
					description={t("autoCompactPruneThresholdDesc")}
					value={props.autoCompactPruneThreshold}
					onChange={(v) => props.setAutoCompactPruneThreshold(typeof v === "number" ? v : 80)}
					min={0}
					max={100}
					allowDecimal={false}
					suffix="%"
				/>
			</Group>
			<Group grow>
				<NumberInput
					label={t("minPruneRatio")}
					description={t("minPruneRatioDesc")}
					value={props.minPruneRatio}
					onChange={(v) => props.setMinPruneRatio(typeof v === "number" ? v : 30)}
					min={0}
					max={100}
					allowDecimal={false}
					suffix="%"
				/>
			</Group>
			<Text size="sm" fw={500} mt={4}>
				{t("contextThresholdsStandard")}
			</Text>
			<Group grow>
				<NumberInput
					label={t("pruneStart")}
					description={t("pruneStartDesc")}
					value={props.contextThresholds.standard.pruneStart}
					onChange={(v) =>
						props.setContextThresholds({
							...props.contextThresholds,
							standard: {
								...props.contextThresholds.standard,
								pruneStart: typeof v === "number" ? v : 95,
							},
						})
					}
					min={50}
					max={100}
					suffix="%"
				/>
				<NumberInput
					label={t("compactStart")}
					description={t("compactStartDesc")}
					value={props.contextThresholds.standard.compactStart}
					onChange={(v) =>
						props.setContextThresholds({
							...props.contextThresholds,
							standard: {
								...props.contextThresholds.standard,
								compactStart: typeof v === "number" ? v : 99,
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
					label={t("pruneStart")}
					description={t("pruneStartDesc")}
					value={props.contextThresholds.large.pruneStart}
					onChange={(v) =>
						props.setContextThresholds({
							...props.contextThresholds,
							large: {
								...props.contextThresholds.large,
								pruneStart: typeof v === "number" ? v : 95,
							},
						})
					}
					min={10}
					max={100}
					suffix="%"
				/>
				<NumberInput
					label={t("compactStart")}
					description={t("compactStartDesc")}
					value={props.contextThresholds.large.compactStart}
					onChange={(v) =>
						props.setContextThresholds({
							...props.contextThresholds,
							large: {
								...props.contextThresholds.large,
								compactStart: typeof v === "number" ? v : 99,
							},
						})
					}
					min={10}
					max={100}
					suffix="%"
				/>
			</Group>
			{/* Session */}
			<Title order={5} mt="sm">
				{t("sessionSubSection")}
			</Title>
			<Switch
				label={t("autoLoadOlderMessages")}
				description={t("autoLoadOlderMessagesDesc")}
				checked={props.userPrefs?.autoLoadOlderMessages ?? true}
				onChange={(e) =>
					props.updateUserPref.mutate({
						autoLoadOlderMessages: e.currentTarget.checked,
					})
				}
			/>
			<Switch
				label={t("replyInUserLanguage")}
				description={t("replyInUserLanguageDesc")}
				checked={props.userPrefs?.replyInUserLanguage ?? true}
				onChange={(e) =>
					props.updateUserPref.mutate({
						replyInUserLanguage: e.currentTarget.checked,
					})
				}
			/>

			{/* Debug */}
			<Title order={5} mt="sm">
				{t("debugSubSection")}
			</Title>
			<Switch
				label={t("showTokenUsage")}
				description={t("showTokenUsageDesc")}
				checked={props.userPrefs?.showTokenUsage ?? false}
				onChange={(e) =>
					props.updateUserPref.mutate({
						showTokenUsage: e.currentTarget.checked,
					})
				}
			/>
			<Switch
				label={t("showOutputStats")}
				description={t("showOutputStatsDesc")}
				checked={props.userPrefs?.showOutputStats ?? false}
				onChange={(e) =>
					props.updateUserPref.mutate({
						showOutputStats: e.currentTarget.checked,
					})
				}
			/>
			{/* Directory Access Control */}
			<Title order={5} mt="sm">
				{t("globalWhitelistDirs")}
			</Title>
			<Text size="xs" c="dimmed">
				{t("globalWhitelistDirsDesc")}
			</Text>
			<DirListEditor
				dirs={props.globalWhitelistDirs}
				onChange={props.setGlobalWhitelistDirs}
				mode="whitelist"
				labels={{
					empty: t("dirListEmpty"),
					add: t("dirListAdd"),
					placeholder: t("dirListPlaceholder"),
					levels: {
						readOnly: t("dirAccessReadOnly"),
						readWrite: t("dirAccessReadWrite"),
						full: t("dirAccessFull"),
					},
				}}
			/>
			<Title order={5} mt="sm">
				{t("globalBlacklistDirs")}
			</Title>
			<Text size="xs" c="dimmed">
				{t("globalBlacklistDirsDesc")}
			</Text>
			<DirListEditor
				dirs={props.globalBlacklistDirs}
				onChange={props.setGlobalBlacklistDirs}
				mode="blacklist"
				labels={{
					empty: t("dirListEmpty"),
					add: t("dirListAdd"),
					placeholder: t("dirListPlaceholder"),
					levels: {
						denyWrite: t("dirDenyWrite"),
						denyAll: t("dirDenyAll"),
					},
				}}
			/>
			{/* Command Access Control */}
			<Title order={5} mt="sm">
				{t("globalCommandWhitelist")}
			</Title>
			<Text size="xs" c="dimmed">
				{t("globalCommandWhitelistDesc")}
			</Text>
			<CmdListEditor
				commands={props.globalCommandWhitelist}
				onChange={props.setGlobalCommandWhitelist}
				mode="whitelist"
				labels={{
					empty: t("cmdListEmpty"),
					add: t("cmdListAdd"),
					placeholder: t("cmdListPlaceholder"),
				}}
			/>
			<Title order={5} mt="sm">
				{t("globalCommandBlacklist")}
			</Title>
			<Text size="xs" c="dimmed">
				{t("globalCommandBlacklistDesc")}
			</Text>
			<CmdListEditor
				commands={props.globalCommandBlacklist}
				onChange={props.setGlobalCommandBlacklist}
				mode="blacklist"
				labels={{
					empty: t("cmdListEmpty"),
					add: t("cmdListAdd"),
					placeholder: t("cmdListPlaceholder"),
					denyPromptPlaceholder: t("cmdDenyPromptPlaceholder"),
				}}
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
		const d = domain.trim() || undefined;
		const k = keyword.trim() || undefined;
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
