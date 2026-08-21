import { Alert, Button, Code, Group, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../hooks/useAuth";
import { consumeStartupRecoveryFailure } from "../lib/pwa";
import { LazyOverlayBoundary } from "./common/LazyOverlayBoundary";

const BrokenModelMigrationModal = lazy(() =>
	import("./settings/BrokenModelMigrationModal").then((m) => ({
		default: m.BrokenModelMigrationModal,
	})),
);

/**
 * Report a startup recovery that failed on the build we just reloaded into.
 *
 * A failed recovery no longer blocks the reload (see `isUpdatedServerReadyForReload`): the new
 * server serves normally, and the UI needed to repair the broken narrator state only exists in
 * the new bundle. That makes this banner the place the reason surfaces, since the update dialog
 * that used to show it is gone along with the pre-reload page.
 *
 * The reason is read once from `sessionStorage` and cleared, so a manual refresh does not keep
 * re-announcing a failure the user has already seen.
 */
export function StartupRecoveryAlert() {
	const { t } = useTranslation("common");
	const { data: user } = useCurrentUser();
	const [reason, setReason] = useState<string | null>(null);
	const [dismissed, setDismissed] = useState(false);
	const [migrationOpened, setMigrationOpened] = useState(false);
	const isAdmin = user?.role === "admin";

	useEffect(() => {
		setReason(consumeStartupRecoveryFailure());
	}, []);

	const handleClose = useCallback(() => setDismissed(true), []);
	const closeMigration = useCallback(() => setMigrationOpened(false), []);

	if (reason === null || dismissed) return null;

	return (
		<>
			<Alert
				variant="light"
				color="yellow"
				radius={0}
				icon={<IconAlertTriangle size={18} />}
				withCloseButton
				closeButtonLabel={t("close")}
				onClose={handleClose}
				title={t("startupRecoveryFailedTitle")}
			>
				<Stack gap="xs">
					<Text size="sm">{t("startupRecoveryFailedDesc")}</Text>
					{reason && (
						<Code block style={{ fontSize: "0.75rem", whiteSpace: "pre-wrap" }}>
							{t("startupRecoveryFailedReason", { reason })}
						</Code>
					)}
					{/* Migration rewrites other users' narrator models, so only admins are offered it. */}
					{isAdmin && (
						<Group gap="xs">
							<Button size="compact-sm" variant="light" onClick={() => setMigrationOpened(true)}>
								{t("startupRecoveryFailedAction")}
							</Button>
						</Group>
					)}
				</Stack>
			</Alert>

			{migrationOpened && (
				<LazyOverlayBoundary resetKey={migrationOpened}>
					<Suspense fallback={null}>
						<BrokenModelMigrationModal opened={migrationOpened} onClose={closeMigration} />
					</Suspense>
				</LazyOverlayBoundary>
			)}
		</>
	);
}
