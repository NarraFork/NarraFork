import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isNugPaymentContext } from "@shared/nug-payment";
import { AppError } from "./errors";
import { nugQuotaIdentity } from "./nug-quota-cache";
import { credentialForStream } from "./provider-key-subjects";
import { getProviderKeyStore, nugKeyOwner, withProviderKey } from "./provider-keys";
import { type NUGProviderConfig, nugProviderPrefix, settings } from "./settings";

const PAYMENT_CONTEXT_PURPOSE = "narrafork/nug-payment-request/v1";
export const NUG_PAYMENT_CONTEXT_TTL_MS = 15 * 60_000;

/** 仅在服务器内部使用；不能加入公开 WS 或 API 的 DTO。 */
export interface NugPaymentSubjectSelection {
	credentialId: string;
	storedCredential: boolean;
}

export function getNugPaymentSubject(providerId: string, selection?: NugPaymentSubjectSelection) {
	const connection = (settings.nugProviders ?? []).find((provider) => provider.id === providerId);
	if (!connection)
		throw new AppError(
			"NUG payment connection is unavailable",
			selection ? 409 : 404,
			"NUG_PAYMENT_CONTEXT",
		);
	if (connection.disabled)
		throw new AppError("NUG payment connection is disabled", 409, "NUG_PAYMENT_CONTEXT");
	const keys = getProviderKeyStore().list(nugKeyOwner(providerId));
	const key = selection
		? selection.storedCredential
			? keys.find((entry) => entry.id === selection.credentialId)
			: undefined
		: keys.find((entry) => !entry.disabled);
	if (
		(selection?.storedCredential && !key) ||
		(selection && !selection.storedCredential && keys.length) ||
		key?.disabled ||
		(!key && keys.length)
	) {
		throw new AppError(
			"NUG payment credential changed or is unavailable",
			409,
			"NUG_PAYMENT_CONTEXT",
		);
	}
	const config = structuredClone(key ? withProviderKey(connection, key) : connection);
	if (!config.apiKey?.trim())
		throw new AppError("NUG payment credential is unavailable", 409, "NUG_PAYMENT_CONTEXT");
	return {
		config,
		connection,
		credentialId: key?.id ?? providerId,
		storedCredential: !!key,
		identityHash: privateIdentityHash(config),
	};
}

function privateIdentityHash(config: NUGProviderConfig): string {
	return createHash("sha256").update(nugQuotaIdentity(config)).digest("hex");
}

interface PrivatePaymentClaims extends NugPaymentSubjectSelection {
	narratorId: string;
	providerId: string;
	providerPrefix: string;
	identityHash: string;
}

function claimsFor(
	narratorId: string,
	subject: ReturnType<typeof getNugPaymentSubject>,
): PrivatePaymentClaims {
	return {
		narratorId,
		providerId: subject.connection.id,
		providerPrefix: nugProviderPrefix(subject.connection),
		credentialId: subject.credentialId,
		storedCredential: subject.storedCredential,
		identityHash: subject.identityHash,
	};
}

function paymentSigningSecret(): string | undefined {
	const secret = settings.auth?.jwtSecret;
	return typeof secret === "string" && secret.trim().length > 0 ? secret : undefined;
}

function sign(claims: PrivatePaymentClaims, expiresAt: number, nonce: string): string {
	const secret = paymentSigningSecret();
	if (!secret) throw invalidContext();
	return createHmac("sha256", secret)
		.update(
			JSON.stringify([
				PAYMENT_CONTEXT_PURPOSE,
				claims.narratorId,
				claims.providerId,
				claims.providerPrefix,
				claims.credentialId,
				claims.storedCredential,
				claims.identityHash,
				expiresAt,
				nonce,
			]),
		)
		.digest("base64url");
}

/**
 * 在真实请求边界冻结主体证明，402 时才签发短期上下文。
 * STREAM identity 只用于服务器内部归属校验，绝不直接复用成公开 token。
 * 返回闭包仅保存 CID/摘要等私有声明，不保存 secret/config，也不建立 registry。
 */
export function captureNugPaymentRequest(
	narratorId: string,
	providerPrefix: string,
	privateAttemptIdentity: string | undefined,
): (() => string | undefined) | undefined {
	if (!paymentSigningSecret()) return undefined;
	const connection = (settings.nugProviders ?? []).find(
		(provider) =>
			!provider.disabled &&
			(provider.id === providerPrefix || nugProviderPrefix(provider) === providerPrefix),
	);
	if (!connection || !privateAttemptIdentity) return undefined;
	const request = credentialForStream(
		connection,
		privateAttemptIdentity,
		nugKeyOwner(connection.id),
	);
	if (!request) return undefined;
	try {
		const subject = getNugPaymentSubject(connection.id, {
			credentialId: request.id,
			storedCredential: getProviderKeyStore()
				.list(nugKeyOwner(connection.id))
				.some((key) => key.id === request.id),
		});
		if (subject.identityHash !== privateIdentityHash(request.config)) return undefined;
		const claims = claimsFor(narratorId, subject);
		return () => {
			// 签发前密钥也可能被清空，不能产生空 key 的可伪造 HMAC。
			if (!paymentSigningSecret()) return undefined;
			const expiresAt = Date.now() + NUG_PAYMENT_CONTEXT_TTL_MS;
			const nonce = randomBytes(16).toString("base64url");
			return `npc1.${expiresAt.toString(36)}.${nonce}.${sign(claims, expiresAt, nonce)}`;
		};
	} catch {
		// 无法证明实际失败主体时不制造首 Key 上下文；客户端必须明确失败。
		return undefined;
	}
}

function invalidContext(): AppError {
	return new AppError(
		"NUG 失败请求的充值上下文无效或已过期，请重新发起请求",
		409,
		"NUG_PAYMENT_CONTEXT",
	);
}

/** 调用方必须另行核对 narrator 写权限；客户端从不提供或选择 CID。 */
export function resolveNugPaymentContext(providerId: string, narratorId: string, token: unknown) {
	if (!paymentSigningSecret() || !isNugPaymentContext(token)) throw invalidContext();
	const [, expiry, nonce, signature] = token.split(".");
	if (!expiry || !nonce || !signature) throw invalidContext();
	const expiresAt = Number.parseInt(expiry, 36);
	const now = Date.now();
	if (
		!Number.isSafeInteger(expiresAt) ||
		expiresAt.toString(36) !== expiry ||
		expiresAt <= now ||
		expiresAt > now + NUG_PAYMENT_CONTEXT_TTL_MS
	)
		throw invalidContext();
	const connection = (settings.nugProviders ?? []).find(
		(provider) => provider.id === providerId && !provider.disabled,
	);
	if (!connection) throw invalidContext();
	const keys = getProviderKeyStore().list(nugKeyOwner(providerId));
	// HMAC 的私有声明以 live CID 为候选，排序不参与身份；健康重排仍绑定原钱包。
	const candidates: Array<{ selection: NugPaymentSubjectSelection; config: NUGProviderConfig }> =
		keys.length
			? keys
					.filter((key) => !key.disabled)
					.map((key) => ({
						selection: { credentialId: key.id, storedCredential: true },
						config: withProviderKey(connection, key),
					}))
			: connection.apiKey
				? [
						{
							selection: { credentialId: connection.id, storedCredential: false },
							config: connection,
						},
					]
				: [];
	const presented = Buffer.from(signature);
	for (const { selection, config } of candidates) {
		const claims: PrivatePaymentClaims = {
			...selection,
			narratorId,
			providerId,
			providerPrefix: nugProviderPrefix(connection),
			identityHash: privateIdentityHash(config),
		};
		const expected = Buffer.from(sign(claims, expiresAt, nonce));
		if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
			return getNugPaymentSubject(providerId, selection);
		}
	}
	throw invalidContext();
}
