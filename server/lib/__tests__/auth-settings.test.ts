import { describe, expect, test } from "bun:test";
import { isMaskedSecret, maskAuthSettings, maskSecret } from "../auth-settings";
import type { NarraForkSettings } from "../settings/types";

type AuthSettings = NarraForkSettings["auth"];

describe("maskSecret", () => {
	test("masks long secrets to stars + last 4", () => {
		expect(maskSecret("supersecretvalue1234")).toBe("********1234");
	});
	test("short secrets become all stars", () => {
		expect(maskSecret("abcd")).toBe("****");
		expect(maskSecret("ab")).toBe("**");
	});
	test("empty / undefined → empty string", () => {
		expect(maskSecret("")).toBe("");
		expect(maskSecret(undefined)).toBe("");
	});
});

describe("isMaskedSecret", () => {
	test("empty / undefined counts as masked (keep existing)", () => {
		expect(isMaskedSecret("")).toBe(true);
		expect(isMaskedSecret(undefined)).toBe(true);
		expect(isMaskedSecret(null)).toBe(true);
	});
	test("values containing stars are masked", () => {
		expect(isMaskedSecret("********1234")).toBe(true);
	});
	test("a real secret is not masked", () => {
		expect(isMaskedSecret("realSecret1234")).toBe(false);
	});
	test("a real secret containing a star (mid-string) is NOT masked", () => {
		// OIDC client secrets can contain `*`; only a LEADING star means masked.
		expect(isMaskedSecret("re*lSecret1234")).toBe(false);
		expect(isMaskedSecret("abc*")).toBe(false);
		expect(isMaskedSecret("s3cr3t*v4lue")).toBe(false);
	});
});

describe("maskAuthSettings", () => {
	const auth: AuthSettings = {
		jwtSecret: "TOP-SECRET-JWT",
		registrationOpen: true,
		webauthn: { rpID: "narrafork.example.com", origins: ["https://narrafork.example.com"] },
		oidcProviders: [
			{
				id: "corp",
				name: "Company SSO",
				issuer: "https://idp.example.com",
				clientId: "client-123",
				clientSecret: "the-real-client-secret-xyz",
				scopes: ["openid", "email"],
				allowSignup: true,
				allowedEmailDomains: ["example.com"],
				enabled: true,
			},
		],
	};

	test("removes jwtSecret entirely", () => {
		const masked = maskAuthSettings(auth) as Record<string, unknown>;
		expect("jwtSecret" in masked).toBe(false);
	});

	test("masks each OIDC client secret", () => {
		const masked = maskAuthSettings(auth);
		expect(masked.oidcProviders?.[0].clientSecret).toBe("********-xyz");
		// The plaintext must never appear.
		expect(JSON.stringify(masked)).not.toContain("the-real-client-secret-xyz");
	});

	test("preserves non-secret OIDC fields and webauthn config", () => {
		const masked = maskAuthSettings(auth);
		const p = masked.oidcProviders?.[0];
		expect(p?.id).toBe("corp");
		expect(p?.issuer).toBe("https://idp.example.com");
		expect(p?.clientId).toBe("client-123");
		expect(p?.scopes).toEqual(["openid", "email"]);
		expect(p?.allowSignup).toBe(true);
		expect(masked.webauthn?.rpID).toBe("narrafork.example.com");
		expect(masked.registrationOpen).toBe(true);
	});

	test("handles missing oidcProviders / webauthn", () => {
		const minimal: AuthSettings = { jwtSecret: "x", registrationOpen: false };
		const masked = maskAuthSettings(minimal);
		expect(masked.oidcProviders).toBeUndefined();
		expect(masked.registrationOpen).toBe(false);
	});

	test("masks the LDAP service-account password and keeps the rest", () => {
		const masked = maskAuthSettings({
			...auth,
			ldap: {
				enabled: true,
				url: "ldaps://dc1.corp.example.com:636",
				bindDn: "cn=svc,dc=example,dc=com",
				bindPassword: "the-real-bind-password",
				searchBase: "dc=example,dc=com",
			},
		});
		expect(masked.ldap?.bindPassword).toBe("********word");
		expect(JSON.stringify(masked)).not.toContain("the-real-bind-password");
		// Everything an admin needs to see to edit the form stays readable.
		expect(masked.ldap?.url).toBe("ldaps://dc1.corp.example.com:636");
		expect(masked.ldap?.bindDn).toBe("cn=svc,dc=example,dc=com");
		expect(masked.ldap?.searchBase).toBe("dc=example,dc=com");
		expect(masked.ldap?.enabled).toBe(true);
	});

	test("the masked LDAP password is recognized as masked on write", () => {
		const masked = maskAuthSettings({
			...auth,
			ldap: { enabled: true, url: "ldaps://dc1", bindPassword: "the-real-bind-password" },
		});
		// Sending the redacted value back must not overwrite the stored secret.
		expect(isMaskedSecret(masked.ldap?.bindPassword)).toBe(true);
	});

	test("leaves the ldap block absent when no directory is configured", () => {
		const masked = maskAuthSettings(auth);
		expect(masked.ldap).toBeUndefined();
	});
});
