// Images from before leave-koishi 6.7 run this file straight from supervisord (`start-koishi.cjs start koishi.yml`). It
// starts the host, as start-host.sh does in later images; the name stays because those images' supervisord names it.
const state = process.env.KOISHI_STATE_DIR || "/var/lib/yesimbot";
const main = "/opt/yesimbot/apps/server/dist/main.js";
process.argv = [process.argv[0], main, "--state", state];
import(main).catch((error) => {
  console.error(error);
  process.exit(1);
});
