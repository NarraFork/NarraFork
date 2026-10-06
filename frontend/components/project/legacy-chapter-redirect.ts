export function resolveLegacyChapterTarget(
	narrators: readonly { id: string; variant?: string }[],
	from?: string,
	hash?: string,
) {
	const primary = narrators.find((narrator) => narrator.variant === "primary");
	if (!primary) return null;
	return {
		to: "/narrators/$narratorId" as const,
		params: { narratorId: primary.id },
		search: from ? { from } : {},
		hash: hash || undefined,
		replace: true,
	};
}

export function canOperateLegacyResources(
	access: { canManage: boolean; members: readonly { userId: string; role: string }[] } | undefined,
	userId: string | undefined,
): boolean {
	return (
		!!access &&
		(access.canManage ||
			(!!userId &&
				access.members.some(
					(member) =>
						member.userId === userId && (member.role === "write" || member.role === "manage"),
				)))
	);
}

export function legacyRouteErrorKey(error: unknown): "denied" | "missing" | "error" {
	const status = error && typeof error === "object" && "status" in error ? error.status : null;
	return status === 401 || status === 403 ? "denied" : status === 404 ? "missing" : "error";
}
