import {
	Button,
	Card,
	Group,
	Loader,
	SimpleGrid,
	Stack,
	Text,
	ThemeIcon,
	Title,
} from "@mantine/core";
import {
	IconArrowRight,
	IconBox,
	IconCloud,
	IconDatabase,
	IconPlayerPlay,
	IconTerminal2,
	IconUsers,
	IconWand,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
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

	const { data: users } = useQuery({
		queryKey: ["admin", "users"],
		queryFn: api.listUsers,
		enabled: user?.role === "admin",
	});

	const { data: settings } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		enabled: user?.role === "admin",
	});

	const { data: terminals } = useQuery({
		queryKey: ["admin", "terminals"],
		queryFn: api.listAdminTerminals,
		enabled: user?.role === "admin",
	});

	const { data: containerSetup } = useQuery({
		queryKey: ["containerSetup"],
		queryFn: () => api.getContainerSetup(),
		staleTime: Number.POSITIVE_INFINITY,
		enabled: user?.role === "admin",
	});

	if (user && user.role !== "admin") {
		navigate({ to: "/" });
		return null;
	}

	if (!user) return <Loader />;

	const providerCount =
		(settings?.openaiProviders?.length ?? 0) +
		(settings?.anthropicProviders?.length ?? 0) +
		(settings?.nugProviders?.length ?? 0);

	const runningTerminals =
		terminals?.terminals?.filter((t: { status: string }) => t.status === "running") ?? [];

	return (
		<Stack>
			<Title order={2}>{t("adminDashboard")}</Title>
			<Text c="dimmed">{t("adminDashboardDesc")}</Text>

			<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
				<StatCard
					icon={<IconUsers size={22} />}
					color="indigo"
					label={t("adminUsers")}
					value={users?.length ?? 0}
					description={t("adminUsersDesc")}
					to="/admin/users"
				/>
				<StatCard
					icon={<IconCloud size={22} />}
					color="blue"
					label={t("adminProviders")}
					value={providerCount}
					description={t("adminProvidersDesc")}
					to="/admin/providers"
				/>
				<StatCard
					icon={<IconTerminal2 size={22} />}
					color="teal"
					label={t("adminTerminals")}
					value={runningTerminals.length}
					description={t("adminTerminalsShortDesc")}
					to="/admin/terminals"
				/>
				<StatCard
					icon={<IconBox size={22} />}
					color={containerSetup?.allReady ? "green" : "orange"}
					label={t("adminContainers")}
					value={
						containerSetup
							? containerSetup.allReady
								? t("containerSetupReady")
								: t("containerSetupNotReady")
							: "—"
					}
					description={t("adminContainersDesc")}
					to="/admin/containers"
				/>
				<StatCard
					icon={<IconDatabase size={22} />}
					color="grape"
					label={t("adminStorage")}
					value={ts("storageSection")}
					description={t("adminStorageDesc")}
					to="/admin/storage"
				/>
				<StatCard
					icon={<IconPlayerPlay size={22} />}
					color="orange"
					label={t("adminRuntime")}
					value={ts("runtimeSection")}
					description={t("adminRuntimeDesc")}
					to="/admin/runtime"
				/>
			</SimpleGrid>

			<Title order={4} mt="md">
				{t("adminQuickActions")}
			</Title>
			<Group>
				<Button
					variant="light"
					leftSection={<IconWand size={16} />}
					onClick={() => window.dispatchEvent(new CustomEvent("narrafork:open-wizard"))}
				>
					{ts("wizardReopen")}
				</Button>
			</Group>
		</Stack>
	);
}

function StatCard({
	icon,
	color,
	label,
	value,
	description,
	to,
}: {
	icon: React.ReactNode;
	color: string;
	label: string;
	value: number | string;
	description?: string;
	to: string;
}) {
	return (
		<Card withBorder component={Link} to={to} style={{ textDecoration: "none", cursor: "pointer" }}>
			<Group justify="space-between" mb="xs">
				<Text size="xs" tt="uppercase" fw={700} c="dimmed">
					{label}
				</Text>
				<ThemeIcon color={color} variant="light" size="md" radius="md">
					{icon}
				</ThemeIcon>
			</Group>
			<Text size="xl" fw={700} c={color}>
				{value}
			</Text>
			{description && (
				<Group justify="space-between" mt={4}>
					<Text size="xs" c="dimmed">
						{description}
					</Text>
					<IconArrowRight size={14} color="var(--mantine-color-dimmed)" />
				</Group>
			)}
		</Card>
	);
}
