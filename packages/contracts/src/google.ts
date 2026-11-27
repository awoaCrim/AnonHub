/** Public Google connector boundary; credentials and provider responses never cross this interface. */
export type GoogleService = "gmail" | "calendar" | "drive";

export type GoogleAccess = "read" | "manage";

export type GoogleSelection = Partial<Record<GoogleService, GoogleAccess>>;

export interface GoogleAccountView {
  id: string;
  email: string;
  name?: string;
  permissions: GoogleSelection;
  connectedAt: number;
  needsReconnect: boolean;
}

export interface GoogleSnapshot {
  available: boolean;
  configured: boolean;
  /** This runtime uses the owner's shared Google app; only the owner sets it up. */
  shared?: boolean;
  /** The owner's own app (never on a friend's runtime). The client secret is never returned. */
  clientId?: string;
  redirectUri?: string;
  accounts: GoogleAccountView[];
}

/** The owner's Google app, published to every friend's runtime through the account manager. */
export interface GoogleSharedApp {
  version: 1;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

export interface GoogleConnector {
  snapshot(): Promise<GoogleSnapshot>;
  begin(binding: string, selection: GoogleSelection, accountId?: string): Promise<{ authorizationUrl: string }>;
  finish(binding: string, input: { state: string; code?: string; error?: string }, valid: () => boolean): Promise<void>;
  disconnect(id: string): Promise<{ revoked: boolean }>;
}
