import { Alert, Button, Group, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconBrandGit, IconDownload, IconRefresh, IconRobot } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSetupAssistant } from "../hooks/useSetupAssistant";
import { api, getToken } from "../lib/api";
import { SetupAssistantAuthorizationModal } from "./settings/SetupAssistantAuthorizationModal";

/**
 * Non-blocking banner shown when the backend reports git is not installed.
 *
 * It used to be a full-screen overlay, which overstated the problem: the backend
 * only gates the routes that actually run git (project creation, chapter
 * lifecycle, merges, the git panel). Standalone narrators, provider setup and
 * every settings page work fine without it — and a Setup Assistant narrator is
 * the thing best equipped to install git on an arbitrary machine. So this
 * informs and offers actions instead of locking the user out.
 */
export function GitMissingAlert() {
	const { t } = useTranslation("common");
	const hasToken = !!getToken();
	const [dismissed, setDismissed] = useState(false);

	const {
		data: health,
		refetch,
		isRefetching,
	} = useQuery({
		queryKey: ["health"],
		queryFn: () => api.health(),
		staleTime: Number.POSITIVE_INFINITY,
		enabled: hasToken,
	});

	const { delegate, isDelegating, canDelegate } = useSetupAssistant();
	const [authorizeOpened, { open: openAuthorize, close: closeAuthorize }] = useDisclosure(false);

	// Nothing to say before login, while health is loading, or when git is present.
	if (!hasToken || !health || health.gitAvailable) return null;
	if (dismissed) return null;

	return (
		<>
			<Alert
				variant="light"
				color="yellow"
				icon={<IconBrandGit size={18} />}
				withCloseButton
				closeButtonLabel={t("gitDismiss")}
				onClose={() => setDismissed(true)}
				radius={0}
				title={t("gitNotInstalled")}
			>
				<Text size="sm" mb="xs">
					{t("gitNotInstalledBannerDesc")}
				</Text>
				<Group gap="xs">
					{canDelegate && (
						<Button
							size="compact-sm"
							leftSection={<IconRobot size={14} />}
							onClick={openAuthorize}
							loading={isDelegating}
						>
							{t("gitInstallViaNarrator")}
						</Button>
					)}
					<Button
						size="compact-sm"
						variant="light"
						component="a"
						href="https://git-scm.com/downloads"
						target="_blank"
						rel="noopener noreferrer"
						leftSection={<IconDownload size={14} />}
					>
						{t("gitDownload")}
					</Button>
					<Button
						size="compact-sm"
						variant="subtle"
						leftSection={<IconRefresh size={14} />}
						onClick={() => refetch()}
						loading={isRefetching}
					>
						{t("gitRecheck")}
					</Button>
				</Group>
			</Alert>

			<SetupAssistantAuthorizationModal
				opened={authorizeOpened}
				onClose={closeAuthorize}
				loading={isDelegating}
				onConfirm={(authorization) => {
					closeAuthorize();
					delegate(authorization);
				}}
			/>
		</>
	);
}
