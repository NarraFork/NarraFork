/** Replaced at compile time; ordinary builds never import the RTC client. */
declare const __NF_REMOTE_BUILD__: boolean;
export const REMOTE_BUILD = typeof __NF_REMOTE_BUILD__ !== "undefined" && __NF_REMOTE_BUILD__;
