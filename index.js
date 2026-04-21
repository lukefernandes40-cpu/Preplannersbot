// ===== KEEP SERVER ALIVE =====
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("Bot is running"));
app.listen(PORT, () => console.log(`🌐 Server running on ${PORT}`));

require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  ChannelType
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

client.on("error", console.error);
process.on("unhandledRejection", console.error);

const activeRaids = new Map();

// ===== COMMAND =====
const commands = [
  new SlashCommandBuilder()
    .setName("raid")
    .setDescription("Create raid ticket")
];

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
})();

// ===== EMBED =====
function buildEmbed(raid) {
  return new EmbedBuilder()
    .setTitle("⚔ RAID ALERT")
    .setColor(0xff0000)
    .addFields(
      { name: "🌍 Region", value: raid.data.region },
      { name: "🤝 Allies", value: raid.data.allies },
      { name: "⚔ Enemies", value: raid.data.enemies },
      { name: "🔗 Link", value: raid.data.link }
    );
}

// ===== BUTTONS =====
function getRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("raid_ping")
        .setLabel("🔔 Raid Ping")
        .setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("edit_raid")
        .setLabel("✏️ Edit")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("end_raid")
        .setLabel("❌ End")
        .setStyle(ButtonStyle.Danger)
    )
  ];
}

// ===== INTERACTIONS =====
client.on("interactionCreate", async interaction => {

  // ===== COMMAND =====
  if (interaction.isChatInputCommand() && interaction.commandName === "raid") {
    const modal = new ModalBuilder()
      .setCustomId("raid_modal")
      .setTitle("⚔ Raid Setup");

    const fields = ["region", "allies", "enemies", "link"];

    modal.addComponents(
      ...fields.map(f =>
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(f)
            .setLabel(f.toUpperCase())
            .setStyle(TextInputStyle.Short)
        )
      )
    );

    return interaction.showModal(modal);
  }

  // ===== CREATE RAID =====
  if (interaction.isModalSubmit() && interaction.customId === "raid_modal") {

    await interaction.deferReply({ flags: 64 });

    const guild = interaction.guild;

    const channel = await guild.channels.create({
      name: `raid-${interaction.user.username}`,
      type: ChannelType.GuildText,
      parent: process.env.RAID_CATEGORY_ID,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        { id: process.env.RAID_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
      ]
    });

    const data = {
      region: interaction.fields.getTextInputValue("region"),
      allies: interaction.fields.getTextInputValue("allies"),
      enemies: interaction.fields.getTextInputValue("enemies"),
      link: interaction.fields.getTextInputValue("link"),
    };

    const msg = await channel.send({
      embeds: [buildEmbed({ data })],
      components: getRows()
    });

    activeRaids.set(channel.id, {
      owner: interaction.user.id,
      data,
      messageId: msg.id
    });

    return interaction.editReply({ content: `✅ Created <#${channel.id}>` });
  }

  // ===== EDIT SAVE =====
  if (interaction.isModalSubmit() && interaction.customId.startsWith("edit_")) {
    const id = interaction.customId.split("_")[1];
    const raid = activeRaids.get(id);
    if (!raid) return;

    raid.data.region = interaction.fields.getTextInputValue("region");
    raid.data.allies = interaction.fields.getTextInputValue("allies");
    raid.data.enemies = interaction.fields.getTextInputValue("enemies");
    raid.data.link = interaction.fields.getTextInputValue("link");

    return interaction.reply({ content: "✅ Raid Updated", flags: 64 });
  }

  // ===== BUTTONS =====
  if (interaction.isButton()) {

    const raid = activeRaids.get(interaction.channel.id);
    if (!raid) return;

    // ===== RAID PING =====
    if (interaction.customId === "raid_ping") {
  const member = await interaction.guild.members.fetch(interaction.user.id);

  // Give role
await interaction.deferReply({ ephemeral: true });

await interaction.channel.send({
  content: `🚨 RAID ALERT <@&${process.env.RAID_ROLE_ID}>`,
  allowedMentions: {
    roles: [process.env.RAID_ROLE_ID]
  }
});

return interaction.editReply({ content: "✅ Raid Ping Sent" });
    }


    // ===== END RAID =====
    if (interaction.customId === "end_raid") {
      if (interaction.user.id !== raid.owner) {
        return interaction.reply({ content: "❌ Only owner can end this raid", flags: 64 });
      }

      activeRaids.delete(interaction.channel.id);
      await interaction.reply({ content: "🛑 Raid Ended", flags: 64 });

      setTimeout(() => interaction.channel.delete().catch(()=>{}), 3000);
    }

    // ===== EDIT =====
    if (interaction.customId === "edit_raid") {
      const d = raid.data;

      const modal = new ModalBuilder()
        .setCustomId(`edit_${interaction.channel.id}`)
        .setTitle("Edit Raid");

      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("region").setLabel("Region").setStyle(TextInputStyle.Short).setValue(d.region)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("allies").setLabel("Allies").setStyle(TextInputStyle.Short).setValue(d.allies)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("enemies").setLabel("Enemies").setStyle(TextInputStyle.Short).setValue(d.enemies)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("link").setLabel("Link").setStyle(TextInputStyle.Short).setValue(d.link))
      );

      return interaction.showModal(modal);
    }
  }
});

// ===== LOGIN =====
client.login(process.env.TOKEN);

// ===== LIVE PANEL REFRESH =====
setInterval(async () => {
  for (const [channelId, raid] of activeRaids.entries()) {
    const channel = await client.channels.fetch(channelId).catch(()=>null);
    if (!channel) continue;

    if (raid.messageId) {
      const old = await channel.messages.fetch(raid.messageId).catch(()=>null);
      if (old) await old.delete().catch(()=>{});
    }

    const msg = await channel.send({
      embeds: [buildEmbed(raid)],
      components: getRows()
    });

    raid.messageId = msg.id;
  }
}, 30000);