/**
 * `user_identities.provider` values that both the server and the UI must agree on.
 *
 * They live here, rather than next to the LDAP client, because the UI renders a directory
 * binding differently from a federation link (it cannot be unlinked). Two independent
 * copies of the prefix would drift, and the drift would show up as a button that offers an
 * action the server refuses.
 */

/** Prefix shared by every directory-bound identity. */
export const LDAP_PROVIDER_PREFIX = "ldap:";

/**
 * The single configured directory's provider id.
 *
 * The colon is deliberate: OIDC provider ids are validated against
 * `^[a-z0-9][a-z0-9_-]*$`, so no configured SSO provider id can ever collide with it.
 */
export const LDAP_PROVIDER_ID = `${LDAP_PROVIDER_PREFIX}default`;

/** Whether an identity row is the account's directory login rather than a federation link. */
export function isDirectoryIdentityProvider(provider: string): boolean {
	return provider.startsWith(LDAP_PROVIDER_PREFIX);
}
