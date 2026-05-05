import http from "node:http";

import {
  Client,
  Events,
  PermissionFlagsBits as PermissionFlags,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ApplicationCommandOptionType,
  MessageFlags,
  ComponentType
} from "discord.js";

function parseUserMention(text) {
  const match = text.match(/^<@!?(\d+)>$/);
  return match ? match[1] : null;
}

const pendingReactionRolePanels = new Map();

import { loadConfig } from "./utilities/config.js";
import { BotDatabase } from "./admin/database.js";
import { PrismaBotDatabase } from "./admin/database-prisma.js";
import { createAdminCommandHandlers } from "./admin/commands.js";
import {
  normalizeEmojiInput,
  emojiKeyCandidatesFromGatewayEmoji,
  emojiRouteTokenFromNormalized
} from "./utilities/emoji.js";
import { createModerationCommandHandlers } from "./moderation/commands.js";
import { RaidMlClient } from "./moderation/raidMlClient.js";
import { RaidRiskEngine, SpamRiskEngine, snowflakeToDate } from "./moderation/riskSignals.js";
import { createUtilityCommandHandlers } from "./utilities/commands.js";

import { renderWelcomeCardImage } from "./utilities/welcome-card-image.js";
import { WordStore } from "./moderation/words.js";

const config = loadConfig();

async function createDatabaseRuntime(configValue) {
  if (configValue.databaseDriver === "sqlite") {
    return new BotDatabase(configValue.databasePath);
  }

  const prismaDb = new PrismaBotDatabase();
  await prismaDb.ensureInitialized();
  return prismaDb;
}

const db = await createDatabaseRuntime(config);
const riskEngine = new RaidRiskEngine(config.raidMl);
const spamEngine = new SpamRiskEngine(config.automod);
const wordStore = new WordStore(config.wordsJsonPath);
const aiLastUsedByUser = new Map();

wordStore.load();

const clientIntents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessageReactions
];

if (config.discordIntents?.guildMembers) {
  clientIntents.push(GatewayIntentBits.GuildMembers);
}

if (config.discordIntents?.messageContent) {
  clientIntents.push(GatewayIntentBits.MessageContent);
}

const client = new Client({ 
  intents: clientIntents,
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});



const SLASH_SYNC_GUILD_ID = "1499796427562549440";

const raidMlClient = new RaidMlClient(config.raidMl, () => {});
const raidMlHealthState = {
  online: null,
  monitorHandle: null
};

const RAID_LOCKDOWN_DURATION_MS = 60 * 60 * 1000;
const RAID_STATE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const raidProtectionMonitorState = {
  monitorHandle: null
};

// Performance: In-memory cache for guild configs with 5 minute TTL
const guildConfigCache = new Map();
const GUILD_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

async function getCachedGuildConfig(guildId) {
  const cached = guildConfigCache.get(guildId);
  if (cached && Date.now() - cached.timestamp < GUILD_CONFIG_CACHE_TTL_MS) {
    return cached.config;
  }
  const config = await db.getGuildConfig(guildId);
  guildConfigCache.set(guildId, { config, timestamp: Date.now() });
  return config;
}

function buildReactionRolePanelEmbed({ title, content, emojiDisplay, roleMention }) {
  const embed = new EmbedBuilder()
    .setTitle(String(title || "Reaction Role Panel").trim() || "Reaction Role Panel")
    .setDescription(String(content || "Click the reaction below to claim the role.").trim() || "Click the reaction below to claim the role.")
    .setColor(0x5865f2);

  if (emojiDisplay && roleMention) {
    embed.addFields({
      name: "How to claim:",
      value: `React with ${String(emojiDisplay).trim()} to get ${String(roleMention).trim()}`,
      inline: false
    });
  }

  embed.setFooter({
    text: "React to get the role • Remove your reaction to lose the role"
  });

  return embed;
}

async function updateRaidMlHealthState({ startup = false } = {}) {
  if (!raidMlClient.enabled) {
    return false;
  }

  const previousOnline = raidMlHealthState.online;
  const currentOnline = await raidMlClient.checkHealth();
  raidMlHealthState.online = currentOnline;
  return currentOnline;
}

function startRaidMlHealthMonitor() {
  if (!raidMlClient.enabled || raidMlHealthState.monitorHandle) {
    return;
  }

  const intervalMs = Math.max(2000, Number(config.raidMl.healthCheckIntervalMs || 10000));
  raidMlHealthState.monitorHandle = setInterval(() => {
    updateRaidMlHealthState().catch(() => {});
  }, intervalMs);
}

function formatUserMention(userId) {
  return `<@${userId}>`;
}

function parseSnowflake(value) {
  const text = String(value ?? "").trim();
  return /^\d{5,22}$/.test(text) ? text : null;
}

function parseUserIdArg(arg) {
  const text = String(arg ?? "").trim();
  if (!text) {
    return null;
  }

  const fromMention = parseUserMention(text);
  if (fromMention) {
    return fromMention;
  }

  const cleaned = text.replace(/[<@!>]/g, "");
  return parseSnowflake(cleaned);
}

function canManageTargetRole(actorMember, targetMember, guild) {
  if (!actorMember || !targetMember) {
    return false;
  }

  const actorId = String(actorMember?.user?.id || actorMember?.id || "").trim();
  if (guild && String(guild.ownerId || "") === actorId) {
    return true;
  }

  if (actorMember?.permissions?.has?.(PermissionFlags.Administrator)) {
    return true;
  }

  const actorRole = actorMember.roles?.highest;
  const targetRole = targetMember.roles?.highest;
  if (!actorRole || !targetRole) {
    return false;
  }

  return actorRole.comparePositionTo(targetRole) > 0;
}

function toIsoSeconds(date) {
  const rounded = new Date(Math.floor(date.getTime() / 1000) * 1000);
  return rounded.toISOString().replace(".000Z", "Z");
}

function getEveryoneRoleId(guild) {
  return String(guild?.roles?.everyone?.id || guild?.id || "").trim();
}

function serializePermissionOverwrite(overwrite) {
  return {
    id: String(overwrite?.id || "").trim(),
    type: overwrite?.type,
    allow: String(overwrite?.allow?.bitfield ?? 0),
    deny: String(overwrite?.deny?.bitfield ?? 0)
  };
}

function deserializePermissionOverwrite(entry) {
  return {
    id: String(entry?.id || "").trim(),
    type: entry?.type,
    allow: String(entry?.allow ?? 0),
    deny: String(entry?.deny ?? 0)
  };
}

function buildRaidLockdownDenyPermissions() {
  return {
    SendMessages: true,
    SendMessagesInThreads: true,
    CreatePublicThreads: true,
    CreatePrivateThreads: true,
    AddReactions: true,
    AttachFiles: true,
    EmbedLinks: true,
    CreateInstantInvite: true,
    ManageChannels: true
  };
}

function parseRaidStateTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

async function getEffectiveRaidLockdownState(guildId, resolvedGuild = null) {
  const state = await db.getRaidLockdownState(guildId);
  if (!state.lockdown_active || !state.lockdown_until) {
    return state;
  }

  const lockdownUntilMs = parseRaidStateTimestamp(state.lockdown_until);
  if (!Number.isFinite(lockdownUntilMs)) {
    return state;
  }

  if (Date.now() < lockdownUntilMs) {
    return state;
  }

  const guild = resolvedGuild || (await resolveClientGuild(guildId).catch(() => null));
  if (guild) {
    await releaseRaidLockdown(guild, state, "Lockdown expired");
  } else {
    await db.setRaidLockdownState(guildId, false, "Lockdown expired", null, null);
  }

  return {
    lockdown_active: false,
    lockdown_reason: "Lockdown expired",
    lockdown_until: null,
    lockdown_snapshot: null,
    lockdown_updated_at: new Date().toISOString()
  };
}

async function buildRaidLockdownSnapshot(guild) {
  const channels = [];

  for (const channel of guild?.channels?.cache?.values?.() || []) {
    if (!channel || typeof channel.permissionOverwrites?.cache?.map !== "function") {
      continue;
    }

    if (!(channel.isTextBased?.() || channel.isThread?.())) {
      continue;
    }

    const overwrites = channel.permissionOverwrites.cache.map((overwrite) => serializePermissionOverwrite(overwrite));
    channels.push({
      channel_id: String(channel.id || "").trim(),
      overwrites
    });
  }

  return JSON.stringify({
    guild_id: String(guild?.id || "").trim(),
    captured_at: new Date().toISOString(),
    channels
  });
}

async function applyRaidLockdown(guild, reason, lockdownUntil) {
  const guildId = String(guild?.id || "").trim();
  if (!guildId) {
    return false;
  }

  const currentState = await db.getRaidLockdownState(guildId);
  if (currentState.lockdown_active && currentState.lockdown_until) {
    const existingUntilMs = parseRaidStateTimestamp(currentState.lockdown_until);
    if (Number.isFinite(existingUntilMs) && existingUntilMs > Date.now()) {
      return false;
    }
  }

  const snapshot = await buildRaidLockdownSnapshot(guild);
  const everyoneRoleId = getEveryoneRoleId(guild);
  const denyPermissions = buildRaidLockdownDenyPermissions();
  let updatedChannelCount = 0;

  for (const channel of guild?.channels?.cache?.values?.() || []) {
    if (!channel || typeof channel.permissionOverwrites?.edit !== "function") {
      continue;
    }

    if (!(channel.isTextBased?.() || channel.isThread?.())) {
      continue;
    }

    try {
      await channel.permissionOverwrites.edit(everyoneRoleId, denyPermissions, {
        reason: sanitizeReason(reason || "Automatic raid lockdown")
      });
      updatedChannelCount += 1;
    } catch (error) {}
  }

  let inviteCount = 0;
  try {
    const invites = await guild.invites.fetch();
    inviteCount = invites?.size || 0;
    for (const invite of invites.values()) {
      try {
        await invite.delete(sanitizeReason(reason || "Automatic raid lockdown"));
      } catch (error) {}
    }
  } catch (error) {}

  await db.setRaidLockdownState(guildId, true, reason, lockdownUntil, snapshot);
  await db.logModerationAction({
    guildId,
    action: "raid_lockdown_enable",
    actorUserId: client.user?.id ?? null,
    reason,
    metadata: {
      lockdown_until: lockdownUntil,
      updated_channel_count: updatedChannelCount,
      deleted_invite_count: inviteCount
    }
  });

  return true;
}

async function releaseRaidLockdown(guild, state = null, reason = "Lockdown expired") {
  const guildId = String(guild?.id || "").trim();
  if (!guildId) {
    return false;
  }

  const lockdownState = state || (await db.getRaidLockdownState(guildId));
  if (!lockdownState.lockdown_active && !lockdownState.lockdown_snapshot) {
    return false;
  }

  let snapshot = null;
  try {
    snapshot = lockdownState.lockdown_snapshot ? JSON.parse(lockdownState.lockdown_snapshot) : null;
  } catch (error) {}

  let restoredChannelCount = 0;
  for (const channelState of snapshot?.channels || []) {
    const channelId = String(channelState?.channel_id || "").trim();
    if (!channelId) {
      continue;
    }

    let channel = guild.channels?.cache?.get(channelId) || null;
    if (!channel && typeof guild.channels?.fetch === "function") {
      try {
        channel = await guild.channels.fetch(channelId);
      } catch {
        channel = null;
      }
    }

    if (!channel || typeof channel.permissionOverwrites?.set !== "function") {
      continue;
    }

    try {
      await channel.permissionOverwrites.set(
        (Array.isArray(channelState?.overwrites) ? channelState.overwrites : []).map((entry) => deserializePermissionOverwrite(entry)),
        sanitizeReason(reason || "Raid lockdown lifted")
      );
      restoredChannelCount += 1;
    } catch (error) {}
  }

  await db.setRaidLockdownState(guildId, false, reason, null, null);
  await db.logModerationAction({
    guildId,
    action: "raid_lockdown_disable",
    actorUserId: client.user?.id ?? null,
    reason,
    metadata: {
      restored_channel_count: restoredChannelCount
    }
  });

  return true;
}

async function sweepRaidProtectionState(guildId, resolvedGuild = null) {
  const gateState = await getEffectiveGateState(guildId);
  const lockdownState = await getEffectiveRaidLockdownState(guildId, resolvedGuild);
  return { gateState, lockdownState };
}

async function startRaidProtectionMonitor() {
  if (raidProtectionMonitorState.monitorHandle) {
    return;
  }

  const sweep = async () => {
    try {
      const guildIds = await db.listKnownGuildIds(1000);
      for (const guildId of guildIds) {
        const guild = await resolveClientGuild(guildId).catch(() => null);
        await sweepRaidProtectionState(guildId, guild);
      }
    } catch (error) {}
  };

  await sweep();
  raidProtectionMonitorState.monitorHandle = setInterval(() => {
    sweep().catch(() => {});
  }, RAID_STATE_SWEEP_INTERVAL_MS);
}

function sanitizeReason(reason, maxLength = 180) {
  const cleaned = String(reason ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatWarningCounter(warningCount, maxWarnings) {
  const current = Math.max(0, Number(warningCount || 0));
  const max = Math.max(1, Number(maxWarnings || 1));

  if (current <= max) {
    return `warning ${current}/${max}.`;
  }

  return `warning threshold exceeded (${current} total, limit ${max}).`;
}

function formatWarningThresholdDetail(warningCount, maxWarnings) {
  const current = Math.max(0, Number(warningCount || 0));
  const max = Math.max(1, Number(maxWarnings || 1));

  if (current <= max) {
    return `${current}/${max}`;
  }

  return `${current} total, limit ${max}`;
}

function parsePrefixedCommand(messageContent) {
  const content = String(messageContent ?? "");
  const prefix = config.prefixes.find((entry) => content.startsWith(entry));
  if (!prefix) {
    return null;
  }

  const body = content.slice(prefix.length).trim();
  if (!body) {
    return null;
  }

  const parts = body.split(/\s+/);
  const command = String(parts.shift() || "").toLowerCase();

  return {
    prefix,
    body,
    command,
    args: parts
  };
}

function randomIntegerInRange(min, max) {
  const lower = Math.floor(Math.min(min, max));
  const upper = Math.floor(Math.max(min, max));
  if (lower === upper) {
    return lower;
  }

  return lower + Math.floor(Math.random() * (upper - lower + 1));
}

function formatInteger(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return "0";
  }

  return Math.trunc(numeric).toLocaleString("en-US");
}

function buildProgressBar(current, total, size = 16) {
  const normalizedTotal = Math.max(1, Number(total || 1));
  const normalizedCurrent = Math.max(0, Math.min(Number(current || 0), normalizedTotal));
  const filled = Math.round((normalizedCurrent / normalizedTotal) * size);
  const clampedFilled = Math.max(0, Math.min(filled, size));
  return `${"=".repeat(clampedFilled)}${".".repeat(size - clampedFilled)}`;
}

const NON_TOGGLEABLE_COMMANDS = new Set(["help"]);
const WELCOME_CARD_IMAGE_FILE = "welcome-card.png";

const TICKET_PERMISSION_BITS = {
  viewChannel: 1024n,
  sendMessages: 2048n,
  embedLinks: 16384n,
  attachFiles: 32768n,
  readMessageHistory: 65536n
};

const TICKET_ALLOW_MASK =
  TICKET_PERMISSION_BITS.viewChannel |
  TICKET_PERMISSION_BITS.sendMessages |
  TICKET_PERMISSION_BITS.embedLinks |
  TICKET_PERMISSION_BITS.attachFiles |
  TICKET_PERMISSION_BITS.readMessageHistory;

function resolveAvatarUrl(userLike) {
  if (!userLike || typeof userLike !== "object") {
    return null;
  }

  try {
    if (typeof userLike.displayAvatarURL === "function") {
      return String(userLike.displayAvatarURL({ extension: "png", size: 256 }));
    }
  } catch {
    // Best effort.
  }

  try {
    if (typeof userLike.avatarURL === "function") {
      return String(userLike.avatarURL({ extension: "png", size: 256 }));
    }
  } catch {
    // Best effort.
  }

  if (typeof userLike.avatarUrl === "string" && userLike.avatarUrl.trim()) {
    return userLike.avatarUrl.trim();
  }

  const userId = String(userLike.id || "").trim();
  const avatarHash = String(userLike.avatar || "").trim();
  if (userId && avatarHash) {
    const extension = avatarHash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${extension}?size=256`;
  }

  return null;
}

function sanitizeChannelNameFragment(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-\s_]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!text) {
    return "member";
  }

  return text.slice(0, 30);
}

function buildTicketChannelName(member, userId) {
  const sourceName =
    member?.displayName ||
    member?.nick ||
    member?.user?.globalName ||
    member?.user?.displayName ||
    member?.user?.username ||
    `user-${String(userId || "").slice(-4)}`;

  const clean = sanitizeChannelNameFragment(sourceName);
  const suffix = String(userId || "").slice(-4);
  return suffix ? `ticket-${clean}-${suffix}` : `ticket-${clean}`;
}

function buildTicketPermissionOverwrites({ guildId, userId, supportRoleId }) {
  const overwrites = [
    {
      id: guildId,
      type: 0,
      allow: "0",
      deny: String(TICKET_PERMISSION_BITS.viewChannel)
    },
    {
      id: userId,
      type: 1,
      allow: String(TICKET_ALLOW_MASK),
      deny: "0"
    }
  ];

  const roleId = parseSnowflake(supportRoleId);
  if (roleId) {
    overwrites.push({
      id: roleId,
      type: 0,
      allow: String(TICKET_ALLOW_MASK),
      deny: "0"
    });
  }

  return overwrites;
}

function emojiMatchesStoredTrigger(storedEmoji, gatewayEmoji) {
  const configured = String(storedEmoji || "").trim();
  if (!configured) {
    return false;
  }

  let normalized = null;
  try {
    normalized = normalizeEmojiInput(configured);
  } catch {
    return false;
  }

  const candidates = emojiKeyCandidatesFromGatewayEmoji(gatewayEmoji);
  if (candidates.length === 0) {
    return false;
  }

  const expected = new Set([String(normalized.key || "").trim(), String(normalized.display || "").trim()]);
  if (Array.isArray(normalized.aliases)) {
    for (const alias of normalized.aliases) {
      expected.add(String(alias || "").trim());
    }
  }

  for (const candidate of candidates) {
    if (expected.has(String(candidate || "").trim())) {
      return true;
    }
  }

  return false;
}

async function createTicketChannel({ guild, guildId, name, parentId, topic, permissionOverwrites }) {
  if (guild?.channels && typeof guild.channels.create === "function") {
    try {
      const created = await guild.channels.create({
        name,
        type: 0,
        parentId: parentId || undefined,
        topic,
        permissionOverwrites
      });

      if (created?.id) {
        return created;
      }
    } catch {
      // Fall back to direct REST create.
    }
  }

  const body = {
    name,
    type: 0,
    topic,
    permission_overwrites: Array.isArray(permissionOverwrites) ? permissionOverwrites : undefined,
    parent_id: parentId || undefined
  };

  return client.rest.post(`/guilds/${guildId}/channels`, { auth: true, body });
}

function renderMessageTemplate(template, values = {}) {
  const source = String(template || "");
  if (!source.trim()) {
    return "";
  }

  return source.replace(/\{([a-z0-9_.-]+)\}/gi, (full, token) => {
    const key = String(token || "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      return full;
    }

    const replacement = values[key];
    return replacement == null ? "" : String(replacement);
  });
}

const EMBED_COLORS = {
  info: 0x1f6feb,
  success: 0x2ea043,
  warning: 0xd29922,
  error: 0xf85149
};

function truncateText(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function buildEmbedPayload(description, options = {}) {
  const title = options.title ? truncateText(options.title, 256) : undefined;
  const kind = options.kind && EMBED_COLORS[options.kind] ? options.kind : "info";

  return {
    embeds: [
      {
        title,
        description: truncateText(description || "No content.", 4096),
        color: EMBED_COLORS[kind],
        timestamp: new Date().toISOString(),
        thumbnail: options.thumbnail ? { url: options.thumbnail } : undefined
      }
    ]
  };
}

function normalizeRoleMentionIds(options = {}) {
  const ids = [];
  const seen = new Set();

  const push = (value) => {
    const id = parseSnowflake(value);
    if (!id || seen.has(id)) {
      return;
    }

    seen.add(id);
    ids.push(id);
  };

  push(options.roleId);

  if (Array.isArray(options.roleIds)) {
    for (const roleId of options.roleIds) {
      push(roleId);
    }
  }

  return ids;
}

function buildReplyContextLines(message, options = {}) {
  if (options.includeContext !== true) {
    return [];
  }

  const lines = [];
  const userId = parseSnowflake(options.userId || message?.author?.id || message?.user?.id);
  const channelId = parseSnowflake(options.channelId || message?.channelId || message?.channel?.id);
  const guildId = parseSnowflake(options.guildId || message?.guildId || message?.guild?.id);
  const messageId = parseSnowflake(options.messageId || message?.id);
  const roleIds = normalizeRoleMentionIds(options);

  if (userId) {
    lines.push(`user: <@${userId}>`);
  }

  if (channelId) {
    lines.push(`channel: <#${channelId}>`);
  }

  if (guildId && channelId && messageId) {
    // Use Discord-native jump link instead of an external link
    lines.push(`message: https://discord.com/channels/${guildId}/${channelId}/${messageId}`);
  } else if (messageId) {
    lines.push(`message_id: ${messageId}`);
  }

  if (roleIds.length > 0) {
    lines.push(`role: ${roleIds.map((id) => `<@&${id}>`).join(", ")}`);
  }

  return lines;
}

function appendContextToEmbedPayload(payload, message, options = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.embeds) || payload.embeds.length === 0) {
    return payload;
  }

  const contextLines = buildReplyContextLines(message, options);
  if (contextLines.length === 0) {
    return payload;
  }

  const firstEmbed = payload.embeds[0] || {};
  const baseDescription = String(firstEmbed.description || "No content.").trim();
  const contextBlock = contextLines.join("\n");

  payload.embeds[0] = {
    ...firstEmbed,
    description: truncateText(`${baseDescription}\n\n${contextBlock}`, 4096)
  };

  return payload;
}

function stripReplyMetadata(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const { message_reference, messageReference, reply, ...cloned } = payload;
  return cloned;
}

function toReplyPayload(content, options = {}) {
  if (content && typeof content === "object") {
    return content;
  }

  return buildEmbedPayload(String(content ?? ""), options);
}

function isUnknownMessageError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  if (String(error.code || "").toUpperCase() === "UNKNOWN_MESSAGE") {
    return true;
  }

  const statusCode = Number(error.statusCode || 0);
  const message = String(error.message || "").toLowerCase();
  return statusCode === 404 && message.includes("message wasn't found");
}

async function resolveReplyChannel(message) {
  if (message?.channel && typeof message.channel.send === "function") {
    return message.channel;
  }

  if (message?.channelId) {
    try {
      const channel = await resolveClientChannel(message.channelId);
      if (channel && typeof channel.send === "function") {
        return channel;
      }
    } catch {
      // Ignore channel resolve errors and continue with best effort fallbacks.
    }
  }

  if (typeof message?.send === "function") {
    return message;
  }

  return null;
}

function scheduleMessageDeletion(sentMessage, deleteAfterMs) {
  const delayMs = Math.floor(Number(deleteAfterMs || 0));
  if (!sentMessage || typeof sentMessage.delete !== "function" || !Number.isFinite(delayMs) || delayMs <= 0) {
    return;
  }

  const timer = setTimeout(() => {
    Promise.resolve(sentMessage.delete()).catch(() => {
      // Best effort auto-delete.
    });
  }, delayMs);

  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

function waitFor(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Math.floor(Number(ms || 0))));
  });
}

function getHttpStatusCode(error) {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  return Number.isFinite(statusCode) ? statusCode : 0;
}

function normalizeRetryAfterMs(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  // Retry-After is normally seconds; some clients expose milliseconds.
  return numeric <= 60 ? Math.floor(numeric * 1000) : Math.floor(numeric);
}

function getRetryAfterMs(error) {
  const fromField = normalizeRetryAfterMs(error?.retryAfter ?? error?.retry_after);
  if (fromField > 0) {
    return fromField;
  }

  const headers = error?.headers || error?.response?.headers;
  if (!headers || typeof headers !== "object") {
    return 0;
  }

  return normalizeRetryAfterMs(headers["retry-after"] ?? headers["Retry-After"]);
}

function isTransientSendError(error) {
  const statusCode = getHttpStatusCode(error);
  return statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

function computeRetryDelayMs(error, attemptNumber) {
  const exponentialBase = 300 * Math.pow(2, Math.max(0, Number(attemptNumber || 1) - 1));
  const retryAfterMs = getRetryAfterMs(error);
  const jitterMs = Math.floor(Math.random() * 120);
  return Math.min(2500, Math.max(exponentialBase, retryAfterMs) + jitterMs);
}

async function sendWithRetry(sendFn, { label = "message send", maxAttempts = 2 } = {}) {
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;

    try {
      return await sendFn();
    } catch (error) {
      if (!isTransientSendError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const delayMs = computeRetryDelayMs(error, attempt);
      const statusCode = getHttpStatusCode(error);
      await waitFor(delayMs);
    }
  }

  return null;
}

async function safeReply(message, content, options = {}) {
  const replyPayload = appendContextToEmbedPayload(toReplyPayload(content, options), message, options);
  const channelPayload = stripReplyMetadata(replyPayload);
  const autoDeleteMs = options?.deleteAfterMs;
  const forceChannelSend = options?.forceChannelSend === true;

  const sendChannelMessage = async (payload, label) => {
    const channel = await resolveReplyChannel(message);
    if (!channel || typeof channel.send !== "function") {
      return null;
    }

    return sendWithRetry(
      () => channel.send({ ...payload, allowedMentions: payload.allowedMentions || { parse: [] } }),
      {
        label,
        maxAttempts: 2
      }
    );
  };

  if (forceChannelSend) {
    try {
      const sentMessage = await sendChannelMessage(channelPayload, "channel.send direct");
      scheduleMessageDeletion(sentMessage, autoDeleteMs);
      return sentMessage;
    } catch (error) {}
  }

  if (typeof message?.reply === "function") {
    try {
      const sentMessage = await sendWithRetry(() => message.reply(replyPayload), {
        label: "message.reply preferred",
        maxAttempts: 2
      });
      scheduleMessageDeletion(sentMessage, autoDeleteMs);
      return sentMessage;
    } catch (error) {
      const unknownMessage = isUnknownMessageError(error);
      try {
        const sentMessage = await sendChannelMessage(channelPayload, "channel.send fallback");
        scheduleMessageDeletion(sentMessage, autoDeleteMs);
        return sentMessage;
      } catch (sendError) {}

      if (!unknownMessage && typeof content === "string") {
        try {
          const sentMessage = await sendChannelMessage(
            {
              content: truncateText(content, 1900),
              allowedMentions: { parse: [] }
            },
            "channel.send plain fallback"
          );
          scheduleMessageDeletion(sentMessage, autoDeleteMs);
          return sentMessage;
        } catch (fallbackError) {}
      }
    }
  } else {
    try {
      const sentMessage = await sendChannelMessage(channelPayload, "channel.send preferred");
      scheduleMessageDeletion(sentMessage, autoDeleteMs);
      return sentMessage;
    } catch (error) {
      const unknownMessage = isUnknownMessageError(error);

      if (!unknownMessage && typeof content === "string") {
        try {
          const sentMessage = await sendChannelMessage(
            {
              content: truncateText(content, 1900),
              allowedMentions: { parse: [] }
            },
            "channel.send plain fallback"
          );
          scheduleMessageDeletion(sentMessage, autoDeleteMs);
          return sentMessage;
        } catch (fallbackError) {

        }
      }
    }
  }

  return null;
}

async function resolveClientChannel(channelId) {
  const normalizedChannelId = parseSnowflake(channelId);
  if (!normalizedChannelId) {
    return null;
  }

  const cached = client.channels?.cache?.get?.(normalizedChannelId);
  if (cached) {
    return cached;
  }

  if (typeof client.channels?.fetch === "function") {
    try {
      return await client.channels.fetch(normalizedChannelId);
    } catch {
      return null;
    }
  }

  return null;
}

async function resolveClientGuild(guildId) {
  const normalizedGuildId = parseSnowflake(guildId);
  if (!normalizedGuildId) {
    return null;
  }

  const cached = client.guilds?.cache?.get?.(normalizedGuildId);
  if (cached) {
    return cached;
  }

  if (typeof client.guilds?.fetch === "function") {
    try {
      return await client.guilds.fetch(normalizedGuildId);
    } catch {
      return null;
    }
  }

  return null;
}

const PAGINATION_BUTTON_CUSTOM_IDS = Object.freeze({
  first: "paginate:first",
  previous: "paginate:previous",
  next: "paginate:next",
  last: "paginate:last"
});
const PAGINATION_ACTION_BY_BUTTON_ID = new Map([
  [PAGINATION_BUTTON_CUSTOM_IDS.first, "first"],
  [PAGINATION_BUTTON_CUSTOM_IDS.previous, "previous"],
  [PAGINATION_BUTTON_CUSTOM_IDS.next, "next"],
  [PAGINATION_BUTTON_CUSTOM_IDS.last, "last"]
]);
const PAGINATION_SESSION_TTL_MS = 15 * 60 * 1000;
const paginationSessions = new Map();

function resolvePaginationActionFromButton(customId) {
  const normalized = String(customId || "").trim();
  if (!normalized) {
    return null;
  }

  return PAGINATION_ACTION_BY_BUTTON_ID.get(normalized) || null;
}

function buildPaginationButtonRows(currentPage, totalPages) {
  const normalizedTotalPages = Math.max(1, Number(totalPages || 1));
  if (normalizedTotalPages <= 1) {
    return [];
  }

  const page = Math.max(1, Math.min(Number(currentPage || 1), normalizedTotalPages));
  const isFirstPage = page <= 1;
  const isLastPage = page >= normalizedTotalPages;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(PAGINATION_BUTTON_CUSTOM_IDS.first)
        .setStyle(ButtonStyle.Secondary)
        .setLabel("⏪")
        .setDisabled(isFirstPage),
      new ButtonBuilder()
        .setCustomId(PAGINATION_BUTTON_CUSTOM_IDS.previous)
        .setStyle(ButtonStyle.Secondary)
        .setLabel("◀")
        .setDisabled(isFirstPage),
      new ButtonBuilder()
        .setCustomId(PAGINATION_BUTTON_CUSTOM_IDS.next)
        .setStyle(ButtonStyle.Secondary)
        .setLabel("▶")
        .setDisabled(isLastPage),
      new ButtonBuilder()
        .setCustomId(PAGINATION_BUTTON_CUSTOM_IDS.last)
        .setStyle(ButtonStyle.Secondary)
        .setLabel("⏩")
        .setDisabled(isLastPage)
    )
  ];
}

function withPaginationComponents(payload, currentPage, totalPages) {
  const basePayload = payload && typeof payload === "object" ? { ...payload } : {};
  basePayload.components = buildPaginationButtonRows(currentPage, totalPages);
  return basePayload;
}

function clearPaginationSessionTimer(session) {
  if (session?.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

function armPaginationSession(session) {
  clearPaginationSessionTimer(session);
  session.expiresAt = Date.now() + PAGINATION_SESSION_TTL_MS;
  session.timer = setTimeout(() => {
    paginationSessions.delete(session.messageId);
    Promise.resolve(editPaginatedMessage(session, { components: [] })).catch(() => {
      // Best effort cleanup.
    });
  }, PAGINATION_SESSION_TTL_MS);

  if (session.timer && typeof session.timer.unref === "function") {
    session.timer.unref();
  }
}

async function editPaginatedMessage(session, payload) {
  let updatedMessage = null;

  if (typeof session?.message?.edit === "function") {
    try {
      updatedMessage = await session.message.edit(payload);
    } catch {
      updatedMessage = null;
    }
  }

  if (!updatedMessage) {
    try {
      const channel = await resolveClientChannel(session.channelId);
      const fetchedMessage =
        typeof channel?.messages?.fetch === "function"
          ? await channel.messages.fetch(session.messageId)
          : null;

      if (fetchedMessage && typeof fetchedMessage.edit === "function") {
        updatedMessage = await fetchedMessage.edit(payload);
      }
    } catch {
      updatedMessage = null;
    }
  }

  if (!updatedMessage && client.rest && typeof client.rest.patch === "function") {
    updatedMessage = await client.rest.patch(
      `/channels/${session.channelId}/messages/${session.messageId}`,
      { auth: true, body: payload }
    );
  }

  if (updatedMessage) {
    session.message = updatedMessage;
  }

  return updatedMessage;
}

async function registerPaginatedMessage({ sentMessage, currentPage, totalPages, getPagePayload, ownerUserId = null }) {
  const messageId = parseSnowflake(sentMessage?.id);
  const channelId = parseSnowflake(sentMessage?.channelId || sentMessage?.channel?.id);
  if (!messageId || !channelId || typeof getPagePayload !== "function") {
    return false;
  }

  const existing = paginationSessions.get(messageId);
  if (existing) {
    clearPaginationSessionTimer(existing);
  }

  const session = {
    messageId,
    channelId,
    message: sentMessage,
    currentPage: Math.max(1, Number(currentPage || 1)),
    totalPages: Math.max(1, Number(totalPages || 1)),
    ownerUserId: parseSnowflake(ownerUserId),
    getPagePayload,
    expiresAt: Date.now() + PAGINATION_SESSION_TTL_MS,
    timer: null
  };

  armPaginationSession(session);
  paginationSessions.set(messageId, session);
  if (session.totalPages > 1) {
    await editPaginatedMessage(session, { components: buildPaginationButtonRows(session.currentPage, session.totalPages) });
  }
  return true;
}

async function handlePaginatedButtonInteraction(interaction) {
  if (!interaction?.isButton?.()) {
    return false;
  }

  const action = resolvePaginationActionFromButton(interaction.customId);
  if (!action) {
    return false;
  }

  const resolvedUserId = parseSnowflake(interaction.user?.id);
  const resolvedChannelId = parseSnowflake(interaction.channelId || interaction.message?.channelId || interaction.channel?.id);
  const resolvedMessageId = parseSnowflake(interaction.message?.id);

  if (!resolvedUserId || !resolvedChannelId || !resolvedMessageId) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Pagination context is unavailable.", flags: MessageFlags.Ephemeral }).catch(() => null);
    }
    return true;
  }

  const session = paginationSessions.get(resolvedMessageId);
  if (!session || session.channelId !== resolvedChannelId) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "This pagination session has expired. Run the command again.", flags: MessageFlags.Ephemeral }).catch(() => null);
    }
    return true;
  }

  if (session.ownerUserId && session.ownerUserId !== resolvedUserId) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Run the command yourself to control this page.", flags: MessageFlags.Ephemeral }).catch(() => null);
    }
    return true;
  }

  const nowMs = Date.now();
  if (session.expiresAt <= nowMs) {
    clearPaginationSessionTimer(session);
    paginationSessions.delete(resolvedMessageId);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.update({ components: [] }).catch(() => null);
    }
    return true;
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => null);
  }

  armPaginationSession(session);

  try {
    let requestedPage = Math.max(1, Number(session.currentPage || 1));
    const knownTotalPages = Math.max(1, Number(session.totalPages || 1));

    if (action === "first") {
      requestedPage = 1;
    } else if (action === "previous") {
      requestedPage = Math.max(1, requestedPage - 1);
    } else if (action === "next") {
      requestedPage = Math.min(knownTotalPages, requestedPage + 1);
    } else if (action === "last") {
      requestedPage = knownTotalPages;
    }

    const nextState = await session.getPagePayload(requestedPage);
    if (!nextState || !nextState.payload) {
      return true;
    }

    const nextTotalPages = Math.max(1, Number(nextState.totalPages || 1));
    const nextPage = Math.max(1, Math.min(Number(nextState.page || requestedPage), nextTotalPages));
    const nextPayload = withPaginationComponents(nextState.payload, nextPage, nextTotalPages);

    if (nextPage !== session.currentPage || nextTotalPages !== session.totalPages) {
      await editPaginatedMessage(session, nextPayload);
    } else {
      await editPaginatedMessage(session, { components: buildPaginationButtonRows(nextPage, nextTotalPages) });
    }

    session.currentPage = nextPage;
    session.totalPages = nextTotalPages;
} catch (error) {}

  return true;
}

const paginationRuntime = {
  registerPaginatedMessage
};

const messageGuildCache = new WeakMap();
const messageAuthorMemberCache = new WeakMap();
const messageStaffCache = new WeakMap();

function canCacheMessageObject(message) {
  return Boolean(message && typeof message === "object");
}

async function resolveGuildFromMessage(message) {
  if (canCacheMessageObject(message) && messageGuildCache.has(message)) {
    return messageGuildCache.get(message);
  }

  const promise = (async () => {
    if (message.guild) {
      return message.guild;
    }

    const guildId = parseSnowflake(message?.guildId || message?.guild?.id);
    if (!guildId) {
      return null;
    }

    const cachedGuild = client.guilds?.cache?.get(guildId);
    if (cachedGuild) {
      return cachedGuild;
    }

    try {
      return await client.guilds.fetch(guildId);
    } catch {
      return null;
    }
  })();

  if (canCacheMessageObject(message)) {
    messageGuildCache.set(message, promise);
  }

  return promise;
}

async function resolveGuildMember(guild, userId) {
  if (!guild || !userId) {
    return null;
  }

  try {
    const cachedMember = guild.members?.cache?.get?.(userId);
    if (cachedMember) {
      return cachedMember;
    }

    if (typeof guild.members?.fetch === "function") {
      return await guild.members.fetch(userId);
    }

    return null;
  } catch {
    return null;
  }
}

async function resolveAuthorMemberFromMessage(message, guild = null) {
  if (canCacheMessageObject(message) && messageAuthorMemberCache.has(message)) {
    return messageAuthorMemberCache.get(message);
  }

  const promise = (async () => {
    if (message?.member && typeof message.member?.permissions?.has === "function") {
      return message.member;
    }

    const resolvedGuild = guild || (await resolveGuildFromMessage(message));
    const authorId = parseSnowflake(message?.author?.id);
    if (!resolvedGuild || !authorId) {
      return null;
    }

    return resolveGuildMember(resolvedGuild, authorId);
  })();

  if (canCacheMessageObject(message)) {
    messageAuthorMemberCache.set(message, promise);
  }

  return promise;
}

function hasPermissionFlag(source, permissionFlag) {
  if (!source || permissionFlag == null) {
    return false;
  }

  if (typeof source.has === "function") {
    try {
      return Boolean(source.has(permissionFlag));
    } catch {
      // Continue with bigint fallback.
    }
  }

  try {
    const rawValue = source?.bitfield ?? source;
    const bitfield = typeof rawValue === "bigint" ? rawValue : BigInt(rawValue || 0);
    const required = typeof permissionFlag === "bigint" ? permissionFlag : BigInt(permissionFlag || 0);
    return (bitfield & required) === required;
  } catch {
    return false;
  }
}

async function isStaffMember(message) {
  if (canCacheMessageObject(message) && messageStaffCache.has(message)) {
    return messageStaffCache.get(message);
  }

  const promise = (async () => {
    const member = await resolveAuthorMemberFromMessage(message);
    return Boolean(member?.permissions?.has(PermissionFlags.Administrator));
  })();

  if (canCacheMessageObject(message)) {
    messageStaffCache.set(message, promise);
  }

  return promise;
}

async function hasPermission(message, permissionFlag) {
  const member = await resolveAuthorMemberFromMessage(message);
  const permissionSource = message?.memberPermissions || member?.permissions || message?.member?.permissions;
  const guild = await resolveGuildFromMessage(message);

  if (Boolean(
    hasPermissionFlag(permissionSource, permissionFlag) ||
    hasPermissionFlag(permissionSource, PermissionFlags.Administrator)
  )) {
    return true;
  }

  const memberUserId = String(member?.user?.id || member?.id || message?.author?.id || "").trim();
  if (guild && memberUserId && String(guild.ownerId || "") === memberUserId) {
    return true;
  }

  if (
    permissionFlag === PermissionFlags.Administrator &&
    Boolean(
      hasPermissionFlag(permissionSource, PermissionFlags.ManageGuild) ||
      hasPermissionFlag(permissionSource, PermissionFlags.ManageChannels) ||
      hasPermissionFlag(permissionSource, PermissionFlags.ManageRoles)
    )
  ) {
    return true;
  }

  return false;
}

async function requirePermission(
  message,
  permissionFlag,
  deniedText = "You do not have permission for this command."
) {
  const allowed = await hasPermission(message, permissionFlag);
  if (!allowed) {
    await safeReply(message, deniedText);
    return false;
  }

  return true;
}

async function generateAiText(prompt) {
  if (!config.ai.apiKey) {
    throw new Error("Google API key is not configured");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    config.ai.modelName
  )}:generateContent?key=${encodeURIComponent(config.ai.apiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AI request failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const part = candidate?.content?.parts?.find((item) => typeof item?.text === "string");
  const text = String(part?.text ?? "").trim();

  if (!text) {
    throw new Error("AI response was empty");
  }

  return text;
}

function estimateProfileScore(member) {
  const hasAvatar = Boolean(member?.user?.avatar || member?.user?.avatarUrl);
  const displayName = String(member?.displayName || member?.nick || member?.user?.username || "").trim();

  let score = 0;
  if (hasAvatar) score += 0.55;
  if (displayName.length >= 3) score += 0.25;
  if (displayName && !displayName.toLowerCase().startsWith("user") && !displayName.toLowerCase().startsWith("member")) {
    score += 0.2;
  }

  return {
    hasAvatar,
    profileScore: Math.max(0, Math.min(score, 1))
  };
}

function buildTimeoutCandidates(durationSeconds) {
  const until = new Date(Date.now() + durationSeconds * 1000);
  const secondsIso = toIsoSeconds(until);
  const fullIso = until.toISOString();

  return [...new Set([secondsIso, fullIso.replace(".000Z", "Z"), fullIso])];
}

async function tryApplyTimeout(member, reason, durationSeconds) {
  const timeoutReason = sanitizeReason(reason);
  const attempted = [];

  for (const candidate of buildTimeoutCandidates(durationSeconds)) {
    attempted.push(candidate);
    try {
      await member.edit({
        communication_disabled_until: candidate,
        timeout_reason: timeoutReason
      });
      return {
        ok: true,
        until: candidate,
        attempted,
        error: null
      };
    } catch (error) {
      if (!String(error).includes("INVALID_FORM_BODY")) {
        return {
          ok: false,
          until: null,
          attempted,
          error: String(error)
        };
      }
    }
  }

  return {
    ok: false,
    until: null,
    attempted,
    error: "INVALID_FORM_BODY"
  };
}

async function sendVerificationDm(member, verificationUrl, reason) {
  const details = verificationUrl
    ? [
        "Your join is currently gated while staff review activity patterns.",
        `Reason: ${reason}`,
        `Complete verification here: ${verificationUrl}`
      ]
    : [
        "Your join is currently gated while staff review activity patterns.",
        `Reason: ${reason}`,
        "No verification website is configured right now.",
        "A staff member will review and approve or reject your join manually."
      ];

  try {
    if (member?.user && typeof member.user.send === "function") {
      await member.user.send(
        buildEmbedPayload(details.join("\n"), {
          title: "Join Verification",
          kind: "warning"
        })
      );
      return true;
    }
  } catch (error) {

  }

  return false;
}

async function getEffectiveGateState(guildId) {
  const state = await db.getRaidGateState(guildId);
  if (!state.gate_active || !state.gate_until) {
    return state;
  }

  const gateUntilMs = Date.parse(state.gate_until);
  if (!Number.isFinite(gateUntilMs)) {
    return state;
  }

  if (Date.now() >= gateUntilMs) {
    await db.setRaidGateState(guildId, false, "Gate expired", null);
    return {
      gate_active: false,
      gate_reason: "Gate expired",
      gate_until: null,
      updated_at: new Date().toISOString()
    };
  }

  return state;
}

async function gateMember(member, signal, reason, guildConfig, options = {}) {
  const guildId = member?.guild?.id || member?.guildId;
  const userId = member?.user?.id || member?.id;

  if (!guildId || !userId) {
    return "gated_failed";
  }

  await db.upsertVerificationMember({
    guildId,
    userId,
    status: "pending",
    riskScore: signal.riskScore,
    verificationUrl: guildConfig.verification_url,
    reason
  });

  const dmSent = await sendVerificationDm(member, guildConfig.verification_url, reason);
  const metadata = {
    risk_score: Number(signal.riskScore.toFixed(4)),
    risk_level: signal.riskLevel,
    join_rate_per_minute: Number(signal.joinRatePerMinute.toFixed(3)),
    young_account_ratio: Number(signal.youngAccountRatio.toFixed(3)),
    dm_sent: dmSent,
    gate_mode: guildConfig.join_gate_mode
  };

    const shouldKick = Boolean(options.forceKick) || guildConfig.join_gate_mode === "kick";

    if (shouldKick) {
    try {
      // Prefer kicking via GuildMember.kick
      if (typeof member?.kick === "function") {
        await member.kick({ reason: sanitizeReason(`Join gated: ${reason}`) });
      } else if (member?.guild && member.guild.members && typeof member.guild.members.kick === "function") {
        await member.guild.members.kick(userId, { reason: sanitizeReason(`Join gated: ${reason}`) });
      } else {
        throw new Error("Cannot perform kick: guild API unavailable");
      }
      await db.logModerationAction({
        guildId,
        action: "join_gate_kick",
        actorUserId: client.user?.id ?? null,
        targetUserId: userId,
        reason,
        metadata
      });
      return "gated_kick";
    } catch (error) {
      await db.logModerationAction({
        guildId,
        action: "join_gate_kick_failed",
        actorUserId: client.user?.id ?? null,
        targetUserId: userId,
        reason,
        metadata: {
          ...metadata,
          kick_error: String(error)
        }
      });
      return "gated_kick_failed";
    }
  }

  const timeoutResult = await tryApplyTimeout(member, `Join gated: ${reason}`, guildConfig.gate_duration_seconds);
  if (timeoutResult.ok) {
    await db.logModerationAction({
      guildId,
      action: "join_gate_timeout",
      actorUserId: client.user?.id ?? null,
      targetUserId: userId,
      reason,
      metadata: {
        ...metadata,
        gate_until: new Date(Date.now() + guildConfig.gate_duration_seconds * 1000).toISOString(),
        timeout_until: timeoutResult.until,
        timeout_attempted_values: timeoutResult.attempted
      }
    });
    return "gated_timeout";
  }

  await db.logModerationAction({
    guildId,
    action: "join_gate_timeout_failed",
    actorUserId: client.user?.id ?? null,
    targetUserId: userId,
    reason,
    metadata: {
      ...metadata,
      timeout_attempted_values: timeoutResult.attempted,
      timeout_error: timeoutResult.error
    }
  });
  return "gated_timeout_failed";
}

async function sendWelcomeForMember(member) {
  const guildId = member?.guild?.id || member?.guildId;
  const userId = member?.user?.id || member?.id;
  if (!guildId || !userId) {
    return;
  }

  const gateState = await getEffectiveGateState(guildId);
  const lockdownState = await getEffectiveRaidLockdownState(guildId);
  if (gateState.gate_active || lockdownState.lockdown_active) {
    return;
  }

  if (await db.isMemberPendingVerification(guildId, userId)) {
    return;
  }

  const guildConfig = await db.getGuildConfig(guildId);
  const channelId = guildConfig.welcome_channel_id;
  if (!channelId) {
    return;
  }

  const memberCountCandidate = [
    Number(member?.guild?.memberCount),
    Number(member?.guild?.member_count),
    Number(member?.guild?.approximate_member_count)
  ].find((entry) => Number.isFinite(entry) && entry > 0);
  const memberCount = Math.max(0, Number.isFinite(memberCountCandidate) ? memberCountCandidate : 0);
  const guildName = String(member?.guild?.name || guildId);

  const templateValues = {
    "user.mention": formatUserMention(userId),
    "user.id": userId,
    "user.name": String(member?.user?.username || member?.displayName || userId),
    "guild.id": guildId,
    "guild.name": guildName,
    "server.member_count": formatInteger(memberCount),
    "channels.rules": guildConfig.rules_channel_id ? `<#${guildConfig.rules_channel_id}>` : "-",
    "channels.chat": guildConfig.chat_channel_id ? `<#${guildConfig.chat_channel_id}>` : "-",
    "channels.help": guildConfig.help_channel_id ? `<#${guildConfig.help_channel_id}>` : "-",
    "channels.about": guildConfig.about_channel_id ? `<#${guildConfig.about_channel_id}>` : "-",
    "channels.perks": guildConfig.perks_channel_id ? `<#${guildConfig.perks_channel_id}>` : "-"
  };

  const resourceLines = [];
  if (guildConfig.rules_channel_id) resourceLines.push(`Rules: <#${guildConfig.rules_channel_id}>`);
  if (guildConfig.chat_channel_id) resourceLines.push(`Chat: <#${guildConfig.chat_channel_id}>`);
  if (guildConfig.help_channel_id) resourceLines.push(`Help: <#${guildConfig.help_channel_id}>`);
  if (guildConfig.about_channel_id) resourceLines.push(`About: <#${guildConfig.about_channel_id}>`);
  if (guildConfig.perks_channel_id) resourceLines.push(`Perks: <#${guildConfig.perks_channel_id}>`);

  templateValues["channels.resources"] = resourceLines.join("\n");

  const templateSource = String(guildConfig.welcome_message_template || "");
  const renderedWelcome = renderMessageTemplate(templateSource, templateValues).trim();

  const lines = [renderedWelcome || `Welcome ${formatUserMention(userId)} to ${guildName}.`];
  if (!/\{channels\./i.test(templateSource) && resourceLines.length > 0) {
    lines.push(...resourceLines);
  }

  let welcomePayload = lines.join("\n");

  if (guildConfig.welcome_card_enabled) {
    const titleTemplate = String(guildConfig.welcome_card_title_template || "");
    const subtitleTemplate = String(guildConfig.welcome_card_subtitle_template || "");
    const titleText = renderMessageTemplate(titleTemplate, templateValues).trim() || `Welcome to ${guildName}`;
    const subtitleText =
      renderMessageTemplate(subtitleTemplate, templateValues).trim() ||
      `${String(member?.user?.username || member?.displayName || "Member")} joined the server.`;

    try {
      const imageData = await renderWelcomeCardImage({
        guildName,
        displayName: String(member?.displayName || member?.user?.username || "Member"),
        avatarUrl: resolveAvatarUrl(member?.user || member),
        memberCount,
        titleText,
        subtitleText,
        primaryColor: guildConfig.welcome_card_primary_color,
        accentColor: guildConfig.welcome_card_accent_color,
        overlayOpacity: guildConfig.welcome_card_overlay_opacity,
        backgroundUrl: guildConfig.welcome_card_background_url,
        fontStyle: guildConfig.welcome_card_font
      });

      const embed = new EmbedBuilder()
        .setTitle("🌟 " + titleText)
        .setAuthor({ name: guildName, iconURL: (member?.guild && typeof member.guild.iconURL === 'function') ? member.guild.iconURL({ size: 256 }) : null })
        .setDescription(lines.join("\n"))
        .setColor(0x1f6feb)
        .setThumbnail(resolveAvatarUrl(member?.user || member))
        .setImage(`attachment://${WELCOME_CARD_IMAGE_FILE}`)
        .setFooter({ text: "Enjoy your stay!", iconURL: "https://cdn.discordapp.com/emojis/1043132646736232538.png" });
        
      welcomePayload = {
        content: `<@${member.user?.id || member.id}>`,
        embeds: [embed],
        files: [
          {
            name: WELCOME_CARD_IMAGE_FILE,
            attachment: imageData
          }
        ]
      };
    } catch (error) {

    }
  } else {
    const embed = new EmbedBuilder()
      .setTitle(`🌟 Welcome to ${guildName}!`)
      .setAuthor({ name: guildName, iconURL: (member?.guild && typeof member.guild.iconURL === 'function') ? member.guild.iconURL({ size: 256 }) : null })
      .setDescription(lines.join("\n"))
      .setColor(0x1f6feb)
      .setThumbnail(resolveAvatarUrl(member?.user || member))
      .setFooter({ text: "Enjoy your stay!", iconURL: "https://cdn.discordapp.com/emojis/1043132646736232538.png" });
    welcomePayload = { content: `<@${member.user?.id || member.id}>`, embeds: [embed] };
  }

  try {
    const channel = await resolveClientChannel(channelId);
    if (channel && typeof channel.send === "function") {
      await channel.send(welcomePayload);
    }
  } catch (error) {

  }
}

async function handleMemberJoin(member) {
  const guildId = member?.guild?.id || member?.guildId;
  const userId = member?.user?.id || member?.id;

  if (!guildId || !userId) {
    return;
  }

  if (member?.user?.bot) {
    return;
  }

  const guildConfig = await getCachedGuildConfig(guildId);
  const gateState = await getEffectiveGateState(guildId);
  const lockdownState = await getEffectiveRaidLockdownState(guildId, member?.guild || null);

  const createdAt = snowflakeToDate(userId);
  const accountAgeDays = Math.max(0, (Date.now() - createdAt.getTime()) / 86400000);
  const profile = estimateProfileScore(member);

  const joinInput = {
    guildId,
    accountAgeDays,
    hasAvatar: profile.hasAvatar,
    profileScore: profile.profileScore,
    windowSeconds: guildConfig.raid_monitor_window_seconds,
    joinRateThreshold: guildConfig.raid_join_rate_threshold
  };

  // Join gating uses local rate/burst logic so decisions are driven by join timing only.
  const signal = riskEngine.evaluateJoin(joinInput);
  let sidecarSignal = null;
  if (raidMlClient.enabled) {
    try {
      const sidecarCandidate = await raidMlClient.evaluateJoin(joinInput);
      if (sidecarCandidate && Number.isFinite(Number(sidecarCandidate.riskScore))) {
        sidecarSignal = sidecarCandidate;
      }
    } catch {
      // Best effort sidecar telemetry.
    }
  }

  const riskScore = Number(signal.riskScore || 0);
  const modelConfidence = Number(signal.modelConfidence ?? 0.5);
  const heuristicScore = Number(signal.heuristicScore ?? riskScore);
  const adaptiveScore = Number(signal.adaptiveScore ?? riskScore);
  const riskLevel =
    typeof signal.riskLevel === "string"
      ? signal.riskLevel
      : riskScore >= 0.82
        ? "high"
        : riskScore >= 0.6
          ? "medium"
          : "low";

  const threshold = Number(guildConfig.raid_gate_threshold);
  const suspicious = riskScore >= threshold;
  const cautious = riskScore >= Math.max(0.5, threshold - 0.1);

  let gateActive = Boolean(gateState.gate_active);
  let gateReason = String(gateState.gate_reason || "");
  let action = "allow";
  const lockdownActive = Boolean(lockdownState.lockdown_active);

  if (suspicious && !gateActive) {
    const gateUntil = new Date(Date.now() + guildConfig.gate_duration_seconds * 1000);
    gateReason =
      `Automated anti-raid trigger in closed testing. ${signal.explanation}. ` +
      `risk=${riskScore.toFixed(3)} confidence=${modelConfidence.toFixed(3)}`;
    await db.setRaidGateState(guildId, true, gateReason, gateUntil.toISOString());
    gateActive = true;
  }

  if (suspicious && !lockdownActive) {
    const lockdownUntil = new Date(Date.now() + RAID_LOCKDOWN_DURATION_MS).toISOString();
    await applyRaidLockdown(member?.guild || null, gateReason || `Automatic raid lockdown for ${guildId}`, lockdownUntil);
  }

  const shouldGate = gateActive || cautious || lockdownActive;
  if (shouldGate) {
    if (!gateReason) {
      gateReason =
        `Precautionary join gating while staff review suspicious pattern ` +
        `(risk=${riskScore.toFixed(3)}, confidence=${modelConfidence.toFixed(3)}, ${signal.explanation}).`;
    }

    action = await gateMember(member, signal, gateReason, guildConfig, {
      forceKick: suspicious || lockdownActive
    });
  }

  await db.logJoinEvent({
    guildId,
    userId,
    accountAgeDays: Number(signal.accountAgeDays ?? accountAgeDays),
    hasAvatar: Boolean(signal.hasAvatar ?? profile.hasAvatar),
    profileScore: Number(signal.profileScore ?? profile.profileScore),
    joinRate: Number(signal.joinRatePerMinute || 0),
    youngAccountRatio: Number(signal.youngAccountRatio || 0),
    riskScore,
    riskLevel,
    action,
    metadata: {
      explanation: String(signal.explanation || "signals unavailable"),
      gate_active: gateActive,
      model_confidence: Number(modelConfidence.toFixed(4)),
      heuristic_score: Number(heuristicScore.toFixed(4)),
      adaptive_score: Number(adaptiveScore.toFixed(4)),
      anomaly: signal.anomaly || null,
      suspicious_activity: signal.suspiciousActivity || null,
      model_state: signal.modelState || null,
      backend: "local-js",
      sidecar_risk_score: sidecarSignal ? Number(sidecarSignal.riskScore || 0) : null,
      sidecar_risk_level: sidecarSignal && typeof sidecarSignal.riskLevel === "string" ? sidecarSignal.riskLevel : null
    }
  });

  if (!action.startsWith("gated")) {
    await sendWelcomeForMember(member);
  }
}

async function sendTicketTriggerNotice(channelId, messageText) {
  if (!channelId || !messageText) {
    return;
  }

  try {
    const channel = await resolveClientChannel(channelId);
    if (channel && typeof channel.send === "function") {
      await channel.send(String(messageText));
    }
  } catch {
    // Best effort notification.
  }
}

async function handleReactionTicketCreate(reaction, user, messageId, channelId, emoji, userId) {
  const guildId = parseSnowflake(reaction?.guildId || reaction?.guild_id || reaction?.message?.guildId || reaction?.message?.guild_id);
  const resolvedUserId = parseSnowflake(userId || user?.id || reaction?.userId || reaction?.user_id || reaction?.user?.id);
  const resolvedChannelId = parseSnowflake(
    channelId || reaction?.channelId || reaction?.channel_id || reaction?.message?.channelId || reaction?.message?.channel_id
  );
  const resolvedMessageId = parseSnowflake(messageId || reaction?.messageId || reaction?.message_id || reaction?.message?.id);

  if (!guildId || !resolvedUserId || !resolvedChannelId || !resolvedMessageId) {
    return;
  }

  if (client.user?.id && resolvedUserId === client.user.id) {
    return;
  }

  const guildConfig = await getCachedGuildConfig(guildId);
  if (!guildConfig.ticket_enabled) {
    return;
  }

  if (!guildConfig.ticket_trigger_channel_id || !guildConfig.ticket_trigger_message_id) {
    return;
  }

  if (guildConfig.ticket_trigger_channel_id !== resolvedChannelId) {
    return;
  }

  if (guildConfig.ticket_trigger_message_id !== resolvedMessageId) {
    return;
  }

  if (!emojiMatchesStoredTrigger(guildConfig.ticket_trigger_emoji, emoji || reaction?.emoji)) {
    return;
  }

  let guild = null;
  try {
    guild = await resolveClientGuild(guildId);
  } catch {
    guild = null;
  }

  if (!guild) {
    return;
  }

  const member = await resolveGuildMember(guild, resolvedUserId);
  if (!member || member.user?.bot) {
    return;
  }

  const existingTicket = await db.getOpenTicketForUser(guildId, resolvedUserId);
  if (existingTicket?.channel_id) {
    let existingChannel = null;
    try {
      existingChannel = await resolveClientChannel(existingTicket.channel_id);
    } catch {
      existingChannel = null;
    }

    if (existingChannel) {
      await sendTicketTriggerNotice(
        resolvedChannelId,
        `${formatUserMention(resolvedUserId)} you already have an open ticket: <#${existingTicket.channel_id}>.`
      );
      return;
    }

    await db.clearOpenTicketForUser(guildId, resolvedUserId);
  }

  const ticketChannelName = buildTicketChannelName(member, resolvedUserId);
  const supportRoleId = parseSnowflake(guildConfig.ticket_support_role_id);
  const parentId = parseSnowflake(guildConfig.ticket_category_channel_id);
  const permissionOverwrites = buildTicketPermissionOverwrites({
    guildId,
    userId: resolvedUserId,
    supportRoleId
  });
  const topic = sanitizeReason(
    `Support ticket for ${resolvedUserId}. Trigger message ${resolvedMessageId}.`,
    250
  );

  try {
    const created = await createTicketChannel({
      guild,
      guildId,
      name: ticketChannelName,
      parentId,
      topic,
      permissionOverwrites
    });

    const createdChannelId = parseSnowflake(created?.id);
    if (!createdChannelId) {
      throw new Error("ticket channel creation returned no channel id");
    }

    await db.setOpenTicket({
      guildId,
      userId: resolvedUserId,
      channelId: createdChannelId,
      triggerChannelId: resolvedChannelId,
      triggerMessageId: resolvedMessageId
    });

    const ticketTemplateValues = {
      "user.mention": formatUserMention(resolvedUserId),
      "user.id": resolvedUserId,
      "user.name": String(member.displayName || member.user?.username || resolvedUserId),
      "guild.id": guildId,
      "guild.name": String(guild.name || guildId),
      "ticket.channel": `<#${createdChannelId}>`,
      "ticket.support_role": supportRoleId ? `<@&${supportRoleId}>` : ""
    };

    const ticketMessage =
      renderMessageTemplate(guildConfig.ticket_welcome_template, ticketTemplateValues).trim() ||
      `Hello ${formatUserMention(resolvedUserId)}. Thanks for opening a ticket. Our team will be with you soon.`;

    let ticketChannel = null;
    try {
      ticketChannel = await resolveClientChannel(createdChannelId);
    } catch {
      ticketChannel = null;
    }

    if (ticketChannel && typeof ticketChannel.send === "function") {
      await ticketChannel.send(ticketMessage);
    }

    await sendTicketTriggerNotice(
      resolvedChannelId,
      `${formatUserMention(resolvedUserId)} ticket created: <#${createdChannelId}>.`
    );

    await db.logModerationAction({
      guildId,
      action: "ticket_create",
      actorUserId: client.user?.id ?? null,
      targetUserId: resolvedUserId,
      reason: `trigger=${resolvedMessageId} emoji=${guildConfig.ticket_trigger_emoji}`,
      channelId: createdChannelId,
      messageId: resolvedMessageId,
      metadata: {
        trigger_channel_id: resolvedChannelId,
        ticket_channel_id: createdChannelId,
        support_role_id: supportRoleId,
        category_channel_id: parentId
      }
    });
  } catch (error) {
    await db.logModerationAction({
      guildId,
      action: "ticket_create_failed",
      actorUserId: client.user?.id ?? null,
      targetUserId: resolvedUserId,
      reason: `trigger=${resolvedMessageId}`,
      channelId: resolvedChannelId,
      messageId: resolvedMessageId,
      metadata: {
        error: String(error),
        ticket_trigger_emoji: guildConfig.ticket_trigger_emoji
      }
    });

    await sendTicketTriggerNotice(
      resolvedChannelId,
      `${formatUserMention(resolvedUserId)} ticket creation failed. Please contact staff manually.`
    );

  }
}

async function applyReactionRole(reaction, emoji, userId, channelId, messageId, remove) {
  const guildId = parseSnowflake(reaction?.guildId || reaction?.guild_id || reaction?.message?.guildId || reaction?.message?.guild_id);
  const resolvedUserId = parseSnowflake(userId || reaction?.userId || reaction?.user_id || reaction?.user?.id);
  const resolvedChannelId = parseSnowflake(
    channelId || reaction?.channelId || reaction?.channel_id || reaction?.message?.channelId || reaction?.message?.channel_id
  );
  const resolvedMessageId = parseSnowflake(
    messageId || reaction?.messageId || reaction?.message_id || reaction?.message?.id
  );

  if (!guildId || !resolvedUserId || !resolvedChannelId || !resolvedMessageId) {
    return;
  }

  if (client.user?.id && resolvedUserId === client.user.id) {
    return;
  }

  const emojiKeys = emojiKeyCandidatesFromGatewayEmoji(emoji || reaction?.emoji);
  if (emojiKeys.length === 0) {
    return;
  }

  let roleIds = [];
  let matchedEmojiKey = "";
  let fallbackMappingUsed = false;

  for (const key of emojiKeys) {
    const candidateRoleIds = await db.getReactionRoleIds(guildId, resolvedChannelId, resolvedMessageId, key);
    if (candidateRoleIds.length > 0) {
      roleIds = candidateRoleIds;
      matchedEmojiKey = key;
      logInfo(`reaction-role: matched emoji key "${key}" with roles [${candidateRoleIds.join(', ')}] on message ${resolvedMessageId}`);
      break;
    }
  }

  if (roleIds.length === 0) {
    logInfo(`reaction-role: no direct match found. searched emoji keys: [${emojiKeys.join(', ')}] on message ${resolvedMessageId}`);
    const messageMappings = (await db
      .listReactionRoles(guildId, resolvedMessageId)
      ).filter((entry) => entry.channel_id === resolvedChannelId);

    if (messageMappings.length > 0) {

    }

    if (messageMappings.length === 1 && messageMappings[0].role_id) {
      roleIds = [messageMappings[0].role_id];
      matchedEmojiKey = String(messageMappings[0].emoji_key || "");
      fallbackMappingUsed = true;

    }
  }

  if (roleIds.length === 0) {
    logInfo(`reaction-role: no role mapping found for guild=${guildId} channel=${resolvedChannelId} message=${resolvedMessageId} emoji_keys=[${emojiKeys.join(', ')}]`);
    return;
  }

  try {
    const guild = await resolveClientGuild(guildId);
    const member = await resolveGuildMember(guild, resolvedUserId);
    if (!member || member.user?.bot) {
      return;
    }

    const appliedRoleIds = [];
    const failedRoleIds = [];

    for (const roleId of roleIds) {
      try {
        if (remove) {
          await member.roles.remove(roleId);
        } else {
          await member.roles.add(roleId);
        }
        appliedRoleIds.push(roleId);
      } catch (error) {
        failedRoleIds.push(roleId);
        logError(`reaction-role: failed to ${remove ? 'remove' : 'add'} role ${roleId} to ${resolvedUserId}: ${String(error?.message || error)}`);
      }
    }

    if (appliedRoleIds.length === 0 && failedRoleIds.length > 0) {

    }

    await db.logModerationAction({
      guildId,
      action: remove ? "reaction_role_revoke" : "reaction_role_grant",
      actorUserId: client.user?.id ?? null,
      targetUserId: resolvedUserId,
      reason: `emoji=${matchedEmojiKey || emojiKeys[0]} message=${resolvedMessageId}`,
      channelId: resolvedChannelId,
      messageId: resolvedMessageId,
      metadata: {
        emoji_key: matchedEmojiKey || emojiKeys[0],
        emoji_keys_seen: emojiKeys,
        fallback_mapping_used: fallbackMappingUsed,
        applied_role_ids: appliedRoleIds,
        failed_role_ids: failedRoleIds
      }
    });
  } catch (error) {

  }
}

async function handleSpamModeration(message, options = {}) {
  if (!config.automod.spamDetectionEnabled) {
    return false;
  }

  if (!message.guildId || !message.content || message.author?.bot) {
    return false;
  }

  const guild = options.guild || (await resolveGuildFromMessage(message));
  if (!guild) {
    return false;
  }

  const authorIsStaff =
    typeof options.authorIsStaff === "boolean" ? options.authorIsStaff : await isStaffMember(message);

  if (authorIsStaff) {
    return false;
  }

  const actorId = message.author.id;
  const signal = spamEngine.evaluateMessage({
    guildId: guild.id,
    userId: actorId,
    content: message.content,
    createdAtMs: Date.now()
  });

  if (!signal.isSpam || signal.score < config.automod.warningOnlyThreshold) {
    return false;
  }

  const reasonsText = signal.reasons.length > 0 ? signal.reasons.join(", ") : "spam-like activity";

  try {
    if (typeof message.delete === "function") {
      await message.delete();
    }
  } catch {
    // Best effort.
  }

  const warningCount = await db.incrementWarning(
    guild.id,
    actorId,
    `Spam detected: ${reasonsText}`,
    client.user?.id ?? null
  );

  let timeoutApplied = false;
  let timeoutError = null;
  let timeoutSeconds = 0;
  let timeoutAttemptedValues = [];
  let offendingMember = null;

  const shouldTimeout =
    signal.score >= config.automod.spamScoreMuteThreshold || warningCount >= config.maxWarnings;

  if (shouldTimeout) {
    offendingMember = await resolveGuildMember(guild, actorId);
    if (offendingMember) {
      timeoutSeconds = signal.severity === "high" ? config.automod.severeTimeoutSeconds : config.automod.timeoutSeconds;
      const timeoutResult = await tryApplyTimeout(offendingMember, `Automod spam: ${reasonsText}`, timeoutSeconds);
      timeoutApplied = timeoutResult.ok;
      timeoutError = timeoutResult.ok ? null : timeoutResult.error;
      timeoutAttemptedValues = timeoutResult.attempted;
    }
  }

  const guildConfig = await getCachedGuildConfig(guild.id);
  let raidEscalated = false;
  let escalation = null;

  if (signal.score >= config.automod.spamScoreMuteThreshold) {
    const escalationInput = {
      guildId: guild.id,
      userId: actorId,
      windowSeconds: config.automod.raidEscalationWindowSeconds,
      score: signal.score
    };

    if (raidMlClient.enabled) {
      escalation = await raidMlClient.recordSuspiciousActivity(escalationInput);
    }

    if (!escalation) {
      escalation = riskEngine.recordSuspiciousActivity(escalationInput);
    }

    const escalationScore = Number(escalation.suspiciousScore || 0);
    const escalationRate = Number(escalation.eventRatePerMinute || 0);

    const shouldEscalate =
      (escalation.eventCount >= config.automod.raidEscalationEventThreshold &&
        escalation.uniqueUsers >= config.automod.raidEscalationUserThreshold) ||
      escalationScore >= 1.2 ||
      (escalation.uniqueUsers >= config.automod.raidEscalationUserThreshold &&
        escalationRate >= Math.max(6, config.automod.raidEscalationEventThreshold));

    if (shouldEscalate) {
      const state = await getEffectiveGateState(guild.id);
      const gateReason =
        `Automatic raid gate from spam surge: ${escalation.eventCount} suspicious events from ` +
        `${escalation.uniqueUsers} users in ${escalation.windowSeconds}s (score=${escalationScore.toFixed(3)}).`;

      if (!state.gate_active) {
        const gateUntil = new Date(Date.now() + guildConfig.gate_duration_seconds * 1000).toISOString();
        await db.setRaidGateState(guild.id, true, gateReason, gateUntil);
        raidEscalated = true;
      }

      const lockdownState = await getEffectiveRaidLockdownState(guild.id, guild);
      if (!lockdownState.lockdown_active) {
        const lockdownUntil = new Date(Date.now() + RAID_LOCKDOWN_DURATION_MS).toISOString();
        await applyRaidLockdown(guild, gateReason, lockdownUntil);
        raidEscalated = true;
      }

      if (!offendingMember) {
        offendingMember = await resolveGuildMember(guild, actorId);
      }

      if (offendingMember?.kickable) {
        try {
          await offendingMember.kick({ reason: sanitizeReason(`Automatic raid removal: ${gateReason}`) });
          raidEscalated = true;
        } catch (error) {
          await db.logModerationAction({
            guildId: guild.id,
            action: "automod_spam_kick_failed",
            actorUserId: client.user?.id ?? null,
            targetUserId: actorId,
            reason: `Failed to remove raid account: ${String(error?.message || error)}`,
            channelId: message.channelId,
            messageId: message.id,
            metadata: {
              raid_escalation_state: escalation,
              kick_error: String(error?.message || error)
            }
          });
        }
      }
    }
  }

  await db.logModerationAction({
    guildId: guild.id,
    action: timeoutApplied ? "automod_spam_timeout" : "automod_spam_warn",
    actorUserId: client.user?.id ?? null,
    targetUserId: actorId,
    reason: `Spam detected: ${reasonsText}`,
    channelId: message.channelId,
    messageId: message.id,
    metadata: {
      score: Number(signal.score.toFixed(4)),
      severity: signal.severity,
      reasons: signal.reasons,
      metrics: signal.metrics,
      warning_count: warningCount,
      max_warnings: config.maxWarnings,
      timeout_applied: timeoutApplied,
      timeout_seconds: timeoutSeconds,
      timeout_error: timeoutError,
      timeout_attempted_values: timeoutAttemptedValues,
      raid_escalated: raidEscalated,
      raid_escalation_state: escalation
    }
  });

  const responseLines = [
    `${formatUserMention(actorId)} flagged for spam (${reasonsText}).`,
    formatWarningCounter(warningCount, config.maxWarnings)
  ];

  if (timeoutApplied) {
    responseLines.push(`Auto-timeout applied for ${Math.max(1, Math.round(timeoutSeconds / 60))} minute(s).`);
  } else if (shouldTimeout && timeoutError) {
    responseLines.push(`Timeout failed: ${timeoutError}`);
  }

  if (raidEscalated) {
    responseLines.push("Raid gate and lockdown were enabled automatically due to coordinated spam.");
    responseLines.push("The offending account was removed when Discord allowed it.");
  }

  await safeReply(message, responseLines.join("\n"), {
    title: "Auto Moderation",
    kind: timeoutApplied || raidEscalated ? "warning" : "info",
    forceChannelSend: true
  });

  return true;
}

async function handleWordModeration(message, options = {}) {
  if (!message.guildId || !message.content || message.author?.bot) {
    return false;
  }

  const blockedWord = wordStore.findBlockedWord(message.content);
  if (!blockedWord) {
    return false;
  }

  const guild = options.guild || (await resolveGuildFromMessage(message));
  if (!guild) {
    return false;
  }

  const actorId = message.author.id;
  const warningCount = await db.incrementWarning(guild.id, actorId, `Blocked word: ${blockedWord}`, client.user?.id ?? null);

  try {
    if (typeof message.delete === "function") {
      await message.delete();
    }
  } catch {
    // Best effort.
  }

  await db.logModerationAction({
    guildId: guild.id,
    action: "automod_warn",
    actorUserId: client.user?.id ?? null,
    targetUserId: actorId,
    reason: `Blocked word detected: ${blockedWord}`,
    channelId: message.channelId,
    messageId: message.id,
    metadata: {
      warning_count: warningCount,
      max_warnings: config.maxWarnings
    }
  });

  if (warningCount >= config.maxWarnings) {
    const thresholdDetail = formatWarningThresholdDetail(warningCount, config.maxWarnings);
    const member = await resolveGuildMember(guild, actorId);
    if (member) {
      const timeoutSeconds = config.automod.timeoutSeconds;
      const timeoutResult = await tryApplyTimeout(
        member,
        `Blocked word threshold reached (${thresholdDetail})`,
        timeoutSeconds
      );

      if (timeoutResult.ok) {
        await db.logModerationAction({
          guildId: guild.id,
          action: "automod_word_timeout",
          actorUserId: client.user?.id ?? null,
          targetUserId: actorId,
          reason: `Blocked word threshold reached (${thresholdDetail})`,
          metadata: {
            blocked_word: blockedWord,
            timeout_seconds: timeoutSeconds,
            timeout_until: timeoutResult.until,
            timeout_attempted_values: timeoutResult.attempted
          }
        });

        await safeReply(
          message,
          `${formatUserMention(actorId)} was auto-muted after repeated blocked words.`,
          { title: "Auto Moderation", kind: "warning", forceChannelSend: true }
        );
        return true;
      }
    }

    try {
      // Try to kick via resolved member or guild.members.kick
      const resolved = await resolveGuildMember(guild, actorId);
      if (resolved && typeof resolved.kick === "function") {
        await resolved.kick({ reason: `Exceeded warnings (${warningCount})` });
      } else if (guild && guild.members && typeof guild.members.kick === "function") {
        await guild.members.kick(actorId, { reason: `Exceeded warnings (${warningCount})` });
      } else {
        throw new Error("Cannot perform kick: guild API unavailable");
      }
      await db.resetWarnings(guild.id, actorId);
      await db.logModerationAction({
        guildId: guild.id,
        action: "automod_kick",
        actorUserId: client.user?.id ?? null,
        targetUserId: actorId,
        reason: `Exceeded warnings (${warningCount})`
      });
      await safeReply(message, `${formatUserMention(actorId)} was removed after exceeding warning limit.`, {
        title: "Auto Moderation",
        kind: "error",
        forceChannelSend: true
      });
      return true;
    } catch (error) {
      await safeReply(message, `Warning recorded for ${formatUserMention(actorId)} but kick failed: ${String(error)}`, {
        title: "Auto Moderation",
        kind: "warning",
        forceChannelSend: true
      });
      return true;
    }
  }

  await safeReply(
    message,
    `${formatUserMention(actorId)} ${formatWarningCounter(warningCount, config.maxWarnings)} Blocked word detected.`,
    {
      title: "Auto Moderation",
      kind: "warning",
      forceChannelSend: true
    }
  );

  return true;
}

async function sendLevelUpAnnouncement(message, guildConfig, levelSnapshot) {
  if (!config.leveling.announceLevelUp) {
    return;
  }

  const channelId = guildConfig.leveling_channel_id || message.channelId;
  if (!channelId) {
    return;
  }

  let channel = null;
  try {
    channel = await resolveClientChannel(channelId);
  } catch {
    channel = null;
  }

  if (!channel || typeof channel.send !== "function") {
    channel = await resolveReplyChannel(message);
  }

  if (!channel || typeof channel.send !== "function") {
    return;
  }

  const rank = await db.getMemberLevelRank(levelSnapshot.guild_id || message.guildId, levelSnapshot.user_id);
  const progressBar = buildProgressBar(levelSnapshot.progress_xp, levelSnapshot.progress_required, 18);
  const xpToNext = Math.max(0, Number(levelSnapshot.progress_required || 0) - Number(levelSnapshot.progress_xp || 0));

  const levelupText = renderMessageTemplate(guildConfig.levelup_message_template, {
    "user.mention": formatUserMention(levelSnapshot.user_id),
    "user.id": levelSnapshot.user_id,
    "user.name": String(message.author?.username || levelSnapshot.user_id),
    "guild.id": String(message.guildId || levelSnapshot.guild_id || ""),
    "guild.name": String(message.guild?.name || ""),
    level: String(levelSnapshot.level),
    rank: String(rank),
    "messages.count": formatInteger(levelSnapshot.message_count),
    "xp.total": formatInteger(levelSnapshot.xp),
    "xp.current": formatInteger(levelSnapshot.progress_xp),
    "xp.required": formatInteger(levelSnapshot.progress_required),
    "xp.to_next": formatInteger(xpToNext),
    "progress.percent": String(levelSnapshot.progress_percent),
    "progress.bar": progressBar
  }).trim();

  try {
    const finalContent =
      levelupText || `congo ${formatUserMention(levelSnapshot.user_id)} you levelled up to level ${levelSnapshot.level}!`;
    await channel.send(finalContent);
  } catch (error) {

  }
}

async function handleLevelingMessage(message, parsedCommand = null, options = {}) {
  if (!message.guildId || message.author?.bot) {
    return;
  }

  const guild = options.guild || (await resolveGuildFromMessage(message));
  if (!guild) {
    return;
  }

  if (config.leveling.ignoreCommandMessages) {
    const parsed = parsedCommand || parsePrefixedCommand(message.content);
    if (parsed) {
      return;
    }
  }

  const content = String(message.content || "").trim();
  if (content.length < config.leveling.minMessageLength) {
    return;
  }

  const xpGain = randomIntegerInRange(config.leveling.minXpPerMessage, config.leveling.maxXpPerMessage);
  const levelSnapshot = await db.addMemberXp({
    guildId: guild.id,
    userId: message.author.id,
    xpGain,
    cooldownSeconds: config.leveling.cooldownSeconds
  });

  if (!levelSnapshot.leveled_up || levelSnapshot.applied_xp <= 0 || levelSnapshot.cooldown_active) {
    return;
  }

  const guildConfig = await getCachedGuildConfig(guild.id);
  await sendLevelUpAnnouncement(message, guildConfig, levelSnapshot);
}

const commandHandlers = {
  ...createUtilityCommandHandlers({
    safeReply,
    config,
    aiLastUsedByUser,
    generateAiText,
    db,
    resolveGuildFromMessage,
    parseUserIdArg,
    formatUserMention,
    paginationRuntime
  }),
  ...createAdminCommandHandlers({
    PermissionFlags,
    requirePermission,
    resolveGuildFromMessage,
    safeReply,
    db,
    parseSnowflake,
    getEffectiveGateState,
    getEffectiveLockdownState: getEffectiveRaidLockdownState
  }),
  ...createModerationCommandHandlers({
    PermissionFlags,
    requirePermission,
    resolveGuildFromMessage,
    safeReply,
    wordStore,
    db,
    parseUserIdArg,
    formatUserMention,
    parseSnowflake,
    client,
    sanitizeReason,
    resolveGuildMember,
    toIsoSeconds,
    getEffectiveGateState,
    getEffectiveLockdownState: getEffectiveRaidLockdownState,
    sendWelcomeForMember,
    renderMessageTemplate,
    normalizeEmojiInput,
    emojiRouteTokenFromNormalized,
    messageBaseUrl: null,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
    ComponentType
  })
};
async function executeCommand(parsed, message) {
  const handler = commandHandlers[parsed.command];
  if (!handler) {
    return;
  }

  const guildId = parseSnowflake(message?.guildId || message?.guild?.id);
  if (guildId && !NON_TOGGLEABLE_COMMANDS.has(parsed.command)) {
    const enabled = await db.isCommandEnabled(guildId, parsed.command);
    if (!enabled) {
      await safeReply(message, `Command is disabled in this server: ${parsed.command}`, {
        title: "Command Disabled",
        kind: "warning"
      });
      return;
    }
  }

  try {
    await handler({
      message,
      args: parsed.args,
      body: parsed.body,
      command: parsed.command
    });
  } catch (error) {
    console.error(`[cmd:${parsed.command}] handler error:`, error);
    await safeReply(message, "Command failed. Please try again later.");
  }
}

function startUptimeServer() {
  if (!config.uptime.enabled) {
    return;
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok\n");
  });

  server.listen(config.uptime.port, config.uptime.host, () => {

  });
}

function buildSlashCommandsData() {
  function getDefaultPermissionForCommand(cmdName) {
    switch (cmdName) {
      case "serverconfig":
      case "setresourcechannels":
      case "setroles":
      case "setverificationurl":
      case "raid":
      case "setraidsettings":
      case "autosetup":
        return PermissionFlags.Administrator;
      case "blacklisted":
      case "reloadwords":
        return PermissionFlags.ManageGuild;
      case "warn":
      case "warnings":
      case "mute":
      case "unmute":
      case "raidgate":
      case "pendingverifications":
      case "raidsnapshot":
        return PermissionFlags.ModerateMembers;
      case "purge":
        return PermissionFlags.ManageMessages;
      case "kick":
        return PermissionFlags.KickMembers;
      case "ban":
      case "unban":
        return PermissionFlags.BanMembers;
      case "role":
      case "addrole":
      case "removerole":
      case "reactionroles":
        return PermissionFlags.ManageRoles;
      default:
        return null;
    }
  }

  function getSlashOptionsForCommand(cmdName) {
    switch (cmdName) {
      case "help":
        return [{ name: "section", description: "Help section (e.g., moderation, leveling, reactionroles)", type: ApplicationCommandOptionType.String, required: false }];
      case "rank":
        return [{ name: "user", description: "Member to check rank for", type: ApplicationCommandOptionType.User, required: false }];
      case "leaderboard":
      case "activityboard":
        return [{ name: "page", description: "Leaderboard page number", type: ApplicationCommandOptionType.Integer, required: false }];
      case "ask":
        return [{ name: "question", description: "Your question for the AI assistant", type: ApplicationCommandOptionType.String, required: true }];
      case "serverconfig":
      case "stats":
      case "joke":
      case "reloadwords":
      case "blacklisted":
      case "reactionroles":
      case "role":
      case "raid":
      case "autosetup":
        return [];
      case "setresourcechannels":
        return [
          { name: "rules", description: "Rules channel", type: ApplicationCommandOptionType.Channel, required: true },
          { name: "chat", description: "General chat channel", type: ApplicationCommandOptionType.Channel, required: true },
          { name: "help", description: "Help and support channel", type: ApplicationCommandOptionType.Channel, required: true },
          { name: "about", description: "Server info and about channel", type: ApplicationCommandOptionType.Channel, required: true },
          { name: "perks", description: "Perks and benefits channel", type: ApplicationCommandOptionType.Channel, required: true }
        ];
      case "setroles":
        return [
          { name: "admin_role", description: "Admin role name", type: ApplicationCommandOptionType.String, required: true },
          { name: "mod_role", description: "Moderator role name", type: ApplicationCommandOptionType.String, required: true }
        ];
      case "setverificationurl":
        return [{ name: "value", description: "Verification URL or 'off' to clear", type: ApplicationCommandOptionType.String, required: true }];
      case "purge":
        return [
          { name: "count", description: "Messages to delete (1-100)", type: ApplicationCommandOptionType.Integer, required: true },
          { name: "channel", description: "Channel to purge", type: ApplicationCommandOptionType.Channel, required: false }
        ];
      case "warnings":
        return [{ name: "user", description: "Member to inspect", type: ApplicationCommandOptionType.User, required: false }];
      case "warn":
        return [
          { name: "user", description: "Member to warn", type: ApplicationCommandOptionType.User, required: true },
          { name: "reason", description: "Reason for the warning", type: ApplicationCommandOptionType.String, required: true }
        ];
      case "kick":
      case "ban":
        return [
          { name: "user", description: "Member to act on", type: ApplicationCommandOptionType.User, required: true },
          { name: "reason", description: "Reason for the action", type: ApplicationCommandOptionType.String, required: false }
        ];
      case "unban":
        return [{ name: "user", description: "Member to unban", type: ApplicationCommandOptionType.User, required: true }];
      case "mute":
        return [
          { name: "user", description: "Member to timeout", type: ApplicationCommandOptionType.User, required: true },
          { name: "duration_minutes", description: "Timeout length in minutes", type: ApplicationCommandOptionType.Integer, required: false },
          { name: "reason", description: "Reason for the timeout", type: ApplicationCommandOptionType.String, required: false }
        ];
      case "unmute":
        return [
          { name: "user", description: "Member to remove timeout from", type: ApplicationCommandOptionType.User, required: true },
          { name: "reason", description: "Reason for removing the timeout", type: ApplicationCommandOptionType.String, required: false }
        ];
      case "addrole":
      case "removerole":
        return [
          { name: "user", description: "Member to update", type: ApplicationCommandOptionType.User, required: true },
          { name: "role", description: "Role to add or remove", type: ApplicationCommandOptionType.Role, required: true }
        ];
      case "pendingverifications":
      case "raidsnapshot":
        return [{ name: "limit", description: "Maximum number of rows to show", type: ApplicationCommandOptionType.Integer, required: false }];
      case "setraidsettings":
      case "raidgate":
        return [];
      default:
        return [];
    }
  }

  const commandDescriptions = {
    help: "Browse interactive command guide by category",
    stats: "View server overview statistics",
    rank: "Check your XP rank in the server",
    leaderboard: "View server XP leaderboard",
    activityboard: "View member activity leaderboard",
    ask: "Ask the AI assistant a question",
    joke: "Get a random AI-generated joke",
    serverconfig: "Show current server configuration",
    setresourcechannels: "Configure resource channel IDs",
    setroles: "Set admin and moderator role names",
    setverificationurl: "Set or clear join verification URL",
    setraidsettings: "Update advanced raid detection thresholds",
    raid: "Open the raid control center",
    autosetup: "Auto-create channels, categories, and map all server config in one command",
    blacklisted: "Manage blacklisted words via dropdown menu",
    reloadwords: "Reload blacklisted words from disk",
    warn: "Issue a warning to a member",
    warnings: "View warnings for a member",
    purge: "Delete recent messages in bulk",
    role: "Manage a member's roles through a dropdown menu",
    addrole: "Add a role to a member",
    removerole: "Remove a role from a member",
    kick: "Remove a member from the server",
    ban: "Ban a member from the server",
    unban: "Remove a member ban",
    mute: "Temporarily timeout a member",
    unmute: "Remove timeout from a member",
    raidgate: "Enable, disable, or inspect raid gate",
    pendingverifications: "View pending member verifications",
    raidsnapshot: "View recent join events and risk scores",
    reactionroles: "Manage reaction role mappings via dropdown menu",
  };

  const hiddenSlashCommands = new Set(["setraidsettings", "raidgate", "raidsnapshot", "addrole", "removerole"]);

  return Object.keys(commandHandlers)
    .filter((cmdName) => !hiddenSlashCommands.has(cmdName))
    .map((cmdName) => {
      const defaultPermission = getDefaultPermissionForCommand(cmdName);
      const commandData = {
        name: cmdName,
        description: commandDescriptions[cmdName] || `Execute the ${cmdName} command`,
        options: getSlashOptionsForCommand(cmdName)
      };

      if (defaultPermission != null) {
        commandData.defaultMemberPermissions = defaultPermission;
      }

      return commandData;
    });
}

const SLASH_COMMANDS_DATA = buildSlashCommandsData();

async function registerSlashCommandsForGuild(readyClient, commandsData, guildId) {
  const normalizedGuildId = parseSnowflake(guildId);
  if (!normalizedGuildId) {
    return false;
  }

  try {
    const guild = readyClient.guilds?.cache?.get(normalizedGuildId) || (await readyClient.guilds.fetch(normalizedGuildId));
    await guild.commands.set(commandsData);
    return true;
  } catch (error) {

    return false;
  }
}

async function registerSlashCommandsAcrossGuilds(readyClient, commandsData, preferredGuildId = null) {
  const guildIdSet = new Set();

  const normalizedPreferredGuildId = parseSnowflake(preferredGuildId);
  if (normalizedPreferredGuildId) {
    guildIdSet.add(normalizedPreferredGuildId);
  }

  for (const guild of readyClient.guilds?.cache?.values?.() || []) {
    if (guild?.id) {
      guildIdSet.add(guild.id);
    }
  }

  if (guildIdSet.size === 0) {
    try {
      const fetchedGuilds = await readyClient.guilds.fetch();
      for (const guildRef of fetchedGuilds.values()) {
        if (guildRef?.id) {
          guildIdSet.add(guildRef.id);
        }
      }
    } catch (error) {

    }
  }

  if (guildIdSet.size === 0) {

    return;
  }

  let successCount = 0;
  for (const guildId of guildIdSet) {
    if (await registerSlashCommandsForGuild(readyClient, commandsData, guildId)) {
      successCount += 1;
    }
  }
}

client.once(Events.ClientReady, async (readyClient) => {


  try {
    await registerSlashCommandsAcrossGuilds(readyClient, SLASH_COMMANDS_DATA, process.env.SLASH_SYNC_GUILD_ID || SLASH_SYNC_GUILD_ID);
    await startRaidProtectionMonitor();
  } catch (err) {

  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Handle modal submissions for blacklisted word management and reaction roles
  if (interaction.isModalSubmit()) {
    try {
      if (interaction.customId === 'blacklist_add_modal') {
        const guild = await resolveGuildFromMessage(interaction);
        if (!guild) {
          return interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral });
        }
        const isOwner = String(guild.ownerId || '') === String(interaction.user?.id || '');
        const hasManageGuildPermission = Boolean(
          interaction.member?.permissions?.has(PermissionFlags.ManageGuild) ||
          interaction.member?.permissions?.has(PermissionFlags.Administrator)
        );
        if (!isOwner && !hasManageGuildPermission) {
          return interaction.reply({ content: 'You lack permission to manage blacklisted words.', flags: MessageFlags.Ephemeral });
        }

        const word = interaction.fields.getTextInputValue('word_input');
        if (!word?.trim()) {
          return interaction.reply({ content: 'Word cannot be empty.', flags: MessageFlags.Ephemeral });
        }
        const created = wordStore.add(word.trim());
        const msg = created ? `✅ Blacklisted word added: **${word}**` : `ℹ️ Word already blacklisted: **${word}**`;
        return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      } 
      
      if (interaction.customId === 'blacklist_remove_modal') {
        const guild = await resolveGuildFromMessage(interaction);
        if (!guild) {
          return interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral });
        }
        const isOwner = String(guild.ownerId || '') === String(interaction.user?.id || '');
        const hasManageGuildPermission = Boolean(
          interaction.member?.permissions?.has(PermissionFlags.ManageGuild) ||
          interaction.member?.permissions?.has(PermissionFlags.Administrator)
        );
        if (!isOwner && !hasManageGuildPermission) {
          return interaction.reply({ content: 'You lack permission to manage blacklisted words.', flags: MessageFlags.Ephemeral });
        }

        const word = interaction.fields.getTextInputValue('word_input');
        if (!word?.trim()) {
          return interaction.reply({ content: 'Word cannot be empty.', flags: MessageFlags.Ephemeral });
        }
        const deleted = wordStore.remove(word.trim());
        const msg = deleted ? `✅ Blacklisted word removed: **${word}**` : `⚠️ Word not found in blacklist: **${word}**`;
        return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      } 

      if (interaction.customId === 'role_add_modal' || interaction.customId === 'role_remove_modal') {
        const guild = await resolveGuildFromMessage(interaction);
        if (!guild) {
          return interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral });
        }
        const isOwner = String(guild.ownerId || '') === String(interaction.user?.id || '');
        const hasManageRolesPermission = Boolean(
          interaction.member?.permissions?.has(PermissionFlags.ManageRoles) ||
          interaction.member?.permissions?.has(PermissionFlags.Administrator)
        );
        if (!isOwner && !hasManageRolesPermission) {
          return interaction.reply({ content: 'You lack permission to manage roles.', flags: MessageFlags.Ephemeral });
        }

        const userId = parseUserIdArg(interaction.fields.getTextInputValue('user_input'));
        const roleText = interaction.fields.getTextInputValue('role_input');
        if (!userId || !roleText?.trim()) {
          return interaction.reply({ content: 'User and role are required.', flags: MessageFlags.Ephemeral });
        }

        const roleId = await guild.resolveRoleId(roleText.trim());
        if (!roleId) {
          return interaction.reply({ content: 'Role not found.', flags: MessageFlags.Ephemeral });
        }

        const targetMember = await resolveGuildMember(guild, userId);
        if (!targetMember) {
          return interaction.reply({ content: 'Member not found in this server.', flags: MessageFlags.Ephemeral });
        }

        const actorMember = interaction.member || (await resolveGuildMember(guild, interaction.user.id));
        if (!targetMember.manageable) {
          return interaction.reply({ content: 'I cannot manage that member because their role is higher than mine.', flags: MessageFlags.Ephemeral });
        }

        if (!canManageTargetRole(actorMember, targetMember, guild)) {
          return interaction.reply({ content: 'You need a higher role or administrator access to manage that member.', flags: MessageFlags.Ephemeral });
        }

        const action = interaction.customId === 'role_add_modal' ? 'add_role' : 'remove_role';
        const change = action === 'add_role'
          ? await targetMember.roles.add(roleId)
          : await targetMember.roles.remove(roleId);

        await db.logModerationAction({
          guildId: guild.id,
          action,
          actorUserId: interaction.user.id,
          targetUserId: userId,
          reason: `role_id=${roleId}`,
          metadata: { role_id: roleId }
        });

        return interaction.reply({
          content: action === 'add_role'
            ? `✅ Added role <@&${roleId}> to ${formatUserMention(userId)}.`
            : `✅ Removed role <@&${roleId}> from ${formatUserMention(userId)}.`,
          flags: MessageFlags.Ephemeral
        });
      }
      
      if (interaction.customId === 'reactionrole_add_modal') {
        const guild = await resolveGuildFromMessage(interaction);
        if (!guild) {
          return interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral });
        }
        const isOwner = String(guild.ownerId || '') === String(interaction.user?.id || '');
        const hasManageRolesPermission = Boolean(
          interaction.member?.permissions?.has(PermissionFlags.ManageRoles) ||
          interaction.member?.permissions?.has(PermissionFlags.Administrator)
        );
        if (!isOwner && !hasManageRolesPermission) {
          return interaction.reply({ content: 'You lack permission to manage reaction roles.', flags: MessageFlags.Ephemeral });
        }

        const panelTitle = String(interaction.fields.getTextInputValue('panel_title') || '').trim();
        const panelContent = String(interaction.fields.getTextInputValue('panel_content') || '').trim();
        const emojiInput = String(interaction.fields.getTextInputValue('emoji_input') || '').trim();

        if (!panelTitle || !panelContent || !emojiInput) {
          return interaction.reply({ content: 'All fields are required.', flags: MessageFlags.Ephemeral });
        }

        let normalizedEmoji;
        try {
          normalizedEmoji = normalizeEmojiInput(emojiInput);
        } catch (error) {
          return interaction.reply({ content: String(error?.message || 'Invalid emoji.'), flags: MessageFlags.Ephemeral });
        }

        if (!interaction.channel || typeof interaction.channel.send !== 'function') {
          return interaction.reply({ content: 'I cannot post the panel in this channel.', flags: MessageFlags.Ephemeral });
        }

        const roleSelectRow = new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder()
            .setCustomId('reactionrole_pick_role')
            .setPlaceholder('Choose the role for this panel')
            .setMinValues(1)
            .setMaxValues(1)
        );

        const sent = await interaction.reply({
          content: 'Choose the role to connect to this new reaction-role panel:',
          components: [roleSelectRow],
          flags: MessageFlags.Ephemeral
        });

        // Fetch the reply message to set up the collector
        const replyMessage = await interaction.fetchReply().catch(() => null);
        if (!replyMessage || typeof replyMessage.createMessageComponentCollector !== 'function') {
          return;
        }

        const roleSelectCollector = replyMessage.createMessageComponentCollector({
          componentType: ComponentType.RoleSelect,
          time: 120000
        });

        roleSelectCollector.on('collect', async (selection) => {
          if (selection.customId !== 'reactionrole_pick_role') {
            return selection.deferUpdate();
          }

          await selection.deferUpdate();

          const selectedRoleId = String(selection.values?.[0] || '').trim();
          if (!selectedRoleId) {
            return selection.followUp({ content: 'Pick a role first.', flags: MessageFlags.Ephemeral });
          }

          const role = await guild.roles.fetch(selectedRoleId).catch(() => null);
          if (!role) {
            return selection.followUp({ content: 'That role could not be resolved.', flags: MessageFlags.Ephemeral });
          }

          const panelEmbed = buildReactionRolePanelEmbed({
            title: panelTitle,
            content: panelContent,
            emojiDisplay: normalizedEmoji.display,
            roleMention: `<@&${role.id}>`
          });

          let panelMessage = null;
          try {
            panelMessage = await interaction.channel.send({ embeds: [panelEmbed] });
          } catch (error) {
            return selection.followUp({ content: `I could not send the panel: ${String(error?.message || error)}`, flags: MessageFlags.Ephemeral });
          }

          try {
            await panelMessage.react(normalizedEmoji.reactionValue);
          } catch {
            // best effort; the mapping can still be configured if the emoji is valid for reaction handling.
          }



          await db.addReactionRole({
            guildId: interaction.guildId,
            channelId: panelMessage.channelId,
            messageId: panelMessage.id,
            emojiKey: normalizedEmoji.key,
            emojiDisplay: normalizedEmoji.display,
            roleId: role.id,
            createdByUserId: interaction.user.id
          });

          pendingReactionRolePanels.set(interaction.user.id, {
            guildId: interaction.guildId,
            channelId: panelMessage.channelId,
            messageId: panelMessage.id,
            emojiDisplay: normalizedEmoji.display,
            roleId: role.id
          });

          await selection.editReply({
            content: `✅ Posted the reaction role panel and connected ${normalizedEmoji.display} to <@&${role.id}>. Logs will show if reactions work.`,
            components: []
          });
        });

        roleSelectCollector.on('end', () => {
          pendingReactionRolePanels.delete(interaction.user.id);
        });
        return;
      }

      if (interaction.customId === 'reactionrole_remove_modal') {
        return interaction.reply({ content: 'Use the reaction role dropdown menu to remove mappings.', flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'raid_config_modal') {
        const guild = await resolveGuildFromMessage(interaction);
        if (!guild) {
          return interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral });
        }
        const isOwner = String(guild.ownerId || '') === String(interaction.user?.id || '');
        const hasAdminPermission = Boolean(
          interaction.member?.permissions?.has(PermissionFlags.Administrator)
        );
        if (!isOwner && !hasAdminPermission) {
          return interaction.reply({ content: 'You need administrator permission to update raid settings.', flags: MessageFlags.Ephemeral });
        }

        const threshold = Math.max(0, Math.min(Number(interaction.fields.getTextInputValue('raid_gate_threshold')), 1));
        const joinRateThreshold = Math.max(1, Math.min(Number(interaction.fields.getTextInputValue('raid_join_rate_threshold')), 1000));
        const windowSeconds = Math.max(30, Math.min(Number(interaction.fields.getTextInputValue('raid_monitor_window_seconds')), 3600));
        const gateDurationSeconds = Math.max(60, Math.min(Number(interaction.fields.getTextInputValue('gate_duration_seconds')), 86400));
        const mode = String(interaction.fields.getTextInputValue('join_gate_mode') || 'timeout').trim().toLowerCase() === 'kick' ? 'kick' : 'timeout';

        await db.updateGuildConfig(guild.id, {
          raid_gate_threshold: threshold,
          raid_join_rate_threshold: joinRateThreshold,
          raid_monitor_window_seconds: windowSeconds,
          gate_duration_seconds: gateDurationSeconds,
          join_gate_mode: mode
        });

        return interaction.reply({
          content: `✅ Raid controls updated: threshold=${threshold}, join_rate=${joinRateThreshold}, window=${windowSeconds}s, duration=${gateDurationSeconds}s, mode=${mode}.`,
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (err) {

      try {
        return interaction.reply({ content: `Error: ${String(err).slice(0, 100)}`, flags: MessageFlags.Ephemeral });
      } catch {
        // Silently fail if we can't even send the error
      }
    }
    return;
  }

  if (interaction.isButton()) {
    const handled = await handlePaginatedButtonInteraction(interaction);
    if (handled) {
      return;
    }
  }

  if (interaction.isChannelSelectMenu()) {
     return; // Handled by message collectors locally
  }
  
  if (!interaction.isChatInputCommand()) return;

  const cmdName = interaction.commandName;
  const handler = commandHandlers[cmdName];
  if (!handler) return;
  const shouldUseEphemeral = cmdName === "help";

  // Acknowledge quickly so slower commands (like image rendering) do not hit Unknown interaction.
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply(
        shouldUseEphemeral ? { flags: MessageFlags.Ephemeral } : {}
      );
    }
  } catch (error) {
    if (error?.code !== 40060) {

    }
  }

  // Build input string from provided slash options (different commands expose different option names)
  let inputStr = "";
  try {
    const parts = [];
    const opts = interaction.options?.data || [];
    for (const o of opts) {
      if (!o) continue;
      parts.push(String(o.value));
    }
    inputStr = parts.join(" ");
  } catch {
    inputStr = interaction.options.getString('input') || "";
  }

  const args = inputStr ? inputStr.trim().split(/\s+/) : [];
  
  const fakeMessage = {
    author: interaction.user,
    member: interaction.member,
    memberPermissions: interaction.memberPermissions,
    guildId: interaction.guildId,
    guild: interaction.guild,
    channelId: interaction.channelId,
    channel: interaction.channel,
    content: `/${cmdName} ${inputStr}`,
    reply: async (payload) => {
       const interactionPayload =
         shouldUseEphemeral
           ? { ...payload, flags: MessageFlags.Ephemeral }
           : payload;

       try {
         // Try reply first (works if interaction hasn't been acknowledged)
         if (!interaction.replied && !interaction.deferred) {
            return await interaction.reply(interactionPayload);
         }
         
         // If already deferred, use editReply
         if (interaction.deferred && !interaction.replied) {
            const { flags, ephemeral, fetchReply, withResponse, ...editPayload } = interactionPayload || {};
            return await interaction.editReply(editPayload);
         }
         
         // If already replied, use followUp
         if (interaction.replied) {
            return await interaction.followUp(interactionPayload);
         }
      } catch (err) {
        // Handle "already acknowledged" error gracefully
        if (err?.code === 40060) {
           try {
              return await interaction.followUp(interactionPayload);
            } catch {
              return null; // Silently fail if followUp also fails
            }
        }
        if (err?.code === 10062) {
          return null;
        }
        throw err;
      }
    }
  };

  const guildId = interaction.guildId;
  if (guildId && !NON_TOGGLEABLE_COMMANDS.has(cmdName)) {
    const enabled = await db.isCommandEnabled(guildId, cmdName);
    if (!enabled) {
      await safeReply(fakeMessage, `Command is disabled in this server: ${cmdName}`, {
        title: "Command Disabled",
        kind: "warning"
      });
      return;
    }
  }

  try {
    await handler({
      message: fakeMessage,
      args,
      body: inputStr,
      command: cmdName
    });
  } catch (error) {
    console.error(`[slash:${cmdName}] handler error:`, error);
    await safeReply(fakeMessage, "Command failed. Please try again later.");
  }
});

client.on(Events.GuildCreate, async (guild) => {
  try {
    if (!guild || !guild.id) return;
    logInfo(`Joined new guild: ${guild.name || guild.id} (${guild.id})`);
    
    // Dynamically initialize configuration
    await getCachedGuildConfig(guild.id);

    await registerSlashCommandsForGuild(client, SLASH_COMMANDS_DATA, guild.id);

    // Warm up caches for seamless dynamic performance
    await Promise.allSettled([
      typeof guild.channels?.fetch === "function" ? guild.channels.fetch() : null,
      typeof guild.roles?.fetch === "function" ? guild.roles.fetch() : null,
      typeof guild.emojis?.fetch === "function" ? guild.emojis.fetch() : null
    ]);
  } catch (error) {

  }
});

client.on(Events.Error, (error) => {

});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await handleMemberJoin(member);
  } catch (error) {

  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (reaction.partial) {
      await reaction.fetch();
    }

    const resolvedUserId = user?.id || reaction?.users?.cache?.lastKey?.() || null;
    const emoji = reaction?.emoji ?? null;
    const messageId = reaction?.message?.id || null;
    const channelId = reaction?.message?.channelId || null;

    await Promise.allSettled([
      applyReactionRole(reaction, emoji, resolvedUserId, channelId, messageId, false),
      handleReactionTicketCreate(reaction, user, messageId, channelId, emoji, resolvedUserId)
    ]);
  } catch (error) {

  }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  try {
    if (reaction.partial) {
      await reaction.fetch();
    }

    const resolvedUserId = user?.id || null;
    const emoji = reaction?.emoji ?? null;
    const messageId = reaction?.message?.id || null;
    const channelId = reaction?.message?.channelId || null;

    await applyReactionRole(reaction, emoji, resolvedUserId, channelId, messageId, true);
  } catch (error) {

  }
});

const activeVoiceSessions = new Map();

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const guildId = newState?.guildId || oldState?.guildId;
    const userId = newState?.userId || oldState?.userId || newState?.id || oldState?.id;
    if (!guildId || !userId) return;

    if (newState?.member?.user?.bot || oldState?.member?.user?.bot) {
      return;
    }

    const oldChannelId = oldState?.channelId;
    const newChannelId = newState?.channelId;
    const sessionKey = `${guildId}_${userId}`;

    if (!oldChannelId && newChannelId) {
      activeVoiceSessions.set(sessionKey, Date.now());
    } else if (oldChannelId && !newChannelId) {
      const joinedAt = activeVoiceSessions.get(sessionKey);
      if (joinedAt) {
        const durationSecs = Math.floor((Date.now() - joinedAt) / 1000);
        activeVoiceSessions.delete(sessionKey);
        await db.addVoiceTime(guildId, userId, durationSecs);
      }
    }
  } catch (error) {

  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) {
      return;
    }

    const guild = message.guildId ? await resolveGuildFromMessage(message) : null;
    const authorIsStaff = guild && config.automod.spamDetectionEnabled ? await isStaffMember(message) : false;
    const messageContext = {
      guild,
      authorIsStaff
    };

    const spamBlocked = await handleSpamModeration(message, messageContext);
    if (spamBlocked) {
      return;
    }

    const blocked = await handleWordModeration(message, messageContext);
    if (blocked) {
      return;
    }

    const parsed = parsePrefixedCommand(message.content);
    await handleLevelingMessage(message, parsed, messageContext);

    if (!parsed) {
      return;
    }

    await executeCommand(parsed, message);
  } catch (error) {

  }
});

async function start() {
  startUptimeServer();

  if (raidMlClient.enabled) {
    await updateRaidMlHealthState({ startup: true });
    startRaidMlHealthMonitor();
  }

  await client.login(config.botToken);
}

start().catch((error) => {

  process.exitCode = 1;
});


