import type { GoogleSelection } from "@yesimbot/contracts";
import { z } from "zod/v4";

export const GOOGLE_AUTH_ROOT = "https://www.googleapis.com/auth/";

export const SCOPES = {
  gmail: { read: [`${GOOGLE_AUTH_ROOT}gmail.readonly`], manage: [`${GOOGLE_AUTH_ROOT}gmail.modify`] },
  calendar: {
    read: [`${GOOGLE_AUTH_ROOT}calendar.calendarlist.readonly`, `${GOOGLE_AUTH_ROOT}calendar.events.readonly`],
    manage: [`${GOOGLE_AUTH_ROOT}calendar.calendarlist.readonly`, `${GOOGLE_AUTH_ROOT}calendar.events`],
  },
  drive: { read: [`${GOOGLE_AUTH_ROOT}drive.readonly`], manage: [`${GOOGLE_AUTH_ROOT}drive`] },
} as const;

export const selectionSchema = z
  .object({
    gmail: z.enum(["read", "manage"]).optional(),
    calendar: z.enum(["read", "manage"]).optional(),
    drive: z.enum(["read", "manage"]).optional(),
  })
  .strict()
  .refine((selection) => Object.keys(selection).length > 0);

export function requestedScopes(input: GoogleSelection): string[] {
  const selection = selectionSchema.parse(input);
  return ["openid", "email", "profile", ...Object.entries(selection).flatMap(([service, mode]) => SCOPES[service as keyof typeof SCOPES][mode!])];
}

export function permissions(scopes: readonly string[]): GoogleSelection {
  const granted = new Set(scopes);
  const result: GoogleSelection = {};
  for (const service of ["gmail", "calendar", "drive"] as const) {
    if (SCOPES[service].manage.every((scope) => granted.has(scope))) result[service] = "manage";
    else if (SCOPES[service].read.every((scope) => granted.has(scope))) result[service] = "read";
  }
  return result;
}
