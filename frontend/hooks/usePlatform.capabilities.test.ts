import { describe, expect, test } from "bun:test";
import {
	useNarratorPermissionsCapability,
	useNarratorSubagentsCapability,
	useSettingsValidationCapability,
	useVNetCapability,
} from "./usePlatform";

/**
 * The capability hooks that hold no live signal return frozen constants, so they can be
 * called outside React. These tests pin the values that gate visible UI — particularly the
 * ones the old getters got wrong because a missing `capabilities` payload made them read
 * `false`.
 */
describe("collapsed capability constants", () => {
	test("permission modes and reflections match the agent loop", () => {
		const permissions = useNarratorPermissionsCapability();
		expect(permissions.supported).toBe(true);
		expect(permissions.modes).toEqual([
			"default",
			"acceptEdits",
			"bypassPermissions",
			"readOnly",
			"dontAsk",
		]);
		expect(permissions.reflections).toEqual(["danger", "plan", "goal"]);
		expect(permissions.approveDeny).toBe(true);
		expect(permissions.updatedInput).toBe(true);
	});

	test("subagent reattach blocks the parent instead of falling back", () => {
		const subagents = useNarratorSubagentsCapability();
		expect(subagents.supported).toBe(true);
		expect(subagents.reattachBlocksParent).toBe(true);
		expect(subagents.reattachFallback).toBe(false);
	});

	test("vnet peer discovery runs over websocket, not udp rendezvous", () => {
		const vnet = useVNetCapability();
		expect(vnet.supported).toBe(true);
		expect(vnet.ws).toBe(true);
		expect(vnet.udpRendezvous).toBe(false);
	});

	test("settings validation reports zod parity rather than loose parsing", () => {
		const validation = useSettingsValidationCapability();
		expect(validation.tsZodParity).toBe(true);
		expect(validation.looseValidation).toBe(false);
	});
});
