import prismaClientPkg from "@prisma/client";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const { PrismaClient } = prismaClientPkg;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function nowIso() {
  return new Date().toISOString();
}

function toSnowflakeText(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return value.toString();
  const text = String(value).trim();
  return /^\d{5,22}$/.test(text) ? text : null;
}

function toInteger(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === "bigint") return Number(value);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFloat(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  return toInteger(value, 0) !== 0;
}

function parseMetadata(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const DEFAULT_WELCOME_MESSAGE_TEMPLATE = "Welcome {user.mention} to {guild.name}.";
const DEFAULT_LEVELUP_MESSAGE_TEMPLATE = "Level Up: {user.mention} reached level {level}. Rank #{rank}.";
const DEFAULT_KICK_MESSAGE_TEMPLATE = "Kicked {user.mention}. Reason: {reason}.";
const DEFAULT_BAN_MESSAGE_TEMPLATE = "Banned {user.mention}. Reason: {reason}.";
const DEFAULT_MUTE_MESSAGE_TEMPLATE = "{user.mention} muted for {duration_minutes} minute(s). Reason: {reason}.";

function normalizeTemplateText(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeColor(value, fallback) {
  const text = String(value ?? "").trim();
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(text)) return text.toLowerCase();
  return fallback;
}

function normalizeCommandName(commandName) {
  return String(commandName || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function xpRequiredForNextLevel(level) {
  const normalized = Math.max(0, toInteger(level, 0));
  return 5 * normalized * normalized + 50 * normalized + 100;
}

function totalXpForLevel(level) {
  const targetLevel = Math.max(0, toInteger(level, 0));
  let total = 0;
  for (let current = 0; current < targetLevel; current += 1) {
    total += xpRequiredForNextLevel(current);
  }
  return total;
}

function levelFromTotalXp(totalXp) {
  let level = 0;
  let remainingXp = Math.max(0, toInteger(totalXp, 0));
  while (remainingXp >= xpRequiredForNextLevel(level) && level < 1000) {
    remainingXp -= xpRequiredForNextLevel(level);
    level += 1;
  }
  return level;
}

function buildLevelProgress(totalXp, level) {
  const normalizedXp = Math.max(0, toInteger(totalXp, 0));
  const normalizedLevel = Math.max(0, toInteger(level, 0));
  const currentLevelXp = totalXpForLevel(normalizedLevel);
  const nextLevelXp = totalXpForLevel(normalizedLevel + 1);
  const progressXp = Math.max(0, normalizedXp - currentLevelXp);
  const progressRequired = Math.max(1, nextLevelXp - currentLevelXp);
  const progressPercent = Math.max(0, Math.min(Math.round((progressXp / progressRequired) * 100), 100));
  return { currentLevelXp, nextLevelXp, progressXp, progressRequired, progressPercent };
}

export class PrismaBotDatabase {
  constructor() {
    this.initPromise = this.ensureInitialized();
  }

  async ensureInitialized() {
    // Prisma connects automatically on first query, but we can do a dummy query.
    try {
      await prisma.$connect();
    } catch (e) {
      console.error("Prisma connect error", e);
    }
  }

  async ensureGuildConfig(guildId) {
    const id = toSnowflakeText(guildId);
    if (!id) throw new Error("invalid guild id");

    await prisma.guildConfig.upsert({
      where: { guild_id: id },
      update: {},
      create: { guild_id: id }
    });
  }

  async getGuildConfig(guildId) {
    await this.ensureGuildConfig(guildId);
    const row = await prisma.guildConfig.findUnique({ where: { guild_id: guildId } });
    if (!row) throw new Error("missing guild config row");

    return {
      ...row,
      welcome_message_template: normalizeTemplateText(row.welcome_message_template, DEFAULT_WELCOME_MESSAGE_TEMPLATE),
      levelup_message_template: normalizeTemplateText(row.levelup_message_template, DEFAULT_LEVELUP_MESSAGE_TEMPLATE),
      kick_message_template: normalizeTemplateText(row.kick_message_template, DEFAULT_KICK_MESSAGE_TEMPLATE),
      ban_message_template: normalizeTemplateText(row.ban_message_template, DEFAULT_BAN_MESSAGE_TEMPLATE),
      mute_message_template: normalizeTemplateText(row.mute_message_template, DEFAULT_MUTE_MESSAGE_TEMPLATE)
    };
  }

  async updateGuildConfig(guildId, updates) {
    await this.ensureGuildConfig(guildId);
    await prisma.guildConfig.update({
      where: { guild_id: guildId },
      data: updates
    });
    return this.getGuildConfig(guildId);
  }

  async getWarningCount(guildId, userId) {
    const row = await prisma.warning.findUnique({
      where: { guild_id_user_id: { guild_id: guildId, user_id: userId } }
    });
    return row ? toInteger(row.warning_count, 0) : 0;
  }

  async incrementWarning(guildId, userId, reason, actorUserId = null) {
    const now = nowIso();
    const current = await this.getWarningCount(guildId, userId);
    const next = current + 1;

    await prisma.warning.upsert({
      where: { guild_id_user_id: { guild_id: guildId, user_id: userId } },
      update: { warning_count: next, updated_at: now },
      create: { guild_id: guildId, user_id: userId, warning_count: next, updated_at: now }
    });

    await prisma.warningEvent.create({
      data: { guild_id: guildId, user_id: userId, actor_user_id: actorUserId, reason, created_at: now }
    });

    return next;
  }

  async resetWarnings(guildId, userId) {
    try {
      await prisma.warning.delete({
        where: { guild_id_user_id: { guild_id: guildId, user_id: userId } }
      });
    } catch {} // Ignore if it doesn't exist
  }

  async listWarningCounts(guildId, limit = 50) {
    const rows = await prisma.warning.findMany({
      where: { guild_id: guildId },
      orderBy: [{ warning_count: 'desc' }, { updated_at: 'desc' }],
      take: Math.max(1, Math.min(toInteger(limit, 50), 200))
    });
    return rows.map(r => ({
      user_id: r.user_id,
      warning_count: r.warning_count,
      updated_at: r.updated_at
    }));
  }

  async listKnownGuildIds(limit = 1000) {
    const rows = await prisma.guildConfig.findMany({
      orderBy: { guild_id: 'asc' },
      take: Math.max(1, Math.min(toInteger(limit, 1000), 10000)),
      select: { guild_id: true }
    });
    return rows.map(r => r.guild_id);
  }

  async isCommandEnabled(guildId, commandName) {
    const normalizedCommand = normalizeCommandName(commandName);
    const row = await prisma.commandToggle.findUnique({
      where: { guild_id_command_name: { guild_id: guildId, command_name: normalizedCommand } }
    });
    return row ? row.enabled : true;
  }

  async setCommandEnabled(guildId, commandName, enabled) {
    const normalizedCommand = normalizeCommandName(commandName);
    await prisma.commandToggle.upsert({
      where: { guild_id_command_name: { guild_id: guildId, command_name: normalizedCommand } },
      update: { enabled: !!enabled, updated_at: nowIso() },
      create: { guild_id: guildId, command_name: normalizedCommand, enabled: !!enabled, updated_at: nowIso() }
    });
    return enabled;
  }

  async logModerationAction({ guildId, action, actorUserId = null, targetUserId = null, reason = null, channelId = null, messageId = null, metadata = null }) {
    await prisma.moderationLog.create({
      data: {
        guild_id: guildId,
        actor_user_id: actorUserId,
        target_user_id: targetUserId,
        action,
        reason,
        channel_id: channelId,
        message_id: messageId,
        metadata: metadata ? JSON.stringify(metadata) : null,
        created_at: nowIso()
      }
    });
  }

  async getMemberLevel(guildId, userId) {
    const row = await prisma.memberLevel.findUnique({
      where: { guild_id_user_id: { guild_id: guildId, user_id: userId } }
    });

    const xp = Math.max(0, toInteger(row?.xp, 0));
    const level = Math.max(0, toInteger(row?.level, levelFromTotalXp(xp)));
    const progress = buildLevelProgress(xp, level);

    return {
      guild_id: guildId,
      user_id: userId,
      xp,
      level,
      message_count: Math.max(0, toInteger(row?.message_count, 0)),
      last_xp_at: row?.last_xp_at,
      updated_at: row?.updated_at,
      current_level_xp: progress.currentLevelXp,
      next_level_xp: progress.nextLevelXp,
      progress_xp: progress.progressXp,
      progress_required: progress.progressRequired,
      progress_percent: progress.progressPercent
    };
  }

  async upsertVerificationMember({ guildId, userId, status, riskScore, verificationUrl = null, reason, verifiedByUserId = null }) {
    const now = nowIso();
    await prisma.verificationQueue.upsert({
      where: { guild_id_user_id: { guild_id: guildId, user_id: userId } },
      update: { status, risk_score: riskScore, verification_url: verificationUrl, reason, updated_at: now, verified_by_user_id: verifiedByUserId },
      create: { guild_id: guildId, user_id: userId, status, risk_score: riskScore, verification_url: verificationUrl, reason, created_at: now, updated_at: now, verified_by_user_id: verifiedByUserId }
    });
  }

  async getVerificationStatus(guildId, userId) {
    const row = await prisma.verificationQueue.findUnique({
      where: { guild_id_user_id: { guild_id: guildId, user_id: userId } }
    });
    if (!row) return null;
    return {
      status: String(row.status || "pending"),
      risk_score: toFloat(row.risk_score, 0),
      verification_url: row.verification_url == null ? null : String(row.verification_url),
      reason: String(row.reason || ""),
      created_at: String(row.created_at || nowIso()),
      updated_at: String(row.updated_at || nowIso()),
      verified_by_user_id: toSnowflakeText(row.verified_by_user_id)
    };
  }

  async isMemberPendingVerification(guildId, userId) {
    const status = await this.getVerificationStatus(guildId, userId);
    return status != null && status.status === "pending";
  }

  async listPendingVerifications(guildId, limit = 20) {
    const rows = await prisma.verificationQueue.findMany({
      where: { guild_id: guildId, status: "pending" },
      orderBy: { updated_at: 'desc' },
      take: Math.max(1, Math.min(toInteger(limit, 20), 50))
    });
    return rows.map(row => ({
      user_id: row.user_id,
      status: row.status,
      risk_score: toFloat(row.risk_score, 0),
      verification_url: row.verification_url,
      reason: row.reason,
      created_at: row.created_at,
      updated_at: row.updated_at,
      verified_by_user_id: row.verified_by_user_id
    }));
  }

  async setRaidGateState(guildId, gateActive, reason = null, gateUntil = null) {
    await prisma.raidState.upsert({
      where: { guild_id: guildId },
      update: { gate_active: !!gateActive, gate_reason: reason, gate_until: gateUntil, updated_at: nowIso() },
      create: { guild_id: guildId, gate_active: !!gateActive, gate_reason: reason, gate_until: gateUntil, updated_at: nowIso() }
    });
  }

  async setRaidLockdownState(guildId, lockdownActive, reason = null, lockdownUntil = null, snapshot = null) {
    await prisma.raidState.upsert({
      where: { guild_id: guildId },
      update: { lockdown_active: !!lockdownActive, lockdown_reason: reason, lockdown_until: lockdownUntil, lockdown_snapshot: snapshot, lockdown_updated_at: nowIso() },
      create: { guild_id: guildId, lockdown_active: !!lockdownActive, lockdown_reason: reason, lockdown_until: lockdownUntil, lockdown_snapshot: snapshot, lockdown_updated_at: nowIso() }
    });
  }

  async getRaidLockdownState(guildId) {
    const row = await prisma.raidState.findUnique({ where: { guild_id: guildId } });
    if (!row) {
      return { lockdown_active: false, lockdown_reason: null, lockdown_until: null, lockdown_snapshot: null, lockdown_updated_at: null };
    }
    return {
      lockdown_active: toBoolean(row.lockdown_active),
      lockdown_reason: row.lockdown_reason,
      lockdown_until: row.lockdown_until,
      lockdown_snapshot: row.lockdown_snapshot,
      lockdown_updated_at: row.lockdown_updated_at
    };
  }

  async getRaidGateState(guildId) {
    const row = await prisma.raidState.findUnique({ where: { guild_id: guildId } });
    if (!row) {
      return { gate_active: false, gate_reason: null, gate_until: null, updated_at: null };
    }
    return {
      gate_active: toBoolean(row.gate_active),
      gate_reason: row.gate_reason,
      gate_until: row.gate_until,
      updated_at: row.updated_at
    };
  }

  async logJoinEvent({ guildId, userId, accountAgeDays, hasAvatar, profileScore, joinRate, youngAccountRatio, riskScore, riskLevel, action, metadata }) {
    await prisma.joinEvent.create({
      data: {
        guild_id: guildId, user_id: userId, account_age_days: accountAgeDays, has_avatar: !!hasAvatar,
        profile_score: profileScore, join_rate: joinRate, young_account_ratio: youngAccountRatio,
        risk_score: riskScore, risk_level: riskLevel, action, metadata: metadata ? JSON.stringify(metadata) : null,
        created_at: nowIso()
      }
    });
  }

  async listRecentJoinEvents(guildId, limit = 20) {
    const rows = await prisma.joinEvent.findMany({
      where: { guild_id: guildId },
      orderBy: { id: 'desc' },
      take: Math.max(1, Math.min(toInteger(limit, 20), 100))
    });
    return rows.map(row => ({
      user_id: row.user_id,
      risk_score: toFloat(row.risk_score, 0),
      risk_level: row.risk_level,
      action: row.action,
      metadata: parseMetadata(row.metadata),
      created_at: row.created_at
    }));
  }

  async ensureMemberLevelRow(guildId, userId) {
    await prisma.memberLevel.upsert({
      where: { guild_id_user_id: { guild_id: guildId, user_id: userId } },
      update: {},
      create: { guild_id: guildId, user_id: userId, updated_at: nowIso() }
    });
  }

  async addMemberXp({ guildId, userId, xpGain, cooldownSeconds = 45 }) {
    return await prisma.$transaction(async (tx) => {
      let row = await tx.memberLevel.findUnique({
        where: { guild_id_user_id: { guild_id: guildId, user_id: userId } }
      });
      if (!row) {
        row = await tx.memberLevel.create({
          data: { guild_id: guildId, user_id: userId, updated_at: nowIso() }
        });
      }

      const now = new Date();
      const nowText = now.toISOString();
      const previousXp = Math.max(0, toInteger(row.xp, 0));
      const previousLevel = Math.max(0, toInteger(row.level, levelFromTotalXp(previousXp)));
      const previousMessageCount = Math.max(0, toInteger(row.message_count, 0));
      const cooldownMs = Math.max(0, toInteger(cooldownSeconds, 45)) * 1000;
      const lastXpAt = row.last_xp_at;
      const lastXpAtMs = lastXpAt ? Date.parse(lastXpAt) : NaN;
      const cooldownActive = cooldownMs > 0 && Number.isFinite(lastXpAtMs) && now.getTime() - lastXpAtMs < cooldownMs;

      const appliedXp = cooldownActive ? 0 : Math.max(0, toInteger(xpGain, 0));
      const totalXp = previousXp + appliedXp;
      const level = levelFromTotalXp(totalXp);
      const messageCount = previousMessageCount + 1;
      const leveledUp = level > previousLevel;
      const progress = buildLevelProgress(totalXp, level);
      const cooldownRemainingSeconds = cooldownActive && Number.isFinite(lastXpAtMs)
          ? Math.max(0, Math.ceil((cooldownMs - (now.getTime() - lastXpAtMs)) / 1000))
          : 0;

      await tx.memberLevel.update({
        where: { guild_id_user_id: { guild_id: guildId, user_id: userId } },
        data: {
          xp: totalXp, level, message_count: messageCount,
          last_xp_at: appliedXp > 0 ? nowText : lastXpAt,
          updated_at: nowText
        }
      });

      return {
        guild_id: guildId, user_id: userId, xp: totalXp, level, previous_level: previousLevel,
        previous_xp: previousXp, applied_xp: appliedXp, message_count: messageCount,
        leveled_up: leveledUp, cooldown_active: cooldownActive,
        cooldown_remaining_seconds: cooldownRemainingSeconds,
        current_level_xp: progress.currentLevelXp, next_level_xp: progress.nextLevelXp,
        progress_xp: progress.progressXp, progress_required: progress.progressRequired,
        progress_percent: progress.progressPercent
      };
    });
  }

  async getMemberLevelRank(guildId, userId) {
    const levelData = await this.getMemberLevel(guildId, userId);
    const aheadCount = await prisma.memberLevel.count({
      where: {
        guild_id: guildId,
        OR: [
          { level: { gt: levelData.level } },
          { level: levelData.level, xp: { gt: levelData.xp } },
          { level: levelData.level, xp: levelData.xp, message_count: { gt: levelData.message_count } },
          { level: levelData.level, xp: levelData.xp, message_count: levelData.message_count, user_id: { lt: levelData.user_id } }
        ]
      }
    });
    return aheadCount + 1;
  }

  async getLevelMemberCount(guildId) {
    return await prisma.memberLevel.count({ where: { guild_id: guildId } });
  }

  async listLevelLeaderboard(guildId, limit = 10, offset = 0) {
    const normalizedLimit = Math.max(1, Math.min(toInteger(limit, 10), 50));
    const normalizedOffset = Math.max(0, toInteger(offset, 0));
    const rows = await prisma.memberLevel.findMany({
      where: { guild_id: guildId },
      orderBy: [{ level: 'desc' }, { xp: 'desc' }, { message_count: 'desc' }, { user_id: 'asc' }],
      take: normalizedLimit,
      skip: normalizedOffset
    });

    return rows.map((row, index) => {
      const xp = Math.max(0, toInteger(row.xp, 0));
      const level = Math.max(0, toInteger(row.level, levelFromTotalXp(xp)));
      const progress = buildLevelProgress(xp, level);
      return {
        rank: normalizedOffset + index + 1,
        user_id: row.user_id, xp, level, message_count: row.message_count,
        last_xp_at: row.last_xp_at, updated_at: row.updated_at,
        current_level_xp: progress.currentLevelXp, next_level_xp: progress.nextLevelXp,
        progress_xp: progress.progressXp, progress_required: progress.progressRequired,
        progress_percent: progress.progressPercent
      };
    });
  }

  async addVoiceTime(guildId, userId, seconds) {
    const amount = Math.max(0, toInteger(seconds, 0));
    if (amount <= 0) return;
    await prisma.memberLevel.updateMany({
      where: { guild_id: guildId, user_id: userId },
      data: { voice_seconds: { increment: amount }, updated_at: nowIso() }
    });
  }

  async listActivityLeaderboard(guildId, limit = 10, offset = 0) {
    const normalizedLimit = Math.max(1, Math.min(toInteger(limit, 10), 50));
    const normalizedOffset = Math.max(0, toInteger(offset, 0));
    const rows = await prisma.memberLevel.findMany({
      where: { guild_id: guildId },
      orderBy: [{ voice_seconds: 'desc' }, { message_count: 'desc' }, { user_id: 'asc' }],
      take: normalizedLimit,
      skip: normalizedOffset
    });
    return rows.map((row, index) => ({
      rank: normalizedOffset + index + 1,
      user_id: row.user_id, message_count: row.message_count,
      voice_seconds: row.voice_seconds, updated_at: row.updated_at
    }));
  }

  async getOpenTicketForUser(guildId, userId) {
    const row = await prisma.ticketThread.findUnique({
      where: { guild_id_user_id: { guild_id: guildId, user_id: userId } }
    });
    if (!row) return null;
    return {
      guild_id: row.guild_id, user_id: row.user_id, channel_id: row.channel_id,
      trigger_channel_id: row.trigger_channel_id, trigger_message_id: row.trigger_message_id,
      created_at: row.created_at, updated_at: row.updated_at
    };
  }

  async getOpenTicketForChannel(guildId, channelId) {
    const row = await prisma.ticketThread.findFirst({
      where: { guild_id: guildId, channel_id: channelId }
    });
    if (!row) return null;
    return {
      guild_id: row.guild_id, user_id: row.user_id, channel_id: row.channel_id,
      trigger_channel_id: row.trigger_channel_id, trigger_message_id: row.trigger_message_id,
      created_at: row.created_at, updated_at: row.updated_at
    };
  }

  async setOpenTicket({ guildId, userId, channelId, triggerChannelId = null, triggerMessageId = null }) {
    const now = nowIso();
    await prisma.ticketThread.upsert({
      where: { guild_id_user_id: { guild_id: guildId, user_id: userId } },
      update: { channel_id: channelId, trigger_channel_id: triggerChannelId, trigger_message_id: triggerMessageId, updated_at: now },
      create: { guild_id: guildId, user_id: userId, channel_id: channelId, trigger_channel_id: triggerChannelId, trigger_message_id: triggerMessageId, created_at: now, updated_at: now }
    });
    return this.getOpenTicketForUser(guildId, userId);
  }

  async clearOpenTicketForUser(guildId, userId) {
    const deleted = await prisma.ticketThread.deleteMany({
      where: { guild_id: guildId, user_id: userId }
    });
    return deleted.count;
  }

  async clearOpenTicketForChannel(guildId, channelId) {
    const deleted = await prisma.ticketThread.deleteMany({
      where: { guild_id: guildId, channel_id: channelId }
    });
    return deleted.count;
  }

  async addReactionRole({ guildId, channelId, messageId, emojiKey, emojiDisplay, roleId, createdByUserId = null }) {
    try {
      await prisma.reactionRole.create({
        data: { guild_id: guildId, channel_id: channelId, message_id: messageId, emoji_key: emojiKey, emoji_display: emojiDisplay, role_id: roleId, created_by_user_id: createdByUserId, created_at: nowIso() }
      });
      return true;
    } catch {
      return false; // Unique constraint hit
    }
  }

  async listReactionRoles(guildId, messageId = null) {
    const rows = await prisma.reactionRole.findMany({
      where: messageId == null ? { guild_id: guildId } : { guild_id: guildId, message_id: messageId },
      orderBy: messageId == null ? [{ message_id: 'desc' }, { emoji_display: 'asc' }, { role_id: 'asc' }] : [{ emoji_display: 'asc' }, { role_id: 'asc' }]
    });
    return rows.map(r => ({
      id: Number(r.id), channel_id: r.channel_id, message_id: r.message_id, emoji_key: r.emoji_key,
      emoji_display: r.emoji_display, role_id: r.role_id, created_by_user_id: r.created_by_user_id, created_at: r.created_at
    }));
  }

  async getReactionRoleIds(guildId, channelId, messageId, emojiKey) {
    const rows = await prisma.reactionRole.findMany({
      where: { guild_id: guildId, channel_id: channelId, message_id: messageId, emoji_key: emojiKey },
      orderBy: { role_id: 'asc' }
    });
    return rows.map(r => r.role_id);
  }

  async removeReactionRole(guildId, channelId, messageId, emojiKey, roleId = null) {
    const deleted = await prisma.reactionRole.deleteMany({
      where: roleId 
        ? { guild_id: guildId, channel_id: channelId, message_id: messageId, emoji_key: emojiKey, role_id: roleId }
        : { guild_id: guildId, channel_id: channelId, message_id: messageId, emoji_key: emojiKey }
    });
    return deleted.count;
  }

  async clearReactionRolesForMessage(guildId, channelId, messageId) {
    const deleted = await prisma.reactionRole.deleteMany({
      where: { guild_id: guildId, channel_id: channelId, message_id: messageId }
    });
    return deleted.count;
  }
}
