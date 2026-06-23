import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { IconArrowLeft, IconUsers } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useChatGroups } from "../../hooks/useChatGroup";

export const Route = createFileRoute("/groups/")({
	component: GroupsListPage,
});

function GroupsListPage() {
	const navigate = useNavigate();
	const { t } = useTranslation("narrators");
	const { data, isLoading } = useChatGroups();
	const groups = data?.groups ?? [];

	return (
		<Box maw={900} mx="auto">
			<Group gap="xs" mb="md">
				<ActionIcon variant="subtle" color="gray" onClick={() => navigate({ to: ".." })}>
					<IconArrowLeft size={18} />
				</ActionIcon>
				<IconUsers size={20} />
				<Title order={3}>{t("groupsListTitle")}</Title>
			</Group>

			{isLoading ? (
				<Center py="xl">
					<Loader size="sm" />
				</Center>
			) : groups.length === 0 ? (
				<Center py="xl">
					<Stack gap="xs" align="center">
						<Text c="dimmed" size="sm" ta="center">
							{t("groupsListEmpty")}
						</Text>
						<Button size="xs" variant="light" onClick={() => navigate({ to: "/narrators" })}>
							{t("groupsCreateNamedCta")}
						</Button>
					</Stack>
				</Center>
			) : (
				<Stack gap="xs">
					{groups.map((g) => (
						<Paper
							key={g.id}
							p="sm"
							radius="md"
							withBorder
							style={{ cursor: "pointer" }}
							onClick={() => navigate({ to: "/groups/$groupId", params: { groupId: g.id } })}
						>
							<Group justify="space-between" wrap="nowrap">
								<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
									<IconUsers size={18} />
									<Text fw={600} truncate="end">
										{g.title || t("groupUntitled")}
									</Text>
								</Group>
								<Badge size="sm" variant="light" color="grape">
									{t("groupMemberCount", { count: g.memberCount })}
								</Badge>
							</Group>
						</Paper>
					))}
				</Stack>
			)}
		</Box>
	);
}
