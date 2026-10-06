/**
 * Generate a URL/branch-safe slug from arbitrary text.
 *
 * Supports Unicode (CJK characters are preserved).
 * Git branch names handle UTF-8 fine.
 */
export function slugify(text: string): string {
	return (
		text
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
			.replace(/[^\p{L}\p{N}]+/gu, "-") // keep Unicode letters & digits, replace rest with -
			.replace(/(^-|-$)/g, "") // trim leading/trailing dashes
			.toLowerCase()
			.slice(0, 30) || "chapter" // fallback for empty result
	);
}
