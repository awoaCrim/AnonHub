import { createHash, createHmac } from "node:crypto";

import { newSecret } from "@yesimbot/foundation";

/**
 * Path signature of the public xiaoheihe web client (`hkey`), ported from xiaoheihe-cli
 * (MIT, xhh_operator/signing.py). It is a request checksum, not an account credential.
 */
const ALPHABET = "AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89";

export function sign(path: string, timestamp: number, nonce: string): string {
  const normalized = "/" + path.split("/").filter(Boolean).join("/") + "/";
  const parts = [mapChars(String(timestamp + 1), ALPHABET.slice(0, -2)), mapChars(normalized, ALPHABET), mapChars(nonce, ALPHABET)];
  let interleaved = "";
  const longest = Math.max(...parts.map((part) => part.length));
  for (let i = 0; i < longest; i++) for (const part of parts) interleaved += part[i] ?? "";
  const digest = md5(interleaved.slice(0, 20));
  const [a, b, c, d] = [...digest.slice(-6, -2)].map((char) => char.charCodeAt(0)) as [number, number, number, number];
  const mixed = [
    thirteen(a) ^ eleven(b) ^ nine(c) ^ three(d),
    three(a) ^ thirteen(b) ^ eleven(c) ^ nine(d),
    nine(a) ^ three(b) ^ thirteen(c) ^ eleven(d),
    eleven(a) ^ nine(b) ^ three(c) ^ thirteen(d),
  ];
  // The web implementation keeps the two untouched tail bytes in the checksum.
  const tail = [...digest.slice(-2)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const checksum = (mixed.reduce((sum, value) => sum + value, 0) + tail) % 100;
  return mapChars(digest.slice(0, 5), ALPHABET.slice(0, -4)) + String(checksum).padStart(2, "0");
}

export function signedParams(path: string, timestamp: number, nonce?: string): Record<string, string> {
  const value = nonce ?? md5(`${timestamp}${newSecret(16)}`).toUpperCase();
  return { hkey: sign(path, timestamp, value), _time: String(timestamp), nonce: value };
}

/** Extra signature the web client adds to write endpoints (public Workshop version 15). */
export function workshopParams(params: Readonly<Record<string, string>>): Record<string, string> {
  const salt = "Z7mFG4tQp9Ws2LxB8H";
  const message = `${salt}${params.nonce}${params._time}:${params.nonce}`;
  return { _rnd: "15:" + createHmac("sha256", salt).update(message).digest("hex") };
}

const md5 = (value: string) => createHash("md5").update(value).digest("hex");

const double = (value: number) => ((value << 1) ^ (value & 128 ? 27 : 0)) & 255;

const three = (value: number) => double(value) ^ value;

const nine = (value: number) => three(double(value));

const eleven = (value: number) => nine(three(double(value)));

const thirteen = (value: number) => eleven(value) ^ nine(value) ^ three(value);

function mapChars(value: string, alphabet: string): string {
  return [...value].map((char) => alphabet[char.charCodeAt(0) % alphabet.length]).join("");
}
