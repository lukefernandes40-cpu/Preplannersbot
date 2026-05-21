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
  ChannelType,
  UserSelectMenuBuilder
} = require("discord.js");

const activeRaids = new Map();

// ===== PARTICIPATION TRACKER =====
// { userId: { count: number, misses: number } }
const raidStats = new Map();

// ===== PENDING END SESSIONS =====
// { channelId: { raid, durationMs, selectedUsers: [] } }
const pendingEnds = new Map();

// ===== REFRESH PAUSED CHANNELS =====
// Channels where the live panel refresh is suppressed (raid ending flow in progress)
const refreshPaused = new Set();

// ===== HELPER: HAS ROLE =====
function hasRole(member, roleId) {
  if (!roleId) return false;
  return member?.roles?.cache?.has(roleId);
}

// ===== EMBED: MAIN RAID ALERT =====
function buildEmbed(raid) {
  const ss1 = raid.screenshots?.ss1;
  const ss2 = raid.screenshots?.ss2;

  let ssValue = "";
  if (ss1 || ss2) {
    if (ss1) ssValue += `[📸 SS 1](${ss1})`;
    if (ss1 && ss2) ssValue += "  ·  ";
    if (ss2) ssValue += `[📸 SS 2](${ss2})`;
  } else {
    ssValue = "Send an image with `upload` to add screenshots.";
  }

  return new EmbedBuilder()
    .setTitle("⚔️ RAID ALERT")
    .setColor(0xff0000)
    .addFields(
      { name: "🌍 Region",      value: raid.data.region },
      { name: "🤝 Allies",      value: raid.data.allies  },
      { name: "⚔️ Enemies",     value: raid.data.enemies },
      { name: "🔗 Link",        value: raid.data.link    },
      { name: "📷 Screenshots", value: ssValue           }
    )
    .setTimestamp();
}

// ===== EMBED: RAID STATUS =====
function buildStatusEmbed(raid) {
  const ingame = raid.members?.ingame || [];
  const queue  = raid.members?.queue  || {};

  const ingameList = ingame.length > 0
    ? ingame.map(id => `<@${id}>`).join(", ")
    : "None";

  const queueLines = Object.entries(queue)
    .sort(([, a], [, b]) => a - b)
    .map(([uid, pos]) => `<@${uid}>: **#${pos}**`)
    .join("\n") || "None";

  return new EmbedBuilder()
    .setTitle("📊 Raid Status")
    .setColor(0xff6600)
    .addFields(
      { name: "🎮 In Game",        value: ingameList },
      { name: "🔢 Queue Position", value: queueLines }
    )
    .setTimestamp();
}

// ===== EMBED: RAID SUMMARY =====
function buildSummaryEmbed(raid, durationMs, extraRaiders = [], screenshotUrl = null) {
  const ingame     = raid.members?.ingame || [];
  const queueUsers = Object.keys(raid.members?.queue || {});
  const allHelped  = [...new Set([...ingame, ...queueUsers, ...extraRaiders])];

  const totalSec = Math.floor(durationMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hrs  = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  let durStr = "";
  if (days > 0) durStr += `${days}d `;
  if (hrs  > 0) durStr += `${hrs}h `;
  if (mins > 0) durStr += `${mins}m `;
  durStr += `${secs}s`;

  const raiderList = allHelped.length > 0
    ? allHelped.map(id => `<@${id}>`).join("\n")
    : "No raiders recorded.";

  const embed = new EmbedBuilder()
    .setTitle("🏁 Raid Completed")
    .setColor(0x00ff99)
    .setDescription("The raid has concluded. Great work!")
    .addFields(
      { name: "⏱️ Duration",    value: durStr,                   inline: true },
      { name: "👥 Raiders",     value: String(allHelped.length), inline: true },
      { name: "\u200b",         value: "\u200b",                 inline: true },
      { name: "⚔️ Raider List", value: raiderList }
    )
    .setTimestamp();

  if (screenshotUrl) embed.setImage(screenshotUrl);
  return embed;
}

// ===== BUTTONS: CONTROL =====
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
    )
  ];
}

// ===== BUTTONS: MEMBER ACTIONS =====
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
    )
  ];
}

// ===== USER SELECT: RAIDER PICKER =====
function getRaiderSelectRow() {
  return [
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId("raid_raider_select")
        .setPlaceholder("Select extra raiders to add to the summary...")
        .setMinValues(0)
        .setMaxValues(25)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("raid_confirm_end")
        .setLabel("✅ Confirm & Send Summary")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("raid_screenshot_end")
        .setLabel("📸 Raid Screenshot (optional)")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

// ===== DM ALL RAIDERS =====
async function dmAllRaiders(guild, raid, isUpdate = false) {
  const roleId = process.env.RAID_ROLE_ID;
  if (!roleId) return;

  let members;
  try {
    // Fetch only members with the raid role — avoids the opcode 8 rate limit
    // caused by fetching all guild members at once
    members = await guild.members.fetch({ withPresences: false });
    members = members.filter(m => m.roles.cache.has(roleId) && !m.user.bot);
  } catch {
    return;
  }

  if (!raid.dmMessages) raid.dmMessages = {};

  for (const [, member] of members) {
    try {
      const existing = raid.dmMessages[member.id];

      if (isUpdate && existing) {
        const dmChannel = await member.user.createDM().catch(() => null);
        if (!dmChannel) continue;
        const alertMsg  = await dmChannel.messages.fetch(existing.alertMsgId).catch(() => null);
        const statusMsg = await dmChannel.messages.fetch(existing.statusMsgId).catch(() => null);
        if (alertMsg)  await alertMsg.edit({ embeds: [buildEmbed(raid)] }).catch(() => {});
        if (statusMsg) await statusMsg.edit({ embeds: [buildStatusEmbed(raid)] }).catch(() => {});
      } else if (!isUpdate) {
        const alertMsg  = await member.user.send({ embeds: [buildEmbed(raid)] }).catch(() => null);
        const statusMsg = await member.user.send({ embeds: [buildStatusEmbed(raid)] }).catch(() => null);
        if (alertMsg && statusMsg) {
          raid.dmMessages[member.id] = {
            alertMsgId:  alertMsg.id,
            statusMsgId: statusMsg.id
          };
        }
      }
    } catch {
      // DMs closed — skip
    }
  }
}

// ===== FINALISE RAID (roles + DMs + summary channel) =====
// Called AFTER the interaction has already been responded to
async function finaliseRaid(guild, client, raid, durationMs, extraRaiders = [], screenshotUrl = null) {
  const ingame     = raid.members?.ingame || [];
  const queueUsers = Object.keys(raid.members?.queue || {});
  const allHelped  = [...new Set([...ingame, ...queueUsers, ...extraRaiders])];

  const summaryEmbed = buildSummaryEmbed(raid, durationMs, extraRaiders, screenshotUrl);

  // Fetch members — safe to do now because interaction is already responded to
  // withPresences: false avoids the GatewayRateLimitError on opcode 8
  await guild.members.fetch({ withPresences: false });

  // ===== ROLE ASSIGNMENT =====
  for (const userId of allHelped) {
    const stats  = raidStats.get(userId) || { count: 0, misses: 0 };
    stats.count += 1;
    stats.misses = 0;
    raidStats.set(userId, stats);

    const member = guild.members.cache.get(userId);
    if (!member) continue;

    // Remove No Help role
    if (process.env.NO_HELP_ROLE_ID && hasRole(member, process.env.NO_HELP_ROLE_ID)) {
      await member.roles.remove(process.env.NO_HELP_ROLE_ID).catch(() => {});
    }
    // Role Helper — after 1st participation
    if (process.env.ROLE_HELPER_ROLE_ID && stats.count === 1) {
      await member.roles.add(process.env.ROLE_HELPER_ROLE_ID).catch(() => {});
    }
    // Active Raider — after 5th participation
    if (process.env.ACTIVE_RAIDER_ROLE_ID && stats.count >= 5) {
      await member.roles.add(process.env.ACTIVE_RAIDER_ROLE_ID).catch(() => {});
    }
  }

  // No Help — 5 consecutive misses
  if (process.env.NO_HELP_ROLE_ID) {
    const raidRoleMembers = guild.members.cache.filter(
      m => m.roles.cache.has(process.env.RAID_ROLE_ID) && !m.user.bot
    );
    for (const [userId, member] of raidRoleMembers) {
      if (allHelped.includes(userId)) continue;
      const stats   = raidStats.get(userId) || { count: 0, misses: 0 };
      stats.misses += 1;
      raidStats.set(userId, stats);
      if (stats.misses >= 5) {
        await member.roles.add(process.env.NO_HELP_ROLE_ID).catch(() => {});
      }
    }
  }

  // Post to summary channel
  if (process.env.RAID_SUMMARY_CHANNEL_ID) {
    try {
      const sumCh = await client.channels.fetch(process.env.RAID_SUMMARY_CHANNEL_ID);
      if (sumCh) await sumCh.send({ embeds: [summaryEmbed] });
    } catch {}
  }

  // DM summary to all raiders
  const roleId = process.env.RAID_ROLE_ID;
  if (roleId) {
    const members = guild.members.cache.filter(m => m.roles.cache.has(roleId) && !m.user.bot);
    for (const [, member] of members) {
      await member.user.send({ embeds: [summaryEmbed] }).catch(() => {});
    }
  }
}

// ===== CREATE RAID =====
async function createRaid(interaction) {
  if (hasRole(interaction.member, process.env.RAID_BLACKLIST_ROLE_ID)) {
    return interaction.reply({ content: "🚫 You are blacklisted from using `/raid`.", flags: 64 });
  }

  const modal = new ModalBuilder()
    .setCustomId("raid_modal")
    .setTitle("⚔️ Raid Setup");

  modal.addComponents(
    ...["region", "allies", "enemies", "link"].map(f =>
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(f)
          .setLabel(f.toUpperCase())
          .setStyle(TextInputStyle.Short)
      )
    )
  );

  // showModal is the FIRST and ONLY response — no awaits before it
  return interaction.showModal(modal);
}

// ===== HANDLE RAID MODAL =====
async function handleRaidModal(interaction) {
  // Defer immediately — buys us 15 minutes for slow work
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
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
      },
      {
        id: process.env.RAID_ROLE_ID,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
      }
    ]
  });

  const data = {
    region:  interaction.fields.getTextInputValue("region"),
    allies:  interaction.fields.getTextInputValue("allies"),
    enemies: interaction.fields.getTextInputValue("enemies"),
    link:    interaction.fields.getTextInputValue("link")
  };

  const raidState = {
    owner: interaction.user.id,
    data,
    screenshots: { ss1: null, ss2: null },
    lastPing: 0,
    members: { ingame: [], queue: {} },
    startTime: Date.now(),
    messageId: null,
    statusMessageId: null,
    memberActionMessageId: null,
    dmMessages: {}
  };

  const msg = await channel.send({ embeds: [buildEmbed(raidState)], components: getControlRows() });
  raidState.messageId = msg.id;

  const statusMsg = await channel.send({ embeds: [buildStatusEmbed(raidState)] });
  raidState.statusMessageId = statusMsg.id;

  const memberMsg = await channel.send({ components: getMemberActionRow() });
  raidState.memberActionMessageId = memberMsg.id;

  activeRaids.set(channel.id, raidState);

  // editReply first so Discord sees we handled it
  await interaction.editReply({ content: `✅ Raid created: <#${channel.id}>` });

  // DMs can now take as long as they need
  dmAllRaiders(guild, raidState, false).catch(console.error);
}

// ===== HANDLE EDIT MODAL =====
async function handleEditModal(interaction) {
  // Defer immediately
  await interaction.deferReply({ flags: 64 });

  const channelId = interaction.customId.replace("edit_raid_", "");
  const raid = activeRaids.get(channelId);
  if (!raid) return interaction.editReply({ content: "❌ Raid not found" });

  raid.data.region  = interaction.fields.getTextInputValue("region");
  raid.data.allies  = interaction.fields.getTextInputValue("allies");
  raid.data.enemies = interaction.fields.getTextInputValue("enemies");
  raid.data.link    = interaction.fields.getTextInputValue("link");

  // Update channel embed
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (channel && raid.messageId) {
    const msg = await channel.messages.fetch(raid.messageId).catch(() => null);
    if (msg) await msg.edit({ embeds: [buildEmbed(raid)], components: getControlRows() });
  }

  await interaction.editReply({ content: "✅ Raid updated." });

  // Sync DMs after replying
  dmAllRaiders(interaction.guild, raid, true).catch(console.error);
}

// ===== HANDLE QUEUE MODAL =====
async function handleQueueModal(interaction) {
  const channelId = interaction.customId.replace("queue_modal_", "");
  const raid = activeRaids.get(channelId);
  if (!raid) return interaction.reply({ content: "❌ Raid not found", flags: 64 });

  const raw = interaction.fields.getTextInputValue("queue_number").trim();
  const num = parseInt(raw, 10);
  if (isNaN(num) || num < 1 || num > 50) {
    return interaction.reply({ content: "❌ Enter a number between **1** and **50**.", flags: 64 });
  }

  const userId = interaction.user.id;
  const igIdx  = raid.members.ingame.indexOf(userId);
  if (igIdx !== -1) raid.members.ingame.splice(igIdx, 1);

  if (raid.members.queue[userId] === num) {
    delete raid.members.queue[userId];
  } else {
    raid.members.queue[userId] = num;
  }

  // Acknowledge immediately
  await interaction.deferUpdate().catch(() => {});

  // Slow work after
  await updateStatusEmbed(interaction.client, channelId, raid);
  dmAllRaiders(interaction.guild, raid, true).catch(console.error);
}

// ===== UPDATE STATUS EMBED =====
async function updateStatusEmbed(client, channelId, raid) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !raid.statusMessageId) return;
  const msg = await channel.messages.fetch(raid.statusMessageId).catch(() => null);
  if (msg) await msg.edit({ embeds: [buildStatusEmbed(raid)] });
}

// ===== HANDLE SCREENSHOT MESSAGE =====
async function handleMessage(message) {
  if (message.author.bot) return;

  const channelId = message.channel.id;
  const raid = activeRaids.get(channelId);
  if (!raid) return;

  // ===== AWAITING RAID END SCREENSHOT =====
  const pending = pendingEnds.get(channelId);
  if (pending?.awaitingScreenshot) {
    const img = message.attachments.find(a => a.contentType?.startsWith("image/"));
    if (img) {
      pending.awaitingScreenshot = false;
      pending.screenshotUrl = img.url;

      await message.reply("✅ Screenshot captured! Sending raid summary now...");

      const { raid: pendingRaid, durationMs, selectedUsers, screenshotUrl } = pending;
      pendingEnds.delete(channelId);
      activeRaids.delete(channelId);
      refreshPaused.delete(channelId);

      await finaliseRaid(message.guild, message.client, pendingRaid, durationMs, selectedUsers || [], screenshotUrl);
      setTimeout(() => message.channel.delete().catch(() => {}), 4000);
      return;
    }
    // If they sent a non-image message while awaiting, ignore (let normal flow continue)
    return;
  }

  const cmd = message.content.trim().toLowerCase();

  const isUpload   = cmd === "upload";
  const isReplace1 = cmd === "replace ss 1";
  const isReplace2 = cmd === "replace ss 2";

  if (!isUpload && !isReplace1 && !isReplace2) return;

  // Look for image on this message first
  let imageUrl = null;
  const directImg = message.attachments.find(a => a.contentType?.startsWith("image/"));
  if (directImg) imageUrl = directImg.url;

  // Then check replied-to message
  if (!imageUrl && message.reference?.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      const refImg = refMsg.attachments.find(a => a.contentType?.startsWith("image/"));
      if (refImg) imageUrl = refImg.url;
    } catch {
      // ignore
    }
  }

  if (!imageUrl) {
    await message.reply(
      "❌ No image found.\n" +
      "**How to upload:**\n" +
      "• Attach an image to your message and type `upload`\n" +
      "• **OR** reply to a message that has an image and type `upload`"
    );
    return;
  }

  if (isUpload) {
    if (!raid.screenshots.ss1) {
      raid.screenshots.ss1 = imageUrl;
      await message.reply("✅ **Screenshot 1** saved!");
    } else if (!raid.screenshots.ss2) {
      raid.screenshots.ss2 = imageUrl;
      await message.reply("✅ **Screenshot 2** saved!");
    } else {
      await message.reply("⚠️ Both slots are full. Use `replace SS 1` or `replace SS 2`.");
      return;
    }
  } else if (isReplace1) {
    raid.screenshots.ss1 = imageUrl;
    await message.reply("🔄 **Screenshot 1** replaced!");
  } else if (isReplace2) {
    raid.screenshots.ss2 = imageUrl;
    await message.reply("🔄 **Screenshot 2** replaced!");
  }

  // Update embed
  const channel = await message.client.channels.fetch(channelId).catch(() => null);
  if (channel && raid.messageId) {
    const msg = await channel.messages.fetch(raid.messageId).catch(() => null);
    if (msg) await msg.edit({ embeds: [buildEmbed(raid)], components: getControlRows() });
  }

  dmAllRaiders(message.guild, raid, true).catch(console.error);
}

// ===== HANDLE BUTTONS =====
// CRITICAL RULE: every branch must call interaction.reply / deferReply / showModal / deferUpdate
// as the VERY FIRST await. No async work before responding.
async function handleButton(interaction, client) {
  const customId = interaction.customId;

  // ── Raider select menu value stored ──
  if (customId === "raid_raider_select") {
    // This is handled by handleSelectMenu, not here
    return false;
  }

  // ── Screenshot upload step ──
  if (customId === "raid_screenshot_end") {
    const pending = pendingEnds.get(interaction.channel.id);
    if (!pending) {
      return interaction.reply({ content: "❌ No pending raid end.", flags: 64 });
    }

    pending.awaitingScreenshot = true;

    await interaction.reply({
      content:
        "📸 **Upload your raid screenshot now.**\n" +
        "Send an image in this channel and it will be attached to the summary embed.\n" +
        "Once uploaded, the summary will be sent automatically.\n\n" +
        "*(You can also click **✅ Confirm & Send Summary** at any time to send without a screenshot.)*",
      flags: 64
    });
    return true;
  }

  // ── Confirm end ──
  if (customId === "raid_confirm_end") {
    const pending = pendingEnds.get(interaction.channel.id);
    if (!pending) {
      return interaction.reply({ content: "❌ No pending raid end.", flags: 64 });
    }

    // Respond FIRST
    await interaction.update({ content: "⏳ Sending summary...", embeds: [], components: [] });

    const { raid, durationMs, screenshotUrl } = pending;
    const extraRaiders = pending.selectedUsers || [];
    pendingEnds.delete(interaction.channel.id);
    activeRaids.delete(interaction.channel.id);
    refreshPaused.delete(interaction.channel.id);

    // Slow work after interaction is already handled
    await finaliseRaid(interaction.guild, client, raid, durationMs, extraRaiders, screenshotUrl);
    setTimeout(() => interaction.channel.delete().catch(() => {}), 4000);
    return true;
  }

  // ── Skip end (kept for backward compat, no longer shown in UI) ──
  if (customId === "raid_skip_end") {
    const pending = pendingEnds.get(interaction.channel.id);
    if (!pending) {
      return interaction.reply({ content: "❌ No pending raid end.", flags: 64 });
    }

    // Respond FIRST
    await interaction.update({ content: "⏳ Sending summary...", embeds: [], components: [] });

    const { raid, durationMs } = pending;
    pendingEnds.delete(interaction.channel.id);
    activeRaids.delete(interaction.channel.id);
    refreshPaused.delete(interaction.channel.id);

    await finaliseRaid(interaction.guild, client, raid, durationMs, [], null);
    setTimeout(() => interaction.channel.delete().catch(() => {}), 4000);
    return true;
  }

  // All remaining buttons require an active raid in this channel
  const raid = activeRaids.get(interaction.channel?.id);
  if (!raid) return false;

  // ===== RAID PING =====
  if (customId === "raid_ping") {
    const now      = Date.now();
    const cooldown = 5 * 60 * 1000;

    if (now - raid.lastPing < cooldown) {
      const rem = cooldown - (now - raid.lastPing);
      const m   = Math.floor(rem / 60000);
      const s   = Math.ceil((rem % 60000) / 1000);
      // Reply first, nothing slow before it
      return interaction.reply({ content: `⏳ Wait ${m}m ${s}s before pinging again.`, flags: 64 });
    }

    raid.lastPing = now;
    // Defer first
    await interaction.deferReply({ flags: 64 });
    // Slow work after
    await interaction.channel.send({
      content: `🚨 RAID ALERT <@&${process.env.RAID_ROLE_ID}>`,
      allowedMentions: { roles: [process.env.RAID_ROLE_ID] }
    });
    await interaction.editReply({ content: "✅ Raid Ping Sent" });
    return true;
  }

  // ===== END RAID =====
  if (customId === "end_raid") {
    const isOwner   = interaction.user.id === raid.owner;
    const isHandler = hasRole(interaction.member, process.env.RAID_HANDLER_ROLE_ID);

    if (!isOwner && !isHandler) {
      // Reply first — no async before this
      return interaction.reply({
        content: "❌ Only the raid owner or a Raid Handler can end this raid.",
        flags: 64
      });
    }

    const durationMs = Date.now() - raid.startTime;
    pendingEnds.set(interaction.channel.id, { raid, durationMs, selectedUsers: [], screenshotUrl: null, awaitingScreenshot: false });

    // Pause the live refresh for this channel so it doesn't bury the end flow
    refreshPaused.add(interaction.channel.id);

    // Reply FIRST — no async work before this
    await interaction.reply({
      content:
        "## 🏁 Raid Ending\n" +
        "Select any **additional raiders** to add to the summary, then click Confirm.\n" +
        "You can also optionally attach a **Raid Screenshot** before confirming.",
      components: getRaiderSelectRow(),
      flags: 64
    });

    // Freeze the channel panel in place: remove buttons so nobody can click during end flow
    try {
      const channel = interaction.channel;
      if (raid.messageId) {
        const panelMsg = await channel.messages.fetch(raid.messageId).catch(() => null);
        if (panelMsg) await panelMsg.edit({ components: [] }).catch(() => {});
      }
      if (raid.memberActionMessageId) {
        const memberMsg = await channel.messages.fetch(raid.memberActionMessageId).catch(() => null);
        if (memberMsg) await memberMsg.edit({ components: [] }).catch(() => {});
      }
    } catch {}

    return true;
  }

  // ===== EDIT RAID =====
  if (customId === "edit_raid") {
    const d     = raid.data;
    const modal = new ModalBuilder()
      .setCustomId(`edit_raid_${interaction.channel.id}`)
      .setTitle("Edit Raid");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("region").setLabel("Region").setStyle(TextInputStyle.Short).setValue(d.region)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("allies").setLabel("Allies").setStyle(TextInputStyle.Short).setValue(d.allies)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("enemies").setLabel("Enemies").setStyle(TextInputStyle.Short).setValue(d.enemies)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("link").setLabel("Link").setStyle(TextInputStyle.Short).setValue(d.link)
      )
    );

    // showModal MUST be the first and only response — no awaits before it
    await interaction.showModal(modal);
    return true;
  }

  // ===== IN GAME TOGGLE =====
  if (customId === "member_ingame") {
    const userId = interaction.user.id;
    const ingame = raid.members.ingame;
    const idx    = ingame.indexOf(userId);

    if (raid.members.queue[userId] !== undefined) delete raid.members.queue[userId];

    const nowIn = idx === -1;
    if (nowIn) ingame.push(userId);
    else ingame.splice(idx, 1);

    // Reply FIRST
    await interaction.reply({
      content: nowIn ? "✅ You're marked **In Game**" : "❎ You're no longer **In Game**",
      flags: 64
    });

    // Slow work after
    await updateStatusEmbed(client, interaction.channel.id, raid);
    dmAllRaiders(interaction.guild, raid, true).catch(console.error);
    return true;
  }

  // ===== QUEUE POSITION =====
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

    // showModal MUST be first — no awaits before it
    await interaction.showModal(modal);
    return true;
  }

  return false;
}

// ===== HANDLE SELECT MENU =====
async function handleSelectMenu(interaction) {
  if (interaction.customId !== "raid_raider_select") return false;

  const pending = pendingEnds.get(interaction.channel.id);
  if (!pending) {
    await interaction.reply({ content: "❌ No pending raid end found.", flags: 64 });
    return true;
  }

  pending.selectedUsers = interaction.values || [];

  // Respond immediately
  await interaction.reply({
    content: `✅ **${pending.selectedUsers.length}** extra raider(s) selected. Click **Confirm & Send Summary** when ready.`,
    flags: 64
  });
  return true;
}

// ===== LIVE PANEL REFRESH (60s) =====
function startRefresh(client) {
  setInterval(async () => {
    for (const [channelId, raid] of activeRaids.entries()) {
      // Skip channels mid-end-flow — the panel is intentionally frozen
      if (refreshPaused.has(channelId)) continue;

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;

      if (raid.messageId) {
        const old = await channel.messages.fetch(raid.messageId).catch(() => null);
        if (old) await old.delete().catch(() => {});
      }
      const msg = await channel.send({ embeds: [buildEmbed(raid)], components: getControlRows() });
      raid.messageId = msg.id;

      if (raid.statusMessageId) {
        const old = await channel.messages.fetch(raid.statusMessageId).catch(() => null);
        if (old) await old.delete().catch(() => {});
      }
      const statusMsg = await channel.send({ embeds: [buildStatusEmbed(raid)] });
      raid.statusMessageId = statusMsg.id;

      if (raid.memberActionMessageId) {
        const old = await channel.messages.fetch(raid.memberActionMessageId).catch(() => null);
        if (old) await old.delete().catch(() => {});
      }
      const memberMsg = await channel.send({ components: getMemberActionRow() });
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
  handleSelectMenu,
  handleMessage,
  startRefresh
};