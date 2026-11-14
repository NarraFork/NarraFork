import { useTransferScheduledTask } from "@frontend/hooks/useScheduledTasks";
import { type ScheduledTask, scheduledTasksApi } from "@frontend/lib/api/scheduled-tasks";
import { Alert, Button, Group, Modal, Select, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function TaskTransfer({ task }: { task: ScheduledTask }) {
	const { t } = useTranslation("scheduledTasks");
	const [opened, setOpened] = useState(false);
	const [owner, setOwner] = useState<string | null>(null);
	const transfer = useTransferScheduledTask();
	const users = useQuery({
		queryKey: ["scheduled-task-transfer-users"],
		queryFn: ({ signal }) => scheduledTasksApi.listScheduledTaskTransferUsers(signal),
		enabled: !!task.capabilities.canTransfer && opened,
		staleTime: 60_000,
	});
	if (!task.capabilities.canTransfer) return null;
	return (
		<>
			<Button size="xs" variant="subtle" onClick={() => setOpened(true)}>
				{t("transferOwner")}
			</Button>
			<Modal
				opened={opened}
				onClose={() => {
					if (!transfer.isPending) setOpened(false);
				}}
				title={t("transferOwner")}
			>
				<Stack>
					<Text size="sm">{t("transferHint")}</Text>
					<Select
						label={t("newOwner")}
						searchable
						data={(users.data ?? []).map((user) => ({ value: user.id, label: user.username }))}
						value={owner}
						onChange={setOwner}
						disabled={users.isPending}
					/>
					{(users.error || transfer.error) && (
						<Alert color="red">{(users.error || transfer.error)?.message}</Alert>
					)}
					<Group justify="flex-end">
						<Button
							variant="default"
							onClick={() => setOpened(false)}
							disabled={transfer.isPending}
						>
							{t("cancel")}
						</Button>
						<Button
							disabled={!owner || owner === task.ownerUserId}
							loading={transfer.isPending}
							onClick={() => {
								if (owner)
									transfer.mutate(
										{ id: task.id, ownerUserId: owner },
										{ onSuccess: () => setOpened(false) },
									);
							}}
						>
							{t("transferOwner")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
}
