import { z } from "zod/v4";

export const address = z
  .string()
  .email()
  .max(320)
  .refine((value) => !/[\r\n\0]/.test(value));

export const header = z
  .string()
  .max(500)
  .refine((value) => !/[\r\n\0]/.test(value));

export const mailSchema = z
  .object({
    to: z.array(address).min(1).max(50),
    cc: z.array(address).max(50).optional(),
    bcc: z.array(address).max(50).optional(),
    subject: header,
    body: z.string().max(64_000),
    threadId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,200}$/)
      .optional(),
    inReplyTo: header.optional(),
  })
  .strict();

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
}

/** Plain-text UTF-8 MIME. Addresses and headers cannot inject additional message headers. */
export function rawMail(input: z.infer<typeof mailSchema>, messageId: string): string {
  const mail = mailSchema.parse(input);
  const words: string[] = [];
  let part = "";
  for (const char of mail.subject) {
    if (Buffer.byteLength(part + char) > 42) {
      words.push(part);
      part = "";
    }
    part += char;
  }
  words.push(part);
  const subject = words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`).join("\r\n ");
  const body =
    Buffer.from(mail.body.replace(/\r?\n/g, "\r\n"))
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? "";
  const headers = [
    `To: ${mail.to.join(", ")}`,
    ...(mail.cc?.length ? [`Cc: ${mail.cc.join(", ")}`] : []),
    ...(mail.bcc?.length ? [`Bcc: ${mail.bcc.join(", ")}`] : []),
    `Subject: ${subject}`,
    `Message-ID: <${messageId}@yesimbot.local>`,
    ...(mail.inReplyTo ? [`In-Reply-To: ${mail.inReplyTo}`, `References: ${mail.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`).toString("base64url");
}

export function mailView(message: GmailMessage, includeBody = false) {
  const headers = Array.isArray(message.payload?.headers) ? message.payload.headers : [];
  const get = (name: string) => headers.find((item) => typeof item.name === "string" && item.name.toLowerCase() === name)?.value?.slice(0, 1000);
  const view = {
    id: message.id,
    threadId: message.threadId,
    subject: get("subject"),
    from: get("from"),
    to: get("to"),
    cc: get("cc"),
    date: get("date"),
    messageId: get("message-id"),
    labels: message.labelIds,
    snippet: typeof message.snippet === "string" ? message.snippet.slice(0, 500) : undefined,
  };
  if (!includeBody) return view;
  const plain: string[] = [],
    html: string[] = [],
    attachments: Array<{ id?: string; name: string; mimeType?: string; size?: number }> = [];
  let budget = 64_000,
    visited = 0;
  const walk = (part: GmailPart | undefined, depth: number) => {
    if (!part || depth > 12 || ++visited > 100) return;
    if (part.filename)
      attachments.push({ id: part.body?.attachmentId, name: String(part.filename).slice(0, 200), mimeType: part.mimeType, size: part.body?.size });
    else if (budget && typeof part.body?.data === "string" && ["text/plain", "text/html"].includes(part.mimeType ?? "")) {
      const text = Buffer.from(part.body.data.slice(0, Math.ceil((budget * 4) / 3) + 4), "base64url")
        .toString("utf8")
        .slice(0, budget);
      (part.mimeType === "text/plain" ? plain : html).push(text);
      budget -= text.length;
    }
    if (Array.isArray(part.parts)) for (const child of part.parts) walk(child, depth + 1);
  };
  walk(message.payload, 0);
  const text = plain.length
    ? plain.join("\n")
    : html
        .join("\n")
        .replace(/<[^<>]*>/g, " ")
        .replace(/&(?:nbsp|amp|lt|gt|quot);/g, (entity) => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"' })[entity]!);
  return { ...view, body: text.slice(0, 48_000), truncated: budget === 0 || text.length > 48_000 || visited > 100, attachments };
}
