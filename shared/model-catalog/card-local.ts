import { patchRawMetadata, validateRawMetadata, type RawCatalog, type RawMetadata } from "./card";
import type { RawLocalState } from "./card-resolver";
type CardMetadataPatch = Parameters<typeof patchRawMetadata>[1];

type Target = "model" | "variant" | "binding";
const scopeKey = (target: Target, id: string) => `${target}:${id}`;
function leaves(metadata: RawMetadata, prefix = ""): string[] {
	return Object.entries(metadata).flatMap(([key, value]) => {
		const path = prefix ? `${prefix}.${key}` : key;
		return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length
			? leaves(value, path)
			: [path];
	});
}
function merge(base: RawMetadata, incoming: RawMetadata): RawMetadata {
	const out = structuredClone(base);
	for (const [key, value] of Object.entries(incoming)) {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			if (!Object.keys(value).length && Object.hasOwn(out, key)) continue;
			const before = out[key];
			out[key] = merge(
				before && typeof before === "object" && !Array.isArray(before) ? before : {},
				value,
			);
		} else out[key] = structuredClone(value);
	}
	return validateRawMetadata(out);
}

/** Fold each existing override into its local definition/binding once, at the old priority. */
export function normalizeRawLocalState(input: RawLocalState): RawLocalState {
	if (!input || !Number.isSafeInteger(input.revision) || input.revision < 0)
		throw new Error("Invalid local metadata revision");
	if (input.legacyFields !== undefined) {
		if (
			!input.legacyFields ||
			typeof input.legacyFields !== "object" ||
			Array.isArray(input.legacyFields)
		)
			throw new Error("Invalid migration provenance");
		for (const [key, paths] of Object.entries(input.legacyFields)) {
			if (
				!/^(model|variant|binding):.+$/.test(key) ||
				!Array.isArray(paths) ||
				paths.length > 10000 ||
				paths.some((path) => typeof path !== "string" || path.length > 1024)
			)
				throw new Error("Invalid migration provenance");
		}
	}
	const local = structuredClone(input);
	const origins = local.legacyFields ?? {};
	const seen = new Set<string>();
	local.overrides = (local.overrides ?? []).filter((entry) => {
		const key = scopeKey(entry.target, entry.targetId);
		if (seen.has(key)) throw new Error(`Duplicate local override: ${key}`);
		seen.add(key);
		if (input.legacyFields === undefined && entry.source === "legacy-local")
			origins[key] = leaves(entry.metadata);
		if (entry.target === "binding") {
			const binding = local.bindings?.find((b) => b.id === entry.targetId);
			if (!binding) throw new Error(`Unknown local binding: ${entry.targetId}`);
			binding.overrides = merge(binding.overrides ?? {}, entry.metadata);
			return false;
		}
		const definition = (entry.target === "model" ? local.models : local.variants)?.find(
			(m) => m.id === entry.targetId,
		);
		if (!definition) return true;
		definition.metadata = merge(definition.metadata, entry.metadata);
		return false;
	});
	local.legacyFields = origins;
	return local;
}

/** The only v2 metadata patch destination in each scope. Revision/persistence belong to the caller. */
export function patchLocalCardMetadata(
	catalog: RawCatalog,
	input: RawLocalState,
	target: Target,
	id: string,
	patch: CardMetadataPatch,
): RawLocalState {
	if (!["model", "variant", "binding"].includes(target)) throw new Error("Invalid metadata scope");
	const local = normalizeRawLocalState(input);
	let before: RawMetadata;
	let store: (metadata: RawMetadata) => void;
	if (target === "binding") {
		const binding = local.bindings?.find((b) => b.id === id);
		if (!binding) throw new Error(`Unknown local binding: ${id}`);
		before = binding.overrides ?? {};
		store = (metadata) => {
			if (Object.keys(metadata).length) binding.overrides = metadata;
			else delete binding.overrides;
		};
	} else {
		const definition = (target === "model" ? local.models : local.variants)?.find(
			(m) => m.id === id,
		);
		if (definition) {
			before = definition.metadata;
			store = (metadata) => {
				definition.metadata = metadata;
			};
		} else {
			if (!(target === "model" ? catalog.models : catalog.variants).some((m) => m.id === id))
				throw new Error(`Unknown ${target}: ${id}`);
			const existing = local.overrides?.find((o) => o.target === target && o.targetId === id);
			before = existing?.metadata ?? {};
			store = (metadata) => {
				local.overrides = (local.overrides ?? []).filter((o) => o !== existing);
				if (Object.keys(metadata).length)
					local.overrides.push({ target, targetId: id, metadata, source: "user" });
			};
		}
	}
	const after = patchRawMetadata(before, patch);
	if (JSON.stringify(before) === JSON.stringify(after)) return local;
	store(after);
	const changed = [...Object.keys(patch.set ?? {}), ...(patch.reset ?? [])];
	const key = scopeKey(target, id);
	if (local.legacyFields?.[key]) {
		local.legacyFields[key] = local.legacyFields[key]!.filter(
			(field) =>
				!changed.some(
					(path) => field === path || field.startsWith(`${path}.`) || path.startsWith(`${field}.`),
				),
		);
		if (!local.legacyFields[key]!.length) delete local.legacyFields[key];
	}
	return local;
}

export type ModelCardMutation =
	| {
			baseRevision: number;
			action: "patch";
			target: Target;
			targetId: string;
			patch: CardMetadataPatch;
	  }
	| {
			baseRevision: number;
			action: "upsert-model";
			model: NonNullable<RawLocalState["models"]>[number];
	  }
	| {
			baseRevision: number;
			action: "upsert-variant";
			variant: NonNullable<RawLocalState["variants"]>[number];
	  }
	| {
			baseRevision: number;
			action: "upsert-binding";
			binding: NonNullable<RawLocalState["bindings"]>[number];
	  }
	| {
			baseRevision: number;
			action: "hide" | "restore" | "delete";
			target: Target;
			targetId: string;
	  };

function editedMetadata(previous: RawMetadata, incoming: RawMetadata): RawMetadata {
	validateRawMetadata(incoming);
	const set: Record<string, import("./card").JSONValue> = {};
	const collect = (value: RawMetadata, before: RawMetadata, prefix: string) => {
		for (const [key, item] of Object.entries(value)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (JSON.stringify(item) === JSON.stringify(before[key])) continue;
			if (item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length) {
				const old = before[key];
				collect(item, old && typeof old === "object" && !Array.isArray(old) ? old : {}, path);
			} else set[path] = item;
		}
	};
	collect(incoming, previous, "");
	return patchRawMetadata(previous, { set });
}

function replaceLocalEntry<T extends { id: string }>(items: T[] | undefined, entry: T): T[] {
	return items?.some((item) => item.id === entry.id)
		? items.map((item) => (item.id === entry.id ? entry : item))
		: [...(items ?? []), entry];
}
function clearEditedOrigins(
	local: RawLocalState,
	target: Target,
	id: string,
	before: RawMetadata,
	after: RawMetadata,
): void {
	const key = scopeKey(target, id);
	const at = (metadata: RawMetadata, path: string): unknown =>
		path
			.split(".")
			.reduce<unknown>(
				(value, key) =>
					value && typeof value === "object" && !Array.isArray(value)
						? (value as RawMetadata)[key]
						: undefined,
				metadata,
			);
	if (local.legacyFields?.[key]) {
		local.legacyFields[key] = local.legacyFields[key]!.filter(
			(path) => JSON.stringify(at(before, path)) === JSON.stringify(at(after, path)),
		);
		if (!local.legacyFields[key]!.length) delete local.legacyFields[key];
	}
}
/** Pure v2 edits. Unknown existing attributes survive; new unknown properties are not writable. */
export function mutateRawLocal(
	catalog: RawCatalog,
	input: RawLocalState,
	mutation: ModelCardMutation,
): RawLocalState {
	const keys: Record<ModelCardMutation["action"], string[]> = {
		patch: ["target", "targetId", "patch"],
		"upsert-model": ["model"],
		"upsert-variant": ["variant"],
		"upsert-binding": ["binding"],
		hide: ["target", "targetId"],
		restore: ["target", "targetId"],
		delete: ["target", "targetId"],
	};
	if (
		!Object.hasOwn(keys, mutation.action) ||
		Object.keys(mutation).some(
			(key) => !["action", "baseRevision", ...keys[mutation.action]].includes(key),
		)
	)
		throw new Error("Invalid model card mutation");
	if (mutation.action === "patch")
		return patchLocalCardMetadata(
			catalog,
			input,
			mutation.target,
			mutation.targetId,
			mutation.patch,
		);
	const local = normalizeRawLocalState(input);
	if (mutation.action === "upsert-model" || mutation.action === "upsert-variant") {
		const variant = mutation.action === "upsert-variant";
		let entry = structuredClone(variant ? mutation.variant : mutation.model);
		if (!entry || typeof entry.id !== "string" || !entry.id)
			throw new Error("Identity is required");
		if (Object.hasOwn(entry, "rawMetadata"))
			throw new Error("Derived metadata fields are read-only");
		const existing = (variant ? local.variants : local.models)?.find((m) => m.id === entry.id);
		if (!existing && (variant ? catalog.variants : catalog.models).some((m) => m.id === entry.id))
			throw new Error("Edit a catalog entry using a scoped patch, not a replacement definition");
		entry = {
			...existing,
			...entry,
			...(entry.matches ? { matches: { ...existing?.matches, ...entry.matches } } : {}),
			metadata: editedMetadata(existing?.metadata ?? {}, entry.metadata),
		};
		clearEditedOrigins(
			local,
			variant ? "variant" : "model",
			entry.id,
			existing?.metadata ?? {},
			entry.metadata,
		);
		if (variant)
			local.variants = replaceLocalEntry(
				local.variants,
				entry as NonNullable<RawLocalState["variants"]>[number],
			);
		else local.models = replaceLocalEntry(local.models, entry);
	} else if (mutation.action === "upsert-binding") {
		let entry = structuredClone(mutation.binding);
		if (!entry || !entry.id || !entry.upstreamModelId)
			throw new Error("Binding identity is required");
		if (Object.hasOwn(entry, "rawMetadata"))
			throw new Error("Derived metadata fields are read-only");
		const existing = local.bindings?.find((b) => b.id === entry.id);
		entry = {
			...existing,
			...entry,
			overrides: editedMetadata(existing?.overrides ?? {}, entry.overrides ?? {}),
		};
		clearEditedOrigins(local, "binding", entry.id, existing?.overrides ?? {}, entry.overrides!);
		if (!Object.keys(entry.overrides!).length) delete entry.overrides;
		local.bindings = replaceLocalEntry(local.bindings, entry);
	} else {
		if (!["model", "variant", "binding"].includes(mutation.target) || !mutation.targetId)
			throw new Error("Invalid metadata scope");
		const { target, targetId: id } = mutation;
		if (target === "binding") {
			if (mutation.action !== "delete") throw new Error("Bindings cannot hide model availability");
			if (!local.bindings?.some((b) => b.id === id)) throw new Error("Unknown binding");
			local.bindings = local.bindings.filter((b) => b.id !== id);
		} else {
			const defined = (target === "model" ? local.models : local.variants)?.some(
				(m) => m.id === id,
			);
			const preset = (target === "model" ? catalog.models : catalog.variants).some(
				(m) => m.id === id,
			);
			if (!defined && !preset) throw new Error("Unknown model card identity");
			if (mutation.action === "delete") {
				if (!defined) throw new Error("Use hide for a catalog definition");
				if (target === "model") local.models = local.models?.filter((m) => m.id !== id);
				else local.variants = local.variants?.filter((m) => m.id !== id);
			}
			const field = target === "model" ? "hiddenModelIds" : "hiddenVariantIds";
			local[field] = (local[field] ?? []).filter((key) => key !== id);
			if (mutation.action === "hide") local[field].push(id);
		}
		if (mutation.action === "delete") {
			local.overrides = local.overrides?.filter((o) => o.target !== target || o.targetId !== id);
			delete local.legacyFields?.[scopeKey(target, id)];
		}
	}
	return normalizeRawLocalState(local);
}
