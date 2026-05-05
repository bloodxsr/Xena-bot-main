import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags, StringSelectMenuBuilder } from "discord.js";
import path from "node:path";

import { renderLevelCardImage } from "./level-card-image.js";
import { renderServerStatsCardImage } from "./server-stats-image.js";

function formatInteger(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return "0";
  }

  return Math.trunc(numeric).toLocaleString("en-US");
}

function colorHexToInt(value, fallback) {
  const text = String(value ?? "").trim();
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(text)) {
    return fallback;
  }

  if (text.length === 4) {
    const r = text[1];
    const g = text[2];
    const b = text[3];
    return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }

  return Number.parseInt(text.slice(1), 16);
}

function progressBar(current, total, size = 16) {
  const normalizedTotal = Math.max(1, Number(total || 1));
  const normalizedCurrent = Math.max(0, Math.min(Number(current || 0), normalizedTotal));
  const filled = Math.round((normalizedCurrent / normalizedTotal) * size);
  const clampedFilled = Math.max(0, Math.min(filled, size));
  return `${"=".repeat(clampedFilled)}${".".repeat(size - clampedFilled)}`;
}

function buildPaginationFooterText(baseText, totalPages) {
  const base = String(baseText || "").trim();
  if (Math.max(1, Number(totalPages || 1)) <= 1) {
    return base;
  }

  const navigationText = "Use the button controls to change pages.";
  return base ? `${base} | ${navigationText}` : navigationText;
}

function createCommandEmbed({ title, description, color, fields = [], footer = null, author = null, thumbnail = null }) {
  const embed = {
    title,
    description,
    color,
    fields,
    footer: footer ? { text: footer } : undefined,
    timestamp: new Date().toISOString()
  };

  if (author) embed.author = author;
  if (thumbnail) embed.thumbnail = { url: thumbnail };

  return { embeds: [embed] };
}

function chunkEntries(entries, size = 6) {
  const normalizedSize = Math.max(1, Math.trunc(Number(size) || 6));
  const chunks = [];

  for (let index = 0; index < entries.length; index += normalizedSize) {
    chunks.push(entries.slice(index, index + normalizedSize));
  }

  return chunks;
}

const HELP_SECTION_SELECT_ID = "help:section-select";
const HELP_HOME_BUTTON_ID = "help:home";
const HELP_COMMAND_SELECT_ID = "help:command-select";

const LEVEL_CARD_IMAGE_FILE = "level-card.png";
const SERVER_STATS_IMAGE_FILE = "server-stats.png";
const STATIC_LEVEL_CARD_PATH = path.join(process.cwd(), "LEVELCARD.png");
const DISCORD_EPOCH_MS = 1420070400000n;

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

function resolveGuildIconUrl(guild) {
  if (!guild || typeof guild !== "object") {
    return null;
  }

  try {
    if (typeof guild.iconURL === "function") {
      const iconUrl = guild.iconURL({ size: 256 });
      if (typeof iconUrl === "string" && iconUrl.trim()) {
        return iconUrl.trim();
      }
    }
  } catch {
    // Best effort.
  }

  if (typeof guild.icon_url === "string" && guild.icon_url.trim()) {
    return guild.icon_url.trim();
  }

  return null;
}

function dateFromSnowflake(snowflake) {
  try {
    const value = BigInt(String(snowflake));
    const timestampMs = (value >> 22n) + DISCORD_EPOCH_MS;
    return new Date(Number(timestampMs));
  } catch {
    return null;
  }
}

function resolveGuildCreatedAt(guild) {
  const direct = guild?.createdAt || guild?.created_at;
  if (direct instanceof Date && Number.isFinite(direct.getTime())) {
    return direct;
  }

  if (typeof direct === "string" && direct.trim()) {
    const parsed = new Date(direct);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }

  if (typeof direct === "number" && Number.isFinite(direct)) {
    const parsed = new Date(direct);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }

  return dateFromSnowflake(guild?.id);
}

function formatDateTimeUtc(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return "unknown";
  }

  return value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function buildLevelCardPayload({
  mention,
  level,
  rank,
  trackedMembers,
  progressXp,
  progressRequired,
  progressPercent,
  totalXp,
  messageCount,
  embedColor
}) {
  const xpToNext = Math.max(0, Number(progressRequired || 0) - Number(progressXp || 0));
  const progress = progressBar(progressXp, progressRequired, 18);
  const normalizedPercent = Math.round(
    Math.max(0, Math.min(100, Number.isFinite(Number(progressPercent)) ? Number(progressPercent) : 0))
  );
  const rankSuffix = trackedMembers > 0 ? `/${trackedMembers}` : "";

  return createCommandEmbed({
    title: "Level Card",
    description: `${mention}\nRank #${rank}${rankSuffix} | Level ${level}`,
    color: colorHexToInt(embedColor, 0x1f6feb),
    fields: [
      {
        name: "XP Progress",
        value: [
          `[${progress}] ${normalizedPercent}%`,
          `XP ${formatInteger(progressXp)}/${formatInteger(progressRequired)}`,
          `${formatInteger(xpToNext)} XP to next level`
        ].join("\n"),
        inline: false
      },
      {
        name: "Total XP",
        value: formatInteger(totalXp),
        inline: true
      },
      {
        name: "Messages",
        value: formatInteger(messageCount),
        inline: true
      },
      {
        name: "Next Level",
        value: `Level ${Math.max(0, Number(level || 0)) + 1}`,
        inline: true
      }
    ],
    footer: "Keep chatting to earn XP."
  });
}

async function tryBuildLevelCardImageAttachmentPayload({
  displayName,
  avatarUrl,
  level,
  rank,
  trackedMembers,
  progressXp,
  progressRequired,
  totalXp,
  messageCount,
  levelCardStyle
}) {
  try {
    const imageData = await renderLevelCardImage({
      displayName,
      avatarUrl,
      level,
      rank,
      trackedMembers,
      progressXp,
      progressRequired,
      totalXp,
      messageCount,
      primaryColor: levelCardStyle?.primaryColor,
      accentColor: levelCardStyle?.accentColor,
      overlayOpacity: levelCardStyle?.overlayOpacity,
      backgroundUrl: levelCardStyle?.backgroundUrl || STATIC_LEVEL_CARD_PATH,
      fontStyle: levelCardStyle?.fontStyle
    });

    return {
      files: [
        {
          name: LEVEL_CARD_IMAGE_FILE,
          attachment: imageData
        }
      ]
    };
  } catch {
    return null;
  }
}

function buildServerStatsPayload({
  guildName,
  guildId,
  ownerMention,
  createdAtText,
  memberCount,
  channelCount,
  categoryCount,
  roleCount,
  emojiCount,
  boostCount,
  trackedMembers,
  topLevelText
}) {
  return createCommandEmbed({
    title: `Security ✓ APP`,
    description: `**Server Name**\n${guildName}\n\n**Server ID**\n${guildId}\n\n**Guild Owner**\n${ownerMention}`,
    color: 0x0ea5e9,
    fields: [
      { name: "Boosts", value: `${formatInteger(boostCount)} Boosts`, inline: true },
      { name: "Channels", value: `${formatInteger(channelCount)} Channels`, inline: true },
      { name: "Roles", value: `${formatInteger(roleCount)} Roles`, inline: true },
      { name: "Categories", value: `${formatInteger(categoryCount)} Categories`, inline: true },
      { name: "Members", value: `${formatInteger(memberCount)} Members`, inline: true }
    ],
    footer: { text: topLevelText || "No leveling data yet." }
  });
}

async function tryBuildServerStatsImagePayload({
  guildName,
  guildId,
  ownerId,
  ownerMention,
  createdAtText,
  memberCount,
  channelCount,
  roleCount,
  emojiCount,
  trackedMembers,
  iconUrl,
  topLevelText
}) {
  try {
    const imageData = await renderServerStatsCardImage({
      guildName,
      guildId,
      ownerId,
      createdAtText,
      memberCount,
      channelCount,
      roleCount,
      emojiCount,
      trackedMembers,
      iconUrl,
      topLevelText
    });

    return {
      embeds: [
        {
          title: `Server: ${guildName}`,
          author: { name: guildName, icon_url: iconUrl || undefined },
          thumbnail: { url: iconUrl || undefined },
          description: `${ownerMention} | ${formatInteger(memberCount)} members`,
          color: 0x0ea5e9,
          image: {
            url: `attachment://${SERVER_STATS_IMAGE_FILE}`
          },
          footer: {
            text: "Use /rank to view your level card."
          },
          timestamp: new Date().toISOString()
        }
      ],
      files: [
        {
          name: SERVER_STATS_IMAGE_FILE,
          attachment: imageData
        }
      ]
    };
  } catch {
    return null;
  }
}

function buildLeaderboardPayload({ rows, page, totalPages, trackedMembers }) {
  const lines = rows.map((entry) => {
    const index = String(entry.rank).padStart(2, "0");
    return `${index}. <@${entry.user_id}> | L${entry.level} | ${formatInteger(entry.xp)} XP | ${formatInteger(entry.message_count)} msg`;
  });

  return createCommandEmbed({
    title: "Level Leaderboard",
    description: lines.length > 0 ? lines.join("\n") : "No leveling data yet.",
    color: 0x2ea043,
    fields: [
      {
        name: "Page",
        value: `${page}/${totalPages}`,
        inline: true
      },
      {
        name: "Tracked Members",
        value: formatInteger(trackedMembers),
        inline: true
      },
      {
        name: "Page Size",
        value: "10",
        inline: true
      }
    ],
    footer: buildPaginationFooterText("Use /rank [user] for a detailed level card.", totalPages)
  });
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatVoiceHours(seconds) {
  const normalizedSeconds = Math.max(0, Number(seconds || 0));
  const hours = normalizedSeconds / 3600;
  const roundedHours = Math.round(hours * 10) / 10;
  return `${roundedHours.toFixed(1).replace(/\.0$/, "")}h`;
}

function buildActivityBoardPayload({ rows, page, totalPages, trackedMembers }) {
  const lines = rows.map((entry) => {
    const index = String(entry.rank).padStart(2, "0");
    return `${index}. <@${entry.user_id}> | voice: ${formatVoiceHours(entry.voice_seconds)} (${formatDuration(entry.voice_seconds)}) | messages: ${formatInteger(entry.message_count)}`;
  });

  return createCommandEmbed({
    title: "Activity Leaderboard",
    description: lines.length > 0 ? lines.join("\n") : "No activity data available.",
    color: 0x9b59b6,
    fields: [
      {
        name: "Page",
        value: `${page}/${totalPages}`,
        inline: true
      },
      {
        name: "Tracked Members",
        value: formatInteger(trackedMembers),
        inline: true
      },
      {
        name: "Page Size",
        value: "10",
        inline: true
      }
    ],
    footer: buildPaginationFooterText("Ranked by voice time first, then messages.", totalPages)
  });
}

export function createUtilityCommandHandlers({
  safeReply,
  config,
  aiLastUsedByUser,
  generateAiText,
  db,
  resolveGuildFromMessage,
  parseUserIdArg,
  formatUserMention,
  paginationRuntime = null
}) {
  const makeHelpCommand = (usage, summary, example = "") => ({
    usage: String(usage || "").trim(),
    summary: String(summary || "").trim(),
    example: String(example || "").trim()
  });

  const helpSections = {
    general: {
      title: "General",
      summary: "Core utility and info commands.",
      commands: [
        makeHelpCommand("help [section]", "Open this interactive command guide.", "/help moderation"),
        makeHelpCommand("stats", "Show server overview stats card.")
      ]
    },
    admin: {
      title: "Admin",
      summary: "Server configuration and policy commands.",
      commands: [
        makeHelpCommand("autosetup", "Auto-create channels, categories and map all config in one command."),
        makeHelpCommand("serverconfig", "Show current server configuration values."),
        makeHelpCommand(
          "setresourcechannels <rules> <chat> <help> <about> <perks>",
          "Set resource channel IDs used in templates and onboarding."
        ),
        makeHelpCommand("setroles <AdminRoleName> | <ModRoleName>", "Set staff role name mappings."),
        makeHelpCommand("setverificationurl <value|off>", "Set or clear the verification URL for joining members."),
        makeHelpCommand("raid", "Open the raid control center and configure raid protection."),
        makeHelpCommand(
          "setraidsettings <threshold> <join_rate_threshold> <window_seconds> <gate_duration_seconds> <timeout|kick>",
          "Update advanced raid thresholds in one command."
        ),
      ]
    },
    moderation: {
      title: "Moderation",
      summary: "Member actions, filters, and raid controls.",
      commands: [
        makeHelpCommand("warn <user> <reason>", "Issue a warning to a member."),
        makeHelpCommand("warnings [user]", "Show warning count for a member."),
        makeHelpCommand("purge <count> [channel_id]", "Bulk-delete up to 100 recent messages."),
        makeHelpCommand("kick <user> [reason]", "Kick a member from the server."),
        makeHelpCommand("ban <user> [reason]", "Ban a member from the server."),
        makeHelpCommand("unban <user>", "Remove a member ban."),
        makeHelpCommand("mute <user> [duration_minutes] [reason]", "Timeout a member for a duration."),
        makeHelpCommand("unmute <user> [reason]", "Remove timeout from a member."),
        makeHelpCommand("role", "Manage a member's roles with a dropdown menu."),
        makeHelpCommand("addrole <user> <role>", "Add one role to a member."),
        makeHelpCommand("removerole <user> <role>", "Remove one role from a member."),
        makeHelpCommand("blacklisted", "Manage blacklisted words (view, add, remove)."),
        makeHelpCommand("reloadwords", "Reload blacklisted words from disk."),
        makeHelpCommand("raidgate <on|off|status> [duration_seconds]", "Enable, disable, or inspect raid gate state."),
        makeHelpCommand("pendingverifications [limit]", "List members waiting for manual verification."),
        makeHelpCommand("raidsnapshot [limit]", "Show recent join risk events for moderation review.")
      ]
    },
    reactionroles: {
      title: "Reaction Roles",
      summary: "Manage reaction role mappings via interactive menus.",
      commands: [
        makeHelpCommand(
          "reactionroles",
          "Manage reaction role mappings (list, add, remove via dropdown menu)."
        )
      ]
    },
    leveling: {
      title: "Leveling",
      summary: "XP, rank, and leaderboard commands.",
      commands: [
        makeHelpCommand("rank [user]", "Show a user's level card and XP progress."),
        makeHelpCommand("leaderboard [page]", "Show XP leaderboard with pagination."),
        makeHelpCommand("activityboard [page]", "Show activity leaderboard (voice + messages).")
      ]
    },
    ai: {
      title: "AI",
      summary: "AI assistant prompts.",
      commands: [
        makeHelpCommand("ask <question>", "Ask the configured AI assistant."),
        makeHelpCommand("joke", "Get a short AI-generated joke.")
      ]
    }
  };

  const orderedHelpSections = ["general", "admin", "moderation", "reactionroles", "leveling", "ai"];

  const helpAliasToSection = {
    general: "general",
    basics: "general",
    utility: "general",
    utilities: "general",
    admin: "admin",
    staff: "admin",
    config: "admin",
    moderation: "moderation",
    mod: "moderation",
    reactionrole: "reactionroles",
    reactionroles: "reactionroles",
    rr: "reactionroles",
    leveling: "leveling",
    level: "leveling",
    xp: "leveling",
    verification: "moderation",
    raid: "moderation",
    activity: "leveling",
    ai: "ai"
  };

  function normalizeHelpSectionInput(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function formatHelpCommandLine(command) {
    const usage = String(command?.usage || "").trim();
    const summary = String(command?.summary || "").trim();
    if (usage && summary) {
      return `- \`/${usage}\` - ${summary}`;
    }

    if (usage) {
      return `- \`/${usage}\``;
    }

    return `- ${summary || "No details available."}`;
  }

  function buildHelpSectionSelectRow(selectedSectionKey = null) {
    const sectionEntries = orderedHelpSections.map((sectionKey) => {
      const section = helpSections[sectionKey];
      return {
        label: section.title,
        value: sectionKey,
        description: String(section.summary || "").slice(0, 100),
        default: selectedSectionKey === sectionKey
      };
    });

    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(HELP_SECTION_SELECT_ID)
        .setPlaceholder("Choose a help section")
        .addOptions(sectionEntries)
    );
  }

  function buildHelpCommandSelectRow(sectionKey) {
    const section = helpSections[sectionKey];
    if (!section || !Array.isArray(section.commands) || section.commands.length === 0) {
      return null;
    }

    const options = section.commands.slice(0, 25).map((command, index) => {
      const usage = String(command?.usage || `command-${index + 1}`).trim() || `command-${index + 1}`;
      const summary = String(command?.summary || "Show command details.").trim() || "Show command details.";
      return {
        label: usage.slice(0, 100),
        value: `${sectionKey}:${index}`,
        description: summary.slice(0, 100)
      };
    });

    if (options.length === 0) {
      return null;
    }

    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(HELP_COMMAND_SELECT_ID)
        .setPlaceholder("Choose a command for usage details")
        .addOptions(options)
    );
  }

  function buildHelpButtonRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(HELP_HOME_BUTTON_ID).setLabel("Overview").setStyle(ButtonStyle.Secondary)
    );
  }

  function buildHelpOverviewPayload() {
    return createCommandEmbed({
      title: "Help Menu",
      description: [
        "Choose a section from the dropdown to view command usage.",
        "Text commands can still use !help <section>."
      ].join("\n"),
      color: 0x5865f2,
      fields: orderedHelpSections.map((sectionKey) => {
        const section = helpSections[sectionKey];
        return {
          name: section.title,
          value: `${section.summary}\nCommands: ${section.commands.length}`,
          inline: true
        };
      }),
      footer: "Use /help to open this menu anytime."
    });
  }

  function buildHelpUnknownPayload(requestedSection) {
    return createCommandEmbed({
      title: "Help Section Not Found",
      description: `No help section matched \`${String(requestedSection || "").trim() || "unknown"}\`.`,
      color: 0xf59e0b,
      fields: [
        {
          name: "Try One Of These",
          value: orderedHelpSections.map((sectionKey) => `\`${sectionKey}\``).join(", "),
          inline: false
        }
      ],
      footer: "Tip: use /help and pick from the dropdown."
    });
  }

  function buildHelpComponentRows(sectionKey = null) {
    const rows = [];

    if (sectionKey) {
      rows.push(buildHelpButtonRow());
    }

    rows.push(buildHelpSectionSelectRow(sectionKey));

    if (sectionKey) {
      const commandRow = buildHelpCommandSelectRow(sectionKey);
      if (commandRow) {
        rows.push(commandRow);
      }
    }

    return rows;
  }

  function buildHelpOverviewInteractivePayload() {
    return {
      ...buildHelpOverviewPayload(),
      components: buildHelpComponentRows()
    };
  }

  function buildHelpSectionPayload(sectionKey) {
    const section = helpSections[sectionKey];
    const commandLines = section.commands.map((command) => formatHelpCommandLine(command));
    const commandFields = chunkEntries(commandLines, 6).map((entries, index) => ({
      name: index === 0 ? "Commands" : "More Commands",
      value: entries.join("\n"),
      inline: false
    }));

    return createCommandEmbed({
      title: `${section.title} Commands`,
      description: section.summary,
      color: 0x5865f2,
      fields: commandFields,
      footer: "Use the command dropdown below for examples."
    });
  }

  function buildHelpSectionInteractivePayload(sectionKey) {
    return {
      ...buildHelpSectionPayload(sectionKey),
      components: buildHelpComponentRows(sectionKey)
    };
  }

  async function attachHelpInteractions(sentMessage, ownerUserId, initialSectionKey = null) {
    if (!sentMessage || typeof sentMessage.createMessageComponentCollector !== "function") {
      return;
    }

    let activeSectionKey = initialSectionKey && helpSections[initialSectionKey] ? initialSectionKey : null;

    const collector = sentMessage.createMessageComponentCollector({
      componentType: ComponentType.MessageComponent,
      time: 120000
    });

    collector.on("collect", async (interaction) => {
      try {
        const actorId = String(interaction.user?.id || "");
        if (ownerUserId && actorId !== ownerUserId) {
          await interaction.reply({
            content: "Run /help to open your own interactive help menu.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (interaction.customId === HELP_HOME_BUTTON_ID && interaction.isButton()) {
          activeSectionKey = null;
          await interaction.update(buildHelpOverviewInteractivePayload());
          return;
        }

        if (interaction.customId === HELP_SECTION_SELECT_ID && interaction.isStringSelectMenu()) {
          const selectedSectionKey = interaction.values[0];
          if (!selectedSectionKey || !helpSections[selectedSectionKey]) {
            await interaction.deferUpdate();
            return;
          }

          activeSectionKey = selectedSectionKey;
          await interaction.update(buildHelpSectionInteractivePayload(selectedSectionKey));
          return;
        }

        if (interaction.customId === HELP_COMMAND_SELECT_ID && interaction.isStringSelectMenu()) {
          const selectedValue = String(interaction.values?.[0] || "");
          const [sectionKey, indexText] = selectedValue.split(":");
          const section = helpSections[sectionKey];
          const commandIndex = Number.parseInt(indexText, 10);

          if (!section || !Number.isFinite(commandIndex) || commandIndex < 0 || commandIndex >= section.commands.length) {
            await interaction.deferUpdate();
            return;
          }

          const command = section.commands[commandIndex];
          const usage = String(command?.usage || "").trim();
          const summary = String(command?.summary || "").trim();
          const example = String(command?.example || "").trim();
          const detailLines = [usage ? `\`/${usage}\`` : "`Unknown command`"];

          if (summary) {
            detailLines.push(summary);
          }

          if (example) {
            detailLines.push(`Example: \`${example}\``);
          }

          await interaction.reply({
            content: detailLines.join("\n"),
            flags: MessageFlags.Ephemeral
          });
        }
      } catch {
        // Best effort interactive help.
      }
    });

    collector.on("end", async () => {
      try {
        const disabledRows = buildHelpComponentRows(activeSectionKey);
        for (const row of disabledRows) {
          for (const component of row.components) {
            component.setDisabled(true);
          }
        }

        await sentMessage.edit({ components: disabledRows }).catch(() => null);
      } catch {
        // Best effort cleanup.
      }
    });
  }

  async function sendPaginatedBoard(message, loadPage, requestedPage = 1) {
    const initialState = await loadPage(requestedPage);
    const sentMessage = await safeReply(message, initialState.payload);

    if (
      sentMessage &&
      paginationRuntime &&
      typeof paginationRuntime.registerPaginatedMessage === "function" &&
      initialState.totalPages > 1
    ) {
      await paginationRuntime.registerPaginatedMessage({
        sentMessage,
        currentPage: initialState.page,
        totalPages: initialState.totalPages,
        getPagePayload: loadPage,
        ownerUserId: message?.author?.id || message?.user?.id || null
      });
    }

    return sentMessage;
  }

  const handlers = {
    async help({ message, args }) {
      const requested = String(Array.isArray(args) ? args.join(" ").trim() : "").trim();
      if (requested) {
        const normalizedRequested = normalizeHelpSectionInput(requested);
        const sectionKey = helpAliasToSection[normalizedRequested];

        if (!sectionKey) {
          await safeReply(message, buildHelpUnknownPayload(requested));
          return;
        }

        const sentMessage = await safeReply(message, buildHelpSectionInteractivePayload(sectionKey));
        await attachHelpInteractions(sentMessage, message?.author?.id || message?.user?.id || null, sectionKey);
        return;
      }

      const sentMessage = await safeReply(message, buildHelpOverviewInteractivePayload());
      await attachHelpInteractions(sentMessage, message?.author?.id || message?.user?.id || null);
    },

    async stats({ message }) {
      const guild = await resolveGuildFromMessage(message);
      if (!guild) {
        await safeReply(message, "This command only works in a server.");
        return;
      }

      // Performance: Parallel fetching for guild data
      const [channelsResult, rolesResult, emojisResult, trackedMembers, topLeaderboard] = await Promise.allSettled([
        Promise.resolve().then(async () => {
          let count = Math.max(0, Number(guild.channels?.cache?.size || 0));
          if (count === 0 && typeof guild.channels?.fetch === "function") {
            try {
              const channels = await guild.channels.fetch();
              count = channels?.size || Math.max(0, Number(guild.channels?.cache?.size || 0));
            } catch {
              // Best effort.
            }
          }
          return count;
        }),
        Promise.resolve().then(async () => {
          let count = Math.max(0, Number(guild.roles?.cache?.size || 0));
          if (count === 0 && typeof guild.roles?.fetch === "function") {
            try {
              const roles = await guild.roles.fetch();
              count = roles?.size || Math.max(0, Number(guild.roles?.cache?.size || 0));
            } catch {
              // Best effort.
            }
          }
          return count;
        }),
        Promise.resolve().then(async () => {
          let count = Math.max(0, Number(guild.emojis?.cache?.size || 0));
          if (count === 0 && typeof guild.emojis?.fetch === "function") {
            try {
              const emojis = await guild.emojis.fetch();
              count = emojis?.size || Math.max(0, Number(guild.emojis?.cache?.size || 0));
            } catch {
              // Best effort.
            }
          }
          return count;
        }),
        db.getLevelMemberCount(guild.id),
        db.listLevelLeaderboard(guild.id, 1, 0)
      ]);

      const channelCount = channelsResult.status === 'fulfilled' ? channelsResult.value : 0;
      let roleCount = rolesResult.status === 'fulfilled' ? rolesResult.value : 0;
      let emojiCount = emojisResult.status === 'fulfilled' ? emojisResult.value : 0;
      const trackedMemberCount = trackedMembers.status === 'fulfilled' ? trackedMembers.value : 0;
      const topEntry = topLeaderboard.status === 'fulfilled' ? topLeaderboard.value?.[0] || null : null;

      const categoryCount = Math.max(0, Number(guild.channels?.cache?.filter((ch) => ch?.type === 4)?.size || 0));
      const boostCount = Math.max(0, Number(guild.premiumSubscriptionCount || 0));

      const rawMemberCount = [guild.memberCount, guild.member_count, guild.approximate_member_count]
        .map((value) => Number(value))
        .find((value) => Number.isFinite(value) && value > 0);
      let memberCount = Math.max(
        0,
        Number.isFinite(rawMemberCount) ? rawMemberCount : Number(guild.members?.cache?.size || 0)
      );

      memberCount = Math.max(memberCount, trackedMemberCount);

      const createdAtText = formatDateTimeUtc(resolveGuildCreatedAt(guild));
      const ownerId = String(guild.ownerId || "").trim();
      const ownerMention = ownerId ? formatUserMention(ownerId) : "Unknown";
      const topLevelText = topEntry
        ? `${formatUserMention(topEntry.user_id)} | L${topEntry.level} | ${formatInteger(topEntry.xp)} XP`
        : "No leveling data yet.";
      const topLevelImageText = topEntry
        ? `#1 ${topEntry.user_id} | L${topEntry.level} | ${formatInteger(topEntry.xp)} XP`
        : "No leveling data yet.";

      const imagePayload = await tryBuildServerStatsImagePayload({
        guildName: String(guild.name || "Unknown Server"),
        guildId: String(guild.id || "-"),
        ownerId,
        ownerMention,
        createdAtText,
        memberCount,
        channelCount,
        roleCount,
        emojiCount,
        trackedMembers,
        iconUrl: resolveGuildIconUrl(guild),
        topLevelText: topLevelImageText
      });

      if (imagePayload) {
        await safeReply(message, imagePayload);
        return;
      }

      await safeReply(
        message,
        buildServerStatsPayload({
          guildName: String(guild.name || "Unknown Server"),
          guildId: String(guild.id || "-"),
          ownerMention,
          createdAtText,
          memberCount,
          channelCount,
          categoryCount,
          roleCount,
          emojiCount,
          boostCount,
          trackedMembers: trackedMemberCount,
          topLevelText
        })
      );
    },

    async rank({ message, args }) {
      const guild = await resolveGuildFromMessage(message);
      if (!guild) {
        await safeReply(message, "This command only works in a server.");
        return;
      }

      const guildConfig = await db.getGuildConfig(guild.id);
      const targetUserId = parseUserIdArg(args[0]) || message.author.id;
      const [snapshot, rank, trackedCount] = await Promise.all([
        db.getMemberLevel(guild.id, targetUserId),
        db.getMemberLevelRank(guild.id, targetUserId),
        db.getLevelMemberCount(guild.id)
      ]);
      const trackedMembers = Math.max(Number(rank || 1), Number(trackedCount || 0));

      const selfTarget = String(targetUserId) === String(message.author?.id || "");
      let displayName = selfTarget
        ? String(message.author?.globalName || message.author?.displayName || message.author?.username || targetUserId)
        : String(targetUserId);
      let avatarUrl = selfTarget ? resolveAvatarUrl(message.author) : null;

      try {
        const cachedMember = guild.members?.cache?.get?.(targetUserId) || null;
        const fetchedMember =
          cachedMember || (typeof guild.members?.fetch === "function" ? await guild.members.fetch(targetUserId) : null);

        if (fetchedMember) {
          displayName = String(
            fetchedMember.displayName ||
              fetchedMember.nick ||
              fetchedMember.user?.globalName ||
              fetchedMember.user?.displayName ||
              fetchedMember.user?.username ||
              displayName
          );

          avatarUrl = avatarUrl || resolveAvatarUrl(fetchedMember.user || fetchedMember);
        }
      } catch {
        // Best effort profile data.
      }

      const imagePayload = await tryBuildLevelCardImageAttachmentPayload({
        displayName,
        avatarUrl,
        level: snapshot.level,
        rank,
        trackedMembers,
        progressXp: snapshot.progress_xp,
        progressRequired: snapshot.progress_required,
        totalXp: snapshot.xp,
        messageCount: snapshot.message_count,
        levelCardStyle: {
          primaryColor: guildConfig.level_card_primary_color,
          accentColor: guildConfig.level_card_accent_color,
          overlayOpacity: guildConfig.level_card_overlay_opacity,
          backgroundUrl: guildConfig.level_card_background_url || STATIC_LEVEL_CARD_PATH,
          fontStyle: guildConfig.level_card_font
        }
      });

      if (imagePayload) {
        await safeReply(message, imagePayload);
        return;
      }

      await safeReply(
        message,
        `Rank data: Level ${snapshot.level} | Rank #${rank}/${trackedMembers} | XP ${snapshot.progress_xp}/${snapshot.progress_required}`
      );
    },

    async leaderboard({ message, args }) {
      const guild = await resolveGuildFromMessage(message);
      if (!guild) {
        await safeReply(message, "This command only works in a server.");
        return;
      }

      const requestedPage = Number.parseInt(String(args[0] || "1"), 10);
      const initialPage = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
      const pageSize = 10;

      const loadPage = async (requestedBoardPage) => {
        const trackedMembers = await db.getLevelMemberCount(guild.id);
        const totalPages = Math.max(1, Math.ceil(Math.max(0, trackedMembers) / pageSize));
        const page = Math.max(1, Math.min(Number(requestedBoardPage || 1), totalPages));
        const offset = (page - 1) * pageSize;
        const rows = await db.listLevelLeaderboard(guild.id, pageSize, offset);

        return {
          page,
          totalPages,
          payload: buildLeaderboardPayload({
            rows,
            page,
            totalPages,
            trackedMembers
          })
        };
      };

      await sendPaginatedBoard(message, loadPage, initialPage);
    },

    async activityboard({ message, args }) {
      const guild = await resolveGuildFromMessage(message);
      if (!guild) {
        await safeReply(message, "This command only works in a server.");
        return;
      }

      const requestedPage = Number.parseInt(String(args[0] || "1"), 10);
      const initialPage = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
      const pageSize = 10;

      const loadPage = async (requestedBoardPage) => {
        const trackedMembers = await db.getLevelMemberCount(guild.id);
        const totalPages = Math.max(1, Math.ceil(Math.max(0, trackedMembers) / pageSize));
        const page = Math.max(1, Math.min(Number(requestedBoardPage || 1), totalPages));
        const offset = (page - 1) * pageSize;
        const rows =
          typeof db.listActivityLeaderboard === "function"
            ? await db.listActivityLeaderboard(guild.id, pageSize, offset)
            : [];

        return {
          page,
          totalPages,
          payload: buildActivityBoardPayload({
            rows,
            page,
            totalPages,
            trackedMembers
          })
        };
      };

      await sendPaginatedBoard(message, loadPage, initialPage);
    },

    async ask({ message, args }) {
      const question = args.join(" ").trim();
      if (!question) {
        await safeReply(message, "Usage: ask <question>");
        return;
      }

      if (question.length > config.ai.maxQuestionLength) {
        await safeReply(message, `Question too long. Max ${config.ai.maxQuestionLength} characters.`);
        return;
      }

      if (!config.ai.apiKey) {
        await safeReply(message, "AI is not configured (missing GOOGLE_API_KEY).\n");
        return;
      }

      const now = Date.now();
      const lastUsed = aiLastUsedByUser.get(message.author.id) || 0;
      const cooldownMs = config.ai.rateLimitSeconds * 1000;
      if (now - lastUsed < cooldownMs) {
        const retryIn = Math.ceil((cooldownMs - (now - lastUsed)) / 1000);
        await safeReply(message, `AI rate limit active. Retry in ${retryIn}s.`);
        return;
      }

      aiLastUsedByUser.set(message.author.id, now);

      try {
        const answer = await generateAiText(question);
        const trimmed = answer.slice(0, config.ai.maxResponseLength);
        await safeReply(message, trimmed);
      } catch (error) {
        await safeReply(message, `AI request failed: ${String(error)}`);
      }
    },

    async joke({ message }) {
      return handlers.ask({
        message,
        args: ["Tell a short clean joke for a community server."]
      });
    }
  };

  return handlers;
}
