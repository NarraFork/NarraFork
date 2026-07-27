import { describe, expect, test } from "bun:test";
import { getNamespacesForPath } from "@frontend/lib/i18n";

/**
 * Regression coverage for "passkey login shows Something went wrong, fixed by reload".
 *
 * `AuthenticatedLayout` (the shell that wraps EVERY authenticated route) calls
 * `useTranslation("settings")` for the setup-wizard return button, and it mounts
 * `ProviderBaseUrlFixHost`, which also translates from `settings`. With
 * `react.useSuspense: true`, a namespace that is not yet loaded makes
 * `useTranslation` THROW a promise during render.
 *
 * On a normal navigation the root route's `beforeLoad` awaits
 * `ensureI18nNamespaces(getNamespacesForPath(pathname))` first, so the throw is a
 * benign suspend that resolves. But the shell lives ABOVE the route match, so its
 * suspend is caught by TanStack's global catch boundary rather than the root
 * route's `errorComponent` — surfacing the framework default "Something went
 * wrong!" instead of our own error UI.
 *
 * Therefore every path the shell can render on must include every namespace the
 * shell itself consumes. Otherwise the shell's own render depends on a race
 * between the language switch and the route transition.
 */

/** Namespaces consumed by AuthenticatedLayout and the hosts it always mounts. */
const APP_SHELL_NAMESPACES = ["common", "nav", "settings"] as const;

/** Authenticated destinations a user can land on, including post-login redirects. */
const AUTHENTICATED_PATHS: string[] = [
	"/",
	"/projects",
	"/projects/abc",
	"/narrators",
	"/narrators/archived",
	"/narrators/abc",
	"/narrators/workspace/abc",
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
	test.each(
		AUTHENTICATED_PATHS,
	)("%s preloads every namespace the app shell renders with", (path) => {
		const loaded = getNamespacesForPath(path);
		const missing = APP_SHELL_NAMESPACES.filter((ns) => !loaded.includes(ns));
		expect(missing).toEqual([]);
	});
});
