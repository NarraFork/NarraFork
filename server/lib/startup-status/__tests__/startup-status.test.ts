import { afterEach, describe, expect, test } from "bun:test";
import { STARTUP_STATUS_HEADER } from "../../../../shared/startup-status";
import {
	closeStartupStatus,
	expectStartupViewer,
	reportStartupStep,
	showStartupProblem,
	startStartupStatus,
} from "../index";
import { isLocalViewer, type StartupProblem, snapshotForViewer } from "../protocol";
import { StartupError, toStartupProblem } from "../startup-error";

const problem: StartupProblem = {
	message: { en: "Port is busy.", zh: "端口被占用。" },
	command: "Stop-Process -Id 4242",
	detail: "Error: EADDRINUSE",
};

function freePort(): number {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const { port } = probe;
	probe.stop(true);
	if (port === undefined) throw new Error("no port");
	return port;
}

/** Another test can take a just-freed port; try a few. */
async function start() {
	for (let attempt = 0; attempt < 5; attempt++) {
		const port = freePort();
		const target = { hostname: "127.0.0.1", port };
		if (await startStartupStatus(target, { version: "9.9.9", brandName: "Lab <A&B>" })) {
			const url = (path: string) => `http://127.0.0.1:${port}${path}`;
			return { port, url };
		}
	}
	throw new Error("could not start the status page on a free port");
}

/** Messages reach the worker asynchronously; wait for the page to reflect one. */
async function startupBody(
	url: (path: string) => string,
	until: (body: Record<string, unknown>) => boolean,
) {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const body = (await (await fetch(url("/api/startup"))).json()) as Record<string, unknown>;
		if (until(body) || Date.now() > deadline) return body;
		await Bun.sleep(10);
	}
}

afterEach(closeStartupStatus);

describe("startup status page", () => {
	test("answers navigation, health and other requests while starting", async () => {
		const { url } = await start();

		const page = await fetch(url("/narrators/abc"), { headers: { accept: "text/html" } });
		expect(page.status).toBe(503);
		expect(page.headers.get(STARTUP_STATUS_HEADER)).toBe("1");
		const html = await page.text();
		// Relative to the page, so polling keeps working under a reverse-proxy prefix.
		expect(html).toContain('<base href="../">');
		expect(html).toContain('fetch("api/startup"');
		// The instance name titles the window, escaped.
		expect(html).toContain("<title>Lab &#60;A&#38;B&#62;</title>");

		const health = await fetch(url("/api/health"));
		expect(health.status).toBe(503);
		expect(await health.json()).toEqual({
			status: "starting",
			readiness: "starting",
			version: "9.9.9",
		});

		for (const path of ["/api/narrators", "/ws/narrator", "/assets/index.js"]) {
			const response = await fetch(url(path));
			expect(response.status).toBe(503);
			expect(response.headers.get(STARTUP_STATUS_HEADER)).toBe("1");
		}
	});

	test("reports the current step", async () => {
		const { url } = await start();
		reportStartupStep({ key: "migrating", current: 2, total: 5 });
		const body = await startupBody(url, (b) => (b.step as { key: string }).key === "migrating");
		expect(body.version).toBe("9.9.9");
		expect(body.step).toEqual({ key: "migrating", current: 2, total: 5 });
		expect(typeof body.now).toBe("number");
	});

	test("frees the port on close", async () => {
		const { port } = await start();
		await closeStartupStatus();
		const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("main") });
		try {
			expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("main");
		} finally {
			server.stop(true);
		}
	});

	test("skips the page when the port is taken", async () => {
		const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
		try {
			const listening = await startStartupStatus(
				{ hostname: "127.0.0.1", port: holder.port ?? 0 },
				{ version: "9.9.9", brandName: "NarraFork" },
			);
			expect(listening).toBe(false);
			// Without a page there is nobody to wait for.
			const startedAt = Date.now();
			await showStartupProblem(problem);
			expect(Date.now() - startedAt).toBeLessThan(100);
		} finally {
			holder.stop(true);
		}
	});

	test("a failure waits until the open page has read it", async () => {
		const { url } = await start();
		// A page is polling.
		await fetch(url("/api/startup"));
		let done = false;
		const shown = showStartupProblem(problem).then(() => {
			done = true;
		});
		await Bun.sleep(50);
		expect(done).toBe(false);
		const body = await (await fetch(url("/api/startup"))).json();
		expect(body.problem).toEqual(problem);
		await shown;
		expect(done).toBe(true);
	});

	test("a failure waits for a browser that is being opened", async () => {
		const { url } = await start();
		expectStartupViewer();
		await startupBody(url, () => true);
		let done = false;
		const shown = showStartupProblem(problem).then(() => {
			done = true;
		});
		await startupBody(url, (b) => !!b.problem);
		await shown;
		expect(done).toBe(true);
	});

	test("a failure nobody is looking at does not wait", async () => {
		await start();
		const startedAt = Date.now();
		await showStartupProblem(problem);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});
});

describe("snapshotForViewer", () => {
	const snapshot = { version: "1", step: { key: "starting" as const }, stepStartedAt: 0, problem };

	test("keeps commands and details for a browser on the server itself", () => {
		expect(snapshotForViewer(snapshot, true)).toEqual(snapshot);
	});

	test("shows another machine only the message", () => {
		expect(snapshotForViewer(snapshot, false).problem).toEqual({ message: problem.message });
	});

	test("a browser on the server itself connects from loopback without forwarding", () => {
		const none = new Headers();
		for (const address of ["127.0.0.1", "127.8.0.2", "::1", "::ffff:127.0.0.1"]) {
			expect(isLocalViewer(address, none)).toBe(true);
		}
		for (const address of ["192.168.1.2", "::ffff:10.0.0.1", "fe80::1", undefined]) {
			expect(isLocalViewer(address, none)).toBe(false);
		}
	});

	test("a reverse proxy on the server is not the viewer", () => {
		for (const header of ["x-forwarded-for", "x-real-ip", "forwarded"]) {
			expect(isLocalViewer("127.0.0.1", new Headers({ [header]: "203.0.113.7" }))).toBe(false);
		}
	});
});

describe("toStartupProblem", () => {
	test("passes a StartupError through", () => {
		expect(toStartupProblem(new StartupError(problem))).toBe(problem);
	});

	test("describes anything else as unexpected, with the error as detail", () => {
		const described = toStartupProblem(new Error("boom"));
		expect(described.message.en).toContain("unexpected");
		expect(described.detail).toContain("boom");
		expect(described.command).toBeUndefined();
	});
});
