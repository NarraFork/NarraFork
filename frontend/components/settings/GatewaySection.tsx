import {
	ActionIcon,
	Anchor,
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
	Transition,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDeviceFloppy, IconPlus, IconQrcode, IconTrash } from "@tabler/icons-react";
import type { UseMutationResult } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGatewayCapability } from "../../hooks/usePlatform";
import { miscApi } from "../../lib/api/misc";

type Platform = "telegram" | "discord" | "slack" | "feishu" | "webhook" | "weixin" | "qqbot";

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
	// QQ Bot specific
	clientSecret?: string;
	allowedGroups?: string[];
	dmPolicy?: string;
	groupPolicy?: string;
	markdownSupport?: boolean;
	sandbox?: boolean;
	stt?: {
		apiKey: string;
		baseUrl?: string;
		model?: string;
	};
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
	qqbot: "QQ Bot",
};

const ALL_PLATFORMS: Platform[] = [
	"telegram",
	"discord",
	"slack",
	"feishu",
	"webhook",
	"weixin",
	"qqbot",
];

const GATEWAY_PERMISSION_MODES = [
	"default",
	"acceptEdits",
	"bypassPermissions",
	"readOnly",
	"dontAsk",
] as const;

const GATEWAY_DEFAULT_PERMISSION_MODE = "bypassPermissions";

function normalizeGatewayPermissionMode(value: unknown): string {
	if (typeof value !== "string") return GATEWAY_DEFAULT_PERMISSION_MODE;
	if ((GATEWAY_PERMISSION_MODES as readonly string[]).includes(value)) return value;
	if (value === "allowByDefault") return "acceptEdits";
	if (value === "denyByDefault") return "dontAsk";
	return GATEWAY_DEFAULT_PERMISSION_MODE;
}

export function GatewaySection({ userPrefs, updateUserPref }: GatewaySectionProps) {
	const { t } = useTranslation("settings");
	const { persistentRuntimes } = useGatewayCapability();
	const persistentRuntimeDisabledReason = t("gatewayPersistentRuntimesUnsupported");
	const addablePlatforms = persistentRuntimes ? ALL_PLATFORMS : (["webhook"] as Platform[]);
	const [config, setConfig] = useState<GatewayConfig>({});
	const [inited, setInited] = useState(false);
	const [saving, setSaving] = useState(false);
	const serverSnapshot = useRef<GatewayConfig>({});

	useEffect(() => {
		if (userPrefs && !inited) {
			const raw = userPrefs.gatewayConfig;
			if (raw && typeof raw === "object") {
				const parsed = raw as GatewayConfig;
				const normalized = {
					...parsed,
					defaultPermissionMode: normalizeGatewayPermissionMode(parsed.defaultPermissionMode),
				};
				setConfig(normalized);
				serverSnapshot.current = normalized;
			}
			setInited(true);
		}
	}, [userPrefs, inited]);

	const isDirty = useMemo(() => {
		if (!inited) return false;
		return JSON.stringify(config) !== JSON.stringify(serverSnapshot.current);
	}, [inited, config]);

	// Compute which platforms changed (for targeted reload)
	const getChangedPlatforms = useCallback((): Platform[] => {
		const oldPlatforms = serverSnapshot.current.platforms ?? [];
		const newPlatforms = config.platforms ?? [];
		const changed = new Set<Platform>();

		// Platforms that were added or modified
		for (const np of newPlatforms) {
			const op = oldPlatforms.find((p) => p.platform === np.platform);
			if (!op || JSON.stringify(op) !== JSON.stringify(np)) {
				changed.add(np.platform);
			}
		}
		// Platforms that were removed
		for (const op of oldPlatforms) {
			if (!newPlatforms.find((p) => p.platform === op.platform)) {
				changed.add(op.platform);
			}
		}
		return Array.from(changed);
	}, [config]);

	const handleSave = useCallback(async () => {
		setSaving(true);
		try {
			await new Promise<void>((resolve, reject) => {
				updateUserPref.mutate(
					{ gatewayConfig: config },
					{ onSuccess: () => resolve(), onError: (err) => reject(err) },
				);
			});

			// Determine which platforms need reload
			const changedPlatforms = getChangedPlatforms();

			// Also check if global gateway settings changed (enabled, streaming, etc.)
			const globalChanged =
				serverSnapshot.current.enabled !== config.enabled ||
				serverSnapshot.current.streaming !== config.streaming ||
				serverSnapshot.current.defaultPermissionMode !== config.defaultPermissionMode ||
				serverSnapshot.current.defaultProjectId !== config.defaultProjectId ||
				serverSnapshot.current.defaultChapterId !== config.defaultChapterId ||
				serverSnapshot.current.sessionIdleMinutes !== config.sessionIdleMinutes ||
				serverSnapshot.current.rateLimitPerMinute !== config.rateLimitPerMinute;

			if (globalChanged && changedPlatforms.length === 0) {
				// Global settings changed but no specific platform — full reload
				await miscApi.gatewayReload();
			} else if (changedPlatforms.length > 0) {
				await miscApi.gatewayReload(changedPlatforms);
			}

			serverSnapshot.current = config;
			notifications.show({ message: t("gatewaySaveSuccess"), color: "green" });
		} catch (err) {
			notifications.show({
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		} finally {
			setSaving(false);
		}
	}, [config, updateUserPref, getChangedPlatforms, t]);

	const updateField = useCallback(
		<K extends keyof GatewayConfig>(key: K, value: GatewayConfig[K]) => {
			setConfig((prev) => ({ ...prev, [key]: value }));
		},
		[],
	);

	const platforms = config.platforms ?? [];

	const addPlatform = useCallback(
		(platform: Platform) => {
			if (!persistentRuntimes && platform !== "webhook") return;
			const existing = platforms.find((p) => p.platform === platform);
			if (existing) return;
			setConfig((prev) => ({
				...prev,
				platforms: [...(prev.platforms ?? []), { platform, enabled: true }],
			}));
		},
		[persistentRuntimes, platforms],
	);

	const removePlatform = useCallback((index: number) => {
		setConfig((prev) => {
			const updated = [...(prev.platforms ?? [])];
			updated.splice(index, 1);
			return { ...prev, platforms: updated };
		});
	}, []);

	const updatePlatform = useCallback((index: number, patch: Partial<PlatformConfig>) => {
		setConfig((prev) => {
			const updated = [...(prev.platforms ?? [])];
			updated[index] = { ...updated[index], ...patch };
			return { ...prev, platforms: updated };
		});
	}, []);

	const availablePlatforms = addablePlatforms.filter(
		(p) => !platforms.some((existing) => existing.platform === p),
	);

	return (
		<Stack gap="md">
			<Text size="sm" c="dimmed">
				{t("gatewayDesc")}
			</Text>
			{!persistentRuntimes && (
				<Text size="xs" c="orange">
					{persistentRuntimeDisabledReason}
				</Text>
			)}

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
						value={normalizeGatewayPermissionMode(config.defaultPermissionMode)}
						onChange={(v) =>
							updateField("defaultPermissionMode", v ?? GATEWAY_DEFAULT_PERMISSION_MODE)
						}
						data={[
							{ value: "default", label: t("gatewayPermDefault") },
							{ value: "acceptEdits", label: t("gatewayPermAcceptEdits") },
							{ value: "bypassPermissions", label: t("gatewayPermBypass") },
							{ value: "readOnly", label: t("gatewayPermReadOnly") },
							{ value: "dontAsk", label: t("gatewayPermDontAsk") },
						]}
					/>

					<Group grow>
						<NumberInput
							label={t("gatewaySessionIdle")}
							description={t("gatewaySessionIdleDesc")}
							value={config.sessionIdleMinutes ?? 0}
							min={0}
							max={43200}
							onChange={(v) => updateField("sessionIdleMinutes", typeof v === "number" ? v : 0)}
						/>
						<NumberInput
							label={t("gatewayRateLimit")}
							description={t("gatewayRateLimitDesc")}
							value={config.rateLimitPerMinute ?? 20}
							min={0}
							max={1000}
							onChange={(v) => updateField("rateLimitPerMinute", typeof v === "number" ? v : 20)}
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
							disabledReason={
								!persistentRuntimes && platform.platform !== "webhook"
									? persistentRuntimeDisabledReason
									: undefined
							}
						/>
					))}
				</>
			)}

			<Transition transition="slide-up" mounted={isDirty}>
				{(styles) => (
					<Group justify="flex-end" style={styles}>
						<Button
							leftSection={<IconDeviceFloppy size={16} />}
							onClick={handleSave}
							loading={saving}
						>
							{t("gatewaySave")}
						</Button>
					</Group>
				)}
			</Transition>
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
	disabledReason,
}: {
	platform: PlatformConfig;
	index: number;
	onUpdate: (index: number, patch: Partial<PlatformConfig>) => void;
	onRemove: (index: number) => void;
	disabledReason?: string;
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
							disabled={!!disabledReason}
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

				{disabledReason && (
					<Text size="xs" c="orange">
						{disabledReason}
					</Text>
				)}

				{platform.enabled && !disabledReason && (
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
						autoComplete="off"
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
						autoComplete="off"
						onChange={(e) => setBotToken(e.currentTarget.value)}
						onBlur={() => saveField("botToken", botToken)}
					/>
					<PasswordInput
						label={t("gatewayPlatformAppToken")}
						value={appToken}
						autoComplete="off"
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
						autoComplete="off"
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
						autoComplete="off"
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

		case "qqbot":
			return <QQBotFields platform={platform} index={index} onUpdate={onUpdate} />;

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
	const { weixinQrSupported, weixinQrReason } = useGatewayCapability();
	const qrDisabledReason = weixinQrReason ?? t("gatewayWeixinQrUnsupported");
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
		if (!weixinQrSupported) {
			setQrStatus("error");
			setQrError(qrDisabledReason);
			return;
		}
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
	}, [index, onUpdate, qrDisabledReason, stopPolling, weixinQrSupported]);

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
			{!weixinQrSupported && (
				<Text size="xs" c="orange">
					{qrDisabledReason}
				</Text>
			)}

			{/* QR login section */}
			<Group gap="sm">
				<Button
					size="xs"
					variant="light"
					leftSection={<IconQrcode size={14} />}
					onClick={startQrLogin}
					loading={weixinQrSupported && (qrStatus === "wait" || qrStatus === "scaned")}
					disabled={!weixinQrSupported}
					title={!weixinQrSupported ? qrDisabledReason : undefined}
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
						autoComplete="off"
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

// ---------------------------------------------------------------------------
// QQ Bot fields
// ---------------------------------------------------------------------------

const QQ_POLICY_OPTIONS = (t: (key: string) => string) => [
	{ value: "open", label: t("gatewayQQBotPolicyOpen") },
	{ value: "allowlist", label: t("gatewayQQBotPolicyAllowlist") },
	{ value: "disabled", label: t("gatewayQQBotPolicyDisabled") },
];

function QQBotFields({
	platform,
	index,
	onUpdate,
}: {
	platform: PlatformConfig;
	index: number;
	onUpdate: (index: number, patch: Partial<PlatformConfig>) => void;
}) {
	const { t } = useTranslation("settings");

	const [appId, setAppId] = useState(platform.appId ?? "");
	const [clientSecret, setClientSecret] = useState(platform.clientSecret ?? "");
	const [allowedUsers, setAllowedUsers] = useState((platform.allowedUsers ?? []).join(", "));
	const [allowedGroups, setAllowedGroups] = useState((platform.allowedGroups ?? []).join(", "));
	const [sttApiKey, setSttApiKey] = useState(platform.stt?.apiKey ?? "");
	const [sttBaseUrl, setSttBaseUrl] = useState(platform.stt?.baseUrl ?? "");
	const [sttModel, setSttModel] = useState(platform.stt?.model ?? "");

	useEffect(() => {
		setAppId(platform.appId ?? "");
		setClientSecret(platform.clientSecret ?? "");
		setAllowedUsers((platform.allowedUsers ?? []).join(", "));
		setAllowedGroups((platform.allowedGroups ?? []).join(", "));
		setSttApiKey(platform.stt?.apiKey ?? "");
		setSttBaseUrl(platform.stt?.baseUrl ?? "");
		setSttModel(platform.stt?.model ?? "");
	}, [platform]);

	const saveField = (field: string, value: string) => {
		if (value.startsWith("*")) return;
		onUpdate(index, { [field]: value });
	};

	const saveCommaSeparated = (field: string, value: string) => {
		const items = value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		onUpdate(index, { [field]: items.length > 0 ? items : undefined });
	};

	const saveStt = (patch: Partial<NonNullable<PlatformConfig["stt"]>>) => {
		const current = platform.stt ?? { apiKey: "" };
		const updated = { ...current, ...patch };
		// If apiKey is empty, remove the whole stt config
		if (!updated.apiKey) {
			onUpdate(index, { stt: undefined });
		} else {
			onUpdate(index, { stt: updated });
		}
	};

	const policyOptions = QQ_POLICY_OPTIONS(t);

	return (
		<Stack gap="xs">
			<Text size="xs" c="dimmed">
				{t("gatewayQQBotDesc")}
			</Text>
			<Anchor href="https://q.qq.com" target="_blank" rel="noopener noreferrer" size="xs">
				{t("gatewayQQBotApplyLink")} ↗
			</Anchor>

			<TextInput
				label={t("gatewayQQBotAppId")}
				description={t("gatewayQQBotAppIdDesc")}
				value={appId}
				onChange={(e) => setAppId(e.currentTarget.value)}
				onBlur={() => saveField("appId", appId)}
			/>
			<PasswordInput
				label={t("gatewayQQBotClientSecret")}
				description={t("gatewayQQBotClientSecretDesc")}
				value={clientSecret}
				autoComplete="off"
				onChange={(e) => setClientSecret(e.currentTarget.value)}
				onBlur={() => saveField("clientSecret", clientSecret)}
			/>

			<Group grow>
				<Select
					label={t("gatewayQQBotDmPolicy")}
					description={t("gatewayQQBotDmPolicyDesc")}
					value={platform.dmPolicy ?? "open"}
					onChange={(v) => onUpdate(index, { dmPolicy: v ?? "open" })}
					data={policyOptions}
				/>
				<Select
					label={t("gatewayQQBotGroupPolicy")}
					description={t("gatewayQQBotGroupPolicyDesc")}
					value={platform.groupPolicy ?? "open"}
					onChange={(v) => onUpdate(index, { groupPolicy: v ?? "open" })}
					data={policyOptions}
				/>
			</Group>

			{platform.dmPolicy === "allowlist" && (
				<TextInput
					label={t("gatewayQQBotAllowedUsers")}
					description={t("gatewayQQBotAllowedUsersDesc")}
					value={allowedUsers}
					onChange={(e) => setAllowedUsers(e.currentTarget.value)}
					onBlur={() => saveCommaSeparated("allowedUsers", allowedUsers)}
				/>
			)}

			{platform.groupPolicy === "allowlist" && (
				<TextInput
					label={t("gatewayQQBotAllowedGroups")}
					description={t("gatewayQQBotAllowedGroupsDesc")}
					value={allowedGroups}
					onChange={(e) => setAllowedGroups(e.currentTarget.value)}
					onBlur={() => saveCommaSeparated("allowedGroups", allowedGroups)}
				/>
			)}

			<Group grow>
				<Switch
					label={t("gatewayQQBotMarkdown")}
					description={t("gatewayQQBotMarkdownDesc")}
					checked={platform.markdownSupport ?? false}
					onChange={(e) => onUpdate(index, { markdownSupport: e.currentTarget.checked })}
				/>
				<Switch
					label={t("gatewayQQBotSandbox")}
					description={t("gatewayQQBotSandboxDesc")}
					checked={platform.sandbox ?? false}
					onChange={(e) => onUpdate(index, { sandbox: e.currentTarget.checked })}
				/>
			</Group>

			<Text size="sm" fw={500} mt="xs">
				{t("gatewayQQBotSttSection")}
			</Text>
			<PasswordInput
				label={t("gatewayQQBotSttApiKey")}
				description={t("gatewayQQBotSttApiKeyDesc")}
				value={sttApiKey}
				autoComplete="off"
				onChange={(e) => setSttApiKey(e.currentTarget.value)}
				onBlur={() => saveStt({ apiKey: sttApiKey })}
			/>
			{sttApiKey && (
				<Group grow>
					<TextInput
						label={t("gatewayQQBotSttBaseUrl")}
						description={t("gatewayQQBotSttBaseUrlDesc")}
						value={sttBaseUrl}
						placeholder="https://open.bigmodel.cn/api/coding/paas/v4"
						onChange={(e) => setSttBaseUrl(e.currentTarget.value)}
						onBlur={() => saveStt({ baseUrl: sttBaseUrl || undefined })}
					/>
					<TextInput
						label={t("gatewayQQBotSttModel")}
						description={t("gatewayQQBotSttModelDesc")}
						value={sttModel}
						placeholder="glm-asr"
						onChange={(e) => setSttModel(e.currentTarget.value)}
						onBlur={() => saveStt({ model: sttModel || undefined })}
					/>
				</Group>
			)}
		</Stack>
	);
}
