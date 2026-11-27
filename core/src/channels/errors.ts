import { defineErrors } from "@yesimbot/foundation";

/** A conversation that cannot be located, or whose storage on disk is not what Core wrote. */
export const CHANNEL_ERRORS = defineErrors({
  channel_context_invalid: { model: "会话信息不完整，无法定位这个会话。", user: "会话信息不完整，无法定位这个会话。", status: 400 },
  channel_storage_invalid: { model: "这个会话的存储目录已损坏，没有读取。", user: "这个会话的存储目录已损坏，没有读取。", status: 500 },
  channel_reader_duplicate: { model: "资源读取器重复登记。", user: "资源读取器重复登记。", status: 500 },
});
