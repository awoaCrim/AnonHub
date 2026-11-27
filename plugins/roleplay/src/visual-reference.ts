import type { RoleCardPictureKey, RoleCardPictures } from "@yesimbot/contracts/role-cards";

/** What the role prompt and `read` call the character's own pictures. */
export const ROLE_PICTURE_URIS: Readonly<Record<RoleCardPictureKey, string>> = {
  reference: "role://self/appearance",
  turnaround: "role://self/turnaround",
};

export const ROLE_PICTURES_SCHEME_PROMPT = `${ROLE_PICTURE_URIS.reference} 是你自己的形象参考图，${ROLE_PICTURE_URIS.turnaround} 是你的三视图（都存在你的角色卡里，卡里有才能读）。可以用 read 看，或放进 generate_image 的 referenceUris。`;

/** Joined to the role instructions of conversations whose card has pictures. */
export function rolePicturesPrompt(pictures: RoleCardPictures): string {
  const named = [
    pictures.reference ? `形象参考图 ${ROLE_PICTURE_URIS.reference}` : "",
    pictures.turnaround ? `三视图 ${ROLE_PICTURE_URIS.turnaround}` : "",
  ].filter(Boolean);
  if (!named.length) return "";
  return `你的${named.join("、")}。要自拍、画你自己，或有人想看你长什么样时，把${named.length > 1 ? "它们" : "它"}放进 generate_image 的 referenceUris（subjectType=specific），不用再上网找；只固定你的长相，衣服、姿势和背景按需要变。想确认自己的样子，先用 read 看。`;
}
