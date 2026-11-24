/**
 * The add-provider catalog, served by `GET /api/sourcing/templates`.
 *
 * Presets of known services take their endpoints from the service template, so each URL is
 * written once; the rest are compatible endpoints. Region / billing / cluster variants are
 * plain data: the frontend only picks the matching entry.
 */
import type {
	AddProviderType,
	PresetEndpoints,
	ProviderConnection,
	ProviderConnectionSelection,
	ProviderPreset,
	SourcingCatalog,
} from "@shared/sourcing/presets";
import { getServiceTemplate, listServiceTemplates, type ServiceTemplateId } from "./templates";

const A = "anthropic-messages";
const C = "completions-compatible";
const R = "openai-responses";

// Data only, adapted from @cherrystudio/provider-registry (MIT), Cherry Studio.
// Source: CherryHQ/cherry-studio@4edb3b85630469e1a784577ec47540cb646d9781
// packages/provider-registry/data/providers.json; disclosure: licenses/extra/cherry-studio-provider-registry.txt.
// URLs include the version prefix: our HTTP providers append /messages,
// /responses, /chat/completions or /models/... themselves (no SDK normalization).
// No referral metadata, model catalog, upstream implementation or NUG preset is included.

function preset(
	id: string,
	name: string,
	endpoints: PresetEndpoints,
	extra: Partial<ProviderPreset> = {},
): ProviderPreset {
	return { id, name, nameKey: `providerNames.${id}`, endpoints, defaultProtocol: C, ...extra };
}

/** A known service's official endpoints. */
function known(id: ServiceTemplateId): PresetEndpoints {
	return { ...getServiceTemplate(id).endpoints };
}

function endpoints(messages: string, completions: string, responses?: string): PresetEndpoints {
	return { [A]: messages, [C]: completions, ...(responses ? { [R]: responses } : {}) };
}

/**
 * Variants with their creation defaults: the named creation protocol, else Responses →
 * Messages → Chat Completions. Token Plan keys present NarraFork's own User-Agent, never
 * an impersonated client.
 */
function connections(
	variants: (ProviderConnectionSelection & { endpoints: PresetEndpoints })[],
	creationProtocol?: AddProviderType,
): ProviderConnection[] {
	return variants.map((variant) => ({
		...variant,
		defaultProtocol:
			creationProtocol ?? ([R, A, C] as const).find((p) => variant.endpoints[p]) ?? C,
		...(creationProtocol ? { creationProtocol } : {}),
		...(variant.billing === "token-plan" ? { userAgentMode: "narrafork" as const } : {}),
	}));
}

// NarraFork-authored factual URL mapping; official source URLs and evidence limits:
// licenses/extra/cherry-studio-provider-registry.txt. All Messages bases include /v1
// because NarraFork appends /messages directly (unlike SDK prefix normalization).
// These endpoints do not promise access for clients outside a provider's allowed tools.

const kimiCode = getServiceTemplate("kimi-code").regions ?? {};
// Kimi's dynamic tool loading (a `system` message carrying `tools`) exists only on Chat
// Completions; through the Messages or Responses relay the only option is injecting the
// schema into the load notice. Responses stays selectable, but Chat Completions is what the
// provider is created with.
const KIMI = connections(
	[
		{
			region: "china",
			billing: "payg",
			endpoints: endpoints(
				"https://api.moonshot.cn/anthropic/v1",
				"https://api.moonshot.cn/v1",
				"https://api.moonshot.cn/v1",
			),
		},
		{
			region: "international",
			billing: "payg",
			endpoints: endpoints(
				"https://api.moonshot.ai/anthropic/v1",
				"https://api.moonshot.ai/v1",
				"https://api.moonshot.ai/v1",
			),
		},
		{ region: "china", billing: "token-plan", endpoints: { ...kimiCode.china } },
		{ region: "international", billing: "token-plan", endpoints: { ...kimiCode.international } },
	],
	C,
);

// Subscription keys and pay-as-you-go keys differ, even with the same host.
const MINIMAX = connections(
	(["payg", "token-plan"] as const).flatMap((billing) => [
		{
			region: "china" as const,
			billing,
			endpoints: endpoints("https://api.minimax.cn/anthropic/v1", "https://api.minimax.cn/v1"),
		},
		{
			region: "international" as const,
			billing,
			endpoints: endpoints("https://api.minimax.io/anthropic/v1", "https://api.minimax.io/v1"),
		},
	]),
);

// The official Codex guide verifies Responses for payg and CN Token Plan.
// SGP/AMS have explicit A/C examples only: do not infer regional Responses.
const MIMO = connections([
	...(["china", "international"] as const).map((region) => ({
		region,
		billing: "payg" as const,
		endpoints: endpoints(
			"https://api.xiaomimimo.com/anthropic/v1",
			"https://api.xiaomimimo.com/v1",
			"https://api.xiaomimimo.com/v1",
		),
	})),
	{
		region: "china",
		billing: "token-plan",
		endpoints: endpoints(
			"https://token-plan-cn.xiaomimimo.com/anthropic/v1",
			"https://token-plan-cn.xiaomimimo.com/v1",
			"https://token-plan-cn.xiaomimimo.com/v1",
		),
	},
	...(["sgp", "ams"] as const).map((cluster) => ({
		region: "international" as const,
		billing: "token-plan" as const,
		cluster,
		endpoints: endpoints(
			`https://token-plan-${cluster}.xiaomimimo.com/anthropic/v1`,
			`https://token-plan-${cluster}.xiaomimimo.com/v1`,
		),
	})),
]);

// Ordinary Responses is documented by BigModel, not Z.ai's ordinary API docs.
const ZHIPU = connections([
	{
		region: "china",
		billing: "payg",
		endpoints: endpoints(
			"https://open.bigmodel.cn/api/anthropic/v1",
			"https://open.bigmodel.cn/api/paas/v4",
			"https://open.bigmodel.cn/api/v1",
		),
	},
	{
		region: "international",
		billing: "payg",
		endpoints: endpoints("https://api.z.ai/api/anthropic/v1", "https://api.z.ai/api/paas/v4"),
	},
	{
		region: "china",
		billing: "token-plan",
		endpoints: endpoints(
			"https://open.bigmodel.cn/api/anthropic/v1",
			"https://open.bigmodel.cn/api/coding/paas/v4",
			"https://open.bigmodel.cn/api/v1",
		),
	},
	{
		region: "international",
		billing: "token-plan",
		endpoints: endpoints(
			"https://api.z.ai/api/anthropic/v1",
			"https://api.z.ai/api/coding/paas/v4",
			"https://api.z.ai/api/v1",
		),
	},
]);

// Aliases are NarraFork-authored search terms, not metadata copied from the upstream registry.
const PRESETS: ProviderPreset[] = [
	preset(
		"silicon",
		"Silicon",
		{ [A]: "https://api.siliconflow.cn/v1", [C]: "https://api.siliconflow.cn/v1" },
		{ aliases: ["硅基流动", "硅基", "SiliconFlow"] },
	),
	preset("ovms", "OpenVINO Model Server", { [C]: "http://localhost:8000/v3" }),
	preset("ocoolai", "ocoolAI", { [C]: "https://api.ocoolai.com/v1" }),
	preset(
		"zhipu",
		"ZhiPu",
		{
			[A]: "https://open.bigmodel.cn/api/anthropic/v1",
			[C]: "https://open.bigmodel.cn/api/paas/v4",
		},
		{ aliases: ["智谱", "智谱清言", "GLM", "BigModel"], popular: 3, connections: ZHIPU },
	),
	preset("deepseek", "deepseek", known("deepseek"), { aliases: ["深度求索"], popular: 2 }),
	preset("alayanew", "AlayaNew", { [C]: "https://deepseek.alayanew.com/v1" }),
	preset("burncloud", "BurnCloud", { [C]: "https://ai.burncloud.com/v1" }),
	preset("302ai", "302.AI", { [A]: "https://api.302.ai/v1", [C]: "https://api.302.ai/v1" }),
	preset("lanyun", "LANYUN", { [C]: "https://maas-api.lanyun.net/v1" }),
	preset("ph8", "PH8", { [C]: "https://ph8.co/v1" }),
	preset("sophnet", "SophNet", { [C]: "https://www.sophnet.com/api/open-apis/v1" }),
	preset("ppio", "PPIO", { [C]: "https://api.ppinfra.com/v3/openai" }),
	preset(
		"qiniu",
		"Qiniu",
		{ [A]: "https://api.qnaigc.com/v1", [C]: "https://api.qnaigc.com/v1" },
		{ aliases: ["七牛", "七牛云"] },
	),
	preset("openrouter", "OpenRouter", {
		[A]: "https://openrouter.ai/api/v1",
		[C]: "https://openrouter.ai/api/v1",
	}),
	// Local compatibility override: upstream lists native Ollama and Anthropic;
	// we expose only Ollama's standard OpenAI-compatible /v1, never /api/chat.
	preset("ollama", "Ollama", { [C]: "http://localhost:11434/v1" }),
	preset("radeon-cloud", "AMD GPU Cloud", { [C]: "https://developer.amd.com.cn/radeon/v1" }),
	{
		id: "tokendance",
		name: "TokenDance",
		nameKey: "providerNames.tokendance",
		descriptionKey: "providerDescriptions.tokendance",
		category: "platform-login",
		endpoints: {},
		// TokenDance serves licensed domestic models for users in China.
		languages: ["zh"],
		popular: 1,
	},
	preset("lmstudio", "LM Studio", {
		[A]: "http://localhost:1234/v1",
		[C]: "http://localhost:1234/v1",
	}),
	preset("anthropic", "Anthropic", known("anthropic"), { defaultProtocol: A, popular: 8 }),
	preset(
		"omlx",
		"oMLX",
		{
			[A]: "http://localhost:8000/v1",
			[C]: "http://localhost:8000/v1",
			[R]: "http://localhost:8000/v1",
		},
		{ defaultProtocol: R },
	),
	// Local compatibility override: upstream lists only Responses for OpenAI;
	// also expose the standard Chat Completions API while retaining its default.
	preset("openai", "OpenAI", known("openai"), { defaultProtocol: R, popular: 7 }),
	preset("opencode", "OpenCode Go", known("opencode-go")),
	preset("gemini", "Gemini", known("gemini"), { defaultProtocol: "gemini-compatible" }),
	preset(
		"moonshot",
		"Moonshot AI",
		{ [A]: "https://api.moonshot.cn/anthropic/v1", [C]: "https://api.moonshot.cn/v1" },
		{ aliases: ["月之暗面", "Kimi"], popular: 4, connections: KIMI },
	),
	preset(
		"moonshot-global",
		"Moonshot",
		{ [A]: "https://api.moonshot.ai/anthropic/v1", [C]: "https://api.moonshot.ai/v1" },
		{ aliases: ["月之暗面", "Kimi"], connections: KIMI, defaultRegion: "international" },
	),
	preset(
		"baichuan",
		"BAICHUAN AI",
		{ [C]: "https://api.baichuan-ai.com/v1" },
		{ aliases: ["百川", "百川智能"] },
	),
	preset(
		"dashscope",
		"Bailian",
		{
			[A]: "https://dashscope.aliyuncs.com/apps/anthropic/v1",
			[C]: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			[R]: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		},
		{ aliases: ["通义", "通义千问", "百炼", "阿里云", "Qwen"] },
	),
	preset(
		"stepfun",
		"StepFun",
		{ [A]: "https://api.stepfun.com/v1", [C]: "https://api.stepfun.com/v1" },
		{ aliases: ["阶跃", "阶跃星辰"] },
	),
	preset(
		"doubao",
		"Doubao",
		{
			[C]: "https://ark.cn-beijing.volces.com/api/v3",
			[R]: "https://ark.cn-beijing.volces.com/api/v3",
		},
		{ aliases: ["豆包", "火山", "火山引擎", "字节跳动"] },
	),
	preset(
		"minimax",
		"MiniMax",
		{ [A]: "https://api.minimaxi.com/anthropic/v1", [C]: "https://api.minimaxi.com/v1" },
		{ aliases: ["稀宇", "海螺"], popular: 5, connections: MINIMAX },
	),
	preset("groq", "Groq", { [C]: "https://api.groq.com/openai/v1" }),
	preset("together", "Together", { [C]: "https://api.together.ai/v1" }),
	preset(
		"fireworks",
		"Fireworks",
		{
			[A]: "https://api.fireworks.ai/inference/v1",
			[C]: "https://api.fireworks.ai/inference/v1",
			[R]: "https://api.fireworks.ai/inference/v1",
		},
		{ defaultProtocol: R },
	),
	preset(
		"nvidia",
		"nvidia",
		{ [C]: "https://integrate.api.nvidia.com/v1" },
		{ aliases: ["英伟达"] },
	),
	preset(
		"grok",
		"Grok",
		{ [C]: "https://api.x.ai/v1", [R]: "https://api.x.ai/v1" },
		{ defaultProtocol: R },
	),
	preset("jina", "Jina", { [C]: "https://api.jina.ai/v1" }),
	preset(
		"modelscope",
		"ModelScope",
		{
			[A]: "https://api-inference.modelscope.cn/v1",
			[C]: "https://api-inference.modelscope.cn/v1",
		},
		{ aliases: ["魔搭", "魔搭社区"] },
	),
	preset("xirang", "Xirang", { [C]: "https://wishub-x1.ctyun.cn/v1" }),
	preset(
		"tokenhub",
		"TokenHub",
		{
			[A]: "https://tokenhub.tencentmaas.com/v1",
			[C]: "https://tokenhub.tencentmaas.com/v1",
			[R]: "https://tokenhub.tencentmaas.com/v1",
		},
		{ aliases: ["腾讯", "混元"] },
	),
	preset(
		"baidu-cloud",
		"Baidu Cloud",
		{ [C]: "https://qianfan.baidubce.com/v2" },
		{ aliases: ["百度", "百度云", "千帆", "文心"] },
	),
	preset(
		"poe",
		"Poe",
		{
			[A]: "https://api.poe.com/v1",
			[C]: "https://api.poe.com/v1",
			[R]: "https://api.poe.com/v1",
		},
		{ defaultProtocol: R },
	),
	preset("longcat", "LongCat", {
		[A]: "https://api.longcat.chat/anthropic/v1",
		[C]: "https://api.longcat.chat/openai/v1",
	}),
	preset(
		"huggingface",
		"Hugging Face",
		{ [A]: "https://router.huggingface.co/v1", [R]: "https://router.huggingface.co/v1" },
		{ defaultProtocol: R },
	),
	preset("cerebras", "Cerebras AI", { [C]: "https://api.cerebras.ai/v1" }),
	preset(
		"mimo",
		"Xiaomi MiMo",
		{
			[A]: "https://api.xiaomimimo.com/anthropic/v1",
			[C]: "https://api.xiaomimimo.com/v1",
			[R]: "https://api.xiaomimimo.com/v1",
		},
		{ aliases: ["小米"], popular: 6, connections: MIMO },
	),
	preset(
		"zai",
		"zai",
		{ [A]: "https://api.z.ai/api/anthropic/v1", [C]: "https://api.z.ai/api/paas/v4" },
		{ aliases: ["智谱", "GLM"], connections: ZHIPU, defaultRegion: "international" },
	),
	preset(
		"minimax-global",
		"minimax-global",
		{ [A]: "https://api.minimax.io/anthropic/v1", [C]: "https://api.minimax.io/v1" },
		{ aliases: ["稀宇", "海螺"], connections: MINIMAX, defaultRegion: "international" },
	),
];

const CATALOG: SourcingCatalog = {
	templates: listServiceTemplates().map(({ id, kind, endpoints, regions, defaults }) => ({
		id,
		kind,
		...(endpoints ? { endpoints } : {}),
		...(regions ? { regions } : {}),
		...(defaults ? { defaults } : {}),
	})),
	presets: PRESETS,
};

export function getSourcingCatalog(): SourcingCatalog {
	return CATALOG;
}
