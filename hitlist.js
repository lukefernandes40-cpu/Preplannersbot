const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const noblox = require("noblox.js");
const fetch = require("node-fetch");
const fs = require("fs");

const DB_FILE = "./hitlist.json";

// store active messages
const messageMap = new Map();

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

module.exports = {
  data: new SlashCommandBuilder()
    .setName("hitlist")
    .setDescription("Manage hitlist")

    .addSubcommand(c =>
      c.setName("add")
        .setDescription("Add user")
        .addStringOption(o =>
          o.setName("username")
            .setDescription("Roblox username")
            .setRequired(true)
        )
    )

    .addSubcommand(c =>
      c.setName("remove")
        .setDescription("Remove user")
        .addStringOption(o =>
          o.setName("username")
            .setDescription("Roblox username")
            .setRequired(true)
        )
    )

    .addSubcommand(c =>
      c.setName("list")
        .setDescription("Show all hitlist users")
    ),

  async execute(interaction) {

    if (!interaction.member.roles.cache.has(process.env.HITLIST_ROLE_ID)) {
      return interaction.reply({ content: "❌ No permission", ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    let db = loadDB();

    // ADD
    if (sub === "add") {
      const username = interaction.options.getString("username");

      if (db.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return interaction.reply({ content: "⚠️ Already added", ephemeral: true });
      }

      const userId = await getUserId(username);
      if (!userId) {
        return interaction.reply({ content: "❌ User not found", ephemeral: true });
      }

      db.push({ username, userId });
      saveDB(db);

      return interaction.reply(`✅ Added ${username}`);
    }

    // REMOVE
    if (sub === "remove") {
      const username = interaction.options.getString("username");

      db = db.filter(u => u.username.toLowerCase() !== username.toLowerCase());
      saveDB(db);

      return interaction.reply(`🗑 Removed ${username}`);
    }

    // LIST
    if (sub === "list") {
      if (db.length === 0) {
        return interaction.reply("📭 Hitlist empty");
      }

      const list = db.map(u => `• ${u.username}`).join("\n");

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("📋 Hitlist Users")
            .setDescription(list)
        ]
      });
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

        console.log(`${user.username} → ${status}`);

        const existingMsgId = messageMap.get(user.userId);

        // ===== IF ONLINE / IN GAME =====
        if (status === "online" || status === "in_game") {

          const text =
            status === "in_game"
              ? `🎮 **${user.username}** → In Game`
              : `🟢 **${user.username}** → Online`;

          const embed = new EmbedBuilder()
            .setTitle("🎯 Active Hitlist")
            .setColor(0x00ff99)
            .setDescription(text)
            .setTimestamp();

          // UPDATE EXISTING
          if (existingMsgId) {
            try {
              const msg = await channel.messages.fetch(existingMsgId);
              await msg.edit({ embeds: [embed] });
            } catch {
              messageMap.delete(user.userId);
            }
          }

          // CREATE NEW
          if (!messageMap.has(user.userId)) {
            const msg = await channel.send({ embeds: [embed] });
            messageMap.set(user.userId, msg.id);
          }
        }

        // ===== IF OFFLINE =====
        if (status === "offline") {
          if (existingMsgId) {
            try {
              const msg = await channel.messages.fetch(existingMsgId);
              await msg.delete();
            } catch {}

            messageMap.delete(user.userId);
          }
        }
      }

    }, 60000);
  }
};