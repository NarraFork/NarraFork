/**
 * The keys of a custom API provider: add more, order them, switch them off, give one
 * its own proxy / User-Agent, and (for Kimi Code / OpenCode Go) see each key's usage.
 *
 * Requests rotate per session among the usable keys in this order. The first key is the
 * provider's "API Key" field above; everything here applies immediately.
 */
import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Paper,
	PasswordInput,
	Stack,
	Switch,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import {
	IconArrowDown,
	IconArrowUp,
	IconPlus,
	IconRefresh,
	IconTrash,
	IconWorld,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	invalidateQuotaSnapshots,
	useQuotaSnapshot,
	useQuotaSnapshots,
	useRefreshQuotaSnapshots,
} from "../../hooks/useQuotaSnapshots";
import { ApiError } from "../../lib/api/client";
import { type ProviderKeyInfo, providerKeysApi } from "../../lib/api/provider-keys";
import { describeApiError } from "../../lib/api-error";
import { QuotaSnapshotIndicator } from "../narrator/model/QuotaSnapshotIndicator";
import { CredentialNetworkEditor } from "./CredentialNetworkEditor";

function relativeTime(target: number, locale: string): string {
	const minutes = Math.round((target - Date.now()) / 60_000);
	const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (Math.abs(hours) < 48) return format.format(hours, "hour");
	return format.format(Math.round(hours / 24), "day");
}

function KeyStatus({ entry }: { entry: ProviderKeyInfo }) {
	const { t, i18n } = useTranslation("settings");
	if (entry.disabled) {
		return (
			<Badge size="xs" color={entry.disabledReason === "invalid" ? "red" : "gray"} variant="light">
				{t(entry.disabledReason === "invalid" ? "providerKeys.invalid" : "providerKeys.off")}
			</Badge>
		);
	}
	if (entry.cooldown) {
		return (
			<Tooltip label={t(`providerKeys.cooldownReason.${entry.cooldown.reason}`)}>
				<Badge size="xs" color="orange" variant="light">
					{t("providerKeys.resting", {
						time: relativeTime(entry.cooldown.until, i18n.language),
					})}
				</Badge>
			</Tooltip>
		);
	}
	return (
		<Badge size="xs" color="green" variant="light">
			{t("providerKeys.ready")}
		</Badge>
	);
}

function KeyQuota({ providerId, credentialId }: { providerId: string; credentialId: string }) {
	const { t } = useTranslation("settings");
	const quota = useQuotaSnapshot(providerId, credentialId);
	return <QuotaSnapshotIndicator snapshot={quota.data} title={t("providerKeys.refreshUsage")} />;
}

export function ProviderKeysPanel({
	providerId,
	onFirstKeyChanged,
	showSingleKey = false,
}: {
	providerId: string;
	/** OAuth-only sections have no separate first-key editor. */
	showSingleKey?: boolean;
	/** Keep the settings draft aligned with this immediately persisted pool. */
	onFirstKeyChanged?: (maskedApiKey: string) => void;
}) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const quotas = useQuotaSnapshots();
	const refresh = useRefreshQuotaSnapshots();
	const hasQuota =
		quotas.data?.entries.some(
			(entry) => entry.groupId === providerId && entry.supported !== false,
		) ?? false;
	const queryKey = ["provider-keys", providerId];
	const keys = useQuery({
		queryKey,
		queryFn: () => providerKeysApi.list(providerId),
		refetchInterval: 60_000,
		retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
	});
	const [adding, setAdding] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [newLabel, setNewLabel] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [networkFor, setNetworkFor] = useState<ProviderKeyInfo | null>(null);

	const onFirstKeyChangedRef = useRef(onFirstKeyChanged);
	onFirstKeyChangedRef.current = onFirstKeyChanged;
	const changed = async (data?: { keys?: ProviderKeyInfo[] }) => {
		// Reorder returns the final pool immediately; other writes need a fresh list.
		// '*' keeps a pending/failed list read from clearing the server's first key
		// when an older settings draft is saved.
		if (data?.keys) {
			qc.setQueryData(queryKey, { keys: data.keys });
			onFirstKeyChangedRef.current?.(data.keys[0]?.masked ?? "");
		} else onFirstKeyChangedRef.current?.("*");
		try {
			await invalidateQuotaSnapshots(qc);
			if (!data?.keys) {
				const result = await providerKeysApi.list(providerId);
				qc.setQueryData(queryKey, result);
				onFirstKeyChangedRef.current?.(result.keys[0]?.masked ?? "");
			}
		} finally {
			void qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			void qc.invalidateQueries({ queryKey: ["settings"] });
		}
	};
	const run = useMutation({
		mutationFn: (action: () => Promise<{ keys?: ProviderKeyInfo[] } | unknown>) => action(),
		onSuccess: async (data) => {
			await changed(data as { keys?: ProviderKeyInfo[] });
			setError(null);
		},
		onError: (err) => setError(describeApiError(err, t).message),
	});

	if (keys.error instanceof ApiError && keys.error.status === 404) {
		return (
			<Text size="xs" c="dimmed">
				{t("providerKeys.saveFirst")}
			</Text>
		);
	}
	const list = keys.data?.keys ?? [];
	const showList =
		(showSingleKey && list.length > 0) ||
		list.length > 1 ||
		hasQuota ||
		list.some((k) => k.cooldown || k.disabled);

	const move = (index: number, delta: number) => {
		const ids = list.map((k) => k.id);
		const [id] = ids.splice(index, 1);
		if (!id) return;
		ids.splice(index + delta, 0, id);
		run.mutate(() => providerKeysApi.reorder(providerId, ids));
	};

	return (
		<Stack gap={6}>
			<Group justify="space-between" wrap="nowrap">
				<Text size="sm" fw={500}>
					{t("providerKeys.title", { count: list.length })}
				</Text>
				<Group gap={4} wrap="nowrap">
					{hasQuota && (
						<Tooltip label={t("providerKeys.refreshUsage")}>
							<ActionIcon
								size="sm"
								variant="subtle"
								loading={refresh.isPending}
								aria-label={t("providerKeys.refreshUsage")}
								onClick={() => refresh.mutate({ groupId: providerId })}
							>
								<IconRefresh size={14} />
							</ActionIcon>
						</Tooltip>
					)}
					<Button
						size="compact-xs"
						variant="light"
						leftSection={<IconPlus size={12} />}
						onClick={() => setAdding((v) => !v)}
					>
						{t("providerKeys.add")}
					</Button>
				</Group>
			</Group>
			{(showList || adding) && (
				<Text size="xs" c="dimmed">
					{t("providerKeys.desc")}
				</Text>
			)}
			{showList &&
				list.map((entry, index) => (
					<Paper key={entry.id} withBorder p="xs" radius="sm">
						<Stack gap={6}>
							<Group justify="space-between" wrap="wrap" gap="xs">
								<Group gap={6} wrap="wrap" style={{ minWidth: 0, flex: "1 1 240px" }}>
									<Text size="xs" c="dimmed">
										{index + 1}
									</Text>
									<Text size="sm" truncate>
										{entry.label ?? entry.masked}
									</Text>
									{entry.label && (
										<Text size="xs" c="dimmed" ff="monospace">
											{entry.masked}
										</Text>
									)}
									<KeyStatus entry={entry} />
									{index === 0 && (
										<Badge size="xs" variant="outline">
											{t("providerKeys.first")}
										</Badge>
									)}
								</Group>
								<Group gap={2} wrap="nowrap" style={{ flexShrink: 0, marginLeft: "auto" }}>
									<Tooltip label={t("credentialNetwork.button")}>
										<ActionIcon
											size="sm"
											variant={Object.keys(entry.network).length ? "light" : "subtle"}
											color={Object.keys(entry.network).length ? "indigo" : "gray"}
											aria-label={t("credentialNetwork.button")}
											onClick={() => setNetworkFor(entry)}
										>
											<IconWorld size={14} />
										</ActionIcon>
									</Tooltip>
									<ActionIcon
										size="sm"
										variant="subtle"
										color="gray"
										disabled={index === 0}
										aria-label={t("providerKeys.moveUp")}
										onClick={() => move(index, -1)}
									>
										<IconArrowUp size={14} />
									</ActionIcon>
									<ActionIcon
										size="sm"
										variant="subtle"
										color="gray"
										disabled={index === list.length - 1}
										aria-label={t("providerKeys.moveDown")}
										onClick={() => move(index, 1)}
									>
										<IconArrowDown size={14} />
									</ActionIcon>
									<Switch
										size="xs"
										checked={!entry.disabled}
										aria-label={t("providerKeys.enabled")}
										onChange={(e) => {
											const disabled = !e.currentTarget.checked;
											run.mutate(() => providerKeysApi.update(entry.id, { disabled }));
										}}
									/>
									<ActionIcon
										size="sm"
										variant="subtle"
										color="red"
										aria-label={t("providerKeys.remove")}
										onClick={() => run.mutate(() => providerKeysApi.remove(entry.id))}
									>
										<IconTrash size={14} />
									</ActionIcon>
								</Group>
							</Group>
							{hasQuota && <KeyQuota providerId={providerId} credentialId={entry.id} />}
						</Stack>
					</Paper>
				))}
			{adding && (
				<Group gap="xs" align="flex-end" wrap="wrap">
					<TextInput
						size="xs"
						label={t("providerKeys.label")}
						placeholder={t("providerKeys.labelPlaceholder")}
						value={newLabel}
						onChange={(e) => setNewLabel(e.currentTarget.value)}
						style={{ flex: "1 1 140px" }}
					/>
					<PasswordInput
						size="xs"
						label={t("providerKeys.key")}
						value={newKey}
						autoComplete="off"
						onChange={(e) => setNewKey(e.currentTarget.value)}
						style={{ flex: "2 1 220px" }}
					/>
					<Button
						size="xs"
						disabled={!newKey.trim()}
						loading={run.isPending}
						onClick={() =>
							run.mutate(async () => {
								await providerKeysApi.add(providerId, {
									apiKey: newKey.trim(),
									...(newLabel.trim() ? { label: newLabel.trim() } : {}),
								});
								setNewKey("");
								setNewLabel("");
								setAdding(false);
							})
						}
					>
						{t("providerKeys.addButton")}
					</Button>
				</Group>
			)}
			{error && (
				<Text size="xs" c="red">
					{error}
				</Text>
			)}
			<CredentialNetworkEditor
				opened={!!networkFor}
				onClose={() => setNetworkFor(null)}
				title={t("providerKeys.networkTitle", {
					name: networkFor?.label ?? networkFor?.masked ?? "",
				})}
				value={networkFor?.network}
				showDeviceId={false}
				onSave={async (network) => {
					if (!networkFor) return;
					await providerKeysApi.update(networkFor.id, { network });
					await changed();
				}}
			/>
		</Stack>
	);
}
