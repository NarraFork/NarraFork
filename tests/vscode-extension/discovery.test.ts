/**
 * discovery.test.ts — Which backend the extension attaches to.
 *
 * Run by the repo's `bun test`, even though the extension compiles with its own tsconfig:
 * `discovery.ts` imports nothing from `vscode`, precisely so this decision can be tested
 * without an editor. Anything here that touches the `vscode` API belongs in a different
 * file and cannot be covered this way.
 */

import { describe, expect, it } from "bun:test";
import {
	DEFAULT_BACKEND_PORT,
	discoverBackend,
	normalizeOrigin,
	probeBackend,
	readConfiguredPortFromSettings,
} from "../../vscode-extension/src/discovery";

/**
 * `localhost`, not `127.0.0.1`.
 *
 * ⚠️ The default candidate deliberately uses the NAME. A backend bound to the IPv6
 * loopback only (Bun's behaviour for `host: "localhost"` on a dual-stack machine)
 * refuses `127.0.0.1` outright, so the old hardcoded IPv4 literal reported "no backend"
 * while the app was plainly running. `localhost` resolves to whichever family is up and
 * is also a spelling `asExternalUri` can port-map — see `src/loopback.ts`.
 */
const DEFAULT_ORIGIN = `http://localhost:${DEFAULT_BACKEND_PORT}`;

/** A fetch stub that answers `/api/health` for the listed origins only. */
function fakeFetch(
	answers: Record<string, { status?: number; body?: unknown }>,
	log?: string[],
): typeof fetch {
	return (async (input: string | URL) => {
		const url = String(input);
		log?.push(url);
		const origin = url.replace(/\/api\/health$/, "");
		const answer = answers[origin];
		if (!answer) throw new Error(`connection refused: ${url}`);
		const status = answer.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => answer.body ?? { status: "ok", version: "0.6.3" },
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

const noSettingsFile: typeof readConfiguredPortFromSettings = async () => null;

describe("normalizeOrigin", () => {
	it("keeps an explicit http/https origin", () => {
		expect(normalizeOrigin("http://nf.internal:7778")).toBe("http://nf.internal:7778");
		expect(normalizeOrigin("https://nf.example.com")).toBe("https://nf.example.com");
	});

	it("assumes http for a bare host:port, which is what a user types", () => {
		expect(normalizeOrigin("nf.internal:7778")).toBe("http://nf.internal:7778");
		expect(normalizeOrigin("localhost:9000")).toBe("http://localhost:9000");
	});

	it("discards any path, since only the origin is used", () => {
		expect(normalizeOrigin("http://nf.internal:7778/projects/abc")).toBe("http://nf.internal:7778");
	});

	/*
	 * ⚠️ Loopback spellings are REWRITTEN to `localhost`, and this is a behaviour change
	 * rather than tidying.
	 *
	 * `asExternalUri` port-maps only authorities matching its own regex
	 * (`/^(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)$/`, verbatim from the VS Code bundle
	 * code-server ships). An IPv6 literal does not match, so it is returned UNCHANGED —
	 * no tunnel, no `/proxy/<port>/` — and the panel then framed an address that only
	 * exists on the server, from a browser on the user's machine. A bracketed IPv6 host
	 * also cannot appear in a CSP source list, so `frame-src` collapsed to `'none'`.
	 *
	 * Normalising at the point the user's value is parsed means pinning `http://[::1]:7778`
	 * — the natural thing to write when the backend is IPv6-loopback-only — still works.
	 */
	it("rewrites a loopback address to the localhost spelling", () => {
		expect(normalizeOrigin("http://[::1]:7778")).toBe("http://localhost:7778");
		expect(normalizeOrigin("[::1]:7778")).toBe("http://localhost:7778");
		expect(normalizeOrigin("http://127.0.0.1:7778")).toBe("http://localhost:7778");
		expect(normalizeOrigin("https://[::1]:8443")).toBe("https://localhost:8443");
	});

	it("does not rewrite a remote host that merely looks local", () => {
		// Rewriting a non-loopback host would change WHICH machine is addressed.
		expect(normalizeOrigin("http://notlocalhost.example:7778")).toBe(
			"http://notlocalhost.example:7778",
		);
		expect(normalizeOrigin("http://10.0.0.5:7778")).toBe("http://10.0.0.5:7778");
	});

	it("rejects unusable values", () => {
		for (const value of ["", "   ", "ws://127.0.0.1:7778", "file:///tmp", "::::"]) {
			expect(normalizeOrigin(value)).toBeNull();
		}
	});
});

describe("probeBackend", () => {
	it("accepts a healthy backend and reports its version", async () => {
		const probe = await probeBackend(DEFAULT_ORIGIN, fakeFetch({ [DEFAULT_ORIGIN]: {} }));
		expect(probe).toEqual({ version: "0.6.3" });
	});

	it("accepts a 503, because that is a reachable backend whose recovery failed", async () => {
		// The backend deliberately serves 503 with a health payload while startup recovery
		// failed, and keeps the UI reachable — the UI is where that state gets repaired. So
		// refusing it would hide the panel exactly when it is needed.
		const probe = await probeBackend(
			DEFAULT_ORIGIN,
			fakeFetch({ [DEFAULT_ORIGIN]: { status: 503, body: { status: "error", version: "0.6.3" } } }),
		);
		expect(probe).toEqual({ version: "0.6.3" });
	});

	it("rejects a response that is not a NarraFork health payload", async () => {
		// Something is usually listening on a developer machine. A 200 alone proves nothing,
		// which is why the payload shape is checked rather than the status.
		const probe = await probeBackend(
			DEFAULT_ORIGIN,
			fakeFetch({ [DEFAULT_ORIGIN]: { body: { hello: "world" } } }),
		);
		expect(probe).toBeNull();
	});

	it("rejects other error statuses and connection failures", async () => {
		expect(
			await probeBackend(DEFAULT_ORIGIN, fakeFetch({ [DEFAULT_ORIGIN]: { status: 502 } })),
		).toBeNull();
		expect(await probeBackend(DEFAULT_ORIGIN, fakeFetch({}))).toBeNull();
	});

	it("gives up rather than hanging when nothing answers", async () => {
		// The stub honours `signal` because real `fetch` does: that rejection is precisely
		// what bounds the probe. A stub that ignored it would "prove" a timeout this code
		// does not actually implement.
		const hang = ((_input: string | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			})) as unknown as typeof fetch;
		expect(await probeBackend(DEFAULT_ORIGIN, hang, 20)).toBeNull();
	});
});

describe("readConfiguredPortFromSettings", () => {
	/**
	 * Write `contents` to a scratch settings file and read it back; `null` means "the
	 * file does not exist". Kept inside the repo's test directory rather than /tmp so the
	 * path stays inside the working tree.
	 */
	async function readFrom(contents: string | null): Promise<{ origin: string } | null> {
		const path = `${import.meta.dir}/.tmp-settings-${crypto.randomUUID()}.json`;
		if (contents === null) return readConfiguredPortFromSettings(`${path}.missing`);
		await Bun.write(path, contents);
		try {
			return await readConfiguredPortFromSettings(path);
		} finally {
			await Bun.file(path).delete();
		}
	}

	/*
	 * ⚠️ The derived origin uses `localhost`, not `127.0.0.1` as it once did.
	 *
	 * This is the failure that made the whole feature look broken on a normal machine:
	 * `bun run dev` with the default `host: "localhost"` makes Bun listen on the IPv6
	 * loopback ONLY, so probing `127.0.0.1` got ECONNREFUSED and discovery reported "no
	 * backend responded" while NarraFork was running and serving happily. The name
	 * resolves to whichever family is actually listening.
	 */
	it("derives a loopback origin from server.port", async () => {
		expect(await readFrom(JSON.stringify({ server: { port: 9123 } }))).toEqual({
			origin: "http://localhost:9123",
		});
	});

	it("uses https when TLS is enabled", async () => {
		expect(
			await readFrom(JSON.stringify({ server: { port: 8443, tls: { enabled: true } } })),
		).toEqual({ origin: "https://localhost:8443" });
	});

	it("ignores server.host, which is a BIND address rather than a reachable name", async () => {
		// `0.0.0.0` is a common value and is not connectable; loopback always reaches a
		// local listener whatever it bound to.
		expect(await readFrom(JSON.stringify({ server: { port: 7778, host: "0.0.0.0" } }))).toEqual({
			origin: "http://localhost:7778",
		});
	});

	it("returns null for anything unusable, so a bad hint degrades to the default", async () => {
		expect(await readFrom(null)).toBeNull();
		expect(await readFrom("not json")).toBeNull();
		expect(await readFrom(JSON.stringify({}))).toBeNull();
		expect(await readFrom(JSON.stringify({ server: {} }))).toBeNull();
		expect(await readFrom(JSON.stringify({ server: { port: "7778" } }))).toBeNull();
		expect(await readFrom(JSON.stringify({ server: { port: 0 } }))).toBeNull();
		expect(await readFrom(JSON.stringify({ server: { port: 70000 } }))).toBeNull();
	});
});

describe("discoverBackend", () => {
	it("prefers the port from the settings file", async () => {
		const result = await discoverBackend({
			fetchImpl: fakeFetch({ "http://127.0.0.1:9123": {} }),
			readSettings: async () => ({ origin: "http://127.0.0.1:9123" }),
		});
		expect(result).toEqual({
			ok: true,
			endpoint: { origin: "http://127.0.0.1:9123", version: "0.6.3", source: "settings-file" },
		});
	});

	it("falls back to the default port when the settings hint does not answer", async () => {
		const result = await discoverBackend({
			fetchImpl: fakeFetch({ [DEFAULT_ORIGIN]: {} }),
			readSettings: async () => ({ origin: "http://127.0.0.1:9123" }),
		});
		expect(result.ok && result.endpoint.source).toBe("default");
	});

	it("does not probe the default twice when the settings agree with it", async () => {
		const log: string[] = [];
		await discoverBackend({
			fetchImpl: fakeFetch({ [DEFAULT_ORIGIN]: {} }, log),
			readSettings: async () => ({ origin: DEFAULT_ORIGIN }),
		});
		expect(log).toEqual([`${DEFAULT_ORIGIN}/api/health`]);
	});

	it("reports what it tried when nothing answers", async () => {
		const result = await discoverBackend({
			fetchImpl: fakeFetch({}),
			readSettings: async () => ({ origin: "http://127.0.0.1:9123" }),
		});
		expect(result).toEqual({
			ok: false,
			failure: { attempted: ["http://127.0.0.1:9123", DEFAULT_ORIGIN], configured: false },
		});
	});

	describe("a configured URL", () => {
		// A non-loopback host, so "verbatim" is actually observable: a pinned LOOPBACK
		// address is deliberately re-spelled to `localhost` (see the normalizeOrigin
		// tests above), which would otherwise make these assertions ambiguous about
		// which behaviour they are pinning.
		it("is used verbatim", async () => {
			const result = await discoverBackend({
				configuredUrl: "  nf.internal:9999 ",
				fetchImpl: fakeFetch({ "http://nf.internal:9999": {} }),
				readSettings: noSettingsFile,
			});
			expect(result.ok && result.endpoint).toEqual({
				origin: "http://nf.internal:9999",
				version: "0.6.3",
				source: "configured",
			});
		});

		it("suppresses every other candidate, including the default", async () => {
			// ⚠️ The whole point. Falling back after the user pinned an address would connect
			// them to a DIFFERENT backend while the status bar reported success.
			const log: string[] = [];
			const result = await discoverBackend({
				configuredUrl: "http://nf.internal:9999",
				fetchImpl: fakeFetch({ [DEFAULT_ORIGIN]: {} }, log),
				readSettings: async () => ({ origin: DEFAULT_ORIGIN }),
			});
			expect(result.ok).toBe(false);
			expect(log).toEqual(["http://nf.internal:9999/api/health"]);
		});

		it("fails loudly when it cannot even be parsed", async () => {
			const result = await discoverBackend({
				configuredUrl: "ws://127.0.0.1:9999",
				fetchImpl: fakeFetch({ [DEFAULT_ORIGIN]: {} }),
				readSettings: noSettingsFile,
			});
			expect(result).toEqual({
				ok: false,
				failure: { attempted: ["ws://127.0.0.1:9999"], configured: true },
			});
		});

		it("is treated as absent when blank, so whitespace does not disable discovery", async () => {
			const result = await discoverBackend({
				configuredUrl: "   ",
				fetchImpl: fakeFetch({ [DEFAULT_ORIGIN]: {} }),
				readSettings: noSettingsFile,
			});
			expect(result.ok && result.endpoint.source).toBe("default");
		});
	});
});
