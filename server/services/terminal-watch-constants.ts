/**
 * `command` prefix of a terminal-watch background task. Lives in its own module
 * so background-task-service can recognise watch rows without importing the
 * watch service (which imports it back).
 */
export const TERMINAL_WATCH_COMMAND_PREFIX = "[terminal watch]";
