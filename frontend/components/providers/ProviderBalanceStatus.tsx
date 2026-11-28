import { Button, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import {
	isProviderQuotaCapabilityEnabled,
	useProviderQuota,
	useRefreshProviderQuota,
} from "../../hooks/useProviderQuota";
import { selectQuotaEntries, useQuotaSnapshots } from "../../hooks/useQuotaSnapshots";
import { api } from "../../lib/api";
import { isProviderQuotaUnavailable } from "../narrator/model/provider-quota-view";
import { QuotaSnapshotIndicator } from "../narrator/model/QuotaSnapshotIndicator";

/** Saved Custom API diagnostics and operations share the unified quota presentation. */
export function ProviderBalanceStatus({
	providerId,
	dirty,
}: {
	providerId: string;
	dirty: boolean;
}) {
	const { t } = useTranslation("narrator");
	const { data: user } = useCurrentUser();
	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		staleTime: 30_000,
	});
	const rawGeneration = settings?.providerQuotaGenerations?.[providerId];
	const generation = typeof rawGeneration === "string" ? rawGeneration : undefined;
	const capabilityEnabled = isProviderQuotaCapabilityEnabled(settings);
	const query = useProviderQuota(providerId, generation, true, capabilityEnabled);
	const diagnostic = query.data;
	const unavailable = isProviderQuotaUnavailable(diagnostic);
	const snapshots = useQuotaSnapshots(capabilityEnabled && !!generation && !unavailable);
	const entries = selectQuotaEntries(snapshots.data?.entries ?? []).filter(
		(item) => item.groupId === providerId && item.generation === generation,
	);
	const entry = entries.find((item) => item.primary) ?? entries[0];
	const probing =
		diagnostic?.status === "pending" || diagnostic?.status === "probing" || entry?.refreshing;
	const canRefresh =
		capabilityEnabled &&
		user?.role === "admin" &&
		!dirty &&
		Boolean(generation) &&
		!query.isPending &&
		!query.isError &&
		!snapshots.isPending &&
		!snapshots.isError &&
		!probing &&
		!unavailable;
	const refresh = useRefreshProviderQuota(providerId, generation, canRefresh);
	if (!capabilityEnabled || !generation || unavailable) return null;
	const mode = diagnostic?.status === "supported" ? "refresh" : "probe";
	const snapshot =
		entry?.snapshot && (query.isError || snapshots.isError)
			? { ...entry.snapshot, hasError: true }
			: entry?.snapshot;
	return (
		<Stack gap={4}>
			<Group justify="space-between">
				<Text size="xs" c="dimmed">
					{t(`providerQuota.${diagnostic?.status ?? "pending"}`)}
				</Text>
				{user?.role === "admin" && (
					<Button
						size="compact-xs"
						variant="subtle"
						disabled={!canRefresh}
						loading={refresh.isPending}
						onClick={() => refresh.mutate(mode)}
					>
						{t(`providerQuota.${mode}`)}
					</Button>
				)}
			</Group>
			<QuotaSnapshotIndicator snapshot={snapshot} title={t("providerQuota.supported")} />
			{user?.role === "admin" && diagnostic?.error && diagnostic.error !== "unavailable" && (
				<Text size="xs" c="yellow">
					{t(`providerQuota.errors.${diagnostic.error}`)}
				</Text>
			)}
			{(query.isError || snapshots.isError || refresh.isError) && (
				<Text size="xs" c="red">
					{t("providerQuota.error")}
				</Text>
			)}
			{dirty && (
				<Text size="xs" c="dimmed">
					{t("providerQuota.saveFirst")}
				</Text>
			)}
		</Stack>
	);
}
