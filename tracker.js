// ===== TRACKER.JS =====
// Silent anti-leak tokenized link tracking system.
// Every raid-role Discord member gets a unique personal link per raid.
// When their link is clicked, the backend silently logs the access and
// redirects instantly to the real public server link — no forms, no prompts,
// no warnings, no visible signs of tracking whatsoever.
//
// If someone leaks their link, multiple different visitors will click it.
// You can check this via /tracker lookup <token> or /tracker report <raidid>.
//
// ARCHITECTURE:
//   Express routes  →  /join/:token  /r/:token  /access/:token  /invite/:token  /s/:token
//   DB              →  ./tracker_db.json
//   Admin Discord   →  TRACKER_ADMIN_CHANNEL_ID  (dashboard only — no live alerts)
//
// ENV VARS NEEDED (add to .env):
//   TRACKER_ADMIN_CHANNEL_ID=   private admin channel for dashboard
//   TRACKER_BASE_URL=           your public Express URL e.g. https://yourbot.onrender.com
//   RAID_ROLE_ID=               role whose members get unique links

"use strict";

const fs      = require("fs");
const crypto  = require("crypto");
const express = require("express");
const { EmbedBuilder } = require("discord.js");

const DB_FILE = "./tracker_db.json";

// ===== DB =====
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { raids: {}, users: {} };
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return { raids: {}, users: {} }; }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ===== TOKEN GENERATOR =====
// Short alphanumeric tokens that look like normal invite codes.
const tokenPool = new Set();

function generateToken() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let token;
  do {
    token = "";
    for (let i = 0; i < 4; i++) token += chars[crypto.randomInt(0, chars.length)];
  } while (tokenPool.has(token));
  tokenPool.add(token);
  return token;
}

// ===== URL STYLES =====
// Rotate through multiple path patterns so all links look natural and varied.
const URL_PATTERNS = ["/join/", "/r/", "/access/", "/invite/", "/s/"];

function buildTokenUrl(token, baseUrl) {
  const pattern = URL_PATTERNS[Math.floor(Math.random() * URL_PATTERNS.length)];
  return `${baseUrl}${pattern}${token}`;
}

// ===== DISCORD CLIENT REFERENCE =====
let _client = null;

// ===== UPDATE OR POST DASHBOARD EMBED =====
async function refreshDashboard() {
  const channelId = process.env.TRACKER_ADMIN_CHANNEL_ID;
  if (!channelId || !_client) return;

  const db    = loadDB();
  const embed = buildDashboardEmbed(db);

  try {
    const ch = await _client.channels.fetch(channelId).catch(() => null);
    if (!ch) return;

    if (db.dashboardMsgId) {
      const msg = await ch.messages.fetch(db.dashboardMsgId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [embed] }).catch(() => {});
        return;
      }
    }
    const msg = await ch.send({ embeds: [embed] });
    db.dashboardMsgId = msg.id;
    saveDB(db);
    await msg.pin().catch(() => {});
  } catch (e) {
    console.log("Dashboard refresh error:", e.message);
  }
}

// ===== DASHBOARD EMBED =====
function buildDashboardEmbed(db) {
  const raids = Object.values(db.raids || {});

  // Sort users by unique visitor count descending
  const userLines = Object.entries(db.users || {})
    .sort(([, a], [, b]) => (b.totalUniqueVisitors || 0) - (a.totalUniqueVisitors || 0))
    .slice(0, 20)
    .map(([discordId, u]) => {
      const clicks  = u.totalClicks || 0;
      const unique  = u.totalUniqueVisitors || 0;
      const raidsIn = (u.raidHistory || []).length;
      const flag    = unique >= 3 ? "🚨" : unique >= 2 ? "⚠️" : "✅";
      return (
        `${flag} **${u.discordTag || discordId}**\n` +
        `┗ Total clicks: **${clicks}** | Unique visitors: **${unique}** | Raids: **${raidsIn}**`
      );
    });

  const recentRaids = raids.slice(-5).reverse().map(r => {
    const tokenCount  = Object.keys(r.tokens || {}).length;
    const totalClicks = r.totalClicks || 0;
    const leaked      = Object.values(r.tokens || {}).filter(t => (t.uniqueVisitors || 0) >= 2).length;
    return `**${r.raidId}** — ${new Date(r.createdAt).toLocaleDateString()} | ${tokenCount} members | ${totalClicks} clicks | ${leaked} possibly leaked`;
  });

  return new EmbedBuilder()
    .setTitle("🕵️ Anti-Leak Tracker Dashboard")
    .setColor(0x2b2d31)
    .setDescription(
      "Click counts for each member's unique raid link.\n" +
      "Multiple unique visitors on one link = possible leak."
    )
    .addFields(
      {
        name:  "📊 Members by Unique Visitors",
        value: userLines.length > 0 ? userLines.join("\n\n") : "No data yet.",
        inline: false
      },
      {
        name:  "🗂️ Recent Raids",
        value: recentRaids.length > 0 ? recentRaids.join("\n") : "No raids tracked yet.",
        inline: false
      }
    )
    .setFooter({ text: "Updates every 5 min • Check /tracker report <raidid> for full details" })
    .setTimestamp();
}

// ===== HASH IP =====
// Never store raw IPs. Store a truncated SHA-256 hash for correlation only.
function hashIp(ip) {
  return crypto.createHash("sha256").update(ip + "preplannersbot_salt").digest("hex").slice(0, 16);
}

// ===== REGISTER EXPRESS ROUTES =====
function registerRoutes(app) {
  const patterns = ["/join/:token", "/r/:token", "/access/:token", "/invite/:token", "/s/:token"];

  for (const pattern of patterns) {
    // GET — silently log the visit, instantly redirect to the real link. No page shown.
    app.get(pattern, async (req, res) => {
      const token = req.params.token.toUpperCase().trim();
      const ip    = req.ip || req.headers["x-forwarded-for"] || "unknown";

      // Find the raid link to redirect to
      const db      = loadDB();
      let realLink  = null;
      let tokenData = null;
      let raidData  = null;

      for (const raid of Object.values(db.raids || {})) {
        if (raid.tokens && raid.tokens[token]) {
          tokenData = raid.tokens[token];
          raidData  = raid;
          realLink  = raid.publicLink || null;
          break;
        }
      }

      // Unknown token — redirect to roblox.com silently
      if (!tokenData || !raidData) {
        return res.redirect(302, "https://www.roblox.com");
      }

      // Log the access silently
      const now      = Date.now();
      const hashedIp = hashIp(ip);

      tokenData.clickCount      = (tokenData.clickCount || 0) + 1;
      tokenData.lastClick       = now;
      tokenData.firstClick      = tokenData.firstClick || now;
      tokenData.clicks          = tokenData.clicks || [];
      tokenData.uniqueIps       = tokenData.uniqueIps || [];

      tokenData.clicks.push({ timestamp: now, ip: hashedIp });

      // Track unique visitors by hashed IP
      if (!tokenData.uniqueIps.includes(hashedIp)) {
        tokenData.uniqueIps.push(hashedIp);
      }
      tokenData.uniqueVisitors = tokenData.uniqueIps.length;

      // Update raid-level totals
      raidData.totalClicks = (raidData.totalClicks || 0) + 1;

      // Update user-level totals
      const userId = tokenData.discordId;
      if (!db.users[userId]) {
        db.users[userId] = {
          discordId:           userId,
          discordTag:          tokenData.discordTag,
          totalClicks:         0,
          totalUniqueVisitors: 0,
          raidHistory:         []
        };
      }
      const userRecord = db.users[userId];
      userRecord.totalClicks         = (userRecord.totalClicks || 0) + 1;
      userRecord.totalUniqueVisitors = (userRecord.totalUniqueVisitors || 0);

      // Recalculate total unique visitors across all this user's tokens
      let totalUnique = 0;
      for (const raid of Object.values(db.raids || {})) {
        for (const t of Object.values(raid.tokens || {})) {
          if (t.discordId === userId) totalUnique += (t.uniqueVisitors || 0);
        }
      }
      userRecord.totalUniqueVisitors = totalUnique;

      // Update raid history for this user
      const raidEntry = (userRecord.raidHistory || []).find(r => r.raidId === raidData.raidId);
      if (raidEntry) {
        raidEntry.clicks        = tokenData.clickCount;
        raidEntry.uniqueVisitors = tokenData.uniqueVisitors;
      } else {
        userRecord.raidHistory = userRecord.raidHistory || [];
        userRecord.raidHistory.push({
          raidId:        raidData.raidId,
          clicks:        tokenData.clickCount,
          uniqueVisitors: tokenData.uniqueVisitors,
          date:          now
        });
      }

      saveDB(db);

      // Refresh dashboard silently in the background
      refreshDashboard().catch(() => {});

      // Redirect immediately — user sees nothing unusual
      return res.redirect(302, realLink || "https://www.roblox.com");
    });
  }

  console.log("✅ Tracker routes registered");
}

// ===== CREATE RAID TOKENS =====
// Generates a unique token + tracking link for every raid-role member.
// publicLink = the real Roblox server link entered in the /raid modal.
// Returns a Map: discordId → { token, url }
async function createRaidTokens(guild, raidId, publicLink) {
  const roleId = process.env.RAID_ROLE_ID;
  if (!roleId) return new Map();

  const baseUrl = (process.env.TRACKER_BASE_URL || "").replace(/\/$/, "");
  if (!baseUrl) {
    console.log("⚠️ TRACKER_BASE_URL not set — tracker links disabled");
    return new Map();
  }

  const db  = loadDB();
  const now = Date.now();

  if (!db.raids[raidId]) {
    db.raids[raidId] = {
      raidId,
      createdAt:   now,
      publicLink:  publicLink || null,
      tokens:      {},
      totalClicks: 0
    };
  }

  const members  = guild.members.cache.filter(m => m.roles.cache.has(roleId) && !m.user.bot);
  const tokenMap = new Map();

  for (const [, member] of members) {
    const token = generateToken();
    const url   = buildTokenUrl(token, baseUrl);

    db.raids[raidId].tokens[token] = {
      token,
      discordId:      member.id,
      discordTag:     member.user.tag || member.user.username,
      raidId,
      clickCount:     0,
      firstClick:     null,
      lastClick:      null,
      clicks:         [],
      uniqueIps:      [],
      uniqueVisitors: 0
    };

    tokenMap.set(member.id, { token, url });
  }

  saveDB(db);
  console.log(`✅ Generated ${tokenMap.size} tracker tokens for raid ${raidId}`);
  return tokenMap;
}

// ===== DM TOKENS TO RAID MEMBERS =====
// Sends each member their unique link via DM after the raid embed.
// The message is intentionally simple — no mention of tracking.
async function dmRaidTokens(guild, raidId, raidData, tokenMap) {
  const roleId = process.env.RAID_ROLE_ID;
  if (!roleId) return;

  const members = guild.members.cache.filter(m => m.roles.cache.has(roleId) && !m.user.bot);

  for (const [, member] of members) {
    const tokenInfo = tokenMap.get(member.id);
    if (!tokenInfo) continue;

    // Simple DM — just their personal server link, no suspicious-looking language
    await member.user.send(
      `🔗 **Your private server link:** ${tokenInfo.url}`
    ).catch(() => {});
  }
}

// ===== ADMIN: RAID REPORT =====
// Posts a per-raid click summary to the admin channel.
async function postRaidReport(raidId) {
  const channelId = process.env.TRACKER_ADMIN_CHANNEL_ID;
  if (!channelId || !_client) return;

  const db       = loadDB();
  const raidData = db.raids[raidId];
  if (!raidData) return;

  const tokens = Object.values(raidData.tokens || {});

  // Sort by unique visitors descending
  const sorted = [...tokens].sort((a, b) => (b.uniqueVisitors || 0) - (a.uniqueVisitors || 0));

  const lines = sorted.map(t => {
    const flag = (t.uniqueVisitors || 0) >= 3 ? "🚨" : (t.uniqueVisitors || 0) >= 2 ? "⚠️" : "✅";
    return (
      `${flag} **\`${t.token}\`** — ${t.discordTag} (<@${t.discordId}>)\n` +
      `┗ Clicks: **${t.clickCount || 0}** | Unique visitors: **${t.uniqueVisitors || 0}**`
    );
  });

  const suspicious = sorted.filter(t => (t.uniqueVisitors || 0) >= 2);

  const embed = new EmbedBuilder()
    .setTitle(`📋 Raid Report — ${raidId}`)
    .setColor(suspicious.length > 0 ? 0xff6600 : 0x00cc44)
    .setDescription(
      suspicious.length > 0
        ? `**${suspicious.length}** member(s) with multiple unique visitors on their link.`
        : "✅ No leaks detected — all links accessed by a single visitor."
    )
    .addFields(
      {
        name:  "📊 All Members",
        value: lines.length > 0 ? lines.slice(0, 20).join("\n\n") : "No data.",
        inline: false
      },
      { name: "Total Members",        value: String(tokens.length),            inline: true },
      { name: "Total Clicks",         value: String(raidData.totalClicks || 0), inline: true },
      { name: "Possibly Leaked",      value: String(suspicious.length),         inline: true }
    )
    .setTimestamp();

  try {
    const ch = await _client.channels.fetch(channelId).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] });
  } catch (e) {
    console.log("postRaidReport error:", e.message);
  }
}

// ===== TOKEN LOOKUP =====
function lookupToken(token) {
  const db = loadDB();
  for (const raid of Object.values(db.raids || {})) {
    const t = raid.tokens?.[token];
    if (t) return { ...t, raidId: raid.raidId };
  }
  return null;
}

// ===== USER PROFILE =====
function getUserProfile(discordId) {
  const db = loadDB();
  return db.users?.[discordId] || null;
}

// ===== START TRACKER =====
function startTracker(client) {
  _client = client;
  console.log("✅ Tracker started");
  setInterval(() => refreshDashboard().catch(() => {}), 5 * 60 * 1000);
}

module.exports = {
  registerRoutes,
  startTracker,
  createRaidTokens,
  dmRaidTokens,
  postRaidReport,
  lookupToken,
  getUserProfile,
  buildDashboardEmbed,
  refreshDashboard
};