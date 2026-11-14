/**
 * Theme colour picker: neutral surface presets, a custom hue, and the accent ramp.
 *
 * The swatches are rendered from `resolvePalette` itself rather than from hand-picked
 * preview colours, so what a swatch shows is exactly what the app will paint — including
 * after this file's presets are edited.
 */

import { usePaletteChoice } from "@frontend/hooks/usePaletteChoice";
import { usePluginThemePref } from "@frontend/hooks/usePluginThemes";
import {
	ACCENT_PRESETS,
	type AccentPresetId,
	DEFAULT_PALETTE,
	NEUTRAL_PRESETS,
	type NeutralPresetId,
	type PaletteChoice,
	resolvePalette,
} from "@frontend/lib/palette-presets";
import { Box, Button, ColorInput, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

const NEUTRAL_LABEL: Record<NeutralPresetId, string> = {
	default: "palettePresetDefault",
	graphite: "palettePresetGraphite",
	midnight: "palettePresetMidnight",
	tokyo: "palettePresetTokyo",
	warm: "palettePresetWarm",
	forest: "palettePresetForest",
	contrast: "palettePresetContrast",
};

const ACCENT_LABEL: Record<AccentPresetId, string> = {
	indigo: "paletteAccentIndigo",
	blue: "paletteAccentBlue",
	teal: "paletteAccentTeal",
	green: "paletteAccentGreen",
	amber: "paletteAccentAmber",
	violet: "paletteAccentViolet",
	rose: "paletteAccentRose",
};

function NeutralSwatch({
	choice,
	preset,
	label,
	selected,
	disabled,
	onSelect,
}: {
	choice: PaletteChoice;
	preset: NeutralPresetId;
	label: string;
	selected: boolean;
	disabled: boolean;
	onSelect: () => void;
}) {
	const preview = useMemo(() => resolvePalette({ ...choice, neutral: preset }), [choice, preset]);
	const canvas = preview.ink["ink-950"];
	const pane = preview.ink["ink-900"];
	const rule = preview.ink["ink-700"];
	return (
		<UnstyledButton
			onClick={onSelect}
			disabled={disabled}
			aria-pressed={selected}
			style={{ opacity: disabled ? 0.45 : 1 }}
		>
			<Stack gap={4} align="center">
				<Box
					style={{
						width: 56,
						height: 38,
						borderRadius: 6,
						overflow: "hidden",
						background: canvas,
						border: `1px solid ${selected ? preview.accent[6] : rule}`,
						outline: selected ? `2px solid ${preview.accent[6]}` : undefined,
						outlineOffset: 1,
					}}
				>
					<Box style={{ height: "50%", background: pane, borderBottom: `1px solid ${rule}` }} />
				</Box>
				<Text size="xs" c={selected ? undefined : "dimmed"}>
					{label}
				</Text>
			</Stack>
		</UnstyledButton>
	);
}

function AccentSwatch({
	color,
	label,
	selected,
	disabled,
	onSelect,
}: {
	color: string;
	label: string;
	selected: boolean;
	disabled: boolean;
	onSelect: () => void;
}) {
	return (
		<UnstyledButton
			onClick={onSelect}
			disabled={disabled}
			aria-pressed={selected}
			aria-label={label}
			title={label}
			style={{ opacity: disabled ? 0.45 : 1 }}
		>
			<Box
				style={{
					width: 22,
					height: 22,
					borderRadius: 999,
					background: color,
					outline: selected ? `2px solid ${color}` : undefined,
					outlineOffset: 2,
					border: selected ? "2px solid var(--mantine-color-body)" : "none",
					boxShadow: selected ? "none" : "inset 0 0 0 1px rgba(255,255,255,0.14)",
				}}
			/>
		</UnstyledButton>
	);
}

export function ThemeColorCard() {
	const { t } = useTranslation("settings");
	const { choice, setChoice } = usePaletteChoice();
	const [pluginThemePref] = usePluginThemePref();
	// A plugin theme is a complete design; mixing our palette into it only produces a
	// half-themed app, so the controls step aside and say why.
	const disabled = Boolean(pluginThemePref);

	const accentColors = useMemo(
		() =>
			Object.fromEntries(
				ACCENT_PRESETS.map((preset) => [
					preset.id,
					resolvePalette({ ...choice, accent: preset.id }).accent[6],
				]),
			) as Record<AccentPresetId, string>,
		[choice],
	);

	return (
		<Stack gap="sm" mt="sm">
			<div>
				<Text fw={600} size="sm">
					{t("paletteNeutral")}
				</Text>
				<Text size="xs" c="dimmed">
					{disabled ? t("palettePluginThemeNotice") : t("paletteNeutralDesc")}
				</Text>
			</div>

			<Group gap="md" wrap="wrap">
				{NEUTRAL_PRESETS.map((preset) => (
					<NeutralSwatch
						key={preset.id}
						choice={choice}
						preset={preset.id}
						label={t(NEUTRAL_LABEL[preset.id])}
						selected={choice.neutral === preset.id}
						disabled={disabled}
						onSelect={() => setChoice({ ...choice, neutral: preset.id })}
					/>
				))}
			</Group>

			<Group align="flex-end" gap="sm">
				<ColorInput
					size="xs"
					label={t("paletteCustom")}
					value={choice.neutralCustom}
					disabled={disabled}
					format="hex"
					withEyeDropper={false}
					onChange={(value) => {
						if (!/^#[0-9a-fA-F]{6}$/.test(value)) return;
						setChoice({ ...choice, neutral: "custom", neutralCustom: value });
					}}
					styles={{ input: { width: 120 } }}
				/>
				<Button
					size="xs"
					variant="default"
					disabled={disabled}
					onClick={() => setChoice({ ...DEFAULT_PALETTE, accent: choice.accent })}
				>
					{t("paletteReset")}
				</Button>
			</Group>

			<div>
				<Text fw={600} size="sm">
					{t("paletteAccent")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("paletteAccentDesc")}
				</Text>
			</div>

			<Group gap="sm" wrap="wrap" align="center">
				{ACCENT_PRESETS.map((preset) => (
					<AccentSwatch
						key={preset.id}
						color={accentColors[preset.id]}
						label={t(ACCENT_LABEL[preset.id])}
						selected={choice.accent === preset.id}
						disabled={disabled}
						onSelect={() => setChoice({ ...choice, accent: preset.id })}
					/>
				))}
				<ColorInput
					size="xs"
					value={choice.accentCustom}
					disabled={disabled}
					format="hex"
					withEyeDropper={false}
					aria-label={t("paletteCustom")}
					onChange={(value) => {
						if (!/^#[0-9a-fA-F]{6}$/.test(value)) return;
						setChoice({ ...choice, accent: "custom", accentCustom: value });
					}}
					styles={{ input: { width: 110 } }}
				/>
			</Group>
		</Stack>
	);
}
