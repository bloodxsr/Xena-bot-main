import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";

function formatRaidGateUntil(gateUntil) {
  return gateUntil ? `<t:${Math.floor(new Date(gateUntil).getTime() / 1000)}:R>` : "-";
}

function buildRaidPanelEmbed({ guildName, cfg, gateState }) {
  const gateUntil = gateState?.gate_until || null;
  const gateActive = Boolean(gateState?.gate_active);
  const lockdownUntil = gateState?.lockdown_until || null;
  const lockdownActive = Boolean(gateState?.lockdown_active);

  return new EmbedBuilder()
    .setTitle(`Raid Control Center · ${guildName}`)
    .setColor(gateActive || lockdownActive ? 0xdc2626 : 0x1f6feb)
    .setDescription([
      "Use the dropdown below to view status, update raid thresholds, enable the gate, or pull a recent snapshot.",
      `Current gate: ${gateActive ? "enabled" : "disabled"}`,
      `Current lockdown: ${lockdownActive ? "enabled" : "disabled"}`,
      gateState?.gate_reason ? `Reason: ${gateState.gate_reason}` : null
    ].filter(Boolean).join("\n"))
    .addFields(
      {
        name: "Gate State",
        value: [
          `Active: ${gateActive ? "yes" : "no"}`,
          `Until: ${formatRaidGateUntil(gateUntil)}`,
          `Reason: ${gateState?.gate_reason || "-"}`
        ].join("\n"),
        inline: true
      },
      {
        name: "Lockdown State",
        value: [
          `Active: ${lockdownActive ? "yes" : "no"}`,
          `Until: ${lockdownUntil ? `<t:${Math.floor(new Date(lockdownUntil).getTime() / 1000)}:R>` : "-"}`,
          `Reason: ${gateState?.lockdown_reason || "-"}`
        ].join("\n"),
        inline: true
      },
      {
        name: "Thresholds",
        value: [
          `Score: ${cfg.raid_gate_threshold}`,
          `Join Rate: ${cfg.raid_join_rate_threshold}`,
          `Window: ${cfg.raid_monitor_window_seconds}s`
        ].join("\n"),
        inline: true
      },
      {
        name: "Duration & Mode",
        value: [
          `Duration: ${cfg.gate_duration_seconds}s`,
          `Mode: ${cfg.join_gate_mode}`,
          `Detection: ${cfg.raid_detection_enabled ? "enabled" : "disabled"}`
        ].join("\n"),
        inline: true
      }
    )
    .setTimestamp();
}

function buildRaidActionRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("raid_action")
      .setPlaceholder("Choose a raid action")
      .addOptions([
        { label: "View Status", value: "status", description: "Refresh the current raid state" },
        { label: "Configure", value: "configure", description: "Open a setup modal for raid thresholds" },
        { label: "Enable Gate", value: "enable", description: "Turn raid gate on now" },
        { label: "Disable Gate", value: "disable", description: "Turn raid gate off now" },
        { label: "Snapshot", value: "snapshot", description: "Show recent join activity" }
      ])
  );
}

export function createAdminCommandHandlers({
  PermissionFlags,
  requirePermission,
  resolveGuildFromMessage,
  safeReply,
  db,
  parseSnowflake,
  getEffectiveGateState,
  getEffectiveLockdownState
}) {
  return {
    async serverconfig({ message }) {
      if (!(await requirePermission(message, PermissionFlags.Administrator))) {
        return;
      }
      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const cfg = await db.getGuildConfig(guild.id);
      
      const embed = new EmbedBuilder()
        .setTitle("Server Configuration")
        .setColor(0x1f6feb)
        .addFields(
          { name: 'Logging & Welcome', value: `Logs: <#${cfg.log_channel_id || '-'}>\nWelcome: <#${cfg.welcome_channel_id || '-'}>`, inline: true },
          { name: 'Resources', value: `Rules: <#${cfg.rules_channel_id || '-'}>\nChat: <#${cfg.chat_channel_id || '-'}>\nHelp: <#${cfg.help_channel_id || '-'}>\nAbout: <#${cfg.about_channel_id || '-'}>\nPerks: <#${cfg.perks_channel_id || '-'}>`, inline: true },
          { name: 'Leveling', value: `Channel: <#${cfg.leveling_channel_id || '-'}>`, inline: true },
          { name: 'Roles', value: `Admin: ${cfg.admin_role_name}\nMod: ${cfg.mod_role_name}`, inline: true },
          { name: 'Security', value: `Gate Threshold: ${cfg.raid_gate_threshold}\nJoin Rate: ${cfg.raid_join_rate_threshold}\nWindow: ${cfg.raid_monitor_window_seconds}s\nDuration: ${cfg.gate_duration_seconds}s`, inline: true }
        )
        .setTimestamp();
        
      if (typeof message.reply === "function") {
        await message.reply({ embeds: [embed] });
      } else {
        await safeReply(message, "Config output displayed.");
      }
    },

    async setresourcechannels({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.Administrator))) return;
      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      if (args.length < 5) {
        await safeReply(message, "Usage: setresourcechannels <rules> <chat> <help> <about> <perks>");
        return;
      }

      const [rules, chat, help, about, perks] = args.map(parseSnowflake);
      await db.updateGuildConfig(guild.id, {
        rules_channel_id: rules,
        chat_channel_id: chat,
        help_channel_id: help,
        about_channel_id: about,
        perks_channel_id: perks
      });

      await safeReply(message, "Resource channels updated.");
    },

    async setroles({ message, body }) {
      if (!(await requirePermission(message, PermissionFlags.Administrator))) return;
      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const payload = body.replace(/^setroles\\s+/i, "").trim();
      if (!payload.includes("|")) {
        await safeReply(message, "Usage: setroles <AdminRoleName> | <ModRoleName>");
        return;
      }

      const [adminRole, modRole] = payload.split("|").map((entry) => entry.trim());
      await db.updateGuildConfig(guild.id, {
        admin_role_name: adminRole,
        mod_role_name: modRole
      });

      await safeReply(message, `Role names updated: admin=${adminRole}, mod=${modRole}.`);
    },

    async setverificationurl({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.Administrator))) return;
      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const value = args.join(" ").trim();
      const lowered = value.toLowerCase();
      if (["", "off", "none", "clear", "null"].includes(lowered)) {
        await db.updateGuildConfig(guild.id, { verification_url: null });
        await safeReply(message, "Verification URL cleared. Manual review mode is active.");
        return;
      }

      await db.updateGuildConfig(guild.id, { verification_url: value });
      await safeReply(message, "Verification URL updated.");
    },

    async raid({ message }) {
      if (!(await requirePermission(message, PermissionFlags.Administrator))) return;

      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      const cfg = await db.getGuildConfig(guild.id);
      const gateState = typeof getEffectiveGateState === "function"
        ? await getEffectiveGateState(guild.id)
        : await db.getRaidGateState(guild.id);
      const lockdownState = typeof getEffectiveLockdownState === "function"
        ? await getEffectiveLockdownState(guild.id, guild)
        : await db.getRaidLockdownState(guild.id);

      const sent = await safeReply(message, {
        content: "Raid control center:",
        embeds: [buildRaidPanelEmbed({ guildName: guild.name || guild.id, cfg, gateState: { ...gateState, ...lockdownState } })],
        components: [buildRaidActionRow()]
      });

      if (!sent || typeof sent.createMessageComponentCollector !== "function") {
        return;
      }

      const ownerId = String(message.author?.id || message.user?.id || "").trim();
      const collector = sent.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 120000 });

      collector.on("collect", async (interaction) => {
        const actorId = String(interaction.user?.id || "").trim();
        if (ownerId && actorId !== ownerId) {
          return interaction.reply({ content: "Run /raid to open your own raid control center.", flags: MessageFlags.Ephemeral });
        }

        const action = String(interaction.values?.[0] || "").trim();
        const currentCfg = await db.getGuildConfig(guild.id);
        const currentState = typeof getEffectiveGateState === "function"
          ? await getEffectiveGateState(guild.id)
          : await db.getRaidGateState(guild.id);
        const currentLockdownState = typeof getEffectiveLockdownState === "function"
          ? await getEffectiveLockdownState(guild.id, guild)
          : await db.getRaidLockdownState(guild.id);

        if (action === "status") {
          return interaction.update({
            content: "Raid control center:",
            embeds: [buildRaidPanelEmbed({ guildName: guild.name || guild.id, cfg: currentCfg, gateState: { ...currentState, ...currentLockdownState } })],
            components: [buildRaidActionRow()]
          });
        }

        if (action === "enable") {
          const gateUntil = new Date(Date.now() + Math.max(60, Number(currentCfg.gate_duration_seconds || 300)) * 1000).toISOString();
          await db.setRaidGateState(guild.id, true, `Manual gate enabled by ${actorId}`, gateUntil);
          const refreshed = typeof getEffectiveGateState === "function"
            ? await getEffectiveGateState(guild.id)
            : await db.getRaidGateState(guild.id);
          const refreshedLockdown = typeof getEffectiveLockdownState === "function"
            ? await getEffectiveLockdownState(guild.id, guild)
            : await db.getRaidLockdownState(guild.id);

          return interaction.update({
            content: "Raid control center:",
            embeds: [buildRaidPanelEmbed({ guildName: guild.name || guild.id, cfg: currentCfg, gateState: { ...refreshed, ...refreshedLockdown } })],
            components: [buildRaidActionRow()]
          });
        }

        if (action === "disable") {
          await db.setRaidGateState(guild.id, false, "Manual disable by staff", null);
          const refreshed = typeof getEffectiveGateState === "function"
            ? await getEffectiveGateState(guild.id)
            : await db.getRaidGateState(guild.id);
          const refreshedLockdown = typeof getEffectiveLockdownState === "function"
            ? await getEffectiveLockdownState(guild.id, guild)
            : await db.getRaidLockdownState(guild.id);

          return interaction.update({
            content: "Raid control center:",
            embeds: [buildRaidPanelEmbed({ guildName: guild.name || guild.id, cfg: currentCfg, gateState: { ...refreshed, ...refreshedLockdown } })],
            components: [buildRaidActionRow()]
          });
        }

        if (action === "snapshot") {
          const events = await db.listRecentJoinEvents(guild.id, 8);
          if (events.length === 0) {
            return interaction.reply({ content: "No join events recorded yet.", flags: MessageFlags.Ephemeral });
          }

          const lines = events.map((entry) => `- <@${entry.user_id}> | action=${entry.action} | risk=${Number(entry.risk_score || 0).toFixed(3)} | level=${entry.risk_level}`);
          return interaction.reply({
            content: ["Recent join events:", ...lines].join("\n"),
            flags: MessageFlags.Ephemeral
          });
        }

        if (action === "configure") {
          const modal = new ModalBuilder()
            .setCustomId("raid_config_modal")
            .setTitle("Configure Raid Controls");

          const threshold = new TextInputBuilder()
            .setCustomId("raid_gate_threshold")
            .setLabel("Gate threshold (0 to 1)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(currentCfg.raid_gate_threshold ?? 0.72));

          const joinRate = new TextInputBuilder()
            .setCustomId("raid_join_rate_threshold")
            .setLabel("Join rate threshold")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(currentCfg.raid_join_rate_threshold ?? 8));

          const windowSeconds = new TextInputBuilder()
            .setCustomId("raid_monitor_window_seconds")
            .setLabel("Monitor window seconds")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(currentCfg.raid_monitor_window_seconds ?? 90));

          const durationSeconds = new TextInputBuilder()
            .setCustomId("gate_duration_seconds")
            .setLabel("Gate duration seconds")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(currentCfg.gate_duration_seconds ?? 300));

          const mode = new TextInputBuilder()
            .setCustomId("join_gate_mode")
            .setLabel("Gate mode (timeout or kick)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(currentCfg.join_gate_mode || "timeout"));

          modal.addComponents(
            new ActionRowBuilder().addComponents(threshold),
            new ActionRowBuilder().addComponents(joinRate),
            new ActionRowBuilder().addComponents(windowSeconds),
            new ActionRowBuilder().addComponents(durationSeconds),
            new ActionRowBuilder().addComponents(mode)
          );

          return interaction.showModal(modal);
        }
      });

      collector.on("end", async () => {
        try {
          const disabledRows = [buildRaidActionRow()];
          for (const row of disabledRows) {
            for (const component of row.components) {
              component.setDisabled(true);
            }
          }

          await sent.edit({ components: disabledRows }).catch(() => null);
        } catch {
          // best effort cleanup
        }
      });
    },

    async setraidsettings({ message, args }) {
      if (!(await requirePermission(message, PermissionFlags.Administrator))) return;
      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      if (args.length < 5) return;

      const threshold = Math.max(0, Math.min(Number(args[0]), 1));
      const joinRateThreshold = Math.max(1, Math.min(Number(args[1]), 1000));
      const windowSeconds = Math.max(30, Math.min(Number(args[2]), 3600));
      const gateDurationSeconds = Math.max(60, Math.min(Number(args[3]), 86400));
      const mode = String(args[4] || "timeout").toLowerCase() === "kick" ? "kick" : "timeout";

      await db.updateGuildConfig(guild.id, {
        raid_gate_threshold: threshold,
        raid_join_rate_threshold: joinRateThreshold,
        raid_monitor_window_seconds: windowSeconds,
        gate_duration_seconds: gateDurationSeconds,
        join_gate_mode: mode
      });

      await safeReply(
        message,
        `Raid settings updated: threshold=${threshold}, join_rate=${joinRateThreshold}, window=${windowSeconds}s, duration=${gateDurationSeconds}s, mode=${mode}.`
      );
    },

    async autosetup({ message }) {
      if (!(await requirePermission(message, PermissionFlags.Administrator))) return;

      const guild = await resolveGuildFromMessage(message);
      if (!guild) return;

      if (!guild.channels || typeof guild.channels.create !== "function") {
        await safeReply(message, "Bot lacks permission to manage channels in this server.", {
          title: "Auto Setup",
          kind: "error"
        });
        return;
      }

      await safeReply(message, "⚙️ Running auto-setup — creating channels and saving configuration...", {
        title: "Auto Setup"
      });

      const reason = "Xena auto-setup";
      const cache = guild.channels.cache;

      // Find existing channel by name + type, or create it
      const findOrCreate = async (name, type, parentId = undefined) => {
        const normalizedName = name.toLowerCase().replace(/\s+/g, "-");
        const existing = cache.find(
          (c) =>
            c.type === type &&
            c.name.toLowerCase() === normalizedName &&
            (parentId === undefined || c.parentId === parentId)
        );
        if (existing) return { channel: existing, created: false };
        try {
          const options = { name, type, reason };
          if (parentId) options.parent = parentId;
          const channel = await guild.channels.create(options);
          return { channel, created: true };
        } catch {
          return { channel: null, created: false };
        }
      };

      // ── Categories (type 4) ────────────────────────────────────────────────
      const { channel: mainCat,   created: mainCatNew   } = await findOrCreate("🌐 Server Hub", 4);
      const { channel: staffCat,  created: staffCatNew  } = await findOrCreate("🔒 Staff", 4);

      const mainId  = mainCat?.id  ?? undefined;
      const staffId = staffCat?.id ?? undefined;

      // ── Public channels (type 0) ───────────────────────────────────────────
      const { channel: rulesChannel,   created: rulesNew   } = await findOrCreate("rules",     0, mainId);
      const { channel: chatChannel,    created: chatNew    } = await findOrCreate("general",   0, mainId);
      const { channel: helpChannel,    created: helpNew    } = await findOrCreate("help",      0, mainId);
      const { channel: aboutChannel,   created: aboutNew   } = await findOrCreate("about",     0, mainId);
      const { channel: perksChannel,   created: perksNew   } = await findOrCreate("perks",     0, mainId);
      const { channel: welcomeChannel, created: welcomeNew } = await findOrCreate("welcome",   0, mainId);
      const { channel: levelChannel,   created: levelNew   } = await findOrCreate("level-ups", 0, mainId);

      // ── Staff channels ─────────────────────────────────────────────────────
      const { channel: logChannel, created: logNew } = await findOrCreate("mod-logs", 0, staffId);

      // ── Save everything to guild config ────────────────────────────────────
      const updates = {};
      if (rulesChannel)   updates.rules_channel_id   = rulesChannel.id;
      if (chatChannel)    updates.chat_channel_id     = chatChannel.id;
      if (helpChannel)    updates.help_channel_id     = helpChannel.id;
      if (aboutChannel)   updates.about_channel_id    = aboutChannel.id;
      if (perksChannel)   updates.perks_channel_id    = perksChannel.id;
      if (welcomeChannel) updates.welcome_channel_id  = welcomeChannel.id;
      if (levelChannel)   updates.leveling_channel_id = levelChannel.id;
      if (logChannel)     updates.log_channel_id      = logChannel.id;

      if (Object.keys(updates).length > 0) {
        await db.updateGuildConfig(guild.id, updates);
      }

      // ── Build result summary ───────────────────────────────────────────────
      const ch = (channel, wasCreated, label) => {
        if (!channel) return `⚠️ Failed to create ${label}`;
        const tag = wasCreated ? "created" : "existing";
        return `✅ <#${channel.id}> — ${label} *(${tag})*`;
      };

      const catLine = (cat, wasCreated, name) =>
        cat
          ? `📁 **${cat.name}** *(${wasCreated ? "created" : "existing"})*`
          : `⚠️ ${name} category failed`;

      const lines = [
        catLine(mainCat,  mainCatNew,  "🌐 Server Hub"),
        ch(rulesChannel,   rulesNew,   "rules"),
        ch(chatChannel,    chatNew,    "general chat"),
        ch(helpChannel,    helpNew,    "help"),
        ch(aboutChannel,   aboutNew,   "about"),
        ch(perksChannel,   perksNew,   "perks"),
        ch(welcomeChannel, welcomeNew, "welcome"),
        ch(levelChannel,   levelNew,   "level-ups"),
        "",
        catLine(staffCat, staffCatNew, "🔒 Staff"),
        ch(logChannel,    logNew,      "mod-logs (logging)"),
        "",
        Object.keys(updates).length > 0
          ? `✅ ${Object.keys(updates).length} channel IDs saved to server config.`
          : "⚠️ No config was updated.",
        "Run `/serverconfig` to verify the full configuration."
      ];

      await safeReply(message, lines.join("\n"), {
        title: "Auto Setup Complete",
        kind: "success"
      });
    }
  };
}
