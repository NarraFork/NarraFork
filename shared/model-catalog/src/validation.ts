import schema from '../schema/catalog.schema.json';
import type { CatalogDocument, ModelMetadata } from '../schema/catalog';
type Schema = { $ref?: string; anyOf?: Schema[]; enum?: unknown[]; type?: string; properties?: Record<string, Schema>; additionalProperties?: boolean | Schema; required?: string[]; items?: Schema; uniqueItems?: boolean; minLength?: number; pattern?: string; minimum?: number; maximum?: number; format?: string };
export function fail(message: string): never { throw new Error(message); }
export function validateShape(value: unknown, name: string): void {
  const defs = schema.$defs as unknown as Record<string, Schema>;
  function check(v: unknown, s: Schema, p: string): void {
    if (s.$ref) return check(v, defs[s.$ref.split('/').pop()!]!, p);
    if (s.anyOf) {
      for (const candidate of s.anyOf) { try { check(v, candidate, p); return; } catch {} }
      fail(`Invalid value at ${p}`);
    }
    if (s.enum && !s.enum.includes(v)) fail(`Invalid enum at ${p}`);
    if (s.type === 'null' && v !== null) fail(`Expected null at ${p}`);
    if (s.type === 'string') {
      if (typeof v !== 'string' || v.length < (s.minLength ?? 0) || (s.pattern && !new RegExp(s.pattern).test(v))) fail(`Invalid string at ${p}`);
      if (s.format === 'date-time' && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) || !Number.isFinite(Date.parse(v)))) fail(`Invalid timestamp at ${p}`);
      if (s.format === 'uri') { try { const url = new URL(v); if (!['https:', 'http:'].includes(url.protocol)) fail('protocol'); } catch { fail(`Invalid URL at ${p}`); } }
    }
    if (s.type === 'boolean' && typeof v !== 'boolean') fail(`Expected boolean at ${p}`);
    if (s.type === 'integer' && (typeof v !== 'number' || !Number.isSafeInteger(v) || v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) fail(`Invalid integer at ${p}`);
    if (s.type === 'array') {
      if (!Array.isArray(v)) fail(`Expected array at ${p}`);
      if (s.uniqueItems && new Set(v.map(x => JSON.stringify(x))).size !== v.length) fail(`Duplicate array item at ${p}`);
      v.forEach((x, i) => check(x, s.items!, `${p}[${i}]`));
    }
    if (s.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail(`Expected plain object at ${p}`);
      const obj = v as Record<string, unknown>;
      for (const k of s.required ?? []) if (!Object.hasOwn(obj, k) || obj[k] === undefined) fail(`Missing ${p}.${k}`);
      for (const [k, x] of Object.entries(obj)) {
        if (['__proto__', 'constructor', 'prototype'].includes(k)) fail(`Forbidden key ${p}.${k}`);
        if (s.properties && Object.hasOwn(s.properties, k)) {
          // In-memory TypeScript optional undefined is equivalent to an omitted JSON key.
          if (x !== undefined) check(x, s.properties[k]!, `${p}.${k}`);
        }
        else if (s.additionalProperties === false) fail(`Unknown field ${p}.${k}`);
        else if (typeof s.additionalProperties === 'object') check(x, s.additionalProperties, `${p}.${k}`);
      }
    }
  }
  check(value, defs[name] ?? fail(`Unknown schema ${name}`), name);
}
export function validateMetadata(value: unknown): ModelMetadata {
  validateShape(value, 'ModelMetadata');
  const m = value as ModelMetadata;
  if (m.limits?.contextWindow != null && m.limits.maxOutputTokens != null && m.limits.maxOutputTokens > m.limits.contextWindow) fail('maxOutputTokens exceeds contextWindow');
  const r = m.reasoning;
  if (r?.levels?.some(x => ['none','off','disabled'].includes(x))) fail('Reasoning disable is not a level');
  if (r?.defaultLevel != null && Array.isArray(r.levels) && !r.levels.includes(r.defaultLevel)) fail('defaultLevel is not in levels');
  if (r?.supported === false && ((r.levels?.length ?? 0) > 0 || r.defaultLevel != null || (r.mode != null && r.mode !== 'unknown'))) fail('Unsupported reasoning has active settings');
  return JSON.parse(JSON.stringify(m)) as ModelMetadata;
}
export const leafPaths = new Set([
  'limits.contextWindow','limits.maxOutputTokens','modalities.input','modalities.output','nativeSearch.supported',
  'reasoning.supported','reasoning.mode','reasoning.levels','reasoning.canDisable','reasoning.defaultLevel',
  'referencePricing.currency','referencePricing.unit','referencePricing.input','referencePricing.output','referencePricing.cacheRead','referencePricing.cacheWrite',
  'referencePricing.longContext.thresholdTokens','referencePricing.longContext.basis','referencePricing.longContext.mode','referencePricing.longContext.input','referencePricing.longContext.output','referencePricing.longContext.cacheRead','referencePricing.longContext.cacheWrite',
]);
export function validField(path: string): boolean { return leafPaths.has(path) || [...leafPaths].some(p => p.startsWith(`${path}.`)); }
export function validateCatalog(value: unknown): CatalogDocument {
  validateShape(value, 'CatalogDocument');
  const c = value as CatalogDocument;
  const modelIds = new Set<string>();
  const variantIds = new Set<string>();
  const matches = new Map<string, string>();
  for (const [entries, ids] of [[c.models, modelIds], [c.variants, variantIds]] as const) {
    for (const entry of entries) {
      if (ids.has(entry.id)) fail(`Duplicate id ${entry.id}`);
      ids.add(entry.id);
      validateMetadata(entry.metadata);
      for (const path of entry.matches?.fields ?? []) if (!validField(path)) fail(`Invalid match field ${path}`);
      for (const source of entry.sources ?? []) for (const path of source.fields ?? []) if (!validField(path)) fail(`Invalid source field ${path}`);
      if (entry.status === 'verified' && !entry.sources?.some(s => s.url && s.verifiedAt)) fail(`Verified entry lacks verified source: ${entry.id}`);
      const scope = 'providerKey' in entry ? entry.providerKey : '';
      const exact = [entry.id, ...('upstreamModelIds' in entry ? entry.upstreamModelIds : []), ...(entry.matches?.ids ?? [])];
      for (const [kind, keys] of [['exact', exact], ['alias', entry.matches?.aliases ?? []], ['prefix', entry.matches?.prefixes ?? []]] as const) {
        for (const key of keys) {
          const token = JSON.stringify([scope, kind, key]);
          const previous = matches.get(token);
          if (previous && previous !== entry.id) fail(`Ambiguous ${kind} ${key} in scope ${scope}`);
          matches.set(token, entry.id);
        }
      }
    }
  }
  for (const variant of c.variants) {
    if (!modelIds.has(variant.modelId)) fail(`Unknown model ${variant.modelId} for variant ${variant.id}`);
    const base = c.models.find(m => m.id === variant.modelId)!;
    const merged = JSON.parse(JSON.stringify(base.metadata)) as Record<string, unknown>;
    const overlay = (target: Record<string, unknown>, patch: Record<string, unknown>): void => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) overlay((target[key] ??= {}) as Record<string, unknown>, value as Record<string, unknown>);
        else target[key] = value;
      }
    };
    overlay(merged, variant.metadata as Record<string, unknown>);
    validateMetadata(merged);
  }
  return JSON.parse(JSON.stringify(c)) as CatalogDocument;
}
