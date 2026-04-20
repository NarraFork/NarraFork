import { Affix, Box, Button, Group, NavLink, ScrollArea, Text, Transition } from "@mantine/core";
import {
	IconBell,
	IconBox,
	IconBrain,
	IconCloud,
	IconCpu,
	IconDatabase,
	IconInfoCircle,
	IconPalette,
	IconPlayerPlay,
	IconReceipt2,
	IconServer,
	IconTerminal2,
	IconUser,
	IconUsers,
} from "@tabler/icons-react";
import { createFileRoute, Link, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../hooks/useAuth";
import { InstanceSettingsProvider, useInstanceSettings } from "../hooks/useInstanceSettings";

export const Route = createFileRoute("/settings")({
	component: SettingsLayout,
});

interface NavItem {
	to: string;
	label: string;
	icon: React.ReactNode;
}

/** Paths that require admin role */
const ADMIN_PATHS = new Set([
	"/settings/providers",
	"/settings/chapters",
	"/settings/server",
	"/settings/users",
	"/settings/terminals",
	"/settings/storage",
	"/settings/runtime",
	"/settings/usage",
]);

function SettingsLayout() {
	const { data: user } = useCurrentUser();
	const { t } = useTranslation("settings");
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const instanceSettings = useInstanceSettings();
	const { isDirty, isSaving, save, highlight } = instanceSettings;
	const isAdmin = user?.role === "admin";

	const personalItems: NavItem[] = [
		{ to: "/settings/profile", label: t("profileSection"), icon: <IconUser size={18} /> },
		{ to: "/settings/models", label: t("modelsSection"), icon: <IconCpu size={18} /> },
		{ to: "/settings/agent", label: t("agentSection"), icon: <IconBrain size={18} /> },
		{
			to: "/settings/notifications",
			label: t("notificationSection"),
			icon: <IconBell size={18} />,
		},
		{ to: "/settings/appearance", label: t("appearanceSection"), icon: <IconPalette size={18} /> },
	];

	const instanceItems: NavItem[] = [
		{ to: "/settings/providers", label: t("providersSection"), icon: <IconCloud size={18} /> },
		{
			to: "/settings/chapters",
			label: t("chaptersAndContainersSection"),
			icon: <IconBox size={18} />,
		},
		{ to: "/settings/server", label: t("serverAndSystemSection"), icon: <IconServer size={18} /> },
		{ to: "/settings/users", label: t("usersSection"), icon: <IconUsers size={18} /> },
		{
			to: "/settings/terminals",
			label: t("terminalsSection"),
			icon: <IconTerminal2 size={18} />,
		},
		{ to: "/settings/storage", label: t("storageSection"), icon: <IconDatabase size={18} /> },
		{ to: "/settings/runtime", label: t("runtimeSection"), icon: <IconPlayerPlay size={18} /> },
		{ to: "/settings/usage", label: t("usageSection"), icon: <IconReceipt2 size={18} /> },
		{ to: "/settings/about", label: t("versionSection"), icon: <IconInfoCircle size={18} /> },
	];

	const allVisibleItems = isAdmin ? [...personalItems, ...instanceItems] : personalItems;

	// Redirect non-admin users away from admin-only settings pages
	if (user && !isAdmin && ADMIN_PATHS.has(pathname)) {
		return <Navigate to="/settings/profile" replace />;
	}

	return (
		<InstanceSettingsProvider value={instanceSettings}>
			<Group align="flex-start" wrap="nowrap" gap={0} style={{ minHeight: "calc(100vh - 120px)" }}>
				{/* Desktop: left sidebar navigation */}
				<Box
					component="nav"
					w={220}
					miw={220}
					style={{
						borderRight: "1px solid var(--mantine-color-default-border)",
						position: "sticky",
						top: 76,
						maxHeight: "calc(100vh - 92px)",
					}}
					visibleFrom="sm"
				>
					<ScrollArea h="calc(100vh - 92px)" pr="xs">
						<Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" pt="sm" pb={4}>
							{t("personalGroup")}
						</Text>
						{personalItems.map((item) => (
							<NavLink
								key={item.to}
								component={Link}
								to={item.to}
								label={item.label}
								leftSection={item.icon}
								active={pathname === item.to}
								variant="light"
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
										active={pathname === item.to}
										variant="light"
									/>
								))}
							</>
						)}
					</ScrollArea>
				</Box>

				{/* Main content column */}
				<Box style={{ flex: 1, minWidth: 0 }}>
					{/* Mobile: horizontal scrollable nav */}
					<Box
						hiddenFrom="sm"
						style={{
							borderBottom: "1px solid var(--mantine-color-default-border)",
						}}
					>
						<ScrollArea type="never" offsetScrollbars={false}>
							<Group gap={0} wrap="nowrap" px="xs" py={4}>
								{allVisibleItems.map((item) => (
									<NavLink
										key={item.to}
										component={Link}
										to={item.to}
										label={item.label}
										leftSection={item.icon}
										active={pathname === item.to}
										variant="light"
										style={{
											whiteSpace: "nowrap",
											flexShrink: 0,
											borderRadius: "var(--mantine-radius-sm)",
										}}
									/>
								))}
							</Group>
						</ScrollArea>
					</Box>

					<Box p="md" pb={80}>
						<Outlet />
					</Box>
				</Box>

				{/* Floating save button for instance settings (hidden on providers page which has its own) */}
				<Affix position={{ bottom: 24, right: 24 }}>
					<Transition transition="slide-up" mounted={isDirty && pathname !== "/settings/providers"}>
						{(styles) => (
							<Button
								onClick={save}
								loading={isSaving}
								size="md"
								style={{
									...styles,
									boxShadow: "0 4px 14px rgba(0, 0, 0, 0.25)",
									animation: highlight ? "settingsPulse 1.5s ease" : undefined,
								}}
							>
								{t("unsavedSave")}
							</Button>
						)}
					</Transition>
				</Affix>

				<style>{`
				@keyframes settingsPulse {
					0% { box-shadow: 0 0 0 0 var(--mantine-color-indigo-5); }
					40% { box-shadow: 0 0 0 10px transparent; }
					100% { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25); }
				}
			`}</style>
			</Group>
		</InstanceSettingsProvider>
	);
}
