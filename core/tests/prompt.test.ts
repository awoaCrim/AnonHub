import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { authoredDescription } from "../src/agents/reply-tools.js";
import type { ChannelContext } from "../src/channels/index.js";
import { buildCoreSystemPrompt } from "../src/runtimes/prompt.js";

function promptText(prompt: Awaited<ReturnType<typeof buildCoreSystemPrompt>>): string {
  return prompt.map((block) => String(block.content)).join("\n\n");
}

describe("buildCoreSystemPrompt", () => {
  it.each(["web-first", "chat-first"])("isolates web output rules while preserving a shared role (%s)", async (order) => {
    const direct = { type: "direct" as const, channelId: "owner", userId: "owner", selfId: "bot" };
    const channels: ChannelContext[] = [
      { ...direct, platform: "web" },
      { ...direct, platform: "onebot" },
      { type: "guild", platform: "onebot", channelId: "owner", guildId: "owner", selfId: "bot" },
      { ...direct, platform: "wechat-bridge" },
      { ...direct, platform: "xiaoheihe" },
    ];
    const roleProfile = { characterDefinition: "SHARED_PLATFORM_ROLE_SENTINEL" };
    const roleSections = new Set<string>();
    for (const channel of order === "web-first" ? channels : [...channels].reverse()) {
      const prompt = await buildCoreSystemPrompt({ channel, selfId: "bot", roleProfile });
      const text = promptText(prompt);
      const web = channel.platform === "web";
      for (const marker of ["每一项显示为一条 Markdown 消息", "只在等待动画旁作为临时状态显示", "你输出的普通文本不会作为聊天消息显示"])
        expect(text.includes(marker), `${channel.platform}/${channel.type}: ${marker}`).toBe(web);
      expect(text.includes("你输出的普通文本不会作为消息发出")).toBe(!web);
      expect(text.includes("文字消息使用 send_message")).toBe(!web);
      expect(text).toContain("SHARED_PLATFORM_ROLE_SENTINEL");
      roleSections.add(String(prompt[1]!.content));
    }
    expect(roleSections.size).toBe(1);
  });

  // Prompt-contract coverage; this does not measure a model's factual accuracy.
  it.each(["onebot", "xiaoheihe"])("requires actual factual sources in shared Core rules on %s", async (platform) => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-factual-evidence-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        channel: { type: "guild", platform, guildId: "g", channelId: "c", selfId: "bot" },
        selfId: "bot",
      });
      const text = promptText(prompt);
      for (const rule of [
        "事实判断须有可靠依据；拿不准时先查，查不到就直说不确定，不下结论",
        "没听过某个型号、模型知识缺失或数据库无记录，不能证明产品不存在或是假货",
        "普通闲聊不必逐句搜索",
      ])
        expect(text).toContain(rule);
      expect(text).not.toContain("对确实掌握的知识和形成的判断保持正常的信心");
      expect(text).not.toContain("旧帖");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true].map((innerThought) => ({ innerThought })))(
    "keeps independent ordered responsibilities (inner=$innerThought)",
    async ({ innerThought }) => {
      const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-blocks-"));
      try {
        // Files from the retired PERSONA.md / AGENTS.md support are never read.
        await writeFile(join(root, "PERSONA.md"), "PERSONA_SENTINEL");
        await writeFile(join(root, "AGENTS.md"), "AGENTS_SENTINEL");
        const prompt = await buildCoreSystemPrompt({
          channel: { type: "direct", platform: "test", channelId: "user", selfId: "bot" },
          selfId: "bot",
          customInnerThought: innerThought,
          roleProfile: { characterDefinition: "CARD_SENTINEL", roleInstructions: "CARD_RULE_SENTINEL" },
        });
        const headings = ["# 运行契约", "# 角色", "# 互动策略", "# 能力与证据边界", ...(innerThought ? ["# 内心判断"] : []), "<runtime_context>"];
        const contents = prompt.map((block) => String(block.content));
        expect(contents.map((content) => content.split("\n")[0])).toEqual(headings);
        expect(prompt.every((block) => block.role === "system" && String(block.content).trim().length > 0)).toBe(true);
        for (const heading of headings) {
          expect(contents.filter((content) => content.startsWith(heading))).toHaveLength(1);
        }
        const ownership: Array<readonly [string, string]> = [
          ["# 运行契约", "你输出的普通文本不会作为消息发出"],
          ["# 角色", "CARD_SENTINEL"],
          ["# 角色", "CARD_RULE_SENTINEL"],
          ["# 角色", "完全沉浸在你的人设中"],
          ["# 能力与证据边界", "同一作者、同一产品的其他动态不等于当前引用的上下文"],
          ["# 互动策略", "[CURRENT_MESSAGE]"],
          ["# 能力与证据边界", "不要把未经证实的假设写进搜索词"],
          ["# 互动策略", "以当前消息或事件的 time 作为现在"],
          ["# 互动策略", "被告知不等于获准转述"],
          ["# 互动策略", "当事人自己问起，或主人明确要你查看、转达时，照常处理"],
          ["# 能力与证据边界", "本轮结束之后才兑现的承诺"],
          ["# 能力与证据边界", "这类转述本身不构成授权"],
        ];
        if (innerThought) ownership.push(["# 内心判断", "send_message 和 finish 的 inner_thought"]);
        for (const [heading, marker] of ownership) {
          expect(contents.filter((content) => content.includes(marker))).toEqual([contents[headings.indexOf(heading)]]);
        }
        expect(contents.join("\n")).not.toContain("PERSONA_SENTINEL");
        expect(contents.join("\n")).not.toContain("AGENTS_SENTINEL");
        if (!innerThought) expect(promptText(prompt)).not.toContain("# 内心判断");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it.each(["guild", "channel", "direct"] as const)("explains the actual %s channel type and quote sender", async (type) => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const channel =
        type === "direct"
          ? { type, platform: "onebot", channelId: "user", userId: "user", selfId: "bot" }
          : { type, platform: "onebot", channelId: "room", guildId: "guild" };
      const prompt = await buildCoreSystemPrompt({ channel, selfId: "bot" });
      const constitution = promptText(prompt);
      expect(constitution).toContain("channel 和 guild 都是多人共同参与的社交场");
      expect(constitution).toContain("direct 是与单个人的私下交流");
      expect(constitution).not.toContain("shared 是");
      expect(constitution).toContain("引用区块中的 sender 是被引用消息的作者");
      expect(constitution).toContain("缺少 sender 时表示作者未知");
      expect(String(prompt.at(-1)?.content)).toContain(`<type>${type}</type>`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps first-person role expression without requiring a hidden reasoning format", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });
      const constitution = promptText(prompt);
      expect(constitution).toContain("内部判断只服务于当前回合决策");
      expect(constitution).not.toContain("静默推理过程");
      expect(constitution).toContain("第一人称在情境内部进行");
      expect(constitution).toContain("不要以旁观者或分析者视角归纳、猜测自己的人设");
      expect(constitution).toContain("人设是你行动的前提，不是待推断的结论");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("removes only the generic emoji preference (inner=%s)", async (customInnerThought) => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
        customInnerThought,
        roleProfile: { characterDefinition: "CARD_SENTINEL", roleInstructions: "CARD_RULE_SENTINEL" },
      });
      const expectedBoundaries =
        "你以本节描述的身份存在于持续发生的交流情境中，完全沉浸在你的人设中，对外发言以当前身份的声音、第一人称在情境内部进行。人设是你行动的前提，不是待推断的结论，不要以旁观者或分析者视角归纳、猜测自己的人设；内部判断只服务于当前回合决策，不是角色台词的预演。\n依据角色的动机、经历和眼前情境形成反应，不为证明性格标签而重复同一种表现。允许赞同、拒绝或保留意见，不为讨好或刻意对抗而违背自己的判断。不代写用户没有表达的行动、想法、感受或决定；情绪与关系的变化要有实际互动依据。\n不需要行动时，像有自己生活节奏的人一样存在。";
      const roleText = String(prompt[1]!.content);
      expect(roleText.split("</character_card>\n\n").at(-1)).toBe(expectedBoundaries);
      expect(promptText(prompt)).not.toContain(
        "对外发送的文本尽量避免使用 emoji 或其他 Unicode 表情符号；优先用文字和标点表达情绪，只有在确实有助于语气时才偶尔使用。",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["default", "custom", "card", "combined"])("preserves evidence and role autonomy alongside the request workflow (%s)", async (role) => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-response-choice-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        channel: { type: "direct", platform: "test", channelId: "user", selfId: "bot" },
        selfId: "bot",
        ...(role === "card" || role === "combined" ? { roleProfile: { characterDefinition: "SYNTHETIC_CARD" } } : {}),
      });
      const text = promptText(prompt);
      const roleBlock = String(prompt[1]!.content);
      const evidence = String(prompt.find((block) => String(block.content).startsWith("# 能力与证据边界"))?.content);
      expect(roleBlock).toContain("不为证明性格标签而重复同一种表现");
      expect(roleBlock).toContain("允许赞同、拒绝或保留意见");
      expect(evidence).toContain("同一作者、同一产品的其他动态不等于当前引用的上下文");
      expect(evidence).toContain("如实说明未找到对应依据");
      expect(evidence).toContain("有可靠依据时正常表达，不必刻意加免责声明");
      expect(text).not.toContain("回应不必附带点评");
      expect(text.split("同一作者、同一产品")).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves how to split and send to the send_message tool, once, without sticker guidance when none is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = promptText(
        await buildCoreSystemPrompt({
          channel: { type: "direct", platform: "test", channelId: "user", selfId: "bot" },
          selfId: "bot",
        }),
      );
      // The system prompt keeps only the idea (text output is not delivered; send tools speak; finish ends).
      expect(prompt).not.toContain("# 完整回复编排");
      expect(prompt).not.toContain("不按字数、句号或空行机械拆分");
      expect(prompt).toContain("以各工具的说明为准");
      const tool = authoredDescription(false, false);
      expect(tool).toContain("parts");
      expect(tool).toContain("不按字数、句号或空行机械拆分");
      expect(tool).toContain("完整代码、命令与精确引用不拆散");
      expect(tool).toContain("需要先简短确认再工作时，可以先发确认");
      expect(tool).toContain("不结束本轮");
      expect(tool).not.toMatch(/sticker_id|预览/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit delivery without excluding plugin-owned sending tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
        customInnerThought: false,
      });

      const constitution = promptText(prompt);
      expect(constitution).toContain("你输出的普通文本不会作为消息发出");
      expect(constitution).toContain("文字消息使用 send_message");
      expect(constitution).toContain("插件提供的其他发送工具可以直接发送其支持的内容");
      expect(constitution).toContain("未调用任何发送工具时，本轮不会有内容发出");
      expect(constitution).not.toContain("消息只通过 send_message");
      expect(constitution).not.toContain("sticker_send");
      expect(constitution).not.toContain("尽量避免使用 emoji 或其他 Unicode 表情符号");
      expect(constitution).not.toContain("# 最终回复标签");
      expect(constitution).not.toContain("<reply>");
      expect(constitution).not.toContain("<message/>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("points inner thought at the send_message and finish fields instead of an output tag", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const enabled = await buildCoreSystemPrompt({
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
        customInnerThought: true,
      });
      const disabled = await buildCoreSystemPrompt({
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
        customInnerThought: false,
      });

      const enabledText = promptText(enabled);
      expect(enabledText).toContain("send_message 和 finish 的 inner_thought");
      expect(enabledText).toContain("# 内心判断");
      expect(enabledText).toContain("不发送的简短行为判断");
      expect(enabledText).toContain("具体字段约束见工具说明");
      expect(enabledText).not.toContain("内心独白和对外发言都以你的 persona 的声音进行");
      expect(promptText(disabled)).not.toContain("# 内心判断");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves detailed voice decisions to the complete request workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });

      const constitution = promptText(prompt);
      // Detailed voice decisions live only in the request workflow, not the system prompt.
      expect(constitution).not.toContain("同一回应保持同一说话身份、语域和叙述距离");
      expect(constitution).not.toContain("外部资料只作为事实材料");
      expect(constitution).not.toContain("不要把同一回应拆成互相割裂的报告和聊天");
      // The send_message tool owns splitting; the legacy messages-draft wording is gone.
      expect(constitution).not.toContain("不要用普通文本中的空行制造消息分段");
      expect(constitution).not.toContain("messages 的独立项目");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires target checks and evidence-calibrated image and search claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });

      const constitution = promptText(prompt);
      expect(constitution).toContain("先确认消息是否明确指向你");
      expect(constitution).toContain("只有问号或含义不完整的短句");
      expect(constitution).toContain("区分可见事实、工具结果与自己的推测");
      expect(constitution).toContain("不要把未经证实的假设写进搜索词");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps task completion guidance without retired history framing", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        channel: { type: "direct", platform: "test", channelId: "user", userId: "user", selfId: "bot" },
        selfId: "bot",
      });

      const constitution = promptText(prompt);
      expect(constitution).not.toContain("delivered_transcript");
      expect(constitution).toContain("上一轮任务视为已经完成");
      expect(constitution).toContain("不要重新执行同一任务、重述完整结果");
      // User, 2026-11-18 (prompt review): a plain-words report of a concrete problem reopens the task.
      expect(constitution).toContain("用日常的话指出具体问题");
      expect(constitution).toContain("发现自己有实质性错误时，不必等对方要求就更正");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("anchors current-message authors without inventing a topic from an at mention", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });

      const constitution = promptText(prompt);
      expect(constitution).toContain("[CURRENT_MESSAGE]");
      expect(constitution).toContain("当前消息的 sender 是本轮正在互动的人");
      expect(constitution).toContain("@ 只说明消息指向谁，不提供话题");
      expect(constitution).toContain("不要把历史中别人的话题、断言或情绪当作当前发送者的内容");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("no longer emits a separate message-elements system block", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });

      expect(prompt.map((block) => String(block.content)).some((content) => content.startsWith("# 消息元素"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not include the removed delivered-message marker workaround", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });

      const constitution = promptText(prompt);
      expect(constitution).not.toContain("[DELIVERED_MESSAGE]");
      expect(constitution).not.toContain("历史记录的内部格式");
      expect(constitution).toContain("对外内容只能通过本轮实际提供的发送工具到达平台");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ends a silent turn with finish, never with plain text", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
        customInnerThought: true,
      });

      const constitution = promptText(prompt);
      expect(constitution).toContain("不需要你参与时用 finish 结束本轮");
      expect(constitution).not.toContain("把判断写进 finish 的 reason");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the built-in persona without a role card", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });
      const all = prompt.map((block) => String(block.content)).join("\n");

      expect(all).toContain("<persona>\n# Athena");
      expect(all).toContain("完全沉浸在你的人设中");
      expect(all).toContain("像有自己生活节奏的人一样存在");
      expect(all).not.toContain("对外发送的文本尽量避免使用 emoji");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
