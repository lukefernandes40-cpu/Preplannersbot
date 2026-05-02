const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const noblox = require("noblox.js");
const fetch = require("node-fetch");
const fs = require("fs");

const DB_FILE = "./hitlist.json";
const MSG_FILE = "./hitlist_messages.json";

// ===== LOCK =====
let trackerRunning = false;

// ===== MESSAGE MAP (persisted to disk) =====
function loadMessageMap() {
  if (!fs.existsSync(MSG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(MSG_FILE));
  } catch {
    return {};
  }
}

function saveMessageMap(map) {
  fs.writeFileSync(MSG_FILE, JSON.stringify(map, null, 2));
}

// ===== DISPLAY NAME CACHE =====
const displayCache = new Map();

async function getDisplayName(userId) {
  const cached = displayCache.get(userId);
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) {
    return cached.name;
  }

  try {
    const user = await noblox.getPlayerInfo(userId);
    const display = user.displayName || user.username;
    displayCache.set(userId, { name: display, time: Date.now() });
    return display;
  } catch {
    return cached?.name || null;
  }
}

// ===== LOAD / SAVE DB =====
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DB_FILE));
  } catch {
    return [];
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
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
  try {
    return await noblox.getIdFromUsername(username);
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

// ===== EMBED =====
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

// ===== COMMAND =====
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

    // ===== ADD =====
    if (sub === "add") {
      const username = interaction.options.getString("username");

      if (db.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return interaction.editReply("⚠️ Already added");
      }

      const userId = await getUserId(username);
      if (!userId) return interaction.editReply("❌ User not found on Roblox");

      db.push({ username, userId });
      saveDB(db);

      // Immediately post a new embed for this user without waiting for the interval
      try {
        const channel = await interaction.client.channels.fetch(process.env.HITLIST_CHANNEL_ID).catch(() => null);
        if (channel) {
          const status = await getPresence(userId);
          const displayName = await getDisplayName(userId) || username;
          const embed = buildEmbed({ username, userId }, displayName, status);

          const msg = await channel.send({ embeds: [embed] });

          const msgMap = loadMessageMap();
          msgMap[userId] = msg.id;
          saveMessageMap(msgMap);
        }
      } catch (e) {
        console.log("Error posting new hitlist embed:", e);
      }

      return interaction.editReply(`✅ Added ${username}`);
    }

    // ===== REMOVE =====
    if (sub === "remove") {
      const username = interaction.options.getString("username");
      const user = db.find(u => u.username.toLowerCase() === username.toLowerCase());

      db = db.filter(u => u.username.toLowerCase() !== username.toLowerCase());
      saveDB(db);

      // Delete the embed from the channel too
      if (user) {
        try {
          const channel = await interaction.client.channels.fetch(process.env.HITLIST_CHANNEL_ID).catch(() => null);
          const msgMap = loadMessageMap();
          const msgId = msgMap[user.userId];

          if (channel && msgId) {
            const msg = await channel.messages.fetch(msgId).catch(() => null);
            if (msg) await msg.delete().catch(() => {});
          }

          delete msgMap[user.userId];
          saveMessageMap(msgMap);
        } catch (e) {
          console.log("Error deleting hitlist embed:", e);
        }
      }

      return interaction.editReply(`🗑 Removed ${username}`);
    }

    // ===== LIST =====
    if (sub === "list") {
      if (!db.length) return interaction.editReply("📭 Empty");
      return interaction.editReply(db.map(u => `• ${u.username}`).join("\n"));
    }
  },

  // ===== TRACKER =====
  async startTracker(client) {
    await loginRoblox();
    console.log("🚀 Tracker started");

    setInterval(async () => {
      // Lock: skip this tick if the previous one is still running
      if (trackerRunning) {
        console.log("⏭ Tracker still running, skipping tick");
        return;
      }
      trackerRunning = true;

      try {
        const channel = await client.channels.fetch(process.env.HITLIST_CHANNEL_ID).catch(() => null);
        if (!channel) return;

        const db = loadDB();
        const msgMap = loadMessageMap();

        for (const user of db) {
          try {
            const status = await getPresence(user.userId);
            const displayName = await getDisplayName(user.userId) || user.username;
            const embed = buildEmbed(user, displayName, status);

            const existingMsgId = msgMap[user.userId];

            if (existingMsgId) {
              // Try to edit existing message
              const msg = await channel.messages.fetch(existingMsgId).catch(() => null);
              if (msg) {
                await msg.edit({ embeds: [embed] });
                continue;
              } else {
                // Message was deleted manually, clean up
                delete msgMap[user.userId];
              }
            }

            // Create new message
            const msg = await channel.send({ embeds: [embed] });
            msgMap[user.userId] = msg.id;

          } catch (e) {
            console.log(`Error processing user ${user.username}:`, e);
          }
        }

        saveMessageMap(msgMap);

      } catch (e) {
        console.log("Tracker error:", e);
      } finally {
        trackerRunning = false;
      }

    }, 60000);
  }
};