/**
 * JSON view of a single MCP server draft.
 *
 * The edit modal has two representations of the same draft: a form and a JSON
 * document. Both must round-trip through `McpServerDraft` so that switching
 * views never silently drops a field the other view does not render.
 *
 * Secret values are the reason this is not a plain `JSON.stringify`. The server
 * only ever returns `envKeys`/`headerKeys`, never values, so a JSON view cannot
 * show what is stored. Emitting `""` would read as "the value is empty" and
 * saving would overwrite the real secret with an empty string. Instead the
 * placeholder below marks "keep whatever is persisted", which is exactly the
 * semantics of a `preserved` draft entry, and `buildMcpSecretPatch` already
 * knows how to leave those keys untouched.
 */

import { createPreservedMcpSecretEntries, type McpSecretDraftEntry } from "./mcp-secrets";

/** Sentinel for "leave the persisted secret value unchanged". */
export const MCP_SECRET_KEEP_PLACEHOLDER = "__KEEP_EXISTING__";

export type McpJsonTransport = "stdio" | "streamable-http" | "sse";

export type McpJsonBehavior = "" | "readOnly" | "readWrite" | "ask" | "deny";

/** The subset of `McpServerDraft` the JSON view is allowed to describe. */
export interface McpJsonDraft {
	name: string;
	transport: McpJsonTransport;
	command: string;
	args: string;
	cwd: string;
	url: string;
	env: McpSecretDraftEntry[];
	headers: McpSecretDraftEntry[];
	originalEnvKeys: string[];
	originalHeaderKeys: string[];
	enabled: boolean;
	defaultBehavior: McpJsonBehavior;
}

export type McpJsonParseResult =
	| { ok: true; draft: McpJsonDraft }
	| { ok: false; errorKey: McpJsonParseErrorKey; params?: Record<string, string> };

/**
 * The document is authoritative for every field it can express: an omitted key
 * clears that field rather than inheriting the previous draft value. Deleting a
 * line is the natural way to unset something in a config file, and inheriting
 * instead would make that edit vanish with no feedback. Only the persisted
 * secret key lists — which the document cannot carry — come from the old draft.
 */

export type McpJsonParseErrorKey =
	| "mcpJsonInvalidJson"
	| "mcpJsonNotObject"
	| "mcpJsonInvalidField"
	| "mcpJsonInvalidTransport"
	| "mcpJsonInvalidBehavior";

const BEHAVIORS: readonly Exclude<McpJsonBehavior, "">[] = ["readOnly", "readWrite", "ask", "deny"];

/**
 * Transport aliases accepted on input only. Pasting a config from another tool
 * is the common way to reach this editor, and rejecting `"http"` there would be
 * pedantry — but the emitted document always uses the canonical name so the
 * form's SegmentedControl and the JSON text cannot disagree.
 */
const TRANSPORT_ALIASES: Record<string, McpJsonTransport> = {
	stdio: "stdio",
	sse: "sse",
	"streamable-http": "streamable-http",
	streamablehttp: "streamable-http",
	http: "streamable-http",
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function secretEntriesToJson(entries: ReadonlyArray<McpSecretDraftEntry>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of entries) {
		const key = entry.key.trim();
		if (!key) continue;
		// A preserved entry the user has not retyped has no value in memory; the
		// placeholder is the only honest thing to print for it.
		result[key] = entry.preserved && !entry.dirty ? MCP_SECRET_KEEP_PLACEHOLDER : entry.value;
	}
	return result;
}

/** Serialize a draft into the JSON document shown in the editor. */
export function mcpDraftToJsonText(draft: McpJsonDraft): string {
	const doc: Record<string, unknown> = {
		name: draft.name,
		transport: draft.transport,
	};

	if (draft.transport === "stdio") {
		doc.command = draft.command;
		doc.args = draft.args
			.split("\n")
			.map((arg) => arg.trim())
			.filter(Boolean);
		if (draft.cwd.trim()) doc.cwd = draft.cwd.trim();
	} else {
		doc.url = draft.url;
		const headers = secretEntriesToJson(draft.headers);
		if (Object.keys(headers).length > 0) doc.headers = headers;
	}

	const env = secretEntriesToJson(draft.env);
	if (Object.keys(env).length > 0) doc.env = env;

	doc.enabled = draft.enabled;
	if (draft.defaultBehavior) doc.defaultBehavior = draft.defaultBehavior;

	return JSON.stringify(doc, null, 2);
}

/**
 * Rebuild secret entries from a JSON map.
 *
 * Keys absent from the map are intentionally dropped: `buildMcpSecretPatch`
 * turns "was in originalKeys but not in entries" into a delete, so removing a
 * line from the JSON deletes that variable, which is what editing a config file
 * is expected to mean.
 */
function jsonToSecretEntries(
	value: unknown,
	originalKeys: ReadonlyArray<string>,
): McpSecretDraftEntry[] | null {
	if (value === undefined) return [];
	if (!isObjectRecord(value)) return null;
	const originals = new Set(originalKeys);
	const entries: McpSecretDraftEntry[] = [];
	for (const [rawKey, rawValue] of Object.entries(value)) {
		const key = rawKey.trim();
		if (!key) continue;
		if (typeof rawValue !== "string") return null;
		if (rawValue === MCP_SECRET_KEEP_PLACEHOLDER) {
			if (originals.has(key)) {
				entries.push({ key, value: "", preserved: true });
				continue;
			}
			// The placeholder refers to nothing for a key that was never saved;
			// treating it as a literal secret would persist the sentinel text.
			continue;
		}
		entries.push({ key, value: rawValue, preserved: originals.has(key), dirty: true });
	}
	return entries;
}

function readOptionalString(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return null;
	return value;
}

/**
 * Parse the JSON document back into a draft.
 *
 * `current` supplies the persisted secret key lists, which the JSON text cannot
 * carry: they decide whether a placeholder means "keep this" or refers to a key
 * that does not exist, and which omitted keys count as deletions.
 */
export function parseMcpDraftJson(text: string, current: McpJsonDraft): McpJsonParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, errorKey: "mcpJsonInvalidJson" };
	}
	if (!isObjectRecord(parsed)) {
		return { ok: false, errorKey: "mcpJsonNotObject" };
	}

	const name = readOptionalString(parsed.name);
	if (name === null) {
		return { ok: false, errorKey: "mcpJsonInvalidField", params: { field: "name" } };
	}

	const rawTransport = parsed.transport ?? parsed.type;
	// Transport is the one exception: it selects which other fields are even
	// meaningful, and an omitted transport with a `url` present is the shape most
	// pasted configs use, so falling back to the current value is the useful read.
	let transport = current.transport;
	if (rawTransport !== undefined && rawTransport !== null) {
		if (typeof rawTransport !== "string") {
			return { ok: false, errorKey: "mcpJsonInvalidTransport" };
		}
		const resolved = TRANSPORT_ALIASES[rawTransport.trim().toLowerCase()];
		if (!resolved) {
			return { ok: false, errorKey: "mcpJsonInvalidTransport" };
		}
		transport = resolved;
	}

	const command = readOptionalString(parsed.command);
	if (command === null) {
		return { ok: false, errorKey: "mcpJsonInvalidField", params: { field: "command" } };
	}
	const cwd = readOptionalString(parsed.cwd);
	if (cwd === null) {
		return { ok: false, errorKey: "mcpJsonInvalidField", params: { field: "cwd" } };
	}
	const url = readOptionalString(parsed.url);
	if (url === null) {
		return { ok: false, errorKey: "mcpJsonInvalidField", params: { field: "url" } };
	}

	let args = "";
	if (parsed.args !== undefined && parsed.args !== null) {
		if (!Array.isArray(parsed.args) || parsed.args.some((arg) => typeof arg !== "string")) {
			return { ok: false, errorKey: "mcpJsonInvalidField", params: { field: "args" } };
		}
		args = (parsed.args as string[]).join("\n");
	}

	const env = jsonToSecretEntries(parsed.env, current.originalEnvKeys);
	if (!env) {
		return { ok: false, errorKey: "mcpJsonInvalidField", params: { field: "env" } };
	}
	const headers = jsonToSecretEntries(parsed.headers, current.originalHeaderKeys);
	if (!headers) {
		return { ok: false, errorKey: "mcpJsonInvalidField", params: { field: "headers" } };
	}

	// `enabled` defaults to true when omitted, matching the create API default and
	// the convention of every MCP config format we import from.
	let enabled = true;
	if (parsed.enabled !== undefined && parsed.enabled !== null) {
		if (typeof parsed.enabled !== "boolean") {
			return { ok: false, errorKey: "mcpJsonInvalidField", params: { field: "enabled" } };
		}
		enabled = parsed.enabled;
	}

	let defaultBehavior: McpJsonBehavior = "";
	if ("defaultBehavior" in parsed) {
		const raw = parsed.defaultBehavior;
		if (raw === null || raw === "") {
			defaultBehavior = "";
		} else if (typeof raw === "string" && BEHAVIORS.includes(raw as Exclude<McpJsonBehavior, "">)) {
			defaultBehavior = raw as McpJsonBehavior;
		} else if (typeof raw === "string" && raw === "allow") {
			// The API accepts "allow" as a legacy alias of readWrite; mirror it so a
			// pasted older config does not fail validation for a name we support.
			defaultBehavior = "readWrite";
		} else {
			return { ok: false, errorKey: "mcpJsonInvalidBehavior" };
		}
	}

	return {
		ok: true,
		draft: {
			...current,
			name: name ?? "",
			transport,
			command: command ?? "",
			args,
			cwd: cwd ?? "",
			url: url ?? "",
			env,
			// Editing a non-stdio server as stdio (or the reverse) leaves the
			// other transport's secrets unreachable in the JSON. Keeping the
			// existing preserved entries would silently resurrect them on save,
			// so drop headers entirely when the document describes stdio.
			headers: transport === "stdio" ? [] : headers,
			enabled,
			defaultBehavior,
		},
	};
}

/** Preserved-entry helper re-exported so the modal has one import for JSON mode. */
export { createPreservedMcpSecretEntries };
