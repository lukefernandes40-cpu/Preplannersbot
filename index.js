// ===== KEEP SERVER ALIVE =====
require("dotenv").config();
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Bot is running"));
app.listen(PORT, () => console.log(`🌐 Server running on ${PORT}`));

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
    GatewayIntentBits.MessageContent  // Required for screenshot upload reading
  ]
});

client.on("error", console.error);
process.on("unhandledRejection", console.error);
process.on("uncaughtException",  console.error);

// ===== REGISTER COMMANDS =====
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
  // IMPORTANT: try raid buttons first for raid-specific IDs,
  // then fall through to accountSystem for account buttons.
  // This prevents accountSystem from consuming the interaction token
  // before raid.handleButton can respond (which caused Unknown Interaction errors).
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

    // Everything else goes to accountSystem
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
});

// ===== LOGIN =====
client.login(process.env.TOKEN);