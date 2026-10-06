import { Alert, Button, Center, Group, Loader, Stack, Text } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

/**
 * A route whose code-split chunk could not be fetched.
 *
 * `lazyRouteComponent` caches the rejection: `error` is stored in module scope and
 * rethrown on every later render, and the router keeps `_lazyPromise` /
 * `_componentsPromise` for the route. Nothing retries on its own, so once a chunk
 * request fails the route stays broken for the lifetime of the document.
 *
 * That matters because the single-threaded backend serves these chunks too. While
 * it is busy with a long synchronous job (a storage scan on a large database being
 * the known case) a chunk request can fail outright — and without a boundary at
 * the layout level, the failure propagates to the root `errorComponent`, which
 * replaces the ENTIRE app shell. The navigation sidebar disappears with it, so
 * there is no way back except a full page load.
 *
 * Keeping the failure scoped to the content area preserves the surrounding
 * navigation, and `router.invalidate()` + a remount key is enough to re-run the
 * import once the backend is responsive again.
 */
export function RouteChunkErrorBoundary({ error, reset }: ErrorComponentProps) {
	const router = useRouter();
	const { t } = useTranslation("common");
	const message = error?.message ?? "";
	// A failed dynamic import is reported by the browser as a fetch failure for the
	// module. Anything else is a genuine render error and must not claim the page
	// merely needs reloading.
	const isChunkLoadFailure =
		/dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch/i.test(
			message,
		);

	return (
		<Stack gap="md" p="md">
			<Alert
				color={isChunkLoadFailure ? "yellow" : "red"}
				variant="light"
				title={isChunkLoadFailure ? t("routeChunkFailedTitle") : t("somethingWentWrong")}
			>
				<Stack gap="sm" align="flex-start">
					<Text size="sm">
						{isChunkLoadFailure ? t("routeChunkFailedDesc") : message || t("unexpectedError")}
					</Text>
					<Group gap="xs">
						<Button
							size="xs"
							variant="light"
							leftSection={<IconRefresh size={14} />}
							onClick={() => {
								reset();
								void router.invalidate();
							}}
						>
							{t("retry")}
						</Button>
						{/*
						 * A cached rejection inside `lazyRouteComponent`'s module scope survives
						 * `reset()`, so retrying in place can keep failing even after the backend
						 * recovers. A document reload is the reliable escape hatch, offered
						 * explicitly instead of being triggered behind the user's back.
						 */}
						<Button size="xs" variant="subtle" onClick={() => window.location.reload()}>
							{t("reloadPage")}
						</Button>
					</Group>
				</Stack>
			</Alert>
		</Stack>
	);
}

/**
 * Shown while a route is still resolving (its chunk, loader, or both).
 *
 * Deliberately minimal and unobtrusive: it renders in place of the route's own
 * content while every ancestor stays mounted, so navigation remains usable. Its
 * purpose is only to make a slow navigation legible — a click that waits on a
 * blocked backend previously looked like a button that did nothing at all.
 */
export function RoutePendingIndicator() {
	return (
		<Center p="xl" mih={120}>
			<Loader size="sm" />
		</Center>
	);
}
