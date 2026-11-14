/**
 * Wallpaper picker: a remote image URL with readability controls.
 *
 * Everything here is a device preference (no upload, no server storage), so the card only
 * needs the stored choice plus the two numbers that keep text legible over a photo.
 */

import { useAppBackground } from "@frontend/hooks/useAppBackground";
import { checkBackgroundUrl, DEFAULT_BACKGROUND, MIN_OPACITY } from "@frontend/lib/app-background";
import { Box, Button, Group, Slider, Stack, Switch, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function BackgroundCard() {
	const { t } = useTranslation("settings");
	const { choice, setChoice } = useAppBackground();
	const [draft, setDraft] = useState(choice.url);
	const [touched, setTouched] = useState(false);

	const check = checkBackgroundUrl(draft);
	const error = touched && draft.trim().length > 0 && !check.ok ? check.reason : null;
	const errorText =
		error === "protocol" ? t("bgInvalidProtocol") : error ? t("bgInvalidMalformed") : undefined;

	const commit = (url: string) => {
		setDraft(url);
		if (checkBackgroundUrl(url).ok) {
			setChoice({ ...choice, url: url.trim(), enabled: true });
		}
	};

	return (
		<Stack gap="sm" mt="md">
			<div>
				<Text fw={600} size="sm">
					{t("bgSection")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("bgDesc")}
				</Text>
			</div>

			<Group align="flex-end" gap="sm" wrap="nowrap">
				<TextInput
					size="xs"
					style={{ flex: 1, maxWidth: 520 }}
					label={t("bgUrlLabel")}
					description={t("bgUrlHint")}
					placeholder="https://example.com/wallpaper.webp"
					value={draft}
					error={errorText}
					onBlur={() => setTouched(true)}
					onChange={(event) => {
						setTouched(true);
						commit(event.currentTarget.value);
					}}
				/>
				{choice.enabled ? (
					<Button
						size="xs"
						variant="default"
						onClick={() => {
							setDraft("");
							setTouched(false);
							setChoice({ ...DEFAULT_BACKGROUND });
						}}
					>
						{t("bgClear")}
					</Button>
				) : null}
			</Group>

			<Group gap="lg" align="flex-start" wrap="nowrap">
				<Box style={{ width: 260 }}>
					<Text size="xs" mb={4}>
						{t("bgOpacity")}
					</Text>
					<Slider
						size="xs"
						min={MIN_OPACITY}
						max={100}
						value={choice.opacity}
						onChange={(value) => setChoice({ ...choice, opacity: value })}
						marks={[
							{ value: MIN_OPACITY, label: `${MIN_OPACITY}%` },
							{ value: 100, label: "100%" },
						]}
					/>
				</Box>
				<Box style={{ width: 260 }}>
					<Text size="xs" mb={4}>
						{t("bgScrim")}
					</Text>
					<Slider
						size="xs"
						min={0}
						max={90}
						value={choice.scrim}
						onChange={(value) => setChoice({ ...choice, scrim: value })}
						marks={[
							{ value: 0, label: "0%" },
							{ value: 90, label: "90%" },
						]}
					/>
				</Box>
				<Box style={{ width: 200 }}>
					<Text size="xs" mb={4}>
						{t("bgBlur")}
					</Text>
					<Slider
						size="xs"
						min={0}
						max={24}
						value={choice.blur}
						onChange={(value) => setChoice({ ...choice, blur: value })}
						marks={[
							{ value: 0, label: t("bgBlurSharp") },
							{ value: 24, label: t("bgBlurSoft") },
						]}
					/>
				</Box>
				{choice.enabled ? (
					<Box
						aria-label={t("bgPreview")}
						style={{
							width: 96,
							height: 56,
							borderRadius: 6,
							border: "1px solid var(--mantine-color-default-border)",
							backgroundImage: `url("${choice.url.replace(/"/g, "%22")}")`,
							backgroundSize: "cover",
							backgroundPosition: "center",
						}}
					/>
				) : null}
			</Group>

			<Switch
				size="xs"
				label={t("bgEnable")}
				description={t("bgPrivacy")}
				checked={choice.enabled}
				disabled={!choice.url}
				onChange={(event) => setChoice({ ...choice, enabled: event.currentTarget.checked })}
			/>
		</Stack>
	);
}
