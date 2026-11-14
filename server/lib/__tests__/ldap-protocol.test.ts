import { describe, expect, test } from "bun:test";
import {
	describeLdapConfigProblem,
	escapeDnValue,
	escapeFilterValue,
	hasUsernamePlaceholder,
	isSupportedLdapUrl,
	LDAP_DEFAULT_SEARCH_FILTER,
	normalizeLdapUsername,
	renderFilterTemplate,
	renderUsernameTemplate,
	sanitizeDerivedUsername,
} from "../ldap/protocol";
import type { LdapSettings } from "../settings/types";

describe("isSupportedLdapUrl", () => {
	test("accepts ldap and ldaps endpoints", () => {
		expect(isSupportedLdapUrl("ldap://dc1.corp.example.com")).toBe(true);
		expect(isSupportedLdapUrl("ldap://dc1.corp.example.com:389")).toBe(true);
		expect(isSupportedLdapUrl("ldaps://dc1.corp.example.com:636")).toBe(true);
		expect(isSupportedLdapUrl("  ldaps://dc1.corp.example.com  ")).toBe(true);
	});

	test("rejects other schemes", () => {
		expect(isSupportedLdapUrl("http://dc1.corp.example.com")).toBe(false);
		expect(isSupportedLdapUrl("ldapi://%2Fvar%2Frun%2Fslapd.sock")).toBe(false);
		expect(isSupportedLdapUrl("dc1.corp.example.com:389")).toBe(false);
		expect(isSupportedLdapUrl("")).toBe(false);
	});

	test("rejects a URL carrying credentials, a path or a query", () => {
		// A bind DN smuggled into the URL is how an operator ends up binding as an
		// account they did not configure.
		expect(isSupportedLdapUrl("ldap://cn=admin,dc=x@dc1:389")).toBe(false);
		expect(isSupportedLdapUrl("ldap://user:pw@dc1:389")).toBe(false);
		expect(isSupportedLdapUrl("ldap://dc1:389/dc=example,dc=com")).toBe(false);
		expect(isSupportedLdapUrl("ldap://dc1:389?sizelimit=1")).toBe(false);
	});
});

describe("escapeFilterValue", () => {
	test("escapes every RFC 4515 special character", () => {
		expect(escapeFilterValue("a\\b")).toBe("a\\5cb");
		expect(escapeFilterValue("a*b")).toBe("a\\2ab");
		expect(escapeFilterValue("a(b")).toBe("a\\28b");
		expect(escapeFilterValue("a)b")).toBe("a\\29b");
		expect(escapeFilterValue("a\0b")).toBe("a\\00b");
	});

	test("leaves ordinary names untouched", () => {
		expect(escapeFilterValue("alice.smith")).toBe("alice.smith");
		expect(escapeFilterValue("alice@corp")).toBe("alice@corp");
	});

	test("a filter metacharacter cannot widen the match", () => {
		const injected = renderFilterTemplate("(uid={username})", "*)(uid=*");
		// Every `*`, `(` and `)` from the input is neutralized, so the filter still
		// describes exactly one (impossible) uid rather than "any entry".
		expect(injected).toBe("(uid=\\2a\\29\\28uid=\\2a)");
		expect(injected.match(/\*/g)).toBeNull();
	});
});

describe("escapeDnValue", () => {
	test("escapes the reserved characters", () => {
		expect(escapeDnValue("a,b")).toBe("a\\,b");
		expect(escapeDnValue("a+b")).toBe("a\\+b");
		expect(escapeDnValue('a"b')).toBe('a\\"b');
		expect(escapeDnValue("a<b>c")).toBe("a\\<b\\>c");
		expect(escapeDnValue("a;b")).toBe("a\\;b");
		expect(escapeDnValue("a=b")).toBe("a\\=b");
		expect(escapeDnValue("a\\b")).toBe("a\\\\b");
	});

	test("escapes a leading '#' and leading/trailing spaces only", () => {
		expect(escapeDnValue("#alice")).toBe("\\#alice");
		expect(escapeDnValue(" alice")).toBe("\\ alice");
		expect(escapeDnValue("alice ")).toBe("alice\\ ");
		// An inner '#' or space needs no escape.
		expect(escapeDnValue("al ice#1")).toBe("al ice#1");
	});
});

describe("renderUsernameTemplate", () => {
	test("substitutes the escaped name once per placeholder", () => {
		expect(renderUsernameTemplate("uid={username},ou=people", "alice")).toBe("uid=alice,ou=people");
		expect(renderUsernameTemplate("{username}@corp.example.com", "alice")).toBe(
			"alice@corp.example.com",
		);
		expect(renderUsernameTemplate("{username}/{username}", "alice")).toBe("alice/alice");
	});

	test("escapes the substituted value", () => {
		expect(renderUsernameTemplate("uid={username},dc=x", "a,b")).toBe("uid=a\\,b,dc=x");
	});

	test("refuses a template without the placeholder", () => {
		// A template with no placeholder would bind every login as one fixed account.
		expect(() => renderUsernameTemplate("uid=admin,dc=x", "alice")).toThrow(
			"LDAP template must contain {username}",
		);
		expect(hasUsernamePlaceholder("{username}@corp")).toBe(true);
		expect(hasUsernamePlaceholder("{user}@corp")).toBe(false);
	});
});

describe("sanitizeDerivedUsername", () => {
	test("produces a users.username-compatible value", () => {
		const valid = /^[a-z0-9_-]{3,50}$/;
		expect(sanitizeDerivedUsername("Alice.Smith")).toMatch(valid);
		expect(sanitizeDerivedUsername("alice.smith")).toBe("alicesmith");
		expect(sanitizeDerivedUsername("  ALICE  ")).toBe("alice");
		expect(sanitizeDerivedUsername("a")).toMatch(valid);
		expect(sanitizeDerivedUsername("张三")).toMatch(valid);
	});

	test("caps the length at 50", () => {
		expect(sanitizeDerivedUsername("a".repeat(120))).toHaveLength(50);
	});
});

describe("normalizeLdapUsername", () => {
	test("trims and strips control characters", () => {
		expect(normalizeLdapUsername("  alice  ")).toBe("alice");
		expect(normalizeLdapUsername("ali\u0000ce")).toBe("alice");
		expect(normalizeLdapUsername("ali\u001fce")).toBe("alice");
	});

	test("rejects empty and non-string input", () => {
		expect(normalizeLdapUsername("")).toBe("");
		expect(normalizeLdapUsername("   ")).toBe("");
		expect(normalizeLdapUsername(undefined)).toBe("");
		expect(normalizeLdapUsername(42)).toBe("");
	});
});

describe("describeLdapConfigProblem", () => {
	const base: LdapSettings = {
		enabled: true,
		url: "ldaps://dc1.corp.example.com:636",
		searchBase: "dc=example,dc=com",
	};

	test("accepts a complete search-mode configuration", () => {
		expect(describeLdapConfigProblem(base)).toBeNull();
		expect(
			describeLdapConfigProblem({ ...base, searchFilter: LDAP_DEFAULT_SEARCH_FILTER }),
		).toBeNull();
	});

	test("reports a switched-off directory", () => {
		expect(describeLdapConfigProblem({ ...base, enabled: false })).toBe("LDAP is disabled");
		// ...unless the caller is the admin test button.
		expect(
			describeLdapConfigProblem({ ...base, enabled: false }, { ignoreEnabled: true }),
		).toBeNull();
	});

	test("requires a URL and a search base", () => {
		expect(describeLdapConfigProblem({ ...base, url: "" })).toContain("Server URL is required");
		expect(describeLdapConfigProblem({ ...base, url: "https://dc1" })).toContain("ldap://");
		expect(describeLdapConfigProblem({ ...base, searchBase: "  " })).toContain("Search base DN");
	});

	test("requires {username} in the filter and the direct-mode template", () => {
		expect(describeLdapConfigProblem({ ...base, searchFilter: "(uid=admin)" })).toContain(
			"{username}",
		);
		expect(describeLdapConfigProblem({ ...base, mode: "direct" })).toContain("template");
		expect(
			describeLdapConfigProblem({ ...base, mode: "direct", bindDnTemplate: "uid=admin,dc=x" }),
		).toContain("{username}");
		expect(
			describeLdapConfigProblem({ ...base, mode: "direct", bindDnTemplate: "uid={username},dc=x" }),
		).toBeNull();
	});

	test("rejects StartTLS on an already-encrypted URL", () => {
		expect(describeLdapConfigProblem({ ...base, startTls: true })).toContain("StartTLS");
		expect(
			describeLdapConfigProblem({ ...base, url: "ldap://dc1:389", startTls: true }),
		).toBeNull();
	});

	test("rejects a service DN with no password (unauthenticated bind)", () => {
		expect(describeLdapConfigProblem({ ...base, bindDn: "cn=svc,dc=x" })).toContain(
			"bind password",
		);
		expect(
			describeLdapConfigProblem({ ...base, bindDn: "cn=svc,dc=x", bindPassword: "s3cret" }),
		).toBeNull();
	});
});
