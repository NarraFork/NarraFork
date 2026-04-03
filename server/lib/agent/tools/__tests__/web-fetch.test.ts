import { afterAll, describe, expect, test } from "bun:test";
import { cleanHtml } from "../../../web-fetch/dom";
import type { ToolContext } from "../../types";
import { webFetchTool } from "../web-fetch";

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

afterAll(async () => {
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

	test("rejects non-http protocol", async () => {
		const result = await webFetchTool.execute(
			{ url: "ftp://example.com", mode: "readability" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("http");
	});

	test("rejects file:// protocol", async () => {
		const result = await webFetchTool.execute(
			{ url: "file:///etc/passwd", mode: "dom" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("http");
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
});

// ============================================================
// Unknown mode (no browser needed)
// ============================================================

describe("WebFetch — parameter handling", () => {
	test("unknown mode returns error", async () => {
		const result = await webFetchTool.execute(
			{ url: "https://example.com", mode: "invalid_mode" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Unknown mode");
	});

	test("defaults to readability mode when mode is omitted", async () => {
		const result = await webFetchTool.execute({ url: "https://example.com" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output.length).toBeGreaterThan(0);
	}, 30_000);
});

// ============================================================
// HTTP fallback tests (no browser needed, real network)
// ============================================================

describe("WebFetch — HTTP fallback (readability)", () => {
	test("extracts content from example.com via HTTP fallback", async () => {
		const result = await webFetchTool.execute(
			{ url: "https://example.com", mode: "readability" },
			makeCtx(),
		);
		// Should succeed even without Chrome — HTTP fallback kicks in
		expect(result.isError).toBeFalsy();
		expect(result.output.length).toBeGreaterThan(0);
	}, 30_000);

	test("extracts content from raw GitHub markdown", async () => {
		const result = await webFetchTool.execute(
			{
				url: "https://raw.githubusercontent.com/nicbarker/clay/main/README.md",
				mode: "readability",
			},
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		// Raw markdown may not extract well via Readability, but should return something
		expect(result.output.length).toBeGreaterThan(0);
	}, 30_000);

	test("respects max_length via HTTP fallback", async () => {
		const result = await webFetchTool.execute(
			{ url: "https://example.com", mode: "readability", max_length: 50 },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("truncated");
	}, 30_000);

	test("returns error for unreachable host", async () => {
		const result = await webFetchTool.execute(
			{ url: "https://this-domain-does-not-exist-12345.com", mode: "readability" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("WebFetch failed");
	}, 60_000);
});

describe("WebFetch — HTTP fallback (dom)", () => {
	test("extracts cleaned DOM via HTTP fallback", async () => {
		const result = await webFetchTool.execute(
			{ url: "https://example.com", mode: "dom" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output.length).toBeGreaterThan(0);
		expect(result.output).not.toMatch(/<script[\s>]/i);
	}, 30_000);

	test("extracts elements with selector via linkedom", async () => {
		const result = await webFetchTool.execute(
			{ url: "https://example.com", mode: "dom", selector: "h1" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Example Domain");
	}, 30_000);

	test("returns message for non-matching selector", async () => {
		const result = await webFetchTool.execute(
			{ url: "https://example.com", mode: "dom", selector: ".nonexistent-xyz" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("No elements found");
	}, 30_000);
});

describe("WebFetch — screenshot without browser", () => {
	test("returns clear error when Chrome is not available", async () => {
		if (await canLaunchBrowser()) {
			console.log("Skipping: Chrome IS available, cannot test fallback error");
			return;
		}
		const result = await webFetchTool.execute(
			{ url: "https://example.com", mode: "screenshot" },
			makeCtx(),
		);
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
			url: "https://example.com",
			mode: "readability",
		});
		expect(result.success).toBe(true);
	});

	test("Zod schema rejects missing url", () => {
		const result = webFetchTool.parameters.safeParse({ mode: "dom" });
		expect(result.success).toBe(false);
	});

	test("Zod schema defaults mode to readability when missing", () => {
		const result = webFetchTool.parameters.safeParse({ url: "https://example.com" });
		expect(result.success).toBe(true);
		if (result.success) {
			expect((result.data as { mode: string }).mode).toBe("readability");
		}
	});

	test("Zod schema rejects invalid mode", () => {
		const result = webFetchTool.parameters.safeParse({
			url: "https://example.com",
			mode: "invalid",
		});
		expect(result.success).toBe(false);
	});

	test("Zod schema accepts optional fields", () => {
		const result = webFetchTool.parameters.safeParse({
			url: "https://example.com",
			mode: "dom",
			selector: "h1",
			max_length: 5000,
		});
		expect(result.success).toBe(true);
	});

	test("Zod schema accepts purpose field", () => {
		const result = webFetchTool.parameters.safeParse({
			url: "https://example.com",
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
			{ url: "https://example.com", mode: "readability" },
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
			{ url: "https://example.com", mode: "readability", max_length: 50 },
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
			{ url: "https://this-domain-does-not-exist-12345.com", mode: "readability" },
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
		const result = await webFetchTool.execute(
			{ url: "https://example.com", mode: "screenshot" },
			makeCtx(),
		);
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
		const result = await webFetchTool.execute(
			{ url: "https://example.com", mode: "dom" },
			makeCtx(),
		);
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
			{ url: "https://example.com", mode: "dom", selector: "h1" },
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
			{ url: "https://example.com", mode: "dom", selector: ".nonexistent-class-xyz" },
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
			{ url: "https://example.com", mode: "dom", max_length: 30 },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("truncated");
	}, 30_000);
});

describe("WebFetch — smart mode (browser + model)", () => {
	test("handles gracefully when dependencies unavailable", async () => {
		const result = await webFetchTool.execute(
			{ url: "https://example.com", mode: "smart" },
			makeCtx(),
		);
		// Either succeeds (if browser + model available) or fails gracefully
		if (result.isError) {
			expect(result.output).toContain("WebFetch failed");
		} else {
			expect(result.output.length).toBeGreaterThan(0);
		}
	}, 60_000);
});
