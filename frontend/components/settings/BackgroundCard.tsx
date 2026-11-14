/**
 * Wallpaper picker: a remote URL or a local file, with readability controls.
 *
 * Local files never leave the device: the blob is stored in IndexedDB and served through an
 * object URL, so this works offline and cannot be blocked by a host's hotlink protection.
 * A remote URL is fetched by the browser on every load — the card says so.
 */

import { useAppBackground } from "@frontend/hooks/useAppBackground";
import {
	checkBackgroundUrl,
	DEFAULT_BACKGROUND,
	MIN_OPACITY,
	switchBackgroundSource,
} from "@frontend/lib/app-background";
import { clearWallpaperBlob, saveWallpaperBlob } from "@frontend/lib/wallpaper-store";
import {
	Alert,
	Badge,
	Box,
	Button,
	FileButton,
	Group,
	SegmentedControl,
	SimpleGrid,
	Slider,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { IconAlertTriangle, IconPhoto, IconRefresh, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function BackgroundCard() {
	const { t } = useTranslation("settings");
	const { choice, setChoice, status, reload } = useAppBackground();
	const [draft, setDraft] = useState(choice.url);
	const [touched, setTouched] = useState(false);

	const check = checkBackgroundUrl(draft);
	const showUrlError = touched && draft.trim().length > 0 && !check.ok;
	const errorMessage =
		check.ok || !showUrlError
			? null
			: check.reason === "protocol"
				? t("bgInvalidProtocol")
				: t("bgInvalidMalformed");

	const commitUrl = (url: string) => {
		setDraft(url);
		if (checkBackgroundUrl(url).ok) {
			setChoice({ ...choice, source: "url", url: url.trim(), enabled: true });
		}
	};

	const pickFile = async (file: File | null) => {
		if (!file) return;
		await saveWallpaperBlob(file);
		setTouched(false);
		// Keep the URL: switching back to "Remote URL" must not lose the address.
		setChoice({
			...choice,
			source: "file",
			fileName: file.name,
			enabled: true,
		});
	};

	const clearAll = async () => {
		await clearWallpaperBlob();
		setDraft("");
		setTouched(false);
		setChoice({ ...DEFAULT_BACKGROUND });
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

			<SegmentedControl
				size="xs"
				value={choice.source}
				onChange={(value) =>
					setChoice(switchBackgroundSource(choice, value === "file" ? "file" : "url"))
				}
				data={[
					{ value: "url", label: t("bgSourceUrl") },
					{ value: "file", label: t("bgSourceFile") },
				]}
				style={{ alignSelf: "flex-start" }}
			/>

			{choice.source === "url" ? (
				<Group align="flex-end" gap="xs" wrap="nowrap">
					<TextInput
						size="xs"
						style={{ maxWidth: 620 }}
						label={t("bgUrlLabel")}
						description={t("bgUrlHint")}
						placeholder="https://example.com/wallpaper.webp"
						value={draft}
						error={errorMessage}
						onBlur={() => setTouched(true)}
						onChange={(event) => {
							setTouched(true);
							commitUrl(event.currentTarget.value);
						}}
					/>
					<Button
						size="xs"
						variant="default"
						leftSection={<IconRefresh size={12} />}
						disabled={!check.ok}
						onClick={reload}
					>
						{t("bgReload")}
					</Button>
				</Group>
			) : (
				<Group gap="sm" align="center">
					<FileButton
						accept="image/*"
						onChange={(file) => {
							void pickFile(file);
						}}
					>
						{(props) => (
							<Button {...props} size="xs" variant="default" leftSection={<IconPhoto size={13} />}>
								{t("bgPickFile")}
							</Button>
						)}
					</FileButton>
					{choice.fileName ? (
						<Text size="xs" c="dimmed">
							{choice.fileName}
						</Text>
					) : (
						<Text size="xs" c="dimmed">
							{t("bgNoFile")}
						</Text>
					)}
				</Group>
			)}

			{/* A one-line state readout: without it a failed load is indistinguishable from
			    "the wallpaper is too subtle to see", which is exactly the confusion this card
			    caused before. */}
			<Group gap={6}>
				<Text size="xs" c="dimmed">
					{t("bgStatus")}
				</Text>
				<Badge
					size="xs"
					variant="light"
					color={
						status === "ok"
							? "green"
							: status === "error"
								? "red"
								: status === "loading"
									? "gray"
									: "gray"
					}
				>
					{status === "ok"
						? t("bgStatusLoaded")
						: status === "error"
							? t("bgStatusFailed")
							: status === "loading"
								? t("bgStatusLoading")
								: t("bgStatusOff")}
				</Badge>
			</Group>

			{status === "error" ? (
				<Alert
					color="red"
					variant="light"
					icon={<IconAlertTriangle size={14} />}
					title={t("bgLoadFailed")}
					style={{ maxWidth: 620 }}
				>
					<Text size="xs">{t("bgLoadFailedHint")}</Text>
				</Alert>
			) : null}

			<SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md" verticalSpacing="xs">
				<Box>
					<Text size="xs" mb={4}>
						{t("bgOpacity")}
					</Text>
					<Slider
						size="xs"
						min={MIN_OPACITY}
						max={100}
						value={choice.opacity}
						label={(value) => `${value}%`}
						onChange={(value) => setChoice({ ...choice, opacity: value })}
					/>
				</Box>
				<Box>
					<Text size="xs" mb={4}>
						{t("bgScrim")}
					</Text>
					<Slider
						size="xs"
						min={0}
						max={90}
						value={choice.scrim}
						label={(value) => `${value}%`}
						onChange={(value) => setChoice({ ...choice, scrim: value })}
					/>
				</Box>
				<Box>
					<Text size="xs" mb={4}>
						{t("bgBlur")}
					</Text>
					<Slider
						size="xs"
						min={0}
						max={24}
						value={choice.blur}
						label={(value) => `${value}px`}
						onChange={(value) => setChoice({ ...choice, blur: value })}
					/>
				</Box>
			</SimpleGrid>

			<Group gap="sm" align="center" wrap="wrap">
				<Switch
					size="xs"
					label={t("bgEnable")}
					checked={choice.enabled}
					disabled={choice.source === "url" ? !choice.url : !choice.fileName}
					onChange={(event) => setChoice({ ...choice, enabled: event.currentTarget.checked })}
				/>
				<Button
					size="xs"
					variant="subtle"
					color="gray"
					leftSection={<IconX size={12} />}
					onClick={() => {
						void clearAll();
					}}
				>
					{t("bgClear")}
				</Button>
			</Group>

			<Text size="xs" c="dimmed" style={{ maxWidth: 620 }}>
				{choice.source === "url" ? t("bgPrivacy") : t("bgLocalPrivacy")}
			</Text>
		</Stack>
	);
}
