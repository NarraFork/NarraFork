/**
 * Ordered path guard rules for the remote executor.
 *
 * The model is deliberately small: an ordered list of allow/deny directory
 * prefixes where **the last matching rule wins**. That ordering is the priority
 * mechanism, so a deny can carve a hole out of an allow and a later allow can
 * re-open an exception inside that hole, to any depth. A path matching no rule is
 * refused; an empty list means unrestricted.
 *
 * The authority for these rules is the executor's own config file on the target
 * machine. NarraFork only records the operator's intent so the UI can show it,
 * diff it against what the device reports, and regenerate the config snippet — a
 * server-enforced version would defeat the point of a guard that is supposed to
 * survive a compromised server.
 *
 * Kept platform-agnostic: a rule authored for Windows must round-trip unchanged
 * through a Linux server, so nothing here uses Node's path module.
 */

export type ExecutorPathRuleAction = "allow" | "deny";

export interface ExecutorPathRule {
	action: ExecutorPathRuleAction;
	path: string;
}

/** Mirrors the executor's own cap so the UI cannot save a config it would reject. */
export const MAX_EXECUTOR_PATH_RULES = 256;

/** Mirrors the per-path cap applied to other operator-supplied paths. */
export const MAX_EXECUTOR_PATH_LENGTH = 4096;

/**
 * True when a path is absolute in either POSIX or Windows shape.
 *
 * Both shapes are accepted regardless of which OS this runs on: the server may be
 * Linux while the device is Windows, and reinterpreting the path by the server's
 * own rules would silently change what the operator wrote.
 */
export function isAbsoluteExecutorPath(path: string): boolean {
	if (path.startsWith("/")) return true;
	// UNC share, e.g. \\fileserver\share
	if (path.startsWith("\\\\")) return true;
	// Drive-qualified, e.g. C:\dir or C:/dir. A bare "C:rel" is drive-relative and
	// deliberately rejected.
	return /^[A-Za-z]:[\\/]/.test(path);
}

export interface ExecutorPathRuleProblem {
	index: number;
	message: string;
}

/**
 * Validates a rule list without reordering it. Order carries meaning here, so
 * this never sorts or dedupes: duplicates are legal (the later one wins) and
 * reordering would change the policy.
 */
export function validateExecutorPathRules(rules: readonly ExecutorPathRule[]): {
	ok: boolean;
	problems: ExecutorPathRuleProblem[];
} {
	const problems: ExecutorPathRuleProblem[] = [];
	if (rules.length > MAX_EXECUTOR_PATH_RULES) {
		problems.push({
			index: MAX_EXECUTOR_PATH_RULES,
			message: `At most ${MAX_EXECUTOR_PATH_RULES} rules are allowed`,
		});
	}
	rules.forEach((rule, index) => {
		if (rule.action !== "allow" && rule.action !== "deny") {
			problems.push({ index, message: "Action must be allow or deny" });
		}
		const path = rule.path.trim();
		if (!path) {
			problems.push({ index, message: "Path is required" });
			return;
		}
		if (path.length > MAX_EXECUTOR_PATH_LENGTH) {
			problems.push({ index, message: "Path is too long" });
		}
		// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the intent
		if (/[\u0000-\u001f\u007f]/.test(path)) {
			problems.push({ index, message: "Path may not contain control characters" });
		}
		if (!isAbsoluteExecutorPath(path)) {
			problems.push({ index, message: "Path must be absolute" });
		}
	});
	return { ok: problems.length === 0, problems };
}

/** Trims paths without reordering or deduping. */
export function normalizeExecutorPathRules(rules: readonly ExecutorPathRule[]): ExecutorPathRule[] {
	return rules.map((rule) => ({ action: rule.action, path: rule.path.trim() }));
}

/**
 * Decides a path against an ordered rule list, mirroring the executor's Go
 * implementation (last match wins; unmatched is refused; empty list is
 * unrestricted).
 *
 * This is for UI preview only. It intentionally does NOT resolve symlinks, so it
 * can disagree with the executor on a symlinked path — the executor canonicalizes
 * first and is always the authority.
 */
export function previewExecutorPathDecision(
	rules: readonly ExecutorPathRule[],
	path: string,
	options: { windows?: boolean } = {},
): { decision: "allow" | "deny" | "unmatched"; ruleIndex: number | null } {
	if (rules.length === 0) return { decision: "allow", ruleIndex: null };
	for (let i = rules.length - 1; i >= 0; i--) {
		if (pathWithinRule(rules[i].path, path, options.windows === true)) {
			return { decision: rules[i].action, ruleIndex: i };
		}
	}
	return { decision: "unmatched", ruleIndex: null };
}

/**
 * Prefix containment on path segments. Segment-aware so `/srv/workshop` is not
 * treated as living inside `/srv/work`.
 */
function pathWithinRule(root: string, path: string, windows: boolean): boolean {
	const normalize = (value: string) => {
		let out = windows ? value.replace(/\//g, "\\") : value;
		if (windows) out = out.toLowerCase();
		const sep = windows ? "\\" : "/";
		// Collapse repeated separators and drop a trailing one so "/a/b/" == "/a/b".
		const raw = out.split(sep).filter((part) => part.length > 0);
		// Resolve "." and ".." lexically, matching the executor's filepath.Clean.
		// Without this the preview would walk INTO a rule and then back out of it
		// unnoticed: "/srv/work/../etc" keeps "srv"+"work" as a prefix here while the
		// executor cleans it to "/srv/etc" and refuses. The preview would show allow
		// for a path the device denies — a lie the operator has no way to spot.
		const parts: string[] = [];
		for (const part of raw) {
			if (part === ".") continue;
			if (part === "..") {
				// At the root, ".." has nowhere to go and is dropped, as Clean does.
				parts.pop();
				continue;
			}
			parts.push(part);
		}
		return { prefix: out.startsWith(sep) ? sep : "", parts };
	};
	const left = normalize(root);
	const right = normalize(path);
	if (left.parts.length > right.parts.length) return false;
	return left.parts.every((part, index) => part === right.parts[index]);
}
