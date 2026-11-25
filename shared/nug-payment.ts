/** 公开充值意图不携带 CID、secret 或私有请求 identity。 */
export type NugPaymentIntent =
	| { mode: "standalone" }
	| { mode: "request"; narratorId: string; paymentContext: string };

/** 只检查公开 opaque 格式；权限、用途、有效期及 HMAC 均由服务器核验。 */
export function isNugPaymentContext(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 256 &&
		/^npc1\.[0-9a-z]{1,13}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(value)
	);
}
