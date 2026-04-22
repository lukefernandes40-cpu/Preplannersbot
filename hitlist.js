const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const noblox = require("noblox.js");
const fetch = require("node-fetch");
const fs = require("fs");

const DB_FILE = "./hitlist.json";

// store active messages
const messageMap = new Map();

// cache display names
const displayCache = new Map();

async function getDisplayName(userId) {
  const cached = displayCache.get(userId);

  // refresh every 5 minutes
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) {
    return cached.name;
  }

  try {
    const user = await noblox.getPlayerInfo(userId);
    const display = user.displayName || user.username;

    displayCache.set(userId, {
      name: display,
      time: Date.now()
    });

    return display;
  } catch {
    return cached?.name || null;
  }
}

// ===== LOAD DB =====
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return [];
  return JSON.parse(fs.readFileSync(DB_FILE));
}

// ===== SAVE DB =====
function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ===== LOGIN =====
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
  try {
    return await noblox.getIdFromUsername(username);
  } catch {
    return null;
  }
}

// ===== GET DISPLAY NAME =====
async function getDisplayName(userId) {
  if (displayCache.has(userId)) return displayCache.get(userId);

  try {
    const user = await noblox.getPlayerInfo(userId);
    const display = user.displayName || user.username;

    displayCache.set(userId, display);
    return display;
  } catch {
    return null;
  }
}

// ===== PRESENCE =====
async function getPresence(userId) {
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
    if (!data.userPresences?.[0]) return "offline";

    const type = data.userPresences[0].userPresenceType;

    if (type === 2) return "in_game";
    if (type === 1) return "online";

    return "offline";

  } catch (e) {
    console.log("Presence error:", e);
    return "offline";
  }
}

// ===== EMBED BUILDER =====
function buildEmbed(user, displayName, status) {

  let text = "⚫ Offline";
  let color = 0x2f3136;

  if (status === "online") {
    text = "🟢 Online";
    color = 0x00ff99;
  }

  if (status === "in_game") {
    text = "🎮 In Game";
    color = 0x00ff99;
  }

  return new EmbedBuilder()
    .setTitle("🎯 Active Hitlist")
    .setDescription(`👤 **${displayName}** (@${user.username}) → ${text}`)
    .setColor(color)
    .setTimestamp();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("hitlist")
    .setDescription("Manage hitlist")
    .addSubcommand(c =>
      c.setName("add")
        .setDescription("Add user")
        .addStringOption(o =>
          o.setName("username")
            .setRequired(true)
            .setDescription("Roblox username")
        )
    )
    .addSubcommand(c =>
      c.setName("remove")
        .setDescription("Remove user")
        .addStringOption(o =>
          o.setName("username")
            .setRequired(true)
            .setDescription("Roblox username")
        )
    )
    .addSubcommand(c =>
      c.setName("list")
        .setDescription("Show users")
    ),

  async execute(interaction) {

    await interaction.deferReply({ ephemeral: true });

    if (!interaction.member.roles.cache.has(process.env.HITLIST_ROLE_ID)) {
      return interaction.editReply("❌ No permission");
    }

    const sub = interaction.options.getSubcommand();
    let db = loadDB();

    if (sub === "add") {
      const username = interaction.options.getString("username");

      if (db.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return interaction.editReply("⚠️ Already added");
      }

      const userId = await getUserId(username);
      if (!userId) return interaction.editReply("❌ User not found");

      db.push({ username, userId });
      saveDB(db);

      return interaction.editReply(`✅ Added ${username}`);
    }

    if (sub === "remove") {
      const username = interaction.options.getString("username");

      db = db.filter(u => u.username.toLowerCase() !== username.toLowerCase());
      saveDB(db);

      return interaction.editReply(`🗑 Removed ${username}`);
    }

    if (sub === "list") {
      if (!db.length) return interaction.editReply("📭 Empty");

      return interaction.editReply(
        db.map(u => `• ${u.username}`).join("\n")
      );
    }
  },

  // ===== TRACKER =====
  async startTracker(client) {

    await loginRoblox();
    console.log("🚀 Tracker started");

    setInterval(async () => {

      const channel = await client.channels.fetch(process.env.HITLIST_CHANNEL_ID).catch(() => null);
      if (!channel) return;

      const db = loadDB();

      for (const user of db) {

        const status = await getPresence(user.userId);
        const displayName = await getDisplayName(user.userId) || user.username;

        const embed = buildEmbed(user, displayName, status);

        const existingMsgId = messageMap.get(user.userId);

        // UPDATE
        if (existingMsgId) {
          try {
            const msg = await channel.messages.fetch(existingMsgId);
            await msg.edit({ embeds: [embed] });
            continue;
          } catch {
            messageMap.delete(user.userId);
          }
        }

        // CREATE
        const msg = await channel.send({ embeds: [embed] });
        messageMap.set(user.userId, msg.id);

      }

    }, 60000);
  }
};