import { useQuery } from "@tanstack/react-query";
import { api, type LicenseManifestResponse } from "../lib/api";

export type { LicenseManifestResponse };

/**
 * The third-party component list.
 *
 * `staleTime: Infinity` because the manifest describes the running build: it
 * cannot change without a new binary, and a refetch would re-transfer ~260 KB for
 * a guaranteed-identical result.
 */
export function useLicenses() {
	return useQuery({
		queryKey: ["licenses"],
		queryFn: () => api.getLicenses(),
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/**
 * One license text, fetched only once its row is expanded.
 *
 * The full text set is ~1.1 MB across ~560 unique documents. Loading it with the
 * list would make opening the page pay for text nobody reads; loading per id keeps
 * it to the few kilobytes actually being looked at. Texts are content-addressed,
 * so the cache key is exact and a text shared by 85 packages is fetched once.
 */
export function useLicenseText(id: string | undefined, enabled: boolean) {
	return useQuery({
		queryKey: ["license-text", id],
		queryFn: () => api.getLicenseText(id as string),
		enabled: enabled && Boolean(id),
		staleTime: Number.POSITIVE_INFINITY,
	});
}
