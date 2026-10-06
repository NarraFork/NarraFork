import { describe, expect, test } from "bun:test";
import {
	assertBoundScope,
	assertScopedPrincipal,
	fieldBindingToScope,
	RESOURCE_SCOPE_FIELD_BY_TYPE,
	RESOURCE_TYPE_BY_SCOPE_FIELD,
	ResourceScopeBindingError,
	resourceRefSchema,
	resourceScopeSchema,
	resourceToScope,
	scopeContains,
	scopeIntersects,
	scopeToFieldBinding,
} from "@server/lib/integrations/resource-scope";
import { CAPABILITY_RESOURCE_TYPES } from "@shared/integrations/capabilities";

describe("canonical resource scopes", () => {
	test("uses strict and unambiguous global/id scope shapes", () => {
		expect(resourceScopeSchema.safeParse({ type: "global" }).success).toBe(true);
		expect(resourceScopeSchema.safeParse({ type: "global", id: "unexpected" }).success).toBe(false);
		expect(resourceScopeSchema.safeParse({ type: "project", id: "project-1" }).success).toBe(true);
		expect(resourceScopeSchema.safeParse({ type: "project" }).success).toBe(false);
		expect(resourceRefSchema.safeParse({ type: "project", id: " project-1" }).success).toBe(false);
		expect(
			resourceRefSchema.safeParse({ type: "project", id: "project-1", extra: true }).success,
		).toBe(false);
	});

	test("converts resources without widening their identity", () => {
		const resource = { type: "narrator" as const, id: "narrator-1" };
		expect(resourceToScope(resource)).toEqual(resource);
		expect(() => resourceToScope({ type: "global" })).toThrow();
	});

	test("defines fail-closed containment and intersection semantics", () => {
		const global = { type: "global" as const };
		const project = { type: "project" as const, id: "project-1" };
		const sameProject = { type: "project" as const, id: "project-1" };
		const otherProject = { type: "project" as const, id: "project-2" };
		const chapter = { type: "chapter" as const, id: "chapter-1" };

		expect(scopeContains(global, project)).toBe(true);
		expect(scopeContains(project, global)).toBe(false);
		expect(scopeContains(project, sameProject)).toBe(true);
		expect(scopeContains(project, otherProject)).toBe(false);
		expect(scopeContains(project, chapter)).toBe(false);

		expect(scopeIntersects(global, chapter)).toBe(true);
		expect(scopeIntersects(project, sameProject)).toBe(true);
		expect(scopeIntersects(project, otherProject)).toBe(false);
		expect(scopeIntersects(project, chapter)).toBe(false);
	});

	test("asserts requested scopes against trusted bindings", () => {
		const project = { type: "project" as const, id: "project-1" };
		expect(assertBoundScope({ type: "global" }, project)).toEqual(project);
		expect(assertBoundScope(project, project)).toEqual(project);
		expect(() => assertBoundScope(project, { type: "project", id: "project-2" })).toThrow(
			ResourceScopeBindingError,
		);
	});

	test("owns a complete one-to-one scope-field mapping", () => {
		const fields = Object.values(RESOURCE_SCOPE_FIELD_BY_TYPE);
		expect(Object.keys(RESOURCE_SCOPE_FIELD_BY_TYPE).sort()).toEqual(
			[...CAPABILITY_RESOURCE_TYPES].sort(),
		);
		expect(new Set(fields).size).toBe(fields.length);

		for (const type of CAPABILITY_RESOURCE_TYPES) {
			const field = RESOURCE_SCOPE_FIELD_BY_TYPE[type];
			expect(RESOURCE_TYPE_BY_SCOPE_FIELD[field]).toBe(type);
			const scope = { type, id: `${type}-1` };
			expect(scopeToFieldBinding(scope)).toEqual({ [field]: `${type}-1` });
			expect(fieldBindingToScope(field, `${type}-1`)).toEqual(scope);
		}
		expect(scopeToFieldBinding({ type: "global" })).toEqual({});
	});
});

describe("canonical principal refs", () => {
	test("requires ids for identified principals and forbids authority on system", () => {
		expect(assertScopedPrincipal({ type: "user", id: "user-1" })).toEqual({
			type: "user",
			id: "user-1",
		});
		expect(assertScopedPrincipal({ type: "system" })).toEqual({ type: "system" });
		expect(() => assertScopedPrincipal({ type: "user" })).toThrow();
		expect(() => assertScopedPrincipal({ type: "system", id: "root" })).toThrow();
		expect(() => assertScopedPrincipal({ type: "user", id: " user-1" })).toThrow();
	});
});
