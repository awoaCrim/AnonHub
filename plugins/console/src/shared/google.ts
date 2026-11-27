export const GOOGLE_PATH = "/yesimbot/api/v1/connectors/google";

export const GOOGLE_CALLBACK_PATH = `${GOOGLE_PATH}/callback`;

// Type-only boundary: the browser must not load the contracts barrel and its server-side schemas.
export type { GoogleAccess, GoogleAccountView, GoogleSelection, GoogleService, GoogleSnapshot } from "@yesimbot/contracts";
