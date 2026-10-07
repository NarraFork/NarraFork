import type { CustomApiProtocol } from "./types";

export type AddProviderType = "nug" | CustomApiProtocol;

export interface ProviderPreset {
	id: string;
	name: string;
	nameKey?: string;
	endpoints: Partial<Record<AddProviderType, string>>;
	defaultProtocol: AddProviderType;
}

// Data only, adapted from @cherrystudio/provider-registry (MIT), Cherry Studio.
// Source: CherryHQ/cherry-studio@4edb3b85630469e1a784577ec47540cb646d9781
// packages/provider-registry/data/providers.json; disclosure: licenses/extra/cherry-studio-provider-registry.txt.
// URLs include the version prefix: our HTTP providers append /messages,
// /responses, /chat/completions or /models/... themselves (no SDK normalization).
// No referral metadata, model catalog, upstream implementation or NUG preset is included.

function preset(
	id: string,
	name: string,
	endpoints: ProviderPreset["endpoints"],
	defaultProtocol: AddProviderType = "completions-compatible",
): ProviderPreset {
	return { id, name, nameKey: `providerNames.${id}`, endpoints, defaultProtocol };
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
	preset("silicon", "Silicon", {
		"anthropic-messages": "https://api.siliconflow.cn/v1",
		"completions-compatible": "https://api.siliconflow.cn/v1",
	}),
	preset("ovms", "OpenVINO Model Server", {
		"completions-compatible": "http://localhost:8000/v3",
	}),
	preset("ocoolai", "ocoolAI", { "completions-compatible": "https://api.ocoolai.com/v1" }),
	preset("zhipu", "ZhiPu", {
		"anthropic-messages": "https://open.bigmodel.cn/api/anthropic/v1",
		"completions-compatible": "https://open.bigmodel.cn/api/paas/v4",
	}),
	preset("deepseek", "deepseek", {
		"anthropic-messages": "https://api.deepseek.com/anthropic/v1",
		"completions-compatible": "https://api.deepseek.com/v1",
		"openai-responses": "https://api.deepseek.com/v1",
	}),
	preset("alayanew", "AlayaNew", {
		"completions-compatible": "https://deepseek.alayanew.com/v1",
	}),
	preset("burncloud", "BurnCloud", { "completions-compatible": "https://ai.burncloud.com/v1" }),
	preset("302ai", "302.AI", {
		"anthropic-messages": "https://api.302.ai/v1",
		"completions-compatible": "https://api.302.ai/v1",
	}),
	preset("lanyun", "LANYUN", { "completions-compatible": "https://maas-api.lanyun.net/v1" }),
	preset("ph8", "PH8", { "completions-compatible": "https://ph8.co/v1" }),
	preset("sophnet", "SophNet", {
		"completions-compatible": "https://www.sophnet.com/api/open-apis/v1",
	}),
	preset("ppio", "PPIO", { "completions-compatible": "https://api.ppinfra.com/v3/openai" }),
	preset("qiniu", "Qiniu", {
		"anthropic-messages": "https://api.qnaigc.com/v1",
		"completions-compatible": "https://api.qnaigc.com/v1",
	}),
	preset("openrouter", "OpenRouter", {
		"anthropic-messages": "https://openrouter.ai/api/v1",
		"completions-compatible": "https://openrouter.ai/api/v1",
	}),
	// Local compatibility override: upstream lists native Ollama and Anthropic;
	// we expose only Ollama's standard OpenAI-compatible /v1, never /api/chat.
	preset("ollama", "Ollama", { "completions-compatible": "http://localhost:11434/v1" }),
	preset("radeon-cloud", "AMD GPU Cloud", {
		"completions-compatible": "https://developer.amd.com.cn/radeon/v1",
	}),
	preset("tokendance", "TokenDance", {
		"anthropic-messages": "https://tokendance.space/gateway/v1",
		"gemini-compatible": "https://tokendance.space/gateway/v1beta",
		"completions-compatible": "https://tokendance.space/gateway/v1",
		"openai-responses": "https://tokendance.space/gateway/v1",
	}),
	preset("lmstudio", "LM Studio", {
		"anthropic-messages": "http://localhost:1234/v1",
		"completions-compatible": "http://localhost:1234/v1",
	}),
	preset(
		"anthropic",
		"Anthropic",
		{ "anthropic-messages": "https://api.anthropic.com/v1" },
		"anthropic-messages",
	),
	preset(
		"omlx",
		"oMLX",
		{
			"anthropic-messages": "http://localhost:8000/v1",
			"completions-compatible": "http://localhost:8000/v1",
			"openai-responses": "http://localhost:8000/v1",
		},
		"openai-responses",
	),
	// Local compatibility override: upstream lists only Responses for OpenAI;
	// also expose the standard Chat Completions API while retaining its default.
	preset(
		"openai",
		"OpenAI",
		{
			"openai-responses": "https://api.openai.com/v1",
			"completions-compatible": "https://api.openai.com/v1",
		},
		"openai-responses",
	),
	preset("opencode", "OpenCode Go", {
		"anthropic-messages": "https://opencode.ai/zen/go/v1",
		"completions-compatible": "https://opencode.ai/zen/go/v1",
		"openai-responses": "https://opencode.ai/zen/go/v1",
	}),
	preset(
		"gemini",
		"Gemini",
		{
			"gemini-compatible": "https://generativelanguage.googleapis.com/v1beta",
		},
		"gemini-compatible",
	),
	preset("moonshot", "Moonshot AI", {
		"anthropic-messages": "https://api.moonshot.cn/anthropic/v1",
		"completions-compatible": "https://api.moonshot.cn/v1",
	}),
	preset("moonshot-global", "Moonshot", {
		"anthropic-messages": "https://api.moonshot.ai/anthropic/v1",
		"completions-compatible": "https://api.moonshot.ai/v1",
	}),
	preset("baichuan", "BAICHUAN AI", {
		"completions-compatible": "https://api.baichuan-ai.com/v1",
	}),
	preset("dashscope", "Bailian", {
		"anthropic-messages": "https://dashscope.aliyuncs.com/apps/anthropic/v1",
		"completions-compatible": "https://dashscope.aliyuncs.com/compatible-mode/v1",
		"openai-responses": "https://dashscope.aliyuncs.com/compatible-mode/v1",
	}),
	preset("stepfun", "StepFun", {
		"anthropic-messages": "https://api.stepfun.com/v1",
		"completions-compatible": "https://api.stepfun.com/v1",
	}),
	preset("doubao", "Doubao", {
		"completions-compatible": "https://ark.cn-beijing.volces.com/api/v3",
		"openai-responses": "https://ark.cn-beijing.volces.com/api/v3",
	}),
	preset("minimax", "MiniMax", {
		"anthropic-messages": "https://api.minimaxi.com/anthropic/v1",
		"completions-compatible": "https://api.minimaxi.com/v1",
	}),
	preset("groq", "Groq", { "completions-compatible": "https://api.groq.com/openai/v1" }),
	preset("together", "Together", { "completions-compatible": "https://api.together.ai/v1" }),
	preset(
		"fireworks",
		"Fireworks",
		{
			"anthropic-messages": "https://api.fireworks.ai/inference/v1",
			"completions-compatible": "https://api.fireworks.ai/inference/v1",
			"openai-responses": "https://api.fireworks.ai/inference/v1",
		},
		"openai-responses",
	),
	preset("nvidia", "nvidia", { "completions-compatible": "https://integrate.api.nvidia.com/v1" }),
	preset(
		"grok",
		"Grok",
		{
			"completions-compatible": "https://api.x.ai/v1",
			"openai-responses": "https://api.x.ai/v1",
		},
		"openai-responses",
	),
	preset("jina", "Jina", { "completions-compatible": "https://api.jina.ai/v1" }),
	preset("modelscope", "ModelScope", {
		"anthropic-messages": "https://api-inference.modelscope.cn/v1",
		"completions-compatible": "https://api-inference.modelscope.cn/v1",
	}),
	preset("xirang", "Xirang", { "completions-compatible": "https://wishub-x1.ctyun.cn/v1" }),
	preset("tokenhub", "TokenHub", {
		"anthropic-messages": "https://tokenhub.tencentmaas.com/v1",
		"completions-compatible": "https://tokenhub.tencentmaas.com/v1",
		"openai-responses": "https://tokenhub.tencentmaas.com/v1",
	}),
	preset("baidu-cloud", "Baidu Cloud", {
		"completions-compatible": "https://qianfan.baidubce.com/v2",
	}),
	preset(
		"poe",
		"Poe",
		{
			"anthropic-messages": "https://api.poe.com/v1",
			"completions-compatible": "https://api.poe.com/v1",
			"openai-responses": "https://api.poe.com/v1",
		},
		"openai-responses",
	),
	preset("longcat", "LongCat", {
		"anthropic-messages": "https://api.longcat.chat/anthropic/v1",
		"completions-compatible": "https://api.longcat.chat/openai/v1",
	}),
	preset(
		"huggingface",
		"Hugging Face",
		{
			"anthropic-messages": "https://router.huggingface.co/v1",
			"openai-responses": "https://router.huggingface.co/v1",
		},
		"openai-responses",
	),
	preset("cerebras", "Cerebras AI", { "completions-compatible": "https://api.cerebras.ai/v1" }),
	preset("mimo", "Xiaomi MiMo", {
		"anthropic-messages": "https://api.xiaomimimo.com/anthropic/v1",
		"completions-compatible": "https://api.xiaomimimo.com/v1",
		"openai-responses": "https://api.xiaomimimo.com/v1",
	}),
	preset("zai", "zai", {
		"anthropic-messages": "https://api.z.ai/api/anthropic/v1",
		"completions-compatible": "https://api.z.ai/api/paas/v4",
	}),
	preset("minimax-global", "minimax-global", {
		"anthropic-messages": "https://api.minimax.io/anthropic/v1",
		"completions-compatible": "https://api.minimax.io/v1",
	}),
];

// NarraFork-authored search aliases, not metadata copied from the upstream registry.
const PROVIDER_SEARCH_ALIASES: Record<string, string[]> = {
	silicon: ["硅基流动", "硅基", "SiliconFlow"],
	zhipu: ["智谱", "智谱清言", "GLM", "BigModel"],
	deepseek: ["深度求索"],
	dashscope: ["通义", "通义千问", "百炼", "阿里云", "Qwen"],
	doubao: ["豆包", "火山", "火山引擎", "字节跳动"],
	moonshot: ["月之暗面", "Kimi"],
	"moonshot-global": ["月之暗面", "Kimi"],
	stepfun: ["阶跃", "阶跃星辰"],
	nvidia: ["英伟达"],
	baichuan: ["百川", "百川智能"],
	minimax: ["稀宇", "海螺"],
	"minimax-global": ["稀宇", "海螺"],
	modelscope: ["魔搭", "魔搭社区"],
	qiniu: ["七牛", "七牛云"],
	"baidu-cloud": ["百度", "百度云", "千帆", "文心"],
	tokenhub: ["腾讯", "混元"],
	mimo: ["小米"],
	zai: ["智谱", "GLM"],
};

export function getProviderPresetName(
	provider: ProviderPreset,
	translate: (key: string) => string,
): string {
	return provider.nameKey ? translate(provider.nameKey) : provider.name;
}

/** Match all terms against raw/localized names, id, aliases, protocols and API URLs. */
export function searchProviderPresets(
	query: string,
	translate?: (key: string) => string,
): ProviderPreset[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return PROVIDER_PRESETS.filter((provider) => {
		const haystack = [
			provider.id,
			provider.name,
			...(translate ? [getProviderPresetName(provider, translate)] : []),
			...(PROVIDER_SEARCH_ALIASES[provider.id] ?? []),
			...Object.keys(provider.endpoints),
			...Object.values(provider.endpoints),
		]
			.join(" ")
			.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
}
