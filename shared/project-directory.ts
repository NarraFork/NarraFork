/**
 * `POST /api/projects/resolve-directory`: which project a local directory belongs to, asked
 * before any session exists (the new-session dialog's "start as a team" option).
 *
 * - `project`: the directory is in this project. `canWrite` says whether the caller may
 *   start a team there; an archived project cannot get one.
 * - `repository`: a git repository no project covers yet. Only answered when `create` was
 *   false; with `create` the project is made (as a session started there would) and the
 *   answer is `project`.
 * - `not_git`: outside every project and every git repository; no project is made for it.
 * - `not_directory`: the path does not name an existing directory on this server.
 * - `no_access`: a project covers the directory but the caller cannot read it. Its id and
 *   name are not disclosed.
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
			};
	  }
	| { status: "repository"; root: string }
	| { status: "not_git" }
	| { status: "not_directory" }
	| { status: "no_access" };

export interface ResolveProjectDirectoryRequest {
	cwd: string;
	/** Create the project of a git repository that has none. Defaults to false. */
	create?: boolean;
}
