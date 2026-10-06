import { db } from "../db";
import { oauthSecurityEvents } from "../db/schema";
import { hotSafe } from "./hot-safe";
import { generateId } from "./id";
import { logger } from "./logger";

export type OAuthSecurityEvent =
	| "token_issued"
	| "refresh_rotated"
	| "refresh_reuse_detected"
	| "token_revoked"
	| "rate_limited"
	| "runtime_authorization_lost";

const counters = hotSafe<Record<OAuthSecurityEvent, number>>(
	"narrafork.oauthSecurityObservability.counters",
	() => ({
		token_issued: 0,
		refresh_rotated: 0,
		refresh_reuse_detected: 0,
		token_revoked: 0,
		rate_limited: 0,
		runtime_authorization_lost: 0,
	}),
);

export function countOAuthSecurityEvent(event: OAuthSecurityEvent): void {
	counters[event] += 1;
}

export async function recordOAuthRateLimitTransition(input: {
	endpoint: string;
	bucketType: "ip" | "principal";
	retryAfterSeconds: number;
	clientId?: string | null;
	grantId?: string | null;
	userId?: string | null;
}): Promise<void> {
	try {
		await db.insert(oauthSecurityEvents).values({
			id: generateId(),
			eventType: "rate_limited",
			endpoint: input.endpoint.slice(0, 64),
			bucketType: input.bucketType,
			clientId: input.clientId?.slice(0, 128) ?? null,
			grantId: input.grantId ?? null,
			userId: input.userId ?? null,
			retryAfterSeconds: Math.max(1, Math.min(3_600, Math.ceil(input.retryAfterSeconds))),
			createdAt: new Date().toISOString(),
		});
	} catch (error) {
		logger.error("Failed to persist OAuth rate-limit transition", {
			endpoint: input.endpoint.slice(0, 64),
			error: String(error).slice(0, 512),
		});
	}
}

export async function recordOAuthSecurityEvent(input: {
	event: OAuthSecurityEvent;
	grantId?: string | null;
	userId?: string | null;
	oauthClientId?: string | null;
	metadata?: Record<string, string | number | boolean | null>;
}): Promise<void> {
	countOAuthSecurityEvent(input.event);
	try {
		const { recordOAuthGrantEvent } = await import("../services/oauth-grant-service");
		await recordOAuthGrantEvent({
			eventType: input.event,
			grantId: input.grantId,
			userId: input.userId,
			oauthClientId: input.oauthClientId ?? undefined,
			actorType: "system",
			metadata: input.metadata ?? null,
		});
	} catch (error) {
		logger.error("Failed to persist OAuth security event", {
			event: input.event,
			error: String(error).slice(0, 512),
		});
	}
}

export function getOAuthSecurityObservabilitySnapshot() {
	return {
		sinceProcessStart: { ...counters },
	};
}
