import {
	type ExecutionTargetContext,
	OAUTH_RULE_TARGET_GROUPS,
	type OAuthRuleTargetGroup,
	type RuleTargetKind,
	type RuleTargetSelector,
} from "./types";

const oauthGroups = new Set<string>(OAUTH_RULE_TARGET_GROUPS);

function requireTargetValue(value: string | null | undefined, kind: RuleTargetKind): string {
	const normalized = value?.trim();
	if (!normalized) throw new Error(`${kind} target requires a targetValue`);
	return normalized;
}

export function isOAuthRuleTargetGroup(value: string): value is OAuthRuleTargetGroup {
	return oauthGroups.has(value);
}

/** Convert the legacy nullable deviceScope into the canonical discriminated selector. */
export function selectorFromLegacyDeviceScope(
	deviceScope: string | null | undefined,
): RuleTargetSelector {
	const scope = deviceScope?.trim();
	if (!scope) return { kind: "all" };
	if (scope === "local" || scope === "host") return { kind: "host" };
	if (isOAuthRuleTargetGroup(scope)) return { kind: "oauthGroup", group: scope };
	return { kind: "device", deviceId: scope };
}

/** Convert canonical selector fields stored in the DB into the domain selector. */
export function selectorFromStorage(
	targetKind: RuleTargetKind | null | undefined,
	targetValue: string | null | undefined,
	deviceScope?: string | null,
): RuleTargetSelector {
	if (!targetKind) return selectorFromLegacyDeviceScope(deviceScope);
	switch (targetKind) {
		case "all":
			return { kind: "all" };
		case "host":
			return { kind: "host" };
		case "device":
			return { kind: "device", deviceId: requireTargetValue(targetValue, targetKind) };
		case "oauthGroup": {
			const group = requireTargetValue(targetValue, targetKind);
			if (!isOAuthRuleTargetGroup(group)) throw new Error(`Invalid OAuth target group: ${group}`);
			return { kind: "oauthGroup", group };
		}
	}
}

export function normalizeRuleTargetSelector(input: {
	selector?: RuleTargetSelector;
	targetKind?: RuleTargetKind | null;
	targetValue?: string | null;
	deviceScope?: string | null;
}): RuleTargetSelector {
	if (input.selector) {
		const stored = selectorToStorage(input.selector);
		return selectorFromStorage(stored.targetKind, stored.targetValue);
	}
	return selectorFromStorage(input.targetKind, input.targetValue, input.deviceScope);
}

export function selectorToStorage(selector: RuleTargetSelector): {
	targetKind: RuleTargetKind;
	targetValue: string | null;
	deviceScope: string | null;
} {
	switch (selector.kind) {
		case "all":
			return { targetKind: "all", targetValue: null, deviceScope: null };
		case "host":
			return { targetKind: "host", targetValue: null, deviceScope: "local" };
		case "device":
			return {
				targetKind: "device",
				targetValue: selector.deviceId,
				deviceScope: selector.deviceId,
			};
		case "oauthGroup":
			return { targetKind: "oauthGroup", targetValue: selector.group, deviceScope: selector.group };
	}
}

/**
 * Scoped rules require the complete frozen execution context. Missing context deliberately
 * fails closed: only an unscoped `all` selector can match.
 */
export function ruleTargetMatches(
	selector: RuleTargetSelector,
	context: ExecutionTargetContext | null | undefined,
): boolean {
	if (selector.kind === "all") return true;
	if (!context) return false;
	switch (selector.kind) {
		case "host":
			return context.backend.kind === "local" && context.target.deviceId === "local";
		case "device":
			return context.target.deviceId === selector.deviceId;
		case "oauthGroup":
			return context.deviceClass === selector.group;
	}
}

export function selectorConflictKey(selector: RuleTargetSelector): string {
	switch (selector.kind) {
		case "all":
		case "host":
			return selector.kind;
		case "device":
			return `device:${selector.deviceId}`;
		case "oauthGroup":
			return `oauthGroup:${selector.group}`;
	}
}
