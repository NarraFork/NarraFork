/**
 * Machine-level client identifiers persisted in `~/.narrafork/settings.json`
 * under `clientFingerprint`.
 *
 * `installationId` mirrors the real Codex CLI, which persists a UUID v4 to
 * `~/.codex/installation_id` and sends it as the `x-codex-installation-id`
 * header. `claudeDeviceId` mirrors the Claude Code CLI's `device_id`. NarraFork
 * keeps a single id per instance (one narrafork process/db = one installation),
 * so both are stored in settings rather than dedicated files.
 *
 * Values are generated lazily on first access and reused thereafter.
 * `installationId` can be regenerated on demand (e.g. from the settings UI) to
 * rotate the identity.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { saveSettings, settings } from "./settings";

/** Basic UUID (any version) validation. */
function isUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
	);
}

/**
 * Shape the Claude Code CLI requires of its own `device_id`: 64 lowercase hex
 * characters. Upstream re-generates the value whenever the stored one fails
 * this test, so a differently-shaped id is not a value it would ever send.
 */
const CLAUDE_DEVICE_ID_PATTERN = /^[0-9a-f]{64}$/;

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

/**
 * Return the persisted Claude Code `device_id`, generating and saving a fresh
 * one when missing or malformed.
 *
 * Transcribed from `claude-cli` 2.1.251's own accessor, which reads `userID`
 * from its config, validates it against `/^[0-9a-f]{64}$/`, and otherwise
 * writes back `randomBytes(32).toString("hex")`. Two properties of that
 * behaviour matter here and were previously missing:
 *
 *   - **Shape.** A 21-character nanoid is not a value any real CLI install
 *     reports. It also cannot satisfy the legacy
 *     `user_{64hex}_account_..._session_...` form that Anthropic-facing relays
 *     still parse, so the id was only ever usable in the JSON form.
 *   - **Lifetime.** Upstream persists it, so one install reports one device for
 *     its whole life. Minting it per process made every restart look like a new
 *     machine to anything keyed on device identity.
 */
export function getClaudeDeviceId(): string {
	const existing = settings.clientFingerprint?.claudeDeviceId;
	if (typeof existing === "string" && CLAUDE_DEVICE_ID_PATTERN.test(existing)) return existing;

	const claudeDeviceId = randomBytes(32).toString("hex");
	settings.clientFingerprint = {
		...(settings.clientFingerprint ?? {}),
		claudeDeviceId,
	};
	saveSettings(settings);
	return claudeDeviceId;
}
