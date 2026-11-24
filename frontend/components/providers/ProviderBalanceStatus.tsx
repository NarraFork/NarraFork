import { Button, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useProbeProviderBalance } from "../../hooks/useProviderBalanceProbe";
import { selectQuotaEntries, useQuotaSnapshots } from "../../hooks/useQuotaSnapshots";
import { api } from "../../lib/api";
import { QuotaSnapshotIndicator } from "../narrator/model/QuotaSnapshotIndicator";

export function ProviderBalanceStatus({
	providerId,
	dirty,
}: {
	providerId: string;
	dirty: boolean;
}) {
	const { t } = useTranslation("settings");
	const { data: user } = useCurrentUser();
	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		staleTime: 30_000,
	});
	const rawGeneration = settings?.providerBalanceGenerations?.[providerId];
	const generation = typeof rawGeneration === "string" ? rawGeneration : undefined;
	const capabilityEnabled =
		(settings as { providerBalanceCapability?: { enabled?: unknown } } | undefined)
			?.providerBalanceCapability?.enabled !== false;
	const query = useQuotaSnapshots(capabilityEnabled && !!generation);
	const entries = selectQuotaEntries(query.data?.entries ?? []).filter(
		(item) => item.groupId === providerId,
	);
	const entry = entries.find((item) => item.primary) ?? entries[0];
	const canProbe =
		user?.role === "admin" && !dirty && !!generation && !query.isPending && !query.isError;
	const probe = useProbeProviderBalance(providerId, generation, canProbe);
	if (!capabilityEnabled || !generation) return null;
	const diagnostic = probe.data?.generation === generation ? probe.data : null;
	const status =
		diagnostic?.status ??
		(entry?.refreshing
			? "probing"
			: entry?.supported === false
				? "unsupported"
				: entry?.snapshot
					? "supported"
					: "pending");
	return (
		<Stack gap={4}>
			<Group justify="space-between">
				<Text size="xs" c="dimmed">
					{t(`providerBalance.${status}`)}
				</Text>
				{user?.role === "admin" && (
					<Button
						size="compact-xs"
						variant="subtle"
						disabled={!canProbe || entry?.refreshing}
						loading={probe.isPending}
						onClick={() => probe.mutate()}
					>
						{t("providerBalance.probe")}
					</Button>
				)}
			</Group>
			<QuotaSnapshotIndicator snapshot={entry?.snapshot} title={t("providerBalance.supported")} />
			{(query.isError || probe.isError) && (
				<Text size="xs" c="red">
					{t("providerBalance.failed")}
				</Text>
			)}
			{dirty && (
				<Text size="xs" c="dimmed">
					{t("providerBalance.saveFirst")}
				</Text>
			)}
		</Stack>
	);
}
