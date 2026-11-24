import { afterEach, describe, expect, test } from "bun:test";
import type { SourceProtocol } from "@shared/sourcing/identify";
import { readTemplateModelList, registerModelListReader } from "./model-list-readers";
import { type SourceGroupView, sourceGroupForConnection } from "./source-groups";
import { getServiceTemplate, listCachedTemplateModels, listServiceTemplates } from "./templates";

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
	test("every frozen template has a model-list method", () => {
		for (const template of listServiceTemplates()) {
			expect(Object.isFrozen(template)).toBe(true);
			expect(typeof template.listModels).toBe("function");
		}
	});

	test("a frozen known-service template reads late registration and the actual protocol", async () => {
		const template = getServiceTemplate("kimi-code");
		reader("completions-compatible", (group) => [`${group.id}-openai`]);
		reader("anthropic-messages", (group) => [`${group.id}-anthropic`]);
		expect(await template.listModels(connection("first"))).toEqual(["first-openai"]);
		expect(await template.listModels(connection("second", "anthropic-messages"))).toEqual([
			"second-anthropic",
		]);
		reader("completions-compatible", () => ["replacement"]);
		expect(await template.listModels(connection("first"))).toEqual(["replacement"]);
	});

	test("old disposal cannot remove a replacement, and callers cannot mutate the cached list", () => {
		const old = reader("completions-compatible", () => ["old"]);
		const cached = ["new"];
		const latest = reader("completions-compatible", () => cached);
		old();
		const returned = readTemplateModelList(connection("one"));
		expect(returned).toEqual(["new"]);
		returned.push("not-in-cache");
		expect(cached).toEqual(["new"]);
		latest();
		expect(readTemplateModelList(connection("one"))).toEqual([]);
	});

	test("management lists keep disabled connections, metadata, duplicates and source order", async () => {
		const config = {
			id: "off",
			name: "Disabled connection",
			prefix: "off",
			baseUrl: "https://api.anthropic.com/v1",
			disabled: true,
		};
		const group = sourceGroupForConnection(config, "anthropic-messages");
		const models = [
			{ id: "second", display_name: "Second", contextWindow: 123_456 },
			{ id: "first", display_name: "First", extra: { supported: true } },
			{ id: "first", display_name: "Duplicate id, distinct metadata" },
		];
		reader("anthropic-messages", (current) =>
			current.id === "off" ? models.map((model) => model.id) : [],
		);
		const result = await listCachedTemplateModels(group, models);
		expect(group.disabled).toBe(true);
		expect(result).toEqual(models);
		expect(result[0]).toBe(models[0]);
		expect(
			await getServiceTemplate(group.templateId).listModels({ ...group, id: "unknown" }),
		).toEqual([]);
	});

	test("cancellation stops before reading a catalog", async () => {
		let reads = 0;
		reader("completions-compatible", () => {
			reads++;
			return ["model"];
		});
		await expect(
			getServiceTemplate("kimi-code").listModels(connection("one"), undefined, AbortSignal.abort()),
		).rejects.toThrow();
		expect(reads).toBe(0);
	});

	test("special template readers do not fall back to a protocol catalog", async () => {
		reader("completions-compatible", () => ["wrong-protocol"]);
		for (const templateId of ["codex", "tokendance", "command-code", "nug", "plugin"] as const) {
			reader(templateId, (group) => [`${group.id}-cached`]);
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
				`${templateId}-cached`,
			]);
		}
	});
});
