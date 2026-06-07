// ===== INDEX.JS =====
require("dotenv").config();

// ===== EXPRESS SERVER =====
const express = require("express");
const app     = express();
const PORT    = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("Bot is running"));

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
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

client.on("error", console.error);
process.on("unhandledRejection", console.error);
process.on("uncaughtException",  console.error);

// ===== REGISTER SLASH COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName("raid").setDescription("Create raid ticket"),
  hitlistCommand.data,
  accountSystem.data
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
    return;
  }

  // ===== MODAL SUBMITS =====
  if (interaction.isModalSubmit()) {
    if (interaction.customId === "raid_modal")                    return raid.handleRaidModal(interaction);
    if (interaction.customId.startsWith("edit_raid_"))            return raid.handleEditModal(interaction);
    if (interaction.customId.startsWith("note_modal_"))           return raid.handleNoteModal(interaction);
    if (interaction.customId.startsWith("inposition_modal_"))     return raid.handleInPositionModal(interaction);
    if (interaction.customId.startsWith("edit_account_"))         return accountSystem.handleModal(interaction);
    return;
  }

  // ===== STRING SELECT MENUS =====
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "difficulty_preset_select") {
      await raid.handleSelectMenu(interaction);
      return;
    }
  }

  // ===== USER SELECT MENUS =====
  if (interaction.isUserSelectMenu()) {
    if (interaction.customId.startsWith("swap_target_")) {
      await accountSystem.handleButton(interaction);
      return;
    }
    // raid_raider_select
    await raid.handleSelectMenu(interaction);
    return;
  }

  // ===== BUTTONS =====
  if (interaction.isButton()) {
    const raidIds = [
      "raid_ping", "end_raid", "edit_raid",
      "member_ingame", "member_inposition",
      "raid_confirm_end", "raid_skip_end", "raid_screenshot_end",
      "raid_raider_select", "want_swap_account",
      "raid_note", "raid_open_modal",
      "note_send_ingame", "note_send_inposition", "note_send_both"
    ];

    if (raidIds.includes(interaction.customId)) {
      await raid.handleButton(interaction, client);
      return;
    }

    const accountIds = [
      "use_account", "stop_account", "edit_account",
      "delete_account", "member_swap", "confirm_swap"
    ];
    if (accountIds.includes(interaction.customId) ||
        interaction.customId.startsWith("member_swap_select_") ||
        interaction.customId.startsWith("confirm_swap_")) {
      await accountSystem.handleButton(interaction);
      return;
    }
  }

});

// ===== MESSAGES (raid screenshot detection) =====
client.on("messageCreate", async message => {
  await raid.handleMessage(message);
});

// ===== READY =====
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  hitlistCommand.startTracker(client);
  raid.startRefresh(client);
  raid.startQueueChecker(client);
  accountSystem.syncAllEmbeds(client);
});

// ===== LOGIN =====
client.login(process.env.TOKEN);