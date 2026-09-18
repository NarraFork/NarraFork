/**
 * Kimi coding-plan quota exhaustion: the shared identity of the refusal payload.
 *
 * A quota wall is the one "hard limit" that is also *recoverable on a published
 * schedule*: `GET {origin}/coding/v1/usages` (see the usages cache) reports a reset
 * instant per window, so a refusal can be waited out instead of failing the turn.
 * When it is NOT waited out — the reset is beyond the wait budget, or this run has
 * already suspended on quota too often — the wall is reported instead, and this is
 * how both ends recognize that report.
 *
 * It travels in the narrator's `errorMessage` as a JSON payload, matching
 * `payment_required`: that column is the ONLY carrier of a failure that survives to
 * the next page load (`errorCode` and `diagnostics` are not persisted), so a value
 * the UI must read later has to live there.
 *
 * Shared rather than duplicated because a mismatch is silent: the server would
 * serialize a payload the UI never looks for, and the user would be shown the raw
 * upstream 403 again — the exact defect this exists to prevent.
 */

/**
 * Also used as the machine `errorCode` and the diagnostics reason for the same
 * refusal, so one string identifies it on every channel.
 */
export const KIMI_QUOTA_EXHAUSTED = "kimi_quota_exhausted";
