const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const fs = require("fs");
const DB_FILE = "./accounts.json";

// ===== DB =====
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return [];
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ===== EMBED =====
// showPassword should ONLY ever be true for ephemeral replies, never for public embeds
function buildAccountEmbed(acc, showPassword = false, displayName = null) {
  const embed = new EmbedBuilder()
    .setTitle("🔐 Account Access")
    .addFields(
      { name: "👤 Username", value: acc.username || "N/A" },
      {
        name: "🔑 Password",
        value: showPassword ? acc.password || "N/A" : "\\*\\*\\*\\*\\*\\*\\*"
      }
    )
    .setColor(0x00ffcc);

  if (acc.owner && displayName) {
    embed.addFields({
      name: "📌 Status",
      value: `Used by @${displayName}`
    });
  }

  return embed;
}

// ===== BUTTONS ROW =====
function getButtons(acc) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(acc.owner ? "stop_account" : "use_account")
      .setLabel(acc.owner ? "Stop Using" : "Want to Use?")
      .setStyle(acc.owner ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("edit_account")
      .setLabel("✏️ Edit")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("delete_account")
      .setLabel("🗑️ Delete")
      .setStyle(ButtonStyle.Danger)
  );
}

// ===== COMMAND =====
module.exports = {
  data: new SlashCommandBuilder()
    .setName("account")
    .setDescription("Manage shared accounts")
    .addSubcommand(c =>
      c.setName("add")
        .setDescription("Add a new account")
        .addStringOption(o =>
          o.setName("username")
            .setDescription("Account username")
            .setRequired(true)
        )
        .addStringOption(o =>
          o.setName("password")
            .setDescription("Account password")
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const sub = interaction.options.getSubcommand();

    // ===== ADD =====
    if (sub === "add") {
      if (!interaction.member.roles.cache.has(process.env.ACCOUNT_ROLE_ID)) {
        return interaction.editReply("❌ No permission");
      }

      const username = interaction.options.getString("username");
      const password = interaction.options.getString("password");

      let db = loadDB();

      // Public embed always has password hidden
      const msg = await interaction.editReply({
        embeds: [buildAccountEmbed({ username, password }, false)],
        components: [getButtons({ owner: null })],
        fetchReply: true
      });

      db.push({
        username,
        password,
        owner: null,
        messageId: msg.id,
        channelId: msg.channelId
      });

      saveDB(db);

      // Send the real password only to the adder via ephemeral follow-up
      await interaction.followUp({
        content: `✅ Account added. Password (only you can see this): ||\`${password}\`||`,
        ephemeral: true
      });
    }
  },

  // ===== MODAL HANDLER (edit save) =====
  async handleModal(interaction) {
    if (!interaction.customId.startsWith("edit_account_")) return;

    const messageId = interaction.customId.replace("edit_account_", "");
    let db = loadDB();
    const acc = db.find(a => a.messageId === messageId);
    if (!acc) return interaction.reply({ content: "❌ Account not found", ephemeral: true });

    acc.username = interaction.fields.getTextInputValue("username");
    acc.password = interaction.fields.getTextInputValue("password");
    saveDB(db);

    // Always update the public message with password hidden
    const channel = await interaction.client.channels.fetch(acc.channelId).catch(() => null);
    if (channel) {
      const msg = await channel.messages.fetch(acc.messageId).catch(() => null);
      if (msg) {
        await msg.edit({
          embeds: [buildAccountEmbed(acc, false)],
          components: [getButtons(acc)]
        });
      }
    }

    // Show the new password only to the editor via ephemeral
    return interaction.reply({
      content: `✅ Account updated. New password (only you can see this): ||\`${acc.password}\`||`,
      ephemeral: true
    });
  },

  // ===== BUTTON HANDLER =====
  async handleButton(interaction) {
    if (!interaction.isButton()) return;
    if (!["use_account", "stop_account", "edit_account", "delete_account"].includes(interaction.customId)) return;

    let db = loadDB();
    const acc = db.find(a => a.messageId === interaction.message.id);
    if (!acc) return;

    const hasRole = interaction.member.roles.cache.has(process.env.ACCOUNT_ROLE_ID);
    const displayName = interaction.member.displayName;

    // ===== USE =====
    if (interaction.customId === "use_account") {
      if (acc.owner) {
        return interaction.reply({ content: "❌ Already in use", ephemeral: true });
      }

      acc.owner = interaction.user.id;
      saveDB(db);

      // Public message always hides password
      await interaction.update({
        embeds: [buildAccountEmbed(acc, false, displayName)],
        components: [getButtons(acc)]
      });

      // If they have the role, send them the password ephemerally
      if (hasRole) {
        await interaction.followUp({
          content: `🔑 Password (only you can see this): ||\`${acc.password}\`||`,
          ephemeral: true
        });
      }

      return;
    }

    // ===== STOP =====
    if (interaction.customId === "stop_account") {
      if (interaction.user.id !== acc.owner) {
        return interaction.reply({ content: "❌ Not your account", ephemeral: true });
      }

      acc.owner = null;
      saveDB(db);

      // Public message always hides password
      return interaction.update({
        embeds: [buildAccountEmbed(acc, false)],
        components: [getButtons(acc)]
      });
    }

    // ===== EDIT =====
    if (interaction.customId === "edit_account") {
      if (!hasRole) {
        return interaction.reply({ content: "❌ No permission to edit", ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId(`edit_account_${acc.messageId}`)
        .setTitle("✏️ Edit Account");

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("username")
            .setLabel("Username")
            .setStyle(TextInputStyle.Short)
            .setValue(acc.username)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("password")
            .setLabel("Password")
            .setStyle(TextInputStyle.Short)
            .setValue(acc.password)
            .setRequired(true)
        )
      );

      return interaction.showModal(modal);
    }

    // ===== DELETE =====
    if (interaction.customId === "delete_account") {
      if (!hasRole) {
        return interaction.reply({ content: "❌ No permission to delete", ephemeral: true });
      }

      db = db.filter(a => a.messageId !== acc.messageId);
      saveDB(db);

      await interaction.message.delete().catch(() => {});
      return interaction.reply({ content: "🗑️ Account deleted", ephemeral: true }).catch(() => {});
    }
  }
};