import { parse, resolve } from "node:path";

import { resolveInside } from "@yesimbot/foundation";

/** The real path of an existing file or directory with every link followed; a missing one is `path_missing`. */
export function realPath(path: string): Promise<string> {
  const absolute = resolve(path);
  return resolveInside(parse(absolute).root, absolute, { links: "within" });
}
