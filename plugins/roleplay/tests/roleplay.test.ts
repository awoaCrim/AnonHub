import { blankRoleCardText } from "@yesimbot/contracts/role-cards";
import { describe, expect, it } from "vitest";

import { assembleRoleProfile } from "../src/prompt.js";

describe("roleplay role profile", () => {
  it("puts 角色设定 box by box in the definition, 示例对话 in the instructions and 回复前提醒 apart for after the history", () => {
    const profile = assembleRoleProfile({
      ...blankRoleCardText("千早爱音"),
      nickname: "爱音",
      identity: "高一学生",
      speech: "语气轻快",
      rules: "不说自己是 AI",
      examples: "对方：在吗\n爱音：在！",
      reminder: "每次不超过三句话",
    });
    expect(profile).toEqual({
      characterDefinition: "名字：千早爱音\n自称：爱音\n\n## 身份\n高一学生\n\n## 说话方式\n语气轻快\n\n## 规矩\n不说自己是 AI",
      roleInstructions: "<example_dialogues>\n以下是说话方式的示例，不是这段对话里发生过的事。\n对方：在吗\n爱音：在！\n</example_dialogues>",
      postHistoryInstructions: "每次不超过三句话",
    });
  });

  it("leaves out empty boxes, blank text and a self name equal to the name", () => {
    expect(assembleRoleProfile({ ...blankRoleCardText("爱音"), nickname: "爱音", looks: "  \n", examples: " ", reminder: "" })).toEqual({
      characterDefinition: "名字：爱音",
    });
    expect(assembleRoleProfile(blankRoleCardText())).toEqual({});
  });
});
