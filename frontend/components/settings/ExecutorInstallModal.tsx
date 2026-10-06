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
	SegmentedControl,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { ExecutorPlatform } from "@shared/remote-executor";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type {
	ExecutorTokenDelivery,
	InstallScriptResult,
	RemoteDevice,
} from "../../lib/api/devices";
import {
	isEnrollableServerBaseUrl,
	rememberInstallServerBaseUrl,
	suggestedInstallServerBaseUrl,
} from "../../lib/device-install-url";
import { formatLocaleTime } from "../../lib/intl-format";
import { CopyButton } from "../common/CopyButton";
import {
	InstallCommandCache,
	installCommandExpired,
	installUrlProblem,
} from "./executor-install-command";

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
	const deviceId = device?.id;
	const [initializedDevice, setInitializedDevice] = useState<string | undefined>();
	const [platform, setPlatform] = useState<ExecutorPlatform | null>(null);
	const [mode, setMode] = useState<"system" | "user">("system");
	const [disableShell, setDisableShell] = useState(false);
	const [tokenDelivery, setTokenDelivery] = useState<ExecutorTokenDelivery>("enroll");
	const [confirmedLoopback, setConfirmedLoopback] = useState<string | null>(null);
	const [advanced, setAdvanced] = useState(false);
	const [pending, setPending] = useState(false);
	const [commandError, setCommandError] = useState<string | null>(null);
	const [refresh, setRefresh] = useState(0);
	const [now, setNow] = useState(Date.now());
	const cache = useRef(new InstallCommandCache());
	const activeDevice = useRef(device?.id);
	activeDevice.current = device?.id;
	const [debouncedUrl, setDebouncedUrl] = useState("");
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
		cache.current = new InstallCommandCache();
		setResult(null);
		setInitializedDevice(deviceId);
		if (!deviceId) return;
		setPlatform(null);
		setMode("system");
		setDisableShell(false);
		setTokenDelivery("enroll");
		setConfirmedLoopback(null);
		setAdvanced(false);
		setDebouncedUrl("");
		setRefresh(0);
		setShowScript(false);
		setRevealedToken(null);
		setServerBaseUrl(suggestedInstallServerBaseUrl());
	}, [deviceId]);

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
	const urlProblem = installUrlProblem(trimmedBaseUrl);
	const effectiveDelivery: ExecutorTokenDelivery = canEnroll ? tokenDelivery : "prompt";
	const urlBlocked =
		urlProblem === "invalid" || (urlProblem === "loopback" && confirmedLoopback !== trimmedBaseUrl);

	useEffect(() => {
		setConfirmedLoopback((confirmed) => (confirmed === trimmedBaseUrl ? confirmed : null));
	}, [trimmedBaseUrl]);

	useEffect(() => {
		if (!deviceId) return;
		const timer = setTimeout(() => setDebouncedUrl(trimmedBaseUrl), 400);
		return () => clearTimeout(timer);
	}, [trimmedBaseUrl, deviceId]);

	useEffect(() => {
		// Explicit retry changes the request generation; expiration itself does not.
		void refresh;
		let current = true;
		setResult(null);
		setCommandError(null);
		setPending(false);
		if (
			!device?.id ||
			initializedDevice !== device.id ||
			!platform ||
			!manifestData?.manifest ||
			urlBlocked ||
			debouncedUrl !== trimmedBaseUrl
		)
			return;
		const input = {
			platform,
			mode,
			disableShell,
			serverBaseUrl: trimmedBaseUrl,
			tokenDelivery: effectiveDelivery,
		};
		const key = cache.current.key(device.id, input, manifestData.manifest.version);
		setPending(true);
		cache.current
			.get(key, () => api.createInstallScript(device.id, input))
			.then(
				(generated) => {
					if (!current) return;
					setResult(generated);
					setPending(false);
					rememberInstallServerBaseUrl(trimmedBaseUrl);
				},
				(error: unknown) => {
					if (!current) return;
					setPending(false);
					setCommandError(error instanceof Error ? error.message : String(error));
				},
			);
		return () => {
			current = false;
		};
	}, [
		device?.id,
		platform,
		mode,
		disableShell,
		trimmedBaseUrl,
		debouncedUrl,
		effectiveDelivery,
		manifestData?.manifest,
		urlBlocked,
		refresh,
		initializedDevice,
	]);

	useEffect(() => {
		if (!deviceId) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [deviceId]);

	const diagnostics = useQuery({
		queryKey: ["deviceInstallDiagnostics", device?.id],
		queryFn: () => {
			if (!deviceId) throw new Error("No device selected");
			return api.getDeviceDiagnostics(deviceId);
		},
		enabled: !!device,
		refetchInterval: device ? 2000 : false,
	});
	const expired = !!result && installCommandExpired(result, now);
	const retry = () => {
		if (device && platform && manifestData?.manifest) {
			cache.current.remove(
				cache.current.key(
					device.id,
					{
						platform,
						mode,
						disableShell,
						serverBaseUrl: trimmedBaseUrl,
						tokenDelivery: effectiveDelivery,
					},
					manifestData.manifest.version,
				),
			);
		}
		setRefresh((value) => value + 1);
	};

	/**
	 * Issues the key the manual path asks the operator to type.
	 *
	 * Rotation, not retrieval — the stored key is hashed and cannot be read back.
	 * That is also why this is behind a button rather than fetched with the script:
	 * rotating invalidates whatever the device is currently using, so it must be a
	 * deliberate act by someone who is about to install.
	 */
	const revealKeyMut = useMutation({
		mutationFn: (deviceId: string) => api.rotateDeviceToken(deviceId),
		onSuccess: (issued, deviceId) => {
			if (activeDevice.current === deviceId) setRevealedToken(issued.token);
		},
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
		// Configuration switches never rotate or hide the explicitly issued device key.
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

					<SegmentedControl
						aria-label={t("executorInstallOs", "Operating system")}
						data={[...new Set(publishedPlatforms.map((info) => info.os))].map((os) => ({
							value: os,
							label: os === "darwin" ? "macOS" : os === "windows" ? "Windows" : "Linux",
						}))}
						value={selectedInfo?.os}
						onChange={(os) => {
							const candidates = publishedPlatforms.filter((info) => info.os === os);
							setPlatform(
								(candidates.find((info) => info.arch === selectedInfo?.arch) ?? candidates[0])
									.platform,
							);
							invalidate();
						}}
					/>
					{urlProblem ? (
						<Alert color="yellow">
							<Stack gap="xs">
								<Text>
									{urlProblem === "loopback"
										? t("executorInstallServerUrlLoopback")
										: t(
												"executorInstallServerUrlInvalid",
												"Enter a valid HTTP(S) server URL reachable from the target machine.",
											)}
								</Text>
								<TextInput
									label={t("executorInstallServerUrl")}
									value={serverBaseUrl}
									onChange={(event) => setServerBaseUrl(event.currentTarget.value)}
								/>
								{urlProblem === "loopback" && urlBlocked ? (
									<Button onClick={() => setConfirmedLoopback(trimmedBaseUrl)}>
										{t("executorInstallConfirmLocalHost")}
									</Button>
								) : null}
							</Stack>
						</Alert>
					) : null}
					{pending ? <Loader size="sm" /> : null}
					{commandError ? (
						<Alert color="red">
							<Text>{commandError}</Text>
							<Button onClick={retry}>{t("executorInstallRefresh", "Get a new command")}</Button>
							{effectiveDelivery === "enroll" ? (
								<Button variant="light" onClick={() => setTokenDelivery("prompt")}>
									{t("executorInstallTokenDeliveryManual")}
								</Button>
							) : null}
						</Alert>
					) : null}
					{expired ? (
						<Alert color="yellow">
							<Text>
								{t(
									"executorInstallExpired",
									"This command has expired. Get a new command before installing.",
								)}
							</Text>
							<Button onClick={retry}>{t("executorInstallRefresh", "Get a new command")}</Button>
						</Alert>
					) : null}

					{result && !expired ? (
						<>
							<Divider />
							<Group justify="space-between">
								<Text fw={600} size="sm">
									{t("executorInstallRunOneLiner", {
										shell: result.shell === "sh" ? "sh" : "PowerShell",
									})}
								</Text>
								<Text size="xs" c="dimmed">
									{selectedInfo?.arch}
								</Text>
							</Group>
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
								<Button variant="light" onClick={retry}>
									{t("executorInstallRefresh", "Get a new command")}
								</Button>
								<Text size="xs" c="dimmed">
									{t("executorInstallTicketExpires", {
										time: formatLocaleTime(result.expiresAt),
									})}
								</Text>
							</Group>
							{result.tokenDelivery === "enroll" ? (
								<Text size="sm" c="dimmed">
									{t("executorInstallEnrollNotice")}
								</Text>
							) : (
								<Alert color="yellow" variant="light">
									<Stack gap="xs">
										<Text size="sm">{t("executorInstallTokenReminder")}</Text>
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
														onClick={() => revealKeyMut.mutate(device.id)}
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
							)}
						</>
					) : null}
					{diagnostics.data ? (
						<Alert color={diagnostics.data.online ? "green" : "blue"}>
							<Text>
								{diagnostics.data.online
									? t(
											"executorInstallDeviceOnline",
											"Device is currently online. This does not confirm this installation.",
										)
									: t(`deviceDiagnosticStage_${diagnostics.data.stage}`, diagnostics.data.stage)}
							</Text>
							{!diagnostics.data.online ? (
								<Text size="sm" c="dimmed">
									{t(
										"executorInstallConnectionHelp",
										"Run the command on the target machine. If it stays offline, check the server URL and network access.",
									)}
								</Text>
							) : null}
							{diagnostics.data.lastError ? (
								<Text size="sm">{diagnostics.data.lastError}</Text>
							) : null}
						</Alert>
					) : null}
					{diagnostics.isError ? (
						<Alert color="yellow">{t("deviceDiagnosticsLoadFailed")}</Alert>
					) : null}
					<Button variant="subtle" onClick={() => setAdvanced((open) => !open)}>
						{t("executorInstallAdvanced", "Advanced options")}
					</Button>
					<Collapse expanded={advanced}>
						<Stack>
							<Select
								label={t("executorInstallArchitecture", "Architecture")}
								data={publishedPlatforms
									.filter((info) => info.os === selectedInfo?.os)
									.map((info) => ({ value: info.platform, label: info.arch }))}
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
									setTokenDelivery(value === "enroll" ? "enroll" : "prompt");
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
							{result && !expired ? (
								<>
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
					</Collapse>
				</Stack>
			)}
		</Modal>
	);
}
