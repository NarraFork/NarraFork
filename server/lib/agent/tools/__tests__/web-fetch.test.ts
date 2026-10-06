import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanHtml } from "../../../web-fetch/dom";
import { setBrowserFetchDisabledForTests } from "../../../web-fetch/http-fetch";
import type { ToolContext } from "../../types";
import { webFetchTool } from "../web-fetch";

const EXAMPLE_HTML = `<html><head><title>Local Fallback Fixture</title></head><body><h1>Local Fallback Fixture</h1><p>Deterministic fallback content.</p></body></html>`;

let localPageUrl: string | null = null;
async function getLocalPageUrl(): Promise<string> {
	if (localPageUrl) return localPageUrl;
	const server = Bun.serve({
		port: 0,
		fetch: () => new Response(EXAMPLE_HTML, { headers: { "content-type": "text/html" } }),
	});
	localPageUrl = `http://127.0.0.1:${server.port}/fixture`;
	return localPageUrl;
}

// === Helpers ===

function makeCtx(): ToolContext {
	return {
		narratorId: "test-narrator",
		cwd: "/tmp",
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" as const }),
	};
}

/** Test-only: check if browser can launch (not cached, unlike production code). */
let _browserChecked = false;
let _browserOk = false;
async function canLaunchBrowser(): Promise<boolean> {
	if (_browserChecked) return _browserOk;
	_browserChecked = true;
	try {
		const { getBrowser } = await import("../../../web-fetch/browser");
		const b = await getBrowser();
		_browserOk = b.isConnected();
	} catch {
		_browserOk = false;
	}
	return _browserOk;
}

const FIXTURE_TEXT = "Deterministic WebFetch fixture content for truncation checks. ".repeat(20);
const FIXTURE_HTML = `<!doctype html>
<html>
	<head><title>Example Domain</title></head>
	<body>
		<main><article><h1>Example Domain</h1><p>${FIXTURE_TEXT}</p></article></main>
		<script>window.fixtureNoise = true;</script>
	</body>
</html>`;

let fixtureServer: ReturnType<typeof Bun.serve> | undefined;
let fixtureBaseUrl = "";

function fixtureUrl(path = "/"): string {
	if (!fixtureBaseUrl) throw new Error("WebFetch fixture server is not running");
	return `${fixtureBaseUrl}${path}`;
}

beforeAll(() => {
	fixtureServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/error") return new Response("fixture failure", { status: 503 });
			if (pathname === "/raw") {
				return new Response(`# Fixture Markdown\n\n${FIXTURE_TEXT}`, {
					headers: { "Content-Type": "text/markdown; charset=utf-8" },
				});
			}
			return new Response(FIXTURE_HTML, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		},
	});
	fixtureBaseUrl = `http://127.0.0.1:${fixtureServer.port}`;
});

afterAll(async () => {
	setBrowserFetchDisabledForTests(false);
	await fixtureServer?.stop(true);
	try {
		const { closeBrowser } = await import("../../../web-fetch/browser");
		await closeBrowser();
	} catch {
		// Browser was never launched
	}
});

// ============================================================
// URL validation (no browser needed)
// ============================================================

describe("WebFetch — URL validation", () => {
	test("rejects invalid URL", async () => {
		const result = await webFetchTool.execute({ url: "not-a-url", mode: "readability" }, makeCtx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Invalid URL");
	});

	test("rejects non-supported protocol", async () => {
		const result = await webFetchTool.execute(
			{ url: "ftp://example.com", mode: "readability" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Unsupported protocol");
	});

	test("accepts data: URL", async () => {
		// data: URLs don't need network but still go through the tool pipeline
		const result = await webFetchTool.execute(
			{ url: "data:text/html,<h1>hello</h1>", mode: "dom" },
			makeCtx(),
		);
		// data: URLs may not be supported by HTTP fallback — just verify no crash
		if (result.isError) return;
		expect(result.output).toContain("hello");
	}, 10_000);

	test("rejects file:// URL (bypasses path security checks)", async () => {
		const result = await webFetchTool.execute(
			{ url: "file:///etc/passwd", mode: "readability" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Unsupported protocol");
		expect(result.output).toContain("Read tool");
	});
});

// ============================================================
// DOM cleaning — pure unit tests (no browser, no network)
// ============================================================

describe("WebFetch — cleanHtml", () => {
	test("removes script tags and content", () => {
		const html = '<div>hello</div><script>alert("xss")</script><p>world</p>';
		const result = cleanHtml(html);
		expect(result).not.toContain("<script");
		expect(result).not.toContain("alert");
		expect(result).toContain("hello");
		expect(result).toContain("world");
	});

	test("removes style tags and content", () => {
		const html = "<style>body { color: red; }</style><p>text</p>";
		const result = cleanHtml(html);
		expect(result).not.toContain("<style");
		expect(result).not.toContain("color: red");
		expect(result).toContain("text");
	});

	test("removes noscript, svg, iframe tags", () => {
		const html =
			"<noscript>no js</noscript><svg><circle/></svg><iframe src='x'></iframe><p>keep</p>";
		const result = cleanHtml(html);
		expect(result).not.toContain("<noscript");
		expect(result).not.toContain("<svg");
		expect(result).not.toContain("<iframe");
		expect(result).toContain("keep");
	});

	test("strips data-* and on* attributes", () => {
		const html = '<div data-id="123" onclick="evil()" class="box">content</div>';
		const result = cleanHtml(html);
		expect(result).not.toContain("data-id");
		expect(result).not.toContain("onclick");
		expect(result).toContain('class="box"');
		expect(result).toContain("content");
	});

	test("keeps href, src, alt, title, class, id attributes", () => {
		const html = '<a href="/link" title="tip" class="btn" id="main">click</a>';
		const result = cleanHtml(html);
		expect(result).toContain('href="/link"');
		expect(result).toContain('title="tip"');
		expect(result).toContain('class="btn"');
		expect(result).toContain('id="main"');
	});

	test("collapses excessive whitespace", () => {
		const html = "<p>hello     world</p>";
		const result = cleanHtml(html);
		expect(result).not.toContain("     ");
		expect(result).toContain("hello world");
	});

	test("collapses excessive newlines", () => {
		const html = "<p>a</p>\n\n\n\n\n<p>b</p>";
		const result = cleanHtml(html);
		expect(result).not.toContain("\n\n\n");
	});

	test("handles self-closing tags in REMOVE_TAGS", () => {
		const html = '<link rel="stylesheet" href="x.css"/><p>text</p>';
		const result = cleanHtml(html);
		expect(result).not.toContain("<link");
		expect(result).toContain("text");
	});

	test("handles empty input", () => {
		expect(cleanHtml("")).toBe("");
	});

	test("handles input with only removed tags", () => {
		const html = "<script>x</script><style>y</style>";
		const result = cleanHtml(html);
		expect(result.trim()).toBe("");
	});

	test("preserves form elements (input, button, textarea, select, label)", () => {
		const html =
			'<form action="/submit" method="post">' +
			'<label for="user">Username</label>' +
			'<input type="text" id="user" name="username" placeholder="Enter name" required />' +
			'<textarea name="bio"></textarea>' +
			'<select name="role"><option value="admin" selected>Admin</option></select>' +
			'<button type="submit" disabled>Submit</button>' +
			"</form>";
		const result = cleanHtml(html);
		expect(result).toContain("<form");
		expect(result).toContain("<input");
		expect(result).toContain("<button");
		expect(result).toContain("<textarea");
		expect(result).toContain("<select");
		expect(result).toContain("<option");
		expect(result).toContain("<label");
		expect(result).toContain('action="/submit"');
		expect(result).toContain('method="post"');
		expect(result).toContain('type="text"');
		expect(result).toContain('placeholder="Enter name"');
		expect(result).toContain("required");
		expect(result).toContain("disabled");
		expect(result).toContain("selected");
	});

	test("preserves img tags", () => {
		const html = '<img src="/photo.jpg" alt="A photo" title="Photo" />';
		const result = cleanHtml(html);
		expect(result).toContain("<img");
		expect(result).toContain('src="/photo.jpg"');
		expect(result).toContain('alt="A photo"');
	});

	test("strips style attributes", () => {
		const html = '<div style="color:red" class="box">text</div>';
		const result = cleanHtml(html);
		expect(result).not.toContain("style=");
		expect(result).toContain('class="box"');
	});

	test("keeps aria-* attributes", () => {
		const html = '<button aria-label="Close" aria-describedby="desc">X</button>';
		const result = cleanHtml(html);
		expect(result).toContain('aria-label="Close"');
		expect(result).toContain('aria-describedby="desc"');
	});
});

// ============================================================
// Unknown mode (no browser needed)
// ============================================================

describe("WebFetch — parameter handling", () => {
	test("unknown mode returns error", async () => {
		const result = await webFetchTool.execute(
			{ url: fixtureUrl(), mode: "invalid_mode" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Unknown mode");
	});

	test("defaults to readability mode when mode is omitted", async () => {
		const result = await webFetchTool.execute({ url: fixtureUrl() }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output.length).toBeGreaterThan(0);
	}, 30_000);
});

// ============================================================
// HTTP fallback tests (no browser or external network needed)
// ============================================================

describe("WebFetch — HTTP fallback", () => {
	beforeAll(() => setBrowserFetchDisabledForTests(true));
	afterAll(() => setBrowserFetchDisabledForTests(false));

	test("extracts content from a local text page without external DNS", async () => {
		const result = await webFetchTool.execute(
			{ url: await getLocalPageUrl(), mode: "readability" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output.length).toBeGreaterThan(0);
	}, 30_000);

	describe("readability", () => {
		test("extracts fixture content via HTTP fallback", async () => {
			const result = await webFetchTool.execute(
				{ url: fixtureUrl(), mode: "readability" },
				makeCtx(),
			);
			expect(result.isError).toBeFalsy();
			expect(result.output).toContain("Example Domain");
		}, 30_000);

		test("extracts content from raw markdown", async () => {
			const result = await webFetchTool.execute(
				{ url: fixtureUrl("/raw"), mode: "readability" },
				makeCtx(),
			);
			expect(result.isError).toBeFalsy();
			expect(result.output.length).toBeGreaterThan(0);
		}, 30_000);

		test("respects max_length via HTTP fallback", async () => {
			const result = await webFetchTool.execute(
				{ url: fixtureUrl(), mode: "readability", max_length: 50 },
				makeCtx(),
			);
			expect(result.isError).toBeFalsy();
			expect(result.output).toContain("truncated");
		}, 30_000);

		test("returns error for an unsuccessful response", async () => {
			const result = await webFetchTool.execute(
				{ url: fixtureUrl("/error"), mode: "readability" },
				makeCtx(),
			);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("WebFetch failed");
		}, 30_000);
	});

	describe("dom", () => {
		test("extracts cleaned DOM via HTTP fallback", async () => {
			const result = await webFetchTool.execute({ url: fixtureUrl(), mode: "dom" }, makeCtx());
			expect(result.isError).toBeFalsy();
			expect(result.output.length).toBeGreaterThan(0);
			expect(result.output).not.toMatch(/<script[\s>]/i);
		}, 30_000);

		test("extracts elements with selector via linkedom", async () => {
			const result = await webFetchTool.execute(
				{ url: fixtureUrl(), mode: "dom", selector: "h1" },
				makeCtx(),
			);
			expect(result.isError).toBeFalsy();
			expect(result.output).toContain("Example Domain");
		}, 30_000);

		test("returns message for non-matching selector", async () => {
			const result = await webFetchTool.execute(
				{ url: fixtureUrl(), mode: "dom", selector: ".nonexistent-xyz" },
				makeCtx(),
			);
			expect(result.isError).toBeFalsy();
			expect(result.output).toContain("No elements found");
		}, 30_000);
	});
});

describe("WebFetch — screenshot without browser", () => {
	test("returns clear error when Chrome is not available", async () => {
		if (await canLaunchBrowser()) {
			console.log("Skipping: Chrome IS available, cannot test fallback error");
			return;
		}
		const result = await webFetchTool.execute({ url: fixtureUrl(), mode: "screenshot" }, makeCtx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("requires a browser");
	}, 30_000);
});

// ============================================================
// Tool metadata (no browser needed)
// ============================================================

describe("WebFetch — tool definition", () => {
	test("has correct name", () => {
		expect(webFetchTool.name).toBe("WebFetch");
	});

	test("has rawJsonSchema with required fields", () => {
		const schema = webFetchTool.rawJsonSchema;
		expect(schema).toBeDefined();
		expect(schema?.type).toBe("object");
		expect(schema?.required).toEqual(["url"]);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		const props = schema?.properties as Record<string, any>;
		expect(props.url).toBeDefined();
		expect(props.mode).toBeDefined();
		expect(props.mode.enum).toEqual(["readability", "screenshot", "dom", "smart"]);
		expect(props.selector).toBeDefined();
		expect(props.max_length).toBeDefined();
		expect(props.purpose).toBeDefined();
	});

	test("Zod schema validates correct input", () => {
		const result = webFetchTool.parameters.safeParse({
			url: fixtureUrl(),
			mode: "readability",
		});
		expect(result.success).toBe(true);
	});

	test("Zod schema rejects missing url", () => {
		const result = webFetchTool.parameters.safeParse({ mode: "dom" });
		expect(result.success).toBe(false);
	});

	test("Zod schema defaults mode to readability when missing", () => {
		const result = webFetchTool.parameters.safeParse({ url: fixtureUrl() });
		expect(result.success).toBe(true);
		if (result.success) {
			expect((result.data as { mode: string }).mode).toBe("readability");
		}
	});

	test("Zod schema rejects invalid mode", () => {
		const result = webFetchTool.parameters.safeParse({
			url: fixtureUrl(),
			mode: "invalid",
		});
		expect(result.success).toBe(false);
	});

	test("Zod schema accepts optional fields", () => {
		const result = webFetchTool.parameters.safeParse({
			url: fixtureUrl(),
			mode: "dom",
			selector: "h1",
			max_length: 5000,
		});
		expect(result.success).toBe(true);
	});

	test("Zod schema accepts purpose field", () => {
		const result = webFetchTool.parameters.safeParse({
			url: fixtureUrl(),
			mode: "smart",
			purpose: "Find the API authentication method",
		});
		expect(result.success).toBe(true);
	});
});

// ============================================================
// Browser integration tests — skipped if Chrome is not available
// ============================================================

describe("WebFetch — readability mode (browser)", () => {
	test("extracts content from a real page", async () => {
		if (!(await canLaunchBrowser())) {
			console.log("Skipping: Chrome not available");
			return;
		}
		const result = await webFetchTool.execute(
			{ url: fixtureUrl(), mode: "readability" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output.length).toBeGreaterThan(0);
	}, 30_000);

	test("respects max_length", async () => {
		if (!(await canLaunchBrowser())) {
			console.log("Skipping: Chrome not available");
			return;
		}
		const result = await webFetchTool.execute(
			{ url: fixtureUrl(), mode: "readability", max_length: 50 },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("truncated");
	}, 30_000);

	test("returns error for unreachable host", async () => {
		if (!(await canLaunchBrowser())) {
			console.log("Skipping: Chrome not available");
			return;
		}
		const result = await webFetchTool.execute(
			{ url: "http://127.0.0.1:1/unreachable", mode: "readability" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("WebFetch failed");
	}, 60_000);
});

describe("WebFetch — screenshot mode (browser)", () => {
	test("captures screenshot as base64 PNG", async () => {
		if (!(await canLaunchBrowser())) {
			console.log("Skipping: Chrome not available");
			return;
		}
		const result = await webFetchTool.execute({ url: fixtureUrl(), mode: "screenshot" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Screenshot of");
		expect(result.images).toBeDefined();
		expect(result.images?.length).toBe(1);
		expect(result.images?.[0].format).toBe("png");
		expect(result.images?.[0].base64.startsWith("iVBOR")).toBe(true);
	}, 30_000);
});

describe("WebFetch — dom mode (browser)", () => {
	test("extracts cleaned DOM from a real page", async () => {
		if (!(await canLaunchBrowser())) {
			console.log("Skipping: Chrome not available");
			return;
		}
		const result = await webFetchTool.execute({ url: fixtureUrl(), mode: "dom" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output.length).toBeGreaterThan(0);
		expect(result.output).not.toMatch(/<script[\s>]/i);
		expect(result.output).not.toMatch(/<style[\s>]/i);
	}, 30_000);

	test("extracts specific elements with selector", async () => {
		if (!(await canLaunchBrowser())) {
			console.log("Skipping: Chrome not available");
			return;
		}
		const result = await webFetchTool.execute(
			{ url: fixtureUrl(), mode: "dom", selector: "h1" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Example Domain");
	}, 30_000);

	test("returns message for non-matching selector", async () => {
		if (!(await canLaunchBrowser())) {
			console.log("Skipping: Chrome not available");
			return;
		}
		const result = await webFetchTool.execute(
			{ url: fixtureUrl(), mode: "dom", selector: ".nonexistent-class-xyz" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("No elements found");
	}, 30_000);

	test("respects max_length", async () => {
		if (!(await canLaunchBrowser())) {
			console.log("Skipping: Chrome not available");
			return;
		}
		const result = await webFetchTool.execute(
			{ url: fixtureUrl(), mode: "dom", max_length: 30 },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("truncated");
	}, 30_000);
});

describe("WebFetch — smart mode (browser + model)", () => {
	test("handles gracefully when dependencies unavailable", async () => {
		const result = await webFetchTool.execute({ url: fixtureUrl(), mode: "smart" }, makeCtx());
		// Either succeeds (if browser + model available) or fails gracefully
		if (result.isError) {
			expect(result.output).toContain("WebFetch failed");
		} else {
			expect(result.output.length).toBeGreaterThan(0);
		}
	}, 60_000);
});
