export * from '../schema/catalog';
export * from '../schema/api';
export { validateCatalog, validateMetadata } from './validation';
import type { CatalogDocument, FieldSource, LocalCatalogState, MetadataPatch, ModelBinding, ModelDefinition, ModelMetadata, ModelQuery, ModelVariant, ResolveModelMetadataInput, ResolvedModelMetadata } from '../schema/catalog';
import { fail, leafPaths, validateCatalog, validateMetadata, validateShape } from './validation';

type ObjectValue = Record<string, unknown>;
function leaves(value: object, prefix = ''): Array<[string, unknown]> {
  return Object.entries(value).flatMap(([key, v]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? leaves(v, path) : [[path, v]];
  });
}
function put(target: object, path: string, value: unknown): void {
  const parts = path.split('.');
  let object = target as ObjectValue;
  for (const part of parts.slice(0, -1)) object = (object[part] ??= {}) as ObjectValue;
  object[parts.at(-1)!] = structuredClone(value);
}
function remove(target: ObjectValue, parts: string[]): void {
  const [key, ...rest] = parts;
  if (!key || !Object.hasOwn(target, key)) return;
  if (!rest.length) delete target[key];
  else {
    const child = target[key] as ObjectValue;
    remove(child, rest);
    if (!Object.keys(child).length) delete target[key];
  }
}
export function applyMetadataPatch(metadata: ModelMetadata, patch: MetadataPatch): ModelMetadata {
  const result = validateMetadata(metadata);
  validateShape(patch, 'MetadataPatch');
  for (const path of [...Object.keys(patch.set ?? {}), ...(patch.reset ?? [])]) if (!leafPaths.has(path)) fail(`Invalid metadata leaf ${path}`);
  for (const path of patch.reset ?? []) {
    if (Object.hasOwn(patch.set ?? {}, path)) fail(`Conflicting set/reset ${path}`);
    remove(result as ObjectValue, path.split('.'));
  }
  for (const [path, value] of Object.entries(patch.set ?? {})) {
    if (value === undefined) fail(`Undefined patch value ${path}; use reset to inherit`);
    put(result, path, value);
  }
  return validateMetadata(result);
}

/** Only explicitly declared volatile suffixes are stripped; semantic suffixes and colons are opaque. */
function volatileBases(id: string): string[] {
  let result = id;
  const bases: string[] = [];
  for (;;) {
    const next = result.replace(/(?:-(?:\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|(?:20)?\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|latest|preview))$/, '');
    if (next === result) return bases;
    bases.push(next);
    result = next;
  }
}
type Entry = ModelDefinition | ModelVariant;
type Candidate = { entry: Entry; variant: boolean; via: ResolvedModelMetadata['matchedVia']; scope: number; rank: number; length: number };
function choose<T>(items: T[], message: string): T | undefined {
  if (items.length > 1) fail(message);
  return items[0];
}
export function resolveModelMetadata(input: ResolveModelMetadataInput): ResolvedModelMetadata {
  validateShape(input, 'ResolveModelMetadataInput');
  return createModelMetadataResolver(input.catalog, input.local)(input.query, input.discovered, input.defaults);
}

/** Validate and copy an immutable batch once, rather than revalidating the whole catalog per model. */
export function createModelMetadataResolver(catalogInput: CatalogDocument, localInput?: LocalCatalogState) {
  const catalog = validateCatalog(catalogInput);
  if (localInput !== undefined) validateShape(localInput, 'LocalCatalogState');
  const local = localInput === undefined ? undefined : structuredClone(localInput);
  const localModels = new Set((local?.models ?? []).map(m => m.id));
  const localVariants = new Set((local?.variants ?? []).map(v => v.id));
  const combined = validateCatalog({ ...catalog,
    models: [...catalog.models.filter(m => !localModels.has(m.id)), ...(local?.models ?? [])],
    variants: [...catalog.variants.filter(v => !localVariants.has(v.id)), ...(local?.variants ?? [])],
  });
  return (query: ModelQuery, discovered?: ModelMetadata, defaults?: ModelMetadata): ResolvedModelMetadata => {
    validateShape(query, 'ModelQuery');
    if (discovered !== undefined) validateMetadata(discovered);
    if (defaults !== undefined) validateMetadata(defaults);
    return resolvePreparedModelMetadata({ catalog, local, query, discovered, defaults }, combined);
  };
}

function resolvePreparedModelMetadata(input: ResolveModelMetadataInput, combined: CatalogDocument): ResolvedModelMetadata {
  const { catalog, query, local } = input;
  const localModels = new Set((local?.models ?? []).map(m => m.id));
  const localVariants = new Set((local?.variants ?? []).map(m => m.id));
  const models = combined.models.filter(m => !local?.hiddenModelIds?.includes(m.id));
  const variants = combined.variants.filter(v => !local?.hiddenVariantIds?.includes(v.id) && !local?.hiddenModelIds?.includes(v.modelId));
  const bindings = local?.bindings ?? [];
  const seenBindings = new Set<string>();
  for (const binding of bindings) {
    if (seenBindings.has(binding.id)) fail(`Duplicate binding ${binding.id}`);
    seenBindings.add(binding.id);
    if (binding.overrides) validateMetadata(binding.overrides);
  }
  const matchingBindings = bindings.filter(b => b.upstreamModelId === query.upstreamModelId && (b.providerId === undefined || b.providerId === query.providerId) && (b.channelId === undefined || b.channelId === query.channelId));
  const specificity = (b: ModelBinding) => Number(b.providerId !== undefined) + Number(b.channelId !== undefined);
  const maxSpecificity = Math.max(-1, ...matchingBindings.map(specificity));
  const binding = choose(matchingBindings.filter(b => specificity(b) === maxSpecificity), 'Ambiguous binding');
  let model: ModelDefinition | undefined;
  let variant: ModelVariant | undefined;
  let matchedVia: ResolvedModelMetadata['matchedVia'] = 'none';
  let matchedEntry: Entry | undefined;
  let weakVia: ResolvedModelMetadata['matchedVia'] = 'none';
  const explicitVariant = binding?.variantId ?? query.variantId;
  const explicitModel = binding?.modelId ?? query.modelId;
  if (binding?.variantId && query.variantId && binding.variantId !== query.variantId) fail('Binding conflicts with explicit variant');
  if (binding?.modelId && query.modelId && binding.modelId !== query.modelId) fail('Binding conflicts with explicit model');
  if (explicitVariant !== undefined) {
    const identified = combined.variants.find(v => v.id === explicitVariant) ?? fail(`Unknown variant ${explicitVariant}`);
    if (query.providerKey && query.providerKey !== identified.providerKey) fail('Variant provider scope mismatch');
    if (explicitModel && explicitModel !== identified.modelId) fail('Variant model identity mismatch');
    variant = variants.find(v => v.id === explicitVariant);
    if (variant) {
      model = models.find(m => m.id === variant!.modelId)!;
      matchedVia = binding ? 'binding' : 'exact';
    }
  } else if (explicitModel !== undefined) {
    if (!combined.models.some(m => m.id === explicitModel)) fail(`Unknown model ${explicitModel}`);
    model = models.find(m => m.id === explicitModel);
    if (model) matchedVia = binding ? 'binding' : 'exact';
  } else {
    const candidates: Candidate[] = [];
    // Rank suppressed identities too, so hiding an exact/stronger card cannot resurrect it through a weaker unrelated match.
    for (const entry of [...combined.models, ...combined.variants]) {
      const isVariant = 'providerKey' in entry;
      if (isVariant && entry.providerKey !== query.providerKey) continue;
      const ids = [entry.id, ...(entry.matches?.ids ?? []), ...(isVariant ? entry.upstreamModelIds : [])];
      const aliases = entry.matches?.aliases ?? [];
      const id = query.upstreamModelId;
      let via: Candidate['via'] = 'none';
      let rank = 0;
      let length = 0;
      if (ids.includes(id)) { via = 'exact'; rank = 4; }
      else if (aliases.includes(id)) { via = 'alias'; rank = 3; }
      else if (entry.matches?.volatileSuffixes && volatileBases(id).some(base => [...ids, ...aliases].includes(base))) { via = 'suffix'; rank = 2; }
      else {
        length = Math.max(0, ...(entry.matches?.prefixes ?? []).filter(p => id.startsWith(p)).map(p => p.length));
        if (length) { via = 'prefix'; rank = 1; }
      }
      if (rank) candidates.push({ entry, variant: isVariant, scope: isVariant ? 1 : 0, via, rank, length });
    }
    candidates.sort((a, b) => b.scope - a.scope || b.rank - a.rank || b.length - a.length);
    const best = candidates[0];
    if (best) {
      if (candidates.some(c => c !== best && c.scope === best.scope && c.rank === best.rank && c.length === best.length)) fail(`Ambiguous ${best.via} match for ${query.upstreamModelId}`);
      const suppressed = best.variant
        ? local?.hiddenVariantIds?.includes(best.entry.id) || local?.hiddenModelIds?.includes((best.entry as ModelVariant).modelId)
        : local?.hiddenModelIds?.includes(best.entry.id);
      if (!suppressed) {
        matchedEntry = best.entry;
        matchedVia = binding ? 'binding' : best.via;
        // Preserve weak-match restrictions even when a binding only supplies local overrides.
        if (best.variant) {
          variant = best.entry as ModelVariant;
          model = models.find(m => m.id === variant!.modelId)!;
        } else model = best.entry as ModelDefinition;
        weakVia = best.via;
      }
    }
  }
  const metadata: ModelMetadata = {};
  const provenance: ResolvedModelMetadata['provenance'] = {};
  function merge(value: ModelMetadata | undefined, source: FieldSource, restrict = false): void {
    if (!value) return;
    const validated = validateMetadata(value);
    for (const [path, v] of leaves(validated)) {
      if (restrict && matchedEntry && (weakVia === 'prefix' || weakVia === 'suffix')) {
        const fields = matchedEntry.matches?.fields;
        if (fields && !fields.some(f => path === f || path.startsWith(`${f}.`))) continue;
        if (weakVia === 'prefix' && path.startsWith('referencePricing.') && !fields?.some(f => f === 'referencePricing' || path === f || path.startsWith(`${f}.`))) continue;
      }
      put(metadata, path, v);
      provenance[path] = { ...source };
    }
  }
  merge(input.defaults, { layer: 'default' });
  const source = (entry: Entry, layer: FieldSource['layer']): FieldSource => ({ layer, id: entry.id, catalogVersion: catalog.catalogVersion, ...(entry.status === 'legacy-unverified' ? { legacy: true } : {}) });
  const presetModel = model && catalog.models.find(m => m.id === model.id);
  const presetVariant = variant && catalog.variants.find(v => v.id === variant.id);
  if (presetModel) merge(presetModel.metadata, source(presetModel, 'preset-model'), true);
  if (presetVariant) merge(presetVariant.metadata, source(presetVariant, 'preset-variant'), true);
  merge(input.discovered, { layer: 'discovered' });
  const overrides = local?.overrides ?? [];
  const seenOverrides = new Set<string>();
  for (const o of overrides) {
    validateMetadata(o.metadata);
    const key = JSON.stringify([o.target, o.targetId]);
    if (seenOverrides.has(key)) fail(`Duplicate override ${o.target}:${o.targetId}`);
    seenOverrides.add(key);
  }
  function override(target: 'model' | 'variant' | 'binding', id: string): void {
    const o = overrides.find(x => x.target === target && x.targetId === id);
    if (o) merge(o.metadata, { layer: `local-${target}`, id, explicit: true, ...(o.source === 'legacy-local' ? { legacy: true } : {}) }, target !== 'binding');
  }
  if (model) {
    if (localModels.has(model.id)) merge(model.metadata, { layer: 'local-model', id: model.id, explicit: true }, true);
    override('model', model.id);
  }
  if (variant) {
    if (localVariants.has(variant.id)) merge(variant.metadata, { layer: 'local-variant', id: variant.id, explicit: true }, true);
    override('variant', variant.id);
  }
  if (binding) {
    merge(binding.overrides, { layer: 'local-binding', id: binding.id, explicit: true });
    override('binding', binding.id);
    matchedVia = 'binding';
  }
  validateMetadata(metadata);
  return { schemaVersion: 1, catalogVersion: catalog.catalogVersion, localRevision: local?.revision ?? 0,
    ...(model ? { modelId: model.id } : {}), ...(variant ? { variantId: variant.id } : {}), ...(binding ? { bindingId: binding.id } : {}),
    matchedVia, metadata, provenance };
}
