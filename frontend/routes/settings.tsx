import {
	Affix,
	Alert,
	Box,
	Button,
	Group,
	NavLink,
	ScrollArea,
	Text,
	Transition,
} from "@mantine/core";
import {
	IconArrowLeft,
	IconBell,
	IconBox,
	IconBrain,
	IconCloud,
	IconCpu,
	IconDatabase,
	IconInfoCircle,
	IconKey,
	IconMessageCircle,
	IconPalette,
	IconPlayerPlay,
	IconReceipt2,
	IconSearch,
	IconServer,
	IconShield,
	IconShieldLock,
	IconTerminal2,
	IconUser,
	IconUsers,
	IconWand,
} from "@tabler/icons-react";
import { createFileRoute, Link, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../hooks/useAuth";
import { InstanceSettingsProvider, useInstanceSettings } from "../hooks/useInstanceSettings";
import {
	useSettingsFeatureCapability,
	useSettingsValidationCapability,
} from "../hooks/usePlatform";

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
	"/settings/search",
	"/settings/proxy",
	"/settings/chapters",
	"/settings/server",
	"/settings/authentication",
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
	const settingsValidation = useSettingsValidationCapability();
	const settingsFeatureCapability = useSettingsFeatureCapability();
	const isAdmin = user?.role === "admin";
	const openSetupWizard = () => {
		window.dispatchEvent(new CustomEvent("narrafork:open-wizard"));
	};

	const personalItems: NavItem[] = [
		{ to: "/settings/profile", label: t("profileSection"), icon: <IconUser size={18} /> },
		{ to: "/settings/security", label: t("securitySection"), icon: <IconShieldLock size={18} /> },
		{ to: "/settings/models", label: t("modelsSection"), icon: <IconCpu size={18} /> },
		{ to: "/settings/agent", label: t("agentSection"), icon: <IconBrain size={18} /> },
		{
			to: "/settings/notifications",
			label: t("notificationSection"),
			icon: <IconBell size={18} />,
		},
		{ to: "/settings/appearance", label: t("appearanceSection"), icon: <IconPalette size={18} /> },
		{
			to: "/settings/gateway",
			label: t("gatewaySection"),
			icon: <IconMessageCircle size={18} />,
		},
	];

	const instanceItems: NavItem[] = [
		{ to: "/settings/providers", label: t("providersSection"), icon: <IconCloud size={18} /> },
		{ to: "/settings/search", label: t("searchSection"), icon: <IconSearch size={18} /> },
		{
			to: "/settings/proxy",
			label: t("proxyManagementSection"),
			icon: <IconShield size={18} />,
		},
		{
			to: "/settings/chapters",
			label: t("chaptersAndContainersSection"),
			icon: <IconBox size={18} />,
		},
		{ to: "/settings/server", label: t("serverAndSystemSection"), icon: <IconServer size={18} /> },
		{
			to: "/settings/authentication",
			label: t("authenticationSection"),
			icon: <IconKey size={18} />,
		},
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

	// Find current page label for mobile back header
	const currentItem = allVisibleItems.find((item) => pathname === item.to);

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
								<NavLink
									label={t("wizardReopen")}
									leftSection={<IconWand size={18} />}
									onClick={openSetupWizard}
									variant="subtle"
									mt="md"
								/>
							</>
						)}
					</ScrollArea>
				</Box>

				{/* Main content column */}
				<Box style={{ flex: 1, minWidth: 0 }}>
					{/* Mobile: back button header (only on sub-pages, not on index) */}
					{currentItem && (
						<Box
							hiddenFrom="sm"
							px="xs"
							py={8}
							style={{
								borderBottom: "1px solid var(--mantine-color-default-border)",
							}}
						>
							<Link
								to="/settings"
								style={{
									display: "flex",
									alignItems: "center",
									gap: 6,
									textDecoration: "none",
									color: "inherit",
								}}
							>
								<IconArrowLeft size={18} />
								<Text size="sm" fw={500}>
									{currentItem.label}
								</Text>
							</Link>
						</Box>
					)}

					<Box p="md" pb={80}>
						{settingsValidation.looseValidation && (
							<Alert
								color="yellow"
								variant="light"
								mb="md"
								title={t("settingsLooseValidationWarning")}
							>
								{settingsValidation.reason ?? t("settingsLooseValidationWarningDesc")}
							</Alert>
						)}
						{!settingsFeatureCapability.patchSupported && (
							<Alert
								color="yellow"
								variant="light"
								mb="md"
								title={t("settingsPatchUnsupportedWarning")}
							>
								{t("settingsPatchUnsupportedWarningDesc")}
							</Alert>
						)}
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
								disabled={!settingsFeatureCapability.patchSupported}
								title={
									!settingsFeatureCapability.patchSupported
										? t("settingsPatchUnsupportedWarningDesc")
										: undefined
								}
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
