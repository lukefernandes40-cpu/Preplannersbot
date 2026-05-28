// ===== INDEX.JS =====
require("dotenv").config();

// ===== EXPRESS SERVER =====
const express = require("express");
const app     = express();
const PORT    = process.env.PORT || 3000;

// Keep-alive ping route
app.get("/", (req, res) => res.send("Bot is running"));

// IMPORTANT: Register tracker routes BEFORE app.listen()
// tracker.js adds /join/:token  /r/:token  /access/:token  /invite/:token  /s/:token
const tracker = require("./tracker");
tracker.registerRoutes(app);

app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

// ===== DISCORD =====
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes
} = require("discord.js");

const hitlistCommand = require("./hitlist");
const accountSystem  = require("./accountsystem");
const raid           = require("./raid");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

client.on("error", console.error);
process.on("unhandledRejection", console.error);
process.on("uncaughtException",  console.error);

// ===== REGISTER SLASH COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName("raid").setDescription("Create raid ticket"),
  hitlistCommand.data,
  accountSystem.data,
  // Tracker admin commands
  new SlashCommandBuilder()
    .setName("tracker")
    .setDescription("Anti-leak tracker admin commands")
    .addSubcommand(c =>
      c.setName("lookup")
        .setDescription("Look up which member owns a token")
        .addStringOption(o => o.setName("token").setRequired(true).setDescription("Token code e.g. T91X"))
    )
    .addSubcommand(c =>
      c.setName("report")
        .setDescription("Post raid leak report to admin channel")
        .addStringOption(o => o.setName("raidid").setRequired(true).setDescription("Raid ID"))
    )
    .addSubcommand(c =>
      c.setName("profile")
        .setDescription("Show a member's full leak profile across all raids")
        .addUserOption(o => o.setName("user").setRequired(true).setDescription("Discord member"))
    )
    .addSubcommand(c =>
      c.setName("dashboard")
        .setDescription("Refresh and post the tracker dashboard now")
    )
];

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
(async () => {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
})();

// ===== INTERACTIONS =====
client.on("interactionCreate", async interaction => {

  // ===== SLASH COMMANDS =====
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "raid")    return raid.createRaid(interaction);
    if (interaction.commandName === "hitlist") return hitlistCommand.execute(interaction);
    if (interaction.commandName === "account") return accountSystem.execute(interaction);

    // ===== TRACKER COMMANDS =====
    if (interaction.commandName === "tracker") {
      // Only admins with the hitlist role can use tracker commands
      if (!interaction.member.roles.cache.has(process.env.HITLIST_ROLE_ID)) {
        return interaction.reply({ content: "❌ No permission.", flags: 64 });
      }

      await interaction.deferReply({ flags: 64 });
      const sub = interaction.options.getSubcommand();

      if (sub === "lookup") {
        const token  = interaction.options.getString("token").toUpperCase().trim();
        const result = tracker.lookupToken(token);
        if (!result) return interaction.editReply(`❌ Token \`${token}\` not found in any raid.`);

        const { EmbedBuilder } = require("discord.js");
        const unique = result.uniqueVisitors || 0;
        const flag   = unique >= 3 ? "🚨 Multiple visitors — likely leaked" : unique >= 2 ? "⚠️ 2 unique visitors" : "✅ Single visitor";
        const embed = new EmbedBuilder()
          .setTitle(`🔍 Token Lookup: \`${token}\``)
          .setColor(unique >= 2 ? 0xff6600 : 0x00cc44)
          .addFields(
            { name: "👤 Owner",           value: `${result.discordTag} (<@${result.discordId}>)`, inline: true },
            { name: "🗂️ Raid",            value: result.raidId,                                   inline: true },
            { name: "🔢 Total Clicks",    value: String(result.clickCount || 0),                  inline: true },
            { name: "👥 Unique Visitors", value: String(unique),                                  inline: true },
            { name: "📊 Status",          value: flag,                                             inline: false }
          )
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      if (sub === "report") {
        const raidId = interaction.options.getString("raidid").trim();
        await tracker.postRaidReport(raidId);
        return interaction.editReply(`✅ Report for raid \`${raidId}\` posted to admin channel.`);
      }

      if (sub === "profile") {
        const user    = interaction.options.getUser("user");
        const profile = tracker.getUserProfile(user.id);
        if (!profile) return interaction.editReply(`❌ No tracker data for ${user.tag}.`);

        const { EmbedBuilder } = require("discord.js");
        const totalUnique = profile.totalUniqueVisitors || 0;
        const raidLines   = (profile.raidHistory || [])
          .slice(-10)
          .reverse()
          .map(r => {
            const flag = (r.uniqueVisitors || 0) >= 2 ? "🚨" : "✅";
            return `${flag} **${r.raidId}** — Clicks: ${r.clicks || 0} | Unique visitors: ${r.uniqueVisitors || 0}`;
          });

        const embed = new EmbedBuilder()
          .setTitle(`🕵️ Link Profile: ${profile.discordTag || user.tag}`)
          .setColor(totalUnique >= 4 ? 0xff0000 : totalUnique >= 2 ? 0xff6600 : 0x00cc44)
          .addFields(
            { name: "🔢 Total Clicks",         value: String(profile.totalClicks || 0),           inline: true },
            { name: "👥 Total Unique Visitors", value: String(totalUnique),                        inline: true },
            { name: "🗂️ Raids Participated",    value: String((profile.raidHistory || []).length), inline: true },
            { name: "📋 Raid History (last 10)", value: raidLines.join("\n") || "None",           inline: false }
          )
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      if (sub === "dashboard") {
        await tracker.refreshDashboard();
        return interaction.editReply("✅ Dashboard refreshed in the admin channel.");
      }

      return;
    }

    return;
  }

  // ===== MODAL SUBMITS =====
  if (interaction.isModalSubmit()) {
    if (interaction.customId === "raid_modal")            return raid.handleRaidModal(interaction);
    if (interaction.customId.startsWith("edit_raid_"))    return raid.handleEditModal(interaction);
    if (interaction.customId.startsWith("queue_modal_"))  return raid.handleQueueModal(interaction);
    if (interaction.customId.startsWith("edit_account_")) return accountSystem.handleModal(interaction);
    return;
  }

  // ===== USER SELECT MENUS =====
  if (interaction.isUserSelectMenu()) {
    await raid.handleSelectMenu(interaction);
    return;
  }

  // ===== BUTTONS =====
  if (interaction.isButton()) {
    const raidIds = [
      "raid_ping", "end_raid", "edit_raid",
      "member_ingame", "member_queue",
      "raid_confirm_end", "raid_skip_end", "raid_screenshot_end", "raid_raider_select"
    ];

    if (raidIds.includes(interaction.customId)) {
      await raid.handleButton(interaction, client);
      return;
    }

    await accountSystem.handleButton(interaction);
  }
});

// ===== MESSAGES =====
client.on("messageCreate", async message => {
  await raid.handleMessage(message);
});

// ===== READY =====
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  hitlistCommand.startTracker(client);
  raid.startRefresh(client);
  accountSystem.syncAllEmbeds(client);
  tracker.startTracker(client);        // start anti-leak tracker
  tracker.refreshDashboard().catch(console.error); // post initial dashboard
});

// ===== LOGIN =====
client.login(process.env.TOKEN);