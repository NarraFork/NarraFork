import { describe, expect, test } from "bun:test";
import { createProjectSchema, updateProjectSchema } from "../projects";

describe("updateProjectSchema flowMode", () => {
	/**
	 * The reason this field exists on the update schema at all.
	 *
	 * `projects.flow_mode` was writable only by `createProjectSchema`; no update path
	 * accepted it, so a project created in `ruler` mode rendered the Ruler canvas forever
	 * with no way back to the classic view. That became a real dead end once Ruler was
	 * deprecated — the deprecated view was the only view those projects could ever show.
	 */
	test("accepts switching an existing project between the two canvases", () => {
		expect(updateProjectSchema.parse({ flowMode: "classic" }).flowMode).toBe("classic");
		expect(updateProjectSchema.parse({ flowMode: "ruler" }).flowMode).toBe("ruler");
	});

	test("leaves flowMode alone when the caller does not mention it", () => {
		// Optional, not defaulted: the PATCH handler spreads the parsed result straight into
		// the update, so a default here would silently rewrite the column on every unrelated
		// project edit (a proxy-domain change would reset the view).
		const parsed = updateProjectSchema.parse({ name: "Renamed" });
		expect("flowMode" in parsed).toBe(false);
	});

	test("rejects unknown canvases", () => {
		expect(updateProjectSchema.safeParse({ flowMode: "timeline" }).success).toBe(false);
	});
});

describe("createProjectSchema flowMode", () => {
	test("defaults to the classic canvas", () => {
		// Ruler is deprecated, so anything that does not ask for it must not get it.
		const parsed = createProjectSchema.parse({
			name: "Fresh",
			repoMode: "existing",
			gitPath: "/tmp/repo",
		});
		expect(parsed.flowMode).toBe("classic");
	});

	test("still allows opting into the deprecated Ruler explicitly", () => {
		// Deprecated means "no longer developed", not "removed": existing workflows that
		// deliberately pick it keep working.
		const parsed = createProjectSchema.parse({
			name: "Fresh",
			repoMode: "existing",
			gitPath: "/tmp/repo",
			flowMode: "ruler",
		});
		expect(parsed.flowMode).toBe("ruler");
	});
});
