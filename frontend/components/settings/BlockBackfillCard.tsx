import { api } from "@frontend/lib/api";
import { Group, Loader, Paper, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

const QUERY_KEY = ["storage", "block-backfill"] as const;

/** Automatic storage optimization is visible only while it is working. */
export function BlockBackfillCard() {
	const { t } = useTranslation("settings");
	const { data } = useQuery({
		queryKey: QUERY_KEY,
		queryFn: () => api.getBlockBackfillStatus().then((response) => response.status),
		refetchInterval: 5_000,
	});
	if (!data?.available || (!data.running && !data.projectionRunning)) return null;
	return (
		<Paper p="sm" radius="sm" withBorder data-storage-blocks>
			<Group gap="xs" aria-live="polite">
				<Loader size={12} />
				<Text size="sm" c="dimmed">
					{t("storageBlocksOptimizing")}
				</Text>
			</Group>
		</Paper>
	);
}
