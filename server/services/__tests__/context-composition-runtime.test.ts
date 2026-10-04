import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// These are module-boundary invariants: no runtime history/provider side effects may
// enter a numeric cache read, regardless of whether the request hits an empty cache.
const service = readFileSync(
	new URL("../narrator-context-composition.ts", import.meta.url),
	"utf8",
);
const reader = readFileSync(new URL("../context-composition-history.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../../routes/narrators.ts", import.meta.url), "utf8");
test("composition no longer builds runtime history, prompts or token estimates", () => {
	for (const source of [service, reader]) {
		for (const forbidden of [
			"buildRuntimeHistory",
			"buildEffectiveSystemPrompt",
			"estimateTokens",
			"content_json",
			"content_text",
			"input_json",
			"output_json",
			"system_prompt",
			"context_summary AS",
		])
			expect(source).not.toContain(forbidden);
	}
});
test("composition endpoint retains read ACL and forwards cancellation plus cursor", () => {
	expect(route).toContain(
		'requireNarratorAccess(c, id, c.req.method === "GET" ? "read" : "write")',
	);
	const endpoint = route.slice(
		route.indexOf('narratorRoutes.get("/:id/context-composition"'),
		route.indexOf("\n});", route.indexOf('narratorRoutes.get("/:id/context-composition"')) + 4,
	);
	expect(endpoint).toContain(
		'getNarratorContextComposition(c.req.param("id"), c.req.raw.signal, c.req.query("cursor"))',
	);
	expect(endpoint).not.toContain("getUserLanguage");
});
