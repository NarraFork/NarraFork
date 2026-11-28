import { afterEach, describe, expect, test } from "bun:test";
import type { SourceProtocol } from "@shared/sourcing/identify";
import { readTemplateModelList, registerModelListReader } from "./model-list-readers";
import { type SourceGroupView, sourceGroupForConnection } from "./source-groups";
import { getServiceTemplate } from "./templates";

const disposers: Array<() => void> = [];
afterEach(() => {
	while (disposers.length) disposers.pop()?.();
});

function connection(id: string, protocol: SourceProtocol = "completions-compatible") {
	return sourceGroupForConnection(
		{ id, name: id, prefix: id, baseUrl: "https://api.kimi.com/coding/v1" },
		protocol,
	);
}

function reader(...args: Parameters<typeof registerModelListReader>) {
	const dispose = registerModelListReader(...args);
	disposers.push(dispose);
	return dispose;
}

describe("template model lists", () => {
	test("a known-service template reads its current protocol's complete catalog", async () => {
		const template = getServiceTemplate("kimi-code");
		const first = [{ id: "first-openai", contextWindow: 128_000 }];
		const second = [{ id: "second-anthropic", displayName: "Claude" }];
		reader("completions-compatible", (group) => (group.id === "first" ? first : []));
		reader("anthropic-messages", (group) => (group.id === "second" ? second : []));
		expect(await template.listModels(connection("first"))).toEqual(first);
		expect(await template.listModels(connection("second", "anthropic-messages"))).toEqual(second);
	});

	test("an old owner's disposer cannot remove its replacement", () => {
		const old = reader("completions-compatible", () => [{ id: "old" }]);
		const latest = reader("completions-compatible", () => [{ id: "new" }]);
		old();
		expect(readTemplateModelList(connection("one"))).toEqual([{ id: "new" }]);
		latest();
		expect(readTemplateModelList(connection("one"))).toEqual([]);
	});

	test("management catalogs preserve disabled connections, metadata, duplicates and order", async () => {
		const group = sourceGroupForConnection(
			{ id: "off", name: "Disabled", prefix: "off", disabled: true },
			"anthropic-messages",
		);
		const models = [
			{ id: "second", display_name: "Second", contextWindow: 123_456 },
			{ id: "first", display_name: "First", extra: { supported: true } },
			{ id: "first", display_name: "Duplicate id, distinct metadata" },
		];
		reader("anthropic-messages", (current) => (current.id === "off" ? models : []));
		expect(await getServiceTemplate(group.templateId).listModels(group)).toEqual(models);
		expect(
			await getServiceTemplate(group.templateId).listModels({ ...group, id: "unknown" }),
		).toEqual([]);
	});

	test("a cancelled listing does not read the catalog", async () => {
		let reads = 0;
		reader("completions-compatible", () => {
			reads++;
			return [{ id: "model" }];
		});
		await expect(
			getServiceTemplate("kimi-code").listModels(connection("one"), undefined, AbortSignal.abort()),
		).rejects.toThrow();
		expect(reads).toBe(0);
	});

	test("singleton and plugin templates read their own catalog, not a protocol's", async () => {
		reader("completions-compatible", () => [{ id: "wrong-protocol" }]);
		for (const templateId of ["codex", "tokendance", "command-code", "nug", "plugin"] as const) {
			reader(templateId, (group) => [{ id: `${group.id}-cached` }]);
			const group: SourceGroupView = {
				id: templateId,
				templateId,
				kind: getServiceTemplate(templateId).kind,
				prefix: templateId,
				name: templateId,
				disabled: false,
				endpoint: {},
			};
			expect(await getServiceTemplate(templateId).listModels(group)).toEqual([
				{ id: `${templateId}-cached` },
			]);
		}
	});
});
