// ===== HITLIST.JS =====
// Tracks Roblox users and posts live status embeds.
// FIX: Profile link always shows. Join link shows when joins are ON (gameId + gameInstanceId present).
// FIX: When joins are OFF the embed still links the profile and shows TSB link.

const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const noblox = require("noblox.js");
const fetch  = require("node-fetch");
const fs     = require("fs");

const DB_FILE  = "./hitlist.json";
const MSG_FILE = "./hitlist_messages.json";
const TSB_PLACE_ID = 10449761463;

// ===== LOCK =====
let trackerRunning = false;

// ===== ANALYTICS STORE =====
const analyticsStore = new Map();
const sessionStart   = new Map();

// ===== MESSAGE MAP =====
function loadMessageMap() {
  if (!fs.existsSync(MSG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(MSG_FILE)); } catch { return {}; }
}
function saveMessageMap(map) {
  fs.writeFileSync(MSG_FILE, JSON.stringify(map, null, 2));
}

// ===== DB =====
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch { return []; }
}
function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ===== DISPLAY NAME CACHE =====
const displayCache = new Map();
async function getDisplayName(userId) {
  const cached = displayCache.get(userId);
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) return cached.name;
  try {
    const user    = await noblox.getPlayerInfo(userId);
    const display = user.displayName || user.username;
    displayCache.set(userId, { name: display, time: Date.now() });
    return display;
  } catch {
    return cached?.name || null;
  }
}

// ===== ROBLOX LOGIN =====
async function loginRoblox() {
  try {
    await noblox.setCookie(process.env.ROBLOX_COOKIE);
    console.log("✅ Logged into Roblox");
  } catch (e) {
    console.log("❌ Roblox login failed:", e);
  }
}

// ===== GET USER ID =====
async function getUserId(username) {
  try { return await noblox.getIdFromUsername(username); } catch { return null; }
}

// ===== FULL PRESENCE =====
async function getPresenceFull(userId) {
  try {
    const res = await fetch("https://presence.roblox.com/v1/presence/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}`
      },
      body: JSON.stringify({ userIds: [userId] })
    });
    const data = await res.json();
    return data.userPresences?.[0] || null;
  } catch {
    return null;
  }
}

// ===== STATUS FROM PRESENCE =====
function presenceToStatus(p) {
  if (!p || p.userPresenceType === 0) return "offline";
  if (p.userPresenceType === 2)       return "in_game";
  if (p.userPresenceType === 1)       return "online";
  return "offline";
}

// ===== RECORD ANALYTICS =====
function recordAnalytics(userId, newStatus) {
  const prev = sessionStart.get(userId);
  const now  = Date.now();

  if (!analyticsStore.has(userId)) {
    analyticsStore.set(userId, { sessions: [], dailyCounts: {0:0,1:0,2:0,3:0,4:0,5:0,6:0} });
  }
  const data = analyticsStore.get(userId);

  if (prev && prev.status !== "offline" && prev.status !== newStatus) {
    const duration = now - prev.time;
    data.sessions.push({ start: prev.time, end: now, status: prev.status, durationMs: duration });

    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    data.sessions = data.sessions.filter(s => s.end > cutoff);

    const day = new Date(prev.time).getDay();
    if (prev.status !== "offline") {
      data.dailyCounts[day] = (data.dailyCounts[day] || 0) + 1;
    }
  }

  sessionStart.set(userId, { time: now, status: newStatus });
}

// ===== AVATAR CACHE =====
const avatarCache = new Map();
async function getAvatarUrl(userId) {
  const cached = avatarCache.get(userId);
  if (cached && Date.now() - cached.time < 10 * 60 * 1000) return cached.url;
  try {
    const res  = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
    );
    const data = await res.json();
    const url  = data.data?.[0]?.imageUrl || null;
    if (url) avatarCache.set(userId, { url, time: Date.now() });
    return url;
  } catch {
    return null;
  }
}

// ===== BUILD HITLIST EMBED =====
// FIX: profileUrl is always included in every status branch.
// FIX: joinable check uses gameId AND gameInstanceId — if either is missing, joins are off.
// FIX: Join URL uses the correct deep link format that opens the specific server instance.
async function buildHitlistEmbed(user, displayName, presence) {
  const status     = presenceToStatus(presence);
  const profileUrl = `https://www.roblox.com/users/${user.userId}/profile`;
  const tsbUrl     = `https://www.roblox.com/games/${TSB_PLACE_ID}/The-Strongest-Battlegrounds`;
  const avatarUrl  = await getAvatarUrl(user.userId);

  // A user is in TSB when their rootPlaceId OR placeId matches
  const inTSB = presence && (
    presence.rootPlaceId === TSB_PLACE_ID ||
    presence.placeId     === TSB_PLACE_ID
  );

  // Joinable = in TSB, AND both gameId and gameInstanceId are present and non-empty
  const joinable = inTSB &&
    presence.gameId           &&
    presence.gameInstanceId   &&
    presence.gameId           !== "" &&
    presence.gameInstanceId   !== "";

  let color      = 0x2b2d31;
  let statusLine = "⚫  **OFFLINE**";
  let tsbLine    = null;
  let profileLine = `🔗 [**Profile**](${profileUrl})`;

  if (status === "offline") {
    color      = 0x2b2d31;
    statusLine = "⚫  **OFFLINE**";
  } else if (status === "online" && !inTSB) {
    color      = 0x5865f2;
    statusLine = "🟢  **ONLINE** — browsing Roblox";
  } else if (status === "in_game" && !inTSB) {
    color      = 0xffa500;
    statusLine = `🎮  **IN GAME** — not in TSB`;
    if (presence?.lastLocation) {
      statusLine += `\n📍 ${presence.lastLocation}`;
    }
  } else if (inTSB && !joinable) {
    // In TSB but joins are OFF — still show profile + TSB link
    color      = 0xe03c3c;
    statusLine = "🎮  **IN TSB** — joins **OFF**";
    tsbLine    = `🗡️ [Open TSB](${tsbUrl})`;
  } else if (inTSB && joinable) {
    // Joins ON — deep link directly into their server instance
    const joinUrl = `https://www.roblox.com/games/start?placeId=${TSB_PLACE_ID}&gameInstanceId=${presence.gameInstanceId}`;
    color      = 0xffd700;
    statusLine = "🎯  **IN TSB — JOINS ON!**";
    tsbLine    = `🚀 [**JOIN NOW**](${joinUrl})  ·  🗡️ [TSB](${tsbUrl})`;
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(displayName)
    .setURL(profileUrl)   // Clickable title → profile
    .addFields(
      {
        name:   "👤 Account",
        value:  `[**@${user.username}**](${profileUrl})`,
        inline: true
      },
      {
        name:   "📶 Status",
        value:  statusLine,
        inline: true
      }
    )
    .setFooter({ text: `Roblox ID: ${user.userId}` })
    .setTimestamp();

  // TSB field (only when in TSB)
  if (tsbLine) {
    embed.addFields({ name: "🎯 TSB", value: tsbLine, inline: false });
  }

  if (avatarUrl) embed.setThumbnail(avatarUrl);

  return embed;
}

// ===== SNIPE LOGIC =====
async function snipeUser(userId) {
  const presence = await getPresenceFull(userId);
  if (!presence || presence.userPresenceType === 0) return { status: "offline" };

  const inTSB = presence.rootPlaceId === TSB_PLACE_ID || presence.placeId === TSB_PLACE_ID;

  if (presence.userPresenceType === 2) {
    if (!inTSB) return { status: "other_game", location: presence.lastLocation };
    const joinable = !!presence.gameId && !!presence.gameInstanceId;
    if (joinable) return { status: "in_tsb_joinable", instanceId: presence.gameInstanceId };
    return { status: "in_tsb_nojoin" };
  }
  return { status: "online_not_ingame" };
}

// ===== SNIPE EMBED =====
function buildSnipeEmbed(user, displayName, result) {
  const profileUrl = `https://www.roblox.com/users/${user.userId}/profile`;
  const tsbUrl     = `https://www.roblox.com/games/${TSB_PLACE_ID}/The-Strongest-Battlegrounds`;

  let desc  = `👤 **${displayName}** ([@${user.username}](${profileUrl}))\n\n`;
  let color = 0x555555;

  if (result.status === "offline") {
    desc += "⚫ **Offline** — not in any game.";
  } else if (result.status === "online_not_ingame") {
    desc += `🟢 **Online** — not in a game.\n🔗 [Profile](${profileUrl})`;
    color = 0x00aaff;
  } else if (result.status === "other_game") {
    desc += `🎮 **In Game** — NOT in TSB.`;
    if (result.location) desc += `\n📍 ${result.location}`;
    desc += `\n🔗 [Profile](${profileUrl})`;
    color = 0xffa500;
  } else if (result.status === "in_tsb_nojoin") {
    desc += `🎮 **In TSB** — joins **OFF**.\n🔗 [Profile](${profileUrl})\n🗡️ [TSB](${tsbUrl})`;
    color = 0xff4444;
  } else if (result.status === "in_tsb_joinable") {
    const joinUrl = `https://www.roblox.com/games/start?placeId=${TSB_PLACE_ID}&gameInstanceId=${result.instanceId}`;
    desc += `🎯 **IN TSB — JOINS ON!**\n🚀 [Join Now](${joinUrl})\n🔗 [Profile](${profileUrl})\n🗡️ [TSB](${tsbUrl})`;
    color = 0xffff00;
  }

  return new EmbedBuilder()
    .setTitle("🔍 Snipe Result")
    .setDescription(desc)
    .setColor(color)
    .setTimestamp();
}

// ===== WEEKLY ANALYSIS EMBED =====
function buildAnalysisEmbed(db) {
  const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const lines = [];

  for (const user of db) {
    const data = analyticsStore.get(user.userId);
    if (!data || data.sessions.length === 0) {
      lines.push(`**${user.username}** — No data yet.`);
      continue;
    }

    const sessions = data.sessions;
    const avgMs    = sessions.reduce((a, s) => a + s.durationMs, 0) / sessions.length;
    const avgMin   = Math.round(avgMs / 60000);
    const totalMs  = sessions.reduce((a, s) => a + s.durationMs, 0);
    const totalHrs = (totalMs / 3600000).toFixed(1);

    const bestDay     = Object.entries(data.dailyCounts).sort(([,a],[,b]) => b - a)[0];
    const bestDayName = bestDay ? DAY_NAMES[parseInt(bestDay[0])] : "N/A";

    const gameSessions = sessions.filter(s => s.status === "in_game");
    const avgGameMin   = gameSessions.length > 0
      ? Math.round(gameSessions.reduce((a,s) => a + s.durationMs, 0) / gameSessions.length / 60000)
      : 0;

    const shortSession = avgMin < 30 ? 3 : avgMin < 60 ? 2 : 0;
    const lowTotal     = parseFloat(totalHrs) < 5 ? 3 : parseFloat(totalHrs) < 10 ? 1 : 0;
    const targetScore  = Math.min(10, shortSession + lowTotal + (gameSessions.length > 0 ? 2 : 0));

    lines.push(
      `**${user.username}**\n` +
      `┣ 🕐 Avg session: **${avgMin}m** | 🎮 Avg game: **${avgGameMin}m**\n` +
      `┣ ⏳ Total online: **${totalHrs}h** this week\n` +
      `┣ 📅 Most active: **${bestDayName}**\n` +
      `┗ 🎯 Target ease: **${targetScore}/10**${targetScore >= 7 ? " ← Easy target" : targetScore >= 4 ? " ← Moderate" : " ← Hard"}`
    );
  }

  const description = lines.length > 0
    ? lines.join("\n\n")
    : "No hitlist members or no data collected yet.";

  return new EmbedBuilder()
    .setTitle("📊 Weekly Hitlist Intelligence Report")
    .setDescription(description)
    .setColor(0x8800ff)
    .setFooter({ text: "Analysis covers the past 7 days • Updated every Friday" })
    .setTimestamp();
}

// ===== STATUS TRACKER =====
const lastKnownStatus = new Map();

async function runTrackerTick(client) {
  const channel = await client.channels.fetch(process.env.HITLIST_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const db     = loadDB();
  const msgMap = loadMessageMap();
  if (!db.length) return;

  const results = await Promise.all(
    db.map(async user => {
      const presence    = await getPresenceFull(user.userId);
      const displayName = await getDisplayName(user.userId) || user.username;
      const status      = presenceToStatus(presence);
      return { user, presence, displayName, status };
    })
  );

  for (const { user, status } of results) {
    recordAnalytics(user.userId, status);
  }

  const changed   = results.filter(r => lastKnownStatus.get(r.user.userId) !== r.status);
  const unchanged = results.filter(r => lastKnownStatus.get(r.user.userId) === r.status);

  for (const { user, status } of results) {
    lastKnownStatus.set(user.userId, status);
  }

  // In-place edit for unchanged (no reorder)
  for (const { user, presence, displayName } of unchanged) {
    const msgId = msgMap[user.userId];
    if (!msgId) continue;
    const msg = await channel.messages.fetch(msgId).catch(() => null);
    if (msg) await msg.edit({ embeds: [await buildHitlistEmbed(user, displayName, presence)] }).catch(() => {});
  }

  if (changed.length === 0) {
    saveMessageMap(msgMap);
    return;
  }

  // Delete old embeds for changed users
  for (const { user } of changed) {
    const existingId = msgMap[user.userId];
    if (existingId) {
      const msg = await channel.messages.fetch(existingId).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
      delete msgMap[user.userId];
    }
  }

  // Repost in order: offline → online → in_game (in_game = newest = bottom)
  const offlineChanged = changed.filter(r => r.status === "offline");
  const onlineChanged  = changed.filter(r => r.status === "online");
  const ingameChanged  = changed.filter(r => r.status === "in_game");

  for (const { user, presence, displayName } of [...offlineChanged, ...onlineChanged, ...ingameChanged]) {
    try {
      const embed = await buildHitlistEmbed(user, displayName, presence);
      const msg   = await channel.send({ embeds: [embed] });
      msgMap[user.userId] = msg.id;
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.log(`Error reposting embed for ${user.username}:`, e);
    }
  }

  saveMessageMap(msgMap);
}

// ===== WEEKLY REPORT SCHEDULER =====
function startWeeklyReport(client) {
  setInterval(async () => {
    const now = new Date();
    if (now.getDay() !== 5) return;
    if (now.getHours() !== 18 || now.getMinutes() !== 0) return;

    const channelId = process.env.HITLIST_ANALYSIS_CHANNEL_ID;
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const db    = loadDB();
    const embed = buildAnalysisEmbed(db);
    await channel.send({ embeds: [embed] }).catch(() => {});
  }, 60 * 1000);
}

// ===== COMMAND =====
module.exports = {
  data: new SlashCommandBuilder()
    .setName("hitlist")
    .setDescription("Manage hitlist")
    .addSubcommand(c =>
      c.setName("add")
        .setDescription("Add a user to the hitlist")
        .addStringOption(o => o.setName("username").setRequired(true).setDescription("Roblox username"))
    )
    .addSubcommand(c =>
      c.setName("remove")
        .setDescription("Remove a user from the hitlist")
        .addStringOption(o => o.setName("username").setRequired(true).setDescription("Roblox username"))
    )
    .addSubcommand(c => c.setName("list").setDescription("Show all hitlist users"))
    .addSubcommand(c =>
      c.setName("snipe")
        .setDescription("Check if a hitlist member is in TSB")
        .addStringOption(o =>
          o.setName("username").setRequired(false).setDescription("Roblox username — leave blank to snipe ALL")
        )
    )
    .addSubcommand(c => c.setName("report").setDescription("Generate weekly intel report now")),

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

    if (!interaction.member.roles.cache.has(process.env.HITLIST_ROLE_ID)) {
      return interaction.editReply("❌ No permission");
    }

    const sub = interaction.options.getSubcommand();
    let db    = loadDB();

    // ===== ADD =====
    if (sub === "add") {
      const username = interaction.options.getString("username");
      if (db.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return interaction.editReply("⚠️ Already on the hitlist");
      }
      const userId = await getUserId(username);
      if (!userId) return interaction.editReply("❌ User not found on Roblox");

      db.push({ username, userId });
      saveDB(db);

      try {
        const ch = await interaction.client.channels.fetch(process.env.HITLIST_CHANNEL_ID).catch(() => null);
        if (ch) {
          const presence    = await getPresenceFull(userId);
          const displayName = await getDisplayName(userId) || username;
          const embed       = await buildHitlistEmbed({ username, userId }, displayName, presence);
          const msg         = await ch.send({ embeds: [embed] });
          const msgMap      = loadMessageMap();
          msgMap[userId]    = msg.id;
          saveMessageMap(msgMap);
          lastKnownStatus.set(userId, presenceToStatus(presence));
        }
      } catch (e) {
        console.log("Error posting new hitlist embed:", e);
      }

      return interaction.editReply(`✅ Added **${username}** to the hitlist`);
    }

    // ===== REMOVE =====
    if (sub === "remove") {
      const username = interaction.options.getString("username");
      const user     = db.find(u => u.username.toLowerCase() === username.toLowerCase());
      db = db.filter(u => u.username.toLowerCase() !== username.toLowerCase());
      saveDB(db);

      if (user) {
        try {
          const ch     = await interaction.client.channels.fetch(process.env.HITLIST_CHANNEL_ID).catch(() => null);
          const msgMap = loadMessageMap();
          const msgId  = msgMap[user.userId];
          if (ch && msgId) {
            const msg = await ch.messages.fetch(msgId).catch(() => null);
            if (msg) await msg.delete().catch(() => {});
          }
          delete msgMap[user.userId];
          saveMessageMap(msgMap);
          lastKnownStatus.delete(user.userId);
        } catch (e) {
          console.log("Error deleting hitlist embed:", e);
        }
      }

      return interaction.editReply(`🗑️ Removed **${username}** from the hitlist`);
    }

    // ===== LIST =====
    if (sub === "list") {
      if (!db.length) return interaction.editReply("📭 Hitlist is empty");
      return interaction.editReply(db.map(u => `• ${u.username}`).join("\n"));
    }

    // ===== SNIPE =====
    if (sub === "snipe") {
      const inputUsername = interaction.options.getString("username");

      if (inputUsername) {
        const user = db.find(u => u.username.toLowerCase() === inputUsername.toLowerCase());
        if (!user) return interaction.editReply("❌ That user isn't on the hitlist.");
        const displayName = await getDisplayName(user.userId) || user.username;
        const result      = await snipeUser(user.userId);
        const embed       = buildSnipeEmbed(user, displayName, result);
        return interaction.editReply({ embeds: [embed] });
      }

      if (!db.length) return interaction.editReply("📭 Hitlist is empty.");
      await interaction.editReply(`🔍 Scanning all **${db.length}** hitlist members...`);
      const ch = await interaction.client.channels.fetch(process.env.HITLIST_CHANNEL_ID).catch(() => null);

      for (const user of db) {
        try {
          const displayName = await getDisplayName(user.userId) || user.username;
          const result      = await snipeUser(user.userId);
          const embed       = buildSnipeEmbed(user, displayName, result);
          if (ch) await ch.send({ embeds: [embed] });
        } catch (e) {
          console.log(`Snipe error for ${user.username}:`, e);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // ===== REPORT =====
    if (sub === "report") {
      const embed = buildAnalysisEmbed(db);
      return interaction.editReply({ embeds: [embed] });
    }
  },

  async startTracker(client) {
    await loginRoblox();
    console.log("🚀 Hitlist tracker started");

    setInterval(async () => {
      if (trackerRunning) {
        console.log("⏭ Tracker still running, skipping tick");
        return;
      }
      trackerRunning = true;
      try {
        await runTrackerTick(client);
      } catch (e) {
        console.log("Tracker error:", e);
      } finally {
        trackerRunning = false;
      }
    }, 60000);

    startWeeklyReport(client);
  }
};