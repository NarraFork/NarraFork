import { afterEach, describe, expect, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { AppError, ValidationError } from "@server/lib/errors";
import { setOutboundFetchOverrideForTest } from "@server/lib/net/outbound-fetch";
import type { Agent } from "undici/index.js";
import {
	downloadSkillLink,
	isGitHubSkillDirectoryUrl,
	type SkillLinkDownloadDeps,
	type SkillLinkRequestOptions,
	type SkillLinkResponse,
} from "../skill-link-download";

const source = "https://skills.example.com/raw/SKILL.md";
const markdown = "---\nname: public-skill\ndescription: A public skill\n---\nInstructions 中文\n";
const content = new TextEncoder().encode(markdown);
const publicAnswer = { address: "93.184.216.34", family: 4 };
const noSignal = () => new AbortController().signal;

function response(
	chunks: Uint8Array[] = [content],
	headers: SkillLinkResponse["headers"] = { "content-type": "text/plain; charset=utf-8" },
	statusCode = 200,
) {
	const state = { reads: 0, destroyed: 0 };
	const result: SkillLinkResponse = {
		statusCode,
		headers,
		body: {
			destroy() {
				state.destroyed++;
			},
			[Symbol.asyncIterator]() {
				let index = 0;
				return {
					async next() {
						state.reads++;
						const value = chunks[index++];
						return value
							? { value, done: false as const }
							: { value: undefined, done: true as const };
					},
				};
			},
		},
	};
	return { result, state };
}

function fixture(
	responses: SkillLinkResponse[] = [response().result],
	answers: LookupAddress[] = [publicAnswer],
) {
	const calls: { url: string; options: SkillLinkRequestOptions }[] = [];
	const lookups: string[] = [];
	const deps: SkillLinkDownloadDeps = {
		async resolve(hostname) {
			lookups.push(hostname);
			return answers;
		},
		async request(url, options) {
			calls.push({ url: url.href, options });
			const result = responses[calls.length - 1];
			if (!result) throw new Error("Unexpected fixture request");
			return result;
		},
	};
	return { deps, calls, lookups };
}

async function expectCode(promise: Promise<unknown>, code: string, status?: number) {
	const error = await promise.then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(AppError);
	expect((error as AppError).code).toBe(code);
	if (status !== undefined) expect((error as AppError).statusCode).toBe(status);
	return error as AppError;
}

interface PinnedOptions {
	connect: {
		lookup: LookupFunction;
		servername?: string;
		rejectUnauthorized: boolean;
		signal: AbortSignal;
	};
	maxResponseSize: number;
	autoSelectFamily: boolean;
}

function agentOptions(agent: Agent): PinnedOptions {
	// Inspect the actual undici 6 Agent passed to request(), not a second policy-only lookup.
	const key = Object.getOwnPropertySymbols(agent).find(
		(symbol) => symbol.description === "options",
	);
	expect(key).toBeDefined();
	return Reflect.get(agent, key as symbol) as PinnedOptions;
}

function lookupFixed(lookup: LookupFunction, hostname: string, all = false) {
	return new Promise<string | LookupAddress[]>((resolve, reject) => {
		lookup(hostname, { all }, (error, address) => {
			if (error) reject(error);
			else resolve(address);
		});
	});
}

function stalledResponse(onNext: () => void, onDestroy: () => void): SkillLinkResponse {
	return {
		statusCode: 200,
		headers: {},
		body: {
			destroy: onDestroy,
			[Symbol.asyncIterator]() {
				return {
					next() {
						onNext();
						return new Promise<IteratorResult<Uint8Array>>(() => {});
					},
				};
			},
		},
	};
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

afterEach(() => setOutboundFetchOverrideForTest(null));

describe("public raw skill links", () => {
	test("exports the same strict directory routing predicate used by downloads", () => {
		expect(isGitHubSkillDirectoryUrl("https://github.com/owner/repo/tree/main/skill")).toBe(true);
		for (const url of [
			source,
			"https://github.com.evil.com/owner/repo/tree/main/skill",
			"https://github.com/owner/repo/blob/main/SKILL.md",
			"https://github.com/owner/repo/tree/main/skill?raw=1",
			"https://user@github.com/owner/repo/tree/main/skill",
			"https://github.com/owner/repo/tree/main/../skill",
			"http://github.com/owner/repo/tree/main/skill",
			"invalid",
		]) {
			expect(isGitHubSkillDirectoryUrl(url)).toBe(false);
		}
	});

	test.each([
		source,
		"http://skills.example.com:8080/SKILL.md?download=1",
		"https://raw.githubusercontent.com/owner/repo/main/SKILL.md",
		"https://gitlab.com/owner/repo/-/raw/main/SKILL.md",
		"https://gitee.com/owner/repo/raw/main/SKILL.md",
		"https://forge.example.com/a/-/raw/main/skills/%E4%B8%AD%E6%96%87/SKILL.md",
		"https://github.com.evil.com/owner/repo/tree/main/skill",
		"https://93.184.216.34/SKILL.md",
		"https://[2606:4700:4700::1111]/SKILL.md",
	])("downloads UTF-8 Markdown without assuming a GitHub host: %s", async (url) => {
		const { deps, calls } = fixture();
		const result = await downloadSkillLink(url, noSignal(), deps);
		expect(result).toEqual({ kind: "markdown", files: [{ path: "SKILL.md", bytes: content }] });
		expect(calls).toHaveLength(1);
		expect(Object.keys(result)).toEqual(["files", "kind"]);
		expect(calls[0].options.dispatcher.destroyed).toBe(true);
	});

	test("does not parse YAML or execute downloaded scripts", async () => {
		const bytes = new TextEncoder().encode(
			"not YAML\n<script>throw new Error('do not run')</script>",
		);
		const { deps } = fixture([response([bytes]).result]);
		expect((await downloadSkillLink(source, noSignal(), deps)).files[0].bytes).toEqual(bytes);
	});

	test("dispatches only exact, successfully parsed github.com tree URLs to existing downloader", async () => {
		const calls: string[] = [];
		const root = "a".repeat(40);
		const target = "b".repeat(40);
		const blob = "c".repeat(40);
		setOutboundFetchOverrideForTest(async (input) => {
			const url = String(input);
			calls.push(url);
			if (url.endsWith("/trees/main")) {
				return Response.json({
					sha: root,
					truncated: false,
					tree: [{ path: "skill", sha: target, type: "tree", mode: "040000" }],
				});
			}
			if (url.endsWith(`/trees/${target}?recursive=1`)) {
				return Response.json({
					sha: target,
					truncated: false,
					tree: [
						{ path: "SKILL.md", sha: blob, type: "blob", mode: "100644", size: content.length },
					],
				});
			}
			if (url.endsWith(`/blobs/${blob}`)) return new Response(content);
			return new Response("not found", { status: 404 });
		});
		const raw = fixture();
		const result = await downloadSkillLink(
			"https://github.com/owner/repo/tree/main/skill",
			noSignal(),
			raw.deps,
		);
		expect(result).toEqual({
			kind: "directory",
			files: [{ path: "SKILL.md", bytes: content, executable: false }],
		});
		expect(calls.length).toBeGreaterThan(0);
		expect(raw.calls).toHaveLength(0);
		expect(raw.lookups).toHaveLength(0);
	});

	test.each([
		"https://github.com/owner/repo/blob/main/SKILL.md",
		"https://github.com/owner/repo/tree/main/skill?raw=1",
		"http://github.com/owner/repo/tree/main/skill",
	])("does not misdispatch nonmatching GitHub URLs: %s", async (url) => {
		setOutboundFetchOverrideForTest(async () => {
			throw new Error("Directory transport must not be used");
		});
		const { deps, calls } = fixture();
		expect((await downloadSkillLink(url, noSignal(), deps)).kind).toBe("markdown");
		expect(calls).toHaveLength(1);
	});
});

describe("URL and SSRF protection", () => {
	test.each([
		"",
		"file:///etc/passwd",
		"ftp://skills.example.com/SKILL.md",
		"https:skills.example.com/SKILL.md",
		` ${source}`,
		`${source}\n`,
		`${source}#instructions`,
		`${source}#`,
		`${source}?line=%0d%0a`,
		`${source}?line=%5csecret`,
		"https://user:password@skills.example.com/SKILL.md",
		"https://@skills.example.com/SKILL.md",
		"https://skills.example.com\\@localhost/SKILL.md",
		`${source}/${"x".repeat(2048)}`,
	])("rejects malformed, credentialed or ambiguous URLs before DNS: %s", async (url) => {
		const { deps, calls, lookups } = fixture();
		const error = await expectCode(downloadSkillLink(url, noSignal(), deps), "SKILL_LINK_URL", 400);
		expect(error).toBeInstanceOf(ValidationError);
		expect(error.message).not.toContain("password");
		expect(calls).toHaveLength(0);
		expect(lookups).toHaveLength(0);
	});

	test.each([
		"localhost",
		"localhost.",
		"sub.localhost",
		"service.local",
		"printer",
		"router.home.arpa",
		"127.0.0.1",
		"127.1",
		"2130706433",
		"0x7f000001",
		"0177.0.0.1",
		"0.0.0.0",
		"10.2.3.4",
		"100.64.0.1",
		"100.127.255.254",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.254",
		"192.0.0.1",
		"192.0.2.1",
		"192.88.99.1",
		"192.168.10.1",
		"198.18.0.1",
		"198.19.255.254",
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1",
		"240.0.0.1",
		"255.255.255.255",
		"[::]",
		"[::1]",
		"[::ffff:127.0.0.1]",
		"[::ffff:7f00:1]",
		"[::ffff:93.184.216.34]",
		"[64:ff9b::a00:1]",
		"[100::1]",
		"[2001::1]",
		"[2001:db8::1]",
		"[2002:7f00:1::]",
		"[3fff::1]",
		"[3ffe::1]",
		"[fc00::1]",
		"[fd00::1]",
		"[fe80::1]",
		"[ff02::1]",
	])("blocks local, private and reserved literals: %s", async (host) => {
		const { deps, calls, lookups } = fixture();
		await expectCode(
			downloadSkillLink(`https://${host}/SKILL.md`, noSignal(), deps),
			"SKILL_LINK_PRIVATE_HOST",
			400,
		);
		expect(calls).toHaveLength(0);
		expect(lookups).toHaveLength(0);
	});

	const unsafeAnswerSets: LookupAddress[][] = [
		[],
		[{ address: "10.0.0.1", family: 4 }],
		[publicAnswer, { address: "127.0.0.1", family: 4 }],
		[{ address: "::ffff:a00:1", family: 6 }],
		[{ address: "2606:4700:4700::1111%eth0", family: 6 }],
		[{ address: "93.184.216.34", family: 6 }],
		[{ address: "not an address", family: 4 }],
	];
	test.each(
		unsafeAnswerSets.map((answers) => ({ answers })),
	)("rejects unsafe DNS result sets before connecting: %j", async ({ answers }) => {
		const { deps, calls } = fixture(undefined, answers);
		await expectCode(downloadSkillLink(source, noSignal(), deps), "SKILL_LINK_PRIVATE_HOST", 400);
		expect(calls).toHaveLength(0);
	});

	test("pins the actual Agent lookup and TLS hostname despite changing DNS answers", async () => {
		const answer = { ...publicAnswer };
		const { deps, calls, lookups } = fixture(undefined, [answer]);
		const signal = noSignal();
		deps.request = async (url, options) => {
			calls.push({ url: url.href, options });
			answer.address = "127.0.0.1";
			const pinned = agentOptions(options.dispatcher);
			expect(pinned.connect.signal).toBe(signal);
			expect(pinned.connect.servername).toBe("skills.example.com");
			expect(pinned.connect.rejectUnauthorized).toBe(true);
			expect(pinned.autoSelectFamily).toBe(false);
			expect(pinned.maxResponseSize).toBe(200_001);
			expect(await lookupFixed(pinned.connect.lookup, url.hostname)).toBe(publicAnswer.address);
			const first = (await lookupFixed(
				pinned.connect.lookup,
				url.hostname,
				true,
			)) as LookupAddress[];
			first[0].address = "10.0.0.1";
			expect(await lookupFixed(pinned.connect.lookup, url.hostname, true)).toEqual([publicAnswer]);
			await expect(lookupFixed(pinned.connect.lookup, "other.example.com")).rejects.toThrow();
			return response().result;
		};
		await downloadSkillLink(source, signal, deps);
		expect(lookups).toEqual(["skills.example.com"]);
		expect(calls).toHaveLength(1);
	});

	test("pins public IPv6 answers without address-family fallback", async () => {
		const ipv6 = { address: "2606:4700:4700::1111", family: 6 };
		const { deps } = fixture(undefined, [ipv6]);
		deps.request = async (url, options) => {
			expect(
				await lookupFixed(agentOptions(options.dispatcher).connect.lookup, url.hostname, true),
			).toEqual([ipv6]);
			return response().result;
		};
		await downloadSkillLink(source, noSignal(), deps);
	});
});

describe("validated manual redirects and anonymous requests", () => {
	test("follows at most 3 relative redirects and revalidates/pins each hop", async () => {
		const responses = [
			response([], { location: "../next/SKILL.md" }, 301),
			response([], { location: "//cdn.example.com/skills/one" }, 307),
			response([], { location: "/raw/SKILL.md?download=1" }, 308),
			response(),
		];
		const { deps, calls, lookups } = fixture(responses.map((entry) => entry.result));
		await downloadSkillLink(source, noSignal(), deps);
		expect(calls.map((call) => call.url)).toEqual([
			source,
			"https://skills.example.com/next/SKILL.md",
			"https://cdn.example.com/skills/one",
			"https://cdn.example.com/raw/SKILL.md?download=1",
		]);
		expect(lookups).toEqual([
			"skills.example.com",
			"skills.example.com",
			"cdn.example.com",
			"cdn.example.com",
		]);
		expect(responses.every((entry) => entry.state.destroyed === 1)).toBe(true);
		expect(new Set(calls.map((call) => call.options.dispatcher)).size).toBe(4);
	});

	test("does not perform a fifth request for a redirect loop", async () => {
		const { deps, calls } = fixture(
			Array.from({ length: 4 }, () => response([], { location: source }, 302).result),
		);
		await expectCode(downloadSkillLink(source, noSignal(), deps), "SKILL_LINK_REDIRECT", 400);
		expect(calls).toHaveLength(4);
	});

	test.each([
		["http://skills.example.com/raw/SKILL.md", "SKILL_LINK_REDIRECT"],
		["https://127.0.0.1/SKILL.md", "SKILL_LINK_PRIVATE_HOST"],
		["https://[::ffff:a00:1]/SKILL.md", "SKILL_LINK_PRIVATE_HOST"],
		["http://169.254.169.254/latest/meta-data", "SKILL_LINK_PRIVATE_HOST"],
		["https://user:secret@cdn.example.com/SKILL.md", "SKILL_LINK_URL"],
		["/raw/SKILL.md#fragment", "SKILL_LINK_URL"],
		["", "SKILL_LINK_URL"],
	])("rejects unsafe redirect: %s", async (location, code) => {
		const redirect = response([], { location }, 302);
		const { deps, calls } = fixture([redirect.result]);
		await expectCode(downloadSkillLink(source, noSignal(), deps), code, 400);
		expect(calls).toHaveLength(1);
		expect(redirect.state.destroyed).toBe(1);
	});

	test("rejects redirect DNS rebinding before the second request", async () => {
		const { deps, calls, lookups } = fixture([response([], { location: source }, 302).result]);
		deps.resolve = async (hostname) => {
			lookups.push(hostname);
			return [lookups.length === 1 ? publicAnswer : { address: "127.0.0.1", family: 4 }];
		};
		await expectCode(downloadSkillLink(source, noSignal(), deps), "SKILL_LINK_PRIVATE_HOST", 400);
		expect(calls).toHaveLength(1);
		expect(lookups).toHaveLength(2);
	});

	test("never forwards credentials, cookies, referer, upstream headers or ambient dispatchers", async () => {
		const { deps, calls } = fixture([
			response(
				[],
				{ location: "https://cdn.example.com/SKILL.md", "set-cookie": "secret=token" },
				302,
			).result,
			response().result,
		]);
		setOutboundFetchOverrideForTest(async () => {
			throw new Error("Global outbound transport must not be used for arbitrary public links");
		});
		await downloadSkillLink(source, noSignal(), deps);
		for (const { options } of calls) {
			expect(options.method).toBe("GET");
			expect(options.maxRedirections).toBe(0);
			expect(options.headers).toEqual({
				accept: "text/markdown, text/plain;q=0.9, application/octet-stream;q=0.8",
				"accept-encoding": "identity",
			});
			expect(options.dispatcher.constructor.name).toBe("Agent");
			expect(Object.keys(options)).not.toContain("proxy");
		}
	});
});

describe("bounded raw response bodies", () => {
	test("accepts exactly 200000 bytes including multibyte UTF-8", async () => {
		const bytes = new TextEncoder().encode(`${"中".repeat(66_666)}ab`);
		expect(bytes.length).toBe(200_000);
		const { deps } = fixture([
			response([bytes.subarray(0, 100_000), bytes.subarray(100_000)]).result,
		]);
		expect((await downloadSkillLink(source, noSignal(), deps)).files[0].bytes).toEqual(bytes);
	});

	test("stops oversized chunked bodies immediately rather than truncate or read the tail", async () => {
		const upstream = response([
			new Uint8Array(100_000),
			new Uint8Array(100_001),
			new Uint8Array(100_000),
		]);
		const { deps } = fixture([upstream.result]);
		await expectCode(downloadSkillLink(source, noSignal(), deps), "SKILL_LINK_LIMIT", 400);
		expect(upstream.state.reads).toBe(2);
		expect(upstream.state.destroyed).toBe(1);
	});

	test("rejects oversized content-length before reading a body", async () => {
		const upstream = response([content], { "content-length": "200001" });
		const { deps } = fixture([upstream.result]);
		await expectCode(downloadSkillLink(source, noSignal(), deps), "SKILL_LINK_LIMIT", 400);
		expect(upstream.state.reads).toBe(0);
	});

	test("does not trust a small content-length or an oversized first network chunk", async () => {
		const upstream = response([new Uint8Array(250_000)], { "content-length": "1" });
		const { deps } = fixture([upstream.result]);
		await expectCode(downloadSkillLink(source, noSignal(), deps), "SKILL_LINK_LIMIT", 400);
		expect(upstream.state.reads).toBe(1);
		expect(upstream.state.destroyed).toBe(1);
	});

	test.each([
		"text/html",
		"text/html; charset=utf-8",
		"application/xhtml+xml",
	])("rejects an HTML content-type and explains raw links: %s", async (contentType) => {
		const upstream = response([content], { "content-type": contentType });
		const { deps } = fixture([upstream.result]);
		const error = await expectCode(
			downloadSkillLink(source, noSignal(), deps),
			"SKILL_LINK_HTML",
			400,
		);
		expect(error.message).toContain("raw");
		expect(upstream.state.reads).toBe(0);
	});

	test("allows HTML examples inside a Markdown skill instead of treating them as a webpage", async () => {
		const bytes = new TextEncoder().encode(
			`${markdown}\nExample:\n\`\`\`html\n<html><body>demo</body></html>\n\`\`\`\n`,
		);
		const { deps } = fixture([response([bytes]).result]);
		expect((await downloadSkillLink(source, noSignal(), deps)).files[0].bytes).toEqual(bytes);
	});

	test.each([
		"<!DOCTYPE html><html><body>Sign in</body></html>",
		"\uFEFF  <HTML lang='en'>Sign in</HTML>",
		"<!-- before the page -->\n<html>Sign in</html>",
		"  <head><title>Sign in</title></head>",
		"  <body class='page'>Sign in</body>",
	])("detects HTML served as plain text: %s", async (html) => {
		const { deps } = fixture([response([new TextEncoder().encode(html)]).result]);
		await expectCode(downloadSkillLink(source, noSignal(), deps), "SKILL_LINK_HTML", 400);
	});

	test.each([
		new Uint8Array([0xff]),
		new Uint8Array([0xc0, 0xaf]),
		new Uint8Array([0xe4, 0xb8]),
	])("uses fatal UTF-8 decoding instead of replacement text: %j", async (bytes) => {
		const { deps } = fixture([response([bytes]).result]);
		await expectCode(downloadSkillLink(source, noSignal(), deps), "SKILL_LINK_ENCODING", 400);
	});

	test("rejects compressed responses rather than decompress unbounded data", async () => {
		const { deps } = fixture([response([content], { "content-encoding": "gzip" }).result]);
		await expectCode(downloadSkillLink(source, noSignal(), deps), "SKILL_LINK_ENCODING", 400);
	});

	test.each([
		401, 403, 404, 429, 500,
	])("HTTP %i is a real failure with no leaked body", async (status) => {
		const upstream = response([new TextEncoder().encode("secret upstream details")], {}, status);
		const { deps, calls } = fixture([upstream.result]);
		const error = await expectCode(
			downloadSkillLink(source, noSignal(), deps),
			"SKILL_LINK_HTTP",
			502,
		);
		expect(error.message).not.toContain("secret");
		expect(upstream.state.reads).toBe(0);
		expect(upstream.state.destroyed).toBe(1);
		expect(calls).toHaveLength(1);
	});
});

describe("caller cancellation covers every asynchronous phase", () => {
	test("an already cancelled call performs no DNS or network request", async () => {
		const controller = new AbortController();
		controller.abort();
		const { deps, calls, lookups } = fixture();
		await expectCode(downloadSkillLink(source, controller.signal, deps), "SKILL_LINK_ABORTED", 408);
		expect(calls).toHaveLength(0);
		expect(lookups).toHaveLength(0);
	});

	test("returns promptly when a resolver ignores abort", async () => {
		const controller = new AbortController();
		const { deps, calls } = fixture();
		deps.resolve = () => {
			controller.abort();
			return new Promise(() => {});
		};
		await expectCode(downloadSkillLink(source, controller.signal, deps), "SKILL_LINK_ABORTED", 408);
		expect(calls).toHaveLength(0);
	});

	test("disposes a late response from a request ignoring abort", async () => {
		const controller = new AbortController();
		const late = deferred<SkillLinkResponse>();
		const upstream = response();
		let agent: Agent | undefined;
		const { deps } = fixture();
		deps.request = (_url, options) => {
			agent = options.dispatcher;
			controller.abort();
			return late.promise;
		};
		await expectCode(downloadSkillLink(source, controller.signal, deps), "SKILL_LINK_ABORTED", 408);
		expect(agent?.destroyed).toBe(true);
		late.resolve(upstream.result);
		await Promise.resolve();
		await Promise.resolve();
		expect(upstream.state.destroyed).toBe(1);
	});

	test("cancels a stalled body iterator ignoring abort and closes its connection", async () => {
		const controller = new AbortController();
		let destroyed = 0;
		const upstream = stalledResponse(
			() => controller.abort(),
			() => destroyed++,
		);
		const { deps, calls } = fixture([upstream]);
		await expectCode(downloadSkillLink(source, controller.signal, deps), "SKILL_LINK_ABORTED", 408);
		expect(destroyed).toBe(1);
		expect(calls[0].options.dispatcher.destroyed).toBe(true);
	});

	test("the caller deadline also interrupts a stalled response body", async () => {
		let destroyed = 0;
		const { deps } = fixture([
			stalledResponse(
				() => {},
				() => destroyed++,
			),
		]);
		await expectCode(
			downloadSkillLink(source, AbortSignal.timeout(10), deps),
			"SKILL_LINK_ABORTED",
			408,
		);
		expect(destroyed).toBe(1);
	});

	test("fails DNS and network errors without retrying or exposing secret error details", async () => {
		const dns = fixture();
		dns.deps.resolve = async () => {
			throw new Error("secret resolver details");
		};
		const dnsError = await expectCode(
			downloadSkillLink(source, noSignal(), dns.deps),
			"SKILL_LINK_DNS",
			502,
		);
		expect(dnsError.message).not.toContain("secret");
		expect(dns.calls).toHaveLength(0);
		const transport = fixture();
		let attempts = 0;
		let agent: Agent | undefined;
		transport.deps.request = async (_url, options) => {
			attempts++;
			agent = options.dispatcher;
			throw new Error("secret network details");
		};
		const error = await expectCode(
			downloadSkillLink(source, noSignal(), transport.deps),
			"SKILL_LINK_REQUEST",
			502,
		);
		expect(error.message).not.toContain("secret");
		expect(attempts).toBe(1);
		expect(agent?.destroyed).toBe(true);
	});
});
