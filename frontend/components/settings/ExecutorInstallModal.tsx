import {
	Alert,
	Button,
	Checkbox,
	Code,
	Divider,
	Group,
	Loader,
	Modal,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { ExecutorPlatform } from "@shared/remote-executor";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type { InstallScriptResult, RemoteDevice } from "../../lib/api/devices";
import { formatLocaleTime } from "../../lib/intl-format";
import { CopyButton } from "../common/CopyButton";

/**
 * Guides an operator through installing the remote executor on a target machine.
 *
 * The generated script carries the real server URL, device slug, platform and
 * expected digest, so the only thing left to do by hand is paste the registration
 * key when the script prompts for it.
 */
export function ExecutorInstallModal({
	device,
	onClose,
}: {
	device: RemoteDevice | null;
	onClose: () => void;
}) {
	const { t } = useTranslation("settings");
	const [platform, setPlatform] = useState<ExecutorPlatform | null>(null);
	const [mode, setMode] = useState<"system" | "user">("system");
	const [allowRoot, setAllowRoot] = useState("");
	const [disableShell, setDisableShell] = useState(false);
	const [result, setResult] = useState<InstallScriptResult | null>(null);

	const { data: manifestData, isLoading: manifestLoading } = useQuery({
		queryKey: ["executorManifest"],
		queryFn: () => api.getExecutorManifest(),
		enabled: !!device,
	});

	const publishedPlatforms = useMemo(() => {
		const manifest = manifestData?.manifest;
		if (!manifest) return [];
		return (manifestData?.platforms ?? []).filter((info) => manifest.platforms[info.platform]);
	}, [manifestData]);

	// Reset per-device state so a previously generated script (and its one-time
	// ticket) never leaks into the next device's dialog.
	useEffect(() => {
		if (!device) return;
		setResult(null);
		setPlatform(null);
		setMode("system");
		setAllowRoot(device.defaultCwd ?? "");
		setDisableShell(false);
	}, [device]);

	useEffect(() => {
		if (platform || publishedPlatforms.length === 0) return;
		// Preselect the platform the device already reported, when we know it.
		const reported = publishedPlatforms.find(
			(info) => info.os === device?.platformOs && info.arch === device?.platformArch,
		);
		setPlatform(reported?.platform ?? publishedPlatforms[0].platform);
	}, [platform, publishedPlatforms, device]);

	const generateMut = useMutation({
		mutationFn: () => {
			if (!device || !platform) throw new Error("No platform selected");
			return api.createInstallScript(device.id, {
				platform,
				mode,
				allowRoot: allowRoot.trim(),
				disableShell,
			});
		},
		onSuccess: setResult,
		onError: (error) =>
			notifications.show({
				color: "red",
				message: error instanceof Error ? error.message : String(error),
			}),
	});

	const selectedInfo = publishedPlatforms.find((info) => info.platform === platform);
	const manifest = manifestData?.manifest;

	return (
		<Modal opened={!!device} onClose={onClose} title={t("executorInstallTitle")} size="xl">
			{!device ? null : manifestLoading ? (
				<Loader />
			) : !manifest ? (
				<Alert color="yellow">{t("executorInstallNoRelease")}</Alert>
			) : (
				<Stack>
					<Text size="sm" c="dimmed">
						{t("executorInstallIntro", { name: device.name, version: manifest.version })}
					</Text>

					<Select
						label={t("executorInstallPlatform")}
						data={publishedPlatforms.map((info) => ({
							value: info.platform,
							label: info.label,
						}))}
						value={platform}
						onChange={(value) => {
							setPlatform(value as ExecutorPlatform | null);
							setResult(null);
						}}
						allowDeselect={false}
					/>

					{selectedInfo && !selectedInfo.supportsPty ? (
						<Alert color="yellow" variant="light">
							{t("executorInstallNoPty")}
						</Alert>
					) : null}

					<Select
						label={t("executorInstallMode")}
						description={t("executorInstallModeHelp")}
						data={[
							{ value: "system", label: t("executorInstallModeSystem") },
							{ value: "user", label: t("executorInstallModeUser") },
						]}
						value={mode}
						onChange={(value) => {
							setMode((value as "system" | "user") ?? "system");
							setResult(null);
						}}
						allowDeselect={false}
					/>

					<TextInput
						label={t("executorInstallAllowRoot")}
						description={t("executorInstallAllowRootHelp")}
						placeholder={
							selectedInfo?.os === "windows" ? "C:\\work\\projects" : "/home/you/projects"
						}
						value={allowRoot}
						onChange={(event) => {
							setAllowRoot(event.currentTarget.value);
							setResult(null);
						}}
					/>

					<Checkbox
						label={t("executorInstallDisableShell")}
						description={t("executorInstallDisableShellHelp")}
						checked={disableShell}
						onChange={(event) => {
							setDisableShell(event.currentTarget.checked);
							setResult(null);
						}}
					/>

					<Group justify="flex-end">
						<Button
							loading={generateMut.isPending}
							disabled={!platform || !allowRoot.trim()}
							onClick={() => generateMut.mutate()}
						>
							{t("executorInstallGenerate")}
						</Button>
					</Group>

					{result ? (
						<>
							<Divider />
							<Alert color="blue" variant="light">
								{t("executorInstallTokenReminder")}
							</Alert>
							<Text size="sm">
								{t("executorInstallRunWith", {
									shell: result.shell === "sh" ? "sh" : "PowerShell",
									filename: result.filename,
								})}
							</Text>
							<Code block style={{ maxHeight: 320, overflow: "auto" }}>
								{result.script}
							</Code>
							<Group>
								<CopyButton value={result.script}>
									{({ copied, copy }) => (
										<Button onClick={copy} variant="light">
											{copied ? t("copied") : t("executorInstallCopyScript")}
										</Button>
									)}
								</CopyButton>
								<Text size="xs" c="dimmed">
									{t("executorInstallTicketExpires", {
										time: formatLocaleTime(result.expiresAt),
									})}
								</Text>
							</Group>
						</>
					) : null}
				</Stack>
			)}
		</Modal>
	);
}
