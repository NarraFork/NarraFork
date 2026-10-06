/**
 * Per-provider outbound proxy overrides.
 *
 * Every built-in provider has had `settings.<provider>.proxy`, letting one provider go through
 * a proxy while another goes direct. A plugin provider had no equivalent — the host resolved a
 * single global proxy for all of them — because a plugin's contribution id is not a key in the
 * settings schema and `resolveHostHints()` did not know which provider it was answering for.
 *
 * The subtle case, and the reason these tests exist, is `mode: "direct"`. Resolving it yields
 * no proxy URL, so a resolver that reports "nothing to say" when it has no URL would leave the
 * plugin using whatever proxy it last applied — silently restoring the global proxy the user
 * explicitly opted out of. An explicit override therefore has to speak even when its answer is
 * "no proxy".
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "@server/lib/errors";
import { PluginStateStore } from "@server/services/plugin-state-store";

const roots: string[] = [];

async function makeStore() {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-proxy-"));
	roots.push(root);
	return new PluginStateStore({ root });
}

async function cleanup() {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

describe("plugin provider proxy persistence", () => {
	it("stores and reads back a custom proxy", async () => {
		const store = await makeStore();
		await store.setProviderProxy("com.example.demo", "acme", {
			mode: "custom",
			url: "http://127.0.0.1:7890",
		});
		const record = await store.get("com.example.demo");
		expect(record?.providerProxies.acme).toEqual({
			mode: "custom",
			url: "http://127.0.0.1:7890",
		});
		await cleanup();
	});

	it("keeps direct as a stored decision, not an absence", async () => {
		// `direct` must survive as an explicit choice: collapsing it to "no entry" would make it
		// indistinguishable from following the global proxy, which is the opposite intent.
		const store = await makeStore();
		await store.setProviderProxy("com.example.demo", "acme", { mode: "direct" });
		const record = await store.get("com.example.demo");
		expect(record?.providerProxies.acme).toEqual({ mode: "direct" });
		await cleanup();
	});

	it("treats default as clearing the override", async () => {
		// `default` *is* following the global policy, so storing a row for it would only add
		// state that behaves exactly like no state.
		const store = await makeStore();
		await store.setProviderProxy("com.example.demo", "acme", { mode: "custom", url: "http://p" });
		await store.setProviderProxy("com.example.demo", "acme", { mode: "default" });
		const record = await store.get("com.example.demo");
		expect(record?.providerProxies.acme).toBeUndefined();
		await cleanup();
	});

	it("clears the override when passed null", async () => {
		const store = await makeStore();
		await store.setProviderProxy("com.example.demo", "acme", { mode: "custom", url: "http://p" });
		await store.setProviderProxy("com.example.demo", "acme", null);
		const record = await store.get("com.example.demo");
		expect(record?.providerProxies.acme).toBeUndefined();
		await cleanup();
	});

	it("rejects a custom proxy with no url", async () => {
		const store = await makeStore();
		await expect(
			store.setProviderProxy("com.example.demo", "acme", { mode: "custom" }),
		).rejects.toBeInstanceOf(ValidationError);
		await cleanup();
	});

	it("rejects a url that is not parseable", async () => {
		// The value is handed to an HTTP agent, where a malformed string surfaces as an opaque
		// request failure rather than a configuration error.
		const store = await makeStore();
		await expect(
			store.setProviderProxy("com.example.demo", "acme", { mode: "custom", url: "not a url" }),
		).rejects.toBeInstanceOf(ValidationError);
		await cleanup();
	});

	it("rejects a scheme an HTTP agent cannot use", async () => {
		const store = await makeStore();
		await expect(
			store.setProviderProxy("com.example.demo", "acme", {
				mode: "custom",
				url: "ftp://proxy.example",
			}),
		).rejects.toBeInstanceOf(ValidationError);
		await cleanup();
	});

	it("accepts a socks proxy", async () => {
		const store = await makeStore();
		await store.setProviderProxy("com.example.demo", "acme", {
			mode: "custom",
			url: "socks5://127.0.0.1:1080",
		});
		const record = await store.get("com.example.demo");
		expect(record?.providerProxies.acme?.mode).toBe("custom");
		await cleanup();
	});

	it("keeps overrides for different contributions independent", async () => {
		// The whole point of a per-provider override: one provider proxied, another direct.
		const store = await makeStore();
		await store.setProviderProxy("com.example.demo", "acme", {
			mode: "custom",
			url: "http://127.0.0.1:7890",
		});
		await store.setProviderProxy("com.example.demo", "other", { mode: "direct" });
		const record = await store.get("com.example.demo");
		expect(record?.providerProxies.acme?.url).toBe("http://127.0.0.1:7890");
		expect(record?.providerProxies.other).toEqual({ mode: "direct" });
		await cleanup();
	});

	it("drops overrides for contributions the plugin no longer declares", async () => {
		// A leftover row would silently reapply if the contribution id ever came back.
		const store = await makeStore();
		await store.setProviderProxy("com.example.demo", "acme", { mode: "direct" });
		await store.setProviderProxy("com.example.demo", "gone", { mode: "direct" });
		await store.pruneProviderConfigs("com.example.demo", ["acme"]);
		const record = await store.get("com.example.demo");
		expect(record?.providerProxies.acme).toEqual({ mode: "direct" });
		expect(record?.providerProxies.gone).toBeUndefined();
		await cleanup();
	});

	it("is visible to synchronous readers through the cached state", async () => {
		// The request path resolves the override synchronously; awaiting a load there would put
		// file I/O in front of every chat call.
		const store = await makeStore();
		await store.setProviderProxy("com.example.demo", "acme", { mode: "direct" });
		expect(store.getCachedState("com.example.demo")?.providerProxies.acme).toEqual({
			mode: "direct",
		});
		await cleanup();
	});

	it("survives a reload from disk", async () => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-proxy-reload-"));
		roots.push(root);
		const first = new PluginStateStore({ root });
		await first.setProviderProxy("com.example.demo", "acme", {
			mode: "custom",
			url: "http://127.0.0.1:7890",
		});
		// A fresh store over the same root reads the persisted document.
		const second = new PluginStateStore({ root });
		const record = await second.get("com.example.demo");
		expect(record?.providerProxies.acme).toEqual({
			mode: "custom",
			url: "http://127.0.0.1:7890",
		});
		await cleanup();
	});
});
