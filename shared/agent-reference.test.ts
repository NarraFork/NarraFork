import { describe, expect, test } from "bun:test";
import {
	agentReferenceHref,
	agentReferenceMarker,
	normalizeAgentReferenceLabel,
	parseAgentReference,
} from "./agent-reference";

describe("agent references", () => {
	test("normalizes a full title without discarding its Unicode text", () => {
		expect(normalizeAgentReferenceLabel("  中文\n标题\t  e\u0301  ")).toBe("中文 标题 e\u0301");
		expect(normalizeAgentReferenceLabel(" ")).toBe("");
	});
	test("round trips real case-sensitive session IDs through authored and inert links", () => {
		for (const id of ["a", "Child_A-123", "x".repeat(128)]) {
			expect(parseAgentReference(agentReferenceHref(id))).toBe(id);
			expect(parseAgentReference(agentReferenceMarker(id))).toBe(id);
		}
	});
	test("refuses other schemes, malformed URLs, extra fields and non-ID payloads", () => {
		for (const href of [
			undefined,
			"",
			"nf-agent://open",
			"nf-agent://other?id=x",
			"nf-agent://user@open?id=x",
			"nf-agent://open:80?id=x",
			"nf-agent://open/path?id=x",
			"nf-agent://open?id=x#h",
			"nf-agent://open?id=x&id=y",
			"nf-agent://open?id=x&extra=y",
			"nf-agent://open?id=..%2Fx",
			"nf-agent://open?id=%",
			"nf-agent://open?id=任务",
			`nf-agent://open?id=${"x".repeat(129)}`,
			"#nf-agent=",
			"#nf-agent=x&y=z",
			"javascript:alert(1)",
			"https://open?id=x",
			"//open?id=x",
			"file:///tmp/x",
		]) {
			expect(parseAgentReference(href)).toBeNull();
		}
	});
});
