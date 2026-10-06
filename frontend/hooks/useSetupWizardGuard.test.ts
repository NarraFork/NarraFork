import { describe, expect, test } from "bun:test";
import { shouldBlockForSetupWizard } from "./useSetupWizardGuard";

describe("shouldBlockForSetupWizard", () => {
	test("blocks an admin who has not completed the wizard", () => {
		expect(shouldBlockForSetupWizard({ role: "admin", setupWizardCompleted: false })).toBe(true);
	});

	test("lets an admin through once the wizard is completed", () => {
		expect(shouldBlockForSetupWizard({ role: "admin", setupWizardCompleted: true })).toBe(false);
	});

	test("never blocks a non-admin, even with an incomplete wizard", () => {
		// setupWizardCompleted is per-user and defaults to false, so every newly
		// registered user looks "incomplete". The wizard configures instance-wide
		// settings they cannot change, so they must not be gated on it.
		expect(shouldBlockForSetupWizard({ role: "user", setupWizardCompleted: false })).toBe(false);
	});

	test("does not block while the role or preference is still loading", () => {
		expect(shouldBlockForSetupWizard({ role: undefined, setupWizardCompleted: false })).toBe(false);
		expect(shouldBlockForSetupWizard({ role: "admin", setupWizardCompleted: undefined })).toBe(
			false,
		);
	});
});
