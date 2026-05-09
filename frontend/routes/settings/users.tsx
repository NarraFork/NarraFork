import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Loader,
	Modal,
	Paper,
	Stack,
	Switch,
	Table,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/ConfirmDialogProvider";
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";

export const Route = createFileRoute("/settings/users")({
	component: SettingsUsersPage,
});

const SETTINGS_USERS_QUERY_GC_TIME_MS = 60_000;

function SettingsUsersPage() {
	const { data: user } = useCurrentUser();
	const { t } = useTranslation("common");
	const confirm = useConfirmDialog();
	const qc = useQueryClient();

	const [editingUser, setEditingUser] = useState<{ id: string; username: string } | null>(null);
	const [editUsername, setEditUsername] = useState("");
	const [editPassword, setEditPassword] = useState("");

	const { data: users, isLoading: usersLoading } = useQuery({
		queryKey: ["admin", "users"],
		queryFn: api.listUsers,
		enabled: user?.role === "admin",
		gcTime: SETTINGS_USERS_QUERY_GC_TIME_MS,
	});

	const { data: settings } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		enabled: user?.role === "admin",
		gcTime: SETTINGS_USERS_QUERY_GC_TIME_MS,
	});

	const deleteUser = useMutation({
		mutationFn: api.deleteUser,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
	});

	const updateAdminSettings = useMutation({
		mutationFn: api.updateAdminSettings,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "settings"] }),
	});

	const updateUser = useMutation({
		mutationFn: ({
			id,
			data,
		}: {
			id: string;
			data: { username?: string; password?: string; role?: "admin" | "user" };
		}) => api.updateUser(id, data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["admin", "users"] });
			setEditingUser(null);
		},
	});

	const openEditModal = (u: { id: string; username: string }) => {
		setEditingUser(u);
		setEditUsername(u.username);
		setEditPassword("");
	};

	const handleEditSubmit = () => {
		if (!editingUser) return;
		const data: { username?: string; password?: string } = {};
		if (editUsername && editUsername !== editingUser.username) data.username = editUsername;
		if (editPassword) data.password = editPassword;
		if (!data.username && !data.password) {
			setEditingUser(null);
			return;
		}
		updateUser.mutate({ id: editingUser.id, data });
	};

	if (usersLoading) return <Loader />;

	return (
		<Stack>
			<Title order={3}>{t("adminUsersDesc")}</Title>

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
									<Table.Th>{t("actions")}</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
								{users.map((u: any) => (
									<Table.Tr key={u.id}>
										<Table.Td>{u.username}</Table.Td>
										<Table.Td>
											{u.id === user?.id ? (
												<Badge color="indigo">{u.role}</Badge>
											) : (
												<Badge
													color={u.role === "admin" ? "indigo" : "gray"}
													style={{ cursor: "pointer" }}
													onClick={async () => {
														const newRole = u.role === "admin" ? "user" : "admin";
														const msg =
															newRole === "admin"
																? t("confirmPromoteAdmin", { username: u.username })
																: t("confirmDemoteAdmin", { username: u.username });
														if (await confirm({ message: msg })) {
															updateUser.mutate({ id: u.id, data: { role: newRole } });
														}
													}}
												>
													{u.role}
												</Badge>
											)}
										</Table.Td>
										<Table.Td>
											<Text size="sm">{new Date(u.createdAt).toLocaleDateString()}</Text>
										</Table.Td>
										<Table.Td>
											<Group gap="xs">
												<ActionIcon color="blue" variant="subtle" onClick={() => openEditModal(u)}>
													<IconPencil size={16} />
												</ActionIcon>
												{u.id !== user?.id && (
													<ActionIcon
														color="red"
														variant="subtle"
														onClick={async () => {
															if (
																await confirm({
																	message: t("confirmDeleteUser", { username: u.username }),
																})
															) {
																deleteUser.mutate(u.id);
															}
														}}
														loading={deleteUser.isPending}
													>
														<IconTrash size={16} />
													</ActionIcon>
												)}
											</Group>
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					)}
				</Stack>
			</Paper>

			<Modal opened={!!editingUser} onClose={() => setEditingUser(null)} title={t("editUser")}>
				<Stack>
					<TextInput
						label={t("newUsername")}
						value={editUsername}
						onChange={(e) => setEditUsername(e.currentTarget.value)}
					/>
					<TextInput
						label={t("newPassword")}
						type="password"
						placeholder={t("newPasswordPlaceholder")}
						value={editPassword}
						onChange={(e) => setEditPassword(e.currentTarget.value)}
					/>
					{updateUser.isError && (
						<Text c="red" size="sm">
							{(updateUser.error as Error).message}
						</Text>
					)}
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setEditingUser(null)}>
							{t("cancel")}
						</Button>
						<Button onClick={handleEditSubmit} loading={updateUser.isPending}>
							{t("save")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	);
}
