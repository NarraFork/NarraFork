import { ActionIcon, Badge, Loader, Paper, Stack, Switch, Table, Text, Title } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";

export const Route = createFileRoute("/admin/")({
	component: AdminPage,
});

function AdminPage() {
	const { data: user } = useCurrentUser();
	const navigate = useNavigate();
	const { t } = useTranslation("common");
	const qc = useQueryClient();

	const { data: users, isLoading: usersLoading } = useQuery({
		queryKey: ["admin", "users"],
		queryFn: api.listUsers,
		enabled: user?.role === "admin",
	});

	const { data: settings } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		enabled: user?.role === "admin",
	});

	const deleteUser = useMutation({
		mutationFn: api.deleteUser,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
	});

	const updateAdminSettings = useMutation({
		mutationFn: api.updateAdminSettings,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "settings"] }),
	});

	// Redirect non-admin users
	if (user && user.role !== "admin") {
		navigate({ to: "/" });
		return null;
	}

	if (usersLoading) return <Loader />;

	return (
		<Stack>
			<Title order={2}>{t("adminPanel")}</Title>

			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("registrationSettings")}</Title>
					<Switch
						label={t("registrationOpen")}
						checked={settings?.auth?.registrationOpen ?? true}
						onChange={(e) =>
							updateAdminSettings.mutate({
								registrationOpen: e.currentTarget.checked,
							})
						}
					/>
				</Stack>
			</Paper>

			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("userManagement")}</Title>
					{!users?.length ? (
						<Text c="dimmed">{t("noUsers")}</Text>
					) : (
						<Table>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>{t("username")}</Table.Th>
									<Table.Th>{t("role")}</Table.Th>
									<Table.Th>{t("createdAt")}</Table.Th>
									<Table.Th />
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{users.map((u: any) => (
									<Table.Tr key={u.id}>
										<Table.Td>{u.username}</Table.Td>
										<Table.Td>
											<Badge color={u.role === "admin" ? "indigo" : "gray"}>{u.role}</Badge>
										</Table.Td>
										<Table.Td>
											<Text size="sm">{new Date(u.createdAt).toLocaleDateString()}</Text>
										</Table.Td>
										<Table.Td>
											{u.id !== user?.id && (
												<ActionIcon
													color="red"
													variant="subtle"
													onClick={() => deleteUser.mutate(u.id)}
													loading={deleteUser.isPending}
												>
													<IconTrash size={16} />
												</ActionIcon>
											)}
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					)}
				</Stack>
			</Paper>
		</Stack>
	);
}
