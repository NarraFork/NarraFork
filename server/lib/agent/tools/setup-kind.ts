/**
 * Setup Assistant preload tool names + trait — pure string constants, no imports.
 *
 * Kept in a dedicated leaf module for the same reason as `knowledge-kind.ts`:
 * narrator-service.ts must be able to import these names without importing
 * tools/index.ts, which would re-form the circular-import chain that caused a
 * temporal-dead-zone crash.
 */

/** Permanent trait marking a Setup Assistant narrator. */
export const SETUP_KIND_TRAIT = "setup";

/**
 * Setup Assistant narrators preinstall these optional tools (written into
 * enabledTools at creation).
 *
 * Terminal is included because package managers and `sudo` frequently want a
 * PTY; the plain Bash tool has no tty and some installers behave differently or
 * refuse to run without one.
 */
export const SETUP_KIND_PRELOAD_TOOLS = ["Terminal"] as const;
