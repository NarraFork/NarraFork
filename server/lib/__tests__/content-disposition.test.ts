import { describe, expect, it } from "bun:test";
import { buildAttachmentDisposition, sanitizeAttachmentFileName } from "../content-disposition";

describe("sanitizeAttachmentFileName", () => {
	it("keeps an ordinary name untouched", () => {
		expect(sanitizeAttachmentFileName("api-request-2026-08-17.json")).toBe(
			"api-request-2026-08-17.json",
		);
	});

	it("reduces a path to its basename, for both separators", () => {
		expect(sanitizeAttachmentFileName("/repo/logs/a.json")).toBe("a.json");
		expect(sanitizeAttachmentFileName("C:\\repo\\logs\\a.json")).toBe("a.json");
	});

	// The value becomes a filename on the client, so it must not be able to
	// express a path or climb out of the download directory.
	it("never yields a traversal segment", () => {
		expect(sanitizeAttachmentFileName("../../etc/passwd")).toBe("passwd");
		expect(sanitizeAttachmentFileName("..")).toBe("download");
		expect(sanitizeAttachmentFileName(".")).toBe("download");
	});

	it("falls back for empty and absent input", () => {
		expect(sanitizeAttachmentFileName("")).toBe("download");
		expect(sanitizeAttachmentFileName(null)).toBe("download");
		expect(sanitizeAttachmentFileName(undefined)).toBe("download");
		expect(sanitizeAttachmentFileName("   ")).toBe("download");
	});

	// CR/LF in a header value is header injection, not a cosmetic problem: the
	// filename comes off the filesystem, where newlines are legal characters.
	it("strips control characters, CR/LF and quotes", () => {
		expect(sanitizeAttachmentFileName("a\r\nX-Evil: 1\r\n\r\nb.json")).toBe("aX-Evil 1b.json");
		expect(sanitizeAttachmentFileName('we"ird.json')).toBe("weird.json");
		expect(sanitizeAttachmentFileName("na\u0000me.json")).toBe("name.json");
	});

	// A `;` is legal inside the quoted `filename`, but every parser that splits on
	// `;` before unquoting (including this repo's own) would then read a truncated
	// name plus an invented parameter.
	it("strips the header's parameter delimiters", () => {
		expect(sanitizeAttachmentFileName("a;b,c.json")).toBe("abc.json");
	});

	it("bounds the length so a pathological name cannot bloat the header", () => {
		expect(sanitizeAttachmentFileName(`${"a".repeat(500)}.json`).length).toBe(120);
	});
});

describe("buildAttachmentDisposition", () => {
	it("marks the response as an attachment with both filename spellings", () => {
		expect(buildAttachmentDisposition("report.json")).toBe(
			"attachment; filename=\"report.json\"; filename*=UTF-8''report.json",
		);
	});

	// `filename` is a quoted ASCII parameter, so a CJK name is only transportable
	// via RFC 5987 `filename*`; the fallback must still be a usable name.
	it("percent-encodes a CJK name and keeps an ASCII fallback with the extension", () => {
		const header = buildAttachmentDisposition("报告.json");
		expect(header).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A.json");
		expect(header).toContain('filename="__.json"');
	});

	it("cannot be broken out of by a quote or a newline in the name", () => {
		const header = buildAttachmentDisposition('evil";\r\nX-Injected: 1');
		expect(header).not.toContain("\r");
		expect(header).not.toContain("\n");
		// Exactly the two parameters we emit, so nothing extra was smuggled in.
		expect(header.split(";").length).toBe(3);
	});
});
