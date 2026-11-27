import { api } from "./api";

/** The phone app as the site publishes it at `/downloads/android.json` (scripts/publish-android.mjs). */
export interface AndroidRelease {
  versionCode: number;
  versionName: string;
  /** A same-site `/downloads/*.apk`. */
  url: string;
  size: number;
  sha256: string;
}

/** Reads and checks the manifest; only a same-site APK with a version, size and SHA-256 is offered. */
export async function loadAndroidRelease(): Promise<AndroidRelease> {
  const result = await api<Partial<AndroidRelease> & { version?: number }>("/downloads/android.json", undefined, { fresh: true });
  const release = androidRelease(result);
  if (!release) throw new Error("invalid_release_manifest");
  return release;
}

export function androidRelease(value: Partial<AndroidRelease> & { version?: number }): AndroidRelease | undefined {
  const { version, versionCode, versionName, url, size, sha256 } = value;
  if (version !== 1 || !Number.isSafeInteger(versionCode) || (versionCode ?? 0) <= 0) return;
  if (typeof versionName !== "string" || !/^[0-9]+(\.[0-9]+){0,3}$/.test(versionName)) return;
  if (typeof url !== "string" || !/^\/downloads\/[a-zA-Z0-9._-]+\.apk$/.test(url)) return;
  if (!Number.isSafeInteger(size) || (size ?? 0) <= 0 || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) return;
  return { versionCode: versionCode!, versionName, url, size: size!, sha256 };
}

/**
 * Where 安装 App is offered: on a computer (a code to scan) and on an Android phone (the download itself); never
 * inside the app (its user agent says `YesImBotApp/`) and never on an iPhone or iPad, where it cannot run.
 */
export function installPlace(userAgent: string, touchPoints = 0, platform = ""): "computer" | "android" | undefined {
  if (userAgent.includes("YesImBotApp/")) return;
  if (/iPhone|iPad|iPod/.test(userAgent) || (platform === "MacIntel" && touchPoints > 1)) return;
  return /Android/i.test(userAgent) ? "android" : "computer";
}

/** The download as a QR code (an SVG); the encoder loads the first time a code is shown. */
export async function qrSvg(text: string): Promise<string> {
  const QRCode = await import("qrcode");
  return QRCode.toString(text, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#181818ff", light: "#ffffff00" } });
}
