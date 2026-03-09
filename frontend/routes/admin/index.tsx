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
	ThemeIcon,
	Title,
} from "@mantine/core";
import {
	IconCheck,
	IconPencil,
	IconRefresh,
	IconTrash,
	IconWand,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
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
	const { t: ts } = useTranslation("settings");
	const qc = useQueryClient();

	const [editingUser, setEditingUser] = useState<{ id: string; username: string } | null>(null);
	const [editUsername, setEditUsername] = useState("");
	const [editPassword, setEditPassword] = useState("");

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

	const updateUser = useMutation({
		mutationFn: ({ id, data }: { id: string; data: { username?: string; password?: string } }) =>
			api.updateUser(id, data),
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

	// Redirect non-admin users
	if (user && user.role !== "admin") {
		navigate({ to: "/" });
		return null;
	}

	if (usersLoading) return <Loader />;

	return (
		<Stack>
			<Title order={2}>{t("adminPanel")}</Title>

			<Button
				variant="light"
				leftSection={<IconWand size={16} />}
				onClick={() => window.dispatchEvent(new CustomEvent("narrafork:open-wizard"))}
			>
				{ts("wizardReopen")}
			</Button>

			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("providers")}</Title>
					<Button variant="light" onClick={() => navigate({ to: "/admin/providers" })}>
						{t("providers")}
					</Button>
				</Stack>
			</Paper>

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
											<Badge color={u.role === "admin" ? "indigo" : "gray"}>{u.role}</Badge>
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
														onClick={() => deleteUser.mutate(u.id)}
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

			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("terminalManagement")}</Title>
					<Button variant="light" onClick={() => navigate({ to: "/admin/terminals" })}>
						{t("terminalManageAll")}
					</Button>
				</Stack>
			</Paper>

			<ContainerSetupPanel t={t} />

			<Paper withBorder p="md">
				<Stack>
					<Group>
						</Button>
						</Button>
						</Button>
					</Group>
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
							{t("cancel", { ns: "common", defaultValue: "Cancel" })}
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

// === Container Setup Checklist ===

function ContainerSetupPanel({
	t,
}: {
	t: (key: string, opts?: Record<string, unknown>) => string;
}) {
	const qc = useQueryClient();
	const { data, isLoading } = useQuery({
		queryKey: ["containerSetup"],
		queryFn: () => api.getContainerSetup(),
		staleTime: Number.POSITIVE_INFINITY,
	});

	// Refetch with refresh=true to bypass server cache
	const [rechecking, setRechecking] = useState(false);
	const recheckFresh = async () => {
		setRechecking(true);
		try {
			const fresh = await api.getContainerSetup(true);
			qc.setQueryData(["containerSetup"], fresh);
		} finally {
			setRechecking(false);
		}
	};

	const renderStatus = (ok: boolean, label: string, detail: string) => (
		<Group gap="xs" wrap="nowrap">
			<ThemeIcon color={ok ? "green" : "red"} size="sm" variant="light">
				{ok ? <IconCheck size={14} /> : <IconX size={14} />}
			</ThemeIcon>
			<Text size="sm" fw={500} style={{ minWidth: 160 }}>
				{label}
			</Text>
			<Text size="xs" c="dimmed">
				{detail}
			</Text>
		</Group>
	);

	return (
		<Paper withBorder p="md">
			<Stack>
				<Group justify="space-between">
					<Title order={4}>{t("containerSetup")}</Title>
					{data && (
						<Badge color={data.allReady ? "green" : "red"} variant="light">
							{data.allReady ? t("containerSetupReady") : t("containerSetupNotReady")}
						</Badge>
					)}
				</Group>
				<Text size="sm" c="dimmed">
					{t("containerSetupDesc")}
				</Text>

				{isLoading ? (
					<Loader size="sm" />
				) : data ? (
					<Stack gap="xs">
						{renderStatus(
							data.podman.ok,
							t("containerSetupPodman"),
							data.podman.ok
								? t("containerSetupInstalled", { version: data.podman.version })
								: t("containerSetupNotInstalled"),
						)}
						{renderStatus(
							data.podmanCompose.ok,
							t("containerSetupPodmanCompose"),
							data.podmanCompose.ok
								? t("containerSetupInstalled", { version: data.podmanCompose.version })
								: t("containerSetupNotInstalled"),
						)}
						{renderStatus(
							data.composeProvider.ok,
							t("containerSetupComposeProvider"),
							data.composeProvider.provider
								? data.composeProvider.ok
									? t("containerSetupCorrect", { provider: data.composeProvider.provider })
									: t("containerSetupIncorrect", { provider: data.composeProvider.provider })
								: t("containerSetupNotConfigured"),
						)}
						{renderStatus(
							data.passt.ok,
							t("containerSetupPasst"),
							data.passt.ok
								? t("containerSetupInstalled", { version: data.passt.version ?? "" })
								: t("containerSetupNotInstalled"),
						)}
						{renderStatus(
							data.rootlessNetwork.ok,
							t("containerSetupRootlessNetwork"),
							data.rootlessNetwork.backend
								? data.rootlessNetwork.ok
									? t("containerSetupRootlessNetworkSupported", {
											backend: data.rootlessNetwork.backend,
										})
									: t("containerSetupRootlessNetworkUnsupported", {
											backend: data.rootlessNetwork.backend,
										})
								: t("containerSetupNotConfigured"),
						)}
					</Stack>
				) : null}

				<Group>
					<Button
						variant="light"
						size="xs"
						leftSection={<IconRefresh size={14} />}
						onClick={recheckFresh}
						loading={isLoading || rechecking}
					>
						{t("containerSetupRecheck")}
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
}
