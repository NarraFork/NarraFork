import { describe, expect, test } from "bun:test";
import { SERVICE_TEMPLATE_IDS } from "@shared/sourcing/identify";
import { getServiceTemplate, listServiceTemplates } from "./templates";

describe("service templates", () => {
	test("one template per id", () => {
		expect(listServiceTemplates().map((template) => template.id)).toEqual([
			...SERVICE_TEMPLATE_IDS,
		]);
		for (const id of SERVICE_TEMPLATE_IDS) expect(getServiceTemplate(id).id).toBe(id);
	});

	test("subscription matches what auto routing treats as a plan today", () => {
		const subscribed = listServiceTemplates()
			.filter((template) => template.subscription)
			.map((template) => template.id);
		expect(subscribed).toEqual(["codex", "kimi-code", "opencode-go"]);
	});

	test("only sources that already pool several credentials are multi-credential", () => {
		const single = listServiceTemplates()
			.filter((template) => !template.multiCredential)
			.map((template) => template.id);
		expect(single).toEqual(["tokendance", "command-code", "nug", "plugin"]);
	});

	test("API templates have no official endpoints; Kimi Code has one per region", () => {
		for (const template of listServiceTemplates()) {
			if (template.kind === "api") {
				expect(template.endpoints).toBeUndefined();
				expect(template.regions).toBeUndefined();
			}
		}
		expect(getServiceTemplate("kimi-code").regions).toEqual({
			china: {
				"anthropic-messages": "https://api.kimi.com/coding/v1",
				"completions-compatible": "https://api.kimi.com/coding/v1",
				"openai-responses": "https://api.kimi.com/coding/v1",
			},
			international: {
				"anthropic-messages": "https://api.kimi.ai/coding/v1",
				"completions-compatible": "https://api.kimi.ai/coding/v1",
				"openai-responses": "https://api.kimi.ai/coding/v1",
			},
		});
	});

	test("templates are frozen all the way down", () => {
		const kimi = getServiceTemplate("kimi-code");
		expect(Object.isFrozen(kimi)).toBe(true);
		expect(Object.isFrozen(kimi.authKinds)).toBe(true);
		expect(Object.isFrozen(kimi.defaults)).toBe(true);
		expect(Object.isFrozen(kimi.regions?.china)).toBe(true);
	});
});
