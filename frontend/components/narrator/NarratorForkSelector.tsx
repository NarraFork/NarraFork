import { ActionIcon, Badge, Group, Popover, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconGitFork } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useRelatedNarrators } from "../../hooks/useNarrator";

interface NarratorForkSelectorProps {
	narratorId: string;
}

export function NarratorForkSelector({ narratorId }: NarratorForkSelectorProps) {
	const { t } = useTranslation("narrator");
	const { data: rawRelated } = useRelatedNarrators(narratorId);
	const navigate = useNavigate();

	// Filter out subagents — they are child agents, not conversation branches
	const related = rawRelated?.filter((n: { type?: string }) => n.type !== "subagent");

	// Don't render if no related narrators or only self
	if (!related || related.length <= 1) return null;

	return (
		<Popover width={260} position="bottom-start" shadow="md" withinPortal>
			<Popover.Target>
				<Tooltip label={t("branchSwitch")}>
					<ActionIcon size="sm" variant="subtle" color="gray" ml={4} aria-label={t("branchSwitch")}>
						<IconGitFork size={16} />
					</ActionIcon>
				</Tooltip>
			</Popover.Target>
			<Popover.Dropdown p="xs">
				<Text size="xs" c="dimmed" fw={500} mb={4} px={4}>
					{t("branches")}
				</Text>
				{related.map((n: { id: string; title: string | null; parentNarratorId: string | null }) => (
					<UnstyledButton
						key={n.id}
						w="100%"
						px={8}
						py={4}
						style={{ borderRadius: 4 }}
						className="mantine-hover"
						onClick={() => {
							if (n.id !== narratorId) {
								navigate({
									to: "/sessions/$narratorId",
									params: { narratorId: n.id },
								});
							}
						}}
					>
						<Group gap={8} wrap="nowrap">
							<IconGitFork size={14} style={{ flexShrink: 0, opacity: 0.5 }} />
							<Text size="sm" truncate style={{ flex: 1 }}>
								{n.title || (n.parentNarratorId ? t("branch") : t("branchRoot"))}
							</Text>
							{n.id === narratorId && (
								<Badge size="xs" variant="dot" color="green">
									{t("branchActive")}
								</Badge>
							)}
						</Group>
					</UnstyledButton>
				))}
			</Popover.Dropdown>
		</Popover>
	);
}
