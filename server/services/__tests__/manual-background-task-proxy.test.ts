import { expect, test } from "bun:test";
import type { NoProxyRule } from "@shared/proxy-settings";
import { manualCommandProxyEnv } from "../manual-background-task";

const rule = (pattern: string, match: NoProxyRule["match"] = "wildcard", enabled = true) => ({
	id: pattern,
	pattern,
	match,
	enabled,
});

test("publishes the selected proxy and compatible exclusions with both environment spellings", () => {
	const proxy = "http://proxy.test:8888";
	const env = manualCommandProxyEnv(proxy, " startup.test, internal.test ", [
		rule(".Internal.test"),
		rule("service.test"),
		rule("disabled.test", "wildcard", false),
		rule("https://no.test/private/*"),
		rule("^private\\.test$", "regex"),
		rule("other.test:8443"),
	]);
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
		expect(env[name]).toBe(proxy);
		expect(env[name.toLowerCase()]).toBe(proxy);
	}
	expect(env.NO_PROXY).toBe(
		"startup.test,internal.test,localhost,127.0.0.1,::1,0.0.0.0,service.test",
	);
	expect(env.no_proxy).toBe(env.NO_PROXY);
});

test("preserves explicitly configured global exclusion", () => {
	const env = manualCommandProxyEnv("http://proxy.test:8888", "", [rule("*")]);
	expect(env.NO_PROXY.split(",")).toContain("*");
});
