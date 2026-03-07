import { Badge, Group, Loader, Paper, Stack, Switch, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useRoutines, useToggleRoutine } from "../../hooks/useRoutines";

export function RoutinesSection() {
	const { t } = useTranslation("settings");
	const { data, isLoading } = useRoutines();
	const toggle = useToggleRoutine();
	const { i18n } = useTranslation();
	const isZh = i18n.language?.startsWith("zh");

	if (isLoading) {
		return (
			<Paper withBorder p="md">
				<Loader size="sm" />
			</Paper>
		);
	}

	const routines = data?.routines ?? [];

	// Group by category
	const categories = [...new Set(routines.map((r) => r.category))];

	return (
		<Paper withBorder p="md">
			<Stack gap="md">
				<Group justify="space-between">
					<Title order={4}>{t("routinesSection")}</Title>
				</Group>
				<Text size="sm" c="dimmed">
					{t("routinesDesc")}
				</Text>

				{categories.map((cat) => (
					<Stack key={cat} gap="xs">
						<Text size="sm" fw={600} c="dimmed" tt="uppercase">
							{t(`routineCategory.${cat}`, cat)}
						</Text>
						{routines
							.filter((r) => r.category === cat)
							.map((routine) => (
								<Group key={routine.id} justify="space-between" wrap="nowrap">
									<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
										<Badge
											size="xs"
											variant="light"
											color={routine.type === "command" ? "indigo" : "teal"}
										>
											{t(`routineType.${routine.type}`)}
										</Badge>
										<Text size="sm" fw={500} truncate>
											{routine.type === "command" ? `/${routine.name}` : routine.name}
										</Text>
										<Text size="xs" c="dimmed" truncate>
											{isZh ? routine.descriptionZh : routine.descriptionEn}
										</Text>
									</Group>
									<Switch
										size="sm"
										checked={routine.enabled}
										onChange={() => toggle.mutate({ id: routine.id, enabled: !routine.enabled })}
									/>
								</Group>
							))}
					</Stack>
				))}

				{routines.length === 0 && (
					<Text size="sm" c="dimmed" ta="center">
						{t("routinesEmpty", "No built-in routines available")}
					</Text>
				)}
			</Stack>
		</Paper>
	);
}
