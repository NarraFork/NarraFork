import type { UsageBreakdownDimension } from "@frontend/types/usage-history";

export const UNATTRIBUTED_USAGE_USER = "__unattributed__";

export function usageUserOptions(
	users: readonly { id: string; username?: string | null }[],
	selectedUserId: string | undefined,
	unattributedLabel: string,
): { value: string; label: string }[] {
	const options = [
		{ value: UNATTRIBUTED_USAGE_USER, label: unattributedLabel },
		...users.map((user) => ({ value: user.id, label: user.username || user.id })),
	];
	// The admin list excludes deleted users; retain an explicitly entered historical ID.
	if (selectedUserId && !options.some((option) => option.value === selectedUserId)) {
		options.push({ value: selectedUserId, label: selectedUserId });
	}
	return options;
}

export function usageUserLabel(
	user: { userId?: string | null; username?: string | null },
	unattributedLabel: string,
): string {
	return user.username || user.userId || unattributedLabel;
}

export function usageDimensionLabel(
	label: string,
	dimension: UsageBreakdownDimension,
	unattributedLabel: string,
): string {
	return dimension === "user" && label === UNATTRIBUTED_USAGE_USER ? unattributedLabel : label;
}
