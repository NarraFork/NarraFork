import { proxyOverrideSchema } from "@shared/proxy-settings";
import { z } from "zod";
import { BUILD_GITHUB_REPOSITORY } from "../../../shared/build-repository";
import { isValidGitHubRepository } from "../../../shared/github-repository";

export { isValidGitHubRepository } from "../../../shared/github-repository";

import { isTrustedUpdateServerUrl } from "../update-server-url";
import type { NarraForkSettings } from "./types";

export const DEFAULT_GITHUB_REPOSITORY = BUILD_GITHUB_REPOSITORY;
export const LEGACY_UPDATE_SERVER_URL = "https://narrafork-update.b.domexie.cn";
export const DEFAULT_UPDATE_SETTINGS = {
	source: "github",
	githubRepository: DEFAULT_GITHUB_REPOSITORY,
	serverUrl: LEGACY_UPDATE_SERVER_URL,
	product: "narrafork",
	channel: "stable",
	checkIntervalMinutes: 60,
	autoDownload: false,
} satisfies NonNullable<NarraForkSettings["update"]>;

/** Shared by the settings PATCH route and isolated validation tests. */
export const updateSourceSettingsSchema = z
	.object({
		proxy: proxyOverrideSchema,
		source: z.enum(["github", "update-server"]).optional(),
		githubRepository: z
			.string()
			.max(140)
			.refine(isValidGitHubRepository, {
				message: "GitHub repository must be an owner/repo slug (owner <= 39, repo <= 100)",
			})
			.optional(),
		// "" clears the override so the built-in default server is used again.
		// Update payloads are trusted on TLS alone (the SHA-512 ships alongside
		// the binary), so reject plaintext origins instead of silently disabling
		// updates after saving an unsafe URL. Loopback is allowed for local testing.
		serverUrl: z
			.union([
				z.string().url().refine(isTrustedUpdateServerUrl, {
					message: "Update server must use https (plaintext http is only allowed for loopback)",
				}),
				z.literal(""),
			])
			.optional(),
		product: z.string().min(1).optional(),
		channel: z.enum(["stable", "beta"]).optional(),
		checkIntervalMinutes: z.number().int().min(0).optional(),
		autoDownload: z.boolean().optional(),
	})
	.partial()
	.optional();

function isLegacyUpdateServer(value: unknown): boolean {
	if (value == null || value === "") return true;
	if (typeof value !== "string") return false;
	if (!value.trim()) return true;
	try {
		const url = new URL(value.trim());
		return (
			url.protocol === "https:" &&
			url.host === "narrafork-update.b.domexie.cn" &&
			!url.username &&
			!url.password &&
			!url.pathname.replace(/\/+$/, "") &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}

/**
 * Pure migration: consult pre-merge values so the new default source cannot mask
 * a previously configured private server. Neither argument is mutated, and both
 * sources' configuration is retained. needsSave records missing persisted fields
 * even if deepMerge has already supplied their defaults.
 */
export function normalizeUpdateSourceSettings(
	merged: Pick<NarraForkSettings, "update">,
	raw: Record<string, unknown>,
): { update: NonNullable<NarraForkSettings["update"]>; needsSave: boolean } {
	const rawUpdate =
		raw.update && typeof raw.update === "object" && !Array.isArray(raw.update)
			? (raw.update as Record<string, unknown>)
			: {};
	const source =
		rawUpdate.source === "github" || rawUpdate.source === "update-server"
			? rawUpdate.source
			: isLegacyUpdateServer(rawUpdate.serverUrl) &&
					(rawUpdate.product ?? "narrafork") === "narrafork"
				? "github"
				: "update-server";
	const githubRepository = isValidGitHubRepository(merged.update?.githubRepository)
		? merged.update.githubRepository
		: DEFAULT_GITHUB_REPOSITORY;
	return {
		update: { ...DEFAULT_UPDATE_SETTINGS, ...merged.update, source, githubRepository },
		needsSave: rawUpdate.source !== source || rawUpdate.githubRepository !== githubRepository,
	};
}
