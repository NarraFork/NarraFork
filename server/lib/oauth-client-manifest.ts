import { z } from "zod";
import {
	normalizeOAuthClientPolicy,
	type OAuthClientPolicy,
	oauthClientPolicySchema,
} from "./oauth-client-policy";
import { OAUTH_SUPPORTED_SCOPES } from "./oauth-provider";

/** Stable identifier for portable public OAuth client registrations. */
export const OAUTH_CLIENT_MANIFEST_KIND = "narrafork.oauth-client";
export const OAUTH_CLIENT_MANIFEST_VERSION = 1;

/** NarraFork currently supports these grant types for public PKCE clients only. */
export const OAUTH_PUBLIC_CLIENT_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

export const oauthClientIdSchema = z
	.string()
	.trim()
	.min(4)
	.max(128)
	.regex(/^[A-Za-z0-9._-]+$/, "clientId must contain only letters, digits, '.', '_' or '-'");

export const oauthClientNameSchema = z.string().trim().min(1).max(200);

export const oauthRedirectUriSchema = z
	.string()
	.trim()
	.min(1)
	.max(2048)
	.refine((value) => {
		try {
			new URL(value);
			return true;
		} catch {
			return false;
		}
	}, "redirectUris entries must be valid absolute URLs");

export const oauthRedirectUrisSchema = z.array(oauthRedirectUriSchema).min(1).max(20);

export const oauthClientScopesSchema = z
	.array(z.enum(OAUTH_SUPPORTED_SCOPES))
	.max(OAUTH_SUPPORTED_SCOPES.length)
	.transform((scopes) => [...new Set(scopes)]);

export const oauthPublicClientGrantTypesSchema = z.tuple([
	z.literal("authorization_code"),
	z.literal("refresh_token"),
]);

export const oauthClientManifestSchema = z
	.object({
		kind: z.literal(OAUTH_CLIENT_MANIFEST_KIND),
		version: z.literal(OAUTH_CLIENT_MANIFEST_VERSION),
		clientId: oauthClientIdSchema,
		name: oauthClientNameSchema,
		redirectUris: oauthRedirectUrisSchema,
		scopes: oauthClientScopesSchema,
		grantTypes: oauthPublicClientGrantTypesSchema,
		publicClient: z.literal(true),
		policy: oauthClientPolicySchema,
	})
	.strict();

export type OAuthClientManifest = z.infer<typeof oauthClientManifestSchema>;

/** Minimal persisted client projection required to generate a portable manifest. */
export interface OAuthClientManifestSource {
	clientId: string;
	name: string;
	redirectUris: string[];
	scopes: string[];
	policyJson: Record<string, unknown> | null;
}

/**
 * Produce a strict, portable registration manifest without database metadata or
 * secrets. Legacy policies are normalized into the current deviceAccess shape.
 */
export function exportOAuthClientManifest(input: OAuthClientManifestSource): OAuthClientManifest {
	return oauthClientManifestSchema.parse({
		kind: OAUTH_CLIENT_MANIFEST_KIND,
		version: OAUTH_CLIENT_MANIFEST_VERSION,
		clientId: input.clientId,
		name: input.name,
		redirectUris: input.redirectUris,
		scopes: input.scopes,
		grantTypes: OAUTH_PUBLIC_CLIENT_GRANT_TYPES,
		publicClient: true,
		policy: normalizeOAuthClientPolicy(input.policyJson),
	});
}

/** Full current policy type, exported for import callers that need no patch semantics. */
export type OAuthClientManifestPolicy = OAuthClientPolicy;
