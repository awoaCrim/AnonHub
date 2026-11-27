// A one-time script in miniature (scripts/tests/test_deploy_preview.py): it configures the foundation's storage itself
// and reads through a plugin table that imports the foundation from the plugin's side. Bundled for a deploy, both must
// share one storage module, or the table reports "storage not configured".
import { configureStorage } from "@yesimbot/foundation";

import { sqliteUsageTable } from "../../../plugins/usage/src/table.js";

configureStorage({ dataRoot: process.argv[2] ?? "." });
process.stdout.write(`${(await sqliteUsageTable().rowsSince(0)).length}\n`);
