import { Group, NumberInput, Select, Stack, Switch, Text, Title } from "@mantine/core";
import {
	IconEye,
	IconHandStop,
	IconNotebook,
	IconPencilCheck,
	IconShield,
	IconShieldOff,
} from "@tabler/icons-react";
import type { UseMutationResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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
	translateReasoning: boolean;
	setTranslateReasoning: (v: boolean) => void;
	expandReasoning: boolean;
	setExpandReasoning: (v: boolean) => void;
	defaultRelaxedPlan: boolean;
	setDefaultRelaxedPlan: (v: boolean) => void;
	smartInterruptionCheck: boolean;
	setSmartInterruptionCheck: (v: boolean) => void;
	maxTransientRetries: number;
	setMaxTransientRetries: (v: number) => void;
	contextThresholds: {
		standard: { pruneStart: number; compactStart: number };
		large: { pruneStart: number; compactStart: number };
	};
	setContextThresholds: (v: {
		standard: { pruneStart: number; compactStart: number };
		large: { pruneStart: number; compactStart: number };
	}) => void;
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
					{ value: "plan", label: tn("perm_plan") },
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
					) : props.permissionMode === "plan" ? (
						<IconNotebook size={14} />
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
						plan: <IconNotebook size={14} />,
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
				label={t("translateReasoning")}
				description={t("translateReasoningDesc")}
				checked={props.translateReasoning}
				onChange={(e) => props.setTranslateReasoning(e.currentTarget.checked)}
			/>
			<Switch
				label={t("expandReasoning")}
				description={t("expandReasoningDesc")}
				checked={props.expandReasoning}
				onChange={(e) => props.setExpandReasoning(e.currentTarget.checked)}
			/>
			<Switch
				label={t("defaultRelaxedPlan")}
				description={t("defaultRelaxedPlanDesc")}
				checked={props.defaultRelaxedPlan}
				onChange={(e) => props.setDefaultRelaxedPlan(e.currentTarget.checked)}
			/>
			<Switch
				label={t("smartInterruptionCheck")}
				description={t("smartInterruptionCheckDesc")}
				checked={props.smartInterruptionCheck}
				onChange={(e) => props.setSmartInterruptionCheck(e.currentTarget.checked)}
			/>
			<NumberInput
				label={t("maxTransientRetries")}
				description={t("maxTransientRetriesDesc")}
				value={props.maxTransientRetries}
				onChange={(v) => props.setMaxTransientRetries(typeof v === "number" ? v : 10)}
				min={-1}
				max={100}
			/>
			{/* Context Thresholds */}
			<Title order={5} mt="sm" id="contextThresholds">
				{t("contextThresholds")}
			</Title>
			<Text size="xs" c="dimmed">
				{t("contextThresholdsDesc")}
			</Text>
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
