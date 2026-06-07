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
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  AttachmentBuilder
} = require("discord.js");

const fetch = require("node-fetch");
const fs    = require("fs");

// ===== STATE =====
const activeRaids   = new Map();  // channelId -> raidState
const raidStats     = new Map();  // userId -> { count, misses }
const pendingEnds   = new Map();  // channelId -> pendingEnd
const refreshPaused = new Set();  // channelIds where refresh is paused

// ===== HELPERS =====
function hasRole(member, roleId) {
  if (!roleId) return false;
  return member?.roles?.cache?.has(roleId);
}

async function safeFetchMember(guild, userId) {
  const cached = guild.members.cache.get(userId);
  if (cached) return cached;
  try { return await guild.members.fetch({ user: userId, force: false }); }
  catch { return null; }
}

async function fetchRoleMembers(guild, roleId) {
  if (!roleId) return new Map();
  try { await guild.members.fetch(); } catch {}
  return guild.members.cache.filter(m => m.roles.cache.has(roleId) && !m.user.bot);
}

// Find raid by channel id or by owner/user id (for DM interactions)
function findRaidForInteraction(interaction) {
  if (interaction.channel?.id) {
    const r = activeRaids.get(interaction.channel.id);
    if (r) return r;
  }
  for (const [, r] of activeRaids) {
    if (r.owner === interaction.user.id) return r;
    if (r.dmMessages && r.dmMessages[interaction.user.id]) return r;
  }
  return null;
}

function findRaidChannelId(raid) {
  for (const [channelId, r] of activeRaids) {
    if (r === raid) return channelId;
  }
  return null;
}

// ===== COLOURS =====
const COLOURS = {
  alert:   0xff2244,
  status:  0xff8c00,
  summary: 0x00e676,
  info:    0x5865f2,
  swap:    0x9c27b0,
  note:    0xffd700
};

// ===== DIFFICULTY PRESETS =====
const DIFFICULTY_PRESETS = [
  "EZ Clap", "Mid", "Locked In", "Cooked", "Beyond Saving",
  "Absolutely Fried", "Getting Real", "Its Aight", "Developer Difficulty",
  "Nah Bro", "Pack It Up", "Start Praying", "Call The Ancestors",
  "Streamer Lobby", "A Few Mfs", "Fries ✌"
];

// ===== EMBEDS =====
function buildEmbed(raid) {
  const diff = raid.data.difficulty ? `\`\`\`${raid.data.difficulty}\`\`\`` : "`Not Set`";

  return new EmbedBuilder()
    .setTitle("⚔️  RAID ALERT")
    .setColor(COLOURS.alert)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "A raid has been called! Get in position and coordinate with your team.\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    )
    .addFields(
      { name: "🌍  Region",     value: `\`\`\`${raid.data.region}\`\`\``,    inline: true  },
      { name: "🤝  Allies",     value: `\`\`\`${raid.data.allies}\`\`\``,    inline: true  },
      { name: "⚔️  Enemies",    value: `\`\`\`${raid.data.enemies}\`\`\``,   inline: false },
      { name: "💀  Difficulty", value: diff,                                  inline: true  }
    )
    .setFooter({ text: "React fast • Stay focused • Win the raid" })
    .setTimestamp();
}

function buildStatusEmbed(raid) {
  const ingame     = raid.members?.ingame      || [];
  const inposition = raid.members?.inposition  || [];

  const ingameList = ingame.length > 0
    ? ingame.map(id => `> <@${id}>`).join("\n")
    : "> *Nobody in game yet*";

  const inposList = inposition.length > 0
    ? inposition.map(entry => `> \`#${entry.slot}\` <@${entry.userId}>`).join("\n")
    : "> *Queue is empty*";

  return new EmbedBuilder()
    .setTitle("📊  Live Raid Status")
    .setColor(COLOURS.status)
    .setDescription("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    .addFields(
      { name: "🎮  In Game",     value: ingameList, inline: false },
      { name: "📍  In Position", value: inposList,  inline: false }
    )
    .setFooter({ text: "Updates in real-time" })
    .setTimestamp();
}

// ===== FIXED SUMMARY EMBED — players placed in correct category =====
function buildSummaryEmbed(raid, durationMs, extraRaiders = []) {
  // Use the state as it was when raid ended — ingame and inposition are separate
  const ingame     = raid.members?.ingame      || [];
  const inposition = raid.members?.inposition  || [];  // array of { userId, slot }

  // Extra raiders added manually at end go into raider list only if not already tracked
  const trackedIds = new Set([...ingame, ...inposition.map(e => e.userId)]);
  const onlyExtra  = extraRaiders.filter(id => !trackedIds.has(id));

  const totalSec = Math.floor(durationMs / 1000);
  const hrs  = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  let durStr = "";
  if (hrs  > 0) durStr += `${hrs}h `;
  if (mins > 0) durStr += `${mins}m `;
  durStr += `${secs}s`;

  const allHelped = [...ingame, ...inposition.map(e => e.userId), ...onlyExtra];
  const uniqueAll = [...new Set(allHelped)];

  // Raider list = ingame + extra (not inposition-only)
  const raiderIds = [...new Set([...ingame, ...onlyExtra])];
  const raiderList = raiderIds.length > 0
    ? raiderIds.map(id => `> <@${id}>`).join("\n")
    : "> No raiders recorded.";

  // In Position list = only those who were in inposition (not ingame)
  const inposOnly = inposition.filter(e => !ingame.includes(e.userId));
  const inposList = inposOnly.length > 0
    ? inposOnly.map(e => `> \`#${e.slot}\` <@${e.userId}>`).join("\n")
    : "> None";

  const diff = raid.data?.difficulty ? `\`${raid.data.difficulty}\`` : "`N/A`";

  return new EmbedBuilder()
    .setTitle("🏁  Raid Completed — GG!")
    .setColor(COLOURS.summary)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "The raid has concluded. Thank you to everyone who participated!\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    )
    .addFields(
      { name: "⏱️  Duration",     value: `\`${durStr}\``,             inline: true  },
      { name: "👥  Total Raiders", value: `\`${uniqueAll.length}\``,  inline: true  },
      { name: "💀  Difficulty",    value: diff,                        inline: true  },
      { name: "🌍  Region",        value: `\`${raid.data?.region || "N/A"}\``, inline: true },
      { name: "\u200b",            value: "\u200b",                    inline: true  },
      { name: "\u200b",            value: "\u200b",                    inline: true  },
      { name: "⚔️  Raider List",   value: raiderList,                  inline: false },
      { name: "📍  In Position",   value: inposList,                   inline: false }
    )
    .setFooter({ text: "Well done to everyone who participated!" })
    .setTimestamp();
}

// ===== BUILD SUMMARY PAYLOAD =====
async function buildSummaryPayload(raid, durationMs, extraRaiders = [], screenshotUrl = null) {
  const embed = buildSummaryEmbed(raid, durationMs, extraRaiders);

  if (!screenshotUrl) return { embeds: [embed], files: [] };

  try {
    const res = await fetch(screenshotUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.buffer();
    const attachment = new AttachmentBuilder(buffer, { name: "raid-screenshot.png" });
    embed.setImage("attachment://raid-screenshot.png");
    return { embeds: [embed], files: [attachment] };
  } catch (e) {
    console.log("⚠️ Could not fetch screenshot bytes:", e.message);
    embed.setImage(screenshotUrl);
    return { embeds: [embed], files: [] };
  }
}

// ===== BUTTON ROWS =====
function getControlRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("raid_ping")
        .setLabel("🔔 Raid Ping")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("want_swap_account")
        .setLabel("🔄 Want to Swap Acc?")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("raid_note")
        .setLabel("📝 Note")
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("edit_raid")
        .setLabel("✏️ Edit")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("end_raid")
        .setLabel("❌ End Raid")
        .setStyle(ButtonStyle.Danger)
    )
  ];
}

// ===== SINGLE DM ACTION ROW — all buttons in one message =====
function getDMActionRow(link) {
  const joinUrl = link && link.startsWith("http") ? link : "https://www.roblox.com";
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("🚀 Join Raid")
        .setStyle(ButtonStyle.Link)
        .setURL(joinUrl),
      new ButtonBuilder()
        .setCustomId("member_ingame")
        .setLabel("🎮 I'm In Game")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("member_inposition")
        .setLabel("📍 In Position")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("want_swap_account")
        .setLabel("🔄 Want to Swap Acc?")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function getMemberActionRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("member_ingame")
        .setLabel("🎮 I'm In Game")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("member_inposition")
        .setLabel("📍 In Position")
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

function getSwapActionRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("want_swap_account")
        .setLabel("🔄 Want to Swap Acc?")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function getRaiderSelectRow() {
  return [
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId("raid_raider_select")
        .setPlaceholder("🔍 Search and select extra raiders...")
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
        .setLabel("📸 Add Raid Screenshot (optional)")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function getNoteTargetRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("note_send_ingame")
        .setLabel("🎮 Send to In Game")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("note_send_inposition")
        .setLabel("📍 Send to In Position")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("note_send_both")
        .setLabel("📨 Send to Both")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function buildJoinRow(link) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("🚀 Join Raid")
        .setStyle(ButtonStyle.Link)
        .setURL(link && link.startsWith("http") ? link : "https://www.roblox.com")
    )
  ];
}

// ===== DIFFICULTY SELECT ROW =====
function getDifficultySelectRow() {
  const options = DIFFICULTY_PRESETS.map(p => ({ label: p, value: p }));
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("difficulty_preset_select")
        .setPlaceholder("Select your difficulty in the following raid")
        .addOptions(options)
    )
  ];
}

// ===== ROLE HELPERS =====
async function assignMemberRole(guild, userId, roleId) {
  if (!roleId) return;
  const member = await safeFetchMember(guild, userId);
  if (member) await member.roles.add(roleId).catch(() => {});
}

async function removeMemberRole(guild, userId, roleId) {
  if (!roleId) return;
  const member = await safeFetchMember(guild, userId);
  if (member) await member.roles.remove(roleId).catch(() => {});
}

async function stripRaidRoles(guild, raid) {
  const inGameRoleId     = process.env.IN_GAME_ROLE_ID;
  const inPositionRoleId = process.env.IN_POSITION_ROLE_ID;
  for (const userId of (raid.members?.ingame || [])) {
    await removeMemberRole(guild, userId, inGameRoleId);
  }
  for (const entry of (raid.members?.inposition || [])) {
    await removeMemberRole(guild, entry.userId, inPositionRoleId);
  }
}

// ===== DM ALL RAIDERS — single combined message =====
async function dmAllRaiders(guild, raid, isUpdate = false) {
  const roleId = process.env.RAID_ROLE_ID;
  if (!roleId) return;

  const members = await fetchRoleMembers(guild, roleId);
  if (!raid.dmMessages) raid.dmMessages = {};

  for (const [, member] of members) {
    try {
      if (isUpdate) {
        const existing = raid.dmMessages[member.id];
        if (!existing) continue;
        const dmChannel = await member.user.createDM().catch(() => null);
        if (!dmChannel) continue;

        if (existing.alertMsgId) {
          const alertMsg = await dmChannel.messages.fetch(existing.alertMsgId).catch(() => null);
          if (alertMsg) await alertMsg.edit({ embeds: [buildEmbed(raid)] }).catch(() => {});
        }
        if (existing.statusMsgId) {
          const statusMsg = await dmChannel.messages.fetch(existing.statusMsgId).catch(() => null);
          if (statusMsg) await statusMsg.edit({ embeds: [buildStatusEmbed(raid)] }).catch(() => {});
        }
      } else {
        // Fresh DM — alert embed
        const alertMsg  = await member.user.send({ embeds: [buildEmbed(raid)] }).catch(() => null);
        // Status embed
        const statusMsg = await member.user.send({ embeds: [buildStatusEmbed(raid)] }).catch(() => null);

        // All action buttons in ONE message: Join Raid | I'm In Game | In Position | Want to Swap Acc?
        const actionMsg = await member.user.send({
          content: "**Use the buttons below to manage your raid status:**",
          components: getDMActionRow(raid.data.link)
        }).catch(() => null);

        if (alertMsg && statusMsg) {
          raid.dmMessages[member.id] = {
            alertMsgId:  alertMsg.id,
            statusMsgId: statusMsg.id,
            actionMsgId: actionMsg?.id || null
          };
        }
      }
    } catch { /* DMs closed */ }
  }
}

// ===== FINALISE RAID =====
async function finaliseRaid(guild, client, raid, durationMs, extraRaiders = [], screenshotUrl = null) {
  const ingame    = raid.members?.ingame      || [];
  const inpos     = (raid.members?.inposition || []).map(e => e.userId);
  const allHelped = [...new Set([...ingame, ...inpos, ...extraRaiders])];

  const summaryPayload = await buildSummaryPayload(raid, durationMs, extraRaiders, screenshotUrl);

  // ── Role awards ──
  for (const userId of allHelped) {
    const stats  = raidStats.get(userId) || { count: 0, misses: 0 };
    stats.count += 1;
    stats.misses = 0;
    raidStats.set(userId, stats);

    const member = await safeFetchMember(guild, userId);
    if (!member) continue;

    if (process.env.NO_HELP_ROLE_ID && hasRole(member, process.env.NO_HELP_ROLE_ID)) {
      await member.roles.remove(process.env.NO_HELP_ROLE_ID).catch(() => {});
    }
    if (process.env.ROLE_HELPER_ROLE_ID && stats.count === 1) {
      await member.roles.add(process.env.ROLE_HELPER_ROLE_ID).catch(() => {});
    }
    if (process.env.ACTIVE_RAIDER_ROLE_ID && stats.count >= 5) {
      await member.roles.add(process.env.ACTIVE_RAIDER_ROLE_ID).catch(() => {});
    }
  }

  // ── No Help (5 consecutive misses) ──
  if (process.env.NO_HELP_ROLE_ID && process.env.RAID_ROLE_ID) {
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

  // ── Strip In Game / In Position roles ──
  await stripRaidRoles(guild, raid);

  // ── Post to summary channel ──
  if (process.env.RAID_SUMMARY_CHANNEL_ID) {
    try {
      const sumCh = await client.channels.fetch(process.env.RAID_SUMMARY_CHANNEL_ID);
      if (sumCh) await sumCh.send(summaryPayload);
    } catch (e) {
      console.log("Error posting to summary channel:", e.message);
    }
  }

  // ── DM summary to all raid-role members ──
  if (process.env.RAID_ROLE_ID) {
    const members = guild.members.cache.filter(
      m => m.roles.cache.has(process.env.RAID_ROLE_ID) && !m.user.bot
    );
    for (const [, member] of members) {
      await member.user.send(summaryPayload).catch(() => {});
    }
  }
}

// ===== UPDATE STATUS EMBED =====
async function updateStatusEmbed(client, channelId, raid) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !raid.statusMessageId) return;
  const msg = await channel.messages.fetch(raid.statusMessageId).catch(() => null);
  if (msg) await msg.edit({ embeds: [buildStatusEmbed(raid)] }).catch(() => {});
}

// ===== CREATE RAID =====
async function createRaid(interaction) {
  if (hasRole(interaction.member, process.env.RAID_BLACKLIST_ROLE_ID)) {
    return interaction.reply({ content: "🚫 You are blacklisted from using `/raid`.", flags: 64 });
  }

  await interaction.reply({
    content:
      "## ⚔️ Raid Setup — Step 1\nPick a **difficulty preset** from the dropdown, or click on continue to skip.",
    components: [
      ...getDifficultySelectRow(),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("raid_open_modal")
          .setLabel("▶️ Continue to Raid Form")
          .setStyle(ButtonStyle.Primary)
      )
    ],
    flags: 64
  });
}

// ===== HANDLE SELECT MENU =====
async function handleSelectMenu(interaction) {
  if (interaction.customId === "difficulty_preset_select") {
    const chosen = interaction.values[0];
    if (!interaction.client._pendingDifficulty) interaction.client._pendingDifficulty = new Map();
    interaction.client._pendingDifficulty.set(interaction.user.id, chosen);

    await interaction.update({
      content:
        `## ⚔️ Raid Setup — Step 1\n✅ Difficulty set to **${chosen}**.\nNow click **▶️ Continue to Raid Form** to fill in the rest.`,
      components: [
        ...getDifficultySelectRow(),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("raid_open_modal")
            .setLabel("▶️ Continue to Raid Form")
            .setStyle(ButtonStyle.Primary)
        )
      ]
    });
    return true;
  }

  if (interaction.customId === "raid_raider_select") {
    const pending = pendingEnds.get(interaction.channel?.id);
    if (!pending) {
      await interaction.reply({ content: "❌ No pending raid end found.", flags: 64 });
      return true;
    }

    pending.selectedUsers = interaction.values || [];

    await interaction.reply({
      content: `✅ **${pending.selectedUsers.length}** extra raider(s) selected. Click **Confirm & Send Summary** when ready.`,
      flags: 64
    });
    return true;
  }

  return false;
}

// ===== HANDLE RAID MODAL =====
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
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
      },
      ...(process.env.RAID_ROLE_ID ? [{
        id: process.env.RAID_ROLE_ID,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
      }] : [])
    ]
  });

  const pendingDiff = interaction.client._pendingDifficulty?.get(interaction.user.id) || null;
  if (interaction.client._pendingDifficulty) interaction.client._pendingDifficulty.delete(interaction.user.id);

  const typedDiff = interaction.fields.getTextInputValue("difficulty") || null;
  const finalDiff = typedDiff || pendingDiff || null;

  const data = {
    region:     interaction.fields.getTextInputValue("region"),
    allies:     interaction.fields.getTextInputValue("allies"),
    enemies:    interaction.fields.getTextInputValue("enemies"),
    link:       interaction.fields.getTextInputValue("link"),
    difficulty: finalDiff
  };

  const raidState = {
    owner:                 interaction.user.id,
    data,
    lastPing:              0,
    members:               { ingame: [], inposition: [] },
    startTime:             Date.now(),
    messageId:             null,
    statusMessageId:       null,
    memberActionMessageId: null,
    dmMessages:            {},
    pendingNote:           null
  };

  const msg       = await channel.send({ embeds: [buildEmbed(raidState)], components: getControlRows() });
  raidState.messageId = msg.id;

  const statusMsg = await channel.send({ embeds: [buildStatusEmbed(raidState)] });
  raidState.statusMessageId = statusMsg.id;

  const joinRow   = buildJoinRow(data.link);
  const memberMsg = await channel.send({ components: [...joinRow, ...getMemberActionRow()] });
  raidState.memberActionMessageId = memberMsg.id;

  activeRaids.set(channel.id, raidState);

  await interaction.editReply({ content: `✅ Raid created: <#${channel.id}>` });

  dmAllRaiders(guild, raidState, false).catch(console.error);
}

// ===== HANDLE EDIT MODAL =====
async function handleEditModal(interaction) {
  await interaction.deferReply({ flags: 64 });

  const channelId = interaction.customId.replace("edit_raid_", "");
  const raid = activeRaids.get(channelId);
  if (!raid) return interaction.editReply({ content: "❌ Raid not found" });

  raid.data.region     = interaction.fields.getTextInputValue("region");
  raid.data.allies     = interaction.fields.getTextInputValue("allies");
  raid.data.enemies    = interaction.fields.getTextInputValue("enemies");
  raid.data.link       = interaction.fields.getTextInputValue("link");
  raid.data.difficulty = interaction.fields.getTextInputValue("difficulty") || raid.data.difficulty;

  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (channel && raid.messageId) {
    const msg = await channel.messages.fetch(raid.messageId).catch(() => null);
    if (msg) await msg.edit({ embeds: [buildEmbed(raid)], components: getControlRows() });
  }

  await interaction.editReply({ content: "✅ Raid updated." });
  dmAllRaiders(interaction.guild, raid, true).catch(console.error);
}

// ===== HANDLE NOTE MODAL =====
async function handleNoteModal(interaction) {
  const channelId = interaction.customId.replace("note_modal_", "");
  const raid = activeRaids.get(channelId);
  if (!raid) return interaction.reply({ content: "❌ Raid not found.", flags: 64 });

  if (!hasRole(interaction.member, process.env.RAID_LEADER_ROLE_ID)) {
    return interaction.reply({ content: "❌ Only Raid Leaders can send notes.", flags: 64 });
  }

  const noteText = interaction.fields.getTextInputValue("note_text");
  raid.pendingNote = { text: noteText, authorId: interaction.user.id };

  return interaction.reply({
    content: "📝 **Note ready!** Choose who to send this note to:",
    embeds: [
      new EmbedBuilder()
        .setColor(COLOURS.note)
        .setTitle("📝 Note Preview")
        .setDescription(noteText)
        .setFooter({ text: "Select your audience below" })
    ],
    components: getNoteTargetRow(),
    flags: 64
  });
}

// ===== HANDLE IN POSITION MODAL =====
async function handleInPositionModal(interaction) {
  if (!interaction.customId.startsWith("inposition_modal_")) return false;

  const raidChannelId = interaction.customId.replace("inposition_modal_", "");
  let raid = activeRaids.get(raidChannelId);
  if (!raid) return interaction.reply({ content: "❌ Raid not found.", flags: 64 });

  const slotStr = interaction.fields.getTextInputValue("position_slot").trim();
  const slot    = parseInt(slotStr, 10);

  if (isNaN(slot) || slot < 1 || slot > 99) {
    return interaction.reply({ content: "❌ Please enter a valid slot number (1–99).", flags: 64 });
  }

  const userId  = interaction.user.id;
  const ingame  = raid.members.ingame;
  const inpos   = raid.members.inposition;

  // Remove from in-game if they were there
  const igIdx = ingame.indexOf(userId);
  if (igIdx !== -1) {
    ingame.splice(igIdx, 1);
    await removeMemberRole(interaction.guild || await interaction.client.guilds.fetch(process.env.GUILD_ID).catch(() => null), userId, process.env.IN_GAME_ROLE_ID);
  }

  const existingIdx = inpos.findIndex(e => e.userId === userId);
  if (existingIdx !== -1) {
    inpos[existingIdx].slot = slot;
    await interaction.reply({ content: `✅ Updated your position to **#${slot}**!`, flags: 64 });
  } else {
    inpos.push({ userId, slot });
    const guild = interaction.guild || await interaction.client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
    if (guild) await assignMemberRole(guild, userId, process.env.IN_POSITION_ROLE_ID);
    await interaction.reply({ content: `✅ You're marked **In Position #${slot}**!`, flags: 64 });
  }

  inpos.sort((a, b) => a.slot - b.slot);

  const raidChannel = await interaction.client.channels.fetch(raidChannelId).catch(() => null);
  if (raidChannel && raid.statusMessageId) {
    const statusMsg = await raidChannel.messages.fetch(raid.statusMessageId).catch(() => null);
    if (statusMsg) await statusMsg.edit({ embeds: [buildStatusEmbed(raid)] }).catch(() => {});
  }

  const guild = interaction.guild || await interaction.client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  if (guild) dmAllRaiders(guild, raid, true).catch(console.error);

  return true;
}

// ===== HANDLE MESSAGE (screenshot detection) =====
async function handleMessage(message) {
  if (message.author.bot) return;
  if (!message.guild)     return;

  const channelId = message.channel.id;
  const pending   = pendingEnds.get(channelId);
  if (!pending?.awaitingScreenshot) return;

  const raid = activeRaids.get(channelId);
  if (!raid) return;

  const isOwner   = message.author.id === raid.owner;
  const isHandler = message.member && hasRole(message.member, process.env.RAID_HANDLER_ROLE_ID);
  if (!isOwner && !isHandler) return;

  let img = message.attachments.find(a => a.contentType?.startsWith("image/")) || null;

  if (!img && message.reference?.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      img = refMsg.attachments.find(a => a.contentType?.startsWith("image/")) || null;
    } catch {}
  }

  if (img) {
    pending.awaitingScreenshot = false;
    pending.screenshotUrl      = img.url;

    await message.reply("✅ Screenshot captured! Sending raid summary now...");

    const { raid: pendingRaid, durationMs, selectedUsers, screenshotUrl } = pending;
    pendingEnds.delete(channelId);
    activeRaids.delete(channelId);
    refreshPaused.delete(channelId);

    await finaliseRaid(message.guild, message.client, pendingRaid, durationMs, selectedUsers || [], screenshotUrl);
    setTimeout(() => message.channel.delete().catch(() => {}), 4000);
    return;
  }

  if (message.content.trim()) {
    await message.reply(
      "📸 Still waiting for your **raid screenshot**.\n" +
      "Attach an image to your message and send it, or click **✅ Confirm & Send Summary** to skip."
    ).catch(() => {});
  }
}

// ===== HANDLE BUTTONS =====
async function handleButton(interaction, client) {
  const customId = interaction.customId;

  // ── Open raid modal ──
  if (customId === "raid_open_modal") {
    const pendingDiff = interaction.client._pendingDifficulty?.get(interaction.user.id) || "";

    const modal = new ModalBuilder()
      .setCustomId("raid_modal")
      .setTitle("⚔️ Raid Setup");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("region")
          .setLabel("REGION")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("allies")
          .setLabel("ALLIES")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("enemies")
          .setLabel("ENEMIES")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("link")
          .setLabel("SERVER LINK")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("difficulty")
          .setLabel("DIFFICULTY (personalize if needed)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(pendingDiff)
          .setPlaceholder("Or type: EZ Clap / Mid / Cooked / Start Praying...")
      )
    );

    await interaction.showModal(modal);
    return true;
  }

  if (customId === "raid_raider_select") return false;

  // ── Screenshot step ──
  if (customId === "raid_screenshot_end") {
    const pending = pendingEnds.get(interaction.channel?.id);
    if (!pending) return interaction.reply({ content: "❌ No pending raid end.", flags: 64 });

    pending.awaitingScreenshot = true;

    await interaction.reply({
      content:
        "📸 **Upload your raid screenshot now.**\n" +
        "Attach an image to a message in **this channel** and send it.\n" +
        "Only the **raid owner** or a **Raid Handler** can submit it.\n\n" +
        "*(Click **✅ Confirm & Send Summary** at any time to skip the screenshot.)*",
      flags: 64
    });
    return true;
  }

  // ── Confirm end ──
  if (customId === "raid_confirm_end") {
    const pending = pendingEnds.get(interaction.channel?.id);
    if (!pending) return interaction.reply({ content: "❌ No pending raid end.", flags: 64 });

    await interaction.deferUpdate();

    const { raid, durationMs, screenshotUrl } = pending;
    const extraRaiders = pending.selectedUsers || [];
    pendingEnds.delete(interaction.channel.id);
    activeRaids.delete(interaction.channel.id);
    refreshPaused.delete(interaction.channel.id);

    await finaliseRaid(interaction.guild, client, raid, durationMs, extraRaiders, screenshotUrl);
    setTimeout(() => interaction.channel.delete().catch(() => {}), 4000);
    return true;
  }

  // ── Note send buttons ──
  if (["note_send_ingame", "note_send_inposition", "note_send_both"].includes(customId)) {
    await interaction.deferUpdate();

    let raid = interaction.channel ? activeRaids.get(interaction.channel.id) : null;

    if (!raid) {
      for (const [, r] of activeRaids) {
        if (r.pendingNote && r.pendingNote.authorId === interaction.user.id) {
          raid = r;
          break;
        }
      }
    }

    if (!raid) {
      await interaction.editReply({ content: "❌ No active raid found.", embeds: [], components: [] });
      return true;
    }

    if (!hasRole(interaction.member, process.env.RAID_LEADER_ROLE_ID)) {
      await interaction.editReply({ content: "❌ Only Raid Leaders can send notes.", embeds: [], components: [] });
      return true;
    }

    if (!raid.pendingNote) {
      await interaction.editReply({ content: "❌ No note ready. Click the 📝 Note button first.", embeds: [], components: [] });
      return true;
    }

    const { text } = raid.pendingNote;
    raid.pendingNote = null;

    const noteEmbed = new EmbedBuilder()
      .setColor(COLOURS.note)
      .setTitle("📝 Note from Raid Leader")
      .setDescription(text)
      .setFooter({ text: "Sent by Raid Leader" })
      .setTimestamp();

    let targets = [];
    if (customId === "note_send_ingame")     targets = [...(raid.members?.ingame || [])];
    if (customId === "note_send_inposition") targets = [...(raid.members?.inposition || []).map(e => e.userId)];
    if (customId === "note_send_both")       targets = [...new Set([...(raid.members?.ingame || []), ...(raid.members?.inposition || []).map(e => e.userId)])];

    let sent = 0;
    for (const userId of targets) {
      const member = await safeFetchMember(interaction.guild, userId);
      if (!member) continue;
      const ok = await member.user.send({ embeds: [noteEmbed] }).catch(() => null);
      if (ok) sent++;
    }

    await interaction.editReply({
      content: `✅ Note sent to **${sent}** member(s).`,
      embeds: [],
      components: []
    });
    return true;
  }

  // ── Want to Swap Acc ──
  if (customId === "want_swap_account") {
    await interaction.deferReply({ flags: 64 });

    const raid = findRaidForInteraction(interaction);
    const raidChannelId = raid ? findRaidChannelId(raid) : null;

    const userName = interaction.user.displayName ?? interaction.user.username;

    if (raidChannelId && raid) {
      try {
        const raidChannel = await client.channels.fetch(raidChannelId).catch(() => null);
        if (raidChannel) {
          await raidChannel.send({
            content:
              `🔄 **${userName}** is looking to **swap their account**!\n` +
              `> If you'd like to swap, reply to this message or DM **${userName}** directly.`,
            allowedMentions: { parse: [] }
          });
        }
      } catch {}
    }

    if (raid) {
      const roleId = process.env.RAID_ROLE_ID;
      if (roleId) {
        const guild = interaction.guild || await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
        if (guild) {
          const members = await fetchRoleMembers(guild, roleId);
          for (const [, member] of members) {
            if (member.id === interaction.user.id) continue;
            await member.user.send({
              content:
                `🔄 **${userName}** is looking to **swap their account**!\n` +
                `> If you'd like to swap, DM **${userName}** directly.`,
              allowedMentions: { parse: [] }
            }).catch(() => {});
          }
        }
      }
    }

    await interaction.editReply({ content: "✅ Swap request sent to all raiders!" });
    return true;
  }

  // ── Find raid for remaining buttons ──
  const raid = findRaidForInteraction(interaction);
  const raidChannelId = raid ? findRaidChannelId(raid) : null;

  // ── Raid Note (open modal) ──
  if (customId === "raid_note") {
    if (!hasRole(interaction.member, process.env.RAID_LEADER_ROLE_ID)) {
      return interaction.reply({ content: "❌ Only Raid Leaders can send notes.", flags: 64 });
    }

    if (!raid) return interaction.reply({ content: "❌ No active raid in this channel.", flags: 64 });

    const modal = new ModalBuilder()
      .setCustomId(`note_modal_${raidChannelId}`)
      .setTitle("📝 Send Note to Raiders");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("note_text")
          .setLabel("Note message")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("Type your note here...")
          .setRequired(true)
          .setMaxLength(1500)
      )
    );

    await interaction.showModal(modal);
    return true;
  }

  if (!raid) return false;

  // ── Raid Ping ──
  if (customId === "raid_ping") {
    const now      = Date.now();
    const cooldown = 5 * 60 * 1000;

    if (now - raid.lastPing < cooldown) {
      const rem = cooldown - (now - raid.lastPing);
      const m   = Math.floor(rem / 60000);
      const s   = Math.ceil((rem % 60000) / 1000);
      return interaction.reply({ content: `⏳ Wait ${m}m ${s}s before pinging again.`, flags: 64 });
    }

    raid.lastPing = now;
    await interaction.deferReply({ flags: 64 });

    const pingChannel = raidChannelId ? await client.channels.fetch(raidChannelId).catch(() => null) : interaction.channel;
    if (pingChannel) {
      await pingChannel.send({
        content: `🚨 **RAID ALERT** <@&${process.env.RAID_ROLE_ID}> — Get in now!`,
        allowedMentions: { roles: [process.env.RAID_ROLE_ID] }
      });
    }
    await interaction.editReply({ content: "✅ Raid Ping Sent!" });
    return true;
  }

  // ── End Raid ──
  if (customId === "end_raid") {
    await interaction.deferReply({ flags: 64 });

    const isOwner   = interaction.user.id === raid.owner;
    const isHandler = hasRole(interaction.member, process.env.RAID_HANDLER_ROLE_ID);

    if (!isOwner && !isHandler) {
      await interaction.editReply({ content: "❌ Only the raid owner or a Raid Handler can end this raid." });
      return true;
    }

    const durationMs = Date.now() - raid.startTime;
    pendingEnds.set(raidChannelId, {
      raid, durationMs,
      selectedUsers: [], screenshotUrl: null, awaitingScreenshot: false
    });
    refreshPaused.add(raidChannelId);

    try {
      const raidChannel = await client.channels.fetch(raidChannelId).catch(() => null);
      if (raidChannel) {
        if (raid.messageId) {
          const panelMsg = await raidChannel.messages.fetch(raid.messageId).catch(() => null);
          if (panelMsg) await panelMsg.edit({ embeds: [buildEmbed(raid)], components: [] }).catch(() => {});
        }
        if (raid.memberActionMessageId) {
          const memberMsg = await raidChannel.messages.fetch(raid.memberActionMessageId).catch(() => null);
          if (memberMsg) await memberMsg.edit({ components: [] }).catch(() => {});
        }
        if (raid.statusMessageId) {
          const statusMsg = await raidChannel.messages.fetch(raid.statusMessageId).catch(() => null);
          if (statusMsg) await statusMsg.edit({ embeds: [buildStatusEmbed(raid)] }).catch(() => {});
        }
      }
    } catch {}

    await interaction.editReply({
      content:
        "## 🏁 Raid Ending\n" +
        "Use the selector below to add any **additional raiders** to the summary.\n" +
        "Optionally attach a **Raid Screenshot**, then click **Confirm**.\n\n" +
        "📸 To add a screenshot: click **Add Raid Screenshot** then send an image **in this channel**.",
      components: getRaiderSelectRow()
    });

    return true;
  }

  // ── Edit Raid ──
  if (customId === "edit_raid") {
    const d     = raid.data;
    const modal = new ModalBuilder()
      .setCustomId(`edit_raid_${raidChannelId}`)
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
        new TextInputBuilder().setCustomId("link").setLabel("Server Link").setStyle(TextInputStyle.Short).setValue(d.link)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("difficulty")
          .setLabel("Difficulty")
          .setStyle(TextInputStyle.Short)
          .setValue(d.difficulty || "")
          .setRequired(false)
      )
    );

    await interaction.showModal(modal);
    return true;
  }

  // ── In Game Toggle ──
  if (customId === "member_ingame") {
    await interaction.deferReply({ flags: 64 });

    const userId = interaction.user.id;
    const ingame = raid.members.ingame;
    const inpos  = raid.members.inposition;

    const posIdx = inpos.findIndex(e => e.userId === userId);
    if (posIdx !== -1) {
      inpos.splice(posIdx, 1);
      const guild = interaction.guild || await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
      if (guild) await removeMemberRole(guild, userId, process.env.IN_POSITION_ROLE_ID);
    }

    const idx   = ingame.indexOf(userId);
    const nowIn = idx === -1;
    if (nowIn) {
      ingame.push(userId);
      const guild = interaction.guild || await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
      if (guild) await assignMemberRole(guild, userId, process.env.IN_GAME_ROLE_ID);
    } else {
      ingame.splice(idx, 1);
      const guild = interaction.guild || await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
      if (guild) await removeMemberRole(guild, userId, process.env.IN_GAME_ROLE_ID);
    }

    await interaction.editReply({
      content: nowIn ? "✅ You're marked **In Game**!" : "❎ You're no longer **In Game**."
    });

    if (raidChannelId) await updateStatusEmbed(client, raidChannelId, raid);

    const guild = interaction.guild || await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
    if (guild) dmAllRaiders(guild, raid, true).catch(console.error);
    return true;
  }

  // ── In Position Toggle ──
  if (customId === "member_inposition") {
    const modal = new ModalBuilder()
      .setCustomId(`inposition_modal_${raidChannelId}`)
      .setTitle("📍 Set Your Position");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("position_slot")
          .setLabel("Your position number (e.g. 4)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Enter a number like 1, 2, 3...")
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(2)
      )
    );

    await interaction.showModal(modal);
    return true;
  }

  return false;
}

// ===== LIVE REFRESH (60s) =====
function startRefresh(client) {
  setInterval(async () => {
    for (const [channelId, raid] of activeRaids.entries()) {
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
      const joinRow   = buildJoinRow(raid.data.link);
      const memberMsg = await channel.send({ components: [...joinRow, ...getMemberActionRow()] });
      raid.memberActionMessageId = memberMsg.id;
    }
  }, 60000);
}

function startQueueChecker(client) {}

module.exports = {
  activeRaids,
  createRaid,
  handleRaidModal,
  handleEditModal,
  handleNoteModal,
  handleInPositionModal,
  handleButton,
  handleSelectMenu,
  handleMessage,
  startRefresh,
  startQueueChecker
};