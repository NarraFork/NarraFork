import { describe, expect, it } from "bun:test";
import { ensureNonEmptySchema } from "../../../../server/lib/agent/tool-registry";

/**
 * parameter, so `ensureNonEmptySchema` has to mark SOMETHING required.
 *
 * It used to promote `Object.keys(properties)[0]`, which lied about the tool's
 * contract. The visible fallout: ExitPlanMode's first declared property was the
 * parameter while `inline_plan` — the field that actually carries the plan —
 * stayed optional. Models fabricated permission declarations to fill it, and
 * that invented list showed up in the tool-call inspector.
 *
 * These tests pin the replacement rule: never promote a real field, always
 * inject an inert `const: true` dummy.
 */
describe("ensureNonEmptySchema", () => {
	it("injects a dummy instead of promoting an existing optional property", () => {
		const schema = {
			type: "object",
			properties: {
				allowedPrompts: { type: "array" },
				inline_plan: { type: "string" },
			},
		};

		const result = ensureNonEmptySchema(schema);

		expect(result.required).toEqual(["confirm"]);
		const props = result.properties as Record<string, unknown>;
		// Every declared property survives, none of them becomes required.
		expect(props.allowedPrompts).toBeDefined();
		expect(props.inline_plan).toBeDefined();
		expect(props.confirm).toEqual({
			type: "boolean",
			description: "Dummy parameter (always pass true)",
			const: true,
			default: true,
		});
	});

	it("leaves a schema that already declares a required property untouched", () => {
		const schema = {
			type: "object",
			properties: { file_path: { type: "string" }, content: { type: "string" } },
			required: ["file_path", "content"],
		};

		expect(ensureNonEmptySchema(schema)).toBe(schema);
	});

	it("still handles a schema with no properties at all", () => {
		const result = ensureNonEmptySchema({ type: "object", properties: {} });

		expect(result.required).toEqual(["confirm"]);
		expect(Object.keys(result.properties as Record<string, unknown>)).toEqual(["confirm"]);
	});

	it("handles a schema with no properties key", () => {
		const result = ensureNonEmptySchema({ type: "object" });

		expect(result.required).toEqual(["confirm"]);
		expect(Object.keys(result.properties as Record<string, unknown>)).toEqual(["confirm"]);
	});

	it("treats an empty required array as absent", () => {
		const result = ensureNonEmptySchema({
			type: "object",
			properties: { a: { type: "string" } },
			required: [],
		});

		expect(result.required).toEqual(["confirm"]);
	});

	it("does not mutate the input schema", () => {
		const properties = { a: { type: "string" } };
		const schema: Record<string, unknown> = { type: "object", properties };

		ensureNonEmptySchema(schema);

		expect(schema.required).toBeUndefined();
		expect(Object.keys(properties)).toEqual(["a"]);
	});

	it("overrides a tool's own all-optional confirm rather than leaving it optional", () => {
		// dangerConfirm/dangerCancel already declare `confirm: z.literal(true).optional()`.
		// The injected dummy must win, because a `confirm` that is present but not
		// required would leave the schema with nothing required and still be truncated.
		const result = ensureNonEmptySchema({
			type: "object",
			properties: {
				confirm: { type: "boolean", const: true, description: "Optional compatibility flag." },
				reflection: { type: "string" },
			},
		});

		expect(result.required).toEqual(["confirm"]);
		const props = result.properties as Record<string, Record<string, unknown>>;
		expect(props.confirm.const).toBe(true);
		expect(props.confirm.default).toBe(true);
		expect(props.reflection).toBeDefined();
	});

	it("never marks a plan-carrying or name-generating field required", () => {
		// ExitPlanMode (inline allowed) and EnterPlanMode shapes: both are
		// all-optional by design, and both were previously misrepresented.
		const exitPlanMode = ensureNonEmptySchema({
			type: "object",
			properties: { inline_plan: { type: "string" } },
		});
		expect(exitPlanMode.required).not.toContain("inline_plan");

		const enterPlanMode = ensureNonEmptySchema({
			type: "object",
			properties: { plan_name: { type: "string" } },
		});
		expect(enterPlanMode.required).not.toContain("plan_name");

		// Agent: `description` is only needed when launching, not for `stop`.
		const agent = ensureNonEmptySchema({
			type: "object",
			properties: { description: { type: "string" }, stop: { type: "string" } },
		});
		expect(agent.required).not.toContain("description");
	});
});
