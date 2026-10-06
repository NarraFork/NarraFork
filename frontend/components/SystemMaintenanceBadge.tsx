import { Alert, Button, Popover, Stack, Text } from "@mantine/core";
import { IconPlayerPause } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../hooks/useAuth";
import { useSystemLifecycleStatus } from "../hooks/useSystemLifecycleStatus";
import { api } from "../lib/api";
import {
	systemLifecycleNoticeQueryKey,
	systemLifecycleStatusQueryKey,
} from "../lib/api/system-lifecycle";

/** Non-dismissible, global indication of the maintenance gate, not a narrator failure. */
export function SystemMaintenanceBadge() {
	const { t } = useTranslation("settings");
	const { data: user } = useCurrentUser();
	const client = useQueryClient();
	const isAdmin = user?.role === "admin";
	const lifecycle = useSystemLifecycleStatus(isAdmin);
	const notice = useQuery({
		queryKey: systemLifecycleNoticeQueryKey,
		queryFn: ({ signal }) => api.getSystemLifecycleNotice(signal),
		enabled: !!user && !isAdmin,
		refetchInterval: (query) => (query.state.data?.phase === "shutting_down" ? false : 2_000),
		refetchIntervalInBackground: true,
		retry: false,
	});
	const cancel = useMutation({
		mutationFn: api.cancelSystemRecovery,
		onSuccess: async ({ status }) => {
			await Promise.all([
				client.cancelQueries({ queryKey: systemLifecycleNoticeQueryKey }),
				client.cancelQueries({ queryKey: systemLifecycleStatusQueryKey }),
			]);
			client.setQueryData(systemLifecycleNoticeQueryKey, {
				phase: status.phase,
				shutdownRequested: status.shutdownRequested,
			});
			client.setQueryData(systemLifecycleStatusQueryKey, status);
		},
	});
	// Administrators must not see a stale redacted notice disagreeing with the settings card.
	const status = isAdmin ? lifecycle.data : notice.data;
	if (!user || !status || !["preparing", "prepared", "shutting_down"].includes(status.phase)) {
		return null;
	}
	const closing = status.phase === "shutting_down";
	const prepared = status.phase === "prepared";
	const label = t(
		closing
			? "systemMaintenanceClosing"
			: prepared
				? "systemMaintenancePaused"
				: "systemMaintenancePreparing",
	);
	return (
		<Popover width={320} position="bottom" withArrow withinPortal>
			<Popover.Target>
				<Button
					size="compact-xs"
					color="yellow"
					variant="light"
					leftSection={<IconPlayerPause size={14} />}
					style={{ flexShrink: 0 }}
					aria-live="polite"
					aria-label={label}
					title={label}
				>
					<Text component="span" size="xs" visibleFrom="sm">
						{label}
					</Text>
				</Button>
			</Popover.Target>
			<Popover.Dropdown>
				<Stack gap="xs">
					<Text size="sm">
						{t(
							closing
								? "systemShutdownManualStart"
								: prepared
									? "systemMaintenancePausedDescription"
									: "systemMaintenancePreparingDescription",
						)}
					</Text>
					{status.shutdownRequested && !closing && (
						<Text size="xs" c="dimmed">
							{t("systemShutdownQueued")}
						</Text>
					)}
					{cancel.error && <Alert color="red">{cancel.error.message}</Alert>}
					{!closing &&
						(user.role === "admin" ? (
							<Button
								size="xs"
								color="yellow"
								loading={cancel.isPending}
								onClick={() => cancel.mutate()}
							>
								{t("systemMaintenanceResume")}
							</Button>
						) : (
							<Text size="xs" c="dimmed">
								{t("systemMaintenanceContactAdmin")}
							</Text>
						))}
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
}
