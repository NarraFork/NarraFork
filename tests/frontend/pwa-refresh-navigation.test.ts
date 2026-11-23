import { expect, mock, test } from "bun:test";
import { setBaseHref } from "../../server/lib/spa-base-href";
import { STARTUP_STATUS_HEADER } from "../../shared/startup-status";

const source = await Bun.file("frontend/src-sw.ts").text();
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
	source.replace(/import[\s\S]*?from\s+"[^"]+";/g, ""),
);

function worker(
	fetcher: (request: Request) => Promise<Response>,
	timers = { setTimeout, clearTimeout },
) {
	const routes: Array<{
		match: (options: object) => boolean;
		handle: (options: { request: Request }) => Promise<Response>;
	}> = [];
	const events = new Map<string, (event: unknown) => void>();
	const claim = mock(async () => {});
	const postMessage = mock((_message: unknown) => {});
	const unregister = mock(async () => true);
	const shell = mock(
		async () =>
			new Response("<html><head></head><body>cached</body></html>", {
				headers: { "content-type": "text/html" },
			}),
	);
	const self = {
		registration: { scope: "https://nf.test/proxy/7778/", unregister },
		location: { origin: "https://nf.test" },
		clients: { claim, matchAll: async () => [{ postMessage }] },
		addEventListener: (name: string, handler: (event: unknown) => void) =>
			events.set(name, handler),
		skipWaiting: () => {},
		...timers,
	};
	class Strategy {}
	class NavigationRoute {
		constructor(readonly handle: (options: { request: Request }) => Promise<Response>) {}
	}
	new Function(
		"self",
		"fetch",
		"registerRoute",
		"NavigationRoute",
		"precacheAndRoute",
		"cleanupOutdatedCaches",
		"createHandlerBoundToURL",
		"CacheableResponsePlugin",
		"ExpirationPlugin",
		"CacheFirst",
		"StaleWhileRevalidate",
		"setBaseHref",
		"API_WS_PREFIXES",
		"isApiOrWsRelativePath",
		"appVersionsMatch",
		"STARTUP_STATUS_HEADER",
		"__APP_VERSION__",
		"setTimeout",
		"clearTimeout",
		compiled,
	)(
		self,
		fetcher,
		(
			match: (options: object) => boolean,
			handle: (options: { request: Request }) => Promise<Response>,
		) => routes.push({ match, handle }),
		NavigationRoute,
		() => {},
		() => {},
		() => shell,
		Strategy,
		Strategy,
		Strategy,
		Strategy,
		setBaseHref,
		["api", "ws"],
		() => false,
		(a: string, b: string) => a === b,
		STARTUP_STATUS_HEADER,
		"1.0.0",
		timers.setTimeout,
		timers.clearTimeout,
	);
	return { routes, claim, unregister, postMessage, events, shell };
}

test("recovery route precedes precache and preserves fresh/startup HTML", async () => {
	expect(source.indexOf("registerRoute(")).toBeLessThan(
		source.indexOf("precacheAndRoute(self.__WB_MANIFEST)"),
	);
	for (const status of [200, 503]) {
		let networkRequest: Request | undefined;
		const runtime = worker(async (request: Request) => {
			networkRequest = request;
			const headers: Record<string, string> = { "content-type": "text/html" };
			if (status === 503) headers[STARTUP_STATUS_HEADER] = "1";
			return new Response("fresh", { status, headers });
		});
		const route = runtime.routes[0];
		if (!route) throw new Error("Missing route");
		const url = new URL("https://nf.test/proxy/7778/settings/server?_nf_reload=123");
		expect(route.match({ request: { mode: "navigate" }, url })).toBe(true);
		expect(route.match({ request: { mode: "cors" }, url })).toBe(false);
		expect(
			route.match({ request: { mode: "navigate" }, url: new URL("https://nf.test/settings") }),
		).toBe(false);
		const response = await route.handle({ request: new Request(url) });
		expect(response.status).toBe(status);
		expect(await response.text()).toBe("fresh");
		expect(networkRequest?.cache).toBe("no-store");
		expect(networkRequest?.url).toBe(url.href);
		expect(runtime.shell).not.toHaveBeenCalled();
	}
});

for (const failure of ["error", "timeout", "proxy"] as const) {
	test(`recovery navigation falls back to base-corrected shell after ${failure}`, async () => {
		let expire: (() => void) | undefined;
		let delay = 0;
		let signal: AbortSignal | null | undefined;
		const runtime = worker(
			async (request: Request) => {
				signal = request.signal;
				if (failure === "error") throw Error("offline");
				if (failure === "proxy")
					return new Response("bad gateway", {
						status: 502,
						headers: { "content-type": "text/html" },
					});
				return new Promise(() => {});
			},
			{
				setTimeout: ((callback: () => void, ms: number) => {
					expire = callback;
					delay = ms;
					return 1;
				}) as typeof setTimeout,
				clearTimeout: (() => {}) as typeof clearTimeout,
			},
		);
		const response = runtime.routes[0]?.handle({
			request: new Request("https://nf.test/proxy/7778/settings?_nf_reload=1"),
		});
		if (failure === "timeout") {
			expect(delay).toBe(8000);
			expire?.();
			expect(signal?.aborted).toBe(true);
		}
		expect(await (await response)?.text()).toContain('<base href="/proxy/7778/">');
		expect(runtime.shell).toHaveBeenCalledTimes(1);
	});
}

test("activation claims clients without waiting on the version check and never unregisters", async () => {
	for (const version of ["1.0.0", "2.0.0", undefined]) {
		const runtime = worker(async () => Response.json({ version }));
		let activated: Promise<void> | undefined;
		runtime.events.get("activate")?.({
			waitUntil: (promise: Promise<void>) => {
				activated = promise;
			},
		});
		await activated;
		// The version check runs after the claim, off the activation path.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(runtime.claim).toHaveBeenCalledTimes(1);
		expect(runtime.unregister).not.toHaveBeenCalled();
		expect(runtime.postMessage).toHaveBeenCalledTimes(version === "2.0.0" ? 1 : 0);
	}
});

test("active worker reports its compiled build over the private response port", () => {
	const runtime = worker(async () => Response.json({}));
	const reply = mock((_message: unknown) => {});
	runtime.events.get("message")?.({
		data: { type: "GET_VERSION" },
		ports: [{ postMessage: reply }],
	});
	expect(reply).toHaveBeenCalledWith({ version: "1.0.0" });
	runtime.events.get("message")?.({ data: { type: "OTHER" }, ports: [{ postMessage: reply }] });
	expect(reply).toHaveBeenCalledTimes(1);
	runtime.events.get("message")?.({ data: { type: "GET_VERSION" }, ports: [] });
});
