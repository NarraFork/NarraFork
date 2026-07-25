import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { userPluginThemes } from "../db/schema";
import { generateId } from "../lib/id";

/**
 * Per-user enablement of theme-only plugin contributions.
 *
 * The plugin *package* is installed globally (shared), but which themes a user
 * has enabled — and therefore which compiled CSS is delivered to them — is
 * isolated per user. This service is intentionally a thin, indexed CRUD layer
 * (small table, unique + user indexes) so it stays cheap on the request path.
 */

export interface UserEnabledTheme {
	pluginId: string;
	themeId: string;
}

/** Return the set of themes a user has explicitly enabled. */
export async function listEnabledThemes(userId: string): Promise<UserEnabledTheme[]> {
	const rows = await db
		.select({ pluginId: userPluginThemes.pluginId, themeId: userPluginThemes.themeId })
		.from(userPluginThemes)
		.where(and(eq(userPluginThemes.userId, userId), eq(userPluginThemes.enabled, true)));
	return rows;
}

/** Whether a specific theme is enabled for a user. */
export async function isThemeEnabled(
	userId: string,
	pluginId: string,
	themeId: string,
): Promise<boolean> {
	const row = await db
		.select({ enabled: userPluginThemes.enabled })
		.from(userPluginThemes)
		.where(
			and(
				eq(userPluginThemes.userId, userId),
				eq(userPluginThemes.pluginId, pluginId),
				eq(userPluginThemes.themeId, themeId),
			),
		)
		.limit(1);
	return row.length > 0 && row[0].enabled === true;
}

/**
 * Enable or disable a theme for a user (upsert on the unique
 * (userId, pluginId, themeId) key). Returns the resulting enabled state.
 */
export async function setThemeEnabled(
	userId: string,
	pluginId: string,
	themeId: string,
	enabled: boolean,
): Promise<boolean> {
	const now = new Date().toISOString();
	const existing = await db
		.select({ id: userPluginThemes.id })
		.from(userPluginThemes)
		.where(
			and(
				eq(userPluginThemes.userId, userId),
				eq(userPluginThemes.pluginId, pluginId),
				eq(userPluginThemes.themeId, themeId),
			),
		)
		.limit(1);

	if (existing.length > 0) {
		await db
			.update(userPluginThemes)
			.set({ enabled, updatedAt: now })
			.where(eq(userPluginThemes.id, existing[0].id));
	} else {
		await db.insert(userPluginThemes).values({
			id: generateId(),
			userId,
			pluginId,
			themeId,
			enabled,
			createdAt: now,
			updatedAt: now,
		});
	}
	return enabled;
}
