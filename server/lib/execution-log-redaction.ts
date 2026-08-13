import { redactSecretPatterns } from "./net/diagnostic-redaction";

/**
 * Credential redaction for execution-log payloads.
 *
 * `narrator_tool_calls.input_json` / `output_json` are whatever the tool was
 * handed and whatever it printed: a `Bash` command that exported a token, a
 * `Write` that persisted a config file, an HTTP response body echoed to stdout.
 * The execution-log detail endpoint is a GLOBAL view across every narrator, so
 * without this an administrator reads plaintext credentials belonging to users
 * who never agreed to that visibility.
 *
 * Deliberately reuses `redactSecretPatterns` (the network-diagnostics masker)
 * for the string-level work rather than growing a second pattern list that
 * would drift from it. What this module adds on top is the two things that
 * matter for stored tool payloads and not for a log line:
 *
 *  1. **Structural traversal.** Payloads are JSON objects, so a key named
 *     `password` must be masked even when its value carries no recognizable
 *     shape (`{"password":"hunter2"}` has nothing for a regex to anchor on).
 *  2. **Depth/size discipline.** Masking runs on every detail read, so it is
 *     bounded and must never recurse without a floor.
 *
 * Best-effort by construction: a secret with no recognizable key name and no
 * recognizable shape still gets through. It reduces the exposure surface; it is
 * not a guarantee, and it is not a substitute for keeping credentials out of
 * command lines in the first place.
 */

const REDACTED = "[REDACTED]";

/**
 * Key-name fragments whose VALUE is replaced wholesale, regardless of shape.
 *
 * Matched against the tokenized key (camelCase and kebab/snake both split), so
 * `apiKey`, `API_KEY` and `api-key` all land here. Kept narrow on purpose:
 * `id`/`name`/`user` are excluded because masking them would gut the log's
 * usefulness while protecting nothing.
 */
const SENSITIVE_KEY_PARTS = new Set([
	"password",
	"passwd",
	"pwd",
	"secret",
	"token",
	"credential",
	"credentials",
	"authorization",
	"cookie",
	"passphrase",
	"privatekey",
]);

/** Depth ceiling for structural traversal; deeper values are summarized. */
const MAX_REDACT_DEPTH = 12;

/** PEM private-key bodies, which `redactSecretPatterns` does not cover. */
const PEM_BLOCK_RE =
	/-----BEGIN (?:[A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]*)PRIVATE KEY-----/g;

/**
 * `export`/`set` of a credential-looking shell variable.
 *
 * `redactSecretPatterns` handles `key=value` where the key literally contains
 * `token`/`secret`/etc., but not the shell-specific `export FOO_TOKEN=...`
 * spelling with a quoted value, which is the single most common way a secret
 * enters a Bash command line.
 */
const SHELL_EXPORT_RE =
	/\b((?:export|set|SET)\s+[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|PASSPHRASE)[A-Za-z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;|&]+)/g;

/** `--password foo` / `-p foo` style flags, whose value is a separate argv token. */
const CREDENTIAL_FLAG_RE =
	/(--(?:password|passwd|token|secret|api-key|apikey|access-token|refresh-token|private-key|passphrase)[= ])(?:"[^"]*"|'[^']*'|[^\s;|&]+)/gi;

function splitKeyParts(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.toLowerCase()
		.split("_")
		.filter(Boolean);
}

/**
 * Whether a key name means "the value is a credential".
 *
 * Joins the tokens as well as testing them individually so `apiKey` → `apikey`
 * and `privateKey` → `privatekey` match without needing every casing spelled
 * out in the set.
 */
export function isSensitiveExecutionLogKey(key: string): boolean {
	const parts = splitKeyParts(key);
	if (parts.some((part) => SENSITIVE_KEY_PARTS.has(part))) return true;
	const joined = parts.join("");
	if (SENSITIVE_KEY_PARTS.has(joined)) return true;
	// `api key` / `access token` written as separate tokens.
	return parts.some(
		(part, index) =>
			(part === "api" && parts[index + 1] === "key") ||
			(part === "access" && parts[index + 1] === "token") ||
			(part === "refresh" && parts[index + 1] === "token") ||
			(part === "private" && parts[index + 1] === "key"),
	);
}

/** Mask credential shapes inside a free-text value (command line, stdout, file body). */
export function redactExecutionLogText(value: string): string {
	return redactSecretPatterns(value)
		.replace(PEM_BLOCK_RE, REDACTED)
		.replace(SHELL_EXPORT_RE, `$1${REDACTED}`)
		.replace(CREDENTIAL_FLAG_RE, `$1${REDACTED}`);
}

/**
 * Mask credentials in a stored tool payload, preserving its shape.
 *
 * Structure is kept intact (objects stay objects, arrays keep their length) so
 * the client can still render the payload; only leaf values change. Sensitive
 * keys are replaced without inspecting their value; every other string is run
 * through the text masker.
 */
export function redactExecutionLogPayload(value: unknown, depth = 0): unknown {
	if (value == null) return value;
	if (typeof value === "string") return redactExecutionLogText(value);
	if (typeof value !== "object") return value;
	if (depth >= MAX_REDACT_DEPTH) return "[depth limit]";
	if (Array.isArray(value)) {
		return value.map((item) => redactExecutionLogPayload(item, depth + 1));
	}
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		result[key] = isSensitiveExecutionLogKey(key)
			? REDACTED
			: redactExecutionLogPayload(item, depth + 1);
	}
	return result;
}
