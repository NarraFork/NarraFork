import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	APP_SHELL_NAMESPACES,
	getInitialNamespaces,
	getNamespacesForPath,
} from "@frontend/lib/i18n";

/** Authenticated paths retain the complete shell contract used by the root gate. */

/** Authenticated destinations a user can land on, including post-login redirects. */
const AUTHENTICATED_PATHS: string[] = [
	"/",
	"/projects",
	"/projects/abc",
	"/narrators",
	"/narrators/archived",
	"/narrators/abc",
	"/narrators/workspace/abc",
	`/git/narrators/abc/commits/${"a".repeat(40)}`,
	"/settings",
	"/settings/agent",
	"/settings/users",
	"/search",
	"/routines",
	"/scheduled-tasks",
	"/knowledge",
	"/learn",
	"/changelog",
	"/some/unknown/route",
];

describe("app shell i18n namespaces", () => {
	test("bootstrap waits only for global common and errors copy", () => {
		for (const path of ["/", "/narrators/abc", "/shared/narrators/id", "/windows/panel"]) {
			expect(getInitialNamespaces(path)).toEqual(["common", "errors"]);
		}
	});
	test("navigation preloads on intent without blocking beforeLoad", () => {
		const app = readFileSync(new URL("../../frontend/App.tsx", import.meta.url), "utf8");
		const root = readFileSync(new URL("../../frontend/routes/__root.tsx", import.meta.url), "utf8");
		expect(app).toContain('defaultPreload: "intent"');
		expect(app).toContain("defaultPendingMs: 400");
		expect(app).toContain("defaultPendingMinMs: 300");
		expect(root).not.toContain("await ensureI18nNamespaces");
		expect(root).toContain("void ensureI18nNamespaces");
		expect(root).toContain(".catch(() => {})");
	});
	test("narrator git windows preload only their own translations", () => {
		expect(getNamespacesForPath(`/windows/git/narrators/abc/commits/${"a".repeat(40)}`)).toEqual([
			"common",
			"errors",
			"git",
		]);
	});
	test("unknown window targets do not load navigation bundles", () => {
		expect(getNamespacesForPath("/windows/unknown")).toEqual(["common", "errors"]);
	});
	test("panel windows preload the namespaces panel components translate with", () => {
		const loaded = getNamespacesForPath("/windows/panel");
		for (const ns of ["common", "errors", "narrator", "terminal", "git", "knowledge"] as const) {
			expect(loaded).toContain(ns);
		}
	});
	test("workspace windows preload the workspace page's namespaces", () => {
		expect(getNamespacesForPath("/windows/workspaces/abc")).toContain("narrators");
	});
	test("narrator commit deep links preload git translations", () => {
		const loaded = getNamespacesForPath(`/git/narrators/abc/commits/${"a".repeat(40)}`);
		expect(loaded).toContain("git");
	});
	test.each(
		AUTHENTICATED_PATHS,
	)("%s preloads every namespace the app shell renders with", (path) => {
		const loaded = getNamespacesForPath(path);
		const missing = APP_SHELL_NAMESPACES.filter((ns) => !loaded.includes(ns));
		expect(missing).toEqual([]);
	});
});

describe("authenticated route namespace gate", () => {
	test("route resources wait below the persistent shell", () => {
		const source = readFileSync(
			new URL("../../frontend/components/AuthenticatedAppLayout.tsx", import.meta.url),
			"utf8",
		);
		const main = source.slice(source.indexOf("<AppShell.Main"), source.indexOf("</AppShell.Main>"));
		expect(main).toContain("<GitMissingAlert />");
		expect(main).toContain("<StartupRecoveryAlert />");
		expect(main).toContain("<I18nNamespaceGate namespaces={getNamespacesForPath(pathname)}>");
		expect(main).toContain("<Outlet />");
		expect(main.indexOf("<GitMissingAlert />")).toBeLessThan(main.indexOf("<Suspense"));
	});
});
