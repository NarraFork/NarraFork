/**
 * Installation ID — a stable, machine-level identifier persisted in
 * `~/.narrafork/settings.json` under `clientFingerprint.installationId`.
 *
 * Mirrors the behavior of the real Codex CLI, which persists a UUID v4 to
 * `~/.codex/installation_id` and sends it as the `x-codex-installation-id`
 * header. NarraFork keeps a single id per instance (one narrafork process/db =
 * one installation), so it is stored in settings rather than a dedicated file.
 *
 * The value is generated lazily on first access and reused thereafter. It can
 * be regenerated on demand (e.g. from the settings UI) to rotate the identity.
 */
import { randomUUID } from "node:crypto";
import { saveSettings, settings } from "./settings";

/** Basic UUID (any version) validation. */
function isUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
	);
}

/**
 * Return the persisted installation id, generating and saving a fresh UUID v4
 * the first time (or when the stored value is missing/invalid).
 */
export function getInstallationId(): string {
	const existing = settings.clientFingerprint?.installationId;
	if (isUuid(existing)) return existing;
	return regenerateInstallationId();
}

/**
 * Force-generate a new installation id, persist it, and return it. Used to
 * rotate the client identity from the settings UI.
 */
export function regenerateInstallationId(): string {
	const installationId = randomUUID();
	settings.clientFingerprint = {
		...(settings.clientFingerprint ?? {}),
		installationId,
	};
	saveSettings(settings);
	return installationId;
}
