import { Badge, Loader, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconClock, IconRocket } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../hooks/useAuth";
import { useUpdateCheck } from "../hooks/useUpdateCheck";
import { UPDATE_STATUS_QUERY_KEY, useUpdateScheduleStatus } from "../hooks/useUpdateSchedule";
import {
	hasActiveUpdateSchedule,
	type PreparedUpdateStatus,
	resolveScheduledUpdatePill,
} from "../lib/update-state";
import type { UpdateModalData } from "./UpdateModal";

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
		strategy,
		settingsKey,
	} = useUpdateCheck();
	const [modalData, setModalData] = useState<UpdateModalData>({});
	// Source changes clear the recommendation query, but not a prepared/scheduled binary.
	const previousTarget = useRef<string | undefined>(undefined);
	const checkedTarget = releaseInfo?.version ?? latestVersion;
	const previousStatus = queryClient.getQueryData<PreparedUpdateStatus>([
		UPDATE_STATUS_QUERY_KEY,
		previousTarget.current,
	]);
	const preservePreviousTarget =
		hasActiveUpdateSchedule(previousStatus) ||
		(previousStatus?.ready === true && previousTarget.current !== currentVersion);
	if (checkedTarget && !preservePreviousTarget) previousTarget.current = checkedTarget;
	const targetVersion = previousTarget.current ?? checkedTarget;
	const recommendationMatchesTarget = checkedTarget === targetVersion;
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
		enabled:
			isAdmin &&
			(updateAvailable || cachedStatus?.ready === true || hasActiveUpdateSchedule(cachedStatus)),
	});
	const pill = resolveScheduledUpdatePill(scheduleStatus);

	const prepared = scheduleStatus?.ready === true;
	if (!updateAvailable && !pill && !prepared) return null;

	return (
		<>
			<Tooltip
				label={
					pill
						? t(pill.tooltipKey, {
								version: scheduleStatus?.targetVersion ?? targetVersion,
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
					onClick={() => {
						setModalData({
							latestVersion: targetVersion,
							currentVersion,
							...(recommendationMatchesTarget && {
								releaseInfo,
								releaseNotes,
								releaseNotesPerVersion,
								releaseDate,
								downloadSize,
								totalSize,
								strategy,
								settingsKey,
							}),
						});
						open();
					}}
				>
					{pill
						? t(pill.labelKey)
						: (!updateAvailable || !recommendationMatchesTarget) && prepared
							? t("updateReadyBadge", { version: targetVersion })
							: t("updateBadge", { from: currentVersion, to: latestVersion })}
				</Badge>
			</Tooltip>

			<Suspense fallback={null}>
				<UpdateModal opened={opened} onClose={close} data={modalData} />
			</Suspense>
		</>
	);
}
