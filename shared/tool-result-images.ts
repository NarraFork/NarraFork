/**
 * 工具结果里的图片在 Chat Completions 请求中的去处。
 *
 * OpenAI 官方把 `tool.content` 限定为文本，工具返回的图片只能另起一条 user 消息；
 * DeepSeek 官方扩展了 `image_url` 内容块，可以直接内嵌在工具消息里；Command Code 的
 * CLI 结构则是「工具文本 + 紧随其后的独立 user 图片消息」。三种上游不能共用一种形状，
 * 所以按 provider 配置，缺省 `"off"` 保持现状。
 */
export type ToolResultImagesMode = "off" | "inline" | "separate";

export const TOOL_RESULT_IMAGES_MODES: readonly ToolResultImagesMode[] = [
	"off",
	"inline",
	"separate",
];

/** 未配置或不认识的值一律按 `"off"`：不给不支持扩展的上游发非法 content 数组。 */
export function normalizeToolResultImagesMode(value: unknown): ToolResultImagesMode {
	return value === "inline" || value === "separate" ? value : "off";
}
