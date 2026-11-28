/**
 * no_proxy rule engine: matching semantics, priority, and integration with the
 * shared proxy resolver every channel uses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	isBareHostPattern,
	isNoProxyTarget,
	matchNoProxyRules,
	resetNoProxyRuleCacheForTest,
	wildcardToRegExp,
} from "@server/lib/net/no-proxy";
import {
	applyProxyExemptions,
	explainProxyBypass,
	getNoProxyRules,
	resolveProxyForUrl,
} from "@server/lib/net/proxy";
import { neutralizeAmbientProxyEnv, resetProxyEnvStateForTest } from "@server/lib/net/proxy-env";
import { settings } from "@server/lib/settings";
import type { NoProxyRule } from "@shared/proxy-settings";

const ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];

function wildcard(pattern: string, enabled = true): NoProxyRule {
	return { match: "wildcard", pattern, enabled };
}

function regex(pattern: string, enabled = true): NoProxyRule {
	return { match: "regex", pattern, enabled };
}

describe("no_proxy wildcard rules", () => {
	test("converts globs into anchored case-insensitive patterns", () => {
		expect(wildcardToRegExp("*.example.com").test("api.example.com")).toBe(true);
		expect(wildcardToRegExp("api?.example.com").test("api1.example.com")).toBe(true);
		expect(wildcardToRegExp("api?.example.com").test("api12.example.com")).toBe(false);
		// Anchored: a suffix cannot be matched by a prefix glob.
		expect(wildcardToRegExp("api.example.com").test("api.example.com.evil.test")).toBe(false);
	});

	test("matches subdomain globs against the host", () => {
		const rules = [wildcard("*.internal.example.com")];
		expect(matchNoProxyRules("https://api.internal.example.com/v1", rules)).toMatchObject({
			kind: "wildcard",
			target: "host",
		});
		expect(isNoProxyTarget("https://internal.example.com", rules)).toBe(false);
		expect(isNoProxyTarget("https://api.public.example.com", rules)).toBe(false);
	});

	test("matches full-URL globs including scheme and path", () => {
		const rules = [wildcard("https://api.example.com/*")];
		expect(isNoProxyTarget("https://api.example.com/v1/models", rules)).toBe(true);
		expect(isNoProxyTarget("http://api.example.com/v1/models", rules)).toBe(false);
		expect(isNoProxyTarget("https://other.example.com/v1/models", rules)).toBe(false);
	});

	test("bare host patterns behave like NO_PROXY entries", () => {
		expect(isBareHostPattern("example.com")).toBe(true);
		expect(isBareHostPattern(".example.com")).toBe(true);
		expect(isBareHostPattern("*.example.com")).toBe(false);

		const rules = [wildcard("example.com")];
		expect(isNoProxyTarget("https://example.com", rules)).toBe(true);
		expect(isNoProxyTarget("https://api.example.com", rules)).toBe(true);
		// A suffix must be on a label boundary.
		expect(isNoProxyTarget("https://notexample.com", rules)).toBe(false);
	});

	test("bare host patterns with a port only match that port", () => {
		const rules = [wildcard("example.com:8443")];
		expect(isNoProxyTarget("https://example.com:8443/x", rules)).toBe(true);
		expect(isNoProxyTarget("https://example.com:9443/x", rules)).toBe(false);
		expect(isNoProxyTarget("https://example.com/x", rules)).toBe(false);
	});
});

describe("no_proxy regex rules", () => {
	test("matches the host candidate", () => {
		const rules = [regex("^api\\d+\\.example\\.com$")];
		expect(isNoProxyTarget("https://api42.example.com/v1", rules)).toBe(true);
		expect(isNoProxyTarget("https://api.example.com/v1", rules)).toBe(false);
	});

	test("can match scheme, port and path of the full URL", () => {
		expect(
			isNoProxyTarget("https://api.example.com/v1", [
				regex("^https://(api|files)\\.example\\.com/"),
			]),
		).toBe(true);
		// The `host:port` candidate covers port-anchored patterns in both spellings.
		expect(isNoProxyTarget("http://api.example.com:8080/", [regex(":(8080|8443)$")])).toBe(true);
		expect(isNoProxyTarget("http://api.example.com:8080", [regex(":(8080|8443)$")])).toBe(true);
		expect(isNoProxyTarget("https://api.example.com/v1", [regex(":(8080|8443)$")])).toBe(false);
	});

	test("an invalid regex never exempts anything", () => {
		expect(isNoProxyTarget("https://api.example.com", [regex("([unclosed")])).toBe(false);
	});
});

describe("no_proxy rule priority", () => {
	test("regex rules win over wildcard rules regardless of list order", () => {
		const rules = [
			wildcard("*example.com"),
			regex("^api\\.example\\.com$"),
			regex("^other\\.example\\.com$"),
		];
		expect(matchNoProxyRules("https://api.example.com", rules)).toMatchObject({
			kind: "regex",
			pattern: "^api\\.example\\.com$",
		});
		// A wildcard still applies when no regex matches.
		expect(matchNoProxyRules("https://files.example.com", rules)).toMatchObject({
			kind: "wildcard",
		});
	});

	test("first match wins inside one kind", () => {
		const rules = [regex("^api\\.example\\.com$"), regex("^api")];
		expect(matchNoProxyRules("https://api.example.com", rules)).toMatchObject({
			pattern: "^api\\.example\\.com$",
		});
	});

	test("disabled rules are skipped", () => {
		const rules = [regex("^api\\.example\\.com$", false), wildcard("*.example.com")];
		expect(matchNoProxyRules("https://api.example.com", rules)).toMatchObject({
			kind: "wildcard",
		});
		expect(isNoProxyTarget("https://api.example.com", [wildcard("*", false)])).toBe(false);
	});

	test("an empty or missing rule list exempts nothing", () => {
		expect(matchNoProxyRules("https://api.example.com", [])).toBeUndefined();
		expect(matchNoProxyRules("https://api.example.com", undefined)).toBeUndefined();
	});

	test("unparseable targets are never exempted", () => {
		expect(isNoProxyTarget("not a url", [wildcard("*")])).toBe(false);
	});
});

describe("no_proxy rules reach the shared proxy resolver", () => {
	let savedEnv: Record<string, string | undefined>;
	let savedProxy: typeof settings.proxy;

	beforeEach(() => {
		savedEnv = {};
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		savedProxy = settings.proxy;
		resetProxyRuleCache();
		resetProxyEnvStateForTest();
		neutralizeAmbientProxyEnv();
		settings.proxy = { mode: "custom", url: "http://proxy.local:3128", noProxyRules: [] };
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		settings.proxy = savedProxy;
		resetProxyEnvStateForTest();
		resetProxyRuleCache();
	});

	test("a matching rule exempts the target for every channel resolver", () => {
		settings.proxy = {
			mode: "custom",
			url: "http://proxy.local:3128",
			noProxyRules: [wildcard("*.internal.example.com")],
		};
		expect(resolveProxyForUrl("https://api.internal.example.com/v1")).toBeUndefined();
		// Other proxies on the same host still apply.
		expect(resolveProxyForUrl("https://api.example.com/v1")).toBe("http://proxy.local:3128");
		expect(applyProxyExemptions("http://other:8080", "https://git.internal.example.com")).toBe(
			undefined,
		);
	});

	test("rules apply to per-location overrides too", () => {
		settings.proxy = {
			mode: "custom",
			url: "http://proxy.local:3128",
			noProxyRules: [regex("^api\\.example\\.com$")],
		};
		expect(
			resolveProxyForUrl("https://api.example.com", { mode: "custom", url: "http://ovr:9000" }),
		).toBeUndefined();
		expect(
			resolveProxyForUrl("https://files.example.com", { mode: "custom", url: "http://ovr:9000" }),
		).toBe("http://ovr:9000");
	});

	test("loopback stays exempt and takes priority over rules", () => {
		settings.proxy = {
			mode: "custom",
			url: "http://proxy.local:3128",
			noProxyRules: [wildcard("*")],
		};
		expect(resolveProxyForUrl("http://127.0.0.1:7800/v1")).toBeUndefined();
		expect(explainProxyBypass("http://127.0.0.1:7800/v1")).toEqual({ kind: "loopback" });
	});

	test("loopback wins over a rule that would otherwise match", () => {
		settings.proxy = {
			mode: "custom",
			url: "http://proxy.local:3128",
			noProxyRules: [regex("^127\\.0\\.0\\.1$")],
		};
		expect(explainProxyBypass("http://127.0.0.1:7800")).toEqual({ kind: "loopback" });
	});

	test("ambient NO_PROXY is still honoured alongside rules", () => {
		process.env.NO_PROXY = "envonly.example.com";
		resetProxyEnvStateForTest();
		neutralizeAmbientProxyEnv();
		settings.proxy = {
			mode: "custom",
			url: "http://proxy.local:3128",
			noProxyRules: [wildcard("ruleonly.example.com")],
		};
		expect(explainProxyBypass("https://envonly.example.com")).toEqual({ kind: "no_proxy_env" });
		expect(explainProxyBypass("https://ruleonly.example.com")).toMatchObject({ kind: "rule" });
		expect(resolveProxyForUrl("https://proxied.example.com")).toBe("http://proxy.local:3128");
	});

	test("direct mode stays direct and reports no rules", () => {
		settings.proxy = { mode: "direct", noProxyRules: [wildcard("*.example.com")] };
		expect(getNoProxyRules()).toHaveLength(1);
		expect(resolveProxyForUrl("https://api.example.com")).toBeUndefined();
	});
});

function resetProxyRuleCache(): void {
	resetNoProxyRuleCacheForTest();
}

/**
 * The three override choices a user can pick in "各处单独覆盖" must each end up
 * filtered by the same rule list:
 *   - custom  → the override's own URL
 *   - system  → the ambient HTTPS_PROXY snapshot
 *   - default → the global `settings.proxy` policy
 * Every proxied channel resolves through `resolveProxyForUrl` /
 * `applyProxyExemptions`, so asserting both entry points covers the channels
 * that cannot ask per request (WebSocket clients, IM gateway agents, token
 * refresh, usage probes) as well as the ordinary per-request fetches.
 */
describe("no_proxy rules apply to every override choice", () => {
	const GLOBAL_PROXY = "http://global.proxy:3128";
	const SYSTEM_PROXY = "http://system.proxy:8080";
	const OVERRIDE_PROXY = "http://override.proxy:9000";
	const EXEMPT_HOST = "https://api.internal.example.com/v1";
	const EXEMPT_BY_REGEX = "https://regex-only.example.org/v1";
	const PROXIED_HOST = "https://api.public.example.com/v1";

	let savedEnv: Record<string, string | undefined>;
	let savedProxy: typeof settings.proxy;

	function rules(): NoProxyRule[] {
		return [regex("^https://regex-only\\.example\\.org/"), wildcard("*.internal.example.com")];
	}

	function setAmbientProxy(vars: Record<string, string>): void {
		resetProxyEnvStateForTest();
		for (const [key, value] of Object.entries(vars)) process.env[key] = value;
		neutralizeAmbientProxyEnv();
	}

	beforeEach(() => {
		savedEnv = {};
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		savedProxy = settings.proxy;
		resetProxyRuleCache();
		resetProxyEnvStateForTest();
		neutralizeAmbientProxyEnv();
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		settings.proxy = savedProxy;
		resetProxyEnvStateForTest();
		resetProxyRuleCache();
	});

	test("custom override: rules still exempt targets", () => {
		settings.proxy = { mode: "direct", noProxyRules: rules() };
		const override = { mode: "custom" as const, url: OVERRIDE_PROXY };
		expect(resolveProxyForUrl(EXEMPT_HOST, override)).toBeUndefined();
		expect(resolveProxyForUrl(EXEMPT_BY_REGEX, override)).toBeUndefined();
		expect(resolveProxyForUrl(PROXIED_HOST, override)).toBe(OVERRIDE_PROXY);
		expect(applyProxyExemptions(OVERRIDE_PROXY, EXEMPT_HOST)).toBeUndefined();
	});

	test("system override: rules still exempt targets", () => {
		settings.proxy = { mode: "direct", noProxyRules: rules() };
		setAmbientProxy({ HTTPS_PROXY: SYSTEM_PROXY });
		const override = { mode: "system" as const };
		expect(resolveProxyForUrl(EXEMPT_HOST, override)).toBeUndefined();
		expect(resolveProxyForUrl(EXEMPT_BY_REGEX, override)).toBeUndefined();
		expect(resolveProxyForUrl(PROXIED_HOST, override)).toBe(SYSTEM_PROXY);
		expect(applyProxyExemptions(SYSTEM_PROXY, EXEMPT_HOST)).toBeUndefined();
	});

	test("default override inheriting a custom global: rules still exempt targets", () => {
		settings.proxy = { mode: "custom", url: GLOBAL_PROXY, noProxyRules: rules() };
		const override = { mode: "default" as const };
		expect(resolveProxyForUrl(EXEMPT_HOST, override)).toBeUndefined();
		expect(resolveProxyForUrl(EXEMPT_BY_REGEX, override)).toBeUndefined();
		expect(resolveProxyForUrl(PROXIED_HOST, override)).toBe(GLOBAL_PROXY);
		// No override at all resolves the same way.
		expect(resolveProxyForUrl(EXEMPT_HOST)).toBeUndefined();
		expect(resolveProxyForUrl(PROXIED_HOST)).toBe(GLOBAL_PROXY);
	});

	test("default override inheriting a system global: rules still exempt targets", () => {
		settings.proxy = { mode: "system", noProxyRules: rules() };
		setAmbientProxy({ HTTPS_PROXY: SYSTEM_PROXY });
		expect(resolveProxyForUrl(EXEMPT_HOST, { mode: "default" })).toBeUndefined();
		expect(resolveProxyForUrl(PROXIED_HOST, { mode: "default" })).toBe(SYSTEM_PROXY);
		expect(resolveProxyForUrl(EXEMPT_HOST)).toBeUndefined();
	});

	test("disabled rules leave every override choice proxied", () => {
		settings.proxy = {
			mode: "direct",
			noProxyRules: [wildcard("*.internal.example.com", false)],
		};
		setAmbientProxy({ HTTPS_PROXY: SYSTEM_PROXY });
		expect(resolveProxyForUrl(EXEMPT_HOST, { mode: "custom", url: OVERRIDE_PROXY })).toBe(
			OVERRIDE_PROXY,
		);
		expect(resolveProxyForUrl(EXEMPT_HOST, { mode: "system" })).toBe(SYSTEM_PROXY);
		expect(
			resolveProxyForUrl(EXEMPT_HOST, { mode: "default" }) ?? resolveProxyForUrl(EXEMPT_HOST),
		).toBeUndefined(); // global mode is "direct": nothing to proxy either way
	});

	test("override modes that bypass the proxy entirely are unaffected by rules", () => {
		settings.proxy = { mode: "custom", url: GLOBAL_PROXY, noProxyRules: rules() };
		expect(resolveProxyForUrl(PROXIED_HOST, { mode: "direct" })).toBeUndefined();
		expect(explainProxyBypass(PROXIED_HOST)).toBeUndefined();
	});
});
