/**
 * Safety predicates for tutorial script tool inputs.
 *
 * The tutorial executes its scripted tool calls for REAL. Tool paths resolve
 * against the narrator's cwd, so a relative path lands in the sandbox worktree
 * while an absolute one escapes it — an absolute path in a scripted `Write` would
 * modify the user's actual files and nothing in the product would object.
 *
 * These predicates live in their own module, separate from both the lesson data
 * and its guard test, for one reason: a guard that only walks the current lesson
 * set passes vacuously while no lesson happens to call a tool. Exporting the
 * predicate lets the test assert it REJECTS known-bad input, so the guard is
 * proven able to fail before it is trusted to pass.
 */

import type { TutorialScriptToolUse } from "./lessons";

/**
 * Anchored absolute-path forms.
 *
 * Windows drive letters and `~` are included because a script is authored once
 * and runs on every host: a path that is relative on Linux but absolute on
 * Windows would escape the sandbox only for some users, which is worse than
 * escaping for everyone.
 */
const ABSOLUTE_PATH = /^(?:[/\\]|[A-Za-z]:[/\\]|~)/;

/**
 * Shell forms that must never appear in a scripted command.
 *
 * This is not defence against an attacker — scripts are authored content in this
 * repository. It is defence against an authoring mistake having irreversible
 * consequences on a real user's machine, since the tutorial's shell runs with the
 * user's own privileges.
 */
const FORBIDDEN_SHELL_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\bsudo\b/, reason: "privilege escalation" },
	{ pattern: /\bdoas\b/, reason: "privilege escalation" },
	{ pattern: /\bsu\s+-/, reason: "privilege escalation" },
	{ pattern: /\brm\s+-\w*[rf]/, reason: "recursive/forced delete" },
	{ pattern: /\bmkfs(\.\w+)?\b/, reason: "filesystem format" },
	{ pattern: /\bdd\s+.*\bof=/, reason: "raw device write" },
	{ pattern: />\s*\/dev\//, reason: "device write" },
	{ pattern: /\bshutdown\b|\breboot\b/, reason: "host power control" },
	{ pattern: /\bchmod\s+-R\b|\bchown\s+-R\b/, reason: "recursive permission change" },
	{ pattern: /\bgit\s+push\b/, reason: "network mutation of a real remote" },
	{ pattern: /\bcurl\b|\bwget\b/, reason: "outbound network request" },
];

export interface ScriptSafetyViolation {
	kind: "absolutePath" | "parentTraversal" | "forbiddenCommand" | "unserialisableInput";
	/** The offending value, truncated for message readability. */
	value: string;
	reason?: string;
}

/** Every string value inside a tool input, at any depth. */
export function collectInputStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) collectInputStrings(item, out);
	else if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectInputStrings(item, out);
	}
	return out;
}

function truncate(value: string): string {
	return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}

/**
 * Whether a string value inside a tool input is a filesystem path that could
 * escape the sandbox.
 *
 * `spec://` is exempt: it is a virtual Dynamic Spec URI scoped to the narrator,
 * not a filesystem path, so it cannot reach outside the sandbox regardless of
 * what follows the scheme.
 */
export function isSandboxEscapingPath(value: string): boolean {
	if (value.startsWith("spec://")) return false;
	if (ABSOLUTE_PATH.test(value)) return true;
	return value.split(/[/\\]/).includes("..");
}

/** Find every safety violation in one scripted tool call. Empty means safe. */
export function findToolUseViolations(toolUse: TutorialScriptToolUse): ScriptSafetyViolation[] {
	const violations: ScriptSafetyViolation[] = [];

	for (const value of collectInputStrings(toolUse.input)) {
		if (value.startsWith("spec://")) continue;
		if (ABSOLUTE_PATH.test(value)) {
			violations.push({ kind: "absolutePath", value: truncate(value) });
		} else if (value.split(/[/\\]/).includes("..")) {
			violations.push({ kind: "parentTraversal", value: truncate(value) });
		}
	}

	if (toolUse.name === "Bash") {
		const command = typeof toolUse.input.command === "string" ? toolUse.input.command : "";
		for (const { pattern, reason } of FORBIDDEN_SHELL_PATTERNS) {
			if (pattern.test(command)) {
				violations.push({ kind: "forbiddenCommand", value: truncate(command), reason });
			}
		}
	}

	// The provider streams `JSON.stringify(input)` and the loop parses it back. A
	// value that does not survive that round trip (undefined, a function, a cycle)
	// silently disappears from the parsed input, so the tool runs with different
	// arguments than the script declares.
	try {
		const raw = JSON.stringify(toolUse.input);
		if (JSON.stringify(JSON.parse(raw)) !== raw) {
			violations.push({ kind: "unserialisableInput", value: truncate(raw) });
		}
	} catch {
		violations.push({ kind: "unserialisableInput", value: "<not serialisable>" });
	}

	return violations;
}

/** Human-readable one-liner for a violation, used in test failure messages. */
export function describeViolation(violation: ScriptSafetyViolation): string {
	const suffix = violation.reason ? ` (${violation.reason})` : "";
	return `${violation.kind}: ${violation.value}${suffix}`;
}
