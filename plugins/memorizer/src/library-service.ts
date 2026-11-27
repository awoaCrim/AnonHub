import type { MemoryLibrary } from "./library.js";

/** The `yesimbotMemory` service the console's memory pages read; it only forwards to the body's `MemoryLibrary`. */
export function memoryLibraryService(library: MemoryLibrary) {
  return {
    list: (...args: Parameters<MemoryLibrary["list"]>) => library.list(...args),
    read: (...args: Parameters<MemoryLibrary["read"]>) => library.read(...args),
    update: (...args: Parameters<MemoryLibrary["update"]>) => library.update(...args),
    attachment: (...args: Parameters<MemoryLibrary["attachment"]>) => library.attachment(...args),
    delete: (...args: Parameters<MemoryLibrary["delete"]>) => library.delete(...args),
  };
}
