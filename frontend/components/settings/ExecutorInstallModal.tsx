import {
	Alert,
	Button,
	Checkbox,
	Code,
	Collapse,
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
import type {
	ExecutorTokenDelivery,
	InstallScriptResult,
	RemoteDevice,
} from "../../lib/api/devices";
import {
	isEnrollableServerBaseUrl,
	isLoopbackServerBaseUrl,
	rememberInstallServerBaseUrl,
	suggestedInstallServerBaseUrl,
} from "../../lib/device-install-url";
import { formatLocaleTime } from "../../lib/intl-format";
import { CopyButton } from "../common/CopyButton";

/**
 * Installing the remote executor on a target machine.
 *
 * The output is one command to paste. Everything the machine needs — server URL,
 * device slug, platform, expected digest, and the device key itself — is carried by
 * the short-lived ticket inside that command, so there is no separate step where a
 * human copies a key between two dialogs.
 *
 * The manual path (operator types the key at a prompt) is still available and is
 * the only option when the key cannot be transported safely, e.g. plaintext http on
 * a routable address.
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
	const [disableShell, setDisableShell] = useState(false);
	const [tokenDelivery, setTokenDelivery] = useState<ExecutorTokenDelivery>("enroll");
	const [serverBaseUrl, setServerBaseUrl] = useState("");
	const [showScript, setShowScript] = useState(false);
	const [result, setResult] = useState<InstallScriptResult | null>(null);
	/** Plaintext key for the manual path only, issued on request. Never persisted. */
	const [revealedToken, setRevealedToken] = useState<string | null>(null);

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

	// Reset per-device state so a previously generated command (and its ticket)
	// never leaks into the next device's dialog.
	useEffect(() => {
		if (!device) return;
		setResult(null);
		setPlatform(null);
		setMode("system");
		setDisableShell(false);
		setTokenDelivery("enroll");
		setShowScript(false);
		setRevealedToken(null);
		setServerBaseUrl(suggestedInstallServerBaseUrl());
	}, [device]);

	useEffect(() => {
		if (platform || publishedPlatforms.length === 0) return;
		// Preselect the platform the device already reported, when we know it.
		const reported = publishedPlatforms.find(
			(info) => info.os === device?.platformOs && info.arch === device?.platformArch,
		);
		setPlatform(reported?.platform ?? publishedPlatforms[0].platform);
	}, [platform, publishedPlatforms, device]);

	const trimmedBaseUrl = serverBaseUrl.trim();
	// Automatic key delivery needs a transport the key can survive. Mirrored from the
	// server rule so the option is visibly unavailable instead of failing on submit;
	// the server still enforces it.
	const canEnroll = isEnrollableServerBaseUrl(trimmedBaseUrl);
	const baseUrlIsLoopback = isLoopbackServerBaseUrl(trimmedBaseUrl);
	const effectiveDelivery: ExecutorTokenDelivery = canEnroll ? tokenDelivery : "prompt";

	const generateMut = useMutation({
		mutationFn: () => {
			if (!device || !platform) throw new Error("No platform selected");
			return api.createInstallScript(device.id, {
				platform,
				mode,
				disableShell,
				// Always sent: the server's fallback is the request origin, which is right
				// for a plain reverse proxy but wrong whenever the target machine reaches
				// this server by another name.
				serverBaseUrl: trimmedBaseUrl || undefined,
				tokenDelivery: effectiveDelivery,
			});
		},
		onSuccess: (generated) => {
			setResult(generated);
			if (trimmedBaseUrl) rememberInstallServerBaseUrl(trimmedBaseUrl);
		},
		onError: (error) =>
			notifications.show({
				color: "red",
				message: error instanceof Error ? error.message : String(error),
			}),
	});

	/**
	 * Issues the key the manual path asks the operator to type.
	 *
	 * Rotation, not retrieval — the stored key is hashed and cannot be read back.
	 * That is also why this is behind a button rather than fetched with the script:
	 * rotating invalidates whatever the device is currently using, so it must be a
	 * deliberate act by someone who is about to install.
	 */
	const revealKeyMut = useMutation({
		mutationFn: () => {
			if (!device) throw new Error("No device selected");
			return api.rotateDeviceToken(device.id);
		},
		onSuccess: (issued) => setRevealedToken(issued.token),
		onError: (error) =>
			notifications.show({
				color: "red",
				message: error instanceof Error ? error.message : String(error),
			}),
	});

	/** Any option change invalidates the generated command and its ticket. */
	const invalidate = () => {
		setResult(null);
		setShowScript(false);
		// The key belongs to the command it was issued for: a regenerated command in
		// enroll mode rotates again, so a stale plaintext key on screen would be wrong.
		setRevealedToken(null);
	};

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
							invalidate();
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
							invalidate();
						}}
						allowDeselect={false}
					/>

					<TextInput
						label={t("executorInstallServerUrl")}
						description={t("executorInstallServerUrlHelp")}
						placeholder="https://narrafork.example.com"
						value={serverBaseUrl}
						onChange={(event) => {
							setServerBaseUrl(event.currentTarget.value);
							invalidate();
						}}
					/>
					{baseUrlIsLoopback ? (
						<Alert color="yellow" variant="light">
							{t("executorInstallServerUrlLoopback")}
						</Alert>
					) : null}

					<Select
						label={t("executorInstallTokenDelivery")}
						description={t("executorInstallTokenDeliveryHelp")}
						data={[
							{
								value: "enroll",
								label: t("executorInstallTokenDeliveryAuto"),
								disabled: !canEnroll,
							},
							{ value: "prompt", label: t("executorInstallTokenDeliveryManual") },
						]}
						value={effectiveDelivery}
						onChange={(value) => {
							setTokenDelivery((value as ExecutorTokenDelivery) ?? "enroll");
							invalidate();
						}}
						allowDeselect={false}
					/>
					{!canEnroll ? (
						<Alert color="yellow" variant="light">
							{t("executorInstallTokenDeliveryUnavailable")}
						</Alert>
					) : null}

					<Alert color="blue" variant="light">
						{t("executorInstallPathGuardLater")}
					</Alert>

					<Checkbox
						label={t("executorInstallDisableShell")}
						description={t("executorInstallDisableShellHelp")}
						checked={disableShell}
						onChange={(event) => {
							setDisableShell(event.currentTarget.checked);
							invalidate();
						}}
					/>

					<Group justify="flex-end">
						<Button
							loading={generateMut.isPending}
							disabled={!platform}
							onClick={() => generateMut.mutate()}
						>
							{t("executorInstallGenerate")}
						</Button>
					</Group>

					{result ? (
						<>
							<Divider />
							<Text fw={600} size="sm">
								{t("executorInstallRunOneLiner", {
									shell: result.shell === "sh" ? "sh" : "PowerShell",
								})}
							</Text>
							<Code block style={{ overflowWrap: "anywhere" }}>
								{result.oneLiner}
							</Code>
							<Group>
								<CopyButton value={result.oneLiner}>
									{({ copied, copy }) => (
										<Button onClick={copy}>
											{copied ? t("copied") : t("executorInstallCopyCommand")}
										</Button>
									)}
								</CopyButton>
								<Text size="xs" c="dimmed">
									{t("executorInstallTicketExpires", {
										time: formatLocaleTime(result.expiresAt),
									})}
								</Text>
							</Group>
							<Alert color={result.tokenDelivery === "enroll" ? "blue" : "yellow"} variant="light">
								<Stack gap="xs">
									<Text size="sm">
										{result.tokenDelivery === "enroll"
											? t("executorInstallEnrollNotice")
											: t("executorInstallTokenReminder")}
									</Text>
									{/*
									 * Manual mode needs a key the operator does not have: registration stopped
									 * displaying it (the installer normally rotates it anyway), so without this
									 * the only way forward is to close the dialog and rotate from the device
									 * card. Issuing it here keeps the one flow that genuinely requires a
									 * visible key self-contained.
									 */}
									{result.tokenDelivery === "prompt" ? (
										revealedToken ? (
											<>
												<Code block style={{ overflowWrap: "anywhere" }}>
													{revealedToken}
												</Code>
												<Group gap="xs">
													<CopyButton value={revealedToken}>
														{({ copied, copy }) => (
															<Button onClick={copy} variant="light" size="xs">
																{copied ? t("copied") : t("executorInstallCopyKey")}
															</Button>
														)}
													</CopyButton>
													<Text size="xs" c="dimmed">
														{t("executorInstallKeyRotatedNotice")}
													</Text>
												</Group>
											</>
										) : (
											<Group gap="xs">
												<Button
													variant="light"
													size="xs"
													loading={revealKeyMut.isPending}
													onClick={() => revealKeyMut.mutate()}
												>
													{t("executorInstallRevealKey")}
												</Button>
												<Text size="xs" c="dimmed">
													{t("executorInstallRevealKeyHelp")}
												</Text>
											</Group>
										)
									) : null}
								</Stack>
							</Alert>

							<Button variant="subtle" size="xs" onClick={() => setShowScript((open) => !open)}>
								{showScript ? t("executorInstallHideScript") : t("executorInstallShowScript")}
							</Button>
							<Collapse expanded={showScript}>
								<Stack gap="xs">
									<Text size="xs" c="dimmed">
										{t("executorInstallRunWith", {
											shell: result.shell === "sh" ? "sh" : "PowerShell",
											filename: result.filename,
										})}
									</Text>
									<Code block style={{ maxHeight: 320, overflow: "auto" }}>
										{result.script}
									</Code>
									<CopyButton value={result.script}>
										{({ copied, copy }) => (
											<Button onClick={copy} variant="default" size="xs">
												{copied ? t("copied") : t("executorInstallCopyScript")}
											</Button>
										)}
									</CopyButton>
								</Stack>
							</Collapse>
						</>
					) : null}
				</Stack>
			)}
		</Modal>
	);
}
