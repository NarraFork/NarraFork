/**
 * `POST /api/narrators/:id/optimize-prompt`.
 *
 * The contract under test is what reaches the *composer*: the optimized prompt
 * intact, never a raw schema envelope. Only text fallback unwraps packaging.
 * The model boundary is
 * stubbed at `summaryGenerate`, which is the single seam between this route and
 * the provider stack, so these tests drive the real route, schema handling and
 * fallback cleaning while fixing only the model's reply.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-optimize-prompt-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

/**
 * Model replies queued by each test. The stub drains this queue so a single test
 * can observe exactly one call, and a stray extra call fails loudly.
 */
type Reply = {
	text?: string;
	structured?: unknown;
	responseFormatDegraded?: string;
	outputTruncated?: boolean;
	reasoningSummary?: string;
};
type ExtraOptions = { responseFormat?: unknown; onGenerationProgress?: () => void | Promise<void> };
const replies: Reply[] = [];
const calls: Array<{ text: string; extraOptions?: ExtraOptions }> = [];

const realAgent = { ...(await import("../../lib/agent")) };
mock.module("../../lib/agent", () => ({
	...realAgent,
	summaryGenerate: async (
		text: string,
		_systemInstruction?: string,
		_tracking?: unknown,
		_signal?: unknown,
		_onTextDelta?: unknown,
		_model?: string,
		_maxOutputTokens?: number,
		_reportErrors?: boolean,
		_onReasoningDelta?: unknown,
		_onRetryProgress?: unknown,
		_onRetryScheduled?: unknown,
		extraOptions?: ExtraOptions,
	) => {
		calls.push({ text, extraOptions });
		const next = replies.shift();
		if (!next) throw new Error("unexpected summaryGenerate call");
		return { text: "", ...next };
	},
}));

const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { narrators, users } = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { saveSettings, settings } = await import("../../lib/settings");

afterAll(() => {
	mock.module("../../lib/agent", () => realAgent);
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	// Windows keeps the sqlite file handle open past the last query, so the temp
	// instance directory cannot always be removed. Leaking a temp dir is
	// harmless; failing the suite over it is not.
	try {
		rmSync(testHome, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

const OWNER = "optimize-owner";
let narratorId = "";

function app() {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: OWNER, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.route("/narrators", narratorRoutes);
	return instance;
}

/** Optimize a draft, returning the whole response body. */
async function optimizeRaw(text: string) {
	const response = await app().request(`http://localhost/narrators/${narratorId}/optimize-prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text, style: "clarify" }),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as { text: string; model: string; reasoningSummary?: string };
}

/** Optimize a draft, returning the text the composer would receive. */
async function optimize(text: string) {
	return (await optimizeRaw(text)).text;
}

/**
 * The route resolves a concrete model before it ever reaches the model seam, so
 * a fresh instance needs a configured default. Re-applied before every test
 * because the settings store is reloaded from disk asynchronously and would
 * otherwise fall back to an unconfigured state mid-suite.
 *
 * The provider is never contacted — the stub replaces the whole generate path.
 */
function configureModel(): void {
	saveSettings({
		...settings,
		customApiProviders: [
			{
				id: "optimize-test",
				name: "Optimize Test",
				prefix: "optimizetest",
				protocol: "completions-compatible",
				apiKey: "test-key",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "demo",
			},
		],
		agent: {
			...settings.agent,
			defaultModel: "optimizetest:demo",
			promptOptimizeModel: "optimizetest:demo",
		},
	});
}

beforeAll(async () => {
	const now = new Date().toISOString();
	await db.insert(users).values({
		id: OWNER,
		username: OWNER,
		passwordHash: "unused",
		createdAt: now,
	});
	narratorId = generateId();
	await db.insert(narrators).values({
		id: narratorId,
		title: "optimize session",
		ownerUserId: OWNER,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
});

beforeEach(() => {
	configureModel();
	replies.length = 0;
	calls.length = 0;
});

afterEach(() => {
	// A test that leaves a reply behind meant the route never asked the model.
	expect(replies).toHaveLength(0);
});

describe("structured output", () => {
	test("returns optimizedPrompt from the schema payload", async () => {
		replies.push({
			text: "",
			structured: { optimizedPrompt: "写一个登录页面，包含邮箱与密码字段。" },
		});
		expect(await optimize("写个登录页")).toBe("写一个登录页面，包含邮箱与密码字段。");
	});

	test.each([
		"要求：\n实现安全查询。\n```sql\nSELECT 1\n```\n最后添加单元测试。",
		"```typescript\nconst example = '<think>保留此示例</think>';\n```",
		"<thinking>这是待解析的字面示例</thinking>\n保留整个输入，包括 <think>未闭合标签。",
		"Optimized prompt:\n此行是正文中指定的标签。",
		'"这一对引号也是正文内容。"',
	])("preserves structured prompt content verbatim: %s", async (optimizedPrompt) => {
		replies.push({ text: JSON.stringify({ optimizedPrompt }), structured: { optimizedPrompt } });
		expect(await optimize("写个登录页")).toBe(optimizedPrompt);
	});

	test("a schema payload wins over unrelated text", async () => {
		// The prose here is what a model would emit alongside structure; the
		// whitelisted field is the only thing that may reach the composer.
		replies.push({
			text: "Sure! I improved your prompt a lot.",
			structured: { optimizedPrompt: "写一个登录页面。" },
		});
		expect(await optimize("写个登录页")).toBe("写一个登录页面。");
	});

	test("extra schema fields are dropped", async () => {
		replies.push({
			text: "",
			structured: {
				optimizedPrompt: "写一个登录页面。",
				reasoning: "the user likely wants validation",
				thinking: "private chain of thought",
			},
		});
		expect(await optimize("写个登录页")).toBe("写一个登录页面。");
	});

	test("requests a JSON-Schema responseFormat", async () => {
		replies.push({ text: "", structured: { optimizedPrompt: "写一个登录页面。" } });
		await optimize("写个登录页");
		const format = calls[0]?.extraOptions?.responseFormat as
			| { type: string; name: string; schema: Record<string, unknown> }
			| undefined;
		expect(format?.type).toBe("json_schema");
		expect(format?.name).toBe("prompt_optimize_result");
		expect(format?.schema.additionalProperties).toBe(false);
		expect(format?.schema.required).toEqual(["optimizedPrompt", "reasoningSummary"]);
		expect(calls[0]?.extraOptions?.onGenerationProgress).toBeFunction();
	});

	test("the draft is still sent inside the prompt tags", async () => {
		replies.push({ text: "", structured: { optimizedPrompt: "写一个登录页面。" } });
		await optimize("写个登录页");
		expect(calls[0]?.text).toContain("<prompt>");
		expect(calls[0]?.text).toContain("写个登录页");
	});
});

describe("text fallback", () => {
	test("reports degradation and cleans a leaky reasoning reply", async () => {
		// A relay that inlines thinking into content instead of a reasoning
		// channel: the reason is reported and the text path cleans it.
		replies.push({
			text: "<thinking>用户想要一个登录页，我应该补充校验。</thinking>\n写一个登录页面，包含表单校验。",
			responseFormatDegraded: "OpenAI returned output that is not a JSON object",
		});
		expect(await optimize("写个登录页")).toBe("写一个登录页面，包含表单校验。");
	});

	test("strips a known preamble without guessing at trailing content", async () => {
		replies.push({
			text: "Here is the optimized prompt:\n\n写一个登录页面，包含表单校验。\n\nLet me know if you want changes.",
			responseFormatDegraded: "relay rejected response_format",
		});
		// The preamble goes; the trailing sentence stays because cleaning only
		// touches the leading and wrapping layers, never the payload body.
		expect(await optimize("写个登录页")).toBe(
			"写一个登录页面，包含表单校验。\n\nLet me know if you want changes.",
		);
	});

	test("unwraps a fenced reply", async () => {
		replies.push({
			text: "```markdown\n写一个登录页面，包含表单校验。\n```",
			responseFormatDegraded: "relay rejected response_format",
		});
		expect(await optimize("写个登录页")).toBe("写一个登录页面，包含表单校验。");
	});

	test("falls back to the draft when cleaning leaves nothing", async () => {
		replies.push({
			text: "<thinking>no usable output</thinking>",
			responseFormatDegraded: "relay rejected response_format",
		});
		expect(await optimize("写个登录页")).toBe("写个登录页");
	});

	test("falls back to the draft for an empty reply", async () => {
		replies.push({ text: "", responseFormatDegraded: "model returned nothing" });
		expect(await optimize("写个登录页")).toBe("写个登录页");
	});

	test("preserves prose requirements surrounding code and literal thinking tags", async () => {
		const reply =
			"要求：\n实现安全查询，识别 <think>示例</think>。\n```sql\nSELECT 1\n```\n最后添加单元测试。";
		replies.push({ text: reply, responseFormatDegraded: "relay rejected response_format" });
		expect(await optimize("写个登录页")).toBe(reply);
	});
});

describe("invalid or incomplete schema output", () => {
	test.each([
		{},
		{ optimizedPrompt: "   ", reasoningSummary: "没有可用正文。" },
		{ optimizedPrompt: 42, reasoningSummary: "字段类型错误。" },
	])("keeps the draft instead of the real raw JSON for invalid structure: %j", async (payload) => {
		replies.push({
			text: JSON.stringify(payload),
			structured: payload,
			reasoningSummary: "此摘要也不应展示。",
		});
		const body = await optimizeRaw("写个登录页");
		expect(body.text).toBe("写个登录页");
		expect(body.reasoningSummary).toBeUndefined();
	});

	test("does not reinterpret invalid structured output as plaintext", async () => {
		replies.push({ text: "不能验证这段输出。", structured: { optimizedPrompt: "   " } });
		expect(await optimize("写个登录页")).toBe("写个登录页");
	});

	test.each([
		'{"optimizedPrompt":"写一个登录页面，包含',
		'```json\n{"reasoningSummary":"补充校验。","optimizedPrompt":42}\n```',
	])("does not write an unparsed JSON envelope into the composer: %s", async (raw) => {
		replies.push({ text: raw, responseFormatDegraded: "not a usable schema response" });
		expect(await optimize("写个登录页")).toBe("写个登录页");
	});

	test("keeps the draft when truncation leaves an unclosed raw JSON envelope", async () => {
		replies.push({
			text: '{"optimizedPrompt":"写一个登录页面，包含',
			outputTruncated: true,
			reasoningSummary: "补充校验。",
		});
		const body = await optimizeRaw("写个登录页");
		expect(body.text).toBe("写个登录页");
		expect(body.reasoningSummary).toBeUndefined();
	});

	test("does not use even a parsed field when the generation was truncated", async () => {
		const payload = { optimizedPrompt: "部分改写。", reasoningSummary: "未完成。" };
		replies.push({ text: JSON.stringify(payload), structured: payload, outputTruncated: true });
		expect(await optimize("写个登录页")).toBe("写个登录页");
	});
});

describe("reasoningSummary passthrough", () => {
	test("returns the summary beside the text, never inside it", async () => {
		replies.push({
			text: "",
			structured: {
				optimizedPrompt: "写一个登录页面，包含邮箱与密码字段。",
				reasoningSummary: "补充了字段与校验要求。",
			},
		});
		const body = await optimizeRaw("写个登录页");
		expect(body.text).toBe("写一个登录页面，包含邮箱与密码字段。");
		expect(body.reasoningSummary).toBe("补充了字段与校验要求。");
		// The summary is presentation only: it must not be appended to the prompt.
		expect(body.text).not.toContain("补充了字段与校验要求。");
	});

	test("omits the field when the payload has no summary", async () => {
		replies.push({
			text: "",
			structured: { optimizedPrompt: "写一个登录页面。" },
		});
		const body = await optimizeRaw("写个登录页");
		expect(body.reasoningSummary).toBeUndefined();
	});

	test("omits the field when the summary is blank", async () => {
		replies.push({
			text: "",
			structured: { optimizedPrompt: "写一个登录页面。", reasoningSummary: "   " },
		});
		const body = await optimizeRaw("写个登录页");
		expect(body.reasoningSummary).toBeUndefined();
	});

	test("a degraded text response never fabricates a summary", async () => {
		// The text path cannot know a rationale, so the field must stay absent
		// even when the reply reads like an explanation.
		replies.push({
			text: "Optimized prompt:\n写一个登录页面。\n\nI clarified the fields.",
			responseFormatDegraded: "relay rejected response_format",
		});
		const body = await optimizeRaw("写个登录页");
		expect(body.reasoningSummary).toBeUndefined();
	});

	test("extra schema fields cannot smuggle a summary into the prompt", async () => {
		replies.push({
			text: "",
			structured: {
				optimizedPrompt: "写一个登录页面。",
				reasoningSummary: "补充校验。",
				reasoning: "private chain of thought",
			},
		});
		const body = await optimizeRaw("写个登录页");
		expect(body.text).toBe("写一个登录页面。");
		expect(body.reasoningSummary).toBe("补充校验。");
	});

	test("the summary field is named on the requested format", async () => {
		replies.push({ text: "", structured: { optimizedPrompt: "写一个登录页面。" } });
		await optimize("写个登录页");
		const format = calls[0]?.extraOptions?.responseFormat as
			| { schema: { required: string[]; properties: Record<string, unknown> } }
			| undefined;
		expect(format?.schema.required).toEqual(["optimizedPrompt", "reasoningSummary"]);
		expect(format?.schema.properties).toHaveProperty("reasoningSummary");
	});
});

describe("multi-segment drafts", () => {
	const draft =
		"<<<NF_seg_0>>>\n写个登录页\n<<<NF_seg_0_END>>>\n<<<NF_seg_1>>>\n加校验\n<<<NF_seg_1_END>>>";

	test("preserves markers in the text path", async () => {
		const reply =
			"<<<NF_seg_0>>>\n写一个登录页面\n<<<NF_seg_0_END>>>\n<<<NF_seg_1>>>\n补充表单校验\n<<<NF_seg_1_END>>>";
		replies.push({ text: reply, responseFormatDegraded: "relay rejected response_format" });
		expect(await optimize(draft)).toBe(reply);
	});

	test("preserves markers in the structured path", async () => {
		const optimized =
			"<<<NF_seg_0>>>\n写一个登录页面\n<<<NF_seg_0_END>>>\n<<<NF_seg_1>>>\n补充表单校验\n<<<NF_seg_1_END>>>";
		replies.push({ text: "", structured: { optimizedPrompt: optimized } });
		expect(await optimize(draft)).toBe(optimized);
	});

	test("asks the model to echo the markers", async () => {
		replies.push({ text: "", structured: { optimizedPrompt: draft } });
		await optimize(draft);
		// The marker instruction is appended to the system instruction, which the
		// stub records only indirectly; the echoed draft proves the draft carried
		// the markers through tagging.
		expect(calls[0]?.text).toContain("<<<NF_seg_0>>>");
	});
});

describe("schema path and fallback path agree", () => {
	test("the same content produces the same composer text either way", async () => {
		const optimized = "写一个登录页面，包含表单校验。";

		replies.push({ text: "", structured: { optimizedPrompt: optimized } });
		const structuredResult = await optimize("写个登录页");

		replies.push({
			text: `Optimized prompt:\n${optimized}`,
			responseFormatDegraded: "relay rejected response_format",
		});
		const fallbackResult = await optimize("写个登录页");

		expect(structuredResult).toBe(optimized);
		expect(fallbackResult).toBe(optimized);
	});
});
