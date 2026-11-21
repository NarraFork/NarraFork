import { expect, test } from "bun:test";
import { ValidationError } from "../../errors";
import { matchNoProxyRules } from "../../net/no-proxy";
import { managedManualProxyBypassList } from "../manual-proxy";

const LOOPBACK = ["<-loopback>", "localhost", "*.localhost", "127.0.0.0/8", "[::1]", "0.0.0.0"];

test("manual browser restores explicit loopback after removing Chromium's implicit list", () => {
	// The CIDR also covers Chromium's IPv4-mapped IPv6 loopback equivalents.
	expect(managedManualProxyBypassList("", [])).toEqual(LOOPBACK);
});

test("translates ambient and settings bare hosts to both exact and dotted suffix matches", () => {
	expect(
		managedManualProxyBypassList(" , .ENV.example.test , 192.0.2.1, 2001:db8::1 ", [
			{ match: "wildcard", pattern: " env.example.test " },
			{ match: "wildcard", pattern: ".Cfg.example.test" },
			{ match: "wildcard", pattern: "exact.example.test:8443" },
			{ match: "wildcard", pattern: "2001:db8::1:8443" },
			{ match: "regex", pattern: "a+", enabled: false },
		]),
	).toEqual([
		...LOOPBACK,
		"env.example.test",
		"*.env.example.test",
		"192.0.2.1",
		"*.192.0.2.1",
		"[2001:db8::1]",
		"cfg.example.test",
		"*.cfg.example.test",
		"exact.example.test:8443",
		"[2001:db8::1]:8443",
	]);
});

test("does not mistake a URL glob for a pure hostname wildcard", () => {
	const rules = [{ match: "wildcard", pattern: "*.example.test" }] as const;
	expect(matchNoProxyRules("https://unrelated.test/path.example.test", rules)?.target).toBe("url");
	expect(() => managedManualProxyBypassList("", rules)).toThrow(ValidationError);
});

test.each([
	"https://example.test/private/*",
	"example.test:80",
	"example.test:443",
	"example.test:08443",
	"example.test:65536",
	"example.test;<local>",
])("rejects the non-equivalent settings wildcard %s", (pattern) => {
	expect(() => managedManualProxyBypassList("", [{ match: "wildcard", pattern }])).toThrow(
		"cannot apply proxy bypass rule #1 per request",
	);
});

test.each([
	"example.test:8443",
	"*.example.test",
	"169.254.0.0/16",
	"<-loopback>",
])("does not treat ambient NO_PROXY as raw Chromium syntax: %s", (pattern) => {
	expect(() => managedManualProxyBypassList(`working.test, ${pattern}`, [])).toThrow(
		"cannot apply NO_PROXY entry #2 per request",
	);
});

test("errors identify the rule by position without leaking its text", () => {
	const secret = "fixture-secret";
	const apply = () => managedManualProxyBypassList("", [{ match: "regex", pattern: secret }]);
	expect(apply).toThrow(ValidationError);
	try {
		apply();
	} catch (error) {
		expect(String(error)).toContain("proxy bypass rule #1");
		expect(String(error)).not.toContain(secret);
	}
});

test("an explicit all-host policy makes remaining rules irrelevant", () => {
	expect(managedManualProxyBypassList("not-a-host/16, *", [])).toEqual([...LOOPBACK, "*"]);
	expect(
		managedManualProxyBypassList("", [
			{ match: "regex", pattern: "^https://example.test" },
			{ match: "wildcard", pattern: "*" },
		]),
	).toEqual([...LOOPBACK, "*"]);
});
