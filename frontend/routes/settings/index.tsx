import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { getSettingsNavGroups, type SettingsNavItem } from "@frontend/lib/settings-nav";
import { Alert, Box, NavLink, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconChevronRight, IconShieldLock, IconWand } from "@tabler/icons-react";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";

export const Route = createFileRoute("/settings/")({
	component: SettingsIndex,
});

function SettingsIndex() {
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY, undefined, {
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

	// Shared with the desktop sidebar (`routes/settings.tsx`). This list used to be
	// a second hand-maintained copy and silently dropped gateway / devices /
	// execution-log; both surfaces must render from `settings-nav`.
	const { personal, enhancements, instance } = getSettingsNavGroups();

	const renderNavItem = (item: SettingsNavItem) => (
		<NavLink
			key={item.to}
			component={Link}
			to={item.to}
			label={t(item.labelKey)}
			leftSection={<item.Icon size={20} />}
			rightSection={<IconChevronRight size={16} stroke={1.5} />}
			variant="subtle"
		/>
	);

	return (
		<Box px="xs" py="sm">
			<Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" pb={4}>
				{t("personalGroup")}
			</Text>
			{personal.map(renderNavItem)}

			<Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" pt="md" pb={4}>
				{t("enhancementsGroup")}
			</Text>
			{enhancements.map(renderNavItem)}

			{isAdmin && (
				<>
					<Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" pt="md" pb={4}>
						{t("instanceGroup")}
					</Text>
					{instance.map(renderNavItem)}
					<NavLink
						label={t("wizardReopen")}
						leftSection={<IconWand size={20} />}
						onClick={openSetupWizard}
						variant="subtle"
						mt="md"
					/>
				</>
			)}
			{!isAdmin && (
				<>
					<Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" pt="md" pb={4}>
						{t("instanceGroup")}
					</Text>
					<Alert
						color="gray"
						variant="light"
						icon={<IconShieldLock size={18} />}
						title={t("instanceAdminOnlyTitle")}
						mx="sm"
						mt={4}
					>
						<Text size="xs">{t("instanceAdminOnlyHint")}</Text>
					</Alert>
				</>
			)}
		</Box>
	);
}
