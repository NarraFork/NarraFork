/**
 * AppearancePanel — live typography controls for the narrator transcript.
 *
 * ## Why this lives beside the transcript
 *
 * Font size, letter spacing and block spacing are judged by eye, on real content:
 * a value that reads well on short prose is cramped on a dense tool trace. Putting
 * the sliders in Settings means changing a value, navigating back, and losing the
 * comparison. Docked here, the transcript re-lays out behind the panel as the slider
 * moves.
 *
 * ## Local state during the drag, one save on release
 *
 * A slider drag emits a value per frame. Each distinct value is a new typography
 * generation, and every generation drops the prepared caches and re-measures the
 * whole document — so writing through on every frame would both hammer the API and
 * make a long transcript stutter under the cursor.
 *
 * So the drag updates the MODULE (cheap, local, immediately visible) while the
 * PREFERENCE is written once on release. The module is the source the height model
 * reads, so the preview is real rather than an approximation of what saving would
 * do.
 */

import { Anchor, Badge, Box, Group, Slider, Stack, Text } from "@mantine/core";
import {
	DEFAULT_TYPOGRAPHY,
	getTypography,
	onTypographyChange,
	setTypography,
	TYPOGRAPHY_RANGE,
	type TypographySettings,
} from "@shared/pretext-layout/typography";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";

/**
 * The live typography, as React state.
 *
 * Subscribes to the module rather than mirroring the preference query, so the panel
 * always shows what the transcript is ACTUALLY using — including a value another
 * surface (Settings, a second dock panel) just changed.
 */
function useLiveTypography(): TypographySettings {
	return useSyncExternalStore(onTypographyChange, getTypography, () => DEFAULT_TYPOGRAPHY);
}

interface KnobProps {
	label: string;
	description: string;
	value: number;
	min: number;
	max: number;
	/** Percent step. 5 for the coarse knobs, 1 for letter spacing (small range). */
	step: number;
	marks: { value: number; label: string }[];
	onPreview: (value: number) => void;
	onCommit: (value: number) => void;
}

function Knob({
	label,
	description,
	value,
	min,
	max,
	step,
	marks,
	onPreview,
	onCommit,
}: KnobProps) {
	// Held only while dragging, so an external change (Settings, a reset) is not
	// masked by a stale local value once the drag ends.
	const [dragging, setDragging] = useState<number | null>(null);
	return (
		<Stack gap={2}>
			<Group justify="space-between" wrap="nowrap" gap="xs">
				<Text size="sm" fw={500}>
					{label}
				</Text>
				<Badge size="sm" variant="light" color="indigo">
					{`${dragging ?? value}%`}
				</Badge>
			</Group>
			<Text size="xs" c="dimmed">
				{description}
			</Text>
			<Slider
				value={dragging ?? value}
				onChange={(next) => {
					setDragging(next);
					// Applied to the module immediately: this IS the preview.
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
				mb="lg"
			/>
		</Stack>
	);
}

export function AppearancePanel() {
	const { t } = useTranslation("narrator");
	const { data: prefs } = useUserPreferences();
	const updatePrefs = useUpdateUserPreferences();
	const live = useLiveTypography();

	/**
	 * Re-apply the SAVED preference when this panel unmounts having left an unsaved
	 * preview behind.
	 *
	 * A preview lives in the module, which outlives the panel. Closing the panel
	 * mid-drag (or after a failed save) would otherwise leave the transcript scaled to
	 * a value that is not stored anywhere — invisible until the next reload silently
	 * reverted it.
	 */
	useEffect(() => {
		if (!prefs) return;
		return () => {
			setTypography({
				fontScalePercent: prefs.narratorFontScalePercent,
				letterSpacingPercent: prefs.narratorLetterSpacingPercent,
				lineHeightScalePercent: prefs.narratorLineHeightScalePercent,
				paragraphScalePercent: prefs.narratorParagraphScalePercent,
			});
		};
	}, [prefs]);

	const commit = useCallback(
		(patch: Partial<TypographySettings>) => {
			setTypography(patch);
			// Persist under the server's field names. Only the changed knob is sent, so
			// two panels adjusting different knobs cannot overwrite each other.
			const body: Record<string, number> = {};
			if (patch.fontScalePercent !== undefined) {
				body.narratorFontScalePercent = patch.fontScalePercent;
			}
			if (patch.letterSpacingPercent !== undefined) {
				body.narratorLetterSpacingPercent = patch.letterSpacingPercent;
			}
			if (patch.lineHeightScalePercent !== undefined) {
				body.narratorLineHeightScalePercent = patch.lineHeightScalePercent;
			}
			if (patch.paragraphScalePercent !== undefined) {
				body.narratorParagraphScalePercent = patch.paragraphScalePercent;
			}
			updatePrefs.mutate(body);
		},
		[updatePrefs],
	);

	const isDefault =
		live.fontScalePercent === DEFAULT_TYPOGRAPHY.fontScalePercent &&
		live.letterSpacingPercent === DEFAULT_TYPOGRAPHY.letterSpacingPercent &&
		live.lineHeightScalePercent === DEFAULT_TYPOGRAPHY.lineHeightScalePercent &&
		live.paragraphScalePercent === DEFAULT_TYPOGRAPHY.paragraphScalePercent;

	return (
		<Box p="md">
			<Stack gap="xs">
				<Text size="xs" c="dimmed">
					{t("appearance.intro")}
				</Text>

				<Knob
					label={t("appearance.fontScale")}
					description={t("appearance.fontScaleDesc")}
					value={live.fontScalePercent}
					min={TYPOGRAPHY_RANGE.fontScalePercent.min}
					max={TYPOGRAPHY_RANGE.fontScalePercent.max}
					step={5}
					marks={[
						{ value: 70, label: "70%" },
						{ value: 100, label: "100%" },
						{ value: 180, label: "180%" },
					]}
					onPreview={(v) => setTypography({ fontScalePercent: v })}
					onCommit={(v) => commit({ fontScalePercent: v })}
				/>

				<Knob
					label={t("appearance.letterSpacing")}
					description={t("appearance.letterSpacingDesc")}
					value={live.letterSpacingPercent}
					min={TYPOGRAPHY_RANGE.letterSpacingPercent.min}
					max={TYPOGRAPHY_RANGE.letterSpacingPercent.max}
					step={1}
					marks={[
						{ value: -5, label: "-5%" },
						{ value: 0, label: "0" },
						{ value: 25, label: "25%" },
					]}
					onPreview={(v) => setTypography({ letterSpacingPercent: v })}
					onCommit={(v) => commit({ letterSpacingPercent: v })}
				/>

				<Knob
					label={t("appearance.lineHeight")}
					description={t("appearance.lineHeightDesc")}
					value={live.lineHeightScalePercent}
					min={TYPOGRAPHY_RANGE.lineHeightScalePercent.min}
					max={TYPOGRAPHY_RANGE.lineHeightScalePercent.max}
					step={5}
					marks={[
						{ value: 75, label: "75%" },
						{ value: 100, label: "100%" },
						{ value: 220, label: "220%" },
					]}
					onPreview={(v) => setTypography({ lineHeightScalePercent: v })}
					onCommit={(v) => commit({ lineHeightScalePercent: v })}
				/>

				<Knob
					label={t("appearance.paragraphScale")}
					description={t("appearance.paragraphScaleDesc")}
					value={live.paragraphScalePercent}
					min={TYPOGRAPHY_RANGE.paragraphScalePercent.min}
					max={TYPOGRAPHY_RANGE.paragraphScalePercent.max}
					step={5}
					marks={[
						{ value: 50, label: "50%" },
						{ value: 100, label: "100%" },
						{ value: 250, label: "250%" },
					]}
					onPreview={(v) => setTypography({ paragraphScalePercent: v })}
					onCommit={(v) => commit({ paragraphScalePercent: v })}
				/>

				{!isDefault && (
					<Anchor
						component="button"
						type="button"
						size="xs"
						onClick={() => commit({ ...DEFAULT_TYPOGRAPHY })}
					>
						{t("appearance.reset")}
					</Anchor>
				)}
				<Text size="xs" c="dimmed">
					{t("appearance.scopeNote")}
				</Text>
			</Stack>
		</Box>
	);
}
