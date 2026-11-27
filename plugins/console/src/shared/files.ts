/** Paths are relative to the Koishi base directory and `/`-separated, as plugin configs store them. */
export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  mtime: number;
}

export interface FileListing {
  dir: string;
  parent: string | null;
  entries: FileEntry[];
  truncated: boolean;
}

export interface FileStat {
  path: string;
  exists: boolean;
  /** Set when the path points outside the base directory; such files are never read. */
  outside?: boolean;
  type?: "file" | "directory";
  size?: number;
  mtime?: number;
}

export interface UploadResult {
  path: string;
  name: string;
  size: number;
}
