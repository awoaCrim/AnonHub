/** Instance-local owner management DTOs. Raw evidence, embeddings and storage paths never cross this boundary. */
export interface ManagedMemory {
  id: string;
  content: string;
  type: string;
  visibility: "owner" | "conversation" | "shared";
  revision: number;
  updatedAt: number;
  source: { platform?: string; channelId?: string };
  attachments?: { index: number; name?: string; mediaType: string; byteLength: number }[];
}

export interface MemoryService {
  list(input?: { limit?: number; cursor?: string }): Promise<{ memories: ManagedMemory[]; nextCursor?: string }>;
  read(id: string): Promise<ManagedMemory>;
  update(
    input: { id: string; revision: number; content: string; visibility?: "owner" | "conversation" | "shared" },
    authorize: () => void,
  ): Promise<ManagedMemory>;
  delete(input: { id: string; revision: number }, authorize: () => void): Promise<{ deleted: true }>;
  /** Absent on a memorizer older than attachments. */
  attachment?(id: string, index: number): Promise<{ bytes: Uint8Array; mediaType: string; filename?: string }>;
}
