import { BASE, getToken } from "../../lib/api/client";
import type { PluginDockPanelParams } from "./protocol";
import type { PluginUiContribution } from "./types";

const contributions = new Map<string, PluginUiContribution>();

function key(pluginId: string, contributionId: string): string {
	return `${pluginId}:${contributionId}`;
}

/** Host-owned registry populated by the plugin catalog sync; never by iframe code. */
export function registerPluginUiContribution(contribution: PluginUiContribution): () => void {
	const contributionKey = key(contribution.pluginId, contribution.contributionId);
	contributions.set(contributionKey, contribution);
	return () => {
		if (contributions.get(contributionKey) === contribution) contributions.delete(contributionKey);
	};
}

export function resolvePluginUiContribution(
	params: PluginDockPanelParams,
): PluginUiContribution | undefined {
	return contributions.get(key(params.pluginId, params.contributionId));
}

export function clearPluginUiContributions(): void {
	contributions.clear();
}

/** Pull the bounded host-owned contribution snapshot; no iframe can mutate this registry. */
export async function syncPluginUiContributions(): Promise<number> {
	const token = getToken();
	if (!token) return 0;
	const response = await fetch(`${BASE}/plugins/ui/contributions`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) return 0;
	const payload = (await response.json()) as unknown;
	if (!Array.isArray(payload)) return 0;
	clearPluginUiContributions();
	let count = 0;
	for (const item of payload.slice(0, 200)) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const value = item as Record<string, unknown>;
		if (
			typeof value.pluginId !== "string" ||
			typeof value.contributionId !== "string" ||
			typeof value.version !== "string" ||
			typeof value.hash !== "string"
		)
			continue;
		registerPluginUiContribution({
			pluginId: value.pluginId,
			contributionId: value.contributionId,
			version: value.version,
			title: typeof value.title === "string" ? value.title : value.contributionId,
			contentHash: value.hash,
			packageHash: value.hash,
			entryPath: typeof value.entryPath === "string" ? value.entryPath : undefined,
			stylePath: typeof value.stylePath === "string" ? value.stylePath : undefined,
			// Session-bound asset URLs are materialized by the runtime after the panel
			// obtains a principal-bound backend session. Keep available contributions
			// resolvable while the URL is intentionally empty and fail closed in runtime.
			entryUrl: "",
			status: value.status === "available" ? "available" : "disabled",
			...(value.status === "available"
				? {}
				: { unavailableReason: "Plugin UI package is not enabled" }),
		});
		count += 1;
	}
	return count;
}
