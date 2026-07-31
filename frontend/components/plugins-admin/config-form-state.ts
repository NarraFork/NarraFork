/**
 * Form state for plugin provider config: draft values in, submit payload out.
 *
 * Kept separate from the React component so the rules that matter can be tested without
 * a DOM. The rules that matter are mostly about secrets:
 *
 * - the server sends a placeholder instead of a stored secret, and sending it back
 *   unchanged means "keep what you have";
 * - an emptied secret field means "delete it", which is distinct from "leave it alone";
 * - a secret must never be written into a draft that could be logged or serialized
 *   alongside ordinary config.
 *
 * Getting that three-way distinction wrong silently destroys a working credential, so it
 * is modelled explicitly rather than inferred from an empty string.
 */

import {
	type ConfigField,
	checkFieldValue,
	formatListValue,
	type JsonValue,
	parseListValue,
} from "./config-schema";

/** Mirrors `SECRET_PLACEHOLDER` in `server/services/plugin-provider-config-service.ts`. */
export const SECRET_PLACEHOLDER = "__narrafork_secret_set__";

/** Per-field secret intent, since "empty" alone is ambiguous. */
export type SecretIntent = "keep" | "replace" | "clear";

export interface ConfigDraft {
	/** Non-secret values, keyed by field name. */
	values: Record<string, JsonValue>;
	/** Raw JSON text for fields that fell back to the JSON editor. */
	rawText: Record<string, string>;
	/** Secret field intents. Absent means `keep`. */
	secretIntents: Record<string, SecretIntent>;
	/** Replacement secret values, only for fields whose intent is `replace`. */
	secretValues: Record<string, string>;
}

export interface ConfigViewInput {
	config: Record<string, JsonValue>;
	secretFields: readonly string[];
	secretsSet: readonly string[];
}

export function emptyDraft(): ConfigDraft {
	return { values: {}, rawText: {}, secretIntents: {}, secretValues: {} };
}

/**
 * Seed a draft from the server's view.
 *
 * `default` only fills a genuinely absent value: applying it over a stored value would
 * silently revert a user's explicit choice on every page load.
 */
export function draftFromView(fields: readonly ConfigField[], view: ConfigViewInput): ConfigDraft {
	const draft = emptyDraft();
	const secretFields = new Set(view.secretFields);
	for (const field of fields) {
		if (secretFields.has(field.name)) continue;
		const stored = view.config[field.name];
		const value = stored !== undefined ? stored : field.defaultValue;
		if (value === undefined) continue;
		if (field.kind === "json" || field.constValue !== undefined) {
			draft.rawText[field.name] = JSON.stringify(value, null, 2);
			continue;
		}
		draft.values[field.name] = value;
	}
	return draft;
}

/** Text to show in a secret input: never the value, only whether one exists. */
export function secretDisplayValue(
	field: ConfigField,
	draft: ConfigDraft,
	view: ConfigViewInput,
): string {
	const intent = draft.secretIntents[field.name] ?? "keep";
	if (intent === "replace") return draft.secretValues[field.name] ?? "";
	if (intent === "clear") return "";
	// `keep` with a stored secret shows the placeholder so the field looks populated
	// without the value ever reaching the browser.
	return view.secretsSet.includes(field.name) ? SECRET_PLACEHOLDER : "";
}

/** Record a user edit to a secret field, deriving intent from the new text. */
export function setSecretValue(draft: ConfigDraft, name: string, text: string): ConfigDraft {
	const secretIntents = { ...draft.secretIntents };
	const secretValues = { ...draft.secretValues };
	if (text === SECRET_PLACEHOLDER) {
		// The user did not touch the masked field; leave the stored secret alone.
		secretIntents[name] = "keep";
		delete secretValues[name];
	} else if (text.length === 0) {
		secretIntents[name] = "clear";
		delete secretValues[name];
	} else {
		secretIntents[name] = "replace";
		secretValues[name] = text;
	}
	return { ...draft, secretIntents, secretValues };
}

export function setFieldValue(draft: ConfigDraft, name: string, value: JsonValue): ConfigDraft {
	return { ...draft, values: { ...draft.values, [name]: value } };
}

export function clearFieldValue(draft: ConfigDraft, name: string): ConfigDraft {
	const values = { ...draft.values };
	delete values[name];
	return { ...draft, values };
}

export function setRawText(draft: ConfigDraft, name: string, text: string): ConfigDraft {
	return { ...draft, rawText: { ...draft.rawText, [name]: text } };
}

export function setListValue(draft: ConfigDraft, name: string, text: string): ConfigDraft {
	const parsed = parseListValue(text);
	if (parsed.length === 0) return clearFieldValue(draft, name);
	return setFieldValue(draft, name, parsed);
}

export function listTextFor(draft: ConfigDraft, name: string): string {
	return formatListValue(draft.values[name]);
}

export interface DraftIssue {
	name: string;
	message: string;
}

export interface BuildPayloadResult {
	/** Body for `PUT /plugins/:id/providers/config`, or undefined when invalid. */
	payload?: Record<string, JsonValue>;
	issues: DraftIssue[];
}

/**
 * Turn a draft into the request body.
 *
 * Advisory checks run first so obvious mistakes surface without a round-trip, but the
 * server re-validates everything: this function is a convenience, not a gatekeeper.
 * Malformed JSON in a raw field *is* blocked here, because there is nothing meaningful
 * to send in that case.
 */
export function buildConfigPayload(
	fields: readonly ConfigField[],
	draft: ConfigDraft,
	view: ConfigViewInput,
): BuildPayloadResult {
	const issues: DraftIssue[] = [];
	const payload: Record<string, JsonValue> = {};
	const secretFields = new Set(view.secretFields);

	for (const field of fields) {
		if (secretFields.has(field.name)) {
			const intent = draft.secretIntents[field.name] ?? "keep";
			if (intent === "keep") {
				// Only echo the placeholder when a secret actually exists; sending it for an
				// unset field would ask the server to keep something that is not there.
				if (view.secretsSet.includes(field.name)) payload[field.name] = SECRET_PLACEHOLDER;
				else if (field.required) issues.push({ name: field.name, message: "required" });
				continue;
			}
			if (intent === "clear") {
				if (field.required) {
					issues.push({ name: field.name, message: "required" });
					continue;
				}
				// Empty string is the documented "delete this secret" signal.
				payload[field.name] = "";
				continue;
			}
			payload[field.name] = draft.secretValues[field.name] ?? "";
			continue;
		}

		if (field.constValue !== undefined) {
			// The server only accepts the const value, so send it verbatim and ignore any
			// edit; the input is rendered read-only for the same reason.
			payload[field.name] = field.constValue;
			continue;
		}

		if (field.kind === "json") {
			const text = draft.rawText[field.name];
			if (text === undefined || text.trim().length === 0) {
				if (field.required) issues.push({ name: field.name, message: "required" });
				continue;
			}
			try {
				payload[field.name] = JSON.parse(text) as JsonValue;
			} catch {
				issues.push({ name: field.name, message: "is not valid JSON" });
			}
			continue;
		}

		const value = draft.values[field.name];
		const issue = checkFieldValue(field, value);
		if (issue) {
			issues.push({ name: field.name, message: issue });
			continue;
		}
		// An absent optional value is omitted rather than sent as null, so the server sees
		// "not configured" instead of "explicitly null".
		if (value === undefined || value === "") continue;
		payload[field.name] = value;
	}

	return issues.length > 0 ? { issues } : { payload, issues };
}

/** True when the draft differs from what the server already has. */
export function isDraftDirty(
	fields: readonly ConfigField[],
	draft: ConfigDraft,
	view: ConfigViewInput,
): boolean {
	const secretFields = new Set(view.secretFields);
	for (const field of fields) {
		if (secretFields.has(field.name)) {
			if ((draft.secretIntents[field.name] ?? "keep") !== "keep") return true;
			continue;
		}
		const stored = view.config[field.name];
		if (field.constValue !== undefined) continue;
		if (field.kind === "json") {
			const text = draft.rawText[field.name] ?? "";
			const storedText = stored === undefined ? "" : JSON.stringify(stored, null, 2);
			if (text.trim() !== storedText.trim()) return true;
			continue;
		}
		const current = draft.values[field.name];
		if (JSON.stringify(current ?? null) === JSON.stringify(stored ?? null)) continue;
		// A field showing its schema default over an unstored value is not a user edit.
		// Without this the Save button would light up on every page load, training the
		// admin to ignore it — and the default came from the plugin, so persisting it
		// changes nothing the plugin would not already assume.
		if (
			stored === undefined &&
			field.defaultValue !== undefined &&
			JSON.stringify(current ?? null) === JSON.stringify(field.defaultValue)
		) {
			continue;
		}
		return true;
	}
	return false;
}
