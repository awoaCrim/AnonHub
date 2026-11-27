import { randomUUID } from "node:crypto";

export interface WebChatMessage {
  readonly id: string;
  readonly role: "user" | "bot";
  readonly text: string;
  readonly status?: string;
  readonly choices?: readonly string[];
}

/** The owner in a browser: logs in to the console and uses its web chat over HTTP, same-origin like the page. */
export class WebChatClient {
  private constructor(
    private readonly url: string,
    private readonly cookie: string,
  ) {}

  static async login(url: string, username: string, password: string): Promise<WebChatClient> {
    const response = await fetch(`${url}/yesimbot/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) throw new Error(`login failed: ${response.status} ${await response.text()}`);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return new WebChatClient(url, cookie);
  }

  /** Sends a message as the page does; returns the client ID it was sent under. */
  async send(text: string): Promise<string> {
    const clientId = randomUUID();
    const response = await fetch(`${this.url}/yesimbot/api/v1/chat/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: this.url, cookie: this.cookie },
      body: JSON.stringify({ text, clientId }),
    });
    if (response.status !== 202) throw new Error(`send failed: ${response.status} ${await response.text()}`);
    return clientId;
  }

  async messages(): Promise<WebChatMessage[]> {
    const response = await fetch(`${this.url}/yesimbot/api/v1/chat`, { headers: { cookie: this.cookie } });
    if (!response.ok) throw new Error(`snapshot failed: ${response.status} ${await response.text()}`);
    return ((await response.json()) as { messages: WebChatMessage[] }).messages;
  }

  async botMessages(): Promise<WebChatMessage[]> {
    return (await this.messages()).filter((message) => message.role === "bot");
  }

  /** A request without the session cookie, as a stranger's browser would send it. */
  static async anonymousSend(url: string, text: string): Promise<number> {
    const response = await fetch(`${url}/yesimbot/api/v1/chat/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ text, clientId: randomUUID() }),
    });
    return response.status;
  }
}
