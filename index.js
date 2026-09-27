import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  downloadContentFromMessage,
  getAggregateVotesInPollMessage,
} from "@whiskeysockets/baileys";
import sharp from "sharp";
import pino from "pino";

// ============ Configuration ============
const PREFIX = process.env.BOT_PREFIX?.trim() || "?";
const PAIRING_NUMBER = String(process.env.PAIRING_NUMBER || "").replace(/\D/g, "");
const SESSION_DIR = process.env.SESSION_DIR?.trim()
  ? path.resolve(process.env.SESSION_DIR.trim())
  : path.join(process.cwd(), "data", "auth_info_baileys");
const PORT = Number(process.env.PORT) || 8080;
const ENABLE_EVAL = process.env.ENABLE_EVAL === "true";
const OWNER_JIDS = new Set(
  (process.env.OWNER_JIDS || "").split(",").filter(Boolean).map((j) => j.trim())
);

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const waLogger = logger.child({ component: "whatsapp" });

let socket = null;
let stopping = false;
let reconnectAttempt = 0;
let menuSessions = new Map();
let messageStore = new Map();

// ============ Utility Functions ============
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeJid(jid) {
  return String(jid || "")
    .replace(/:.*/, "")
    .trim()
    .toLowerCase();
}

function isGroup(jid) {
  return jid?.endsWith("@g.us") ?? false;
}

function isOwner(jid) {
  return OWNER_JIDS.has(normalizeJid(jid));
}

function unwrap(message) {
  let content = message?.message;
  while (content) {
    const wrapper =
      content.ephemeralMessage ||
      content.viewOnceMessage ||
      content.viewOnceMessageV2 ||
      content.documentWithCaptionMessage;
    if (!wrapper?.message) break;
    content = wrapper.message;
  }
  return content || {};
}

function textOf(message) {
  const content = unwrap(message);
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content.templateButtonReplyMessage?.selectedId ||
    ""
  ).trim();
}

function senderOf(message) {
  return message.key.participant || message.key.remoteJid || "";
}

function storeMessage(message) {
  if (message?.key?.id) {
    messageStore.set(message.key.id, message);
    if (messageStore.size > 1000) {
      messageStore.delete(messageStore.keys().next().value);
    }
  }
}

// ============ Poll/Menu Handling ============
function getPollUpdate(message) {
  return unwrap(message).pollUpdateMessage || null;
}

function getPollKey(update) {
  const key = update?.pollCreationMessage?.key;
  return key ? `${key.remoteJid}:${key.id}` : "";
}

async function sendMenu(jid, sender) {
  const menuOptions = ["📸 Figuras", "👮 Moderação", "🛠️ Utilitários", "ℹ️ Sobre"];
  
  const poll = await socket.sendMessage(jid, {
    poll: {
      name: "Menu SyntraxBot",
      values: menuOptions,
      selectableCount: 1,
    },
  });

  const response = await socket.sendMessage(
    jid,
    { text: "*Selecione uma categoria acima ☝️*" },
    { quoted: poll }
  );

  if (poll?.key?.id && response?.key?.id) {
    menuSessions.set(getPollKey(poll), {
      jid,
      sender: normalizeJid(sender),
      responseKey: response.key,
      pollMessage: poll,
      createdAt: Date.now(),
    });
  }
}

async function handleMenuPoll(message) {
  const update = getPollUpdate(message);
  if (!update?.pollCreationMessage?.key) return false;

  const session = menuSessions.get(getPollKey(update));
  if (!session || normalizeJid(update.voterJid) !== session.sender) return true;

  const votes = getAggregateVotesInPollMessage({
    message: messageStore.get(update.pollCreationMessage.key.id),
    pollUpdates: [message],
  });

  const menuOptions = ["📸 Figuras", "👮 Moderação", "🛠️ Utilitários", "ℹ️ Sobre"];
  const selected = menuOptions.find((opt) => votes?.[opt]?.length > 0);

  if (!selected) return true;

  const menuResponses = {
    "📸 Figuras": `*🖼️ MENU FIGURAS*\n\n${PREFIX}s - Responda uma figurinha para converter em imagem\n${PREFIX}img - Responda uma imagem para converter em figurinha\n${PREFIX}fig - Alias de figurinha`,
    "👮 Moderação": `*👮 MENU MODERAÇÃO* (Apenas admins)\n\n${PREFIX}ban @user - Remove um membro\n${PREFIX}promote @user - Promove a administrador\n${PREFIX}demote @user - Remove de administrador`,
    "🛠️ Utilitários": `*🛠️ MENU UTILITÁRIOS*\n\n${PREFIX}ping - Verifica se o bot está online\n${PREFIX}uptime - Mostra tempo de atividade\n${PREFIX}info - Informações da mensagem`,
    "ℹ️ Sobre": `*ℹ️ SOBRE O BOT*\n\n🤖 SyntraxBot v1.1\nBot de WhatsApp usando Baileys\n👥 Suporte a grupos e privados\n⚡ Comandos: ${PREFIX}menu\n\nPrefix: ${PREFIX}`,
  };

  await socket.sendMessage(jid, { text: menuResponses[selected], edit: session.responseKey });
  menuSessions.delete(getPollKey(update));
  return true;
}

// ============ Media Conversion ============
async function stickerToImage(message, jid) {
  try {
    const sticker = unwrap(message).stickerMessage;
    if (!sticker) {
      await socket.sendMessage(
        jid,
        { text: `Responda uma figurinha com ${PREFIX}img` },
        { quoted: message }
      );
      return;
    }

    const buffer = await downloadContentFromMessage(sticker, "image");
    const chunks = [];
    for await (const chunk of buffer) chunks.push(chunk);
    const imageBuffer = Buffer.concat(chunks);

    const image = await sharp(imageBuffer).png().toBuffer();
    await socket.sendMessage(
      jid,
      { image, caption: "🖼️ Sua imagem" },
      { quoted: message }
    );
  } catch (error) {
    waLogger.error({ err: error }, "Erro ao converter figurinha para imagem");
    await socket.sendMessage(
      jid,
      { text: `❌ Erro: ${error.message}` },
      { quoted: message }
    );
  }
}

async function imageToSticker(message, jid) {
  try {
    const image = unwrap(message).imageMessage;
    if (!image) {
      await socket.sendMessage(
        jid,
        { text: `Responda uma imagem com ${PREFIX}s` },
        { quoted: message }
      );
      return;
    }

    const buffer = await downloadContentFromMessage(image, "image");
    const chunks = [];
    for await (const chunk of buffer) chunks.push(chunk);
    const imageBuffer = Buffer.concat(chunks);

    const webp = await sharp(imageBuffer)
      .resize(512, 512, { fit: "cover", withoutEnlargement: false })
      .webp()
      .toBuffer();

    await socket.sendMessage(jid, { sticker: webp }, { quoted: message });
  } catch (error) {
    waLogger.error({ err: error }, "Erro ao converter imagem para figurinha");
    await socket.sendMessage(
      jid,
      { text: `❌ Erro: ${error.message}` },
      { quoted: message }
    );
  }
}

// ============ Group Commands ============
async function getGroupInfo(jid, sender) {
  const metadata = await socket.groupMetadata(jid);
  const senderParticipant = metadata.participants.find(
    (p) => normalizeJid(p.id) === normalizeJid(sender)
  );
  const botParticipant = metadata.participants.find(
    (p) => normalizeJid(p.id) === normalizeJid(socket.user.id)
  );

  return {
    jid,
    isAdmin: senderParticipant?.admin === "admin" || senderParticipant?.admin === "superadmin",
    isBotAdmin: botParticipant?.admin === "admin" || botParticipant?.admin === "superadmin",
    participants: metadata.participants,
  };
}

async function handleGroupAction(jid, sender, action, mention, message) {
  if (!isGroup(jid)) {
    await socket.sendMessage(
      jid,
      { text: "Este comando só funciona em grupos." },
      { quoted: message }
    );
    return;
  }

  const group = await getGroupInfo(jid, sender);
  
  if (!group.isAdmin) {
    await socket.sendMessage(
      jid,
      { text: "👮 Apenas administradores podem usar este comando." },
      { quoted: message }
    );
    return;
  }

  if (!group.isBotAdmin) {
    await socket.sendMessage(
      jid,
      { text: "🤖 Eu preciso ser administrador do grupo para isso." },
      { quoted: message }
    );
    return;
  }

  if (!mention || mention.length === 0) {
    await socket.sendMessage(
      jid,
      { text: `Use: ${PREFIX}${action} @usuario` },
      { quoted: message }
    );
    return;
  }

  try {
    await socket.groupParticipantsUpdate(
      jid,
      [mention[0] + "@s.whatsapp.net"],
      action
    );

    const responses = {
      remove: "🗑️ Membro removido do grupo!",
      promote: "⬆️ Usuário promovido a administrador!",
      demote: "⬇️ Administrador rebaixado.",
    };

    await socket.sendMessage(
      jid,
      { text: responses[action] || "Ação realizada!" },
      { quoted: message }
    );
  } catch (error) {
    waLogger.error({ err: error, action }, "Erro em comando de grupo");
    await socket.sendMessage(
      jid,
      { text: `❌ Erro: ${error.message}` },
      { quoted: message }
    );
  }
}

// ============ Info Command ============
async function sendMessageInfo(jid, message) {
  try {
    const content = unwrap(message);
    const info = {
      remoteJid: message.key.remoteJid,
      messageId: message.key.id,
      timestamp: new Date(message.messageTimestamp * 1000),
      fromMe: message.key.fromMe,
      sender: senderOf(message),
      text: textOf(message).slice(0, 100),
      contentType: Object.keys(content)[0] || "unknown",
      hasMedia: !!content.imageMessage || !!content.videoMessage || !!content.documentMessage,
      isQuoted: !!content.extendedTextMessage?.contextInfo?.quotedMessage,
      mentions: content.extendedTextMessage?.contextInfo?.mentionedJid || [],
    };

    const formatted = JSON.stringify(info, null, 2);
    const output = formatted.length > 4096 ? formatted.slice(0, 4000) + "..." : formatted;

    await socket.sendMessage(
      jid,
      { text: "```\n" + output + "\n```" },
      { quoted: message }
    );
  } catch (error) {
    waLogger.error({ err: error }, "Erro ao gerar info");
    await socket.sendMessage(
      jid,
      { text: `❌ Erro: ${error.message}` },
      { quoted: message }
    );
  }
}

// ============ Code Execution ============
async function executeCode(jid, sender, code, message) {
  if (!ENABLE_EVAL) {
    await socket.sendMessage(
      jid,
      { text: "⛔ Execução de código está desativada." },
      { quoted: message }
    );
    return;
  }

  if (!isOwner(sender)) {
    await socket.sendMessage(
      jid,
      { text: "🔐 Apenas o proprietário pode executar código." },
      { quoted: message }
    );
    return;
  }

  if (!code.trim()) {
    await socket.sendMessage(
      jid,
      { text: `Uso: ${PREFIX}execute <código JavaScript>` },
      { quoted: message }
    );
    return;
  }

  try {
    const result = await new Function(
      "socket",
      "jid",
      "sender",
      "msg",
      "sleep",
      `return (async () => {
        ${code}
      })()`
    )(socket, jid, sender, message, sleep);

    const output =
      result === undefined
        ? "✅ Executado sem retorno"
        : typeof result === "string"
          ? result
          : JSON.stringify(result, null, 2);

    await socket.sendMessage(
      jid,
      { text: "```\n" + output.slice(0, 4000) + "\n```" },
      { quoted: message }
    );
  } catch (error) {
    waLogger.error({ err: error }, "Erro ao executar código");
    await socket.sendMessage(
      jid,
      { text: "```\n" + error.message.slice(0, 500) + "\n```" },
      { quoted: message }
    );
  }
}

// ============ Command Handler ============
async function handleCommand(socket, message, jid, sender, text) {
  const parts = text.slice(PREFIX.length).trim().split(/\s+/);
  const command = (parts.shift() || "").toLowerCase();
  const args = parts;
  const body = args.join(" ");

  switch (command) {
    case "menu":
    case "help":
      return sendMenu(jid, sender);

    case "ping":
      return socket.sendMessage(jid, { text: "🏓 Pong!" }, { quoted: message });

    case "uptime": {
      const uptime = Math.floor(process.uptime());
      const h = Math.floor(uptime / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      const s = uptime % 60;
      return socket.sendMessage(
        jid,
        { text: `⏱️ Bot ativo há ${h}h ${m}m ${s}s` },
        { quoted: message }
      );
    }

    case "info":
      return sendMessageInfo(jid, message);

    case "s":
    case "sticker":
    case "fig":
      return imageToSticker(message, jid);

    case "img":
    case "toimg":
    case "imagem":
      return stickerToImage(message, jid);

    case "ban":
      return handleGroupAction(jid, sender, "remove", args, message);

    case "promote":
      return handleGroupAction(jid, sender, "promote", args, message);

    case "demote":
      return handleGroupAction(jid, sender, "demote", args, message);

    case "execute":
    case "exec":
    case "eval":
      return executeCode(jid, sender, body, message);

    default:
      return socket.sendMessage(
        jid,
        { text: `❌ Comando não encontrado. Use ${PREFIX}menu para ver as opções.` },
        { quoted: message }
      );
  }
}

// ============ Connection Setup ============
async function connect() {
  await fs.promises.mkdir(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  socket = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("SyntraxBot"),
    logger: waLogger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Handle QR code or pairing code
    if (qr) {
      waLogger.info("QR Code disponível para scan");
    }

    // Handle pairing code - CORRETO CONFORME BAILEYS
    if (!socket.authState.creds.registered && PAIRING_NUMBER) {
      try {
        const code = await socket.requestPairingCode(PAIRING_NUMBER);
        waLogger.info({ pairingCode: code }, `Código de pareamento (${PAIRING_NUMBER})`);
      } catch (error) {
        waLogger.error({ err: error }, "Erro ao gerar código de pareamento");
      }
    }

    if (connection === "open") {
      reconnectAttempt = 0;
      waLogger.info({ account: socket.user?.id }, "WhatsApp conectado!");
      return;
    }

    if (connection !== "close" || stopping) return;

    socket = null;
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

    if (!shouldReconnect) {
      waLogger.error("Sessão encerrada. Remova a pasta de autenticação para vincular novamente.");
      return;
    }

    reconnectAttempt++;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
    waLogger.warn({ statusCode, delay }, "Reconectando após desconexão");
    await sleep(delay);
    if (!stopping) await connect();
  });

  socket.ev.on("messages.upsert", async (event) => {
    if (event.type !== "notify") return;

    for (const message of event.messages) {
      storeMessage(message);

      if (getPollUpdate(message)) {
        try {
          await handleMenuPoll(message);
        } catch (error) {
          waLogger.error({ err: error }, "Erro ao processar voto da poll");
        }
        continue;
      }

      if (!message?.message || message.key.fromMe || message.key.remoteJid === "status@broadcast") {
        continue;
      }

      const jid = message.key.remoteJid;
      const text = textOf(message).trim();
      if (!jid || !text.startsWith(PREFIX)) continue;

      try {
        await handleCommand(socket, message, jid, senderOf(message), text);
      } catch (error) {
        waLogger.error({ err: error }, "Erro ao processar comando");
        await socket.sendMessage(
          jid,
          { text: `❌ Erro ao processar comando: ${error.message.slice(0, 100)}` },
          { quoted: message }
        );
      }
    }
  });
}

// ============ HTTP Server ============
const server = createServer((request, response) => {
  if (["/", "/health", "/api/healthz"].includes(request.url)) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: "ok", connected: !!socket }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Not found" }));
});

// ============ Shutdown Handler ============
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Encerrando processo");
  try {
    socket?.end?.(new Error("Encerramento solicitado"));
  } finally {
    server.close(() => process.exit(0));
  }
}

// ============ Start Server ============
server.listen(PORT, () => {
  logger.info({ port: PORT, sessionDir: SESSION_DIR }, "Servidor HTTP iniciado");
  connect().catch((error) => {
    logger.error({ err: error }, "Falha ao iniciar o bot");
    process.exitCode = 1;
  });
});

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
