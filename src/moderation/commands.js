function toReactionRouteToken(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) {
    return "";
  }

  const mentionMatch = raw.match(/^<a?:([^:>]+):(\d{5,22})>$/);
  if (mentionMatch) {
    const [, name, id] = mentionMatch;
    return `${name}:${id}`;
  }

  if (/^\d{5,22}$/.test(raw)) {
    return "";
  }

  return raw;
}

function parseChannelIdInput(rawValue, parseSnowflake) {
  const text = String(rawValue ?? "").trim();
  const direct = parseSnowflake(text);
  if (direct) {
    return direct;
  }

  const mentionMatch = text.match(/^<#(\d{5,22})>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }

  return null;
}

function parseMessageTargetInput(rawValue, parseSnowflake) {
  const text = String(rawValue ?? "").trim();
  const directMessageId = parseSnowflake(text);

  if (directMessageId) {
    return {
      guildId: null,
      channelId: null,
      messageId: directMessageId
    };
  }

  const linkMatch = text.match(
    /^https?:\/\/(?:www\.)?[^/]+\/channels\/(\d{5,22})\/(\d{5,22})\/(\d{5,22})(?:[/?#].*)?$/i
  );

  if (!linkMatch) {
    return null;
  }

  return {
    guildId: linkMatch[1],
    channelId: linkMatch[2],
    messageId: linkMatch[3]
  };
}

function buildReactionCandidates(normalized, emojiRouteTokenFromNormalized) {
  const candidates = [];
  const seenStrings = new Set();

  const pushString = (value) => {
    const text = String(value ?? "").trim();
    if (!text || seenStrings.has(text)) {
      return;
    }

    seenStrings.add(text);
    candidates.push(text);
  };

  if (normalized?.reactionValue && typeof normalized.reactionValue === "object") {
    candidates.push(normalized.reactionValue);
  } else {
    pushString(normalized?.reactionValue);
  }

  pushString(normalized?.display);
  pushString(normalized?.key);

  if (Array.isArray(normalized?.aliases)) {
    for (const alias of normalized.aliases) {
      pushString(alias);
    }
  }

  if (typeof emojiRouteTokenFromNormalized === "function") {
    pushString(toReactionRouteToken(emojiRouteTokenFromNormalized(normalized)));
  }

  return candidates;
}

function buildReactionRouteTokens(normalized, emojiRouteTokenFromNormalized) {
  const routeTokens = [];
  const seen = new Set();

  const push = (value) => {
    const token = toReactionRouteToken(value);
    if (!token || seen.has(token)) {
      return;
    }

    seen.add(token);
    routeTokens.push(token);
  };

  if (typeof emojiRouteTokenFromNormalized === "function") {
    push(emojiRouteTokenFromNormalized(normalized));
  }

  if (normalized?.customName && normalized?.customId) {
    push(`${normalized.customName}:${normalized.customId}`);
  }

  if (typeof normalized?.reactionValue === "string") {
    push(normalized.reactionValue);
  }

  if (Array.isArray(normalized?.aliases)) {
    for (const alias of normalized.aliases) {
      push(alias);
    }
  }

  push(normalized?.display);
  push(normalized?.key);
  return routeTokens;
}

function isGuildOwner(member, guild) {
  return Boolean(
    guild &&
      String(guild.ownerId || "") === String(member?.user?.id || member?.id || "")
  );
}

function hasAdminAuthority(member, permissionFlags) {
  return Boolean(member?.permissions?.has(permissionFlags?.Administrator));
}

function canActOverTarget(actorMember, targetMember, guild, permissionFlags) {
  if (!actorMember || !targetMember) {
    return false;
  }

  if (isGuildOwner(actorMember, guild) || hasAdminAuthority(actorMember, permissionFlags)) {
    return true;
  }

  const actorRole = actorMember.roles?.highest;
  const targetRole = targetMember.roles?.highest;

  if (!actorRole || !targetRole) {
    return false;
  }

  return actorRole.comparePositionTo(targetRole) > 0;
}

const PURGE_FEEDBACK_AUTO_DELETE_MS = 5000;

async function ensureReactionOnMessage({
  client,
  channelId,
  messageId,
  targetMessage,
  normalized,
  emojiRouteTokenFromNormalized
}) {
  let firstError = null;

  for (const candidate of buildReactionCandidates(normalized, emojiRouteTokenFromNormalized)) {
    try {
      await targetMessage.react(candidate);
      return {
        ok: true,
        method: "message.react",
        candidate: typeof candidate === "string" ? candidate : JSON.stringify(candidate)
      };
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
    }
  }

  for (const routeToken of buildReactionRouteTokens(normalized, emojiRouteTokenFromNormalized)) {
    try {
      await client.rest.put(
        `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(routeToken)}/@me`,
        { auth: true }
      );

      return {
        ok: true,
        method: "rest.put",
        candidate: routeToken
      };
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
    }
  }

  return {
    ok: false,
    error: firstError ? String(firstError) : "Failed to add reaction."
  };
}

async function ensureReactionRemovedFromMessage({
  client,
  channelId,
  messageId,
  targetMessage,
  normalized,
  emojiRouteTokenFromNormalized
}) {
  let firstError = null;

  for (const candidate of buildReactionCandidates(normalized, emojiRouteTokenFromNormalized)) {
    if (typeof targetMessage?.removeReaction !== "function") {
      break;
    }

    try {
      await targetMessage.removeReaction(candidate);
      return {
        ok: true,
        method: "message.removeReaction",
        candidate: typeof candidate === "string" ? candidate : JSON.stringify(candidate)
      };
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
    }
  }

  for (const routeToken of buildReactionRouteTokens(normalized, emojiRouteTokenFromNormalized)) {
    try {
      await client.rest.delete(
        `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(routeToken)}/@me`,
        { auth: true }
      );

      return {
        ok: true,
        method: "rest.delete",
        candidate: routeToken
      };
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
    }
  }

  return {
    ok: false,
    error: firstError ? String(firstError) : "Failed to remove reaction."
  };
}

export function createModerationCommandHandlers({
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
  getEffectiveLockdownState,
  sendWelcomeForMember,
  renderMessageTemplate,
  normalizeEmojiInput,
  emojiRouteTokenFromNormalized,
  messageBaseUrl,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  ComponentType
}) {
  const normalizedMessageBaseUrl = String(messageBaseUrl || "https://fluxer.app")
    .trim()
    .replace(/\/+$/, "");

  const buildGuildMessageLink = (guildId, channelId, messageId) => {
    return `${normalizedMessageBaseUrl}/channels/${guildId}/${channelId}/${messageId}`;
  };

  return {
    async blacklisted({ message }) {
      if (!(await requirePermission(message, PermissionFlags.ManageGuild))) {
        return;
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('blacklist_action')
        .setPlaceholder('Choose an action')
        .addOptions([
          { label: 'View Words', value: 'view', description: 'View all blacklisted words' },
          { label: 'Add Word', value: 'add', description: 'Add a word to blacklist' },
          { label: 'Remove Word', value: 'remove', description: 'Remove a word from blacklist' }
        ]);

      const row = new ActionRowBuilder().addComponents(selectMenu);

      const sent = await safeReply(message, {
        content: 'Manage blacklisted words:',
        components: [row]
      });

      if (!sent || typeof sent.createMessageComponentCollector !== 'function') return;

      const collector = sent.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60000 });
      
      collector.on('collect', async (i) => {
        const isOwner = String(i.guild?.ownerId || '') === String(i.member?.user?.id || i.user?.id || '');
        const hasPermission = Boolean(
          i.member?.permissions?.has(PermissionFlags.ManageGuild) ||
          i.member?.permissions?.has(PermissionFlags.Administrator)
        );

        if (!isOwner && !hasPermission) {
          return i.reply({ content: 'You lack permission to manage blacklisted words.', flags: MessageFlags.Ephemeral });
        }

        const action = i.values[0];

        if (action === 'view') {
          const words = wordStore.list();
          if (words.length === 0) {
            return i.reply({ content: 'No blacklisted words configured.', flags: MessageFlags.Ephemeral });
          }

          const pageSize = 20;
          const totalPages = Math.ceil(words.length / pageSize);
          const chunk = words.slice(0, pageSize);
          await i.reply({
            content: [`Blacklisted words (${words.length} total, page 1/${totalPages}):`, ...chunk.map((w) => `- ${w}`)].join('\n'),
            flags: MessageFlags.Ephemeral
          });
        } else if (action === 'add') {
          const modal = new ModalBuilder()
            .setCustomId('blacklist_add_modal')
            .setTitle('Add Blacklisted Word');

          const input = new TextInputBuilder()
            .setCustomId('word_input')
            .setLabel('Word to add')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(50);

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await i.showModal(modal);
        } else if (action === 'remove') {
          const modal = new ModalBuilder()
            .setCustomId('blacklist_remove_modal')
            .setTitle('Remove Blacklisted Word');

          const input = new TextInputBuilder()
            .setCustomId('word_input')
            .setLabel('Word to remove')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(50);

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await i.showModal(modal);
        }
      });

      collector.on('end', () => {
        try {
          sent.edit({ components: [] }).catch(() => null);
        } catch {
          // best effort
        }
      });
    },

    async reloadwords({ message }) {
      if (!(await requirePermission(message, PermissionFlags.ManageGuild))) {
        return;
      }

      wordStore.reload();
      await safeReply(message, `Word list reloaded (${wordStore.list().length} entries).`);
    },

    async warn({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.ModerateMembers))) {
        return;
      }

      const guild = await resolveGuildFromMessage(message);
      if (!guild) {
        await safeReply(message, "This command only works in a server.");
        return;
      }

      const targetUserId = parseUserIdArg(args[0]);
      const reasonInput = String(args.slice(1).join(" ") || "").trim();
      if (!targetUserId || !reasonInput) {
        await safeReply(message, "Usage: warn <user> <reason>");
        return;
      }

      const targetMember = await resolveGuildMember(guild, targetUserId);
      if (!targetMember) {
        await safeReply(message, "Member not found in this guild.");
        return;
      }

      const actorMember = message.member || (await resolveGuildMember(guild, message.author.id));
      if (!canActOverTarget(actorMember, targetMember, guild, PermissionFlags)) {
        await safeReply(message, "You need a higher role or administrator access to warn that member.");
        return;
      }

      const reason = sanitizeReason(reasonInput);
      const warningCount = await db.incrementWarning(guild.id, targetUserId, reason, message.author.id);

      await db.logModerationAction({
        guildId: guild.id,
        action: "warn",
        actorUserId: message.author.id,
        targetUserId,
        reason,
        channelId: message.channelId,
        messageId: message.id,
        metadata: {
          warning_count: warningCount
        }
      });

      await safeReply(
        message,
        `${formatUserMention(targetUserId)} warned.\nReason: ${reason}\nTotal warnings: ${warningCount}`
      );
    },

    async warnings({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.ModerateMembers))) {
        return;
      }

      const guild = await resolveGuildFromMessage(message);
      if (!guild) {
        await safeReply(message, "This command only works in a server.");
        return;
      }

      const targetUserId = parseUserIdArg(args[0]) || message.author.id;
      const count = await db.getWarningCount(guild.id, targetUserId);
      await safeReply(message, `${formatUserMention(targetUserId)} has ${count} warning(s).`);
    },

    async purge({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.ManageMessages))) {
        return;
      }

      const guild = await resolveGuildFromMessage(message);
      if (!guild) {
        await safeReply(message, "This command only works in a server.");
        return;
      }

      const parsedAmount = Number.parseInt(String(args[0] || ""), 10);
      if (!Number.isFinite(parsedAmount) || parsedAmount < 1) {
        await safeReply(message, "Usage: purge <count 1-100> [channel_id]");
        return;
      }

      const amount = Math.max(1, Math.min(parsedAmount, 100));
      const targetChannelId = parseSnowflake(args[1]) || message.channelId;
      if (!targetChannelId) {
        await safeReply(message, "Could not resolve a channel to purge.");
        return;
      }

      let channel = null;
      try {
        channel = client.channels?.cache?.get?.(targetChannelId) || null;
        if (!channel && typeof client.channels?.fetch === "function") {
          channel = await client.channels.fetch(targetChannelId);
        }
      } catch {
        // Best effort.
      }

      if (!channel) {
        await safeReply(message, "Channel not found.");
        return;
      }

      const fetchLimit = Math.max(1, Math.min(amount + 20, 100));
      let rawMessages;

      try {
        rawMessages = await client.rest.get(`/channels/${targetChannelId}/messages?limit=${fetchLimit}`, { auth: true });
      } catch (error) {
        await safeReply(message, "Failed to read channel messages.", {
          title: "Moderation",
          kind: "error"
        });

        if (typeof console !== "undefined" && typeof console.error === "function") {
          console.error("purge read channel messages failed", error);
        }

        return;
      }

      const targetMessageIds = Array.isArray(rawMessages)
        ? rawMessages
            .map((entry) => parseSnowflake(entry?.id))
            .filter((id) => id && id !== message.id)
            .slice(0, amount)
        : [];

      if (targetMessageIds.length === 0) {
        await safeReply(message, "No messages available to delete in that channel.", {
          title: "Moderation",
          kind: "info"
        });
        return;
      }

      let deletedCount = 0;
      let bulkError = null;

      if (targetMessageIds.length >= 2 && typeof channel.bulkDeleteMessages === "function") {
        try {
          await channel.bulkDeleteMessages(targetMessageIds);
          deletedCount = targetMessageIds.length;
        } catch (error) {
          bulkError = String(error);
        }
      }

      if (deletedCount < targetMessageIds.length) {
        for (const targetMessageId of targetMessageIds.slice(deletedCount)) {
          try {
            const targetMessage = await channel?.messages?.fetch(targetMessageId);
            if (targetMessage && typeof targetMessage.delete === "function") {
              await targetMessage.delete();
              deletedCount += 1;
            }
          } catch {
            // Continue deleting what we can.
          }
        }
      }

      await db.logModerationAction({
        guildId: guild.id,
        action: deletedCount > 0 ? "purge" : "purge_failed",
        actorUserId: message.author.id,
        reason: `purge requested (${amount})`,
        channelId: targetChannelId,
        messageId: message.id,
        metadata: {
          requested: amount,
          attempted: targetMessageIds.length,
          deleted: deletedCount,
          bulk_error: bulkError
        }
      });

      if (deletedCount === 0) {
        await safeReply(message, "Unable to delete messages in that channel.", {
          title: "Moderation",
          kind: "error"
        });
        return;
      }

      const responseLines = [
        `Purge completed in <#${targetChannelId}>.`,
        `deleted ${deletedCount}/${targetMessageIds.length} message(s).`
      ];

      if (bulkError && deletedCount > 0) {
        responseLines.push("Bulk delete failed, fallback single-message delete was used.");
      }

      if (deletedCount < targetMessageIds.length) {
        responseLines.push(`${targetMessageIds.length - deletedCount} message(s) could not be removed.`);
      }

      await safeReply(message, responseLines.join("\n"), {
        title: "Moderation",
        kind: deletedCount < targetMessageIds.length ? "warning" : "success",
        deleteAfterMs: PURGE_FEEDBACK_AUTO_DELETE_MS
      });

      if (typeof message.delete === "function") {
        try {
          await message.delete();
        } catch {
          // Best effort command cleanup.
        }
      }
    },

    async kick({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.KickMembers))) {
        return;
      }

      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const userId = parseUserIdArg(args[0]);
      if (!userId) {
        await safeReply(message, "Usage: kick <user> [reason]");
        return;
      }

      const actorMember = message.member || (await resolveGuildMember(guild, message.author.id));
      const targetMember = await resolveGuildMember(guild, userId);

      if (!targetMember) {
        await safeReply(message, "Member not found in this guild.");
        return;
      }

      if (!targetMember.kickable) {
        await safeReply(message, "I cannot kick that member because their role is higher than mine.");
        return;
      }

      if (!canActOverTarget(actorMember, targetMember, guild, PermissionFlags)) {
        await safeReply(message, "You need a higher role or administrator access to kick that member.");
        return;
      }

      const reason = sanitizeReason(args.slice(1).join(" ") || "No reason provided");
      // Try to resolve member and kick via GuildMember.kick(), fallback to guild.members.kick()
      try {
        const target = await resolveGuildMember(guild, userId);
        if (target && typeof target.kick === "function") {
          await target.kick({ reason });
        } else if (guild && guild.members && typeof guild.members.kick === "function") {
          await guild.members.kick(userId, { reason });
        } else {
          throw new Error("Cannot perform kick: guild API unavailable");
        }
      } catch (err) {
        throw err;
      }

      const guildConfig = await db.getGuildConfig(guild.id);
      const kickText = renderMessageTemplate(guildConfig.kick_message_template, {
        "user.mention": formatUserMention(userId),
        "user.id": userId,
        "guild.id": guild.id,
        "guild.name": String(guild.name || guild.id),
        reason
      }).trim();

      await db.logModerationAction({
        guildId: guild.id,
        action: "kick",
        actorUserId: message.author.id,
        targetUserId: userId,
        reason,
        channelId: message.channelId,
        messageId: message.id
      });

      await safeReply(message, kickText || `Kicked ${formatUserMention(userId)}.`);
    },

    async ban({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.BanMembers))) {
        return;
      }

      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const userId = parseUserIdArg(args[0]);
      if (!userId) {
        await safeReply(message, "Usage: ban <user> [reason]");
        return;
      }

      const actorMember = message.member || (await resolveGuildMember(guild, message.author.id));
      const targetMember = await resolveGuildMember(guild, userId);

      if (targetMember && !targetMember.bannable) {
        await safeReply(message, "I cannot ban that member because their role is higher than mine.");
        return;
      }

      if (targetMember && !canActOverTarget(actorMember, targetMember, guild, PermissionFlags)) {
        await safeReply(message, "You need a higher role or administrator access to ban that member.");
        return;
      }

      const reason = sanitizeReason(args.slice(1).join(" ") || "No reason provided");
      await guild.ban(userId, { reason });

      const guildConfig = await db.getGuildConfig(guild.id);
      const banText = renderMessageTemplate(guildConfig.ban_message_template, {
        "user.mention": formatUserMention(userId),
        "user.id": userId,
        "guild.id": guild.id,
        "guild.name": String(guild.name || guild.id),
        reason
      }).trim();

      await db.logModerationAction({
        guildId: guild.id,
        action: "ban",
        actorUserId: message.author.id,
        targetUserId: userId,
        reason,
        channelId: message.channelId,
        messageId: message.id
      });

      await safeReply(message, banText || `Banned ${formatUserMention(userId)}.`);
    },

    async unban({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.BanMembers))) {
        return;
      }

      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const userId = parseUserIdArg(args[0]);
      if (!userId) {
        await safeReply(message, "Usage: unban <user>");
        return;
      }

      await guild.unban(userId);

      await db.logModerationAction({
        guildId: guild.id,
        action: "unban",
        actorUserId: message.author.id,
        targetUserId: userId,
        reason: "Unbanned"
      });

      await safeReply(message, `Unbanned ${formatUserMention(userId)}.`);
    },

    async mute({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.ModerateMembers))) {
        return;
      }

      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const userId = parseUserIdArg(args[0]);
      if (!userId) {
        await safeReply(message, "Usage: mute <user> [duration_minutes] [reason]");
        return;
      }

      let durationMinutes = 10;
      let reasonStartIndex = 1;
      if (args[1] && /^\d+$/.test(args[1])) {
        durationMinutes = Math.max(1, Math.min(Number(args[1]), 10080));
        reasonStartIndex = 2;
      }

      const reason = sanitizeReason(args.slice(reasonStartIndex).join(" ") || "No reason provided");
      const until = toIsoSeconds(new Date(Date.now() + durationMinutes * 60 * 1000));

      const member = await resolveGuildMember(guild, userId);
      if (!member) {
        await safeReply(message, "Member not found in this guild.");
        return;
      }

      const actorMember = message.member || (await resolveGuildMember(guild, message.author.id));
      if (!member.moderatable) {
        await safeReply(message, "I cannot mute that member because their role is higher than mine.");
        return;
      }

      if (!canActOverTarget(actorMember, member, guild, PermissionFlags)) {
        await safeReply(message, "You need a higher role or administrator access to mute that member.");
        return;
      }

      await member.edit({
        communication_disabled_until: until,
        timeout_reason: reason
      });

      const guildConfig = await db.getGuildConfig(guild.id);
      const muteText = renderMessageTemplate(guildConfig.mute_message_template, {
        "user.mention": formatUserMention(userId),
        "user.id": userId,
        "guild.id": guild.id,
        "guild.name": String(guild.name || guild.id),
        reason,
        until,
        duration_minutes: String(durationMinutes)
      }).trim();

      await db.logModerationAction({
        guildId: guild.id,
        action: "mute",
        actorUserId: message.author.id,
        targetUserId: userId,
        reason,
        channelId: message.channelId,
        messageId: message.id,
        metadata: {
          duration_minutes: durationMinutes,
          until
        }
      });

      await safeReply(message, muteText || `${formatUserMention(userId)} muted for ${durationMinutes} minute(s).`);
    },

    async unmute({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.ModerateMembers))) {
        return;
      }

      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const userId = parseUserIdArg(args[0]);
      if (!userId) {
        await safeReply(message, "Usage: unmute <user> [reason]");
        return;
      }

      const reason = sanitizeReason(args.slice(1).join(" ") || "No reason provided");
      const member = await resolveGuildMember(guild, userId);
      if (!member) {
        await safeReply(message, "Member not found in this guild.");
        return;
      }

      const actorMember = message.member || (await resolveGuildMember(guild, message.author.id));
      if (!member.moderatable) {
        await safeReply(message, "I cannot unmute that member because their role is higher than mine.");
        return;
      }

      if (!canActOverTarget(actorMember, member, guild, PermissionFlags)) {
        await safeReply(message, "You need a higher role or administrator access to unmute that member.");
        return;
      }

      await member.edit({
        communication_disabled_until: null,
        timeout_reason: reason
      });

      await db.logModerationAction({
        guildId: guild.id,
        action: "unmute",
        actorUserId: message.author.id,
        targetUserId: userId,
        reason,
        channelId: message.channelId,
        messageId: message.id
      });

      await safeReply(message, `${formatUserMention(userId)} unmuted.`);
    },

    async role({ message }) {
      if (!(await requirePermission(message, PermissionFlags.ManageRoles))) {
        return;
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('role_action')
        .setPlaceholder('Choose a role action')
        .addOptions([
          { label: 'Add Role', value: 'add', description: 'Give a role to a member' },
          { label: 'Remove Role', value: 'remove', description: 'Take a role away from a member' }
        ]);

      const row = new ActionRowBuilder().addComponents(selectMenu);

      const sent = await safeReply(message, {
        content: 'Manage member roles:',
        components: [row]
      });

      if (!sent || typeof sent.createMessageComponentCollector !== 'function') return;

      const collector = sent.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 120000 });

      collector.on('collect', async (i) => {
        const isOwner = String(i.guild?.ownerId || '') === String(i.member?.user?.id || i.user?.id || '');
        const hasPermission = Boolean(
          i.member?.permissions?.has(PermissionFlags.ManageRoles) ||
          i.member?.permissions?.has(PermissionFlags.Administrator)
        );

        if (!isOwner && !hasPermission) {
          return i.reply({ content: 'You lack permission to manage roles.', flags: MessageFlags.Ephemeral });
        }

        const action = i.values[0];
        if (action !== 'add' && action !== 'remove') {
          return i.deferUpdate();
        }

        const modal = new ModalBuilder()
          .setCustomId(action === 'add' ? 'role_add_modal' : 'role_remove_modal')
          .setTitle(action === 'add' ? 'Add Role' : 'Remove Role');

        const userInput = new TextInputBuilder()
          .setCustomId('user_input')
          .setLabel('User mention or ID')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const roleInput = new TextInputBuilder()
          .setCustomId('role_input')
          .setLabel('Role name, mention, or ID')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100);

        modal.addComponents(
          new ActionRowBuilder().addComponents(userInput),
          new ActionRowBuilder().addComponents(roleInput)
        );

        await i.showModal(modal);
      });

      collector.on('end', () => {
        try {
          sent.edit({ components: [] }).catch(() => null);
        } catch {
          // best effort
        }
      });
    },

    async addrole({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.ManageRoles))) {
        return;
      }

      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const userId = parseUserIdArg(args[0]);
      const roleText = args.slice(1).join(" ").trim();
      if (!userId || !roleText) {
        await safeReply(message, "Usage: addrole <user> <role>");
        return;
      }

      const roleId = await guild.resolveRoleId(roleText);
      if (!roleId) {
        await safeReply(message, "Role not found.");
        return;
      }

      const member = await resolveGuildMember(guild, userId);
      if (!member) {
        await safeReply(message, "Member not found.");
        return;
      }

      const actorMember = message.member || (await resolveGuildMember(guild, message.author.id));
      if (!member.manageable) {
        await safeReply(message, "I cannot manage that member because their role is higher than mine.");
        return;
      }

      if (!canActOverTarget(actorMember, member, guild, PermissionFlags)) {
        await safeReply(message, "You need a higher role or administrator access to manage that member.");
        return;
      }

      await member.roles.add(roleId);

      await db.logModerationAction({
        guildId: guild.id,
        action: "add_role",
        actorUserId: message.author.id,
        targetUserId: userId,
        reason: `role_id=${roleId}`,
        metadata: { role_id: roleId }
      });

      await safeReply(message, `Added role <@&${roleId}> to ${formatUserMention(userId)}.`, {
        title: "Moderation",
        kind: "success",
        roleId
      });
    },

    async removerole({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.ManageRoles))) {
        return;
      }

      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const userId = parseUserIdArg(args[0]);
      const roleText = args.slice(1).join(" ").trim();
      if (!userId || !roleText) {
        await safeReply(message, "Usage: removerole <user> <role>");
        return;
      }

      const roleId = await guild.resolveRoleId(roleText);
      if (!roleId) {
        await safeReply(message, "Role not found.");
        return;
      }

      const member = await resolveGuildMember(guild, userId);
      if (!member) {
        await safeReply(message, "Member not found.");
        return;
      }

      const actorMember = message.member || (await resolveGuildMember(guild, message.author.id));
      if (!member.manageable) {
        await safeReply(message, "I cannot manage that member because their role is higher than mine.");
        return;
      }

      if (!canActOverTarget(actorMember, member, guild, PermissionFlags)) {
        await safeReply(message, "You need a higher role or administrator access to manage that member.");
        return;
      }

      await member.roles.remove(roleId);

      await db.logModerationAction({
        guildId: guild.id,
        action: "remove_role",
        actorUserId: message.author.id,
        targetUserId: userId,
        reason: `role_id=${roleId}`,
        metadata: { role_id: roleId }
      });

      await safeReply(message, `Removed role <@&${roleId}> from ${formatUserMention(userId)}.`, {
        title: "Moderation",
        kind: "success",
        roleId
      });
    },

    async raidgate({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.ModerateMembers))) {
        return;
      }

      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const mode = String(args[0] || "status").trim().toLowerCase();
      if (mode === "status") {
        const state = await getEffectiveGateState(guild.id);
        const lockdownState = typeof getEffectiveLockdownState === "function"
          ? await getEffectiveLockdownState(guild.id, guild)
          : await db.getRaidLockdownState(guild.id);
        await safeReply(
          message,
          [
            `gate_active: ${state.gate_active}`,
            `gate_reason: ${state.gate_reason || "-"}`,
            `gate_until: ${state.gate_until || "-"}`,
            `lockdown_active: ${lockdownState.lockdown_active}`,
            `lockdown_reason: ${lockdownState.lockdown_reason || "-"}`,
            `lockdown_until: ${lockdownState.lockdown_until || "-"}`
          ].join("\n")
        );
        return;
      }

      if (mode === "off") {
        await db.setRaidGateState(guild.id, false, "Manual disable by staff", null);
        await safeReply(message, "Raid gate disabled.");
        return;
      }

      if (mode === "on") {
        const cfg = await db.getGuildConfig(guild.id);
        const duration = Math.max(60, Math.min(Number(args[1] || cfg.gate_duration_seconds), 86400));
        const gateUntil = new Date(Date.now() + duration * 1000).toISOString();
        await db.setRaidGateState(guild.id, true, `Manual gate enabled by ${message.author.id}`, gateUntil);
        await safeReply(message, `Raid gate enabled until ${gateUntil}.`);
        return;
      }

      await safeReply(message, "Usage: raidgate <on|off|status> [duration_seconds]");
    },

    async pendingverifications({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.ModerateMembers))) {
        return;
      }

      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const limit = Math.max(1, Math.min(Number(args[0] || 10), 50));
      const rows = await db.listPendingVerifications(guild.id, limit);

      if (rows.length === 0) {
        await safeReply(message, "No pending verifications.");
        return;
      }

      const lines = rows.map(
        (row) => `- ${formatUserMention(row.user_id)} | risk=${row.risk_score.toFixed(3)} | reason=${row.reason}`
      );

      await safeReply(message, ["Pending verifications:", ...lines].join("\n"));
    },

    async raidsnapshot({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.ModerateMembers))) {
        return;
      }

      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const limit = Math.max(1, Math.min(Number(args[0] || 10), 50));
      const events = await db.listRecentJoinEvents(guild.id, limit);

      if (events.length === 0) {
        await safeReply(message, "No join events recorded yet.");
        return;
      }

      const lines = events.map(
        (entry) =>
          `- ${formatUserMention(entry.user_id)} | action=${entry.action} | risk=${entry.risk_score.toFixed(3)} | level=${entry.risk_level}`
      );
      await safeReply(message, ["Recent join events:", ...lines].join("\n"));
    },

    async reactionroles({ message }) {
      if (!(await requirePermission(message, PermissionFlags.ManageRoles))) {
        return;
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('reactionrole_action')
        .setPlaceholder('Choose an action')
        .addOptions([
          { label: 'List Roles', value: 'list', description: 'View reaction role mappings' },
          { label: 'Add Role', value: 'add', description: 'Add a reaction role mapping' },
          { label: 'Remove Role', value: 'remove', description: 'Remove a reaction role mapping' }
        ]);

      const row = new ActionRowBuilder().addComponents(selectMenu);

      const sent = await safeReply(message, {
        content: 'Manage reaction role mappings:',
        components: [row]
      });

      if (!sent || typeof sent.createMessageComponentCollector !== 'function') return;

      const collector = sent.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60000 });
      
      collector.on('collect', async (i) => {
        const isOwner = String(i.guild?.ownerId || '') === String(i.member?.user?.id || i.user?.id || '');
        const hasPermission = Boolean(
          i.member?.permissions?.has(PermissionFlags.ManageRoles) ||
          i.member?.permissions?.has(PermissionFlags.Administrator)
        );

        if (!isOwner && !hasPermission) {
          return i.reply({ content: 'You lack permission to manage reaction roles.', flags: MessageFlags.Ephemeral });
        }

        const action = i.values[0];

        if (action === 'list') {
          const roles = await db.listReactionRoles(i.guildId);
          if (roles.length === 0) {
            return i.reply({ content: 'No reaction role mappings configured.', flags: MessageFlags.Ephemeral });
          }

          const grouped = {};
          for (const role of roles) {
            const key = `${role.channel_id}/${role.message_id}`;
            if (!grouped[key]) {
              grouped[key] = [];
            }
            grouped[key].push({ emoji: role.emoji_display || role.emoji_key, roleId: role.role_id });
          }

          const lines = Object.entries(grouped).map(([key, entries]) => {
            const [channelId, messageId] = key.split('/');
            return `**Message** <https://discord.com/channels/${i.guildId}/${channelId}/${messageId}>:\n${entries.map((e) => `  ${e.emoji}: <@&${e.roleId}>`).join('\n')}`;
          });

          await i.reply({ content: lines.slice(0, 10).join('\n\n') || 'No mappings.', flags: MessageFlags.Ephemeral });
        } else if (action === 'add') {
          const modal = new ModalBuilder()
            .setCustomId('reactionrole_add_modal')
            .setTitle('Create Reaction Role Panel');

          const panelTitle = new TextInputBuilder()
            .setCustomId('panel_title')
            .setLabel('Panel title')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100);

          const panelContent = new TextInputBuilder()
            .setCustomId('panel_content')
            .setLabel('Panel text')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(2000);

          const emoji = new TextInputBuilder()
            .setCustomId('emoji_input')
            .setLabel('Emoji to react with')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(50);

          modal.addComponents(
            new ActionRowBuilder().addComponents(panelTitle),
            new ActionRowBuilder().addComponents(panelContent),
            new ActionRowBuilder().addComponents(emoji)
          );
          await i.showModal(modal);
        } else if (action === 'remove') {
          const roles = await db.listReactionRoles(i.guildId);
          if (roles.length === 0) {
            return i.reply({ content: 'No reaction role mappings configured.', flags: MessageFlags.Ephemeral });
          }

          const options = roles.slice(0, 25).map((role) => {
            const roleName = i.guild?.roles?.cache?.get?.(role.role_id)?.name || `<@&${role.role_id}>`;
            const emojiLabel = String(role.emoji_display || role.emoji_key || 'emoji').slice(0, 50);
            const messageLabel = String(role.message_id || '').slice(0, 12);
            return {
              label: `${emojiLabel} → ${String(roleName).slice(0, 80)}`,
              value: `${role.channel_id}:${role.message_id}:${role.emoji_key}:${role.role_id}`,
              description: `Message ${messageLabel}`.slice(0, 100)
            };
          });

          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('reactionrole_remove_select')
            .setPlaceholder('Choose a reaction-role mapping to remove')
            .addOptions(options);

          await i.reply({
            content: 'Choose the reaction-role mapping to remove:',
            components: [new ActionRowBuilder().addComponents(selectMenu)],
            flags: MessageFlags.Ephemeral
          });

          const replyMessage = await i.fetchReply().catch(() => null);
          if (!replyMessage || typeof replyMessage.createMessageComponentCollector !== 'function') {
            return;
          }

          const removeCollector = replyMessage.createMessageComponentCollector({
            componentType: ComponentType.StringSelect,
            time: 120000
          });

          removeCollector.on('collect', async (selection) => {
            if (selection.customId !== 'reactionrole_remove_select') {
              return selection.deferUpdate();
            }

            await selection.deferUpdate();

            const selected = String(selection.values[0] || '');
            const [channelId, messageId, emojiKey, roleId] = selected.split(':');
            if (!channelId || !messageId || !emojiKey || !roleId) {
              return selection.followUp({ content: 'Invalid mapping selection.', flags: MessageFlags.Ephemeral });
            }

            const removed = await db.removeReactionRole(i.guildId, channelId, messageId, emojiKey, roleId);
            await selection.editReply({
              content: removed > 0 ? `✅ Removed ${emojiKey} from <@&${roleId}>.` : '⚠️ Reaction role mapping not found.',
              components: []
            });
          });

          removeCollector.on('end', () => {
            // collector ended, no cleanup needed
          });
        }
      });

      collector.on('end', () => {
        try {
          sent.edit({ components: [] }).catch(() => null);
        } catch {
          // best effort
        }
      });
    }
  };
}
