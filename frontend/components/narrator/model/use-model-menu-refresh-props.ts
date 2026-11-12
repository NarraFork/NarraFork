import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../../hooks/useAuth";
import { modelCatalogKeys } from "../../../hooks/useModelCatalog";
import {
	useProviderModelRefreshCapability,
	useProviderRuntimeCapability,
} from "../../../hooks/usePlatform";
import { api } from "../../../lib/api";
import { requestNugModelRefreshOnPickerOpen } from "../../../lib/nug-model-refresh";

/** Per-provider-group header actions in {@link ModelMenuItems}. */
export interface ProviderHeaderActions {
	/** Re-fetch this provider's model catalog. */
	onRefresh?: () => void;
	refreshing?: boolean;
}

type RefreshKind = "openai" | "anthropic" | "gemini" | "nug" | "commandcode" | "tokendance";

interface ProviderRef {
	id?: string;
	prefix?: string;
	disabled?: boolean;
}

/**
 * Which refresh endpoint serves a provider prefix. Pure for tests; prefixes are
 * resolved from the settings projections the model list itself is built from.
 */
export function buildProviderRefreshTargets(
	settingsData:
		| {
				openaiProviders?: unknown;
				anthropicProviders?: unknown;
				geminiProviders?: unknown;
				nugProviders?: unknown;
		  }
		| undefined,
	options: { nug: boolean; admin: boolean },
): Record<string, { kind: RefreshKind; id?: string }> {
	const out: Record<string, { kind: RefreshKind; id?: string }> = {};
	const add = (list: unknown, kind: RefreshKind) => {
		if (!Array.isArray(list)) return;
		for (const p of list as ProviderRef[]) {
			if (!p?.id || !p.prefix || p.disabled) continue;
			out[p.prefix] = { kind, id: p.id };
		}
	};
	add(settingsData?.openaiProviders, "openai");
	add(settingsData?.anthropicProviders, "anthropic");
	add(settingsData?.geminiProviders, "gemini");
	if (options.nug) add(settingsData?.nugProviders, "nug");
	// Platform catalogs are refreshed through admin-only endpoints.
	if (options.admin) {
		out.CommandCode = { kind: "commandcode" };
		out.tokendance = { kind: "tokendance" };
	}
	return out;
}

/** Model-group prefix → configured provider id (custom API and NUG providers). */
export function buildProviderIdByPrefix(
	settingsData: { customApiProviders?: unknown; nugProviders?: unknown } | undefined,
	nugProviderIdByPrefix: Record<string, string> = {},
): Record<string, string> {
	const out: Record<string, string> = { ...nugProviderIdByPrefix };
	for (const list of [settingsData?.customApiProviders, settingsData?.nugProviders]) {
		if (!Array.isArray(list)) continue;
		for (const p of list as ProviderRef[]) {
			if (p?.id && p.prefix) out[p.prefix] = p.id;
		}
	}
	return out;
}

async function refreshProviderCatalog(target: { kind: RefreshKind; id?: string }) {
	const id = target.id ?? "";
	switch (target.kind) {
		case "openai":
			return api.openaiRefreshProviderModels(id);
		case "anthropic":
			return api.anthropicRefreshProviderModels(id);
		case "gemini":
			return api.geminiRefreshProviderModels(id);
		case "nug":
			return api.nugRefreshProviderModels(id);
		case "commandcode":
			return api.commandCodeRefreshModels();
		case "tokendance":
			return api.tokenDanceRefreshModels();
	}
}

/**
 * Provider-group header actions for {@link ModelMenuItems}, shared by every model
 * picker so they behave the same way: a catalog refresh button for every provider
 * whose catalog can be re-fetched, and (for admins) a shortcut to the provider's
 * settings page.
 */
export function useModelMenuRefreshProps(nugProviderIdByPrefix: Record<string, string>) {
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const navigate = useNavigate();
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	// Same cache entry as useAllModels, so this never adds a request of its own.
	const { data: settingsData } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		staleTime: 30_000,
	});
	const nugModelRefreshCapability = useProviderModelRefreshCapability("nug");
	const nugRuntimeCapability = useProviderRuntimeCapability("nug");
	const canRefreshNugModels =
		nugModelRefreshCapability.supported &&
		nugRuntimeCapability?.routes?.supported !== false &&
		nugRuntimeCapability?.routes?.perProviderModelsRefresh !== false;
	const [refreshingPrefix, setRefreshingPrefix] = useState<string | null>(null);

	const refreshTargets = useMemo(
		() => buildProviderRefreshTargets(settingsData, { nug: canRefreshNugModels, admin: isAdmin }),
		[settingsData, canRefreshNugModels, isAdmin],
	);

	const handleRefresh = useCallback(
		async (prefix: string, target: { kind: RefreshKind; id?: string }) => {
			setRefreshingPrefix(prefix);
			try {
				await refreshProviderCatalog(target);
				await Promise.all([
					qc.invalidateQueries({ queryKey: ["settings"] }),
					qc.invalidateQueries({ queryKey: ["admin", "settings"] }),
					qc.invalidateQueries({ queryKey: modelCatalogKeys.all }),
				]);
			} catch (error) {
				notifications.show({
					color: "red",
					title: t("refreshProviderModelsErrorTitle"),
					message: error instanceof Error ? error.message : String(error),
				});
			} finally {
				setRefreshingPrefix(null);
			}
		},
		[qc, t],
	);

	const providerActions = useMemo(() => {
		const actions: Record<string, ProviderHeaderActions> = {};
		const add = (prefix: string, target: { kind: RefreshKind; id?: string }) => {
			actions[prefix] = {
				onRefresh: () => {
					void handleRefresh(prefix, target);
				},
				refreshing: refreshingPrefix === prefix,
			};
		};
		if (canRefreshNugModels) {
			for (const [prefix, id] of Object.entries(nugProviderIdByPrefix)) {
				add(prefix, { kind: "nug", id });
			}
		}
		for (const [prefix, target] of Object.entries(refreshTargets)) add(prefix, target);
		return actions;
	}, [refreshTargets, nugProviderIdByPrefix, canRefreshNugModels, handleRefresh, refreshingPrefix]);

	// Link by provider id whenever the prefix belongs to a configured provider: the
	// settings page keys multi-instance providers by id, and a prefix is only a fallback.
	const providerIdByPrefix = useMemo(
		() => buildProviderIdByPrefix(settingsData, nugProviderIdByPrefix),
		[settingsData, nugProviderIdByPrefix],
	);
	const onOpenProviderSettings = useCallback(
		(prefix: string) => {
			void navigate({
				to: "/settings/providers",
				search: { provider: providerIdByPrefix[prefix] ?? prefix },
			});
		},
		[navigate, providerIdByPrefix],
	);

	// Opening the picker also kicks off an opportunistic NUG catalog refresh, so a
	// model that recovered upstream stops showing as "temporarily unavailable"
	// without the user having to find the per-provider refresh button. The real
	// rate limit is a process-wide cooldown on the server; `requestNugModelRefresh…`
	// only avoids redundant round-trips from this tab.
	const handleModelPickerOpened = useCallback(() => {
		void requestNugModelRefreshOnPickerOpen().then((refreshed) => {
			if (refreshed) qc.invalidateQueries({ queryKey: ["settings"] });
		});
	}, [qc]);
	const hasNugModelGroups = Object.keys(nugProviderIdByPrefix).length > 0;
	return {
		providerActions: REMOTE_BUILD ? {} : providerActions,
		// Settings → Providers is an admin page.
		...(!REMOTE_BUILD && isAdmin ? { onOpenProviderSettings } : {}),
		// No NUG gateway in the picker → nothing to refresh, so don't even ask.
		...(!REMOTE_BUILD && canRefreshNugModels && hasNugModelGroups
			? { onPickerOpened: handleModelPickerOpened }
			: {}),
	};
}
