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
	Progress,
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
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../lib/api/client";
import { type ProviderKeyInfo, providerKeysApi } from "../../lib/api/provider-keys";
import { describeApiError } from "../../lib/api-error";
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

function KeyUsage({ usage }: { usage: NonNullable<ProviderKeyInfo["usage"]> }) {
	const { t, i18n } = useTranslation("settings");
	if (usage.windows.length === 0) {
		return usage.error ? (
			<Text size="xs" c="dimmed">
				{t("providerKeys.usageUnavailable")}
			</Text>
		) : null;
	}
	return (
		<Group gap="md" wrap="wrap">
			{usage.windows.map((window) => {
				const percent = window.usedRatio == null ? null : Math.round(window.usedRatio * 100);
				const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
				return (
					<Stack key={window.label} gap={2} style={{ minWidth: 120 }}>
						<Group gap={4} justify="space-between" wrap="nowrap">
							<Text size="xs" c="dimmed">
								{t(`providerKeys.window.${window.label}`, window.label)}
							</Text>
							<Text size="xs">{percent == null ? "—" : `${percent}%`}</Text>
						</Group>
						<Progress
							size="xs"
							value={percent ?? 0}
							color={percent != null && percent >= 90 ? "red" : "indigo"}
						/>
						{Number.isFinite(reset) && (
							<Text size="10px" c="dimmed">
								{t("providerKeys.resets", { time: relativeTime(reset, i18n.language) })}
							</Text>
						)}
					</Stack>
				);
			})}
		</Group>
	);
}

export function ProviderKeysPanel({ providerId }: { providerId: string }) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
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

	const changed = (data?: { keys?: ProviderKeyInfo[] }) => {
		if (data?.keys) qc.setQueryData(queryKey, { keys: data.keys });
		else void qc.invalidateQueries({ queryKey });
		// The first key is also the provider's API key in settings.
		void qc.invalidateQueries({ queryKey: ["settings"] });
	};
	const run = useMutation({
		mutationFn: (action: () => Promise<{ keys?: ProviderKeyInfo[] } | unknown>) => action(),
		onSuccess: (data) => {
			setError(null);
			changed(data as { keys?: ProviderKeyInfo[] });
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
	const showList = list.length > 1 || list.some((k) => k.usage || k.cooldown || k.disabled);

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
					{list.some((k) => k.usage) && (
						<Tooltip label={t("providerKeys.refreshUsage")}>
							<ActionIcon
								size="sm"
								variant="subtle"
								loading={run.isPending}
								onClick={() => run.mutate(() => providerKeysApi.refreshUsage(providerId))}
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
							<Group justify="space-between" wrap="nowrap" gap="xs">
								<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
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
								<Group gap={2} wrap="nowrap">
									<Tooltip label={t("credentialNetwork.button")}>
										<ActionIcon
											size="sm"
											variant={Object.keys(entry.network).length ? "light" : "subtle"}
											color={Object.keys(entry.network).length ? "indigo" : "gray"}
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
							{entry.usage && <KeyUsage usage={entry.usage} />}
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
					changed();
				}}
			/>
		</Stack>
	);
}
