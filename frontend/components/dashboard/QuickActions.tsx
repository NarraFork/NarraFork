import { Button, Card, Group, Text } from "@mantine/core";
import { IconClock, IconMessage, IconPlus, IconTerminal2 } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export function QuickActions() {
	const { t } = useTranslation("dashboard");

	return (
		<Card withBorder>
			<Text size="xs" tt="uppercase" fw={700} c="dimmed" mb="sm">
				{t("quickActions")}
			</Text>
			<Group>
				<Button
					variant="light"
					leftSection={<IconPlus size={16} />}
					component={Link}
					to="/projects"
				>
					{t("newProject")}
				</Button>
				<Button
					variant="light"
					leftSection={<IconMessage size={16} />}
					component={Link}
					to="/narrators"
				>
					{t("newSession")}
				</Button>
				<Button
					variant="light"
					leftSection={<IconClock size={16} />}
					component={Link}
					to="/scheduled-tasks"
				>
					{t("scheduledTasks")}
				</Button>
				<Button
					variant="light"
					leftSection={<IconTerminal2 size={16} />}
					component={Link}
					// biome-ignore lint/suspicious/noExplicitAny: dynamic route params
					to={"/settings/terminals" as any}
				>
					{t("terminalManagement")}
				</Button>
			</Group>
		</Card>
	);
}
