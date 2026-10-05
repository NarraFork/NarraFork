import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
	ADMIN_PATHS,
	getSettingsNavGroups,
	getVisibleSettingsNavItems,
	isAdminPath,
	type SettingsNavItem,
} from "./settings-nav";

/**
 * The mobile picker and the desktop sidebar used to carry independent lists.
 * Gateway / devices / execution-log were added to the desktop sidebar only, so a
 * phone could not reach those pages at all. This suite locks the shared inventory
 * and the admin-path boundary so the two surfaces cannot drift again.
 */
function flatten(groups: ReturnType<typeof getSettingsNavGroups>): SettingsNavItem[] {
	return [...groups.personal, ...groups.enhancements, ...groups.instance];
}

/**
 * Product inventory, not a re-derivation of the config. Each group is locked as a
 * complete ordered path list so deleting or reordering a single entry fails here
 * even when the config and both surfaces stay consistent with each other.
 */
const EXPECTED_PERSONAL = [
	"/settings/profile",
	"/settings/security",
	"/settings/integrations",
	"/settings/connected-apps",
	"/settings/notifications",
	"/settings/appearance",
	// Previously missing from the mobile picker entirely.
	"/settings/gateway",
	"/settings/devices",
] as const;

const EXPECTED_ENHANCEMENTS = ["/settings/grammars"] as const;

const EXPECTED_INSTANCE = [
	"/settings/providers",
	"/settings/models",
	"/settings/agent",
	"/settings/search",
	"/settings/proxy",
	"/settings/chapters",
	"/settings/server",
	"/settings/authentication",
	"/settings/oauth-apps",
	"/settings/users",
	"/settings/terminals",
	"/settings/storage",
	"/settings/runtime",
	// Instance-level; the mobile picker used to list it under personal.
	"/settings/plugins",
	"/settings/usage",
	// Previously missing from the mobile picker entirely.
	"/settings/execution-log",
	// Not admin-gated: reachable by URL for every user.
	"/settings/about",
] as const;

describe("settings nav inventory", () => {
	test("each group is exactly the locked ordered path list", () => {
		const groups = getSettingsNavGroups();
		expect(groups.personal.map((item) => item.to)).toEqual([...EXPECTED_PERSONAL]);
		expect(groups.enhancements.map((item) => item.to)).toEqual([...EXPECTED_ENHANCEMENTS]);
		expect(groups.instance.map((item) => item.to)).toEqual([...EXPECTED_INSTANCE]);
	});

	test("paths are globally unique across groups", () => {
		const paths = flatten(getSettingsNavGroups()).map((item) => item.to);
		expect(new Set(paths).size).toBe(paths.length);
	});

	test("personal pages include gateway and devices; plugins is instance-level", () => {
		const { personal, instance } = getSettingsNavGroups();
		const personalPaths = personal.map((item) => item.to);
		const instancePaths = instance.map((item) => item.to);
		expect(personalPaths).toContain("/settings/gateway");
		expect(personalPaths).toContain("/settings/devices");
		// Plugins is admin-only via ADMIN_PATHS; the mobile list used to put it in
		// personal for everyone, which still redirected non-admins away.
		expect(personalPaths).not.toContain("/settings/plugins");
		expect(instancePaths).toContain("/settings/plugins");
		expect(instancePaths).toContain("/settings/execution-log");
	});

	test("every nav entry has a label key and icon", async () => {
		const en = (await import("../locales/en/settings.json")).default as Record<string, unknown>;
		const zh = (await import("../locales/zh-CN/settings.json")).default as Record<string, unknown>;
		for (const item of flatten(getSettingsNavGroups())) {
			expect(item.to.startsWith("/settings")).toBe(true);
			expect(item.labelKey.length).toBeGreaterThan(0);
			expect(en[item.labelKey]).toBeTruthy();
			expect(zh[item.labelKey]).toBeTruthy();
			// Tabler icons are memo components (typeof "object") or plain functions.
			expect(item.Icon).toBeTruthy();
			expect(typeof item.Icon === "function" || typeof item.Icon === "object").toBe(true);
		}
	});

	test("nav paths map to real settings route files", () => {
		const routeFiles = new Set(
			readdirSync(new URL("../routes/settings", import.meta.url)).map((name) =>
				name.replace(/\.tsx?$/, ""),
			),
		);
		for (const item of flatten(getSettingsNavGroups())) {
			const slug = item.to.replace(/^\/settings\/?/, "");
			if (!slug) continue;
			// Nested plugin detail is not a nav entry; only top-level pages are.
			expect(routeFiles.has(slug) || routeFiles.has(`${slug}.index`)).toBe(true);
		}
	});
});

describe("settings admin boundary", () => {
	test("instance pages are admin-gated except about", () => {
		const { personal, enhancements, instance } = getSettingsNavGroups();
		const about = "/settings/about";
		for (const item of instance) {
			if (item.to === about) {
				expect(ADMIN_PATHS.has(item.to)).toBe(false);
				continue;
			}
			expect(ADMIN_PATHS.has(item.to)).toBe(true);
		}
		for (const item of [...personal, ...enhancements]) {
			expect(ADMIN_PATHS.has(item.to)).toBe(false);
		}
	});

	test("isAdminPath matches exact paths and plugin sub-paths", () => {
		expect(isAdminPath("/settings/users")).toBe(true);
		expect(isAdminPath("/settings/plugins")).toBe(true);
		expect(isAdminPath("/settings/plugins/some-id")).toBe(true);
		expect(isAdminPath("/settings/profile")).toBe(false);
		expect(isAdminPath("/settings/devices")).toBe(false);
		expect(isAdminPath("/settings/gateway")).toBe(false);
		expect(isAdminPath("/settings/about")).toBe(false);
	});

	test("visible items expand with admin and keep personal first", () => {
		const userItems = getVisibleSettingsNavItems(false);
		const adminItems = getVisibleSettingsNavItems(true);
		expect(userItems.map((item) => item.to)).toEqual([
			...EXPECTED_PERSONAL,
			...EXPECTED_ENHANCEMENTS,
		]);
		expect(adminItems.map((item) => item.to)).toEqual([
			...EXPECTED_PERSONAL,
			...EXPECTED_ENHANCEMENTS,
			...EXPECTED_INSTANCE,
		]);
		expect(userItems.every((item) => !ADMIN_PATHS.has(item.to))).toBe(true);
	});
});

describe("both settings surfaces share the inventory", () => {
	test("desktop sidebar and mobile picker import the shared module", async () => {
		const [desktop, mobile] = await Promise.all([
			Bun.file(new URL("../routes/settings.tsx", import.meta.url)).text(),
			Bun.file(new URL("../routes/settings/index.tsx", import.meta.url)).text(),
		]);
		for (const source of [desktop, mobile]) {
			expect(source).toMatch(
				/from ["'](?:@frontend\/lib\/settings-nav|\.\.\/lib\/settings-nav)["']/,
			);
			expect(source).toContain("getSettingsNavGroups()");
			// Reintroducing a local hand-maintained list is what caused the drift.
			expect(source).not.toContain("const personalItems");
			expect(source).not.toContain("const instanceItems");
		}
	});
});
