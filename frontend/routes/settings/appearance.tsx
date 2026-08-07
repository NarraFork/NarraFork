import { Stack, Switch, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AppearanceSection } from "../../components/settings/AppearanceSection";
import { useLocalPref } from "../../hooks/useLocalPref";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";

export const Route = createFileRoute("/settings/appearance")({
	component: SettingsAppearancePage,
});

function SettingsAppearancePage() {
	const { t } = useTranslation("settings");
	const { data: userPrefs } = useUserPreferences();
	const updateUserPref = useUpdateUserPreferences();
	const [oledMode, setOledMode] = useLocalPref("narrafork_oled");
	const [isFullscreen, setIsFullscreen] = useLocalPref("narrafork_fullscreen");
	const [wakeLock, setWakeLock] = useLocalPref("narrafork_wakelock");
	const [advancedAnim, setAdvancedAnim] = useLocalPref("narrafork_advanced_anim");
	const [expandReasoning, setExpandReasoning] = useLocalPref("narrafork_expand_reasoning");
	const [centeredColumn, setCenteredColumn] = useLocalPref("narrafork_narrator_centered_column");
	// TEMPORARY debug toggle — see components/narrator/mock/README-REMOVAL.md.
	// Kept here rather than inside AppearanceSection so removal touches one file.
	const [mockStream, setMockStream] = useLocalPref("narrafork_mock_stream");

	// Sync fullscreen state when user exits via browser shortcut (Esc / F11)
	useEffect(() => {
		const handler = () => setIsFullscreen(!!document.fullscreenElement);
		document.addEventListener("fullscreenchange", handler);
		return () => document.removeEventListener("fullscreenchange", handler);
	}, [setIsFullscreen]);

	return (
		<Stack>
			<Title order={3}>{t("appearanceSection")}</Title>
			<AppearanceSection
				userPrefs={userPrefs}
				updateUserPref={updateUserPref}
				oledMode={oledMode}
				setOledMode={setOledMode}
				isFullscreen={isFullscreen}
				setIsFullscreen={setIsFullscreen}
				wakeLock={wakeLock}
				setWakeLock={setWakeLock}
				advancedAnim={advancedAnim}
				setAdvancedAnim={setAdvancedAnim}
				expandReasoning={expandReasoning}
				setExpandReasoning={setExpandReasoning}
				centeredColumn={centeredColumn}
				setCenteredColumn={setCenteredColumn}
			/>
			{/* TEMPORARY debug toggle (mock stream harness). Delete with ../mock/. */}
			<Switch
				label={t("mockStreamPanel")}
				description={t("mockStreamPanelDesc")}
				checked={mockStream}
				onChange={(e) => setMockStream(e.currentTarget.checked)}
			/>
		</Stack>
	);
}
