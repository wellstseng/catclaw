/**
 * @file cli-bridge/control-request.ts
 * @description Claude CLI control_request（`--permission-prompt-tool stdio`）→ Discord 互動 → control_response
 *
 * 三種請求各自的 UI：
 * - AskUserQuestion：每題一個 select menu（multiSelect 對應 maxValues），「其他」開 modal 自填；答案塞回 updatedInput.answers
 * - ExitPlanMode：貼出計畫 + 核准／退回；退回可在 modal 填意見，成為 deny message，Claude 會據此改計畫再送一次
 * - 其他工具：顯示 input JSON + 允許／拒絕（只有 dangerouslySkipPermissions=false 才會收到）
 *
 * 只有觸發這個 turn 的 Discord 使用者能作答；逾時（CATCLAW_PERMISSION_TIMEOUT_MS，預設 10 分鐘）一律 deny，
 * 讓 CLI 收到明確訊息結束回合，不會卡在 busy。
 *
 * team DM bridge（channelConfig.dm.kind === "team"，見 dm.ts）：AskUserQuestion 仍問發話者，
 * ExitPlanMode / 其他工具的審批改發到 owner 的 DM、只接受 owner 互動；發話者只看到「已送審 → 結果」。
 * 送不到 owner 一律 deny，不退回給發話者自審。
 */

import {
  type Message,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type MessageComponentInteraction,
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { log } from "../logger.js";
import type { CliBridge } from "./bridge.js";
import type { CliBridgeEvent, ControlDecision } from "./types.js";
import type { BridgeSender, IndependentBotSender, MainBotSender } from "./discord-sender.js";

const TIMEOUT_MS = Number(process.env.CATCLAW_PERMISSION_TIMEOUT_MS ?? 600_000);
const TIMEOUT_MIN = Math.round(TIMEOUT_MS / 60_000);
const OTHER = "__other__";

type ControlRequestEvent = CliBridgeEvent & { type: "control_request" };

export async function handleControlRequest(
  evt: ControlRequestEvent,
  bridge: CliBridge,
  originalMessage: Message,
  sender: BridgeSender,
): Promise<void> {
  const userId = originalMessage.author.id;
  let decision: ControlDecision;
  let routed = false;
  try {
    if (evt.tool === "AskUserQuestion") {
      decision = await askUserQuestion(evt, sender, userId);
    } else {
      const route = await resolveApprovalRoute(bridge, sender);
      routed = route !== null;
      const approver = route ?? { sender, userId, note: "" };
      if (route) await sender.send(`⏳ 權限請求已送交管理者審批：\`${evt.tool}\``).catch(() => {});
      decision = evt.tool === "ExitPlanMode"
        ? await approvePlan(evt, approver.sender, approver.userId, approver.note)
        : await genericPermission(evt, approver.sender, approver.userId, approver.note);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[cli-bridge-control] ${evt.tool} Discord 互動失敗：${msg}`);
    decision = { behavior: "deny", message: `Discord 互動失敗：${msg}` };
  }
  bridge.sendControlResponse(evt.requestId, decision);
  if (routed) {
    await sender.send(decision.behavior === "allow"
      ? `✅ 管理者已核准：\`${evt.tool}\``
      : `❌ 管理者拒絕或逾時：\`${evt.tool}\``).catch(() => {});
  }
}

interface ApprovalRoute { sender: BridgeSender; userId: string; note: string }

/**
 * team DM bridge → 回 owner 的 DM 作為審批頻道；一般 bridge 回 null（發話者自審）。
 * team 但缺 approvalChannelId/approverId 或頻道取不到 → throw（上層轉 deny），不給發話者自審。
 */
async function resolveApprovalRoute(bridge: CliBridge, sender: BridgeSender): Promise<ApprovalRoute | null> {
  const dm = bridge.getChannelConfig().dm;
  if (dm?.kind !== "team") return null;
  if (!dm.approvalChannelId || !dm.approverId) throw new Error("team DM bridge 缺 approvalChannelId/approverId，無法送審");
  const base = bridge.getSender();
  const client = base.mode === "independent-bot"
    ? (base as IndependentBotSender).getClient()
    : (base as MainBotSender).getClient();
  const ch = await client.channels.fetch(dm.approvalChannelId);
  if (!ch?.isSendable()) throw new Error(`owner 審批頻道 ${dm.approvalChannelId} 不可發送`);
  return {
    sender: sender.withChannel(ch),
    userId: dm.approverId,
    note: `（來自 **${dm.userName}** 的私訊，bridge \`${bridge.label}\`）\n`,
  };
}

// ── 共用 ─────────────────────────────────────────────────────────────────────

/** awaitMessageComponent / awaitModalSubmit 逾時會 reject → 統一轉 null */
function nullOnTimeout<T>(p: Promise<T>): Promise<T | null> {
  return p.catch(() => null);
}

function buttons(approveId: string, approveLabel: string, denyId: string, denyLabel: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(approveId).setLabel(approveLabel).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(denyId).setLabel(denyLabel).setStyle(ButtonStyle.Danger),
  );
}

/** 從按鈕／選單互動開 modal 收一段文字；使用者關掉 modal 或逾時 → null */
async function askFreeText(
  interaction: MessageComponentInteraction,
  title: string,
  label: string,
  required: boolean,
): Promise<string | null> {
  const modalId = `cr-modal-${interaction.id}`;
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle(title.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("text")
          .setLabel(label.slice(0, 45))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(required)
          .setMaxLength(1000),
      ),
    );
  await interaction.showModal(modal);
  const submit = await nullOnTimeout(interaction.awaitModalSubmit({
    filter: (m) => m.customId === modalId && m.user.id === interaction.user.id,
    time: TIMEOUT_MS,
  }));
  if (!submit) return null;
  await submit.deferUpdate().catch(() => {});
  return submit.fields.getTextInputValue("text").trim();
}

async function finalize(sender: BridgeSender, msg: Message, content: string): Promise<void> {
  await sender.editComponents(msg, { content: content.slice(0, 1990), components: [] })
    .catch((e) => { log.debug(`[cli-bridge-control] 收尾 edit 失敗：${e instanceof Error ? e.message : String(e)}`); });
}

// ── AskUserQuestion ──────────────────────────────────────────────────────────

interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

async function askUserQuestion(evt: ControlRequestEvent, sender: BridgeSender, userId: string): Promise<ControlDecision> {
  const questions = (evt.input.questions as AskQuestion[] | undefined) ?? [];
  const answers: Record<string, string> = {};

  for (const [qi, q] of questions.entries()) {
    const opts = (q.options ?? []).slice(0, 24);
    const select = new StringSelectMenuBuilder()
      .setCustomId(`cr-ask-${evt.requestId.slice(0, 8)}-${qi}`)
      .setPlaceholder(q.multiSelect ? "可複選" : "選一個")
      .setMinValues(1)
      .setMaxValues(q.multiSelect ? opts.length + 1 : 1)
      .addOptions([
        ...opts.map((o, i) => ({
          label: String(o.label).slice(0, 100),
          value: String(i),
          description: o.description ? String(o.description).slice(0, 100) : undefined,
        })),
        { label: "其他（自行輸入）", value: OTHER, description: "開啟輸入框填寫" },
      ]);
    const header = String(q.header ?? "問題").slice(0, 80);
    const prompt = `❓ **${header}**\n${String(q.question)}`.slice(0, 1900);
    const promptMsg = await sender.sendComponents({
      content: prompt,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    });

    const interaction = await nullOnTimeout(promptMsg.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      filter: (i: StringSelectMenuInteraction) => i.user.id === userId,
      time: TIMEOUT_MS,
    }));
    if (!interaction) {
      await finalize(sender, promptMsg, `${prompt}\n\n→ ⏰ ${TIMEOUT_MIN} 分鐘內未回答`);
      return { behavior: "deny", message: `使用者 ${TIMEOUT_MIN} 分鐘內未回答「${q.question}」。請結束本回合，等使用者在頻道回覆後再繼續。` };
    }

    const picked = interaction.values.filter(v => v !== OTHER).map(v => String(opts[Number(v)]?.label ?? v));
    if (interaction.values.includes(OTHER)) {
      const text = await askFreeText(interaction, header, q.question.slice(0, 45), true);
      if (text === null) {
        await finalize(sender, promptMsg, `${prompt}\n\n→ ⏰ 未完成自行輸入`);
        return { behavior: "deny", message: `使用者選了「其他」但未完成輸入「${q.question}」。請結束本回合，等使用者在頻道回覆後再繼續。` };
      }
      picked.push(text);
    } else {
      await interaction.deferUpdate().catch(() => {});
    }

    const answer = picked.join(", ");
    answers[q.question] = answer;
    await finalize(sender, promptMsg, `${prompt}\n\n→ **${answer}**`);
    log.info(`[cli-bridge-control] AskUserQuestion「${header}」→ ${answer}`);
  }

  return { behavior: "allow", updatedInput: { ...evt.input, answers } };
}

// ── ExitPlanMode ─────────────────────────────────────────────────────────────

async function approvePlan(evt: ControlRequestEvent, sender: BridgeSender, userId: string, prefix = ""): Promise<ControlDecision> {
  const plan = String(evt.input.plan ?? "").trim() || "(空計畫)";
  const head = `${prefix}📋 **計畫待核准**`;
  const tooLong = plan.length > 1800;
  const body = tooLong ? plan.slice(0, 1800) + "\n…（完整計畫見附件）" : plan;
  const id = evt.requestId.slice(0, 8);
  const promptMsg = await sender.sendComponents({
    content: `${head}\n${body}`,
    components: [buttons(`cr-plan-ok-${id}`, "核准", `cr-plan-no-${id}`, "退回")],
    files: tooLong ? [new AttachmentBuilder(Buffer.from(plan, "utf-8"), { name: "plan.md" })] : [],
  });

  const interaction = await nullOnTimeout(promptMsg.awaitMessageComponent({
    componentType: ComponentType.Button,
    filter: (i: ButtonInteraction) => i.user.id === userId,
    time: TIMEOUT_MS,
  }));
  if (!interaction) {
    await finalize(sender, promptMsg, `${head} → ⏰ ${TIMEOUT_MIN} 分鐘內無人核准\n${body}`);
    return { behavior: "deny", message: `使用者 ${TIMEOUT_MIN} 分鐘內未核准計畫。請結束本回合，等使用者回覆後再繼續。` };
  }

  if (interaction.customId.startsWith("cr-plan-ok-")) {
    await interaction.deferUpdate().catch(() => {});
    await finalize(sender, promptMsg, `${head} → ✅ 已核准\n${body}`);
    log.info(`[cli-bridge-control] ExitPlanMode → 核准`);
    return { behavior: "allow", updatedInput: evt.input };
  }

  const feedback = await askFreeText(interaction, "退回計畫", "修改意見（可留空）", false);
  const note = feedback ? `：${feedback}` : "";
  await finalize(sender, promptMsg, `${head} → ❌ 已退回${note}\n${body}`);
  log.info(`[cli-bridge-control] ExitPlanMode → 退回${note}`);
  return {
    behavior: "deny",
    message: feedback
      ? `使用者退回計畫：${feedback}`
      : "使用者退回計畫（未附意見），請結束本回合，等使用者在頻道說明修改方向。",
  };
}

// ── 其他工具 ─────────────────────────────────────────────────────────────────

async function genericPermission(evt: ControlRequestEvent, sender: BridgeSender, userId: string, prefix = ""): Promise<ControlDecision> {
  const head = `${prefix}🔐 **權限請求**\n工具：\`${evt.tool}\``;
  const json = JSON.stringify(evt.input, null, 2);
  const budget = 1900 - head.length - 20;
  const shown = json.length > budget ? json.slice(0, budget) + "\n…(truncated)" : json;
  const content = `${head}\n\`\`\`json\n${shown}\n\`\`\``;
  const id = evt.requestId.slice(0, 8);
  const promptMsg = await sender.sendComponents({
    content,
    components: [buttons(`cr-ok-${id}`, "允許", `cr-no-${id}`, "拒絕")],
  });

  const interaction = await nullOnTimeout(promptMsg.awaitMessageComponent({
    componentType: ComponentType.Button,
    filter: (i: ButtonInteraction) => i.user.id === userId,
    time: TIMEOUT_MS,
  }));
  if (!interaction) {
    await finalize(sender, promptMsg, `${content}\n→ ⏰ ${TIMEOUT_MIN} 分鐘內無人回應，自動拒絕`);
    return { behavior: "deny", message: `${TIMEOUT_MIN} 分鐘內無人回應，自動拒絕 ${evt.tool}` };
  }

  const allowed = interaction.customId.startsWith("cr-ok-");
  await interaction.deferUpdate().catch(() => {});
  await finalize(sender, promptMsg, `${content}\n→ ${allowed ? "✅ 已允許" : "❌ 已拒絕"}`);
  log.info(`[cli-bridge-control] ${evt.tool} → ${allowed ? "allow" : "deny"}`);
  return allowed
    ? { behavior: "allow", updatedInput: evt.input }
    : { behavior: "deny", message: `使用者在 Discord 拒絕 ${evt.tool}` };
}
