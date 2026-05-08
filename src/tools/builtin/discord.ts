/**
 * @file tools/builtin/discord.ts
 * @description discord — Discord 操作 builtin tool（取代 mcp_catclaw-discord_discord）
 *
 * 直接走 Discord REST API，token 從 config.discord.token 動態取。
 * agent loop 主 process 內執行，無需 spawn child mcp server。
 *
 * Action 對齊 src/mcp/discord-server.ts。cli-bridge 仍走 mcp 版（獨立 botToken）。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../../core/config.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const API = "https://discord.com/api/v10";

// ── Discord REST ─────────────────────────────────────────────────────────────

async function discordFetch(token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "CatClaw/1.0",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return { ok: true };
  const data = await res.json() as unknown;
  if (!res.ok) throw new Error(`Discord ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

/**
 * 路徑正規化：file:// URI、Windows 雙 drive letter、leading slash 等 AI 常見錯誤輸入
 * （邏輯對齊 mcp/discord-server.ts:normalizeLocalPath）
 */
function normalizeLocalPath(rawPath: string): string {
  const winFileUri = /^file:\/\/\/?([A-Za-z]:)(.*)$/i.exec(rawPath);
  if (winFileUri) {
    try { return winFileUri[1] + decodeURIComponent(winFileUri[2]); }
    catch { return winFileUri[1] + winFileUri[2]; }
  }
  if (/^file:\/\//i.test(rawPath)) {
    try { return fileURLToPath(rawPath); }
    catch { return rawPath.replace(/^file:\/\/\/?/i, "/"); }
  }
  if (/^\/[A-Za-z]:[\\/]/.test(rawPath)) return rawPath.slice(1);
  return rawPath.replace(/^([A-Za-z]):[\\/](?=[A-Za-z]:[\\/])/, "");
}

function guessMimeType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "mp4": return "video/mp4";
    case "mov": return "video/quicktime";
    case "webm": return "video/webm";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "ogg": return "audio/ogg";
    case "pdf": return "application/pdf";
    case "json": return "application/json";
    case "txt": case "md": case "log": return "text/plain";
    case "html": case "htm": return "text/html";
    case "css": return "text/css";
    case "js": case "mjs": case "cjs": return "application/javascript";
    case "ts": case "tsx": return "application/typescript";
    case "zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

async function discordUpload(token: string, channelId: string, rawPath: string, content?: string): Promise<void> {
  const filePath = normalizeLocalPath(rawPath);
  const buf = readFileSync(filePath);
  const filename = filePath.replace(/\\/g, "/").split("/").pop() ?? "file";
  const mime = guessMimeType(filename);
  const form = new FormData();
  if (content) form.append("payload_json", JSON.stringify({ content }));
  form.append("files[0]", new Blob([buf], { type: mime }), filename);

  const headers = new Headers();
  headers.set("Authorization", `Bot ${token}`);
  headers.set("User-Agent", "CatClaw/1.0");

  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers,
    body: form,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`Discord upload ${res.status}: ${JSON.stringify(data)}`);
  }
}

// ── Param helpers ────────────────────────────────────────────────────────────

type P = Record<string, unknown>;

function str(p: P, key: string, required = false): string | undefined {
  const v = p[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (required) throw new Error(`缺少必要參數: ${key}`);
  return undefined;
}

function num(p: P, key: string): number | undefined {
  const v = p[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim()) return parseInt(v, 10);
  return undefined;
}

function strArr(p: P, key: string): string[] | undefined {
  const v = p[key];
  if (Array.isArray(v)) return v.map(String);
  return undefined;
}

function channelId(p: P): string {
  const id = str(p, "channelId") ?? str(p, "to")?.replace(/^channel:/, "");
  if (!id) throw new Error("缺少 channelId 或 to");
  return id;
}

function guildId(p: P): string {
  return str(p, "guildId", true)!;
}

// ── Action dispatcher ────────────────────────────────────────────────────────

async function runAction(token: string, p: P): Promise<string> {
  const action = str(p, "action", true)!;

  switch (action) {

    // Messaging ────────────────────────────────────────────────────────────────

    case "send": {
      const ch = channelId(p);
      if (p.media) {
        await discordUpload(token, ch, String(p.media), str(p, "message"));
        return "訊息 + 檔案已送出";
      }
      let text = str(p, "message") ?? "";
      const replyTo = str(p, "replyTo");
      while (text.length > 0) {
        const body: Record<string, unknown> = { content: text.slice(0, 2000) };
        if (replyTo && text === (str(p, "message") ?? "")) {
          body.message_reference = { message_id: replyTo };
        }
        await discordFetch(token, "POST", `/channels/${ch}/messages`, body);
        text = text.slice(2000);
      }
      return "訊息已送出";
    }

    case "read": {
      const ch = channelId(p);
      const limit = num(p, "limit") ?? 10;
      const before = str(p, "before");
      const after = str(p, "after");
      let qs = `limit=${limit}`;
      if (before) qs += `&before=${before}`;
      if (after) qs += `&after=${after}`;
      const msgs = await discordFetch(token, "GET", `/channels/${ch}/messages?${qs}`);
      return JSON.stringify(msgs);
    }

    case "fetchMessage": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      const msg = await discordFetch(token, "GET", `/channels/${ch}/messages/${msgId}`);
      return JSON.stringify(msg);
    }

    case "edit": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      await discordFetch(token, "PATCH", `/channels/${ch}/messages/${msgId}`, { content: str(p, "message") });
      return "訊息已編輯";
    }

    case "delete": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      await discordFetch(token, "DELETE", `/channels/${ch}/messages/${msgId}`);
      return "訊息已刪除";
    }

    case "react": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      const emoji = str(p, "emoji", true)!;
      const remove = p.remove === true;
      if (remove) {
        await discordFetch(token, "DELETE", `/channels/${ch}/messages/${msgId}/reactions/${encodeURIComponent(emoji)}/@me`);
        return "Reaction 已移除";
      }
      await discordFetch(token, "PUT", `/channels/${ch}/messages/${msgId}/reactions/${encodeURIComponent(emoji)}/@me`);
      return "Reaction 已加";
    }

    case "reactions": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      const emoji = str(p, "emoji", true)!;
      const limit = num(p, "limit") ?? 25;
      const users = await discordFetch(token, "GET", `/channels/${ch}/messages/${msgId}/reactions/${encodeURIComponent(emoji)}?limit=${limit}`);
      return JSON.stringify(users);
    }

    // Thread ──────────────────────────────────────────────────────────────────

    case "threadCreate": {
      const ch = channelId(p);
      const name = str(p, "name", true)!;
      const msgId = str(p, "messageId");
      const content = str(p, "message");
      const autoArchiveMinutes = num(p, "autoArchiveMinutes");

      if (msgId) {
        const r = await discordFetch(token, "POST", `/channels/${ch}/messages/${msgId}/threads`, {
          name,
          auto_archive_duration: autoArchiveMinutes ?? 1440,
        }) as { id: string };
        if (content) await discordFetch(token, "POST", `/channels/${r.id}/messages`, { content });
        return `Thread 建立完成（從訊息），ID: ${r.id}`;
      }
      const guideContent = content ?? `📌 ${name}`;
      const guideMsg = await discordFetch(token, "POST", `/channels/${ch}/messages`, {
        content: guideContent,
      }) as { id: string };
      const r = await discordFetch(token, "POST", `/channels/${ch}/messages/${guideMsg.id}/threads`, {
        name,
        auto_archive_duration: autoArchiveMinutes ?? 1440,
      }) as { id: string };
      return `Thread 建立完成(含主頻導引)，ID: ${r.id}`;
    }

    case "threadList": {
      const gid = guildId(p);
      const active = await discordFetch(token, "GET", `/guilds/${gid}/threads/active`);
      return JSON.stringify(active);
    }

    case "threadReply": {
      const ch = channelId(p);
      const content = str(p, "message", true)!;
      const replyTo = str(p, "replyTo");
      const body: Record<string, unknown> = { content };
      if (replyTo) body.message_reference = { message_id: replyTo };
      const msg = await discordFetch(token, "POST", `/channels/${ch}/messages`, body);
      return JSON.stringify(msg);
    }

    // Pin ─────────────────────────────────────────────────────────────────────

    case "pinMessage": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      await discordFetch(token, "PUT", `/channels/${ch}/pins/${msgId}`);
      return "訊息已釘選";
    }

    case "unpinMessage": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      await discordFetch(token, "DELETE", `/channels/${ch}/pins/${msgId}`);
      return "訊息已取消釘選";
    }

    case "listPins": {
      const ch = channelId(p);
      const pins = await discordFetch(token, "GET", `/channels/${ch}/pins`);
      return JSON.stringify(pins);
    }

    // Search ──────────────────────────────────────────────────────────────────

    case "searchMessages": {
      const gid = guildId(p);
      const content = str(p, "content", true)!;
      const ch = str(p, "channelId");
      const authorId = str(p, "authorId");
      const limit = num(p, "limit") ?? 25;
      let qs = `content=${encodeURIComponent(content)}&limit=${limit}`;
      if (ch) qs += `&channel_id=${ch}`;
      if (authorId) qs += `&author_id=${authorId}`;
      const results = await discordFetch(token, "GET", `/guilds/${gid}/messages/search?${qs}`);
      return JSON.stringify(results);
    }

    // Poll ────────────────────────────────────────────────────────────────────

    case "poll": {
      const ch = channelId(p);
      const question = str(p, "question", true)!;
      const answers = strArr(p, "answers");
      if (!answers?.length) throw new Error("poll 需要 answers 陣列");
      const durationHours = num(p, "durationHours") ?? 24;
      const allowMultiselect = p.allowMultiselect === true;
      const content = str(p, "message");
      const body: Record<string, unknown> = {
        poll: {
          question: { text: question },
          answers: answers.map(a => ({ poll_media: { text: a } })),
          duration: durationHours,
          allow_multiselect: allowMultiselect,
        },
      };
      if (content) body.content = content;
      await discordFetch(token, "POST", `/channels/${ch}/messages`, body);
      return "Poll 已建立";
    }

    // Guild ───────────────────────────────────────────────────────────────────

    case "memberInfo": {
      const gid = guildId(p);
      const userId = str(p, "userId", true)!;
      const member = await discordFetch(token, "GET", `/guilds/${gid}/members/${userId}`);
      return JSON.stringify(member);
    }

    case "roleInfo": {
      const gid = guildId(p);
      const roles = await discordFetch(token, "GET", `/guilds/${gid}/roles`);
      return JSON.stringify(roles);
    }

    case "roleAdd": {
      const gid = guildId(p);
      const userId = str(p, "userId", true)!;
      const roleId = str(p, "roleId", true)!;
      await discordFetch(token, "PUT", `/guilds/${gid}/members/${userId}/roles/${roleId}`);
      return "Role 已新增";
    }

    case "roleRemove": {
      const gid = guildId(p);
      const userId = str(p, "userId", true)!;
      const roleId = str(p, "roleId", true)!;
      await discordFetch(token, "DELETE", `/guilds/${gid}/members/${userId}/roles/${roleId}`);
      return "Role 已移除";
    }

    case "emojiList": {
      const gid = guildId(p);
      const emojis = await discordFetch(token, "GET", `/guilds/${gid}/emojis`);
      return JSON.stringify(emojis);
    }

    case "channelInfo": {
      const ch = channelId(p);
      const channel = await discordFetch(token, "GET", `/channels/${ch}`);
      return JSON.stringify(channel);
    }

    case "channelList": {
      const gid = guildId(p);
      const channels = await discordFetch(token, "GET", `/guilds/${gid}/channels`);
      return JSON.stringify(channels);
    }

    case "channelCreate": {
      const gid = guildId(p);
      const name = str(p, "name", true)!;
      const type = num(p, "type") ?? 0;
      const parentId = str(p, "parentId");
      const topic = str(p, "topic");
      const position = num(p, "position");
      const body: Record<string, unknown> = { name, type };
      if (parentId) body.parent_id = parentId;
      if (topic) body.topic = topic;
      if (position !== undefined) body.position = position;
      const channel = await discordFetch(token, "POST", `/guilds/${gid}/channels`, body);
      return JSON.stringify(channel);
    }

    case "channelEdit": {
      const ch = channelId(p);
      const body: Record<string, unknown> = {};
      const name = str(p, "name");
      const topic = str(p, "topic");
      const position = num(p, "position");
      const parentId = str(p, "parentId");
      const nsfw = p.nsfw;
      const rateLimitPerUser = num(p, "rateLimitPerUser");
      const archived = p.archived;
      const locked = p.locked;
      const autoArchiveDuration = num(p, "autoArchiveDuration");
      if (name) body.name = name;
      if (topic !== undefined) body.topic = topic;
      if (position !== undefined) body.position = position;
      if (parentId !== undefined) body.parent_id = parentId;
      if (typeof nsfw === "boolean") body.nsfw = nsfw;
      if (rateLimitPerUser !== undefined) body.rate_limit_per_user = rateLimitPerUser;
      if (typeof archived === "boolean") body.archived = archived;
      if (typeof locked === "boolean") body.locked = locked;
      if (autoArchiveDuration !== undefined) body.auto_archive_duration = autoArchiveDuration;
      const channel = await discordFetch(token, "PATCH", `/channels/${ch}`, body);
      return JSON.stringify(channel);
    }

    case "channelDelete": {
      const ch = channelId(p);
      await discordFetch(token, "DELETE", `/channels/${ch}`);
      return "Channel 已刪除";
    }

    case "channelMove": {
      const gid = guildId(p);
      const ch = str(p, "channelId", true)!;
      const parentId = str(p, "parentId");
      const position = num(p, "position");
      const body: Record<string, unknown> = { id: ch };
      if (parentId !== undefined) body.parent_id = parentId;
      if (position !== undefined) body.position = position;
      await discordFetch(token, "PATCH", `/guilds/${gid}/channels`, [body]);
      return "Channel 已移動";
    }

    case "categoryCreate": {
      const gid = guildId(p);
      const name = str(p, "name", true)!;
      const position = num(p, "position");
      const body: Record<string, unknown> = { name, type: 4 };
      if (position !== undefined) body.position = position;
      const category = await discordFetch(token, "POST", `/guilds/${gid}/channels`, body);
      return JSON.stringify(category);
    }

    case "categoryEdit": {
      const catId = str(p, "categoryId", true)!;
      const body: Record<string, unknown> = {};
      const name = str(p, "name");
      const position = num(p, "position");
      if (name) body.name = name;
      if (position !== undefined) body.position = position;
      const category = await discordFetch(token, "PATCH", `/channels/${catId}`, body);
      return JSON.stringify(category);
    }

    case "categoryDelete": {
      const catId = str(p, "categoryId", true)!;
      await discordFetch(token, "DELETE", `/channels/${catId}`);
      return "Category 已刪除";
    }

    case "channelPermissionSet": {
      const ch = channelId(p);
      const targetId = str(p, "targetId", true)!;
      const targetType = str(p, "targetType") === "member" ? 1 : 0;
      const allow = str(p, "allow");
      const deny = str(p, "deny");
      await discordFetch(token, "PUT", `/channels/${ch}/permissions/${targetId}`, {
        type: targetType,
        allow: allow ?? "0",
        deny: deny ?? "0",
      });
      return "權限已設定";
    }

    case "channelPermissionRemove": {
      const ch = channelId(p);
      const targetId = str(p, "targetId", true)!;
      await discordFetch(token, "DELETE", `/channels/${ch}/permissions/${targetId}`);
      return "權限已移除";
    }

    case "eventList": {
      const gid = guildId(p);
      const events = await discordFetch(token, "GET", `/guilds/${gid}/scheduled-events`);
      return JSON.stringify(events);
    }

    case "eventCreate": {
      const gid = guildId(p);
      const name = str(p, "name", true)!;
      const startTime = str(p, "startTime", true)!;
      const endTime = str(p, "endTime");
      const description = str(p, "description");
      const ch = str(p, "channelId");
      const location = str(p, "location");
      const entityTypeRaw = str(p, "entityType");
      const entityType = entityTypeRaw === "stage" ? 1 : entityTypeRaw === "external" ? 3 : 2;
      const body: Record<string, unknown> = {
        name,
        scheduled_start_time: startTime,
        entity_type: entityType,
        privacy_level: 2,
      };
      if (description) body.description = description;
      if (endTime) body.scheduled_end_time = endTime;
      if (ch) body.channel_id = ch;
      if (entityType === 3 && location) body.entity_metadata = { location };
      const event = await discordFetch(token, "POST", `/guilds/${gid}/scheduled-events`, body);
      return JSON.stringify(event);
    }

    // Moderation ──────────────────────────────────────────────────────────────

    case "timeout": {
      const gid = guildId(p);
      const userId = str(p, "userId", true)!;
      const durationMinutes = num(p, "durationMinutes");
      let until: string | null = null;
      if (durationMinutes && durationMinutes > 0) {
        until = new Date(Date.now() + durationMinutes * 60_000).toISOString();
      }
      await discordFetch(token, "PATCH", `/guilds/${gid}/members/${userId}`, {
        communication_disabled_until: until,
      });
      return until ? `使用者已禁言至 ${until}` : "禁言已解除";
    }

    case "kick": {
      const gid = guildId(p);
      const userId = str(p, "userId", true)!;
      const reason = str(p, "reason");
      const qs = reason ? `?reason=${encodeURIComponent(reason)}` : "";
      await discordFetch(token, "DELETE", `/guilds/${gid}/members/${userId}${qs}`);
      return "使用者已被踢出";
    }

    case "ban": {
      const gid = guildId(p);
      const userId = str(p, "userId", true)!;
      const reason = str(p, "reason");
      const deleteMessageDays = num(p, "deleteMessageDays");
      const body: Record<string, unknown> = {};
      if (deleteMessageDays) body.delete_message_days = deleteMessageDays;
      const qs = reason ? `?reason=${encodeURIComponent(reason)}` : "";
      await discordFetch(token, "PUT", `/guilds/${gid}/bans/${userId}${qs}`, body);
      return "使用者已被封禁";
    }

    default:
      throw new Error(`不支援的 action: ${action}`);
  }
}

// ── Tool 定義 ────────────────────────────────────────────────────────────────

const ALL_ACTIONS = [
  // Messaging
  "send", "read", "fetchMessage", "edit", "delete",
  "react", "reactions",
  "threadCreate", "threadList", "threadReply",
  "pinMessage", "unpinMessage", "listPins",
  "searchMessages", "poll",
  // Guild
  "memberInfo", "roleInfo", "roleAdd", "roleRemove",
  "emojiList",
  "channelInfo", "channelList", "channelCreate", "channelEdit", "channelDelete", "channelMove",
  "categoryCreate", "categoryEdit", "categoryDelete",
  "channelPermissionSet", "channelPermissionRemove",
  "eventList", "eventCreate",
  // Moderation
  "timeout", "kick", "ban",
];

export const tool: Tool = {
  name: "discord",
  description: [
    "Discord 操作（agent loop 內建版，直接走 REST API，無 child process）。",
    "Messaging: send/read/fetchMessage/edit/delete/react/reactions/threadCreate/threadList/threadReply/pinMessage/unpinMessage/listPins/searchMessages/poll",
    "Guild: memberInfo/roleInfo/roleAdd/roleRemove/emojiList/channelInfo/channelList/channelCreate/channelEdit/channelDelete/channelMove/categoryCreate/categoryEdit/categoryDelete/channelPermissionSet/channelPermissionRemove/eventList/eventCreate",
    "Moderation: timeout/kick/ban",
    "與 mcp_catclaw-discord_discord 等價但更輕量；cli-bridge 仍走 mcp 版（獨立 botToken）。",
  ].join("\n"),
  tier: "public",
  deferred: true,
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ALL_ACTIONS, description: "要執行的操作" },
      // Common
      channelId: { type: "string", description: "頻道 ID" },
      to: { type: "string", description: "channel:<id>（channelId 的替代寫法）" },
      guildId: { type: "string", description: "伺服器 ID（guild action 必填）" },
      messageId: { type: "string", description: "訊息 ID" },
      message: { type: "string", description: "訊息內容" },
      // Messaging
      media: { type: "string", description: "file:///path/to/file（附件）" },
      replyTo: { type: "string", description: "回覆目標訊息 ID" },
      emoji: { type: "string", description: "Emoji（react/reactions 用）" },
      remove: { type: "boolean", description: "移除 reaction（react 用）" },
      limit: { type: "number", description: "筆數上限" },
      before: { type: "string", description: "在此訊息 ID 之前（read 分頁）" },
      after: { type: "string", description: "在此訊息 ID 之後（read 分頁）" },
      // Thread
      name: { type: "string", description: "名稱（thread/channel/category/event/emoji）" },
      autoArchiveMinutes: { type: "number", description: "Thread 自動封存分鐘數" },
      // Pin / Search
      content: { type: "string", description: "搜尋內容（searchMessages 用）" },
      authorId: { type: "string", description: "作者 ID（searchMessages 用）" },
      // Poll
      question: { type: "string", description: "投票問題" },
      answers: { type: "array", items: { type: "string" }, description: "投票選項" },
      durationHours: { type: "number", description: "投票持續時數" },
      allowMultiselect: { type: "boolean", description: "允許多選" },
      // Guild
      userId: { type: "string", description: "使用者 ID" },
      roleId: { type: "string", description: "角色 ID" },
      type: { type: "number", description: "頻道類型（0=text, 2=voice, 4=category, 13=stage, 15=forum）" },
      parentId: { type: "string", description: "父分類 ID" },
      topic: { type: "string", description: "頻道主題" },
      position: { type: "number", description: "排序位置" },
      nsfw: { type: "boolean", description: "NSFW 標記" },
      rateLimitPerUser: { type: "number", description: "慢速模式秒數" },
      archived: { type: "boolean", description: "封存狀態" },
      locked: { type: "boolean", description: "鎖定狀態" },
      autoArchiveDuration: { type: "number", description: "自動封存時間（分鐘）" },
      categoryId: { type: "string", description: "分類 ID（categoryEdit/Delete 用）" },
      // Permission
      targetId: { type: "string", description: "權限目標 ID（role 或 member）" },
      targetType: { type: "string", enum: ["role", "member"], description: "權限目標類型" },
      allow: { type: "string", description: "允許的權限位元（bitfield）" },
      deny: { type: "string", description: "拒絕的權限位元（bitfield）" },
      // Event
      startTime: { type: "string", description: "開始時間 ISO 8601" },
      endTime: { type: "string", description: "結束時間 ISO 8601" },
      description: { type: "string", description: "描述" },
      location: { type: "string", description: "地點（external event 用）" },
      entityType: { type: "string", enum: ["voice", "stage", "external"], description: "活動類型" },
      // Moderation
      durationMinutes: { type: "number", description: "禁言時長（分鐘），0=解除" },
      reason: { type: "string", description: "原因（moderation audit log）" },
      deleteMessageDays: { type: "number", description: "刪除訊息天數（ban 用）" },
    },
    required: ["action"],
  },

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const token = config?.discord?.token;
    if (!token) return { error: "config.discord.token 未設定" };
    try {
      const text = await runAction(token, params);
      return { result: text };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
};
