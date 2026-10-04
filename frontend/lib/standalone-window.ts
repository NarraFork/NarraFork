/** Router paths have already had the deployment basepath stripped. */
export function isStandaloneWindowPath(pathname: string): boolean {
	return pathname === "/windows" || pathname.startsWith("/windows/");
}
