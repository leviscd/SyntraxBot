import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";

const {
  default: makeWASocket,
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
} = await import("baileys").catch(() => import("@whiskeysockets/baileys"));
import pino from "pino";
import sharp from "sharp";

const PREFIX = process.env.BOT_PREFIX?.trim() || "?";
const PAIRING_NUMBER = digitsOnly(process.env.PAIRING_NUMBER);
const OWNER_JIDS = parseOwnerJids();
const ENABLE_EVAL = process.env.ENABLE_EVAL === "true";
const SESSION_DIR = resolveSessionDir();
const MAX_RECONNECT_DELAY = 30_000;
const startedAt = Date.now();

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const waLogger = logger.child({ component: "whatsapp" });
const messages = new Map();

let running = false;
let stopping = false;
let reconnectAttempts = 0;
let currentSocket = null;

const SUBMENUS = {
  "1": [
    "FIGURINHAS",
    "",
    `• ${PREFIX}sticker — imagem para figurinha`,
    `• ${PREFIX}s — imagem para figurinha`,
    `• ${PREFIX}fig — imagem para figurinha`,
    `• ${PREFIX}img — figurinha para imagem`,
    `• ${PREFIX}toimg — figurinha para imagem`,
  ].join("\n"),
  "2": [
    "ADMINISTRAÇÃO",
    "",
    `• ${PREFIX}ban @usuario`,
    `• ${PREFIX}promote @usuario`,
    `• ${PREFIX}demote @usuario`,
    `• ${PREFIX}everyone mensagem`,
  ].join("\n"),
  "3": [
    "UTILITÁRIOS",
    "",
    `• ${PREFIX}ping`,
    `• ${PREFIX}uptime`,
    `• ${PREFIX}info`,
  ].join("\n"),
  "4": [
    "SOBRE O BOT",
    "",
    "SyntraXBot",
    "Bot de WhatsApp usando Baileys.",
    "",
    `Prefixo: ${PREFIX}`,
  ].join("\n"),
};

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeJid(jid) {
  return String(jid || "")
    .replace(/:\d+(?=@)/, "")
    .trim()
    .toLowerCase();
}

function parseOwnerJids() {
  const values = [
    process.env.OWNER_JID,
    process.env.OWNER_JIDS,
    process.env.OWNER_NUMBER,
    process.env.OWNER_NUMBERS,
  ]
    .filter(Boolean)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return new Set(
    values.map((value) =>
      value.includes("@")
        ? normalizeJid(value)
        : `${digitsOnly(value)}@s.whatsapp.net`,
    ),
  );
}

function resolveSessionDir() {
  if (process.env.SESSION_DIR?.trim()) {
    return path.resolve(process.env.SESSION_DIR.trim());
  }

  if (
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID ||
    fs.existsSync("/data")
  ) {
    return "/data/auth_info_baileys";
  }

  return path.join(process.cwd(), ".data", "auth_info_baileys");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function statusCodeFrom(error) {
  if (!error || typeof error !== "object") return undefined;
  if (
    error.output &&
    typeof error.output === "object" &&
    typeof error.output.statusCode === "number"
  ) {
    return error.output.statusCode;
  }
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function keyFor(key) {
  return `${key.remoteJid || ""}:${key.id || ""}`;
}

function remember(message) {
  if (!message?.key?.id) return;
  messages.set(keyFor(message.key), message);
  if (messages.size > 1000) {
    messages.delete(messages.keys().next().value);
  }
}

function unwrap(message) {
  let content = message?.message;
  while (content) {
    const wrapper =
      content.ephemeralMessage ||
      content.viewOnceMessage ||
      content.viewOnceMessageV2 ||
      content.viewOnceMessageV2Extension ||
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
  );
}

function contextOf(message) {
  const content = unwrap(message);
  return (
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.stickerMessage?.contextInfo ||
    content.documentMessage?.contextInfo
  );
}

function quotedOf(message) {
  const context = contextOf(message);
  if (!context?.quotedMessage) return null;

  return {
    key: {
      remoteJid: message.key.remoteJid || undefined,
      id: context.stanzaId || "",
      fromMe: false,
      ...(context.participant ? { participant: context.participant } : {}),
    },
    message: context.quotedMessage,
  };
}

function mediaMessageOf(message, mediaType) {
  if (unwrap(message)[mediaType]) return message;
  const quoted = quotedOf(message);
  return quoted && unwrap(quoted)[mediaType] ? quoted : null;
}

async function mediaBuffer(socket, message, mediaType) {
  const target = mediaMessageOf(message, mediaType);
  if (!target) return null;

  return downloadMediaMessage(
    target,
    "buffer",
    {},
    {
      logger: waLogger,
      reuploadRequest: (messageToUpdate) =>
        socket.updateMediaMessage(messageToUpdate),
    },
  );
}

function senderOf(message) {
  return message.key.participant || message.key.remoteJid || "";
}

function ownerOf(jid) {
  return OWNER_JIDS.has(normalizeJid(jid));
}

function uptime() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
}

function menu() {
  return [
    "SYNTRAXBOT",
    "",
    "Responda com o número da categoria:",
    "1 - Figurinhas",
    "2 - Administração",
    "3 - Utilitários",
    "4 - Sobre o bot",
    "",
    `Use ${PREFIX}menu para abrir novamente.`,
  ].join("\n");
}

async function send(socket, chatId, text, quoted) {
  await socket.sendMessage(
    chatId,
    { text },
    quoted ? { quoted } : undefined,
  );
}

async function sticker(socket, message, chatId) {
  try {
    const buffer = await mediaBuffer(socket, message, "imageMessage");
    if (!buffer) {
      return send(
        socket,
        chatId,
        `Responda uma imagem com ${PREFIX}sticker.`,
        message,
      );
    }

    const webp = await sharp(buffer)
      .resize(512, 512, { fit: "cover" })
      .webp()
      .toBuffer();
    await socket.sendMessage(chatId, { sticker: webp }, { quoted: message });
  } catch (error) {
    waLogger.error({ err: error }, "Erro ao criar figurinha");
    await send(socket, chatId, `Erro ao criar figurinha: ${describeError(error)}`, message);
  }
}

async function toImage(socket, message, chatId) {
  try {
    const buffer = await mediaBuffer(socket, message, "stickerMessage");
    if (!buffer) {
      return send(
        socket,
        chatId,
        `Responda uma figurinha com ${PREFIX}img.`,
        message,
      );
    }

    const image = await sharp(buffer).png().toBuffer();
    await socket.sendMessage(
      chatId,
      { image, caption: "Aqui está sua imagem." },
      { quoted: message },
    );
  } catch (error) {
    waLogger.error({ err: error }, "Erro ao converter figurinha");
    await send(socket, chatId, `Erro ao converter figurinha: ${describeError(error)}`, message);
  }
}

function admin(participant) {
  return participant?.admin === "admin" || participant?.admin === "superadmin";
}

async function groupData(socket, chatId, senderJid) {
  const metadata = await socket.groupMetadata(chatId);
  const sender = metadata.participants.find(
    (participant) =>
      normalizeJid(participant.id) === normalizeJid(senderJid),
  );
  const bot = metadata.participants.find(
    (participant) =>
      normalizeJid(participant.id) === normalizeJid(socket.user?.id),
  );
  return {
    participants: metadata.participants,
    senderAdmin: admin(sender),
    botAdmin: admin(bot),
  };
}

function targetsOf(message) {
  const context = contextOf(message);
  return [
    ...new Set([
      ...(context?.mentionedJid || []),
      ...(context?.participant ? [context.participant] : []),
    ]),
  ];
}

async function groupAction(socket, message, chatId, senderJid, action, command) {
  if (!chatId.endsWith("@g.us")) {
    return send(socket, chatId, "Esse comando só funciona em grupos.", message);
  }

  try {
    const group = await groupData(socket, chatId, senderJid);
    if (!group.senderAdmin) {
      return send(socket, chatId, "Só administradores podem usar esse comando.", message);
    }
    if (!group.botAdmin) {
      return send(socket, chatId, "Eu preciso ser administrador do grupo.", message);
    }

    const targets = targetsOf(message);
    if (!targets.length) {
      return send(
        socket,
        chatId,
        `Marque alguém ou responda à mensagem da pessoa.\nExemplo: ${PREFIX}${command} @usuario`,
        message,
      );
    }

    await socket.groupParticipantsUpdate(chatId, targets, action);
    const responses = {
      remove: "Membro removido.",
      promote: "Membro promovido a administrador.",
      demote: "Administrador rebaixado.",
    };
    await send(socket, chatId, responses[action], message);
  } catch (error) {
    waLogger.error({ err: error, action }, "Erro em comando de grupo");
    await send(socket, chatId, `Erro no comando: ${describeError(error)}`, message);
  }
}

async function everyone(socket, message, chatId, senderJid, body) {
  if (!chatId.endsWith("@g.us")) {
    return send(socket, chatId, "Esse comando só funciona em grupos.", message);
  }

  try {
    const group = await groupData(socket, chatId, senderJid);
    if (!group.senderAdmin) {
      return send(socket, chatId, "Só administradores podem usar esse comando.", message);
    }
    if (!group.botAdmin) {
      return send(socket, chatId, "Eu preciso ser administrador do grupo.", message);
    }

    await socket.sendMessage(
      chatId,
      {
        text: body.trim() || "Atenção geral!",
        mentions: group.participants.map((participant) => participant.id),
      },
      { quoted: message },
    );
  } catch (error) {
    waLogger.error({ err: error }, "Erro no comando everyone");
    await send(socket, chatId, `Erro no comando: ${describeError(error)}`, message);
  }
}

async function info(socket, message, chatId) {
  const quoted = quotedOf(message);
  if (!quoted) {
    return send(socket, chatId, `Responda uma mensagem com ${PREFIX}info.`, message);
  }

  const result = JSON.stringify(
    {
      remoteJid: message.key.remoteJid,
      quotedMessageId: quoted.key.id,
      quotedParticipant: quoted.key.participant || null,
      quotedMessageContent: quoted.message,
    },
    (_key, value) => {
      if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
        return `<Buffer ${value.length} bytes>`;
      }
      if (typeof value === "bigint") return value.toString();
      return value;
    },
    2,
  );
  await send(socket, chatId, `\`\`\`\n${result.slice(0, 3500)}\n\`\`\``, message);
}

async function execute(socket, message, chatId, senderJid, isGroup, code) {
  if (!ENABLE_EVAL) {
    return send(
      socket,
      chatId,
      "O comando exec está desativado. Defina ENABLE_EVAL=true somente se necessário.",
      message,
    );
  }
  if (isGroup || !ownerOf(senderJid)) return;
  if (!code.trim()) {
    return send(socket, chatId, `Uso: ${PREFIX}exec <código JavaScript>`, message);
  }

  try {
    const run = new Function(
      "sock",
      "client",
      "msg",
      "chatId",
      "jid",
      "senderJid",
      `return (async () => {\n${code}\n})()`,
    );
    const result = await run(socket, socket, message, chatId, chatId, senderJid);
    const output =
      result === undefined
        ? "Executado sem retorno."
        : typeof result === "string"
          ? result
          : JSON.stringify(result, null, 2);
    await send(socket, chatId, output.slice(0, 3500), message);
  } catch (error) {
    waLogger.error({ err: error }, "Erro no exec");
    await send(socket, chatId, `Erro: ${describeError(error)}`, message);
  }
}

async function command(socket, message, chatId, senderJid, text) {
  const parts = text.slice(PREFIX.length).trim().split(/\s+/);
  const name = (parts.shift() || "").toLowerCase();
  const body = parts.join(" ").trim();
  const isGroup = chatId.endsWith("@g.us");

  switch (name) {
    case "menu":
    case "help":
      return send(socket, chatId, menu(), message);
    case "1":
    case "2":
    case "3":
    case "4":
      return send(socket, chatId, SUBMENUS[name], message);
    case "sticker":
    case "s":
    case "fig":
      return sticker(socket, message, chatId);
    case "img":
    case "toimg":
    case "imagem":
      return toImage(socket, message, chatId);
    case "ban":
      return groupAction(socket, message, chatId, senderJid, "remove", "ban");
    case "promote":
      return groupAction(socket, message, chatId, senderJid, "promote", "promote");
    case "demote":
      return groupAction(socket, message, chatId, senderJid, "demote", "demote");
    case "everyone":
    case "all":
      return everyone(socket, message, chatId, senderJid, body);
    case "ping":
      return send(socket, chatId, "Pong.", message);
    case "uptime":
      return send(socket, chatId, `Bot ativo há ${uptime()}.`, message);
    case "info":
      return info(socket, message, chatId);
    case "execute":
    case "exec":
    case "eval":
      return execute(socket, message, chatId, senderJid, isGroup, body);
    default:
      return send(
        socket,
        chatId,
        `Comando não encontrado. Use ${PREFIX}menu para ver as opções.`,
        message,
      );
  }
}

function setupMessages(socket) {
  socket.ev.on("messages.upsert", async ({ messages: incoming, type }) => {
    if (type !== "notify") return;

    for (const message of incoming) {
      remember(message);
      if (
        !message?.message ||
        message.key.fromMe ||
        message.key.remoteJid === "status@broadcast"
      ) {
        continue;
      }

      const chatId = message.key.remoteJid;
      const text = textOf(message).trim();
      if (!chatId || !text.startsWith(PREFIX)) continue;

      try {
        await command(socket, message, chatId, senderOf(message), text);
      } catch (error) {
        waLogger.error({ err: error }, "Erro processando mensagem");
        await send(
          socket,
          chatId,
          `Erro ao processar o comando: ${describeError(error)}`,
          message,
        );
      }
    }
  });
}

async function createSocket() {
  await fs.promises.mkdir(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  if (!state.creds.registered && !PAIRING_NUMBER) {
    throw new Error(
      "PAIRING_NUMBER não configurado. Informe o número internacional somente com dígitos.",
    );
  }

  const socket = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    generateHighQualityLinkPreview: false,
    logger: waLogger,
    getMessage: async (key) => messages.get(keyFor(key))?.message,
  });

  socket.ev.on("creds.update", () => {
    void saveCreds().catch((error) =>
      waLogger.error({ err: error }, "Erro salvando credenciais"),
    );
  });

  return { socket, registered: state.creds.registered, saveCreds };
}

function waitForClose(socket, registered) {
  let pairingRequested = registered;
  let finished = false;

  return new Promise((resolve) => {
    const finish = (result) => {
      if (finished) return;
      finished = true;
      resolve(result);
    };

    socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (
        !pairingRequested &&
        (connection === "connecting" || Boolean(qr))
      ) {
        pairingRequested = true;
        void (async () => {
          try {
            await wait(500);
            const code = await socket.requestPairingCode(PAIRING_NUMBER);
            waLogger.info(
              {
                code,
                number: `${PAIRING_NUMBER.slice(0, 3)}***${PAIRING_NUMBER.slice(-2)}`,
              },
              "Pairing code gerado",
            );
          } catch (error) {
            pairingRequested = false;
            waLogger.error({ err: error }, "Erro solicitando pairing code");
          }
        })();
      }

      if (connection === "open") {
        reconnectAttempts = 0;
        waLogger.info({ account: socket.user?.id }, "WhatsApp conectado");
        return;
      }

      if (connection !== "close") return;

      const statusCode = statusCodeFrom(lastDisconnect?.error);
      waLogger.warn(
        { statusCode, error: describeError(lastDisconnect?.error) },
        "Conexão encerrada",
      );

      if (statusCode === DisconnectReason.connectionReplaced) {
        return finish({ reconnect: false, wipe: false });
      }
      if (statusCode === DisconnectReason.loggedOut) {
        return finish({ reconnect: true, wipe: true });
      }
      return finish({
        reconnect: true,
        wipe: statusCode === DisconnectReason.badSession,
      });
    });
  });
}

function nextReconnectDelay() {
  reconnectAttempts += 1;
  return Math.min(1000 * 2 ** Math.min(reconnectAttempts, 5), MAX_RECONNECT_DELAY) +
    Math.floor(Math.random() * 500);
}

async function removeSession() {
  await fs.promises.rm(SESSION_DIR, { recursive: true, force: true });
  waLogger.warn({ sessionDir: SESSION_DIR }, "Sessão apagada");
}

async function startBot() {
  if (running) return;
  running = true;
  stopping = false;

  waLogger.info(
    {
      sessionDir: SESSION_DIR,
      prefix: PREFIX,
      ownerConfigured: OWNER_JIDS.size > 0,
      evalEnabled: ENABLE_EVAL,
    },
    "Iniciando SyntraXBot",
  );

  try {
    while (!stopping) {
      try {
        const { socket, registered, saveCreds } = await createSocket();
        currentSocket = socket;
        setupMessages(socket);
        const result = await waitForClose(socket, registered);
        await saveCreds().catch((error) =>
          waLogger.error({ err: error }, "Erro salvando sessão"),
        );
        currentSocket = null;

        if (result.wipe) await removeSession();
        if (!result.reconnect || stopping) break;

        const delay = nextReconnectDelay();
        waLogger.info({ delayMs: delay }, "Reconectando depois da espera");
        await wait(delay);
      } catch (error) {
        currentSocket = null;
        waLogger.error({ err: error }, "Erro no controlador do bot");
        if (describeError(error).includes("PAIRING_NUMBER não configurado")) break;
        await wait(nextReconnectDelay());
      }
    }
  } finally {
    currentSocket = null;
    running = false;
    waLogger.info("SyntraXBot encerrado");
  }
}

function stopBot() {
  stopping = true;
  currentSocket?.end(new Error("Encerramento solicitado"));
}

const port = Number(process.env.PORT || 8080);
const server = createServer((request, response) => {
  if (
    request.url === "/api/healthz" ||
    request.url === "/healthz" ||
    request.url === "/"
  ) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, () => {
  logger.info({ port }, "Servidor HTTP iniciado");
  void startBot();
});

function shutdown(signal) {
  logger.info({ signal }, "Encerrando processo");
  stopBot();
  server.close(() => process.exit(0));
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));