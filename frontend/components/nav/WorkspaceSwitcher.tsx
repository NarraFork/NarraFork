/**
 * Header control for workspaces (saved split layouts).
 *
 * Workspaces used to be listed in the sidebar as groups of sessions. Folders took over
 * that job, so the sidebar no longer shows workspaces; this menu is where they are found,
 * opened and deleted. Creating one is unchanged (drag a session onto the open session
 * page), and the empty state says so — many users never discovered that gesture.
 */

import { ActionIcon, Button, Group, Menu, Modal, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconLayoutColumns, IconTrash } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDeleteWorkspace } from "../../hooks/useWorkspace";
import { api } from "../../lib/api";

interface WorkspaceSummary {
	id: string;
	title: string;
}

const WORKSPACE_PATH = /^\/narrators\/workspace\/([^/]+)/;

export function WorkspaceSwitcher() {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const currentId = WORKSPACE_PATH.exec(pathname)?.[1] ?? null;
	const [opened, setOpened] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<WorkspaceSummary | null>(null);
	const deleteWorkspace = useDeleteWorkspace();
	// Fetched only once the menu has been opened (or a workspace is on screen), so the
	// header costs nothing for users who never use workspaces.
	const { data, isLoading, isError } = useQuery({
		queryKey: ["workspaces"],
		queryFn: () => api.listWorkspaces() as Promise<WorkspaceSummary[]>,
		enabled: opened || currentId !== null,
		staleTime: 30_000,
	});
	const workspaces = data ?? [];
	const current = currentId
		? workspaces.find((workspace) => workspace.id === currentId)
		: undefined;

	const confirm = () => {
		if (!confirmDelete) return;
		const target = confirmDelete;
		setConfirmDelete(null);
		deleteWorkspace.mutate(target.id, {
			onSuccess: () => {
				if (target.id === currentId) navigate({ to: "/narrators" });
			},
			onError: () => notifications.show({ color: "red", message: t("workspaceDeleteFailed") }),
		});
	};

	return (
		<>
			<Menu opened={opened} onChange={setOpened} position="bottom-end" shadow="md" width={260}>
				<Menu.Target>
					<Tooltip label={t("workspaces")} position="bottom" withArrow disabled={opened}>
						{current ? (
							<Button
								variant="light"
								color="indigo"
								size="xs"
								px={8}
								leftSection={<IconLayoutColumns size={16} />}
								styles={{ section: { marginInlineEnd: 0 } }}
								style={{ maxWidth: 200, flexShrink: 1, minWidth: 0 }}
								aria-label={t("workspaces")}
							>
								{/* Phones show the icon only; the header has no room for a title. */}
								<Text size="xs" truncate visibleFrom="sm" ml={6}>
									{current.title || t("untitledWorkspace")}
								</Text>
							</Button>
						) : (
							// Kept on phones too: it is the only way to reach a workspace there.
							<ActionIcon variant="subtle" color="gray" aria-label={t("workspaces")}>
								<IconLayoutColumns size={20} />
							</ActionIcon>
						)}
					</Tooltip>
				</Menu.Target>
				<Menu.Dropdown>
					<Menu.Label>{t("workspaces")}</Menu.Label>
					{isLoading ? (
						<Text size="xs" c="dimmed" px="sm" py={6}>
							{t("loading")}
						</Text>
					) : isError ? (
						<Text size="xs" c="red" px="sm" py={6}>
							{t("workspacesLoadFailed")}
						</Text>
					) : workspaces.length === 0 ? (
						<Text size="xs" c="dimmed" px="sm" py={6} style={{ whiteSpace: "normal" }}>
							{t("workspacesEmptyHint")}
						</Text>
					) : (
						workspaces.map((workspace) => (
							<Group key={workspace.id} gap={0} wrap="nowrap">
								<Menu.Item
									style={{ flex: 1, minWidth: 0 }}
									leftSection={<IconLayoutColumns size={14} />}
									color={workspace.id === currentId ? "indigo" : undefined}
									onClick={() =>
										navigate({
											to: "/narrators/workspace/$workspaceId",
											params: { workspaceId: workspace.id },
										})
									}
								>
									<Text size="sm" truncate>
										{workspace.title || t("untitledWorkspace")}
									</Text>
								</Menu.Item>
								<Tooltip label={t("deleteWorkspace")} position="right" withArrow>
									{/* A real Tab stop: Menu's arrow-key navigation only visits items. */}
									<ActionIcon
										variant="subtle"
										color="gray"
										aria-label={`${t("deleteWorkspace")}: ${workspace.title || t("untitledWorkspace")}`}
										mr={4}
										onClick={() => {
											setOpened(false);
											setConfirmDelete(workspace);
										}}
									>
										<IconTrash size={14} />
									</ActionIcon>
								</Tooltip>
							</Group>
						))
					)}
				</Menu.Dropdown>
			</Menu>
			<Modal
				opened={!!confirmDelete}
				onClose={() => setConfirmDelete(null)}
				title={t("deleteWorkspace")}
				centered
				size="sm"
			>
				<Text size="sm">
					{t("deleteWorkspaceConfirm", { name: confirmDelete?.title || t("untitledWorkspace") })}
				</Text>
				<Group justify="flex-end" mt="md">
					<Button variant="default" onClick={() => setConfirmDelete(null)}>
						{t("cancel")}
					</Button>
					<Button color="red" onClick={confirm} loading={deleteWorkspace.isPending}>
						{t("deleteWorkspace")}
					</Button>
				</Group>
			</Modal>
		</>
	);
}
