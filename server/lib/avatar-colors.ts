/**
 * Default avatar colours assigned at account creation.
 *
 * Shared by every account-provisioning path (self-registration, SSO, admin-created)
 * so a user's placeholder avatar looks the same however their account came to exist.
 */

/** Mantine-friendly palette. */
const AVATAR_COLORS = [
	"#4C6EF5", // indigo
	"#7950F2", // violet
	"#BE4BDB", // grape
	"#E64980", // pink
	"#FA5252", // red
	"#FD7E14", // orange
	"#FAB005", // yellow
	"#40C057", // green
	"#12B886", // teal
	"#15AABF", // cyan
	"#228BE6", // blue
	"#845EF7", // violet-light
];

export function randomAvatarColor(): string {
	return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}
