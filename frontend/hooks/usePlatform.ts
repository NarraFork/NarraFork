import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

type Platform = "windows" | "macos" | "linux";

/**
 * Returns the server platform ("windows" | "macos" | "linux").
 * Cached for the lifetime of the app — the platform never changes.
 */
export function usePlatform(): Platform {
	const { data } = useQuery({
		queryKey: ["health"],
		queryFn: () => api.health(),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});
	return data?.platform ?? "linux";
}
