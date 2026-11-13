import { describe, expect, test } from "bun:test";
import {
	adminAuthConfigSchema,
	ldapConnectionTestSchema,
	ldapSettingsInputSchema,
	oidcProviderInputSchema,
} from "../validators/auth";

describe("oidcProviderInputSchema", () => {
	const valid = {
		id: "corp-okta",
		name: "Company SSO",
		issuer: "https://idp.example.com",
		clientId: "client-123",
		clientSecret: "secret",
		scopes: ["openid", "email"],
		allowSignup: true,
		allowedEmailDomains: ["example.com"],
		enabled: true,
	};

	test("accepts a well-formed provider", () => {
		expect(oidcProviderInputSchema.safeParse(valid).success).toBe(true);
	});

	test("clientSecret is optional (omitted = keep stored)", () => {
		const { clientSecret, ...withoutSecret } = valid;
		expect(oidcProviderInputSchema.safeParse(withoutSecret).success).toBe(true);
	});

	test("rejects an invalid provider id", () => {
		expect(oidcProviderInputSchema.safeParse({ ...valid, id: "Corp Okta" }).success).toBe(false);
		expect(oidcProviderInputSchema.safeParse({ ...valid, id: "-bad" }).success).toBe(false);
	});

	test("rejects a non-URL issuer", () => {
		expect(oidcProviderInputSchema.safeParse({ ...valid, issuer: "idp.example.com" }).success).toBe(
			false,
		);
	});

	test("rejects missing required fields", () => {
		expect(oidcProviderInputSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
		expect(oidcProviderInputSchema.safeParse({ ...valid, clientId: "" }).success).toBe(false);
	});
});

describe("adminAuthConfigSchema", () => {
	test("accepts an empty provider list", () => {
		expect(adminAuthConfigSchema.safeParse({ oidcProviders: [] }).success).toBe(true);
	});

	test("accepts providers + optional webauthn", () => {
		const result = adminAuthConfigSchema.safeParse({
			oidcProviders: [
				{
					id: "corp",
					name: "Corp",
					issuer: "https://idp.example.com",
					clientId: "cid",
					clientSecret: "s",
				},
			],
			webauthn: { rpID: "example.com", origins: ["https://example.com"] },
		});
		expect(result.success).toBe(true);
	});

	test("rejects a webauthn origin that is not a URL", () => {
		const result = adminAuthConfigSchema.safeParse({
			oidcProviders: [],
			webauthn: { origins: ["example.com"] },
		});
		expect(result.success).toBe(false);
	});

	test("accepts a full LDAP block and rejects an invalid one", () => {
		const ldap = {
			enabled: true,
			url: "ldaps://dc1.corp.example.com:636",
			bindDn: "cn=svc,dc=example,dc=com",
			bindPassword: "secret",
			searchBase: "dc=example,dc=com",
			searchScope: "sub",
		};
		expect(adminAuthConfigSchema.safeParse({ oidcProviders: [], ldap }).success).toBe(true);
		expect(
			adminAuthConfigSchema.safeParse({
				oidcProviders: [],
				ldap: { ...ldap, url: "https://dc1" },
			}).success,
		).toBe(false);
	});

	test("omitted or null ldap leaves the stored configuration alone", () => {
		expect(adminAuthConfigSchema.safeParse({ oidcProviders: [] }).success).toBe(true);
		expect(adminAuthConfigSchema.safeParse({ oidcProviders: [], ldap: null }).success).toBe(true);
	});
});

describe("ldapSettingsInputSchema", () => {
	const search = {
		enabled: true,
		url: "ldaps://dc1.corp.example.com:636",
		searchBase: "dc=example,dc=com",
	};

	test("accepts a complete search-mode configuration", () => {
		expect(ldapSettingsInputSchema.safeParse(search).success).toBe(true);
		expect(
			ldapSettingsInputSchema.safeParse({
				...search,
				searchFilter: "(&(objectClass=person)(sAMAccountName={username}))",
				usernameAttribute: "sAMAccountName",
				connectTimeoutMs: 8000,
				timeoutMs: 8000,
			}).success,
		).toBe(true);
	});

	test("omitted fields keep their defaults", () => {
		const parsed = ldapSettingsInputSchema.parse(search);
		expect(parsed.mode).toBeUndefined();
		expect(parsed.bindPassword).toBeUndefined();
	});

	test("rejects a non-LDAP or credential-carrying URL", () => {
		expect(ldapSettingsInputSchema.safeParse({ ...search, url: "https://dc1" }).success).toBe(
			false,
		);
		expect(
			ldapSettingsInputSchema.safeParse({ ...search, url: "ldap://cn=admin@dc1" }).success,
		).toBe(false);
		expect(
			ldapSettingsInputSchema.safeParse({ ...search, url: "ldap://dc1/dc=example,dc=com" }).success,
		).toBe(false);
	});

	test("allows a blank URL only while the feature is off", () => {
		expect(ldapSettingsInputSchema.safeParse({ enabled: false, url: "" }).success).toBe(true);
		expect(ldapSettingsInputSchema.safeParse({ enabled: true, url: "" }).success).toBe(false);
	});

	test("requires a search base and a {username} filter in search mode", () => {
		expect(ldapSettingsInputSchema.safeParse({ ...search, searchBase: "" }).success).toBe(false);
		expect(
			ldapSettingsInputSchema.safeParse({ ...search, searchFilter: "(uid=admin)" }).success,
		).toBe(false);
		// The default filter is applied when the field is omitted.
		expect(ldapSettingsInputSchema.safeParse({ ...search, searchFilter: "" }).success).toBe(true);
	});

	test("requires a {username} bind template in direct mode", () => {
		expect(
			ldapSettingsInputSchema.safeParse({
				enabled: true,
				url: "ldaps://dc1",
				mode: "direct",
			}).success,
		).toBe(false);
		expect(
			ldapSettingsInputSchema.safeParse({
				enabled: true,
				url: "ldaps://dc1",
				mode: "direct",
				bindDnTemplate: "uid=admin,dc=example,dc=com",
			}).success,
		).toBe(false);
		expect(
			ldapSettingsInputSchema.safeParse({
				enabled: true,
				url: "ldaps://dc1",
				mode: "direct",
				bindDnTemplate: "{username}@corp.example.com",
			}).success,
		).toBe(true);
	});

	test("rejects StartTLS on ldaps:// and a service DN without a password", () => {
		expect(ldapSettingsInputSchema.safeParse({ ...search, startTls: true }).success).toBe(false);
		expect(
			ldapSettingsInputSchema.safeParse({
				...search,
				url: "ldap://dc1:389",
				startTls: true,
			}).success,
		).toBe(true);
		expect(
			ldapSettingsInputSchema.safeParse({ ...search, bindDn: "cn=svc,dc=x", bindPassword: "" })
				.success,
		).toBe(false);
		expect(
			ldapSettingsInputSchema.safeParse({ ...search, bindDn: "cn=svc,dc=x", bindPassword: "pw" })
				.success,
		).toBe(true);
	});

	test("bindPassword is optional so an update can keep the stored one", () => {
		expect(ldapSettingsInputSchema.safeParse({ ...search, bindDn: "" }).success).toBe(true);
		expect(ldapSettingsInputSchema.safeParse({ ...search, bindPassword: undefined }).success).toBe(
			true,
		);
	});

	test("rejects an out-of-range timeout", () => {
		expect(ldapSettingsInputSchema.safeParse({ ...search, timeoutMs: 10 }).success).toBe(false);
		expect(ldapSettingsInputSchema.safeParse({ ...search, timeoutMs: 60_000 }).success).toBe(false);
	});
});

describe("ldapConnectionTestSchema", () => {
	test("accepts an empty request (test the stored settings)", () => {
		expect(ldapConnectionTestSchema.safeParse({}).success).toBe(true);
	});

	test("accepts unsaved form values plus a test account", () => {
		expect(
			ldapConnectionTestSchema.safeParse({
				config: { enabled: false, url: "ldaps://dc1", searchBase: "dc=x" },
				username: "alice",
				password: "pw",
			}).success,
		).toBe(true);
	});

	test("still validates the nested config", () => {
		expect(
			ldapConnectionTestSchema.safeParse({ config: { enabled: true, url: "https://dc1" } }).success,
		).toBe(false);
	});
});
