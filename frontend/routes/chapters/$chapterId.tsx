import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Chapters are gone. Old links (notifications, bookmarks, shared URLs) still point
 * here; chapter data no longer exists to resolve a session from, so they land on
 * the project list.
 */
export const Route = createFileRoute("/chapters/$chapterId")({
	beforeLoad: () => {
		throw redirect({ to: "/projects", replace: true });
	},
});
