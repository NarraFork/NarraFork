import { Button, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useProbeProviderBalance, useProviderBalance } from "../../hooks/useProviderBalance";
import { api } from "../../lib/api";
import { formatProviderBalance } from "../../lib/provider-balance-format";

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
	// The capability belongs to the apikey-quota plugin, so disabling it removes this whole row
	// instead of leaving a status the operator cannot act on. Served by the projection this
	// component already fetches; an unknown answer counts as enabled (the safe direction).
	const capabilityEnabled =
		(settings as { providerBalanceCapability?: { enabled?: unknown } } | undefined)
			?.providerBalanceCapability?.enabled !== false;
	const query = useProviderBalance(providerId, generation);
	const canProbe =
		user?.role === "admin" &&
		!dirty &&
		generation !== undefined &&
		!query.isPending &&
		!query.isError;
	const probe = useProbeProviderBalance(providerId, generation, canProbe);
	// The capability is the plugin's, so a disabled plugin removes the whole row — status label
	// and rediscover action included — instead of advertising a state the operator cannot change.
	if (!capabilityEnabled) return null;
	if (!generation) return null;
	const snapshot = query.data;
	const formatted = formatProviderBalance(snapshot, t, query.isError);
	const probing = snapshot?.status === "pending" || snapshot?.status === "probing";
	return (
		<Stack gap={4}>
			<Group justify="space-between">
				<Text size="xs" c="dimmed">
					{t(`providerBalance.${snapshot?.status ?? "pending"}`)}
				</Text>
				{user?.role === "admin" && (
					<Button
						size="compact-xs"
						variant="subtle"
						disabled={!canProbe || probing}
						loading={probe.isPending}
						onClick={() => probe.mutate()}
					>
						{t("providerBalance.probe")}
					</Button>
				)}
			</Group>
			{snapshot?.balance ? (
				<Text size="xs" style={{ whiteSpace: "pre-line" }}>
					{formatted.detailedQuotaBalance}
				</Text>
			) : (
				// Without a value the failure code is the only thing worth showing: "the plugin is
				// disabled" and "your token was rejected" need different fixes.
				!(query.isError || probe.isError) &&
				snapshot?.error && (
					<Text size="xs" c={snapshot.error === "plugin_not_enabled" ? "dimmed" : "red"}>
						{formatted.quotaBalance}
					</Text>
				)
			)}
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
