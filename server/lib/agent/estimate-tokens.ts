/**
 * 用字符启发式估算文本的 token 数量——只服务于"预算保护"，不是精确计数。
 *
 * 经验值（方向：宁可高估）：
 * - ASCII / 拉丁字符：约 0.5 token/字符
 * - CJK / 宽字符：约 0.85 token/字符
 *
 * 为什么宁可高估：高估的代价只是偏早触发压缩（多花一次摘要调用），低估的代价是
 * 请求被 provider 以超长拒绝——整个回合白跑，用户还得手动压缩后重发。这两者不对
 * 等，所以系数取偏大一端。
 *
 * 已知局限（有实测反证，别再把它当成"保守上界"）：
 * - 对 JSON / 代码 / 工具输出这类符号密集的内容仍然低估。真实事故：一份 body
 *   UTF-8 3,077,644 字节的请求（CJK 183,803 字符 + ASCII 738,946 字符）被
 *   deepseek 的分词器数成 1,080,519 token，扣掉 CJK 部分后反推 ASCII 部分约
 *   1.31 token/字符——结构符号、路径、标识符往往各自成 token。本函数此时只估到
 *   约 52.5 万，仍是低估。
 * - 同一份内容在不同模型上的计数能差一倍以上（该请求在 hy4 上记 638,848），所以
 *   字符法给不出跨模型一致的绝对值。
 * - 对纯英文散文会高估（真实英文约 0.25 token/字符）。
 *
 * 需要精确值时必须接真实分词器；本函数的作用是让"撞墙"更早被发现，而不是替代
 * provider 返回的 usage。
 */

/** ASCII / 拉丁字符的经验系数，见文件头"宁可高估"。 */
const ASCII_TOKENS_PER_CHAR = 0.5;
/** CJK / 宽字符的经验系数，见文件头"宁可高估"。 */
const CJK_TOKENS_PER_CHAR = 0.85;

export function estimateTokens(text: string): number {
	let tokens = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		// CJK Unified Ideographs, CJK Extension A, Hangul, Kana, fullwidth forms, etc.
		if (
			(code >= 0x2e80 && code <= 0x9fff) || // CJK radicals, ideographs
			(code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
			(code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
			(code >= 0xff00 && code <= 0xffef) || // Fullwidth forms
			(code >= 0x3000 && code <= 0x303f) || // CJK symbols and punctuation
			(code >= 0x3040 && code <= 0x30ff) // Hiragana + Katakana
		) {
			tokens += CJK_TOKENS_PER_CHAR;
		} else {
			tokens += ASCII_TOKENS_PER_CHAR;
		}
	}
	return Math.ceil(tokens);
}
