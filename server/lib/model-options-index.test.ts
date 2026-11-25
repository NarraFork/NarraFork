import { describe, expect, test } from "bun:test";
import type { RawCatalog } from "@shared/model-catalog/schema/catalog";
import {
	captureModelOptionsArray,
	type ModelOptionInput,
	ModelOptionsCacheMap,
	OPTIONS_BUDGET,
	parseModelOptionsQuery,
} from "./model-options-contract";
import { ModelOptionsIndex } from "./model-options-index";

const catalog: RawCatalog = {
	schemaVersion: 2,
	catalogVersion: "test",
	sourceVersion: "test",
	publishedAt: "2026-01-01",
	models: [{ id: "alpha", name: "Alpha", matches: { aliases: ["alias-alpha"] }, metadata: {} }],
	variants: [],
};
const input = (id: string, provider = "test", label = id): ModelOptionInput => ({
	value: `${provider}:${id}`,
	provider,
	upstreamModelId: id,
	label,
});
function build(rows: ModelOptionInput[], hidden: string[] = []) {
	const index = new ModelOptionsIndex();
	index.begin("r1", catalog, hidden, []);
	for (let offset = 0; offset < rows.length; offset += 32)
		index.append(rows.slice(offset, offset + 32));
	index.publish();
	return index;
}
const query = { q: "", scope: "all" as const, limit: 40 };

describe("bounded model options index", () => {
	test("ten thousand models paginate after search/scope filtering; never full cards", () => {
		const rows = Array.from({ length: 10_000 }, (_, i) =>
			input(`model-${String(i).padStart(5, "0")}`),
		);
		const index = build(rows);
		const first = index.query("r1", { ...query, q: "model-099", limit: 40 });
		expect(first.items).toHaveLength(40);
		expect(first.hasMore).toBe(true);
		expect(first.items.every((row) => row.value.includes("model-099"))).toBe(true);
		const next = index.query("r1", {
			...query,
			q: "model-099",
			cursor: first.nextCursor ?? undefined,
			limit: 100,
		});
		expect(next.items).toHaveLength(60);
		expect(next.hasMore).toBe(false);
		expect(new Set([...first.items, ...next.items].map((row) => row.value)).size).toBe(100);
		expect(Object.keys(first.items[0] ?? {}).sort()).toEqual(["label", "provider", "value"]);
		expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(64 * 1024);
	});
	test("identity index chooses exact over alias, deduplicates each provider, gives only sourceCount", () => {
		const index = build([
			input("alias-alpha", "b"),
			input("alpha", "b"),
			input("alpha", "a"),
			input("alpha", "a"),
		]);
		const page = index.query("r1", { ...query, scope: "auto" });
		expect(page.items).toEqual([
			{ value: "auto:alpha", label: "Alpha", modelId: "alpha", sourceCount: 2 },
		]);
		expect(index.sourceCandidates("r1", "alpha")).toEqual([
			{ value: "b:alpha", provider: "b", modelId: "alpha" },
			{ value: "a:alpha", provider: "a", modelId: "alpha" },
		]);
		const source = index.query("r1", { ...query, sourceModelId: "alpha", limit: 1 }, [
			{ value: "b:alpha", available: false, subscription: true },
			{ value: "a:alpha", available: true, subscription: false },
		]);
		expect(source.items[0]?.value).toBe("a:alpha");
		expect(source.hasMore).toBe(true);
	});
	test("aggregation members load only on expansion, preserve pins and bind their cursor", () => {
		const index = build([
			input("a", "p", "Member A"),
			input("b", "p", "Member B"),
			{
				value: "__agg__:group",
				label: "Group",
				provider: "__agg__",
				upstreamModelId: "group",
				auto: false,
				aggregationMembers: ["p:a", "p:b"],
			},
			{
				value: "__agg__:other",
				label: "Other",
				provider: "__agg__",
				upstreamModelId: "other",
				auto: false,
				aggregationMembers: ["p:b"],
			},
		]);
		const group = index.query("r1", query).items.find((row) => row.value === "__agg__:group");
		expect(group).toEqual({
			value: "__agg__:group",
			label: "Group",
			provider: "__agg__",
			aggregationId: "group",
			memberCount: 2,
		});
		expect(JSON.stringify(group)).not.toContain("p:a");
		const first = index.query("r1", { ...query, aggregationId: "group", limit: 1 });
		expect(first.items).toEqual([
			{ value: "__agg__:group:p:a", concreteValue: "p:a", label: "Member A", provider: "p" },
		]);
		expect(first.hasMore).toBe(true);
		const next = index.query("r1", {
			...query,
			aggregationId: "group",
			cursor: first.nextCursor ?? undefined,
		});
		expect(next.items[0]?.value).toBe("__agg__:group:p:b");
		expect(next.hasMore).toBe(false);
		expect(index.query("r1", { ...query, aggregationId: "group", q: "p:b" }).items[0]?.value).toBe(
			"__agg__:group:p:b",
		);
		for (const changed of [{ aggregationId: "other" }, { sourceModelId: "alpha" }, {}])
			expect(() =>
				index.query("r1", { ...query, ...changed, cursor: first.nextCursor ?? undefined }),
			).toThrow("cursor expired");
		expect(() => index.query("r1", { ...query, aggregationId: "deleted" })).toThrow(
			"no longer available",
		);
		expect(parseModelOptionsQuery({ aggregationId: "group" }).aggregationId).toBe("group");
		for (const invalid of [
			{ aggregationId: "a".repeat(21) },
			{ aggregationId: " " },
			{ aggregationId: "group", sourceModelId: "alpha" },
		])
			expect(() => parseModelOptionsQuery(invalid)).toThrow("Invalid model options query");
		expect(() =>
			build([
				{
					value: "__agg__:large",
					label: "Large",
					provider: "__agg__",
					upstreamModelId: "large",
					aggregationMembers: Array(21).fill("p:a"),
				},
			]),
		).toThrow("members exceed budget");
	});

	test("hidden and scope filters apply before pagination", () => {
		const index = build([input("alpha"), input("hidden")], ["test:hidden"]);
		expect(index.query("r1", { ...query, scope: "concrete", limit: 1 }).items[0]?.value).toBe(
			"test:alpha",
		);
		expect(index.query("r1", { ...query, q: "hidden" }).items).toEqual([]);
	});
	test("cursor binds generation, search, scope and source", () => {
		const index = build([input("a"), input("b")]);
		const first = index.query("r1", { ...query, limit: 1 });
		for (const changed of [{ q: "b" }, { scope: "auto" as const }, { sourceModelId: "alpha" }])
			expect(() =>
				index.query("r1", { ...query, ...changed, cursor: first.nextCursor ?? undefined }),
			).toThrow("cursor expired");
		index.begin("r2", catalog, [], []);
		index.append([input("c")]);
		index.publish();
		expect(() => index.query("r2", { ...query, cursor: first.nextCursor ?? undefined })).toThrow(
			"cursor expired",
		);
	});
	test("in-progress/discarded next generation does not overwrite current", () => {
		const index = build([input("a")]);
		index.begin("r2", catalog, [], []);
		index.append([input("b")]);
		index.discard();
		expect(index.query("r1", query).items[0]?.value).toBe("test:a");
		expect(() => index.query("r2", query)).toThrow("not ready");
	});
	test("input row/batch bytes/output/source budgets fail, never truncate success", () => {
		const index = new ModelOptionsIndex();
		index.begin("r", catalog, [], []);
		expect(() => index.append(Array.from({ length: 129 }, () => input("a")))).toThrow(
			"exceeds budget",
		);
		index.begin("r", catalog, [], []);
		expect(() => index.append([input("a", "test", "x".repeat(OPTIONS_BUDGET.batchBytes))])).toThrow(
			"exceeds budget",
		);
		const output = build(
			Array.from({ length: 100 }, (_, i) => input(`m${i}`, "test", "x".repeat(1000))),
		);
		expect(() => output.query("r1", { ...query, limit: 100 })).toThrow("page exceeds budget");
		expect(() => build(Array.from({ length: 257 }, (_, i) => input("alpha", `p${i}`)))).toThrow(
			"too many sources",
		);
	});
	test("query limits reject rather than clamp", () => {
		expect(parseModelOptionsQuery({})).toEqual(query);
		for (const invalid of [
			{ q: "x".repeat(101) },
			{ cursor: "x".repeat(2049) },
			{ limit: "101" },
			{ limit: "0" },
			{ scope: "bad" },
			{ sourceModelId: "" },
		])
			expect(() => parseModelOptionsQuery(invalid)).toThrow("Invalid model options query");
	});
	test("capture pins owner array, slices before projection, publication advances generation", () => {
		const map = new ModelOptionsCacheMap<string, string[]>();
		const rows = ["a", "b", "c"];
		map.set("p", rows);
		let projected = 0;
		const capture = captureModelOptionsArray(
			map.get("p"),
			(row) => {
				projected++;
				return input(row);
			},
			map.generation,
		);
		map.set("p", ["new"]);
		expect(capture.readSlice(1, 1).map((row) => row.value)).toEqual(["test:b"]);
		expect(projected).toBe(1);
		expect(map.generation).toBeGreaterThan(capture.generation);
		const revision = map.generation;
		map.set("p", map.get("p") ?? []);
		expect(map.generation).toBeGreaterThan(revision);
		expect(() => capture.readSlice(0, 129)).toThrow("Invalid capture slice");
	});
});
