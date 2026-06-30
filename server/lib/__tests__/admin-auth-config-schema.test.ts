import { describe, expect, test } from "bun:test";
import { adminAuthConfigSchema, oidcProviderInputSchema } from "../validators/auth";

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
});
