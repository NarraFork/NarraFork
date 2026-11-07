import { describe, expect, test } from "bun:test";
import {
	type AutoCandidateInput,
	autoCandidates,
	autoModelValue,
	isAutoModelValue,
	parseAutoModelValue,
} from "./auto-model";

describe("auto model values", () => {
	test("parse and build", () => {
		expect(autoModelValue("gpt-5.5")).toBe("auto:gpt-5.5");
		expect(parseAutoModelValue("auto:gpt-5.5")).toBe("gpt-5.5");
		expect(parseAutoModelValue(" auto:claude-opus-4-6 ")).toBe("claude-opus-4-6");
		expect(parseAutoModelValue("auto:")).toBeNull();
		expect(parseAutoModelValue("codex:gpt-5.5")).toBeNull();
		expect(parseAutoModelValue("automatic:x")).toBeNull();
		expect(isAutoModelValue(undefined)).toBe(false);
	});
});

const input = (
	value: string,
	modelId: string | undefined,
	matchedVia: AutoCandidateInput["matchedVia"],
): AutoCandidateInput => ({
	value,
	provider: value.slice(0, value.indexOf(":")),
	...(modelId ? { modelId } : {}),
	matchedVia,
});

describe("auto candidates", () => {
	test("only strong matches of the same model, one per provider, in input order", () => {
		const result = autoCandidates("claude-opus-4-6", [
			input("nug:claude-opus-4.6", "claude-opus-4-6", "alias"),
			input("anthropic:claude-opus-4-6-20260101", "claude-opus-4-6", "suffix"),
			input("anthropic:claude-opus-4-6", "claude-opus-4-6", "exact"),
			input("relay:claude-opus-4-6-foo", "claude-opus-4-6", "prefix"),
			input("openai:gpt-5.5", "gpt-5.5", "exact"),
			input("private:qwen-7b", undefined, "none"),
		]);
		expect(result.map((c) => c.value)).toEqual([
			"nug:claude-opus-4.6",
			"anthropic:claude-opus-4-6",
		]);
	});

	test("an exact id beats an alias from the same provider, then the lowest id wins", () => {
		const viaAlias = autoCandidates("gpt-5.5", [
			input("p:gpt-5-5", "gpt-5.5", "alias"),
			input("p:gpt-5.5", "gpt-5.5", "exact"),
		]);
		expect(viaAlias.map((c) => c.value)).toEqual(["p:gpt-5.5"]);
		const tie = autoCandidates("gpt-5.5", [
			input("p:openai/gpt-5.5", "gpt-5.5", "alias"),
			input("p:gpt-5-5", "gpt-5.5", "alias"),
		]);
		expect(tie.map((c) => c.value)).toEqual(["p:gpt-5-5"]);
	});
});
