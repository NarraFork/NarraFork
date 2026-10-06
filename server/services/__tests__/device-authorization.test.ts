/**
 * Two-axis device authorization.
 *
 * The axes are independent:
 *  - project axis (`scope`/`projectId`): which projects may use the device
 *  - owner axis (`ownerScope`/`createdBy`): whether it is personal or communal
 *
 * The matrix below is written around the four deployments this was designed for,
 * so a regression shows up as a named scenario rather than an abstract flag flip.
 */
import { describe, expect, test } from "bun:test";
import {
	type DeviceAuthorizationContext,
	isDeviceAuthorized,
	isDeviceAuthorizedForProject,
} from "../device-service";

const OWNER = "user-owner";
const OTHER = "user-other";
const PROJECT = "project-a";
const OTHER_PROJECT = "project-b";

type Device = Parameters<typeof isDeviceAuthorized>[0];

/** A personal dev box that follows its owner across every project. */
const personalMachine: Device = {
	ownerScope: "private",
	createdBy: OWNER,
	scope: "global",
	projectId: null,
};

/** A project deploy target: everyone on the project, that project only. */
const projectDeployTarget: Device = {
	ownerScope: "shared",
	createdBy: OWNER,
	scope: "project",
	projectId: PROJECT,
};

/** A communal build machine: everyone, everywhere. */
const communalBuildMachine: Device = {
	ownerScope: "shared",
	createdBy: OWNER,
	scope: "global",
	projectId: null,
};

/** A personal box deliberately confined to one project. */
const personalProjectBox: Device = {
	ownerScope: "private",
	createdBy: OWNER,
	scope: "project",
	projectId: PROJECT,
};

function check(device: Device, context: DeviceAuthorizationContext): boolean {
	return isDeviceAuthorized(device, context);
}

describe("personal dev box (private + global)", () => {
	test("its owner may use it in any project", () => {
		expect(check(personalMachine, { userId: OWNER, projectId: PROJECT })).toBe(true);
		expect(check(personalMachine, { userId: OWNER, projectId: OTHER_PROJECT })).toBe(true);
		expect(check(personalMachine, { userId: OWNER, projectId: null })).toBe(true);
	});

	test("another user may never use it, even in a shared project", () => {
		expect(check(personalMachine, { userId: OTHER, projectId: PROJECT })).toBe(false);
		expect(check(personalMachine, { userId: OTHER, projectId: null })).toBe(false);
	});

	test("an unattended path with no acting user is refused", () => {
		// Nothing can prove ownership here, so "private" must not degrade to allowed.
		expect(check(personalMachine, { projectId: PROJECT })).toBe(false);
		expect(check(personalMachine, {})).toBe(false);
		expect(check(personalMachine, { userId: null })).toBe(false);
	});
});

describe("project deploy target (shared + project)", () => {
	test("any user on that project may use it", () => {
		expect(check(projectDeployTarget, { userId: OWNER, projectId: PROJECT })).toBe(true);
		expect(check(projectDeployTarget, { userId: OTHER, projectId: PROJECT })).toBe(true);
	});

	test("it is invisible outside its project", () => {
		expect(check(projectDeployTarget, { userId: OWNER, projectId: OTHER_PROJECT })).toBe(false);
		expect(check(projectDeployTarget, { userId: OWNER, projectId: null })).toBe(false);
	});

	test("no acting user is fine because it is shared", () => {
		expect(check(projectDeployTarget, { projectId: PROJECT })).toBe(true);
	});
});

describe("communal build machine (shared + global)", () => {
	test("available to everyone, in and out of projects", () => {
		expect(check(communalBuildMachine, { userId: OWNER, projectId: PROJECT })).toBe(true);
		expect(check(communalBuildMachine, { userId: OTHER, projectId: OTHER_PROJECT })).toBe(true);
		expect(check(communalBuildMachine, {})).toBe(true);
	});
});

describe("personal project box (private + project)", () => {
	test("both axes must pass", () => {
		expect(check(personalProjectBox, { userId: OWNER, projectId: PROJECT })).toBe(true);
		// Right user, wrong project.
		expect(check(personalProjectBox, { userId: OWNER, projectId: OTHER_PROJECT })).toBe(false);
		// Right project, wrong user.
		expect(check(personalProjectBox, { userId: OTHER, projectId: PROJECT })).toBe(false);
		expect(check(personalProjectBox, { userId: OTHER, projectId: OTHER_PROJECT })).toBe(false);
	});
});

describe("backward compatibility", () => {
	test("a row without the owner axis behaves as shared", () => {
		// Pre-migration rows read back with ownerScope undefined; the schema default
		// is "shared", so authorization must match the old project-only behaviour.
		const legacy: Device = { scope: "global", projectId: null };
		expect(check(legacy, {})).toBe(true);
		expect(check(legacy, { userId: OTHER })).toBe(true);

		const legacyProject: Device = { scope: "project", projectId: PROJECT };
		expect(check(legacyProject, { projectId: PROJECT })).toBe(true);
		expect(check(legacyProject, { projectId: OTHER_PROJECT })).toBe(false);
	});

	test("private without a recorded owner is refused rather than open", () => {
		const orphaned: Device = { ownerScope: "private", scope: "global", projectId: null };
		expect(check(orphaned, { userId: OWNER })).toBe(false);
		expect(check(orphaned, {})).toBe(false);
	});

	test("the project-only helper still matches the project axis exactly", () => {
		// Existing callers that legitimately have no user context keep the old
		// semantics, including for private devices.
		expect(isDeviceAuthorizedForProject(personalMachine, null)).toBe(true);
		expect(isDeviceAuthorizedForProject(projectDeployTarget, PROJECT)).toBe(true);
		expect(isDeviceAuthorizedForProject(projectDeployTarget, OTHER_PROJECT)).toBe(false);
	});
});

describe("axis independence", () => {
	test("the owner axis never widens the project axis", () => {
		// Being the owner does not grant access outside the device's project.
		expect(check(personalProjectBox, { userId: OWNER, projectId: OTHER_PROJECT })).toBe(false);
	});

	test("the project axis never widens the owner axis", () => {
		// A matching project does not make a private device communal.
		expect(check(personalProjectBox, { userId: OTHER, projectId: PROJECT })).toBe(false);
	});
});
