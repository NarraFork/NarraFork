import { Badge, Button, Checkbox, Group, Paper, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconRefreshAlert } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useResumeRecoverySubagents } from "../../hooks/useNarrator";

export interface SubagentRecoveryEntry {
	id: string;
	title: string;
	subagentType: string;
	errorMessage?: string | null;
	createdAt?: string;
	/** Foreground subagents from earlier turns must be detached to background first. */
	wasForeground?: boolean;
}

export function SubagentRecoveryPendingCard({
	narratorId,
	messageId,
	subagents,
}: {
	narratorId: string;
	messageId: string;
	subagents: SubagentRecoveryEntry[];
}) {
	const { t } = useTranslation("narrator");
	// Default to all selected — the common case is "bring everything back".
	// `subagents` is derived from the message's contentJson blocks, which are
	// immutable once persisted; a content change would remount this component.
	const [selected, setSelected] = useState<string[]>(() => subagents.map((item) => item.id));
	const resume = useResumeRecoverySubagents();

	const submit = (mode: "notify" | "await") => {
		if (selected.length === 0 || resume.isPending) return;
		resume.mutate(
			{ narratorId, messageId, subagentIds: selected, mode },
			{
				onError: (error: Error) => {
					notifications.show({ message: error.message, color: "red", autoClose: 5000 });
				},
			},
		);
	};

	return (
		<Paper p="sm" radius="sm" style={{ backgroundColor: "var(--mantine-color-orange-light)" }}>
			<Stack gap="xs">
				<Group gap={6} wrap="nowrap" align="flex-start">
					<IconRefreshAlert
						size={16}
						style={{ flexShrink: 0, marginTop: 1, color: "var(--mantine-color-orange-7)" }}
					/>
					<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
						<Text size="xs" fw={600} c="orange.9">
							{t("subagentRecoveryTitle")}
						</Text>
						<Text size="xs" c="orange.9">
							{t("subagentRecoveryDescription", { count: subagents.length })}
						</Text>
					</Stack>
				</Group>

				<Checkbox.Group value={selected} onChange={setSelected}>
					<Stack gap={4}>
						{subagents.map((item) => (
							<Checkbox
								key={item.id}
								value={item.id}
								size="xs"
								disabled={resume.isPending}
								label={
									<Group gap={6} wrap="nowrap">
										<Text size="xs" c="orange.9" truncate style={{ maxWidth: 320 }}>
											{item.title}
										</Text>
										<Badge size="xs" variant="light" color="gray">
											{item.subagentType}
										</Badge>
										{item.wasForeground && (
											<Badge size="xs" variant="light" color="orange">
												{t("subagentRecoveryToBackground")}
											</Badge>
										)}
									</Group>
								}
							/>
						))}
					</Stack>
				</Checkbox.Group>

				<Group justify="flex-end" gap="xs">
					<Button
						size="compact-sm"
						variant="light"
						color="orange"
						loading={resume.isPending}
						disabled={selected.length === 0}
						onClick={() => submit("notify")}
					>
						{t("subagentRecoveryResumeAndNotify")}
					</Button>
					<Button
						size="compact-sm"
						color="orange"
						loading={resume.isPending}
						disabled={selected.length === 0}
						onClick={() => submit("await")}
					>
						{t("subagentRecoveryResumeAndWait")}
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
}

export function SubagentRecoveryResolvedCard({
	resumedCount,
	mode,
}: {
	resumedCount: number;
	mode?: "notify" | "await";
}) {
	const { t } = useTranslation("narrator");
	return (
		<Paper p="xs" radius="sm" style={{ backgroundColor: CARD_BG }}>
			<Group gap={6} wrap="nowrap">
				<IconRefreshAlert
					size={14}
					style={{ flexShrink: 0, color: "var(--mantine-color-dimmed)" }}
				/>
				<Text size="xs" c="dimmed">
					{mode === "await"
						? t("subagentRecoveryResolvedWait", { count: resumedCount })
						: t("subagentRecoveryResolvedNotify", { count: resumedCount })}
				</Text>
			</Group>
		</Paper>
	);
}

const CARD_BG = "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))";
