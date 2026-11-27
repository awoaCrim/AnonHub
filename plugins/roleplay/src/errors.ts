import { defineErrors } from "@yesimbot/foundation";

/** Refusals of `update_role_card`; the model reads the sentence, the result carries the code. */
export const ROLE_CARD_ERRORS = defineErrors({
  role_card_changed: { model: "角色卡刚被别处改过，重新看一下现在的设定再改。", user: "角色卡刚被别处改过，刷新后再改。", status: 409 },
  role_card_unavailable: { model: "角色卡文件读不了，没有改动。", user: "角色卡文件读不了，没有改动。", status: 500 },
  role_card_unchanged: { model: "没有要改的内容。", user: "没有要改的内容。", status: 400 },
  role_card_picture_unavailable: { model: "读不到这张图片，没有改动。", user: "读不到这张图片，没有改动。", status: 400 },
  role_card_picture_unsupported: { model: "图片要 PNG、JPEG 或 WebP，5 MB 以内；没有改动。", user: "图片要 PNG、JPEG 或 WebP，5 MB 以内。", status: 400 },
});
