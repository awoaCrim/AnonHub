/**
 * Blind character-fidelity review of replay replies against the role material.
 *
 * For every case the judge sees the role material (PERSONA.md, card description/personality and
 * example dialogues), the recent conversation, and all candidate replies (production V0 plus each
 * replayed variant/model, first run) under shuffled letters. It scores each candidate; the mapping
 * back to variants is kept out of the prompt. Each case is judged `--passes` times with a fresh
 * shuffle to dilute position bias.
 *
 * Env: REPLAY_ANTHROPIC_KEY, REPLAY_GATEWAY
 * With `--items`, each line of <work-dir>/items.jsonl ({id, group, context, reply}) is scored on its own
 * so replies from different sources (old production, replay, other channels) share one absolute scale.
 *
 * Usage:
 *   node --import tsx scripts/voice-replay/judge.mts <work-dir> [--passes 2] [--items]
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { generateText, type LanguageModel } from "ai";

import { ModelService } from "../../core/src/models/index.js";
import { decodeRoleCard } from "../../packages/character-cards/src/index.js";
import { ROLE_SETTINGS } from "../../packages/contracts/src/role-cards.js";
import { createAnthropicProvider, type Config as AnthropicConfig } from "../../providers/model-provider/src/anthropic.js";

const JUDGE_MODEL = "uwoacrimson-anthropic:wbcn/step-5-preview";

const RUBRIC = `你是角色扮演质量评审。只依据下面给出的角色材料判断，不依据你自己对这个角色的印象。

评分维度（每项 1-5 分）：
- voice：说话方式像不像材料里这个角色平常的样子——在意的点、态度、和对方的距离、用词和句子长短，以示例对话和"平常的你"一节为准。
- state：反应是否符合眼前情境；没有把材料里"特定情况"下的反应（被夸、被说中痛处等）当成每次开口的姿态，也没有为了显示性格而硬演。
- register：有没有变成通用助手、客服、说明文或资料报告的腔调；回答正事时是否仍是这个角色在对这个人说话。
感叹号、语气词、"～"等本身都是合法表达，只看它们用得是否像这个角色、是否和情境相称，不因出现与否直接加减分。
事实正确性不在本次评分范围内。
候选之间相互比较：最贴合的给 5，明显不如它的要拉开分差，不要大面积给同分。

只输出 JSON：{"scores":{"A":{"voice":n,"state":n,"register":n,"note":"不超过30字"}, ...}}，覆盖每个候选字母。`;

const SINGLE_RUBRIC = RUBRIC.replace(
  /候选之间相互比较[^\n]*\n/,
  "只有一条候选。按材料独立给分：5 = 就是这个角色会说的话；3 = 能看出角色但有明显的通用腔或套路；1 = 换成任何助手说都一样。\n",
).replace(
  '只输出 JSON：{"scores":{"A":{"voice":n,"state":n,"register":n,"note":"不超过30字"}, ...}}，覆盖每个候选字母。',
  '只输出 JSON：{"voice":n,"state":n,"register":n,"note":"不超过30字"}',
);

interface JudgeItem {
  readonly id: string;
  readonly group: string;
  readonly kind?: string;
  readonly context: string;
  readonly reply: string;
}

interface Candidate {
  readonly label: string;
  readonly text: string;
}

interface StoredRow {
  readonly type?: string;
  readonly data?: {
    readonly role?: string;
    readonly type?: string;
    readonly content?: unknown;
    readonly data?: { readonly user?: { readonly name?: string }; readonly parts?: Array<{ type: string; text?: string }> };
  };
}

function partsText(parts: ReadonlyArray<{ type: string; text?: string }> | undefined): string {
  return (parts ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`)).join("");
}

function sentTexts(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content as Array<{ type?: string; toolName?: string; input?: { parts?: Array<{ kind?: string; text?: string }> } }>) {
    if (part.type === "tool-call" && part.toolName === "send_message")
      return (part.input?.parts ?? []).flatMap((item) => (item.kind === "text" && item.text ? [item.text] : []));
  }
  return undefined;
}

/** Last few visible turns, rendered plainly so the judge sees what the reply answers. */
async function recentContext(caseDir: string, limit = 8): Promise<string> {
  const rows = (await readFile(join(caseDir, "history.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredRow);
  const lines: string[] = [];
  for (const row of rows) {
    if (row.data?.type === "yesimbot.message") lines.push(`${row.data.data?.user?.name ?? "某人"}：${partsText(row.data.data?.parts)}`);
    const sent = row.data?.role === "assistant" ? sentTexts(row.data.content) : undefined;
    if (sent?.length) lines.push(`爱音：${sent.join(" / ")}`);
  }
  const trigger = JSON.parse(await readFile(join(caseDir, "trigger.json"), "utf8")) as StoredRow;
  lines.push(`${trigger.data?.data?.user?.name ?? "某人"}（当前消息）：${partsText(trigger.data?.data?.parts)}`);
  return lines
    .slice(-limit)
    .map((line) => line.slice(0, 400))
    .join("\n");
}

async function candidates(work: string, id: string): Promise<Candidate[]> {
  const meta = JSON.parse(await readFile(join(work, "cases", id, "case.json"), "utf8")) as { reply: string[] };
  const found: Candidate[] = [{ label: "V0 production", text: meta.reply.join("\n") }];
  for (const variant of await readdir(join(work, "outputs"))) {
    for (const model of await readdir(join(work, "outputs", variant))) {
      const text = await readFile(join(work, "outputs", variant, model, `${id}.r1.json`), "utf8").then(
        (raw) => {
          const result = JSON.parse(raw) as { action: string; texts?: string[] };
          return result.action === "send" && result.texts?.length ? result.texts.join("\n") : undefined;
        },
        () => undefined,
      );
      if (text) found.push({ label: `${variant} ${model}`, text });
    }
  }
  return found;
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  for (let index = result.length - 1; index > 0; index--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const swap = state % (index + 1);
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

async function connect(work: string): Promise<{ model: LanguageModel; stop: () => Promise<void> }> {
  const service = new ModelService({ baseDir: process.cwd(), emit: () => {} }, { basePath: work, logLevel: 0 });
  const lifecycle = service as unknown as { start(): Promise<void>; stop(): Promise<void> };
  await lifecycle.start();
  service.register(
    createAnthropicProvider({
      id: "uwoacrimson-anthropic",
      apiKey: process.env.REPLAY_ANTHROPIC_KEY ?? "",
      baseURL: `${process.env.REPLAY_GATEWAY ?? "http://127.0.0.1:18334"}/v1`,
      chatModels: [{ id: "wbcn/step-5-preview", toolCall: true, reasoning: false }],
    } as unknown as AnthropicConfig),
  );
  return { model: service.resolveChatModel(JUDGE_MODEL).model, stop: () => lifecycle.stop() };
}

async function judgeItems(work: string, material: string, model: LanguageModel): Promise<void> {
  const outDir = join(work, "judgements-single");
  await mkdir(outDir, { recursive: true });
  const queue = (await readFile(join(work, process.env.REPLAY_ITEMS ?? "items.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JudgeItem);
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const output = join(outDir, `${item.id}.json`);
      if (
        await readFile(output, "utf8").then(
          () => true,
          () => false,
        )
      )
        continue;
      const prompt = [material, `## 当前情境\n${item.context}`, `## 候选回复（千早爱音发出的）\n${item.reply}`].join("\n\n");
      try {
        const { text } = await generateText({
          model,
          system: SINGLE_RUBRIC,
          prompt,
          temperature: 0,
          maxOutputTokens: 8192,
          abortSignal: AbortSignal.timeout(300_000),
        });
        const score = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
        await writeFile(output, JSON.stringify({ ...item, score }, null, 2));
        console.log(`judged ${item.id}`);
      } catch (error) {
        console.error(`failed ${item.id}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.REPLAY_CONCURRENCY ?? 4) }, worker));
}

async function main(): Promise<void> {
  const [workArg, ...flags] = process.argv.slice(2);
  if (!workArg) {
    console.error("usage: judge.mts <work-dir> [--passes 2]");
    process.exit(2);
  }
  const work = resolve(workArg);
  const passesFlag = flags.indexOf("--passes");
  const passes = passesFlag >= 0 ? Number(flags[passesFlag + 1]) : 2;
  const card = decodeRoleCard(await readFile(join(work, "raw", "card.json")));
  const persona = await readFile(join(work, "raw", "PERSONA.md"), "utf8");
  const material = [
    `## PERSONA.md\n${persona}`,
    `## 角色卡\n${ROLE_SETTINGS.map(({ key, label }) => (card[key].trim() ? `### ${label}\n${card[key].trim()}` : ""))
      .filter(Boolean)
      .join("\n\n")}`,
    `## 角色卡示例对话\n${card.examples}`,
  ].join("\n\n");
  const { model, stop } = await connect(work);
  if (flags.includes("--items")) {
    await judgeItems(work, material, model);
    await stop();
    return;
  }
  const outDir = join(work, "judgements");
  await mkdir(outDir, { recursive: true });

  const jobs: Array<{ id: string; pass: number }> = [];
  for (const id of (await readdir(join(work, "cases"))).sort()) for (let pass = 1; pass <= passes; pass++) jobs.push({ id, pass });
  const worker = async (): Promise<void> => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const output = join(outDir, `${job.id}.p${job.pass}.json`);
      if (
        await readFile(output, "utf8").then(
          () => true,
          () => false,
        )
      )
        continue;
      const pool = shuffle(await candidates(work, job.id), job.pass * 7919 + job.id.charCodeAt(1) * 31 + Number(job.id.slice(1)));
      const letters = pool.map((_, index) => String.fromCharCode(65 + index));
      const prompt = [
        material,
        `## 最近对话\n${await recentContext(join(work, "cases", job.id))}`,
        `## 候选回复（都是千早爱音对当前消息的回复，彼此独立）\n${pool.map((item, index) => `${letters[index]}. ${item.text}`).join("\n\n")}`,
      ].join("\n\n");
      try {
        const { text } = await generateText({
          model,
          system: RUBRIC,
          prompt,
          temperature: 0,
          maxOutputTokens: 8192,
          abortSignal: AbortSignal.timeout(300_000),
        });
        const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
        const scores = (JSON.parse(json) as { scores: Record<string, unknown> }).scores;
        const mapped = Object.fromEntries(letters.map((letter, index) => [pool[index]!.label, scores[letter]]));
        await writeFile(output, JSON.stringify({ id: job.id, pass: job.pass, scores: mapped }, null, 2));
        console.log(`judged ${job.id}.p${job.pass} (${pool.length} candidates)`);
      } catch (error) {
        console.error(`failed ${job.id}.p${job.pass}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.REPLAY_CONCURRENCY ?? 4) }, worker));
  await stop();
}

await main();
process.exit(0);
