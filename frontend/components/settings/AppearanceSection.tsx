import { Group, SegmentedControl, Select, Slider, Stack, Switch, Text, Title } from "@mantine/core";
import type { UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	pluginThemeKey,
	usePluginAvailableThemes,
	usePluginThemePref,
} from "../../hooks/usePluginThemes";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { ThemeSwitcher } from "../ThemeSwitcher";
import { TERMINAL_THEMES } from "../terminal/terminal-theme";

// biome-ignore lint/suspicious/noExplicitAny: dynamic prefs type
type AnyPrefs = any;
// biome-ignore lint/suspicious/noExplicitAny: mutation hook type
type AnyMutation = UseMutationResult<any, any, any, any>;

export interface AppearanceSectionProps {
	userPrefs: AnyPrefs;
	updateUserPref: AnyMutation;
	oledMode: boolean;
	setOledMode: (v: boolean) => void;
	isFullscreen: boolean;
	setIsFullscreen: (v: boolean) => void;
	wakeLock: boolean;
	setWakeLock: (v: boolean) => void;
	advancedAnim: boolean;
	setAdvancedAnim: (v: boolean) => void;
	expandReasoning: boolean;
	setExpandReasoning: (v: boolean) => void;
}

export function AppearanceSection({
	userPrefs,
	updateUserPref,
	oledMode,
	setOledMode,
	isFullscreen,
	setIsFullscreen,
	wakeLock,
	setWakeLock,
	advancedAnim,
	setAdvancedAnim,
	expandReasoning,
	setExpandReasoning,
}: AppearanceSectionProps) {
	const { t } = useTranslation("settings");
	const [localFontSize, setLocalFontSize] = useState<number | null>(null);
	const { themes: availableThemes, setEnabled: setThemeEnabled } = usePluginAvailableThemes();
	const [pluginThemePref, setPluginThemePref] = usePluginThemePref();

	return (
		<Stack>
			{/* Theme */}
			<Title order={5}>{t("themeSubSection")}</Title>
			<ThemeSwitcher />
			<Switch
				label={t("oledMode")}
				description={t("oledModeDesc")}
				checked={oledMode}
				onChange={(e) => setOledMode(e.currentTarget.checked)}
			/>
			{availableThemes.length > 0 && (
				<Select
					label={t("pluginTheme")}
					description={t("pluginThemeDesc")}
					data={[
						{ value: "", label: t("pluginThemeDefault") },
						...availableThemes.map((theme) => ({
							value: pluginThemeKey(theme),
							label: theme.title,
						})),
					]}
					value={pluginThemePref ?? ""}
					onChange={(v) => {
						// Selecting a theme enables it for this user (if not already) and
						// sets it as the active device preference. Choosing "None" only
						// clears the active preference; it does not disable the theme.
						if (!v) {
							setPluginThemePref(null);
							return;
						}
						const theme = availableThemes.find((it) => pluginThemeKey(it) === v);
						if (theme && !theme.enabled) {
							void setThemeEnabled(theme.pluginId, theme.themeId, true);
						}
						setPluginThemePref(v);
					}}
					allowDeselect={false}
				/>
			)}

			{/* Display */}
			<Title order={5} mt="sm">
				{t("displaySubSection")}
			</Title>
			<Switch
				label={t("ignoreSafeArea")}
				description={t("ignoreSafeAreaDesc")}
				checked={isFullscreen}
				onChange={(e) => {
					const on = e.currentTarget.checked;
					setIsFullscreen(on);
					localStorage.setItem("narrafork_fullscreen", String(on));
					if (on) {
						document.documentElement.requestFullscreen?.().catch(() => {});
					} else if (document.fullscreenElement) {
						document.exitFullscreen?.().catch(() => {});
					}
				}}
			/>
			<Switch
				label={t("wakeLock")}
				description={t("wakeLockDesc")}
				checked={wakeLock}
				onChange={(e) => setWakeLock(e.currentTarget.checked)}
			/>
			<Switch
				label={t("advancedAnimation")}
				description={t("advancedAnimationDesc")}
				checked={advancedAnim}
				onChange={(e) => setAdvancedAnim(e.currentTarget.checked)}
			/>
			{/* Word Wrap */}
			<Title order={5} mt="sm">
				{t("wordWrapSubSection")}
			</Title>
			<Switch
				label={t("wordWrapMarkdown")}
				checked={userPrefs?.wordWrapMarkdown ?? true}
				onChange={(e) =>
					updateUserPref.mutate({
						wordWrapMarkdown: e.currentTarget.checked,
					})
				}
			/>
			<Switch
				label={t("wordWrapCode")}
				checked={userPrefs?.wordWrapCode ?? true}
				onChange={(e) => updateUserPref.mutate({ wordWrapCode: e.currentTarget.checked })}
			/>
			<Switch
				label={t("wordWrapDiff")}
				checked={userPrefs?.wordWrapDiff ?? true}
				onChange={(e) => updateUserPref.mutate({ wordWrapDiff: e.currentTarget.checked })}
			/>

			{/* Recent Tabs */}
			<Title order={5} mt="sm">
				{t("recentTabsSubSection")}
			</Title>
			<Switch
				label={t("addSubagentToRecentTabs")}
				description={t("addSubagentToRecentTabsDesc")}
				checked={userPrefs?.addSubagentToRecentTabs ?? true}
				onChange={(e) =>
					updateUserPref.mutate({ addSubagentToRecentTabs: e.currentTarget.checked })
				}
			/>

			{/* Terminal */}
			<Title order={5} mt="sm">
				{t("terminalSubSection")}
			</Title>
			<Select
				label={t("terminalTheme")}
				data={[
					{ value: "auto", label: t("terminalThemeAuto") },
					...TERMINAL_THEMES.map((th) => ({
						value: th.key,
						label: th.label,
					})),
				]}
				value={userPrefs?.terminalTheme ?? "auto"}
				onChange={(v) => updateUserPref.mutate({ terminalTheme: v ?? "auto" })}
			/>
			<Stack gap={4}>
				<Text size="sm" fw={500}>
					{t("terminalFontSize")}
				</Text>
				<Group>
					<Slider
						value={localFontSize ?? userPrefs?.terminalFontSize ?? 14}
						onChange={setLocalFontSize}
						onChangeEnd={(v) => {
							setLocalFontSize(null);
							updateUserPref.mutate({ terminalFontSize: v });
						}}
						min={8}
						max={32}
						step={1}
						style={{ flex: 1 }}
						marks={[
							{ value: 8, label: "8" },
							{ value: 14, label: "14" },
							{ value: 20, label: "20" },
							{ value: 32, label: "32" },
						]}
					/>
				</Group>
			</Stack>

			{/* Language */}
			<Title order={5} mt="sm">
				{t("languageSubSection")}
			</Title>
			<LanguageSwitcher />

			{/* Input */}
			<Title order={5} mt="sm">
				{t("inputSubSection")}
			</Title>
			<Stack gap={4}>
				<Text size="sm" fw={500}>
					{t("sendMode")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("sendModeDesc")}
				</Text>
				<Text size="xs" fw={500} mt={4}>
					{t("enterKeyBehavior")}
				</Text>
				<SegmentedControl
					value={userPrefs?.enterQueueMode ?? "turn"}
					onChange={(v) => updateUserPref.mutate({ enterQueueMode: v })}
					data={[
						{ value: "turn", label: t("queueMode_turn") },
						{ value: "tool", label: t("queueMode_tool") },
						{ value: "interrupt", label: t("queueMode_interrupt") },
					]}
				/>
				<Text size="xs" fw={500} mt={4}>
					{t("ctrlEnterKeyBehavior")}
				</Text>
				<SegmentedControl
					value={userPrefs?.ctrlEnterQueueMode ?? "tool"}
					onChange={(v) => updateUserPref.mutate({ ctrlEnterQueueMode: v })}
					data={[
						{ value: "turn", label: t("queueMode_turn") },
						{ value: "tool", label: t("queueMode_tool") },
						{ value: "interrupt", label: t("queueMode_interrupt") },
					]}
				/>
				<Text size="xs" c="dimmed" mt={4}>
					{t("shiftEnterNewlineHint")}
				</Text>
			</Stack>

			{/* Session — per-user, kept here so non-admins can still reach them */}
			<Title order={5} mt="sm">
				{t("sessionSubSection")}
			</Title>
			<Switch
				label={t("autoLoadOlderMessages")}
				description={t("autoLoadOlderMessagesDesc")}
				checked={userPrefs?.autoLoadOlderMessages ?? true}
				onChange={(e) =>
					updateUserPref.mutate({
						autoLoadOlderMessages: e.currentTarget.checked,
					})
				}
			/>
			<Switch
				label={t("replyInUserLanguage")}
				description={t("replyInUserLanguageDesc")}
				checked={userPrefs?.replyInUserLanguage ?? true}
				onChange={(e) =>
					updateUserPref.mutate({
						replyInUserLanguage: e.currentTarget.checked,
					})
				}
			/>
			<Switch
				label={t("expandReasoning")}
				description={t("expandReasoningDesc")}
				checked={expandReasoning}
				onChange={(e) => setExpandReasoning(e.currentTarget.checked)}
			/>

			{/* Debug — per-user display toggles */}
			<Title order={5} mt="sm">
				{t("debugSubSection")}
			</Title>
			<Switch
				label={t("showTokenUsage")}
				description={t("showTokenUsageDesc")}
				checked={userPrefs?.showTokenUsage ?? false}
				onChange={(e) =>
					updateUserPref.mutate({
						showTokenUsage: e.currentTarget.checked,
					})
				}
			/>
			<Switch
				label={t("showOutputStats")}
				description={t("showOutputStatsDesc")}
				checked={userPrefs?.showOutputStats ?? false}
				onChange={(e) =>
					updateUserPref.mutate({
						showOutputStats: e.currentTarget.checked,
					})
				}
			/>
		</Stack>
	);
}
