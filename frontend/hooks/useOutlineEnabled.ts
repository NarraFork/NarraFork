import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * Whether `outline.enabled` is on; `loading` until the settings have been read once.
 *
 * Read from the settings every signed-in user already reads (the same `["settings"]` query the
 * app shell uses), so nothing admin-only is fetched for it. While it is off the outline routes
 * answer 404, and the pages and entry points hide themselves.
 */
export function useOutlineEnabled(): { enabled: boolean; loading: boolean } {
	const { data, isLoading } = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
	const outline = (data as { outline?: { enabled?: unknown } } | undefined)?.outline;
	return { enabled: outline?.enabled === true, loading: isLoading };
}
