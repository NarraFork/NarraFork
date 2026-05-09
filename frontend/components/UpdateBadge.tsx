import { Badge, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconRocket } from "@tabler/icons-react";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateCheck } from "../hooks/useUpdateCheck";

const UpdateModal = lazy(() =>
	import("./UpdateModal").then((m) => ({
		default: m.UpdateModal,
	})),
);

/**
 * Inline update badge — shown next to the app title in the header.
 * Clicking opens the update detail modal.
 */
export function UpdateBadge() {
	const { t } = useTranslation("common");
	const [opened, { open, close }] = useDisclosure(false);
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

	if (!updateAvailable) return null;

	return (
		<>
			<Tooltip label={t("updateViewDetails")} position="bottom" withArrow>
				<Badge
					size="sm"
					variant="light"
					color="indigo"
					leftSection={<IconRocket size={12} />}
					style={{ cursor: "pointer" }}
					onClick={open}
				>
					{t("updateBadge", { from: currentVersion, to: latestVersion })}
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
