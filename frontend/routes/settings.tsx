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
import { IconArrowLeft, IconShieldLock, IconWand } from "@tabler/icons-react";
import { createFileRoute, Link, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../hooks/useAuth";
import { InstanceSettingsProvider, useInstanceSettings } from "../hooks/useInstanceSettings";
import {
	useSettingsFeatureCapability,
	useSettingsValidationCapability,
} from "../hooks/usePlatform";
import { APP_VIEWPORT_BOTTOM, SAFE_AREA_INSET_BOTTOM } from "../lib/safe-area";
import {
	getSettingsNavGroups,
	getVisibleSettingsNavItems,
	isAdminPath,
	type SettingsNavItem,
} from "../lib/settings-nav";

export const Route = createFileRoute("/settings")({
	component: SettingsLayout,
});

/** Viewport minus the header offset and Main's own vertical gutters. */
const SETTINGS_SIDEBAR_HEIGHT = `calc(${APP_VIEWPORT_BOTTOM} - 92px)`;

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

	// Shared with the mobile picker (`routes/settings/index.tsx`) so a new page
	// cannot appear on one surface and silently miss the other.
	const { personal, enhancements, instance } = getSettingsNavGroups();
	const allVisibleItems = getVisibleSettingsNavItems(isAdmin);

	// Find current page label for mobile back header
	const currentItem = allVisibleItems.find((item) => pathname === item.to);

	// Redirect non-admin users away from admin-only settings pages
	if (user && !isAdmin && isAdminPath(pathname)) {
		return <Navigate to="/settings/profile" replace />;
	}

	const renderNavItem = (item: SettingsNavItem) => (
		<NavLink
			key={item.to}
			component={Link}
			to={item.to}
			label={t(item.labelKey)}
			leftSection={<item.Icon size={18} />}
			active={pathname === item.to || pathname.startsWith(`${item.to}/`)}
			variant="light"
		/>
	);

	return (
		<InstanceSettingsProvider value={instanceSettings}>
			<Group
				align="flex-start"
				wrap="nowrap"
				gap={0}
				style={{ minHeight: `calc(${APP_VIEWPORT_BOTTOM} - 120px)` }}
			>
				{/* Desktop: left sidebar navigation. */}
				<Box
					component="nav"
					data-settings-desktop-sidebar
					w={220}
					miw={220}
					style={{
						borderRight: "1px solid var(--mantine-color-default-border)",
						position: "sticky",
						// AppShell.Main owns the 60px header + md gutter as scroll-container padding.
						// A sticky inset is measured from that padded edge, so any non-zero value would
						// add the same header offset again once Main becomes scrollable.
						top: 0,
						maxHeight: SETTINGS_SIDEBAR_HEIGHT,
					}}
					visibleFrom="sm"
				>
					<ScrollArea h={SETTINGS_SIDEBAR_HEIGHT} pr="xs">
						<Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" pt="sm" pb={4}>
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
									leftSection={<IconWand size={18} />}
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
									{t(currentItem.labelKey)}
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
				<Affix position={{ bottom: `calc(24px + ${SAFE_AREA_INSET_BOTTOM})`, right: 24 }}>
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
