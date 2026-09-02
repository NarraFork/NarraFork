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

/**
 * Every string value inside a tool input, at any depth.
 *
 * `seen` guards against a cyclic object. Without it this recurses until the stack
 * overflows, and it does so BEFORE the serialisability check below can report the
 * cycle — so the one input shape that is guaranteed to break execution crashes the
 * checker instead of being named by it. A safety predicate that throws on bad input
 * cannot be used to reject bad input.
 *
 * A visited node is skipped rather than treated as a violation: this function only
 * collects strings, and the cycle is diagnosed by
 * {@link findToolUseViolations}'s round-trip check, which is where that verdict
 * belongs.
 */
export function collectInputStrings(
	value: unknown,
	out: string[] = [],
	seen: Set<object> = new Set(),
): string[] {
	if (typeof value === "string") {
		out.push(value);
		return out;
	}
	if (!value || typeof value !== "object") return out;
	if (seen.has(value)) return out;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) collectInputStrings(item, out, seen);
	} else {
		for (const item of Object.values(value)) collectInputStrings(item, out, seen);
	}
	return out;
}

/**
 * Every scripted value that can end up in an executed tool input.
 *
 * `localizedInput` is merged into `input` at resolution time, so scanning only
 * `input` would leave a per-locale field completely unchecked — and a dangerous
 * path in a zh-CN branch alone is exactly the kind of thing review misses.
 */
function scannableInputStrings(toolUse: TutorialScriptToolUse): string[] {
	const out = collectInputStrings(toolUse.input);
	return collectInputStrings(toolUse.localizedInput ?? {}, out);
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

	const scannable = scannableInputStrings(toolUse);

	for (const value of scannable) {
		if (value.startsWith("spec://")) continue;
		if (ABSOLUTE_PATH.test(value)) {
			violations.push({ kind: "absolutePath", value: truncate(value) });
		} else if (value.split(/[/\\]/).includes("..")) {
			violations.push({ kind: "parentTraversal", value: truncate(value) });
		}
	}

	if (toolUse.name === "Bash") {
		// Every scannable string, not `input.command` alone.
		//
		// `localizedInput` is merged into `input` before execution, so a per-locale
		// `command` reaches the real shell while a check that reads only `input.command`
		// never sees it — the same gap the path scan above already closes by scanning
		// both. Over-scanning is the safe direction here: a forbidden pattern in any
		// string of a Bash input is worth a review failure regardless of which field
		// carried it, and these are authored scripts where a false positive costs a
		// rewording.
		for (const value of scannable) {
			for (const { pattern, reason } of FORBIDDEN_SHELL_PATTERNS) {
				if (pattern.test(value)) {
					violations.push({ kind: "forbiddenCommand", value: truncate(value), reason });
				}
			}
		}
	}

	// The provider streams `JSON.stringify(input)` and the loop parses it back. A
	// value that does not survive that round trip (undefined, a function, a cycle)
	// silently disappears from the parsed input, so the tool runs with different
	// arguments than the script declares.
	//
	// `localizedInput` is checked too: it is merged into the input that gets streamed,
	// so an unserialisable value there fails in exactly the same way.
	for (const candidate of [toolUse.input, toolUse.localizedInput]) {
		if (candidate === undefined) continue;
		try {
			const raw = JSON.stringify(candidate);
			if (JSON.stringify(JSON.parse(raw)) !== raw) {
				violations.push({ kind: "unserialisableInput", value: truncate(raw) });
			}
		} catch {
			violations.push({ kind: "unserialisableInput", value: "<not serialisable>" });
		}
	}

	return violations;
}

/** Human-readable one-liner for a violation, used in test failure messages. */
export function describeViolation(violation: ScriptSafetyViolation): string {
	const suffix = violation.reason ? ` (${violation.reason})` : "";
	return `${violation.kind}: ${violation.value}${suffix}`;
}
