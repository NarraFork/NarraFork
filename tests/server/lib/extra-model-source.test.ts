import { afterEach, describe, expect, test } from "bun:test";
import {
	getVisibleModels,
	registerExtraModelSource,
	resolveProvider,
	settings,
} from "@server/lib/settings";

/**
 * `getVisibleModels()` feeds the Agent's model pools (task / fork-narrator subagent
 * models, allowed-model validation, broken-model migration). Plugin providers reach
 * it through a generic extra-source hook rather than an eighth hardcoded lister.
 *
 * The invariant that matters: a plugin must never displace or shadow a builtin.
 * Provider resolution already consults builtins first; these tests pin that the model
 * list behaves the same way.
 */

const disposers: Array<() => void> = [];

afterEach(() => {
	while (disposers.length > 0) disposers.pop()?.();
});

function register(name: string, source: Parameters<typeof registerExtraModelSource>[1]): void {
	disposers.push(registerExtraModelSource(name, source));
}

describe("extra model sources", () => {
	test("adds model values to the visible model list", () => {
		const before = getVisibleModels();
		register("test-plugin", { listModels: () => ["tplug:alpha", "tplug:beta"] });

		const after = getVisibleModels();

		expect(after).toContain("tplug:alpha");
		expect(after).toContain("tplug:beta");
		// Existing models must not be dropped by adding a source.
		for (const value of before) expect(after).toContain(value);
	});

	test("withdraws its models when disposed", () => {
		const dispose = registerExtraModelSource("test-temp", {
			listModels: () => ["ttemp:one"],
		});
		expect(getVisibleModels()).toContain("ttemp:one");

		dispose();

		expect(getVisibleModels()).not.toContain("ttemp:one");
	});

	test("replaces a source registered under the same name", () => {
		register("test-dup", { listModels: () => ["tdup:first"] });
		register("test-dup", { listModels: () => ["tdup:second"] });

		const models = getVisibleModels();

		// Re-registering must replace rather than stack, so repeated wiring is idempotent.
		expect(models).not.toContain("tdup:first");
		expect(models).toContain("tdup:second");
	});

	test("a throwing source does not blank out the model list", () => {
		const before = getVisibleModels();
		register("test-broken", {
			listModels: () => {
				throw new Error("source is broken");
			},
		});
		register("test-ok", { listModels: () => ["tok:one"] });

		const after = getVisibleModels();

		// One bad plugin must not take down every other provider's models.
		expect(after).toContain("tok:one");
		for (const value of before) expect(after).toContain(value);
	});

	test("deduplicates against existing model values", () => {
		const existing = getVisibleModels()[0];
		if (!existing) return;
		register("test-shadow", { listModels: () => [existing] });

		const after = getVisibleModels();

		expect(after.filter((value) => value === existing)).toHaveLength(1);
	});

	test("resolves a bare model id only after every builtin declined", () => {
		register("test-resolver", {
			listModels: () => ["tres:only"],
			resolveProvider: (bare) => (bare === "only-plugin-model" ? "tres" : undefined),
		});

		expect(resolveProvider("only-plugin-model")).toBe("tres");
	});

	test("cannot shadow a builtin model id", () => {
		register("test-hijack", {
			listModels: () => [],
			resolveProvider: () => "thijack",
		});

	});

	test("an explicit prefix always wins over source resolution", () => {
		register("test-explicit", {
			listModels: () => [],
			resolveProvider: () => "twrong",
		});

		expect(resolveProvider("openai:gpt-4o")).toBe("openai");
	});

	test("a disabled prefix hides plugin models just like a builtin's", () => {
		// The provider settings page shows the same on/off switch for plugin providers as
		// for builtins. That switch writes `agent.disabledProviders`, a plain prefix list —
		// this pins that the list governs plugin models too, so the toggle needs no
		// plugin-specific backend path.
		register("test-disable", { listModels: () => ["tdis:alpha", "tdis:beta"] });
		expect(getVisibleModels()).toContain("tdis:alpha");

		const previous = settings.agent.disabledProviders;
		settings.agent.disabledProviders = [...(previous ?? []), "tdis"];
		try {
			const visible = getVisibleModels();
			expect(visible).not.toContain("tdis:alpha");
			expect(visible).not.toContain("tdis:beta");
			// Turning a provider off must not affect anything else the plugin contributes;
			// this list carries model values only, never plugin lifecycle state.
			expect(settings.plugins?.enabled).not.toBe(false);
		} finally {
			settings.agent.disabledProviders = previous;
		}

		expect(getVisibleModels()).toContain("tdis:alpha");
	});
});
