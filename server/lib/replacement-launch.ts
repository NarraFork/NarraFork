/**
 * Arguments for the replacement process.
 *
 * A server supervised by the Windows manager is a `--serve` child of that manager. Relaunching
 * the new binary with `--serve` would update only the server and leave the old manager running
 * the old exe forever, keeping it locked. Start the new binary as a manager instead: it asks the
 * old manager to step aside and then starts and supervises the replacement server itself, passing
 * this handoff on to it.
 */
export function replacementLaunchArgs(
	args: readonly string[],
	options: { platform: string; managerManaged: boolean },
): string[] {
	if (options.platform !== "win32" || !options.managerManaged) return [...args];
	return [...args.filter((arg) => arg !== "--serve"), "--manager"];
}
