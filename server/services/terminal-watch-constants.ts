/**
 * `command` prefixes of watch background tasks. Lives in its own module so
 * background-task-service can recognise watch rows without importing the watch
 * service (which imports it back).
 */
export { TERMINAL_WATCH_COMMAND_PREFIX, WATCH_COMMAND_PREFIX } from "@shared/watch-command";
