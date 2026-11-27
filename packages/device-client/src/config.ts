import { lstat, readFile, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  capabilitiesSchema,
  deviceCredentialSchema,
  deviceRecordSchema,
  deviceUrl,
  localGatewayUrl,
  MAX_PROJECT_ROOTS,
  toolPolicySchema,
  type DeviceCredential,
} from "@yesimbot/contracts";
import { writeJsonAtomic } from "@yesimbot/foundation";
import { z } from "zod/v4";

export const clientConfigSchema = z
  .object({
    version: z.literal(1),
    gateway: z.string().url(),
    /** Shared web app; this client adds local device control, not a second bot instance. */
    consoleUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
        );
      }, "invalid_console_url")
      .optional(),
    /** The same gateway on this machine's host bridge (a VM beside it); the public `gateway` stays the fallback and the update site. */
    localGateway: z.string().url().optional(),
    allowLoopback: z.boolean().default(false),
    workspaceRoot: z.string().min(1),
    policy: toolPolicySchema,
    capabilities: z
      .object({
        files: z.boolean().default(false),
        /**
         * Directories the file tools may also read and write by absolute path (with read-before-edit and content
         * checks). Set only here, by the computer's owner; the bot cannot add one (user, 2026-11-19).
         */
        projectRoots: z
          .array(
            z
              .string()
              .min(1)
              .max(1024)
              .refine((value) => isAbsolute(value) && !value.includes("\0"), "absolute_path_required"),
          )
          .max(MAX_PROJECT_ROOTS)
          .optional(),
        shell: z.boolean().default(false),
        shellConversationDirectory: z.boolean().default(false),
        /** Explicit opt-in to a loopback RFB server; no arbitrary host/URL can be supplied remotely. */
        remoteDesktop: z
          .object({ port: z.number().int().min(1024).max(65535) })
          .strict()
          .optional(),
        desktop: z.object({ endpoint: z.string().url() }).strict().optional(),
        /**
         * agent-desktop; the copy shipped beside the client unless `command` names another. `physicalInput`: an
         * action the desktop refuses without real input is repeated once with the real pointer and keyboard.
         * Unset, only Linux does that (the bots' own virtual screens); a person's Mac or PC keeps its mouse.
         */
        agentDesktop: z
          .object({
            command: z
              .string()
              .refine((value) => isAbsolute(value), "absolute_path_required")
              .optional(),
            physicalInput: z.boolean().optional(),
          })
          .strict()
          .optional(),
        browser: z.object({ endpoint: z.string().url() }).strict().optional(),
      })
      .strict(),
  })
  .strict();

export type ClientConfig = z.infer<typeof clientConfigSchema>;

export async function loadClientConfig(path: string): Promise<ClientConfig> {
  const config = validateClientConfig(await readPrivateJson(path, 256 * 1024));
  config.workspaceRoot = resolve(dirname(path), config.workspaceRoot);
  return config;
}

export function configuredCapabilities(config: ClientConfig) {
  return capabilitiesSchema.parse([
    ...(config.capabilities.files ? ["workspace.files"] : []),
    ...(config.capabilities.shell ? ["computer.shell"] : []),
    ...(config.capabilities.desktop || config.capabilities.agentDesktop ? ["computer.desktop"] : []),
    ...(config.capabilities.browser ? ["computer.browser"] : []),
  ]);
}

/** The credential file is created exclusively. Pairing never replaces an existing device identity. */
export async function pairDevice(config: ClientConfig, code: string, name: string, credentialPath: string): Promise<DeviceCredential> {
  const platform = deviceRecordSchema.shape.platform.parse(process.platform);
  await mkdir(dirname(credentialPath), { recursive: true, mode: 0o700 });
  const file = await open(credentialPath, "wx", 0o600);
  let paired = false;
  try {
    const response = await fetch(deviceUrl(config.gateway, "/v1/enroll", config.allowLoopback), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name, platform, capabilities: configuredCapabilities(config) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("pairing_failed");
    if (!response.body) throw new Error("pairing_failed");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 16384) throw new Error("invalid_pairing_response");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { credential?: unknown };
    const credential = deviceCredentialSchema.parse(result.credential);
    await file.writeFile(JSON.stringify(credential) + "\n");
    await file.sync();
    paired = true;
    return credential;
  } finally {
    await file.close();
    if (!paired) await unlink(credentialPath);
  }
}

export async function readPrivateJson(path: string, limit = 64 * 1024): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new Error("unsafe_config_file");
  if (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) throw new Error("private_config_permissions_required");
  const contents = await readFile(path, "utf8");
  if (Buffer.byteLength(contents) > limit) throw new Error("config_too_large");
  return JSON.parse(contents);
}

export function validateClientConfig(value: unknown): ClientConfig {
  const config = clientConfigSchema.parse(value);
  deviceUrl(config.gateway, "/v1/enroll", config.allowLoopback);
  if (config.localGateway !== undefined) localGatewayUrl(config.localGateway, "/v1/connect");
  if (config.capabilities.desktop) localDesktopEndpoint(config.capabilities.desktop.endpoint);
  if (config.capabilities.desktop && config.capabilities.agentDesktop) throw new Error("duplicate_local_desktop_driver");
  if (config.capabilities.browser) {
    if (localDesktopEndpoint(config.capabilities.browser.endpoint).pathname !== "/") throw new Error("browser_endpoint_root_required");
  }
  return config;
}

export function localDesktopEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash)
    throw new Error("local_desktop_endpoint_required");
  return url;
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Only ever replaces a private regular file of this user.
  try {
    await readPrivateJson(path, 256 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeJsonAtomic(path, value);
}
