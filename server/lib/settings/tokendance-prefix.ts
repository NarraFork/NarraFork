/** Preserve an existing manual provider; never reserve its prefix retroactively. */
export function isLegacyTokenDancePrefixAllowed(
	provider: { id: string; prefix: string },
	previous: readonly { id: string; prefix: string }[],
	platformConnected: boolean,
): boolean {
	return (
		!platformConnected &&
		provider.prefix === "tokendance" &&
		previous.some((item) => item.id === provider.id && item.prefix === "tokendance")
	);
}
