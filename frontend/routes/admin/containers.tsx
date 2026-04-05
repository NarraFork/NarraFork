import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	ThemeIcon,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowLeft, IconCheck, IconRefresh, IconX } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";

export const Route = createFileRoute("/admin/containers")({
	component: AdminContainersPage,
});

function AdminContainersPage() {
	const { data: user } = useCurrentUser();
	const navigate = useNavigate();
	const { t } = useTranslation("common");
	const qc = useQueryClient();

	const [rechecking, setRechecking] = useState(false);

	const { data, isLoading } = useQuery({
		queryKey: ["containerSetup"],
		queryFn: () => api.getContainerSetup(),
		staleTime: Number.POSITIVE_INFINITY,
		enabled: user?.role === "admin",
	});

	const recheckFresh = async () => {
		setRechecking(true);
		try {
			const fresh = await api.getContainerSetup(true);
			qc.setQueryData(["containerSetup"], fresh);
		} catch {
			notifications.show({
				color: "red",
				message: t("containerRecheckFailed"),
			});
		} finally {
			setRechecking(false);
		}
	};

	if (user && user.role !== "admin") {
		navigate({ to: "/" });
		return null;
	}

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
		<Stack>
			<Group justify="space-between">
				<Group mb="xs">
					<ActionIcon variant="subtle" component={Link} to="/admin">
						<IconArrowLeft size={18} />
					</ActionIcon>
					<Title order={2}>{t("containerSetup")}</Title>
				</Group>
				{data && (
					<Badge color={data.allReady ? "green" : "red"} variant="light" size="lg">
						{data.allReady ? t("containerSetupReady") : t("containerSetupNotReady")}
					</Badge>
				)}
			</Group>
			<Text size="sm" c="dimmed">
				{t("containerSetupDesc")}
			</Text>

			<Paper withBorder p="md">
				<Stack>
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
		</Stack>
	);
}
