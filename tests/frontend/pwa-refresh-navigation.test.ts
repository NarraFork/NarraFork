import { expect, test } from "bun:test";

// Execute the actual first route registration without loading Workbox's browser-only
// runtime. This verifies route order as well as behavior, not a copied matcher.
test("recovery navigation precedes precache and fetches fresh HTML", async () => {
	const source = await Bun.file("frontend/src-sw.ts").text();
	const start = source.indexOf("registerRoute(");
	const end = source.indexOf("// Injected by vite-plugin-pwa", start);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeLessThan(source.indexOf("precacheAndRoute(self.__WB_MANIFEST)"));
	let match: (options: { request: { mode: string }; url: URL }) => boolean = () => false;
	let handle: (options: { request: Request }) => Promise<Response> = async () => new Response();
	let networkRequest: Request | undefined;
	new Function("registerRoute", "fetch", "Request", source.slice(start, end))(
		(matcher: typeof match, handler: typeof handle) => {
			match = matcher;
			handle = handler;
		},
		async (request: Request) => {
			networkRequest = request;
			return new Response("fresh");
		},
		Request,
	);
	for (const path of ["/settings/server", "/proxy/7778/narrators/abc"]) {
		const url = new URL(`https://nf.test${path}?_nf_reload=123`);
		expect(match({ request: { mode: "navigate" }, url })).toBe(true);
		expect(match({ request: { mode: "cors" }, url })).toBe(false);
		const response = await handle({ request: new Request(url) });
		expect(await response.text()).toBe("fresh");
		expect(networkRequest?.cache).toBe("no-store");
		expect(networkRequest?.url).toBe(url.href);
	}
	expect(match({ request: { mode: "navigate" }, url: new URL("https://nf.test/settings") })).toBe(
		false,
	);
});
