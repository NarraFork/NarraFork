import { Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";

const ProjectCompatibilityPanel = lazy(() =>
	import("./ProjectCompatibilityPanel").then((module) => ({
		default: module.ProjectCompatibilityPanel,
	})),
);

/**
 * Modal body only. Menu hosts render this OUTSIDE their dropdown: a modal nested
 * in Menu.Dropdown unmounts the moment the menu closes, and the open dropdown
 * sits on a higher layer than the modal (the old bundled entry hit both).
 */
export function NarratorCompatibilityModal({
	projectId,
	opened,
	onClose,
}: {
	projectId?: string | null;
	opened: boolean;
	onClose: () => void;
}) {
	const { t } = useTranslation("projects");
	return (
		<Modal opened={opened} onClose={onClose} title={t("compatibility.title")} size="xl">
			{opened &&
				(projectId ? (
					<Suspense fallback={<Loader size="sm" />}>
						<ProjectCompatibilityPanel projectId={projectId} />
					</Suspense>
				) : (
					<Stack>
						<Text>{t("compatibility.noProject")}</Text>
						<Group>
							<Button component={Link} to="/settings/agent" variant="light">
								{t("compatibility.instanceSettings")}
							</Button>
							<Button component={Link} to="/settings/chapters" variant="light">
								{t("compatibility.workspaceContainers")}
							</Button>
							<Button component={Link} to="/settings/devices" variant="light">
								{t("compatibility.devices")}
							</Button>
							<Button component={Link} to="/routines" variant="light">
								{t("compatibility.routinesSkills")}
							</Button>
							<Button component={Link} to="/knowledge" variant="light">
								{t("compatibility.knowledge")}
							</Button>
						</Group>
					</Stack>
				))}
		</Modal>
	);
}

/** Explicit project context only; ordinary sessions do not need a project. */
export function NarratorCompatibilityEntry({ projectId }: { projectId?: string | null }) {
	const { t } = useTranslation("projects");
	const [opened, setOpened] = useState(false);
	return (
		<>
			<Button size="compact-xs" variant="subtle" onClick={() => setOpened(true)}>
				{t("compatibility.title")}
			</Button>
			<NarratorCompatibilityModal
				projectId={projectId}
				opened={opened}
				onClose={() => setOpened(false)}
			/>
		</>
	);
}
