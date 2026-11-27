import { spawnSync } from "node:child_process";
try {
  const result = spawnSync("/usr/bin/supervisorctl", ["-c", "/opt/yesimbot/docker/supervisord.conf", "status"], { encoding: "utf8", timeout: 4000 });
  // supervisorctl returns 3 when optional NapCat is intentionally stopped.
  if (result.error || (result.status !== 0 && result.status !== 3)) throw new Error("Supervisor unavailable");
  const status = result.stdout;
  // The app image's NapCat runs in its own container; the account manager watches that one.
  const napcat = !!process.env.QQ_ACCOUNT && process.env.YESIMBOT_IMAGE !== "app";
  for (const service of ["koishi", ...(napcat ? ["napcat"] : [])]) {
    if (!new RegExp(`^${service}\\s+RUNNING\\b`, "m").test(status)) throw new Error("Service unavailable");
  }
  for (const url of ["http://127.0.0.1:5140/yesimbot/admin/session", ...(napcat ? ["http://127.0.0.1:6099/"] : [])]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error("HTTP unavailable");
    await response.body?.cancel();
  }
} catch {
  console.error("The host or NapCat is unavailable");
  process.exitCode = 1;
}
