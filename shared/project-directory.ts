/**
 * `POST /api/projects/resolve-directory`: which project a local directory belongs to, asked
 * before any session exists (the new-session dialog's "start as a team" option).
 *
 * - `project`: the directory is in this project. `canWrite` says whether the caller may
 *   start a team there; an archived project cannot get one, and neither can one whose
 *   directory is not a local git work tree (`gitWorkTree: false`; a project may be associated
 *   with any existing folder).
 * - `repository`: a git repository no project covers yet. Only answered when `create` was
 *   false; with `create` the project is made (as a session started there would) and the
 *   answer is `project`.
 * - `not_git`: outside every project and every git repository; no project is made for it.
 *   A directory covered by a project the caller cannot read gets this same answer, byte for
 *   byte, so the lookup never tells anyone that a private project lives there.
 * - `not_directory`: the path does not name an existing directory on this server.
 */
export type ResolveProjectDirectoryResponse =
	| {
			status: "project";
			project: {
				id: string;
				name: string;
				gitPath: string | null;
				archived: boolean;
				canWrite: boolean;
				/** The project directory is a local git work tree, which a team needs. */
				gitWorkTree: boolean;
			};
	  }
	| { status: "repository"; root: string }
	| { status: "not_git" }
	| { status: "not_directory" };

export interface ResolveProjectDirectoryRequest {
	cwd: string;
	/** Create the project of a git repository that has none. Defaults to false. */
	create?: boolean;
}
