// ===== RAID.JS =====
// FIX 1: End-raid screenshot — any message with an image while awaitingScreenshot=true is
//         captured immediately, regardless of whether the user also typed "upload".
//         The upload/replace-ss commands are blocked while awaitingScreenshot is active.
// FIX 2: Crystal-clear summary image — posted as a real file attachment so Discord
//         never re-compresses it. setImage('attachment://raid-result.png') renders inline.
// FIX 3: Opcode 8 GatewayRateLimitError — removed guild.members.fetch({withPresences:false})
//         which triggers a full guild-wide chunk (opcode 8). We now fetch only the specific
//         user IDs we need, and fall back to cache — never a full guild fetch.
// FIX 4: DMs update INSTANTLY on every raid mutation (no 60s delay for DM updates).

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

// Tracker is required lazily so circular deps are avoided at startup
let _tracker = null;
function getTracker() {
  if (!_tracker) _tracker = require("./tracker");
  return _tracker;
}

const activeRaids   = new Map();
const raidStats     = new Map();
const pendingEnds   = new Map();
const refreshPaused = new Set();

// ===== HELPER =====
function hasRole(member, roleId) {
  if (!roleId) return false;
  return member?.roles?.cache?.has(roleId);
}

// ===== SAFE MEMBER FETCH =====
// FIX 3: Never fetch the whole guild (opcode 8). Only fetch specific user IDs by passing
// the user_ids array, which uses a targeted opcode 9 request — no rate limit issues.
async function safeFetchMember(guild, userId) {
  // Try cache first
  const cached = guild.members.cache.get(userId);
  if (cached) return cached;
  // Fetch only this specific user — does NOT trigger opcode 8
  try {
    return await guild.members.fetch({ user: userId, force: false });
  } catch {
    return null;
  }
}

// Fetch all members with a specific role without triggering opcode 8.
// We use the cache (populated by the initial DM send) instead of a full guild chunk.
async function fetchRoleMembers(guild, roleId) {
  if (!roleId) return new Map();
  // Members are already cached from when the raid DMs were sent.
  // Filter from cache — no network request needed.
  return guild.members.cache.filter(m => m.roles.cache.has(roleId) && !m.user.bot);
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
      { name: "🌍 Region",      value: raid.data.region  },
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
// FIX 2: The embed uses attachment://raid-result.png so the image is always full-res.
// The actual file bytes are attached by the caller — not a remote URL in the embed.
function buildSummaryEmbed(raid, durationMs, extraRaiders = [], hasScreenshot = false) {
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

  // FIX 2: Use the attachment:// protocol — Discord renders this at full native resolution
  // without any recompression. The actual PNG bytes are supplied via files:[].
  if (hasScreenshot) {
    embed.setImage("attachment://raid-result.png");
  }

  return embed;
}

// ===== BUILD SUMMARY MESSAGE PAYLOAD =====
// FIX 2: Returns { embeds, files } — if there's a screenshot URL we fetch the image
// bytes and pass them as a real file attachment for full-res rendering.
async function buildSummaryPayload(raid, durationMs, extraRaiders = [], screenshotUrl = null) {
  const hasScreenshot = !!screenshotUrl;
  const embed = buildSummaryEmbed(raid, durationMs, extraRaiders, hasScreenshot);

  if (!hasScreenshot) {
    return { embeds: [embed], files: [] };
  }

  // Fetch the image bytes from the Discord CDN URL and pass as attachment
  try {
    const fetch = require("node-fetch");
    const res   = await fetch(screenshotUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.buffer();
    return {
      embeds: [embed],
      files:  [{ attachment: buffer, name: "raid-result.png" }]
    };
  } catch (e) {
    // If fetch fails, fall back to remote URL (still shows, just may compress)
    console.log("⚠️ Could not fetch screenshot bytes, falling back to URL:", e.message);
    const fallbackEmbed = buildSummaryEmbed(raid, durationMs, extraRaiders, false);
    fallbackEmbed.setImage(screenshotUrl);
    return { embeds: [fallbackEmbed], files: [] };
  }
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
// isUpdate=true  → edit existing DM messages in-place (instant, no new message)
// isUpdate=false → send fresh DMs to every raid-role member
// FIX 3: Uses fetchRoleMembers() which reads from cache — no opcode 8 chunk.
async function dmAllRaiders(guild, raid, isUpdate = false) {
  const roleId = process.env.RAID_ROLE_ID;
  if (!roleId) return;

  // FIX 3: Read from cache — members are already there from guild startup / previous fetches.
  const members = await fetchRoleMembers(guild, roleId);

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
      // DMs closed — skip silently
    }
  }
}

// ===== FINALISE RAID =====
// FIX 3: No guild.members.fetch() call here anymore — only targeted per-user fetches.
// FIX 2: Uses buildSummaryPayload() which sends screenshot as a real file attachment.
async function finaliseRaid(guild, client, raid, durationMs, extraRaiders = [], screenshotUrl = null) {
  const ingame     = raid.members?.ingame || [];
  const queueUsers = Object.keys(raid.members?.queue || {});
  const allHelped  = [...new Set([...ingame, ...queueUsers, ...extraRaiders])];

  // Build the summary payload (fetches screenshot bytes for full-res if needed)
  const summaryPayload = await buildSummaryPayload(raid, durationMs, extraRaiders, screenshotUrl);

  // ===== ROLE ASSIGNMENT =====
  // FIX 3: safeFetchMember per-user instead of fetching the whole guild
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

  // No Help — 5 consecutive misses
  if (process.env.NO_HELP_ROLE_ID) {
    // FIX 3: Use cache — no full guild fetch
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

  // Post to summary channel — FIX 2: full-res file attachment
  if (process.env.RAID_SUMMARY_CHANNEL_ID) {
    try {
      const sumCh = await client.channels.fetch(process.env.RAID_SUMMARY_CHANNEL_ID);
      if (sumCh) await sumCh.send(summaryPayload);
    } catch (e) {
      console.log("Error posting to summary channel:", e.message);
    }
  }

  // DM summary to all raid-role members — FIX 2 + FIX 3
  const roleId = process.env.RAID_ROLE_ID;
  if (roleId) {
    const members = guild.members.cache.filter(m => m.roles.cache.has(roleId) && !m.user.bot);
    for (const [, member] of members) {
      // FIX 2: Send the same full-res payload to each DM
      await member.user.send(summaryPayload).catch(() => {});
    }
  }

  // Post anti-leak tracker report for this raid to the admin channel
  if (raid.raidId) {
    getTracker().postRaidReport(raid.raidId).catch(() => {});
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

  return interaction.showModal(modal);
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
    dmMessages: {},
    raidId: `RAID-${channel.id}`   // stored so finaliseRaid can post the tracker report
  };

  const msg = await channel.send({ embeds: [buildEmbed(raidState)], components: getControlRows() });
  raidState.messageId = msg.id;

  const statusMsg = await channel.send({ embeds: [buildStatusEmbed(raidState)] });
  raidState.statusMessageId = statusMsg.id;

  const memberMsg = await channel.send({ components: getMemberActionRow() });
  raidState.memberActionMessageId = memberMsg.id;

  activeRaids.set(channel.id, raidState);

  await interaction.editReply({ content: `✅ Raid created: <#${channel.id}>` });

  // DMs sent immediately — cache is populated from guild startup
  dmAllRaiders(guild, raidState, false).catch(console.error);

  // Generate personal tracking tokens and DM them to every raid-role member.
  // Pass data.link so each token redirects silently to the actual public server link.
  const raidId  = `RAID-${channel.id}`;
  const tracker = getTracker();
  tracker.createRaidTokens(guild, raidId, data.link).then(tokenMap => {
    tracker.dmRaidTokens(guild, raidId, raidState, tokenMap).catch(console.error);
  }).catch(console.error);
}

// ===== HANDLE EDIT MODAL =====
async function handleEditModal(interaction) {
  await interaction.deferReply({ flags: 64 });

  const channelId = interaction.customId.replace("edit_raid_", "");
  const raid = activeRaids.get(channelId);
  if (!raid) return interaction.editReply({ content: "❌ Raid not found" });

  raid.data.region  = interaction.fields.getTextInputValue("region");
  raid.data.allies  = interaction.fields.getTextInputValue("allies");
  raid.data.enemies = interaction.fields.getTextInputValue("enemies");
  raid.data.link    = interaction.fields.getTextInputValue("link");

  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (channel && raid.messageId) {
    const msg = await channel.messages.fetch(raid.messageId).catch(() => null);
    if (msg) await msg.edit({ embeds: [buildEmbed(raid)], components: getControlRows() });
  }

  await interaction.editReply({ content: "✅ Raid updated." });

  // DMs updated INSTANTLY
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

  await interaction.deferUpdate().catch(() => {});

  await updateStatusEmbed(interaction.client, channelId, raid);
  dmAllRaiders(interaction.guild, raid, true).catch(console.error);
}

// ===== UPDATE STATUS EMBED IN CHANNEL =====
async function updateStatusEmbed(client, channelId, raid) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !raid.statusMessageId) return;
  const msg = await channel.messages.fetch(raid.statusMessageId).catch(() => null);
  if (msg) await msg.edit({ embeds: [buildStatusEmbed(raid)] });
}

// ===== HANDLE SCREENSHOT MESSAGE =====
// FIX 1: When awaitingScreenshot=true, ANY message with an image (regardless of text)
//         is captured for the raid-end summary — even if the user typed "upload".
//         The upload/replace-ss commands are fully blocked in this state.
async function handleMessage(message) {
  if (message.author.bot) return;

  const channelId = message.channel.id;
  const raid = activeRaids.get(channelId);
  if (!raid) return;

  // ===== AWAITING RAID END SCREENSHOT — checked FIRST, blocks everything else =====
  const pending = pendingEnds.get(channelId);
  if (pending?.awaitingScreenshot) {
    // Look for an image in this message (direct attach OR reply-to attach)
    let img = message.attachments.find(a => a.contentType?.startsWith("image/")) || null;

    if (!img && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        img = refMsg.attachments.find(a => a.contentType?.startsWith("image/")) || null;
      } catch {}
    }

    if (img) {
      // Grab the URL — we'll re-fetch as bytes in buildSummaryPayload for full-res
      pending.awaitingScreenshot = false;
      pending.screenshotUrl = img.url;

      await message.reply("✅ Screenshot captured! Sending raid summary now...");

      // Snapshot before deleting from maps
      const { raid: pendingRaid, durationMs, selectedUsers, screenshotUrl } = pending;
      pendingEnds.delete(channelId);
      activeRaids.delete(channelId);
      refreshPaused.delete(channelId);

      await finaliseRaid(message.guild, message.client, pendingRaid, durationMs, selectedUsers || [], screenshotUrl);
      setTimeout(() => message.channel.delete().catch(() => {}), 4000);
      return;
    }

    // No image in this message — if it was a text-only message, give a hint
    if (message.content.trim()) {
      await message.reply(
        "📸 Still waiting for your **raid screenshot**.\n" +
        "Attach an image to your message (with or without text) and send it, or click **✅ Confirm & Send Summary** to skip."
      ).catch(() => {});
    }
    // Either way, stop here — don't fall through to upload/replace-ss logic
    return;
  }

  // ===== NORMAL IN-RAID SCREENSHOT COMMANDS (upload / replace ss 1 / replace ss 2) =====
  const cmd = message.content.trim().toLowerCase();

  const isUpload   = cmd === "upload";
  const isReplace1 = cmd === "replace ss 1";
  const isReplace2 = cmd === "replace ss 2";

  if (!isUpload && !isReplace1 && !isReplace2) return;

  // Find image
  let imageUrl = null;
  const directImg = message.attachments.find(a => a.contentType?.startsWith("image/"));
  if (directImg) imageUrl = directImg.url;

  if (!imageUrl && message.reference?.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      const refImg = refMsg.attachments.find(a => a.contentType?.startsWith("image/"));
      if (refImg) imageUrl = refImg.url;
    } catch {}
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

  // Update channel embed
  const channel = await message.client.channels.fetch(channelId).catch(() => null);
  if (channel && raid.messageId) {
    const msg = await channel.messages.fetch(raid.messageId).catch(() => null);
    if (msg) await msg.edit({ embeds: [buildEmbed(raid)], components: getControlRows() });
  }

  // DMs updated INSTANTLY on screenshot
  dmAllRaiders(message.guild, raid, true).catch(console.error);
}

// ===== HANDLE BUTTONS =====
// CRITICAL RULE: every branch must call interaction.reply / deferReply / showModal / deferUpdate
// as the VERY FIRST await. No async work before responding.
async function handleButton(interaction, client) {
  const customId = interaction.customId;

  if (customId === "raid_raider_select") return false;

  // ── Screenshot upload step ──
  if (customId === "raid_screenshot_end") {
    const pending = pendingEnds.get(interaction.channel.id);
    if (!pending) return interaction.reply({ content: "❌ No pending raid end.", flags: 64 });

    pending.awaitingScreenshot = true;

    await interaction.reply({
      content:
        "📸 **Upload your raid screenshot now.**\n" +
        "Attach an image to a message in this channel and send it.\n" +
        "You can also type `upload` in the same message — either way works.\n\n" +
        "The summary will be sent automatically once the image is received.\n\n" +
        "*(Click **✅ Confirm & Send Summary** at any time to skip the screenshot.)*",
      flags: 64
    });
    return true;
  }

  // ── Confirm end ──
  if (customId === "raid_confirm_end") {
    const pending = pendingEnds.get(interaction.channel.id);
    if (!pending) return interaction.reply({ content: "❌ No pending raid end.", flags: 64 });

    // Respond FIRST — nothing async before this
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

  // ── Skip end (backward compat) ──
  if (customId === "raid_skip_end") {
    const pending = pendingEnds.get(interaction.channel.id);
    if (!pending) return interaction.reply({ content: "❌ No pending raid end.", flags: 64 });

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
      return interaction.reply({ content: `⏳ Wait ${m}m ${s}s before pinging again.`, flags: 64 });
    }

    raid.lastPing = now;
    await interaction.deferReply({ flags: 64 });
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
      return interaction.reply({
        content: "❌ Only the raid owner or a Raid Handler can end this raid.",
        flags: 64
      });
    }

    const durationMs = Date.now() - raid.startTime;
    pendingEnds.set(interaction.channel.id, {
      raid,
      durationMs,
      selectedUsers:    [],
      screenshotUrl:    null,
      awaitingScreenshot: false
    });

    refreshPaused.add(interaction.channel.id);

    // Reply FIRST
    await interaction.reply({
      content:
        "## 🏁 Raid Ending\n" +
        "Select any **additional raiders** to add to the summary, then click Confirm.\n" +
        "You can also optionally attach a **Raid Screenshot** before confirming.",
      components: getRaiderSelectRow(),
      flags: 64
    });

    // Freeze the panel so nobody clicks during end flow
    try {
      if (raid.messageId) {
        const panelMsg = await interaction.channel.messages.fetch(raid.messageId).catch(() => null);
        if (panelMsg) await panelMsg.edit({ components: [] }).catch(() => {});
      }
      if (raid.memberActionMessageId) {
        const memberMsg = await interaction.channel.messages.fetch(raid.memberActionMessageId).catch(() => null);
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

    // showModal MUST be the first and only response
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

    // Channel status + DMs instantly
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

  await interaction.reply({
    content: `✅ **${pending.selectedUsers.length}** extra raider(s) selected. Click **Confirm & Send Summary** when ready.`,
    flags: 64
  });
  return true;
}

// ===== LIVE CHANNEL PANEL REFRESH (60s) =====
// This only refreshes the CHANNEL panel display — DMs are always updated
// instantly through dmAllRaiders() calls after every mutation above.
// FIX 3: No member fetches here — pure channel message operations only.
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