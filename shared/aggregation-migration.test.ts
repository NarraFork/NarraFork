import { describe, expect, test } from "bun:test";
import {
	type AggregationForMigration,
	type MemberIdentity,
	migrateAggregationValue,
} from "./aggregation-migration";

const aggregations = new Map<string, AggregationForMigration>([
	["same", { id: "same", models: ["a:claude-opus-4-6", "b:claude-opus-4.6"] }],
	["mixed", { id: "mixed", models: ["a:claude-opus-4-6", "b:gpt-5.5"] }],
	["outside", { id: "outside", models: ["a:claude-opus-4-6", "relay:private-x"] }],
	["firstOff", { id: "firstOff", models: ["off:gpt-5.5", "b:deepseek-v4-pro"] }],
	["empty", { id: "empty", models: [] }],
]);
const identities: Record<string, MemberIdentity> = {
	"a:claude-opus-4-6": { strongModelId: "claude-opus-4-6" },
	"b:claude-opus-4.6": { strongModelId: "claude-opus-4-6" },
	"b:gpt-5.5": { strongModelId: "gpt-5.5" },
	"relay:private-x": {},
	"off:gpt-5.5": { strongModelId: "gpt-5.5", disabled: true },
	"b:deepseek-v4-pro": { strongModelId: "deepseek-v4-pro" },
};
const migrate = (value: string) =>
	migrateAggregationValue(value, aggregations, (member) => identities[member] ?? {});

describe("aggregation migration", () => {
	test("plain values are left alone", () => {
		expect(migrate("codex:gpt-5.5")).toEqual({ kind: "unchanged" });
		expect(migrate("auto:gpt-5.5")).toEqual({ kind: "unchanged" });
		expect(migrate("__default__")).toEqual({ kind: "unchanged" });
	});

	test("a pinned member is the member, even of a deleted aggregation", () => {
		expect(migrate("__agg__:mixed:b:gpt-5.5")).toEqual({ kind: "pinned", value: "b:gpt-5.5" });
		expect(migrate("__agg__:gone:nug:anthropic:claude")).toEqual({
			kind: "pinned",
			value: "nug:anthropic:claude",
		});
	});

	test("members of one catalog model become auto", () => {
		expect(migrate("__agg__:same")).toEqual({ kind: "auto", value: "auto:claude-opus-4-6" });
	});

	test("mixed or catalog-less members become the first enabled member", () => {
		expect(migrate("__agg__:mixed")).toEqual({ kind: "first-member", value: "a:claude-opus-4-6" });
		expect(migrate("__agg__:outside")).toEqual({
			kind: "first-member",
			value: "a:claude-opus-4-6",
		});
		expect(migrate("__agg__:firstOff")).toEqual({
			kind: "first-member",
			value: "b:deepseek-v4-pro",
		});
	});

	test("a deleted or empty aggregation is reported, not guessed", () => {
		expect(migrate("__agg__:gone")).toEqual({ kind: "missing", aggregationId: "gone" });
		expect(migrate("__agg__:empty")).toEqual({ kind: "missing", aggregationId: "empty" });
	});
});
