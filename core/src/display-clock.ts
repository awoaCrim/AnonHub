import { systemClock } from "@yesimbot/foundation";

/**
 * The clock whose time zone every time a model or a person reads is written in (convention 06): pass it to
 * `formatForModel`. Its zone is the default `Asia/Shanghai`; no setting changes it.
 */
export const DISPLAY_CLOCK = systemClock();
