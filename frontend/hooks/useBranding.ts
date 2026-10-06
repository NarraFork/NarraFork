import { type ResolvedBranding, resolveBranding } from "@shared/branding";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { applyBranding, getCurrentBranding, onBrandingChange } from "../lib/branding";

/**
 * Instance branding, fetched from the public `/api/branding` endpoint.
 *
 * Unauthenticated on purpose: the login page heading and the browser tab title are
 * where a user tells two instances apart, and both exist before a session does.
 *
 * Returns the last known values (localStorage mirror) while loading and the
 * NarraFork defaults on failure, so no caller ever has to handle a loading state
 * for something as small as a name.
 */
export function useBranding(): ResolvedBranding {
	const { data } = useQuery({
		queryKey: ["branding"],
		queryFn: api.getBranding,
		// Branding changes only when an admin edits settings, and the settings save
		// invalidates this key directly — so background refetching would be pure
		// overhead on a value fetched by every page load.
		staleTime: 60 * 60 * 1000,
		gcTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		retry: 1,
	});

	useEffect(() => {
		if (data) applyBranding(data);
	}, [data]);

	// Subscribe to the module-level store rather than returning `data` directly: the
	// settings page applies a colour optimistically through `applyBranding`, and the
	// header must follow that without waiting for a refetch.
	return useSyncExternalStore(onBrandingChange, getCurrentBranding, () =>
		resolveBranding(undefined),
	);
}
