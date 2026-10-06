import { describe, expect, it } from "bun:test";
import {
	availableModes,
	fileBaseName,
	isMarkdownPath,
	MAX_FILE_VIEWER_TEXT_CHARS,
	resolveNodeUnavailable,
} from "./FileViewerContent";

/**
 * The docked file viewer's read cap must stay aligned with the backend's own text
 * limit, otherwise the panel silently truncates files the API was perfectly happy
 * to serve — which is exactly the bug this constant was introduced to fix (it
 * originally reused the hover-preview modal's much tighter 120k cap and cut every
 * large source file at ~40% with only a vague notice).
 *
 * `MAX_TEXT_PREVIEW_BYTES` in server/routes/fs.ts is 1 MB. A UTF-8 character
 * never encodes in less than one byte, so a 1 MB response can never carry more
 * characters than this cap: it is only reached for payloads the backend would
 * already have rejected with 413.
 */
const BACKEND_MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

describe("MAX_FILE_VIEWER_TEXT_CHARS", () => {
	it("is not below the backend's byte limit, so served files are never clipped", () => {
		expect(MAX_FILE_VIEWER_TEXT_CHARS).toBeGreaterThanOrEqual(BACKEND_MAX_TEXT_PREVIEW_BYTES);
	});

	// A round 1e6 is the tempting-but-wrong value: it reads as "one million" yet
	// clips the last 48,576 chars of an ASCII file the backend served in full.
	it("matches the byte ceiling exactly rather than a round decimal million", () => {
		expect(MAX_FILE_VIEWER_TEXT_CHARS).toBe(BACKEND_MAX_TEXT_PREVIEW_BYTES);
		expect(MAX_FILE_VIEWER_TEXT_CHARS).not.toBe(1_000_000);
	});

	it("stays finite so a pathological payload still cannot stream unbounded", () => {
		expect(Number.isFinite(MAX_FILE_VIEWER_TEXT_CHARS)).toBe(true);
		expect(MAX_FILE_VIEWER_TEXT_CHARS).toBeLessThanOrEqual(BACKEND_MAX_TEXT_PREVIEW_BYTES * 4);
	});
});

describe("resolveNodeUnavailable", () => {
	it("returns null for a file that has no node mode at all", () => {
		expect(
			resolveNodeUnavailable({ structuredFormat: null, truncated: true, parseFailed: true }),
		).toBeNull();
	});

	it("returns null when a structured file parsed cleanly", () => {
		expect(
			resolveNodeUnavailable({ structuredFormat: "json", truncated: false, parseFailed: false }),
		).toBeNull();
	});

	it("reports a genuine syntax failure as parse-error", () => {
		expect(
			resolveNodeUnavailable({ structuredFormat: "toml", truncated: false, parseFailed: true }),
		).toBe("parse-error");
	});

	// The regression this function exists for: a truncated read never reaches the
	// parser, so blaming the file's syntax is fabricating a verdict — and it used to
	// show that verdict NEXT TO the truncation notice, saying the same thing twice.
	it("reports truncation as truncated, never as a syntax failure", () => {
		expect(
			resolveNodeUnavailable({ structuredFormat: "json", truncated: true, parseFailed: false }),
		).toBe("truncated");
	});

	it("still prefers truncation when a stale parse verdict is also present", () => {
		expect(
			resolveNodeUnavailable({ structuredFormat: "json", truncated: true, parseFailed: true }),
		).toBe("truncated");
	});
});

describe("mode availability", () => {
	it("gives markdown a rendered preview plus raw, and no node mode", () => {
		expect(isMarkdownPath("/repo/README.md")).toBe(true);
		expect(availableModes("/repo/README.md")).toEqual(["preview", "raw"]);
	});

	it("gives structured data a node tree plus raw", () => {
		expect(availableModes("/repo/package.json")).toEqual(["node", "raw"]);
		expect(availableModes("/repo/Cargo.toml")).toEqual(["node", "raw"]);
		expect(availableModes("/etc/php.ini")).toEqual(["node", "raw"]);
	});

	// A single mode tells the panel to hide the switch rather than render a
	// one-option control.
	it("leaves code, text and yaml with raw only", () => {
		expect(availableModes("/repo/src/main.ts")).toEqual(["raw"]);
		expect(availableModes("/repo/notes.txt")).toEqual(["raw"]);
		expect(availableModes("/repo/compose.yaml")).toEqual(["raw"]);
	});
});

describe("fileBaseName", () => {
	it("handles posix and windows separators, and a bare name", () => {
		expect(fileBaseName("/a/b/c.md")).toBe("c.md");
		expect(fileBaseName("C:\\a\\b\\c.md")).toBe("c.md");
		expect(fileBaseName("c.md")).toBe("c.md");
		expect(fileBaseName("./c.md")).toBe("c.md");
		expect(fileBaseName("/work/a\\b.md")).toBe("a\\b.md");
		expect(fileBaseName("/work/a\\b/readme.md")).toBe("readme.md");
		expect(fileBaseName("C:/work\\readme.md")).toBe("readme.md");
		expect(fileBaseName("C:\\readme.md")).toBe("readme.md");
	});
});
