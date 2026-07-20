import { and, count, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { db } from "../db";
import {
	integrationResourceBindings,
	oauthClients,
	oauthGrants,
	remoteDevices,
} from "../db/schema";
import {
	adaptOAuthScope,
	adaptPluginCapability,
	OAUTH_SCOPE_CAPABILITY_ADAPTER,
	PLUGIN_CAPABILITY_ADAPTER,
} from "../lib/integrations/capability-adapters";
import { logger } from "../lib/logger";
import { pluginManager } from "./plugin-manager";

export type IntegrationAttentionSeverity = "info" | "warning" | "critical";
export type IntegrationAttentionTarget =
	| "/settings/connected-apps"
	| "/settings/devices"
	| "/settings/oauth-apps"
	| "/settings/plugins";

export interface IntegrationAttentionItem {
	id: string;
	severity: IntegrationAttentionSeverity;
	count: number;
	target: IntegrationAttentionTarget;
}

export interface IntegrationSummary {
	generatedAt: string;
	viewer: { role: "admin" | "user" };
	connectedApps: { active: number; revoked: number };
	capabilityCatalog: {
		oauth: number;
		plugin: number;
		shared: number;
	};
	attention: IntegrationAttentionItem[];
	admin: {
		plugins: {
			featureEnabled: boolean;
			total: number;
			enabled: number;
			active: number;
			degraded: number;
			attention: number;
		};
		oauthClients: { total: number; active: number; revoked: number };
		devices: {
			total: number;
			online: number;
			offline: number;
			oauthOwned: number;
			orphaned: number;
		};
		externalResources: {
			active: number;
			orphaned: number;
			revoked: number;
			devices: number;
			narrators: number;
		};
	} | null;
}

function countValue(row: { value: number } | undefined): number {
	return row?.value ?? 0;
}

async function countConnectedApps(userId: string) {
	const [activeRows, revokedRows] = await Promise.all([
		db
			.select({ value: count() })
			.from(oauthGrants)
			.where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt))),
		db
			.select({ value: count() })
			.from(oauthGrants)
			.where(and(eq(oauthGrants.userId, userId), isNotNull(oauthGrants.revokedAt))),
	]);
	return {
		active: countValue(activeRows[0]),
		revoked: countValue(revokedRows[0]),
	};
}

async function getPluginSummary() {
	try {
		const plugins = await pluginManager.list();
		const attentionStates = new Set(["degraded", "failed", "quarantine", "crashed", "backoff"]);
		return {
			featureEnabled: pluginManager.isEnabled(),
			total: plugins.length,
			enabled: plugins.filter((plugin) => plugin.desiredState === "enabled").length,
			active: plugins.filter((plugin) => ["active", "degraded"].includes(plugin.runtimeState))
				.length,
			degraded: plugins.filter((plugin) => plugin.runtimeState === "degraded").length,
			attention: plugins.filter(
				(plugin) =>
					plugin.compatibility === "incompatible" || attentionStates.has(plugin.runtimeState),
			).length,
		};
	} catch (error) {
		logger.warn("Unable to load plugin integration summary", {
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			featureEnabled: pluginManager.isEnabled(),
			total: 0,
			enabled: 0,
			active: 0,
			degraded: 0,
			attention: 0,
		};
	}
}

async function getAdminSummary() {
	const [
		plugins,
		oauthClientTotalRows,
		oauthClientActiveRows,
		oauthClientRevokedRows,
		deviceTotalRows,
		deviceOnlineRows,
		deviceOfflineRows,
		oauthOwnedDeviceRows,
		orphanedDeviceRows,
		activeResourceRows,
		orphanedResourceRows,
		revokedResourceRows,
		externalDeviceRows,
		externalNarratorRows,
	] = await Promise.all([
		getPluginSummary(),
		db.select({ value: count() }).from(oauthClients),
		db.select({ value: count() }).from(oauthClients).where(isNull(oauthClients.revokedAt)),
		db.select({ value: count() }).from(oauthClients).where(isNotNull(oauthClients.revokedAt)),
		db.select({ value: count() }).from(remoteDevices).where(isNull(remoteDevices.revokedAt)),
		db
			.select({ value: count() })
			.from(remoteDevices)
			.where(and(isNull(remoteDevices.revokedAt), eq(remoteDevices.status, "online"))),
		db
			.select({ value: count() })
			.from(remoteDevices)
			.where(and(isNull(remoteDevices.revokedAt), eq(remoteDevices.status, "offline"))),
		db
			.select({ value: count() })
			.from(integrationResourceBindings)
			.where(
				and(
					eq(integrationResourceBindings.resourceType, "device"),
					eq(integrationResourceBindings.sourceType, "oauth_client"),
					ne(integrationResourceBindings.state, "deleted"),
				),
			),
		db
			.select({ value: count() })
			.from(integrationResourceBindings)
			.where(
				and(
					eq(integrationResourceBindings.resourceType, "device"),
					eq(integrationResourceBindings.sourceType, "oauth_client"),
					eq(integrationResourceBindings.state, "orphaned"),
				),
			),
		db
			.select({ value: count() })
			.from(integrationResourceBindings)
			.where(
				and(
					eq(integrationResourceBindings.sourceType, "oauth_client"),
					eq(integrationResourceBindings.state, "active"),
				),
			),
		db
			.select({ value: count() })
			.from(integrationResourceBindings)
			.where(
				and(
					eq(integrationResourceBindings.sourceType, "oauth_client"),
					eq(integrationResourceBindings.state, "orphaned"),
				),
			),
		db
			.select({ value: count() })
			.from(integrationResourceBindings)
			.where(
				and(
					eq(integrationResourceBindings.sourceType, "oauth_client"),
					eq(integrationResourceBindings.state, "revoked"),
				),
			),
		db
			.select({ value: count() })
			.from(integrationResourceBindings)
			.where(
				and(
					eq(integrationResourceBindings.sourceType, "oauth_client"),
					eq(integrationResourceBindings.resourceType, "device"),
					ne(integrationResourceBindings.state, "deleted"),
				),
			),
		db
			.select({ value: count() })
			.from(integrationResourceBindings)
			.where(
				and(
					eq(integrationResourceBindings.sourceType, "oauth_client"),
					eq(integrationResourceBindings.resourceType, "narrator"),
					ne(integrationResourceBindings.state, "deleted"),
				),
			),
	]);

	return {
		plugins,
		oauthClients: {
			total: countValue(oauthClientTotalRows[0]),
			active: countValue(oauthClientActiveRows[0]),
			revoked: countValue(oauthClientRevokedRows[0]),
		},
		devices: {
			total: countValue(deviceTotalRows[0]),
			online: countValue(deviceOnlineRows[0]),
			offline: countValue(deviceOfflineRows[0]),
			oauthOwned: countValue(oauthOwnedDeviceRows[0]),
			orphaned: countValue(orphanedDeviceRows[0]),
		},
		externalResources: {
			active: countValue(activeResourceRows[0]),
			orphaned: countValue(orphanedResourceRows[0]),
			revoked: countValue(revokedResourceRows[0]),
			devices: countValue(externalDeviceRows[0]),
			narrators: countValue(externalNarratorRows[0]),
		},
	};
}

function getCapabilityCatalogSummary(): IntegrationSummary["capabilityCatalog"] {
	const oauth = new Set(
		Object.keys(OAUTH_SCOPE_CAPABILITY_ADAPTER)
			.map(adaptOAuthScope)
			.filter((item) => item?.visibility === "integration")
			.map((item) => item?.id)
			.filter((id): id is NonNullable<typeof id> => Boolean(id)),
	);
	const plugin = new Set(
		Object.keys(PLUGIN_CAPABILITY_ADAPTER)
			.map(adaptPluginCapability)
			.filter((item) => item?.visibility === "integration")
			.map((item) => item?.id)
			.filter((id): id is NonNullable<typeof id> => Boolean(id)),
	);
	return {
		oauth: oauth.size,
		plugin: plugin.size,
		shared: [...oauth].filter((id) => plugin.has(id)).length,
	};
}

export async function getIntegrationSummary(input: {
	userId: string;
	role: "admin" | "user";
	attentionLimit: number;
}): Promise<IntegrationSummary> {
	const connectedApps = await countConnectedApps(input.userId);
	const admin = input.role === "admin" ? await getAdminSummary() : null;
	const attention: IntegrationAttentionItem[] = [];
	if (admin?.externalResources.orphaned) {
		attention.push({
			id: "orphaned_resources",
			severity: "critical",
			count: admin.externalResources.orphaned,
			target: "/settings/connected-apps",
		});
	}
	if (admin?.plugins.attention) {
		attention.push({
			id: "plugin_attention",
			severity: "warning",
			count: admin.plugins.attention,
			target: "/settings/plugins",
		});
	}
	if (admin?.devices.offline) {
		attention.push({
			id: "offline_devices",
			severity: "info",
			count: admin.devices.offline,
			target: "/settings/devices",
		});
	}

	return {
		generatedAt: new Date().toISOString(),
		viewer: { role: input.role },
		connectedApps,
		capabilityCatalog: getCapabilityCatalogSummary(),
		attention: attention.slice(0, input.attentionLimit),
		admin,
	};
}
