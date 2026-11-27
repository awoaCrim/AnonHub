import { api, ApiError } from "./api";
import { confirmDialog } from "./dialog";
import { toast } from "./toast";

/** Sessions being archived, so a second click while the first runs does nothing. */
const pending = new Set<string>();

export interface ArchiveTarget {
  channel: string;
  session: string;
  label: string;
}

/**
 * Archives a conversation's current session once the owner confirms. `current` reads what is open after the question:
 * if the conversation or its session changed meanwhile, nothing is archived. The action lives here, not in the menu item
 * that starts it: a menu closes (and unmounts its items) as soon as one is chosen, before the owner has answered.
 * Returns whether the server confirmed the archive.
 */
export async function archiveConversation(target: ArchiveTarget, current: () => Omit<ArchiveTarget, "label"> | undefined): Promise<boolean> {
  const key = JSON.stringify([target.channel, target.session]);
  if (pending.has(key)) return false;
  pending.add(key);
  try {
    const confirmed = await confirmDialog({
      title: `归档 ${target.label} 的当前会话？`,
      message: "旧记录会保留供查看，新会话不再带入旧聊天和摘要。角色卡与长期记忆保留，正在生成的回复会停止。",
      confirmLabel: "归档会话",
    });
    const now = current();
    if (!confirmed || now?.channel !== target.channel || now.session !== target.session) return false;
    const result = await api<{ archived: boolean }>("/yesimbot/api/v1/conversations/archive", { channel: target.channel, session: target.session });
    if (result?.archived !== true) throw new Error("archive_not_confirmed");
    toast("已开始新会话，旧记录已归档。");
    return true;
  } catch (cause) {
    const code = cause instanceof ApiError ? cause.code : "";
    toast(
      code === "conversation_changed"
        ? "当前会话已变化，请等待列表更新后重试。"
        : code === "conversation_empty"
          ? "当前会话还没有记录，无需归档。"
          : code === "conversation_not_found"
            ? "此会话已不存在，请重新打开会话列表。"
            : "归档未能确认，请检查会话列表后重试。",
      "danger",
    );
    return false;
  } finally {
    pending.delete(key);
  }
}
