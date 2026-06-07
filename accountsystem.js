// ===== ACCOUNTSYSTEM.JS =====

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder
} = require("discord.js");

const fs = require("fs");
const ACCOUNTS_FILE = "./accounts.json";

const pendingSwaps = new Map();

const COLOURS = {
  main:    0x5865f2,
  success: 0x00e676,
  danger:  0xff2244,
  swap:    0x9c27b0,
  warn:    0xff8c00
};

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE)); } catch { return []; }
}
function saveAccounts(data) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
}

function getRaiderRoleId()  { return (process.env.RAID_ROLE_ID    || "").trim(); }
function getAccountRoleId() { return (process.env.ACCOUNT_ROLE_ID || "").trim(); }

async function fetchMember(guild, userId) {
  try { return await guild.members.fetch({ user: userId, force: true }); }
  catch { return null; }
}

function hasRole(member, roleId) {
  if (!roleId) return false;
  return member.roles.cache.has(roleId);
}

function buildPanelEmbed(account, activeUserId = null) {
  const userField  = activeUserId ? `<@${activeUserId}>` : "*Nobody*";
  const statusLine = activeUserId
    ? "⛔ **This account is currently being used.**"
    : "✅ This account is free to use.";
  return new EmbedBuilder()
    .setTitle("🔐  Account Manager")
    .setColor(activeUserId ? COLOURS.danger : COLOURS.main)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "Manage and swap Roblox accounts for raid members.\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
      statusLine
    )
    .addFields(
      { name: "👤  Account",    value: `\`@${account.username}\``, inline: true },
      { name: "🎮  User using", value: userField,                  inline: true }
    )
    .setFooter({ text: activeUserId ? "Only an account manager can free this account." : "Use the button below to use this account." })
    .setTimestamp();
}

function buildAccountEmbed(account) {
  return new EmbedBuilder()
    .setTitle("🔐  Account Details")
    .setColor(COLOURS.main)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "Your assigned Roblox account credentials are below.\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    )
    .addFields(
      { name: "👤  Username", value: `\`\`\`${account.username}\`\`\``, inline: true },
      { name: "🔑  Password", value: `\`\`\`${account.password}\`\`\``, inline: true }
    )
    .setFooter({ text: "Keep these credentials private • Do not share" })
    .setTimestamp();
}

// Always show all buttons — no isManager toggle
function getPanelButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("use_account").setLabel("🟢 Use Account").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop_account").setLabel("🔴 Stop Using").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("edit_account").setLabel("✏️ Edit").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("delete_account").setLabel("🗑️ Delete").setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("member_swap").setLabel("🔄 Swap Account").setStyle(ButtonStyle.Primary)
    )
  ];
}

async function syncAllEmbeds(client) {
  const accounts = loadAccounts();
  for (const account of accounts) {
    try {
      if (!account.channelId || !account.messageId) continue;
      const ch  = await client.channels.fetch(account.channelId).catch(() => null);
      if (!ch) continue;
      const msg = await ch.messages.fetch(account.messageId).catch(() => null);
      if (!msg) continue;
      await msg.edit({
        embeds: [buildPanelEmbed(account, account.activeUserId || null)],
        components: getPanelButtons()
      });
    } catch {}
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("account")
    .setDescription("Manage raid accounts")
    .addSubcommand(c =>
      c.setName("add")
        .setDescription("Add a new Roblox account")
        .addStringOption(o => o.setName("username").setRequired(true).setDescription("Roblox username"))
        .addStringOption(o => o.setName("password").setRequired(true).setDescription("Roblox password"))
    )
    .addSubcommand(c => c.setName("list").setDescription("List all registered accounts")),

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });
    const execMember = await fetchMember(interaction.guild, interaction.user.id);
    if (!execMember || !hasRole(execMember, getAccountRoleId())) {
      return interaction.editReply("❌ You don't have permission to manage accounts.");
    }
    const sub      = interaction.options.getSubcommand();
    const accounts = loadAccounts();

    if (sub === "add") {
      const username = interaction.options.getString("username");
      const password = interaction.options.getString("password");
      if (accounts.find(a => a.username.toLowerCase() === username.toLowerCase())) {
        return interaction.editReply("⚠️ That account already exists.");
      }
      const account = { username, password, owner: interaction.user.id, activeUserId: null, messageId: null, channelId: null };
      accounts.push(account);
      const chId = (process.env.ACCOUNT_CHANNEL_ID || "").trim();
      if (chId) {
        const ch = await interaction.client.channels.fetch(chId).catch(() => null);
        if (ch) {
          const msg = await ch.send({ embeds: [buildPanelEmbed(account, null)], components: getPanelButtons() });
          account.messageId = msg.id;
          account.channelId = ch.id;
        }
      }
      saveAccounts(accounts);
      return interaction.editReply(`✅ Account **${username}** added.`);
    }

    if (sub === "list") {
      if (!accounts.length) return interaction.editReply("📭 No accounts registered.");
      return interaction.editReply(accounts.map(a => `• \`${a.username}\` — <@${a.owner}>`).join("\n"));
    }
  },

  async handleButton(interaction) {
    const customId = interaction.customId;
    const accounts = loadAccounts();
    const userId   = interaction.user.id;

    // ─ Use Account ─
    if (customId === "use_account") {
      const account = accounts.find(a => a.messageId === interaction.message.id);
      if (!account) return interaction.reply({ content: "❌ Account not found.", flags: 64 });

      const member = await fetchMember(interaction.guild, userId);
      if (!member) return interaction.reply({ content: "❌ Could not verify your roles.", flags: 64 });

      const raiderRoleId  = getRaiderRoleId();
      const accountRoleId = getAccountRoleId();
      const isRaider  = raiderRoleId  ? hasRole(member, raiderRoleId)  : false;
      const isManager = accountRoleId ? hasRole(member, accountRoleId) : false;

      if (!isRaider && !isManager) {
        return interaction.reply({ content: "❌ Only raiders or account managers can use accounts.", flags: 64 });
      }

      if (account.activeUserId && account.activeUserId !== userId) {
        return interaction.reply({
          content: `⚠️ **This account is being used** by <@${account.activeUserId}>.\nOnly an account manager can free it using the Stop Using button.`,
          flags: 64
        });
      }

      if (account.activeUserId === userId) {
        // If they're a manager re-clicking, show credentials ephemerally in channel
        if (isManager) {
          return interaction.reply({ embeds: [buildAccountEmbed(account)], flags: 64 });
        }
        return interaction.reply({ content: "ℹ️ You are already marked as using this account.", flags: 64 });
      }

      // Claim the account
      account.activeUserId = userId;
      saveAccounts(accounts);

      // Update panel — always show all buttons
      if (account.channelId && account.messageId) {
        const ch = await interaction.client.channels.fetch(account.channelId).catch(() => null);
        if (ch) {
          const msg = await ch.messages.fetch(account.messageId).catch(() => null);
          if (msg) await msg.edit({ embeds: [buildPanelEmbed(account, userId)], components: getPanelButtons() }).catch(() => {});
        }
      }

      // Managers get credentials as ephemeral channel message — no DM
      if (isManager) {
        return interaction.reply({
          content: `✅ You are now marked as using **${account.username}**.`,
          embeds: [buildAccountEmbed(account)],
          flags: 64
        });
      }

      // Raiders just get confirmation — no credentials at all
      return interaction.reply({ content: `✅ You are now marked as using **${account.username}**.`, flags: 64 });
    }

    // ─ Stop Using — ACCOUNT_ROLE_ID only ─
    if (customId === "stop_account") {
      const account = accounts.find(a => a.messageId === interaction.message.id);
      if (!account) return interaction.reply({ content: "❌ Account not found.", flags: 64 });

      const member = await fetchMember(interaction.guild, userId);
      if (!member) return interaction.reply({ content: "❌ Could not verify your roles.", flags: 64 });

      if (!hasRole(member, getAccountRoleId())) {
        return interaction.reply({ content: "❌ Only account managers can free this account.", flags: 64 });
      }

      const previousUser = account.activeUserId;
      account.activeUserId = null;
      saveAccounts(accounts);

      if (account.channelId && account.messageId) {
        const ch = await interaction.client.channels.fetch(account.channelId).catch(() => null);
        if (ch) {
          const msg = await ch.messages.fetch(account.messageId).catch(() => null);
          if (msg) await msg.edit({ embeds: [buildPanelEmbed(account, null)], components: getPanelButtons() }).catch(() => {});
        }
      }

      const replyMsg = previousUser
        ? `✅ <@${previousUser}> has been removed from **${account.username}**. The account is now free.`
        : "✅ Account was already free.";
      return interaction.reply({ content: replyMsg, flags: 64 });
    }

    // ─ All buttons below require ACCOUNT_ROLE_ID ─
    const managerCheck = await fetchMember(interaction.guild, userId);
    if (!managerCheck || !hasRole(managerCheck, getAccountRoleId())) {
      return interaction.reply({ content: "❌ You don't have permission to use this.", flags: 64 });
    }

    // ─ Edit Account ─
    if (customId === "edit_account") {
      const account = accounts.find(a => a.messageId === interaction.message.id);
      if (!account) return interaction.reply({ content: "❌ Account not found.", flags: 64 });

      const modal = new ModalBuilder()
        .setCustomId(`edit_account_${interaction.message.id}`)
        .setTitle("✏️ Edit Account");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("username").setLabel("Username").setStyle(TextInputStyle.Short).setValue(account.username).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("password").setLabel("Password").setStyle(TextInputStyle.Short).setValue(account.password).setRequired(true)
        )
      );
      return interaction.showModal(modal);
    }

    // ─ Delete Account ─
    if (customId === "delete_account") {
      const idx = accounts.findIndex(a => a.messageId === interaction.message.id);
      if (idx === -1) return interaction.reply({ content: "❌ Account not found.", flags: 64 });
      const removed = accounts.splice(idx, 1)[0];
      saveAccounts(accounts);
      await interaction.message.delete().catch(() => {});
      return interaction.reply({ content: `🗑️ Account **${removed.username}** deleted.`, flags: 64 });
    }

    // ─ Member Swap ─
    if (customId === "member_swap") {
      const account = accounts.find(a => a.messageId === interaction.message.id);
      if (!account) return interaction.reply({ content: "❌ Account not found.", flags: 64 });
      pendingSwaps.set(interaction.message.id, { account, selectedTargetId: null });
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🔄  Member Account Swap")
            .setColor(COLOURS.swap)
            .setDescription(
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              `Swapping account: **${account.username}**\n\n` +
              "Use the selector below to **choose a raider** to send this account's details to.\n" +
              "> Only members with the **Raider role** are valid swap targets.\n\n" +
              "After selecting, click **✅ Confirm Swap** to send the credentials via DM."
            )
            .setFooter({ text: "Credentials will be sent to them via DM" })
            .setTimestamp()
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
              .setCustomId(`swap_target_${interaction.message.id}`)
              .setPlaceholder("🔍 Select a raider to swap to...")
              .setMinValues(1).setMaxValues(1)
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`confirm_swap_${interaction.message.id}`)
              .setLabel("✅ Confirm Swap")
              .setStyle(ButtonStyle.Success)
              .setDisabled(true)
          )
        ],
        flags: 64
      });
    }

    // ─ swap_target_ user select ─
    if (customId.startsWith("swap_target_")) {
      const msgId   = customId.replace("swap_target_", "");
      const pending = pendingSwaps.get(msgId);
      if (!pending) return interaction.reply({ content: "❌ No pending swap found. Try again.", flags: 64 });
      const targetId = interaction.values[0];
      pending.selectedTargetId = targetId;
      pendingSwaps.set(msgId, pending);
      return interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle("🔄  Member Account Swap")
            .setColor(COLOURS.swap)
            .setDescription(
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              `Swapping account: **${pending.account.username}**\n\n` +
              `Selected raider: <@${targetId}>\n\n` +
              "✅ Click **Confirm Swap** to send the credentials to this member via DM.\n" +
              "⚠️ This action cannot be undone."
            )
            .setFooter({ text: "Credentials will be sent to them via DM" })
            .setTimestamp()
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
              .setCustomId(`swap_target_${msgId}`)
              .setPlaceholder("🔍 Select a raider to swap to...")
              .setMinValues(1).setMaxValues(1)
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`confirm_swap_${msgId}`)
              .setLabel("✅ Confirm Swap")
              .setStyle(ButtonStyle.Success)
              .setDisabled(false)
          )
        ]
      });
    }

    // ─ Confirm Swap ─
    if (customId.startsWith("confirm_swap_")) {
      const msgId   = customId.replace("confirm_swap_", "");
      const pending = pendingSwaps.get(msgId);
      if (!pending || !pending.selectedTargetId) {
        return interaction.reply({ content: "❌ No raider selected. Please select a raider first.", flags: 64 });
      }
      const { account, selectedTargetId } = pending;
      pendingSwaps.delete(msgId);

      const targetMember = await fetchMember(interaction.guild, selectedTargetId);
      if (!targetMember) return interaction.reply({ content: "❌ Could not find that member.", flags: 64 });

      const raiderRoleId = getRaiderRoleId();
      if (raiderRoleId && !hasRole(targetMember, raiderRoleId)) {
        return interaction.reply({ content: "❌ That member does not have the Raider role.", flags: 64 });
      }

      const sent = await targetMember.user.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("🔐  Account Swap — Your New Credentials")
            .setColor(COLOURS.success)
            .setDescription(
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              `You have been assigned the account **${account.username}** for the raid.\n` +
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            )
            .addFields(
              { name: "👤  Username", value: `\`\`\`${account.username}\`\`\``, inline: true },
              { name: "🔑  Password", value: `\`\`\`${account.password}\`\`\``, inline: true }
            )
            .setFooter({ text: "Keep these credentials private • Good luck!" })
            .setTimestamp()
        ]
      }).catch(() => null);

      if (!sent) {
        return interaction.update({ content: `⚠️ Could not DM <@${selectedTargetId}> — their DMs may be closed.`, embeds: [], components: [] });
      }

      const allAccounts = loadAccounts();
      const acc = allAccounts.find(a => a.username === account.username);
      if (acc) { acc.owner = selectedTargetId; acc.activeUserId = null; saveAccounts(allAccounts); }

      if (account.channelId && account.messageId) {
        const ch = await interaction.client.channels.fetch(account.channelId).catch(() => null);
        if (ch) {
          const panelMsg = await ch.messages.fetch(account.messageId).catch(() => null);
          if (panelMsg) {
            const updated = { ...account, owner: selectedTargetId, activeUserId: null };
            await panelMsg.edit({ embeds: [buildPanelEmbed(updated, null)], components: getPanelButtons() }).catch(() => {});
          }
        }
      }

      return interaction.update({ content: `✅ Account details sent to <@${selectedTargetId}> via DM. They are now the account holder.`, embeds: [], components: [] });
    }
  },

  async handleModal(interaction) {
    const member = await fetchMember(interaction.guild, interaction.user.id);
    if (!member || !hasRole(member, getAccountRoleId())) {
      return interaction.reply({ content: "❌ You don't have permission to edit accounts.", flags: 64 });
    }
    const msgId    = interaction.customId.replace("edit_account_", "");
    const accounts = loadAccounts();
    const idx      = accounts.findIndex(a => a.messageId === msgId);
    if (idx === -1) return interaction.reply({ content: "❌ Account not found.", flags: 64 });

    accounts[idx].username = interaction.fields.getTextInputValue("username");
    accounts[idx].password = interaction.fields.getTextInputValue("password");
    saveAccounts(accounts);

    await interaction.deferReply({ flags: 64 });

    const account = accounts[idx];
    if (account.channelId && account.messageId) {
      const ch = await interaction.client.channels.fetch(account.channelId).catch(() => null);
      if (ch) {
        const msg = await ch.messages.fetch(account.messageId).catch(() => null);
        if (msg) await msg.edit({ embeds: [buildPanelEmbed(account, account.activeUserId || null)], components: getPanelButtons() }).catch(() => {});
      }
    }
    return interaction.editReply("✅ Account updated.");
  },

  syncAllEmbeds
};