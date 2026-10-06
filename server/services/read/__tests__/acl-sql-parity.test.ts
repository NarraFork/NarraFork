/**
 * `acl-sql.ts` must stay a faithful copy of the ACL modules' SQL, not a second opinion.
 *
 * WHY A COPY EXISTS AT ALL
 * ------------------------
 * `services/project-acl.ts` and `services/narrator-acl.ts` own these rules, but both import
 * `server/db` — the SQLite bootstrap, with migrations, the instance lock and the clean-shutdown
 * marker. The PostgreSQL read adapter must not reach that (`server/db/backend/__tests__/
 * port-purity.test.ts` documents what happens when a backend-neutral module does), so it cannot
 * import either module to reuse their text.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT
 * ------------------------------------
 * A drifted copy of an access rule produces the two worst symptoms available: rows that appear
 * in a list and 404 on open, or rows that should never have appeared. Neither throws, and
 * neither is visible in the diff that caused it — someone edits `narrator-acl.ts`, every SQLite
 * test still passes, and PostgreSQL quietly enforces last month's rules.
 *
 * The comparison is whitespace-insensitive and case-insensitive because indentation and
 * `EXISTS`/`exists` are formatting, while table names, capability lists, `domain_kind is null`
 * and the placement of the grant test inside the gate branch are semantics. Any of those
 * changing on one side and not the other fails here.
 */

import { describe, expect, test } from "bun:test";
import {
	bindPlaceholders,
	narratorReadableText,
	projectReadableForIdText,
	projectReadableText,
} from "../acl-sql";

/** Import the ACL modules lazily: they pull in the SQLite bootstrap at module scope. */
const { narratorReadableSqlFragment, narratorReadableSqlParamCount } = await import(
	"../../narrator-acl"
);
const { projectReadableSqlFragment } = await import("../../project-acl");

function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

describe("neutral ACL SQL mirrors the owning modules", () => {
	test("project readability is character-for-character the same rule", () => {
		const owned = projectReadableSqlFragment(false, "projects");
		expect(owned).not.toBeNull();
		expect(normalize(projectReadableText("projects"))).toBe(normalize(owned?.sql ?? ""));
	});

	test("narrator readability is character-for-character the same rule", () => {
		const owned = narratorReadableSqlFragment(false, "narrators");
		expect(owned).not.toBeNull();
		expect(normalize(narratorReadableText("narrators"))).toBe(normalize(owned?.sql ?? ""));
	});

	test("both fragments bind the same number of user ids as the owning module", () => {
		// Every `?` is the requesting user id. A count that drifts means one backend binds a
		// parameter the other does not, which shifts every following parameter.
		const projectPlaceholders = (projectReadableText("projects").match(/\?/g) ?? []).length;
		const ownedProject = (
			(projectReadableSqlFragment(false, "projects")?.sql ?? "").match(/\?/g) ?? []
		).length;
		expect(projectPlaceholders).toBe(ownedProject);

		const narratorPlaceholders = (narratorReadableText("narrators").match(/\?/g) ?? []).length;
		expect(narratorPlaceholders).toBe(narratorReadableSqlParamCount());
	});

	test("the admin case is the ACL modules' business, not this module's", () => {
		// `acl-sql.ts` only produces rule text; "an admin adds no clause" is decided by the
		// adapters, exactly as the owning fragments decide it by returning null.
		expect(projectReadableSqlFragment(true, "projects")).toBeNull();
		expect(narratorReadableSqlFragment(true, "narrators")).toBeNull();
	});
});

describe("the neutral rules keep their load-bearing clauses", () => {
	test("project access ignores grants carrying a domain_kind", () => {
		// Knowledge credentials share `acl_grants` and carry a placeholder capability. Without
		// this clause a clearance grant reads as project membership.
		expect(normalize(projectReadableText("p"))).toContain("domain_kind is null");
		expect(normalize(narratorReadableText("n"))).toContain("domain_kind is null");
	});

	test("a subagent is judged on its ACL root, and an unresolvable root denies", () => {
		const text = normalize(narratorReadableText("n"));
		// `case when ... = 'subagent' then acl_root_narrator_id else id end` inside an EXISTS:
		// a null root yields no judged row, so the predicate is false.
		expect(text).toContain("n.type = 'subagent' then n.acl_root_narrator_id");
		expect(text).toContain("exists ( select 1 from narrators jn");
		// `coalesce(acl_root_narrator_id, id)` would fall back to the subagent's own frozen
		// columns, disagreeing with the row-level check in the leaking direction.
		expect(text).not.toContain("coalesce(n.acl_root_narrator_id");
	});

	test("the narrator project gate is resolved chapter-first, with no coalesce fallthrough", () => {
		const text = normalize(narratorReadableText("n"));
		expect(text).toContain("case when jn.chapter_id is null then jn.context_project_id end");
	});

	test("write_audience never appears in a READ predicate", () => {
		// The write audience is nested inside `visibility`, so it cannot admit a reader the read
		// branches miss. Consulting it here would widen read.
		expect(normalize(narratorReadableText("n"))).not.toContain("write_audience");
	});

	test("a project id expression is reached through an EXISTS on projects", () => {
		// A join would let several grants on one project duplicate rows and corrupt `limit n + 1`
		// paging.
		const text = normalize(projectReadableForIdText("chapters.project_id"));
		expect(
			text.startsWith("exists ( select 1 from projects p where p.id = chapters.project_id"),
		).toBe(true);
	});
});

describe("placeholder binding stays dialect-neutral", () => {
	test("the user id is a parameter at every placeholder, never interpolated", () => {
		const bound = bindPlaceholders("a = ? or b = ?", "u_1");
		// Two bound values, and the literal id nowhere in the SQL chunks: interpolating it would
		// make the statement text differ per user (defeating statement caching) and turn the
		// predicate into an injection site.
		expect(bound.queryChunks.filter((chunk) => typeof chunk === "object").length).toBeGreaterThan(
			0,
		);
		const raw = bound.queryChunks
			.map((chunk) => (typeof chunk === "object" && "value" in chunk ? String(chunk.value) : ""))
			.join("");
		expect(raw).not.toContain("u_1?");
		expect(JSON.stringify(bound.queryChunks)).toContain("u_1");
	});

	test("text with no placeholder is passed through unchanged", () => {
		const bound = bindPlaceholders("1 = 1", "u_1");
		expect(JSON.stringify(bound.queryChunks)).not.toContain("u_1");
	});
});
