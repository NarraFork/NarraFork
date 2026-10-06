import { Badge, Loader, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconClock, IconRocket } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../hooks/useAuth";
import { useUpdateCheck } from "../hooks/useUpdateCheck";
import { UPDATE_STATUS_QUERY_KEY, useUpdateScheduleStatus } from "../hooks/useUpdateSchedule";
import {
	hasActiveUpdateSchedule,
	type PreparedUpdateStatus,
	resolveScheduledUpdatePill,
} from "../lib/update-state";

const UpdateModal = lazy(() =>
	import("./UpdateModal").then((m) => ({
		default: m.UpdateModal,
	})),
);

/**
 * Inline update badge — shown next to the app title in the header.
 *
 * Two states share one pill:
 * - An available update invites the user to open the detail modal.
 * - A scheduled update reports which phase the restart is waiting in. The coordination waits
 *   have no deadline, so this is the only ambient signal that the switch is pending; without
 *   it a user who closed the dialog would see nothing at all. It therefore survives a failed
 *   update re-check, which would otherwise flip `updateAvailable` back to false mid-drain.
 *
 * Both update endpoints are admin-only. The status poll is gated here because `enabled` also
 * depends on local pill state; the check query gates itself inside `useUpdateCheck`, so a
 * non-admin never issues either request and simply sees no badge.
 */
export function UpdateBadge() {
	const { t } = useTranslation("common");
	const [opened, { open, close }] = useDisclosure(false);
	const queryClient = useQueryClient();
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const {
		updateAvailable,
		latestVersion,
		currentVersion,
		releaseInfo,
		releaseNotes,
		releaseNotesPerVersion,
		releaseDate,
		downloadSize,
		totalSize,
	} = useUpdateCheck();

	const targetVersion = releaseInfo?.version ?? latestVersion;
	// `useUpdateCheck` reports `updateAvailable: false` for any check failure, including a
	// transient one. Gating the query and the pill on it alone means a single failed re-check
	// during the drain would hide the only ambient signal and stop polling entirely. Reading the
	// cached status keeps both alive while the server still reports a schedule; the query's own
	// subscription re-renders this component whenever that cached value changes.
	const cachedStatus = queryClient.getQueryData<PreparedUpdateStatus>([
		UPDATE_STATUS_QUERY_KEY,
		targetVersion,
	]);
	const { data: scheduleStatus } = useUpdateScheduleStatus({
		targetVersion,
		enabled: isAdmin && (updateAvailable || hasActiveUpdateSchedule(cachedStatus)),
	});
	const pill = resolveScheduledUpdatePill(scheduleStatus);

	if (!updateAvailable && !pill) return null;

	return (
		<>
			<Tooltip
				label={
					pill
						? t(pill.tooltipKey, {
								version: scheduleStatus?.targetVersion ?? latestVersion,
							})
						: t("updateViewDetails")
				}
				position="bottom"
				withArrow
			>
				<Badge
					size="sm"
					variant="light"
					color={pill ? "orange" : "indigo"}
					leftSection={
						pill ? (
							pill.busy ? (
								<Loader size={10} color="orange" />
							) : (
								<IconClock size={12} />
							)
						) : (
							<IconRocket size={12} />
						)
					}
					style={{ cursor: "pointer" }}
					onClick={open}
				>
					{pill ? t(pill.labelKey) : t("updateBadge", { from: currentVersion, to: latestVersion })}
				</Badge>
			</Tooltip>

			<Suspense fallback={null}>
				<UpdateModal
					opened={opened}
					onClose={close}
					data={{
						latestVersion,
						currentVersion,
						releaseInfo,
						releaseNotes,
						releaseNotesPerVersion,
						releaseDate,
						downloadSize,
						totalSize,
					}}
				/>
			</Suspense>
		</>
	);
}
