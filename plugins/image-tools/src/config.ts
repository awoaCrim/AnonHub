import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

// The Images models come from YesImBot's model purposes; which chats get generate_image / edit_image is the tool policy's job.
export const moduleConfig = defineModuleConfig("yesimbot-image-tools", z.looseObject({}));

export type Config = z.output<typeof moduleConfig.schema>;
