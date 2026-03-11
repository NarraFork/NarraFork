import { Group, Select, Slider, Stack, Switch, Text, Title } from "@mantine/core";
import type { UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
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
}

export function AppearanceSection({
	userPrefs,
	updateUserPref,
	oledMode,
	setOledMode,
	isFullscreen,
	setIsFullscreen,
}: AppearanceSectionProps) {
	const { t } = useTranslation("settings");
	const [localFontSize, setLocalFontSize] = useState<number | null>(null);

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
		</Stack>
	);
}
