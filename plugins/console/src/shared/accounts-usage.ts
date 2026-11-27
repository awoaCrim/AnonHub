import type { UsagePayload } from "@yesimbot/contracts";

export interface AccountsUsageResponse {
  accounts: Array<{ id: string; username: string; usage: UsagePayload | null }>;
}
