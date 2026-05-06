import { Box, NavLink, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
	IconBell,
	IconBox,
	IconBrain,
	IconChevronRight,
	IconCloud,
	IconCpu,
	IconDatabase,
	IconInfoCircle,
	IconPalette,
	IconPlayerPlay,
	IconReceipt2,
	IconServer,
	IconShield,
	IconTerminal2,
	IconUser,
	IconUsers,
	IconWand,
} from "@tabler/icons-react";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";

export const Route = createFileRoute("/settings/")({
	component: SettingsIndex,
});

function SettingsIndex() {
	const isMobile = useMediaQuery("(max-width: 48em)", undefined, {
		getInitialValueInEffect: false,
	});

	// Desktop: redirect to profile as before
	if (!isMobile) return <Navigate to="/settings/profile" replace />;

	// Mobile: show navigation list
	return <MobileSettingsNav />;
}

function MobileSettingsNav() {
	const { t } = useTranslation("settings");
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const openSetupWizard = () => {
		window.dispatchEvent(new CustomEvent("narrafork:open-wizard"));
	};

	const personalItems = [
		{ to: "/settings/profile", label: t("profileSection"), icon: <IconUser size={20} /> },
		{ to: "/settings/models", label: t("modelsSection"), icon: <IconCpu size={20} /> },
		{ to: "/settings/agent", label: t("agentSection"), icon: <IconBrain size={20} /> },
		{
			to: "/settings/notifications",
			label: t("notificationSection"),
			icon: <IconBell size={20} />,
		},
		{
			to: "/settings/appearance",
			label: t("appearanceSection"),
			icon: <IconPalette size={20} />,
		},
	];

	const instanceItems = [
		{ to: "/settings/providers", label: t("providersSection"), icon: <IconCloud size={20} /> },
		{
			to: "/settings/proxy",
			label: t("proxyManagementSection"),
			icon: <IconShield size={20} />,
		},
		{
			to: "/settings/chapters",
			label: t("chaptersAndContainersSection"),
			icon: <IconBox size={20} />,
		},
		{
			to: "/settings/server",
			label: t("serverAndSystemSection"),
			icon: <IconServer size={20} />,
		},
		{ to: "/settings/users", label: t("usersSection"), icon: <IconUsers size={20} /> },
		{
			to: "/settings/terminals",
			label: t("terminalsSection"),
			icon: <IconTerminal2 size={20} />,
		},
		{ to: "/settings/storage", label: t("storageSection"), icon: <IconDatabase size={20} /> },
		{
			to: "/settings/runtime",
			label: t("runtimeSection"),
			icon: <IconPlayerPlay size={20} />,
		},
		{ to: "/settings/usage", label: t("usageSection"), icon: <IconReceipt2 size={20} /> },
		{
			to: "/settings/about",
			label: t("versionSection"),
			icon: <IconInfoCircle size={20} />,
		},
	];

	return (
		<Box px="xs" py="sm">
			<Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" pb={4}>
				{t("personalGroup")}
			</Text>
			{personalItems.map((item) => (
				<NavLink
					key={item.to}
					component={Link}
					to={item.to}
					label={item.label}
					leftSection={item.icon}
					rightSection={<IconChevronRight size={16} stroke={1.5} />}
					variant="subtle"
				/>
			))}

			{isAdmin && (
				<>
					<Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" pt="md" pb={4}>
						{t("instanceGroup")}
					</Text>
					{instanceItems.map((item) => (
						<NavLink
							key={item.to}
							component={Link}
							to={item.to}
							label={item.label}
							leftSection={item.icon}
							rightSection={<IconChevronRight size={16} stroke={1.5} />}
							variant="subtle"
						/>
					))}
					<NavLink
						label={t("wizardReopen")}
						leftSection={<IconWand size={20} />}
						onClick={openSetupWizard}
						variant="subtle"
						mt="md"
					/>
				</>
			)}
		</Box>
	);
}
