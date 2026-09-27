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

// ============================================================
// CONFIGURAÇÃO
// ============================================================
const PREFIX = process.env.BOT_PREFIX?.trim() || "?";
const PAIRING_NUMBER = String(process.env.PAIRING_NUMBER || "").replace(/\D/g, "");
const PORT = Number(process.env.PORT) || 8080;
const ENABLE_EVAL = process.env.ENABLE_EVAL === "true";
const OWNER_JIDS = new Set(
  (process.env.OWNER_JIDS || "")
    .split(",")
    .map((jid) => jid.trim())
    .filter(Boolean)
);

// ============================================================
// SESSÃO (compatível com Render)
// ============================================================
const USE_RENDER_SESSION = Boolean(process.env.RENDER);
const SESSION_DIR = USE_RENDER_SESSION
  ? "/tmp/wa_session"
  : path.join(process.cwd(), "data", "auth_info_baileys");

// ============================================================
// LOGGER
// ============================================================
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const waLogger = logger.child({ component: "whatsapp" });

// ============================================================
// ESTADO GLOBAL
// (agrupado num único objeto em vez de vários `let` soltos)
// ============================================================
const state = {
  socket: null,
  stopping: false,
  reconnectAttempt: 0,
  pairingCodeGenerated: false,
};

const menuSessions = new Map();
const messageStore = new Map();

// ============================================================
// TEXTOS / CONSTANTES DE MENU
// (antes duplicados dentro de sendMenu() e handleMenuPoll())
// ============================================================
const MENU_OPTIONS = ["📸 Figuras", "👮 Moderação", "🛠️ Utilitários", "ℹ️ Sobre"];

const MENU_RESPONSES = {
  "📸 Figuras": () =>
    `*🖼️ MENU FIGURAS*\n\n${PREFIX}s - Responda uma figurinha para converter em imagem\n${PREFIX}img - Responda uma imagem para converter em figurinha\n${PREFIX}fig - Alias de figurinha`,
  "👮 Moderação": () =>
    `*👮 MENU MODERAÇÃO* (Apenas admins)\n\n${PREFIX}ban @user - Remove um membro\n${PREFIX}promote @user - Promove a administrador\n${PREFIX}demote @user - Remove de administrador`,
  "🛠️ Utilitários": () =>
    `*🛠️ MENU UTILITÁRIOS*\n\n${PREFIX}ping - Verifica se o bot está online\n${PREFIX}uptime - Mostra tempo de atividade\n${PREFIX}info - Informações da mensagem`,
  "ℹ️ Sobre": () =>
    `*ℹ️ SOBRE O BOT*\n\n🤖 SyntraxBot v1.1\nBot de WhatsApp usando Baileys\n👥 Suporte a grupos e privados\n⚡ Comandos: ${PREFIX}menu\n\nPrefix: ${PREFIX}`,
};

const GROUP_ACTION_LABELS = {
  remove: "🗑️ Membro removido do grupo!",
  promote: "⬆️ Usuário promovido a administrador!",
  demote: "⬇️ Administrador rebaixado.",
};

// ============================================================
// UTILITÁRIOS GERAIS
// ============================================================
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
  if (!message?.key?.id) return;
  messageStore.set(message.key.id, message);
  if (messageStore.size > 1000) {
    messageStore.delete(messageStore.keys().next().value);
  }
}

/**
 * Envia uma resposta citando a mensagem original.
 * Centraliza o padrão `sendMessage(jid, content, { quoted: message })`
 * que antes se repetia em quase toda função.
 */
async function reply(jid, message, content) {
  return state.socket.sendMessage(jid, content, { quoted: message });
}

async function replyError(jid, message, error) {
  return reply(jid, message, { text: `❌ Erro: ${error.message}` });
}

// ============================================================
// MENU / ENQUETES
// ============================================================
function getPollUpdate(message) {
  return unwrap(message).pollUpdateMessage || null;
}

function getPollKey(update) {
  const key = update?.pollCreationMessage?.key;
  return key ? `${key.remoteJid}:${key.id}` : "";
}

async function sendMenu(jid, sender) {
  const poll = await state.socket.sendMessage(jid, {
    poll: {
      name: "Menu SyntraxBot",
      values: MENU_OPTIONS,
      selectableCount: 1,
    },
  });

  const response = await state.socket.sendMessage(
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

  const selected = MENU_OPTIONS.find((option) => votes?.[option]?.length > 0);
  if (!selected) return true;

  // Nota: usa session.jid (chat onde a enquete foi criada), não uma
  // variável `jid` solta — ver observação no final da entrega.
  await state.socket.sendMessage(session.jid, {
    text: MENU_RESPONSES[selected](),
    edit: session.responseKey,
  });
  menuSessions.delete(getPollKey(update));
  return true;
}

// ============================================================
// CONVERSÃO DE MÍDIA
// ============================================================
async function downloadAsBuffer(mediaMessage, mediaType) {
  const stream = await downloadContentFromMessage(mediaMessage, mediaType);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function stickerToImage(message, jid) {
  try {
    const sticker = unwrap(message).stickerMessage;
    if (!sticker) {
      await reply(jid, message, { text: `Responda uma figurinha com ${PREFIX}img` });
      return;
    }

    const imageBuffer = await downloadAsBuffer(sticker, "image");
    const image = await sharp(imageBuffer).png().toBuffer();
    await reply(jid, message, { image, caption: "🖼️ Sua imagem" });
  } catch (error) {
    waLogger.error({ err: error }, "Erro ao converter figurinha para imagem");
    await replyError(jid, message, error);
  }
}

async function imageToSticker(message, jid) {
  try {
    const image = unwrap(message).imageMessage;
    if (!image) {
      await reply(jid, message, { text: `Responda uma imagem com ${PREFIX}s` });
      return;
    }

    const imageBuffer = await downloadAsBuffer(image, "image");
    const webp = await sharp(imageBuffer)
      .resize(512, 512, { fit: "cover", withoutEnlargement: false })
      .webp()
      .toBuffer();

    await reply(jid, message, { sticker: webp });
  } catch (error) {
    waLogger.error({ err: error }, "Erro ao converter imagem para figurinha");
    await replyError(jid, message, error);
  }
}

// ============================================================
// COMANDOS DE GRUPO
// ============================================================
async function getGroupInfo(jid, sender) {
  const metadata = await state.socket.groupMetadata(jid);
  const senderParticipant = metadata.participants.find(
    (p) => normalizeJid(p.id) === normalizeJid(sender)
  );
  const botParticipant = metadata.participants.find(
    (p) => normalizeJid(p.id) === normalizeJid(state.socket.user.id)
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
    await reply(jid, message, { text: "Este comando só funciona em grupos." });
    return;
  }

  const group = await getGroupInfo(jid, sender);

  if (!group.isAdmin) {
    await reply(jid, message, { text: "👮 Apenas administradores podem usar este comando." });
    return;
  }

  if (!group.isBotAdmin) {
    await reply(jid, message, { text: "🤖 Eu preciso ser administrador do grupo para isso." });
    return;
  }

  if (!mention || mention.length === 0) {
    await reply(jid, message, { text: `Use: ${PREFIX}${action} @usuario` });
    return;
  }

  try {
    await state.socket.groupParticipantsUpdate(jid, [mention[0] + "@s.whatsapp.net"], action);
    await reply(jid, message, { text: GROUP_ACTION_LABELS[action] || "Ação realizada!" });
  } catch (error) {
    waLogger.error({ err: error, action }, "Erro em comando de grupo");
    await replyError(jid, message, error);
  }
}

// ============================================================
// INFO DA MENSAGEM
// ============================================================
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

    await reply(jid, message, { text: "```\n" + output + "\n```" });
  } catch (error) {
    waLogger.error({ err: error }, "Erro ao gerar info");
    await replyError(jid, message, error);
  }
}

// ============================================================
// EXECUÇÃO DE CÓDIGO (owner only)
// ============================================================
async function executeCode(jid, sender, code, message) {
  if (!ENABLE_EVAL) {
    await reply(jid, message, { text: "⛔ Execução de código está desativada." });
    return;
  }

  if (!isOwner(sender)) {
    await reply(jid, message, { text: "🔐 Apenas o proprietário pode executar código." });
    return;
  }

  if (!code.trim()) {
    await reply(jid, message, { text: `Uso: ${PREFIX}execute <código JavaScript>` });
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
    )(state.socket, jid, sender, message, sleep);

    const output =
      result === undefined
        ? "✅ Executado sem retorno"
        : typeof result === "string"
          ? result
          : JSON.stringify(result, null, 2);

    await reply(jid, message, { text: "```\n" + output.slice(0, 4000) + "\n```" });
  } catch (error) {
    waLogger.error({ err: error }, "Erro ao executar código");
    await reply(jid, message, { text: "```\n" + error.message.slice(0, 500) + "\n```" });
  }
}

// ============================================================
// ROTEAMENTO DE COMANDOS
// (mesmo mapeamento do switch original, agora como tabela)
// ============================================================
const COMMAND_HANDLERS = {
  menu: (ctx) => sendMenu(ctx.jid, ctx.sender),
  help: (ctx) => sendMenu(ctx.jid, ctx.sender),

  ping: (ctx) => reply(ctx.jid, ctx.message, { text: "🏓 Pong!" }),

  uptime: (ctx) => {
    const uptime = Math.floor(process.uptime());
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;
    return reply(ctx.jid, ctx.message, { text: `⏱️ Bot ativo há ${h}h ${m}m ${s}s` });
  },

  info: (ctx) => sendMessageInfo(ctx.jid, ctx.message),

  // ⚠️ mantido idêntico ao original: "s"/"fig" convertem IMAGEM -> figurinha
  s: (ctx) => imageToSticker(ctx.message, ctx.jid),
  sticker: (ctx) => imageToSticker(ctx.message, ctx.jid),
  fig: (ctx) => imageToSticker(ctx.message, ctx.jid),

  // ⚠️ mantido idêntico ao original: "img"/"toimg"/"imagem" convertem figurinha -> IMAGEM
  img: (ctx) => stickerToImage(ctx.message, ctx.jid),
  toimg: (ctx) => stickerToImage(ctx.message, ctx.jid),
  imagem: (ctx) => stickerToImage(ctx.message, ctx.jid),

  ban: (ctx) => handleGroupAction(ctx.jid, ctx.sender, "remove", ctx.args, ctx.message),
  promote: (ctx) => handleGroupAction(ctx.jid, ctx.sender, "promote", ctx.args, ctx.message),
  demote: (ctx) => handleGroupAction(ctx.jid, ctx.sender, "demote", ctx.args, ctx.message),

  execute: (ctx) => executeCode(ctx.jid, ctx.sender, ctx.body, ctx.message),
  exec: (ctx) => executeCode(ctx.jid, ctx.sender, ctx.body, ctx.message),
  eval: (ctx) => executeCode(ctx.jid, ctx.sender, ctx.body, ctx.message),
};

async function handleCommand(message, jid, sender, text) {
  const parts = text.slice(PREFIX.length).trim().split(/\s+/);
  const command = (parts.shift() || "").toLowerCase();
  const args = parts;
  const body = args.join(" ");

  const handler = COMMAND_HANDLERS[command];
  if (!handler) {
    await reply(jid, message, {
      text: `❌ Comando não encontrado. Use ${PREFIX}menu para ver as opções.`,
    });
    return;
  }

  return handler({ jid, sender, message, args, body });
}

// ============================================================
// CONEXÃO
// ============================================================
async function connect() {
  await fs.promises.mkdir(SESSION_DIR, { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const socket = makeWASocket({
    auth: authState,
    browser: Browsers.ubuntu("SyntraxBot"),
    logger: waLogger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });
  state.socket = socket;

  socket.ev.on("creds.update", saveCreds);

  // Controla quando o pairing code pode ser solicitado
  let isSocketReady = false;

  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      isSocketReady = true;
      waLogger.info("🔲 QR Code disponível para scan");
    }

    // Gerar pairing code apenas quando: socket pronto, ainda não gerado,
    // sessão não registrada e PAIRING_NUMBER configurado.
    if (
      isSocketReady &&
      !state.pairingCodeGenerated &&
      !socket.authState.creds.registered &&
      PAIRING_NUMBER
    ) {
      state.pairingCodeGenerated = true;
      try {
        const code = await socket.requestPairingCode(PAIRING_NUMBER);
        waLogger.info({ pairingCode: code }, `🔑 Código de pareamento gerado (${PAIRING_NUMBER})`);
      } catch (error) {
        waLogger.error({ err: error }, "⚠️  Erro ao gerar código de pareamento - continuando...");
        state.pairingCodeGenerated = false;
      }
    }

    if (connection === "open") {
      state.reconnectAttempt = 0;
      waLogger.info(
        { account: socket.user?.id, environment: USE_RENDER_SESSION ? "RENDER" : "LOCAL" },
        "✅ WhatsApp conectado!"
      );
      return;
    }

    if (connection !== "close" || state.stopping) return;

    state.socket = null;
    isSocketReady = false;
    state.pairingCodeGenerated = false;

    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

    if (!shouldReconnect) {
      waLogger.error("Sessão encerrada. Remova a pasta de autenticação para vincular novamente.");
      return;
    }

    state.reconnectAttempt++;
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(state.reconnectAttempt, 5));
    waLogger.warn(
      { statusCode, delay: delayMs, attempt: state.reconnectAttempt },
      "🔄 Reconectando..."
    );
    await sleep(delayMs);
    if (!state.stopping) await connect();
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
        await handleCommand(message, jid, senderOf(message), text);
      } catch (error) {
        waLogger.error({ err: error }, "Erro ao processar comando");
        await reply(jid, message, {
          text: `❌ Erro ao processar comando: ${error.message.slice(0, 100)}`,
        });
      }
    }
  });
}

// ============================================================
// SERVIDOR HTTP (health check)
// ============================================================
const HEALTH_PATHS = new Set(["/", "/health", "/api/healthz"]);

const server = createServer((request, response) => {
  if (HEALTH_PATHS.has(request.url)) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        status: "ok",
        connected: !!state.socket,
        environment: USE_RENDER_SESSION
          ? "RENDER (/tmp/wa_session)"
          : "LOCAL (./data/auth_info_baileys)",
      })
    );
    return;
  }
  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Not found" }));
});

// ============================================================
// ENCERRAMENTO
// ============================================================
async function shutdown(signal) {
  if (state.stopping) return;
  state.stopping = true;
  logger.info({ signal }, "Encerrando processo");
  try {
    state.socket?.end?.(new Error("Encerramento solicitado"));
  } finally {
    server.close(() => process.exit(0));
  }
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================
server.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      sessionDir: SESSION_DIR,
      environment: USE_RENDER_SESSION ? "🚀 RENDER" : "💻 LOCAL",
      pairingNumber: PAIRING_NUMBER ? "Configurado" : "Não configurado",
    },
    "Servidor HTTP iniciado"
  );

  connect().catch((error) => {
    logger.error({ err: error }, "Falha ao iniciar o bot");
    process.exitCode = 1;
  });
});

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
