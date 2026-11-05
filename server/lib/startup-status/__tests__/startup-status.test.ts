import { afterEach, describe, expect, test } from "bun:test";
import { STARTUP_STATUS_HEADER } from "../../../../shared/startup-status";
import {
	closeStartupStatus,
	reportStartupStep,
	showStartupProblem,
	startStartupStatus,
} from "../index";
import { isLoopbackAddress, type StartupProblem, snapshotForViewer } from "../protocol";
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

async function start(viewerExpected = false) {
	const port = freePort();
	const listening = await startStartupStatus(
		{ hostname: "127.0.0.1", port },
		{ version: "9.9.9", viewerExpected },
	);
	const url = (path: string) => `http://127.0.0.1:${port}${path}`;
	return { port, listening, url };
}

afterEach(closeStartupStatus);

describe("startup status page", () => {
	test("answers navigation, health and other requests while starting", async () => {
		const { listening, url } = await start();
		expect(listening).toBe(true);

		const page = await fetch(url("/narrators/abc"), { headers: { accept: "text/html" } });
		expect(page.status).toBe(503);
		expect(page.headers.get(STARTUP_STATUS_HEADER)).toBe("1");
		const html = await page.text();
		// Relative to the page, so polling keeps working under a reverse-proxy prefix.
		expect(html).toContain('<base href="../">');
		expect(html).toContain('fetch("api/startup"');

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
		await Bun.sleep(20);
		const body = await (await fetch(url("/api/startup"))).json();
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
				{ version: "9.9.9", viewerExpected: true },
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

	test("a failure nobody is looking at does not wait", async () => {
		await start(false);
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

	test("recognises loopback peers", () => {
		for (const address of ["127.0.0.1", "127.8.0.2", "::1", "::ffff:127.0.0.1"]) {
			expect(isLoopbackAddress(address)).toBe(true);
		}
		for (const address of ["192.168.1.2", "::ffff:10.0.0.1", "fe80::1", undefined]) {
			expect(isLoopbackAddress(address)).toBe(false);
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
