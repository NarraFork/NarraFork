import { AsyncMutex } from "../async-mutex";

/** Shared by ordinary settings PATCH and TokenDance credential writes. */
export const settingsUpdateLock = new AsyncMutex();
