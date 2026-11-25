import * as auth from "./api/client";
import * as submission from "./narrator-submission";
import * as scopes from "./recent-tabs-owner";

(
	globalThis as typeof globalThis & {
		submissionFixture: { auth: typeof auth; submission: typeof submission; scopes: typeof scopes };
	}
).submissionFixture = { auth, submission, scopes };
