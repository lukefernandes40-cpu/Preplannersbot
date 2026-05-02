// ===== RAID.JS =====
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  ChannelType
} = require("discord.js");

const activeRaids = new Map();

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

// ===== STATUS EMBED =====
function buildStatusEmbed(raid) {
  const ingame = raid.members?.ingame || [];
  const queue = raid.members?.queue || {};

  const ingameList =
    ingame.length > 0 ? ingame.map((id) => `<@${id}>`).join(", ") : "None";

  const queueLines =
    Object.entries(queue)
      .sort(([, a], [, b]) => a - b)
      .map(([userId, pos]) => `<@${userId}>: **#${pos}**`)
      .join("\n") || "None";

  return new EmbedBuilder()
    .setTitle("📊 Raid Status")
    .setColor(0xff6600)
    .addFields(
      { name: "🎮 In Game", value: ingameList },
      { name: "🔢 Pos in queue", value: queueLines }
    );
}

// ===== RAID CONTROL BUTTONS =====
function getControlRows() {
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
    ),
  ];
}

// ===== MEMBER ACTION BUTTONS =====
// Single compact message: [🎮 In Game] [🔢 Set Queue Position]
function getMemberActionRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("member_ingame")
        .setLabel("🎮 In Game")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("member_queue")
        .setLabel("🔢 Set Queue Position")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

// ===== CREATE RAID =====
async function createRaid(interaction) {
  const modal = new ModalBuilder()
    .setCustomId("raid_modal")
    .setTitle("⚔ Raid Setup");

  const fields = ["region", "allies", "enemies", "link"];
  modal.addComponents(
    ...fields.map((f) =>
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

// ===== HANDLE RAID MODAL SUBMIT =====
async function handleRaidModal(interaction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild;

  const channel = await guild.channels.create({
    name: `raid-${interaction.user.username}`,
    type: ChannelType.GuildText,
    parent: process.env.RAID_CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
        ],
      },
      {
        id: process.env.RAID_ROLE_ID,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
        ],
      },
    ],
  });

  const data = {
    region: interaction.fields.getTextInputValue("region"),
    allies: interaction.fields.getTextInputValue("allies"),
    enemies: interaction.fields.getTextInputValue("enemies"),
    link: interaction.fields.getTextInputValue("link"),
  };

  const raidState = {
    owner: interaction.user.id,
    data,
    lastPing: 0,
    members: { ingame: [], queue: {} },
    messageId: null,
    statusMessageId: null,
    memberActionMessageId: null,
  };

  // Send main raid embed + control buttons
  const msg = await channel.send({
    embeds: [buildEmbed({ data })],
    components: getControlRows(),
  });
  raidState.messageId = msg.id;

  // Send status embed
  const statusMsg = await channel.send({
    embeds: [buildStatusEmbed(raidState)],
  });
  raidState.statusMessageId = statusMsg.id;

  // Send single compact member action message
  const memberMsg = await channel.send({
    components: getMemberActionRow(),
  });
  raidState.memberActionMessageId = memberMsg.id;

  activeRaids.set(channel.id, raidState);

  return interaction.editReply({ content: `✅ Created <#${channel.id}>` });
}

// ===== HANDLE EDIT MODAL SUBMIT =====
async function handleEditModal(interaction) {
  await interaction.deferReply({ flags: 64 });

  const id = interaction.customId.replace("edit_raid_", "");
  const raid = activeRaids.get(id);
  if (!raid) return interaction.editReply({ content: "❌ Raid not found" });

  raid.data.region = interaction.fields.getTextInputValue("region");
  raid.data.allies = interaction.fields.getTextInputValue("allies");
  raid.data.enemies = interaction.fields.getTextInputValue("enemies");
  raid.data.link = interaction.fields.getTextInputValue("link");

  // Update the main embed immediately
  const channel = await interaction.client.channels.fetch(id).catch(() => null);
  if (channel && raid.messageId) {
    const msg = await channel.messages.fetch(raid.messageId).catch(() => null);
    if (msg) {
      await msg.edit({
        embeds: [buildEmbed(raid)],
        components: getControlRows(),
      });
    }
  }

  return interaction.editReply({ content: "✅ Raid Updated" });
}

// ===== HANDLE QUEUE MODAL SUBMIT =====
// customId format: "queue_modal_<channelId>"
async function handleQueueModal(interaction) {
  const channelId = interaction.customId.replace("queue_modal_", "");
  const raid = activeRaids.get(channelId);

  if (!raid) {
    return interaction.reply({ content: "❌ Raid not found", ephemeral: true });
  }

  const raw = interaction.fields.getTextInputValue("queue_number").trim();
  const num = parseInt(raw, 10);

  if (isNaN(num) || num < 1 || num > 50) {
    return interaction.reply({
      content: "❌ Please enter a number between **1** and **50**.",
      ephemeral: true,
    });
  }

  const userId = interaction.user.id;

  // Remove from In Game if they were there (mutually exclusive)
  const ingame = raid.members.ingame;
  const igIdx = ingame.indexOf(userId);
  if (igIdx !== -1) ingame.splice(igIdx, 1);

  // Toggle: if same number already set, clear it
  if (raid.members.queue[userId] === num) {
    delete raid.members.queue[userId];
    await interaction.deferUpdate().catch(() => {});
  } else {
    raid.members.queue[userId] = num;
    await interaction.deferUpdate().catch(() => {});
  }

  await updateStatusEmbed(interaction.client, channelId, raid);
}

// ===== UPDATE STATUS EMBED =====
async function updateStatusEmbed(client, channelId, raid) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;
  if (!raid.statusMessageId) return;
  const msg = await channel.messages
    .fetch(raid.statusMessageId)
    .catch(() => null);
  if (msg) {
    await msg.edit({ embeds: [buildStatusEmbed(raid)] });
  }
}

// ===== HANDLE BUTTONS =====
async function handleButton(interaction, client) {
  const raid = activeRaids.get(interaction.channel.id);
  if (!raid) return false; // not a raid button

  const customId = interaction.customId;

  // ===== RAID PING =====
  if (customId === "raid_ping") {
    const now = Date.now();
    const cooldown = 5 * 60 * 1000;

    if (now - raid.lastPing < cooldown) {
      const remainingMs = cooldown - (now - raid.lastPing);
      const minutes = Math.floor(remainingMs / 60000);
      const seconds = Math.ceil((remainingMs % 60000) / 1000);
      await interaction.reply({
        content: `⏳ Wait ${minutes}m ${seconds}s before pinging again.`,
        ephemeral: true,
      });
      return true;
    }

    raid.lastPing = now;
    await interaction.deferReply({ ephemeral: true });
    await interaction.channel.send({
      content: `🚨 RAID ALERT <@&${process.env.RAID_ROLE_ID}>`,
      allowedMentions: { roles: [process.env.RAID_ROLE_ID] },
    });
    await interaction.editReply({ content: "✅ Raid Ping Sent" });
    return true;
  }

  // ===== END RAID =====
  if (customId === "end_raid") {
    if (interaction.user.id !== raid.owner) {
      await interaction.reply({
        content: "❌ Only the owner can end this raid",
        ephemeral: true,
      });
      return true;
    }

    activeRaids.delete(interaction.channel.id);
    await interaction.reply({ content: "🛑 Raid Ended", ephemeral: true });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
    return true;
  }

  // ===== EDIT RAID =====
  if (customId === "edit_raid") {
    const d = raid.data;

    const modal = new ModalBuilder()
      .setCustomId(`edit_raid_${interaction.channel.id}`)
      .setTitle("Edit Raid");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("region")
          .setLabel("Region")
          .setStyle(TextInputStyle.Short)
          .setValue(d.region)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("allies")
          .setLabel("Allies")
          .setStyle(TextInputStyle.Short)
          .setValue(d.allies)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("enemies")
          .setLabel("Enemies")
          .setStyle(TextInputStyle.Short)
          .setValue(d.enemies)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("link")
          .setLabel("Link")
          .setStyle(TextInputStyle.Short)
          .setValue(d.link)
      )
    );

    await interaction.showModal(modal);
    return true;
  }

  // ===== IN GAME TOGGLE =====
  if (customId === "member_ingame") {
    const userId = interaction.user.id;
    const ingame = raid.members.ingame;
    const idx = ingame.indexOf(userId);

    // Remove from queue (mutually exclusive)
    if (raid.members.queue[userId] !== undefined) {
      delete raid.members.queue[userId];
    }

    if (idx === -1) {
      ingame.push(userId);
      await interaction.reply({
        content: "✅ You're marked **In Game**",
        ephemeral: true,
      });
    } else {
      ingame.splice(idx, 1);
      await interaction.reply({
        content: "❎ You're no longer **In Game**",
        ephemeral: true,
      });
    }

    await updateStatusEmbed(client, interaction.channel.id, raid);
    return true;
  }

  // ===== SET QUEUE POSITION (opens modal) =====
  if (customId === "member_queue") {
    const modal = new ModalBuilder()
      .setCustomId(`queue_modal_${interaction.channel.id}`)
      .setTitle("Set Queue Position");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("queue_number")
          .setLabel("Enter your position (1–50)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 12")
          .setMinLength(1)
          .setMaxLength(2)
          .setRequired(true)
      )
    );

    await interaction.showModal(modal);
    return true;
  }

  return false;
}

// ===== LIVE PANEL REFRESH =====
function startRefresh(client) {
  setInterval(async () => {
    for (const [channelId, raid] of activeRaids.entries()) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;

      // Refresh main embed
      if (raid.messageId) {
        const old = await channel.messages
          .fetch(raid.messageId)
          .catch(() => null);
        if (old) await old.delete().catch(() => {});
      }
      const msg = await channel.send({
        embeds: [buildEmbed(raid)],
        components: getControlRows(),
      });
      raid.messageId = msg.id;

      // Refresh status embed
      if (raid.statusMessageId) {
        const old = await channel.messages
          .fetch(raid.statusMessageId)
          .catch(() => null);
        if (old) await old.delete().catch(() => {});
      }
      const statusMsg = await channel.send({
        embeds: [buildStatusEmbed(raid)],
      });
      raid.statusMessageId = statusMsg.id;

      // Refresh member action buttons
      if (raid.memberActionMessageId) {
        const old = await channel.messages
          .fetch(raid.memberActionMessageId)
          .catch(() => null);
        if (old) await old.delete().catch(() => {});
      }
      const memberMsg = await channel.send({
        components: getMemberActionRow(),
      });
      raid.memberActionMessageId = memberMsg.id;
    }
  }, 60000);
}

module.exports = {
  activeRaids,
  createRaid,
  handleRaidModal,
  handleEditModal,
  handleQueueModal,
  handleButton,
  startRefresh,
};