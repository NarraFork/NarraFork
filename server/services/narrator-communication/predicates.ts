import type { NarratorPrincipal } from "../narrator-acl";
import { narratorReadableText, narratorWritableText, projectReadableText } from "../read/acl-sql";

export function communicationProjectReadableText(alias: string): string {
	return projectReadableText(alias);
}
export function communicationReadableText(alias: string): string {
	return narratorReadableText(alias);
}
export function communicationWritableText(alias: string): string {
	return narratorWritableText(alias);
}
export function boundPrincipalPredicate(text: string, principal: NarratorPrincipal) {
	return {
		sql: text,
		params: Array.from({ length: (text.match(/\?/g) ?? []).length }, () => principal.userId),
	};
}
export function communicationReadPredicate(alias: string, principal: NarratorPrincipal) {
	return principal.isAdmin
		? { sql: "1 = 1", params: [] as string[] }
		: boundPrincipalPredicate(communicationReadableText(alias), principal);
}
export function communicationWritePredicate(alias: string, principal: NarratorPrincipal) {
	return principal.isAdmin
		? { sql: "1 = 1", params: [] as string[] }
		: boundPrincipalPredicate(communicationWritableText(alias), principal);
}
/** External authority does not grant entry to the ordinary first-party communication domain. */
export const communicationAuthorityText = (alias: string) =>
	`(${alias}.oauth_policy_snapshot_json IS NULL AND NOT EXISTS (SELECT 1 FROM integration_resource_bindings cb WHERE cb.resource_type = 'narrator' AND cb.resource_id = ${alias}.id AND cb.source_type <> 'first_party'))`;
