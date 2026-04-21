import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Loader,
	Menu,
	NumberInput,
	Paper,
	PasswordInput,
	Select,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { IconPlus, IconQrcode, IconTrash } from "@tabler/icons-react";
import type { UseMutationResult } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { miscApi } from "../../lib/api/misc";

type Platform = "telegram" | "discord" | "slack" | "feishu" | "webhook" | "weixin";

interface PlatformConfig {
	platform: Platform;
	enabled: boolean;
	token?: string;
	botToken?: string;
	appToken?: string;
	appId?: string;
	appSecret?: string;
	secret?: string;
	accountId?: string;
	baseUrl?: string;
	allowedUsers?: string[];
}

interface GatewayConfig {
	enabled?: boolean;
	defaultProjectId?: string;
	defaultChapterId?: string;
	defaultPermissionMode?: string;
	sessionIdleMinutes?: number;
	rateLimitPerMinute?: number;
	streaming?: boolean;
	platforms?: PlatformConfig[];
}

export interface GatewaySectionProps {
	userPrefs: Record<string, unknown> | undefined;
	updateUserPref: UseMutationResult<unknown, unknown, Record<string, unknown>, unknown>;
}

const PLATFORM_LABELS: Record<Platform, string> = {
	telegram: "Telegram",
	discord: "Discord",
	slack: "Slack",
	feishu: "Feishu / Lark",
	webhook: "Webhook",
	weixin: "WeChat",
};

const ALL_PLATFORMS: Platform[] = ["telegram", "discord", "slack", "feishu", "webhook", "weixin"];

export function GatewaySection({ userPrefs, updateUserPref }: GatewaySectionProps) {
	const { t } = useTranslation("settings");
	const [config, setConfig] = useState<GatewayConfig>({});
	const [inited, setInited] = useState(false);

	useEffect(() => {
		if (userPrefs && !inited) {
			const raw = userPrefs.gatewayConfig;
			if (raw && typeof raw === "object") {
				setConfig(raw as GatewayConfig);
			}
			setInited(true);
		}
	}, [userPrefs, inited]);

	const save = useCallback(
		(updated: GatewayConfig) => {
			setConfig(updated);
			updateUserPref.mutate({ gatewayConfig: updated });
		},
		[updateUserPref],
	);

	// Debounced save for NumberInput fields (avoids rapid API calls while typing/dragging)
	const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const debouncedSave = useCallback(
		(updated: GatewayConfig) => {
			setConfig(updated);
			if (debounceTimer.current) clearTimeout(debounceTimer.current);
			debounceTimer.current = setTimeout(() => {
				updateUserPref.mutate({ gatewayConfig: updated });
			}, 500);
		},
		[updateUserPref],
	);

	const updateField = useCallback(
		<K extends keyof GatewayConfig>(key: K, value: GatewayConfig[K]) => {
			save({ ...config, [key]: value });
		},
		[config, save],
	);

	const updateFieldDebounced = useCallback(
		<K extends keyof GatewayConfig>(key: K, value: GatewayConfig[K]) => {
			debouncedSave({ ...config, [key]: value });
		},
		[config, debouncedSave],
	);

	const platforms = config.platforms ?? [];

	const addPlatform = useCallback(
		(platform: Platform) => {
			const existing = platforms.find((p) => p.platform === platform);
			if (existing) return;
			save({
				...config,
				platforms: [...platforms, { platform, enabled: true }],
			});
		},
		[config, platforms, save],
	);

	const removePlatform = useCallback(
		(index: number) => {
			const updated = [...platforms];
			updated.splice(index, 1);
			save({ ...config, platforms: updated });
		},
		[config, platforms, save],
	);

	const updatePlatform = useCallback(
		(index: number, patch: Partial<PlatformConfig>) => {
			const updated = [...platforms];
			updated[index] = { ...updated[index], ...patch };
			save({ ...config, platforms: updated });
		},
		[config, platforms, save],
	);

	const availablePlatforms = ALL_PLATFORMS.filter(
		(p) => !platforms.some((existing) => existing.platform === p),
	);

	return (
		<Stack gap="md">
			<Text size="sm" c="dimmed">
				{t("gatewayDesc")}
			</Text>

			<Switch
				label={t("gatewayEnabled")}
				description={t("gatewayEnabledDesc")}
				checked={config.enabled ?? false}
				onChange={(e) => updateField("enabled", e.currentTarget.checked)}
			/>

			{config.enabled && (
				<>
					<Switch
						label={t("gatewayStreaming")}
						description={t("gatewayStreamingDesc")}
						checked={config.streaming ?? true}
						onChange={(e) => updateField("streaming", e.currentTarget.checked)}
					/>

					<Select
						label={t("gatewayDefaultPermissionMode")}
						description={t("gatewayDefaultPermissionModeDesc")}
						value={config.defaultPermissionMode ?? "bypassPermissions"}
						onChange={(v) => updateField("defaultPermissionMode", v ?? "bypassPermissions")}
						data={[
							{ value: "bypassPermissions", label: t("gatewayPermBypass") },
							{ value: "allowByDefault", label: t("gatewayPermAllow") },
							{ value: "denyByDefault", label: t("gatewayPermDeny") },
						]}
					/>

					<Group grow>
						<NumberInput
							label={t("gatewaySessionIdle")}
							description={t("gatewaySessionIdleDesc")}
							value={config.sessionIdleMinutes ?? 0}
							min={0}
							max={43200}
							onChange={(v) =>
								updateFieldDebounced("sessionIdleMinutes", typeof v === "number" ? v : 0)
							}
						/>
						<NumberInput
							label={t("gatewayRateLimit")}
							description={t("gatewayRateLimitDesc")}
							value={config.rateLimitPerMinute ?? 20}
							min={0}
							max={1000}
							onChange={(v) =>
								updateFieldDebounced("rateLimitPerMinute", typeof v === "number" ? v : 20)
							}
						/>
					</Group>

					<Group grow>
						<TextInput
							label={t("gatewayDefaultProject")}
							description={t("gatewayDefaultProjectDesc")}
							value={config.defaultProjectId ?? ""}
							onChange={(e) => updateField("defaultProjectId", e.currentTarget.value || undefined)}
						/>
						<TextInput
							label={t("gatewayDefaultChapter")}
							description={t("gatewayDefaultChapterDesc")}
							value={config.defaultChapterId ?? ""}
							onChange={(e) => updateField("defaultChapterId", e.currentTarget.value || undefined)}
						/>
					</Group>

					<Group justify="space-between" mt="md">
						<Title order={5}>{t("gatewayPlatforms")}</Title>
						{availablePlatforms.length > 0 && (
							<Menu position="bottom-end">
								<Menu.Target>
									<Button size="xs" variant="light" leftSection={<IconPlus size={14} />}>
										{t("gatewayPlatformAdd")}
									</Button>
								</Menu.Target>
								<Menu.Dropdown>
									{availablePlatforms.map((p) => (
										<Menu.Item key={p} onClick={() => addPlatform(p)}>
											{PLATFORM_LABELS[p]}
										</Menu.Item>
									))}
								</Menu.Dropdown>
							</Menu>
						)}
					</Group>

					{platforms.length === 0 && (
						<Text size="sm" c="dimmed" ta="center" py="md">
							{t("gatewayNoPlatforms")}
						</Text>
					)}

					{platforms.map((platform, index) => (
						<PlatformCard
							key={platform.platform}
							platform={platform}
							index={index}
							onUpdate={updatePlatform}
							onRemove={removePlatform}
						/>
					))}
				</>
			)}
		</Stack>
	);
}

// ---------------------------------------------------------------------------
// Platform card
// ---------------------------------------------------------------------------

function PlatformCard({
	platform,
	index,
	onUpdate,
	onRemove,
}: {
	platform: PlatformConfig;
	index: number;
	onUpdate: (index: number, patch: Partial<PlatformConfig>) => void;
	onRemove: (index: number) => void;
}) {
	const { t } = useTranslation("settings");

	return (
		<Paper withBorder p="md">
			<Stack gap="sm">
				<Group justify="space-between">
					<Group gap="sm">
						<Title order={6}>{PLATFORM_LABELS[platform.platform]}</Title>
						<Switch
							size="xs"
							checked={platform.enabled}
							onChange={(e) => onUpdate(index, { enabled: e.currentTarget.checked })}
							label={t("gatewayPlatformEnabled")}
						/>
					</Group>
					<ActionIcon
						variant="subtle"
						color="red"
						size="sm"
						onClick={() => onRemove(index)}
						title={t("gatewayPlatformRemove")}
					>
						<IconTrash size={14} />
					</ActionIcon>
				</Group>

				{platform.enabled && (
					<PlatformFields platform={platform} index={index} onUpdate={onUpdate} />
				)}
			</Stack>
		</Paper>
	);
}

function PlatformFields({
	platform,
	index,
	onUpdate,
}: {
	platform: PlatformConfig;
	index: number;
	onUpdate: (index: number, patch: Partial<PlatformConfig>) => void;
}) {
	const { t } = useTranslation("settings");

	// Local state for secret fields (save on blur)
	const [token, setToken] = useState(platform.token ?? "");
	const [botToken, setBotToken] = useState(platform.botToken ?? "");
	const [appToken, setAppToken] = useState(platform.appToken ?? "");
	const [appId, setAppId] = useState(platform.appId ?? "");
	const [appSecret, setAppSecret] = useState(platform.appSecret ?? "");
	const [secret, setSecret] = useState(platform.secret ?? "");
	const [allowedUsers, setAllowedUsers] = useState((platform.allowedUsers ?? []).join(", "));

	// Sync from props when platform changes
	useEffect(() => {
		setToken(platform.token ?? "");
		setBotToken(platform.botToken ?? "");
		setAppToken(platform.appToken ?? "");
		setAppId(platform.appId ?? "");
		setAppSecret(platform.appSecret ?? "");
		setSecret(platform.secret ?? "");
		setAllowedUsers((platform.allowedUsers ?? []).join(", "));
	}, [platform]);

	const saveField = (field: string, value: string) => {
		if (value.startsWith("*")) return; // masked value, don't save
		onUpdate(index, { [field]: value });
	};

	const saveAllowedUsers = (value: string) => {
		const users = value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		onUpdate(index, { allowedUsers: users.length > 0 ? users : undefined });
	};

	switch (platform.platform) {
		case "telegram":
		case "discord":
			return (
				<Stack gap="xs">
					<PasswordInput
						label={t("gatewayPlatformToken")}
						value={token}
						onChange={(e) => setToken(e.currentTarget.value)}
						onBlur={() => saveField("token", token)}
					/>
					<TextInput
						label={t("gatewayPlatformAllowedUsers")}
						description={t("gatewayPlatformAllowedUsersDesc")}
						value={allowedUsers}
						onChange={(e) => setAllowedUsers(e.currentTarget.value)}
						onBlur={() => saveAllowedUsers(allowedUsers)}
					/>
				</Stack>
			);

		case "slack":
			return (
				<Stack gap="xs">
					<PasswordInput
						label={t("gatewayPlatformBotToken")}
						value={botToken}
						onChange={(e) => setBotToken(e.currentTarget.value)}
						onBlur={() => saveField("botToken", botToken)}
					/>
					<PasswordInput
						label={t("gatewayPlatformAppToken")}
						value={appToken}
						onChange={(e) => setAppToken(e.currentTarget.value)}
						onBlur={() => saveField("appToken", appToken)}
					/>
					<TextInput
						label={t("gatewayPlatformAllowedUsers")}
						description={t("gatewayPlatformAllowedUsersDesc")}
						value={allowedUsers}
						onChange={(e) => setAllowedUsers(e.currentTarget.value)}
						onBlur={() => saveAllowedUsers(allowedUsers)}
					/>
				</Stack>
			);

		case "feishu":
			return (
				<Stack gap="xs">
					<TextInput
						label={t("gatewayPlatformAppId")}
						value={appId}
						onChange={(e) => setAppId(e.currentTarget.value)}
						onBlur={() => saveField("appId", appId)}
					/>
					<PasswordInput
						label={t("gatewayPlatformAppSecret")}
						value={appSecret}
						onChange={(e) => setAppSecret(e.currentTarget.value)}
						onBlur={() => saveField("appSecret", appSecret)}
					/>
					<TextInput
						label={t("gatewayPlatformAllowedUsers")}
						description={t("gatewayPlatformAllowedUsersDesc")}
						value={allowedUsers}
						onChange={(e) => setAllowedUsers(e.currentTarget.value)}
						onBlur={() => saveAllowedUsers(allowedUsers)}
					/>
				</Stack>
			);

		case "webhook":
			return (
				<Stack gap="xs">
					<PasswordInput
						label={t("gatewayPlatformSecret")}
						value={secret}
						onChange={(e) => setSecret(e.currentTarget.value)}
						onBlur={() => saveField("secret", secret)}
					/>
				</Stack>
			);

		case "weixin":
			return (
				<WeixinFields
					platform={platform}
					index={index}
					onUpdate={onUpdate}
					token={token}
					allowedUsers={allowedUsers}
					setAllowedUsers={setAllowedUsers}
					saveAllowedUsers={saveAllowedUsers}
				/>
			);

		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// WeChat QR login + fields
// ---------------------------------------------------------------------------

type QrStatus = "idle" | "wait" | "scaned" | "confirmed" | "expired" | "error";

function WeixinFields({
	platform,
	index,
	onUpdate,
	token,
	allowedUsers,
	setAllowedUsers,
	saveAllowedUsers,
}: {
	platform: PlatformConfig;
	index: number;
	onUpdate: (index: number, patch: Partial<PlatformConfig>) => void;
	token: string;
	allowedUsers: string;
	setAllowedUsers: (v: string) => void;
	saveAllowedUsers: (v: string) => void;
}) {
	const { t } = useTranslation("settings");
	const [qrStatus, setQrStatus] = useState<QrStatus>("idle");
	const [qrUrl, setQrUrl] = useState<string | null>(null);
	const [qrError, setQrError] = useState<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// Cleanup polling on unmount
	useEffect(() => {
		return () => {
			if (pollRef.current) clearInterval(pollRef.current);
		};
	}, []);

	const stopPolling = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);

	const startQrLogin = useCallback(async () => {
		setQrStatus("wait");
		setQrError(null);
		setQrUrl(null);
		stopPolling();

		try {
			const res = await miscApi.gatewayWeixinQrStart();
			setQrUrl(res.qrcodeUrl);

			// Start polling
			pollRef.current = setInterval(async () => {
				try {
					const poll = await miscApi.gatewayWeixinQrPoll();

					if (poll.status === "scaned") {
						setQrStatus("scaned");
					} else if (poll.status === "confirmed") {
						stopPolling();
						setQrStatus("confirmed");
						setQrUrl(null);
						// Auto-fill credentials
						onUpdate(index, {
							token: poll.token,
							accountId: poll.accountId,
							baseUrl: poll.baseUrl,
						});
					} else if (poll.status === "expired") {
						if (poll.canRefresh && poll.qrcodeUrl) {
							// QR refreshed, update URL
							setQrUrl(poll.qrcodeUrl);
							setQrStatus("wait");
						} else {
							stopPolling();
							setQrStatus("expired");
							setQrUrl(null);
						}
					} else if (poll.status === "error") {
						stopPolling();
						setQrStatus("error");
						setQrError(poll.message ?? "Unknown error");
						setQrUrl(null);
					}
					// "wait" → keep polling
				} catch {
					stopPolling();
					setQrStatus("error");
					setQrError("Polling failed");
					setQrUrl(null);
				}
			}, 2000);
		} catch (err) {
			setQrStatus("error");
			setQrError(err instanceof Error ? err.message : String(err));
		}
	}, [index, onUpdate, stopPolling]);

	const statusBadge = () => {
		switch (qrStatus) {
			case "wait":
				return (
					<Badge color="blue" variant="light" leftSection={<Loader size={10} />}>
						{t("gatewayWeixinQrScanning")}
					</Badge>
				);
			case "scaned":
				return (
					<Badge color="yellow" variant="light" leftSection={<Loader size={10} />}>
						{t("gatewayWeixinQrScaned")}
					</Badge>
				);
			case "confirmed":
				return (
					<Badge color="green" variant="light">
						{t("gatewayWeixinQrConfirmed")}
					</Badge>
				);
			case "expired":
				return (
					<Badge color="orange" variant="light">
						{t("gatewayWeixinQrExpired")}
					</Badge>
				);
			case "error":
				return (
					<Badge color="red" variant="light">
						{qrError ?? "Error"}
					</Badge>
				);
			default:
				return null;
		}
	};

	const hasCredentials = !!(platform.accountId && platform.token);

	return (
		<Stack gap="xs">
			<Text size="xs" c="dimmed">
				{t("gatewayWeixinDesc")}
			</Text>

			{/* QR login section */}
			<Group gap="sm">
				<Button
					size="xs"
					variant="light"
					leftSection={<IconQrcode size={14} />}
					onClick={startQrLogin}
					loading={qrStatus === "wait" || qrStatus === "scaned"}
				>
					{t("gatewayWeixinQrStart")}
				</Button>
				{statusBadge()}
			</Group>

			{qrUrl && (
				<Button
					component="a"
					href={qrUrl}
					target="_blank"
					rel="noopener noreferrer"
					size="xs"
					variant="outline"
					leftSection={<IconQrcode size={14} />}
				>
					{t("gatewayWeixinQrScanning")}
				</Button>
			)}

			{/* Credentials (read-only, filled by QR login) */}
			{hasCredentials && (
				<>
					<TextInput
						label={t("gatewayWeixinAccountId")}
						value={platform.accountId ?? ""}
						readOnly
						variant="filled"
					/>
					<PasswordInput
						label={t("gatewayWeixinToken")}
						value={token || platform.token || ""}
						readOnly
						variant="filled"
					/>
				</>
			)}

			<TextInput
				label={t("gatewayWeixinAllowedUsers")}
				description={t("gatewayWeixinAllowedUsersDesc")}
				value={allowedUsers}
				onChange={(e) => setAllowedUsers(e.currentTarget.value)}
				onBlur={() => saveAllowedUsers(allowedUsers)}
			/>
		</Stack>
	);
}
