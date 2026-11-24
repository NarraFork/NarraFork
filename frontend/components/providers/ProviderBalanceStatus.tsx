import { Button, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import {
	isProviderQuotaCapabilityEnabled,
	useProviderQuota,
	useRefreshProviderQuota,
} from "../../hooks/useProviderQuota";
import { useQuotaNow } from "../../hooks/useQuotaNow";
import { api } from "../../lib/api";
import {
	buildProviderQuotaView,
	isProviderQuotaUnavailable,
} from "../narrator/model/provider-quota-view";
import { QuotaPanelIndicator } from "../narrator/model/QuotaPanelIndicator";

/** Saved Custom API account quota. The historical component name stays compatible. */
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
	const snapshot = query.data;
	const unavailable = isProviderQuotaUnavailable(snapshot);
	const probing = snapshot?.status === "pending" || snapshot?.status === "probing";
	const canRefresh =
		capabilityEnabled &&
		user?.role === "admin" &&
		!dirty &&
		Boolean(generation) &&
		!query.isPending &&
		!query.isError &&
		!probing &&
		!unavailable;
	const refresh = useRefreshProviderQuota(providerId, generation, canRefresh);
	const now = useQuotaNow(capabilityEnabled && !unavailable && Boolean(snapshot?.data?.expiresAt));
	if (!capabilityEnabled || !generation || unavailable) return null;
	const view = buildProviderQuotaView(snapshot, t, user?.role === "admin", query.isError, now);
	const mode = snapshot?.status === "supported" ? "refresh" : "probe";
	return (
		<Stack gap={4}>
			<Group justify="space-between">
				<Text size="xs" c="dimmed">
					{t(`providerQuota.${snapshot?.status ?? "pending"}`)}
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
			<QuotaPanelIndicator view={view} now={snapshot?.data?.expiresAt ? now : undefined} />
			{(query.isError || refresh.isError) && (
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
