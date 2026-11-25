import { createHash } from "node:crypto";
import { type AutoRouteSignals, orderAutoCandidates } from "@shared/auto-route-strategy";
import { identifyModel } from "@shared/model-catalog/resolve";
import type { RawCatalog, RawModel } from "@shared/model-catalog/schema/catalog";
import {
	type ModelOptionInput,
	type ModelOptionRow,
	type ModelOptionSourceCandidate,
	ModelOptionsError,
	type ModelOptionsPage,
	type ModelOptionsQuery,
	modelOptionPrice,
	OPTIONS_BUDGET,
} from "./model-options-contract";

interface IndexedRow extends ModelOptionRow {
	inputPrice?: number | null;
	outputPrice?: number | null;
	search: string;
	match?: string;
	aggregationMembers?: string[];
}
interface Generation {
	revision: string;
	rows: IndexedRow[];
	byValue: Map<string, IndexedRow>;
	codexConfigured: boolean;
	byModel: Map<string, Map<string, IndexedRow>>;
}
/** Only the current generation and one building generation; no per-user index/cache. */
export class ModelOptionsIndex {
	private current?: Generation;
	private building?: Generation;
	private count = 0;
	private bytes = 0;
	private hidden = new Set<string>();
	private excluded = new Set<string>();
	private seen = new Set<string>();
	private catalog?: RawCatalog;
	private catalogModels = new Map<string, RawModel>();
	begin(revision: string, catalog: RawCatalog, hidden: string[], excluded: string[]): void {
		this.discard();
		this.catalog = catalog;
		this.catalogModels = new Map(catalog.models.map((model) => [model.id, model]));
		this.building = {
			revision,
			rows: [],
			byValue: new Map(),
			codexConfigured: false,
			byModel: new Map(),
		};
		this.hidden = new Set(hidden);
		this.excluded = new Set(excluded);
		this.bytes = Buffer.byteLength(JSON.stringify([hidden, excluded]));
		if (this.bytes > OPTIONS_BUDGET.bytes)
			throw new ModelOptionsError(
				"MODEL_OPTIONS_INPUT_LIMIT",
				"Model options input exceeds budget",
			);
	}
	seedCodex(): void {
		if (!this.catalog || !this.building) throw new Error("No build in progress");
		this.building.codexConfigured = true;
		let batch: ModelOptionInput[] = [];
		for (const variant of this.catalog.variants) {
			if (variant.providerKey !== "codex" || variant.status === "deprecated") continue;
			const id = variant.modelId;
			batch.push({
				value: `codex:${id}`,
				label: variant.name ?? id,
				provider: "codex",
				upstreamModelId: id,
				providerKey: "codex",
			});
			if (batch.length === OPTIONS_BUDGET.batchRows) {
				this.append(batch);
				batch = [];
			}
		}
		if (batch.length) this.append(batch);
	}
	appendFilters(kind: "hidden" | "excluded", values: string[]): void {
		if (!this.building) throw new Error("No build in progress");
		const bytes = Buffer.byteLength(JSON.stringify(values));
		this.bytes += bytes;
		if (
			values.length > OPTIONS_BUDGET.batchRows ||
			bytes > OPTIONS_BUDGET.batchBytes ||
			this.bytes > OPTIONS_BUDGET.bytes
		)
			throw new ModelOptionsError(
				"MODEL_OPTIONS_INPUT_LIMIT",
				"Model options input exceeds budget",
			);
		const target = kind === "hidden" ? this.hidden : this.excluded;
		for (const value of values) target.add(value);
	}
	append(rows: ModelOptionInput[]): void {
		if (!this.building || !this.catalog) throw new Error("No build in progress");
		const bytes = Buffer.byteLength(JSON.stringify(rows));
		this.count += rows.length;
		this.bytes += bytes;
		if (
			rows.length > OPTIONS_BUDGET.batchRows ||
			bytes > OPTIONS_BUDGET.batchBytes ||
			this.count > OPTIONS_BUDGET.rows ||
			this.bytes > OPTIONS_BUDGET.bytes
		) {
			throw new ModelOptionsError(
				"MODEL_OPTIONS_INPUT_LIMIT",
				"Model options input exceeds budget",
			);
		}
		for (const input of rows) {
			if (
				input.aggregationMembers !== undefined &&
				(!input.value.startsWith("__agg__:") ||
					input.value.slice(8).length > 20 ||
					input.aggregationMembers.length > 20 ||
					input.aggregationMembers.some(
						(member) => typeof member !== "string" || !member || member.length > 1024,
					))
			)
				throw new ModelOptionsError(
					"MODEL_OPTIONS_INPUT_LIMIT",
					"Aggregation members exceed budget",
				);
			if (this.seen.has(input.value) || this.hidden.has(input.value)) continue;
			this.seen.add(input.value);
			const identity = identifyModel(this.catalog, {
				upstreamModelId: input.upstreamModelId,
				providerKey: input.providerKey,
			});
			const baseMetadata = identity.modelId
				? this.catalogModels.get(identity.modelId)?.metadata
				: undefined;
			const price = (field: "inputPrice" | "outputPrice", rawKey: string) => {
				if (input[field] !== undefined) return input[field];
				const metadata = identity.entry?.metadata;
				return modelOptionPrice(
					metadata && Object.hasOwn(metadata, rawKey) ? metadata[rawKey] : baseMetadata?.[rawKey],
					true,
				);
			};
			const row: IndexedRow = {
				inputPrice: price("inputPrice", "input_cost_per_token"),
				outputPrice: price("outputPrice", "output_cost_per_token"),
				value: input.value,
				label: input.label,
				provider: input.provider,
				...(input.aggregationMembers && {
					aggregationId: input.value.slice(8),
					memberCount: input.aggregationMembers.length,
					aggregationMembers: input.aggregationMembers,
				}),
				...(identity.modelId && { modelId: identity.modelId }),
				search: `${input.label}\n${input.value}\n${identity.modelId ?? ""}`.toLowerCase(),
				match: identity.matchedVia,
			};
			this.building.rows.push(row);
			this.building.byValue.set(row.value, row);
			if (
				!identity.modelId ||
				identity.weak ||
				!["exact", "alias"].includes(identity.matchedVia) ||
				input.auto === false ||
				this.excluded.has(input.provider)
			)
				continue;
			let providers = this.building.byModel.get(identity.modelId);
			if (!providers) {
				providers = new Map();
				this.building.byModel.set(identity.modelId, providers);
			}
			const previous = providers.get(input.provider);
			if (
				!previous ||
				(row.match === "exact" && previous.match !== "exact") ||
				(row.match === previous.match && row.value < previous.value)
			)
				providers.set(input.provider, row);
			if (providers.size > 256)
				throw new ModelOptionsError(
					"MODEL_OPTIONS_SOURCE_LIMIT",
					"Auto model has too many sources",
				);
		}
	}
	publish(): void {
		if (!this.building || !this.catalog) throw new Error("No build in progress");
		const models = this.catalogModels;
		for (const [modelId, providers] of this.building.byModel) {
			const value = `auto:${modelId}`;
			if (this.hidden.has(value)) continue;
			const label = models.get(modelId)?.name ?? modelId;
			const row = {
				value,
				label,
				modelId,
				sourceCount: providers.size,
				search: `${label}\n${value}`.toLowerCase(),
			};
			this.building.rows.push(row);
			this.building.byValue.set(value, row);
		}
		this.building.rows.sort(
			(a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value),
		);
		this.current = this.building;
		this.discard();
	}
	discard(): void {
		this.building = undefined;
		this.catalog = undefined;
		this.catalogModels.clear();
		this.seen.clear();
		this.hidden.clear();
		this.excluded.clear();
		this.count = 0;
		this.bytes = 0;
	}
	sourceCandidates(revision: string, modelId: string): ModelOptionSourceCandidate[] {
		if (this.current?.revision !== revision)
			throw new ModelOptionsError(
				"MODEL_OPTIONS_NOT_READY",
				"Model options generation is not ready",
			);
		const candidates = [...(this.current.byModel.get(modelId)?.values() ?? [])].map((row) => ({
			value: row.value,
			provider: row.provider ?? "",
			...(row.modelId !== undefined && { modelId: row.modelId }),
			...(row.inputPrice !== undefined && { inputPrice: row.inputPrice }),
			...(row.outputPrice !== undefined && { outputPrice: row.outputPrice }),
		}));
		if (
			candidates.length > 256 ||
			Buffer.byteLength(JSON.stringify(candidates)) > OPTIONS_BUDGET.batchBytes
		)
			throw new ModelOptionsError("MODEL_OPTIONS_SOURCE_LIMIT", "Auto sources exceed budget");
		return candidates;
	}
	query(revision: string, query: ModelOptionsQuery, facts?: AutoRouteSignals[]): ModelOptionsPage {
		const current = this.current;
		if (!current || current.revision !== revision)
			throw new ModelOptionsError(
				"MODEL_OPTIONS_NOT_READY",
				"Model options generation is not ready",
			);
		const binding = createHash("sha256")
			.update(
				JSON.stringify([
					revision,
					query.scope,
					query.q,
					query.sourceModelId ?? null,
					query.aggregationId ?? null,
					query.sourceModelId ? (facts ?? null) : null,
				]),
			)
			.digest("hex");
		let offset = 0;
		if (query.cursor) {
			try {
				const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
				if (cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
					throw new Error();
				offset = cursor.offset;
			} catch {
				throw new ModelOptionsError(
					"MODEL_OPTIONS_CURSOR_EXPIRED",
					"Model options cursor expired",
					409,
				);
			}
		}
		let rows = query.sourceModelId
			? [...(current.byModel.get(query.sourceModelId)?.values() ?? [])]
			: current.rows;
		if (query.aggregationId) {
			const group = current.byValue.get(`__agg__:${query.aggregationId}`);
			if (!group?.aggregationMembers)
				throw new ModelOptionsError(
					"MODEL_OPTIONS_AGGREGATION_MISSING",
					"Aggregation is no longer available",
					409,
				);
			// Only this configured <=20 member set is materialized, never the directory.
			rows = group.aggregationMembers.map((member) => {
				const known = current.byValue.get(member);
				const colon = member.indexOf(":");
				const provider = colon > 0 ? member.slice(0, colon) : undefined;
				const label = known?.label ?? member;
				return {
					value: `__agg__:${query.aggregationId}:${member}`,
					label,
					provider: known?.provider ?? provider,
					...(provider === "codex" && !current.codexConfigured && { available: false }),
					...(known?.modelId && { modelId: known.modelId }),
					search: `${label}\n${member}`.toLowerCase(),
				};
			});
		}
		if (query.sourceModelId && facts) {
			if (facts.length > 256)
				throw new ModelOptionsError("MODEL_OPTIONS_SOURCE_LIMIT", "Auto sources exceed budget");
			const byValue = new Map(rows.map((row) => [row.value, row]));
			const signals = new Map(facts.map((fact) => [fact.value, fact]));
			rows = orderAutoCandidates(facts).flatMap((value) => {
				const row = byValue.get(value);
				const signal = signals.get(value);
				return row && signal ? [{ ...row, ...signal }] : [];
			});
		}
		const terms = query.q.toLowerCase().trim().split(/\s+/).filter(Boolean);
		const items: ModelOptionRow[] = [];
		let matched = 0;
		let hasMore = false;
		for (const row of rows) {
			const auto = row.sourceCount !== undefined;
			if (
				!query.sourceModelId &&
				!query.aggregationId &&
				((query.scope === "auto" && !auto) || (query.scope === "concrete" && auto))
			)
				continue;
			if (!terms.every((term) => row.search.includes(term))) continue;
			if (matched++ < offset) continue;
			if (items.length === query.limit) {
				hasMore = true;
				break;
			}
			const {
				search: _search,
				aggregationMembers: _members,
				match: _match,
				inputPrice: _inputPrice,
				outputPrice: _outputPrice,
				...item
			} = row;
			items.push(item);
		}
		const nextCursor = hasMore
			? Buffer.from(JSON.stringify({ binding, offset: offset + items.length })).toString(
					"base64url",
				)
			: null;
		const page = { revision, items, nextCursor, hasMore };
		if (Buffer.byteLength(JSON.stringify(page)) > OPTIONS_BUDGET.pageBytes)
			throw new ModelOptionsError(
				"MODEL_OPTIONS_OUTPUT_LIMIT",
				"Model options page exceeds budget",
			);
		return page;
	}
}
