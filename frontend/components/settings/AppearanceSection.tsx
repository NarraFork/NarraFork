import { Group, SegmentedControl, Select, Slider, Stack, Switch, Text, Title } from "@mantine/core";
import {
	DEFAULT_TYPOGRAPHY,
	setTypography,
	TYPOGRAPHY_RANGE,
} from "@shared/pretext-layout/typography";
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
	blurInMs: number;
	setBlurInMs: (v: number) => void;
	streamTokenMs: number;
	setStreamTokenMs: (v: number) => void;
	expandReasoning: boolean;
	setExpandReasoning: (v: boolean) => void;
	centeredColumn: boolean;
	setCenteredColumn: (v: boolean) => void;
	lodAltGesture: boolean;
	setLodAltGesture: (v: boolean) => void;
}

/**
 * One typography slider.
 *
 * Same two-phase contract as the docked panel's knob: the drag writes the module
 * (visible immediately, and cheap) while the preference is saved once on release.
 * Writing per frame would re-measure every open transcript on every pointer move.
 */
function TypographyKnob({
	label,
	description,
	value,
	min,
	max,
	step,
	marks,
	onPreview,
	onCommit,
}: {
	label: string;
	description: string;
	value: number;
	min: number;
	max: number;
	step: number;
	marks: { value: number; label: string }[];
	onPreview: (value: number) => void;
	onCommit: (value: number) => void;
}) {
	const [dragging, setDragging] = useState<number | null>(null);
	return (
		<Stack gap={4}>
			<Group justify="space-between" wrap="nowrap" gap="xs">
				<Text size="sm" fw={500}>
					{label}
				</Text>
				<Text size="xs" c="dimmed">
					{`${dragging ?? value}%`}
				</Text>
			</Group>
			<Text size="xs" c="dimmed">
				{description}
			</Text>
			<Slider
				value={dragging ?? value}
				onChange={(next) => {
					setDragging(next);
					onPreview(next);
				}}
				onChangeEnd={(next) => {
					setDragging(null);
					onCommit(next);
				}}
				min={min}
				max={max}
				step={step}
				label={(v) => `${v}%`}
				marks={marks}
				mb="md"
			/>
		</Stack>
	);
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
	blurInMs,
	setBlurInMs,
	streamTokenMs,
	setStreamTokenMs,
	expandReasoning,
	setExpandReasoning,
	centeredColumn,
	setCenteredColumn,
	lodAltGesture,
	setLodAltGesture,
}: AppearanceSectionProps) {
	const { t } = useTranslation("settings");
	const [localFontSize, setLocalFontSize] = useState<number | null>(null);
	const [localBlurInMs, setLocalBlurInMs] = useState<number | null>(null);
	const [localStreamTokenMs, setLocalStreamTokenMs] = useState<number | null>(null);
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
			{/* Duration of the card-level blur-in. Shown always but disabled while the
			    switch above is off, so the control that owns it stays discoverable
			    instead of appearing out of nowhere after a toggle. Local state during
			    the drag keeps the slider responsive; the pref is written on release. */}
			<Stack gap={4} ml="xl" opacity={advancedAnim ? 1 : 0.5}>
				<Text size="sm" fw={500}>
					{t("blurInDuration")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("blurInDurationDesc")}
				</Text>
				<Slider
					disabled={!advancedAnim}
					value={localBlurInMs ?? blurInMs}
					onChange={setLocalBlurInMs}
					onChangeEnd={(v) => {
						setLocalBlurInMs(null);
						setBlurInMs(v);
					}}
					min={0}
					max={2000}
					step={50}
					label={(v) => (v === 0 ? t("blurInDurationInstant") : `${v}ms`)}
					marks={[
						{ value: 0, label: t("blurInDurationInstant") },
						{ value: 400, label: "400ms" },
						{ value: 1000, label: "1s" },
						{ value: 2000, label: "2s" },
					]}
					mb="md"
				/>
			</Stack>
			{/* Duration of the streaming per-grapheme fade. Both renderers (the virtual
			    list and the classic one) follow this value. Note the setting is a
			    request, not a guarantee: past ~1s a fast stream hits the live-span cap
			    in stream-token-anim and the oldest graphemes seal early, so the fade
			    shortens on its own. The description text says so. */}
			<Stack gap={4} ml="xl" opacity={advancedAnim ? 1 : 0.5}>
				<Text size="sm" fw={500}>
					{t("streamTokenDuration")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("streamTokenDurationDesc")}
				</Text>
				<Slider
					disabled={!advancedAnim}
					value={localStreamTokenMs ?? streamTokenMs}
					onChange={setLocalStreamTokenMs}
					onChangeEnd={(v) => {
						setLocalStreamTokenMs(null);
						setStreamTokenMs(v);
					}}
					min={0}
					max={5000}
					step={20}
					label={(v) => (v === 0 ? t("blurInDurationInstant") : `${v}ms`)}
					marks={[
						{ value: 0, label: t("blurInDurationInstant") },
						{ value: 320, label: "320ms" },
						{ value: 2500, label: "2.5s" },
						{ value: 5000, label: "5s" },
					]}
					mb="md"
				/>
			</Stack>
			<Switch
				label={t("narratorCenteredColumn")}
				description={t("narratorCenteredColumnDesc")}
				checked={centeredColumn}
				onChange={(e) => setCenteredColumn(e.currentTarget.checked)}
			/>
			<Switch
				label={t("lodAltGesture")}
				description={t("lodAltGestureDesc")}
				checked={lodAltGesture}
				onChange={(e) => setLodAltGesture(e.currentTarget.checked)}
			/>
			{/* Narrator typography — the same three knobs the in-session Typography panel
			    exposes. Both write the SAME user preference; this surface exists so the
			    controls are reachable without opening a conversation, while the docked
			    panel exists so they can be judged against real content. */}
			<Title order={5} mt="sm">
				{t("narratorTypographySubSection")}
			</Title>
			<Text size="xs" c="dimmed">
				{t("narratorTypographyDesc")}
			</Text>
			<TypographyKnob
				label={t("narratorFontScale")}
				description={t("narratorFontScaleDesc")}
				value={userPrefs?.narratorFontScalePercent ?? DEFAULT_TYPOGRAPHY.fontScalePercent}
				min={TYPOGRAPHY_RANGE.fontScalePercent.min}
				max={TYPOGRAPHY_RANGE.fontScalePercent.max}
				step={5}
				marks={[
					{ value: 70, label: "70%" },
					{ value: 100, label: "100%" },
					{ value: 180, label: "180%" },
				]}
				onPreview={(v) => setTypography({ fontScalePercent: v })}
				onCommit={(v) => updateUserPref.mutate({ narratorFontScalePercent: v })}
			/>
			<TypographyKnob
				label={t("narratorLetterSpacing")}
				description={t("narratorLetterSpacingDesc")}
				value={userPrefs?.narratorLetterSpacingPercent ?? DEFAULT_TYPOGRAPHY.letterSpacingPercent}
				min={TYPOGRAPHY_RANGE.letterSpacingPercent.min}
				max={TYPOGRAPHY_RANGE.letterSpacingPercent.max}
				step={1}
				marks={[
					{ value: -5, label: "-5%" },
					{ value: 0, label: "0" },
					{ value: 25, label: "25%" },
				]}
				onPreview={(v) => setTypography({ letterSpacingPercent: v })}
				onCommit={(v) => updateUserPref.mutate({ narratorLetterSpacingPercent: v })}
			/>
			<TypographyKnob
				label={t("narratorLineHeight")}
				description={t("narratorLineHeightDesc")}
				value={
					userPrefs?.narratorLineHeightScalePercent ?? DEFAULT_TYPOGRAPHY.lineHeightScalePercent
				}
				min={TYPOGRAPHY_RANGE.lineHeightScalePercent.min}
				max={TYPOGRAPHY_RANGE.lineHeightScalePercent.max}
				step={5}
				marks={[
					{ value: 75, label: "75%" },
					{ value: 100, label: "100%" },
					{ value: 220, label: "220%" },
				]}
				onPreview={(v) => setTypography({ lineHeightScalePercent: v })}
				onCommit={(v) => updateUserPref.mutate({ narratorLineHeightScalePercent: v })}
			/>
			<TypographyKnob
				label={t("narratorParagraphScale")}
				description={t("narratorParagraphScaleDesc")}
				value={userPrefs?.narratorParagraphScalePercent ?? DEFAULT_TYPOGRAPHY.paragraphScalePercent}
				min={TYPOGRAPHY_RANGE.paragraphScalePercent.min}
				max={TYPOGRAPHY_RANGE.paragraphScalePercent.max}
				step={5}
				marks={[
					{ value: 50, label: "50%" },
					{ value: 100, label: "100%" },
					{ value: 250, label: "250%" },
				]}
				onPreview={(v) => setTypography({ paragraphScalePercent: v })}
				onCommit={(v) => updateUserPref.mutate({ narratorParagraphScalePercent: v })}
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
