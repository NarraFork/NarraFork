import {
	useCleanupScheduledTask,
	useDeleteScheduledTask,
	useRunScheduledTask,
	useToggleScheduledTask,
} from "@frontend/hooks/useScheduledTasks";
import type { ScheduledTask } from "@frontend/lib/api/scheduled-tasks";
import { ActionIcon, Alert, Button, Group, Menu, Modal, Stack, Switch, Text } from "@mantine/core";
import {
	IconBrush,
	IconCopy,
	IconDots,
	IconPencil,
	IconPlayerPause,
	IconPlayerPlay,
	IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/** Only server capabilities grant actions; ownership and roles are never guessed here. */
export function TaskActions({
	task,
	compact = false,
	onEdit,
	onCopy,
	onDeleted,
}: {
	task: ScheduledTask;
	compact?: boolean;
	onEdit: () => void;
	onCopy: () => void;
	onDeleted?: () => void;
}) {
	const { t } = useTranslation("scheduledTasks");
	const toggle = useToggleScheduledTask();
	const run = useRunScheduledTask();
	const cleanup = useCleanupScheduledTask();
	const remove = useDeleteScheduledTask();
	const [confirm, setConfirm] = useState<"delete" | "cleanup" | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const caps = task.capabilities;
	const error = toggle.error ?? run.error ?? cleanup.error ?? remove.error;
	const pending = toggle.isPending || run.isPending || cleanup.isPending || remove.isPending;
	const runNow = () => {
		setNotice(null);
		run.mutate(task.id, { onSuccess: () => setNotice(t("runStarted")) });
	};
	const canCleanup =
		caps.canEdit && task.narratorMode !== "existing" && task.cleanupPolicy?.mode !== "none";
	const hasMenu = caps.canRun || caps.canEdit || caps.canSeePrompt || caps.canDelete;
	return (
		<Stack gap={4}>
			<Group gap="xs" wrap="wrap">
				{compact ? (
					caps.canPause &&
					task.lifecycle !== "ended" && (
						<Switch
							aria-label={t(task.enabled ? "pauseTask" : "resumeTask")}
							checked={task.enabled}
							disabled={pending}
							onChange={(event) =>
								toggle.mutate({ id: task.id, enabled: event.currentTarget.checked })
							}
						/>
					)
				) : (
					<>
						{caps.canRun && (
							<Button
								size="xs"
								leftSection={<IconPlayerPlay size={14} />}
								loading={run.isPending}
								disabled={pending && !run.isPending}
								onClick={runNow}
							>
								{t("runNow")}
							</Button>
						)}
						{caps.canPause && task.lifecycle !== "ended" && (
							<Button
								size="xs"
								variant="default"
								leftSection={
									task.enabled ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />
								}
								disabled={pending}
								onClick={() => toggle.mutate({ id: task.id, enabled: !task.enabled })}
							>
								{t(task.enabled ? "pauseTask" : "resumeTask")}
							</Button>
						)}
						{caps.canEdit && (
							<Button
								size="xs"
								variant="default"
								leftSection={<IconPencil size={14} />}
								onClick={onEdit}
							>
								{t("edit")}
							</Button>
						)}
					</>
				)}
				{hasMenu && (
					<Menu position="bottom-end" withinPortal>
						<Menu.Target>
							<ActionIcon variant="subtle" aria-label={t("moreActions")}>
								<IconDots size={18} />
							</ActionIcon>
						</Menu.Target>
						<Menu.Dropdown>
							{compact && caps.canRun && (
								<Menu.Item
									leftSection={<IconPlayerPlay size={14} />}
									disabled={pending}
									onClick={runNow}
								>
									{t("runNow")}
								</Menu.Item>
							)}
							{compact && caps.canEdit && (
								<Menu.Item leftSection={<IconPencil size={14} />} onClick={onEdit}>
									{t("edit")}
								</Menu.Item>
							)}
							{caps.canSeePrompt && (
								<Menu.Item leftSection={<IconCopy size={14} />} onClick={onCopy}>
									{t("copyTask")}
								</Menu.Item>
							)}
							{caps.canEdit && task.narratorMode !== "existing" && (
								<Menu.Item
									leftSection={<IconBrush size={14} />}
									disabled={!canCleanup || pending}
									onClick={() => setConfirm("cleanup")}
								>
									{t("cleanupNow")}
								</Menu.Item>
							)}
							{caps.canDelete && (
								<Menu.Item
									color="red"
									leftSection={<IconTrash size={14} />}
									disabled={pending}
									onClick={() => setConfirm("delete")}
								>
									{t("delete")}
								</Menu.Item>
							)}
						</Menu.Dropdown>
					</Menu>
				)}
			</Group>
			{error && (
				<Alert color="red" p="xs">
					{error.message}
				</Alert>
			)}
			{notice && (
				<Text size="xs" c="dimmed" role="status">
					{notice}
				</Text>
			)}
			<Modal
				opened={confirm !== null}
				onClose={() => {
					if (!pending) setConfirm(null);
				}}
				title={t(confirm === "delete" ? "deleteTitle" : "cleanupNow")}
				centered
			>
				<Stack>
					<Text size="sm">
						{t(confirm === "delete" ? "deleteConfirm" : "cleanupConfirm", { name: task.name })}
					</Text>
					{confirm === "cleanup" && (
						<Text size="xs" c="dimmed">
							{t("cleanupWarning")}
						</Text>
					)}
					{(remove.error || cleanup.error) && (
						<Alert color="red">{(remove.error || cleanup.error)?.message}</Alert>
					)}
					<Group justify="flex-end">
						<Button variant="default" disabled={pending} onClick={() => setConfirm(null)}>
							{t("cancel")}
						</Button>
						<Button
							color={confirm === "delete" ? "red" : "orange"}
							loading={pending}
							onClick={() => {
								if (confirm === "delete")
									remove.mutate(task.id, {
										onSuccess: () => {
											setConfirm(null);
											onDeleted?.();
										},
									});
								else
									cleanup.mutate(task.id, {
										onSuccess: (result) => {
											setConfirm(null);
											setNotice(
												t("cleanupResult", {
													...result,
													limited: t(result.limited ? "yes" : "no"),
												}),
											);
										},
									});
							}}
						>
							{t(confirm === "delete" ? "delete" : "cleanupNow")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	);
}
