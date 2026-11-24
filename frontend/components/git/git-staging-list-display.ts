import {
	GIT_STAGING_UNASSIGNED_LIST_ID,
	GIT_STAGING_UNASSIGNED_LIST_NAME,
	type GitStagingList,
} from "@shared/git-staging-lists";
import type { TFunction } from "i18next";

/** Localize only the reserved list's default name; stored names remain action inputs. */
export function gitStagingListDisplayName(
	list: Pick<GitStagingList, "id" | "name"> | undefined,
	t: TFunction<"git">,
): string | undefined {
	if (!list) return undefined;
	return list.id === GIT_STAGING_UNASSIGNED_LIST_ID &&
		list.name === GIT_STAGING_UNASSIGNED_LIST_NAME
		? t("staging.unassigned")
		: list.name;
}
