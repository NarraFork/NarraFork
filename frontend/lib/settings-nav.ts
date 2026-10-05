import {
	IconApps,
	IconBell,
	IconBox,
	IconBrain,
	IconCloud,
	IconCpu,
	IconDatabase,
	IconDeviceLaptop,
	IconHistory,
	IconInfoCircle,
	IconKey,
	IconMessageCircle,
	IconPalette,
	IconPlayerPlay,
	IconPlugConnected,
	IconPuzzle,
	IconReceipt2,
	IconRoute,
	IconSearch,
	IconServer,
	IconShield,
	IconShieldLock,
	IconSitemap,
	IconTerminal2,
	IconUser,
	IconUsers,
} from "@tabler/icons-react";
import type { ComponentType } from "react";

/**
 * Single source of truth for the settings navigation.
 *
 * The desktop sidebar (`routes/settings.tsx`) and the mobile picker
 * (`routes/settings/index.tsx`) used to carry independent hand-maintained lists.
 * Every new settings page had to be added twice, and the mobile copy silently
 * drifted more than once (grammars once, then gateway / devices / execution-log).
 * Both surfaces now render from this module; keep new entries here only.
 */
export type SettingsNavGroupId = "personal" | "enhancements" | "instance";

export interface SettingsNavItem {
	to: string;
	/** i18n key in the `settings` namespace */
	labelKey: string;
	Icon: ComponentType<{ size?: number | string }>;
}

export interface SettingsNavGroups {
	personal: readonly SettingsNavItem[];
	enhancements: readonly SettingsNavItem[];
	instance: readonly SettingsNavItem[];
}

export const SETTINGS_NAV_GROUP_ORDER: readonly SettingsNavGroupId[] = [
	"personal",
	"enhancements",
	"instance",
] as const;

/**
 * Paths that require admin role. Keep in lockstep with `instance` items:
 * every instance entry is admin-only except `/settings/about` (version info is
 * linkable for admins in the nav, but a non-admin may still open it by URL).
 * Personal and enhancement entries must never appear here.
 */
export const ADMIN_PATHS: ReadonlySet<string> = new Set([
	"/settings/providers",
	"/settings/search",
	"/settings/proxy",
	"/settings/chapters",
	"/settings/server",
	// Models and agent defaults are instance-wide (PATCH /api/settings), not per-user.
	"/settings/models",
	"/settings/agent",
	"/settings/authentication",
	"/settings/oauth-apps",
	"/settings/users",
	"/settings/terminals",
	"/settings/storage",
	"/settings/runtime",
	"/settings/usage",
	"/settings/execution-log",
	"/settings/plugins",
]);

/** Exact match or sub-path of an admin-only page (e.g. /settings/plugins/:id). */
export function isAdminPath(pathname: string): boolean {
	if (ADMIN_PATHS.has(pathname)) return true;
	for (const adminPath of ADMIN_PATHS) {
		if (pathname.startsWith(`${adminPath}/`)) return true;
	}
	return false;
}

/**
 * Account-level settings. Visible to every user.
 *
 * Devices is personal on purpose: a user registers their own machines and sees
 * only those. Admins still get the full list from the page itself, and the API
 * enforces the same boundary per endpoint.
 */
const personalItems: readonly SettingsNavItem[] = [
	{ to: "/settings/profile", labelKey: "profileSection", Icon: IconUser },
	{ to: "/settings/security", labelKey: "securitySection", Icon: IconShieldLock },
	{ to: "/settings/integrations", labelKey: "integrationsSection", Icon: IconRoute },
	{ to: "/settings/connected-apps", labelKey: "connectedAppsSection", Icon: IconPlugConnected },
	{ to: "/settings/notifications", labelKey: "notificationSection", Icon: IconBell },
	{ to: "/settings/appearance", labelKey: "appearanceSection", Icon: IconPalette },
	{ to: "/settings/gateway", labelKey: "gatewaySection", Icon: IconMessageCircle },
	{ to: "/settings/devices", labelKey: "devicesSection", Icon: IconDeviceLaptop },
];

/**
 * Capability toggles rather than personal preferences. Grammar caching sat among
 * account/notification/appearance settings, where it read as a preference; it
 * decides whether structural tooling works at all, which is a different kind of
 * thing. Still not admin-only: the grammar cache is a shared parser asset (like
 * ripgrep), and gating it would leave non-admins stuck with heuristic structural
 * output.
 */
const enhancementItems: readonly SettingsNavItem[] = [
	{ to: "/settings/grammars", labelKey: "grammarsSection", Icon: IconSitemap },
];

/** Instance-wide configuration. Admin-only in the nav; `about` is also URL-reachable for non-admins. */
const instanceItems: readonly SettingsNavItem[] = [
	{ to: "/settings/providers", labelKey: "providersSection", Icon: IconCloud },
	{ to: "/settings/models", labelKey: "modelsSection", Icon: IconCpu },
	{ to: "/settings/agent", labelKey: "agentSection", Icon: IconBrain },
	{ to: "/settings/search", labelKey: "searchSection", Icon: IconSearch },
	{ to: "/settings/proxy", labelKey: "proxyManagementSection", Icon: IconShield },
	{ to: "/settings/chapters", labelKey: "chaptersAndContainersSection", Icon: IconBox },
	{ to: "/settings/server", labelKey: "serverAndSystemSection", Icon: IconServer },
	{ to: "/settings/authentication", labelKey: "authenticationSection", Icon: IconKey },
	{ to: "/settings/oauth-apps", labelKey: "oauthAppsSection", Icon: IconApps },
	{ to: "/settings/users", labelKey: "usersSection", Icon: IconUsers },
	{ to: "/settings/terminals", labelKey: "terminalsSection", Icon: IconTerminal2 },
	{ to: "/settings/storage", labelKey: "storageSection", Icon: IconDatabase },
	{ to: "/settings/runtime", labelKey: "runtimeSection", Icon: IconPlayerPlay },
	{ to: "/settings/plugins", labelKey: "pluginsSection", Icon: IconPuzzle },
	{ to: "/settings/usage", labelKey: "usageSection", Icon: IconReceipt2 },
	{ to: "/settings/execution-log", labelKey: "executionLogSection", Icon: IconHistory },
	{ to: "/settings/about", labelKey: "versionSection", Icon: IconInfoCircle },
];

/** Full settings nav. Instance entries are admin-gated by the callers, not filtered here. */
export function getSettingsNavGroups(): SettingsNavGroups {
	return {
		personal: personalItems,
		enhancements: enhancementItems,
		instance: instanceItems,
	};
}

/**
 * Flattened nav in group order. Used for the mobile back-header title and the
 * desktop active-item highlight, which must see the same pages the menus offer.
 */
export function getVisibleSettingsNavItems(isAdmin: boolean): readonly SettingsNavItem[] {
	const groups = getSettingsNavGroups();
	return isAdmin
		? [...groups.personal, ...groups.enhancements, ...groups.instance]
		: [...groups.personal, ...groups.enhancements];
}
