import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

const prefix = process.env.BOT_PREFIX?.trim() || "?";
const pairingNumber = String(process.env.PAIRING_NUMBER || "").replace(/\D/g, "");
const sessionDir = process.env.SESSION_DIR?.trim()
  ? path.resolve(process.env.SESSION_DIR.trim())
  : path.join(process.cwd(), "data", "auth_info_baileys");
const port = Number(process.env.PORT) || 8080;
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

let socket;
let stopping = false;
let reconnectAttempt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textOf(message) {
  const content = message?.message;
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.buttonsResponseMessage?.selectedButtonId ||
    content?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  ).trim();
}

async function sendText(jid, text, quoted) {
  if (!socket) return;
  await socket.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
}

async function connect() {
  await fs.promises.mkdir(sessionDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  socket = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    logger: logger.child({ component: "whatsapp" }),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      reconnectAttempt = 0;
      logger.info("WhatsApp conectado");
      return;
    }

    if (connection !== "close" || stopping) return;
    socket = undefined;
    const status = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect = status !== DisconnectReason.loggedOut;

    if (!shouldReconnect) {
      logger.error("Sessão encerrada. Remova a pasta de autenticação para vincular novamente.");
      return;
    }

    reconnectAttempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
    logger.warn({ status, delay }, "Conexão encerrada; reconectando");
    await sleep(delay);
    if (!stopping) await connect();
  });

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages) {
      if (!message?.message || message.key.fromMe) continue;
      const body = textOf(message);
      if (!body.startsWith(prefix)) continue;

      const [command, ...args] = body.slice(prefix.length).trim().split(/\s+/);
      const jid = message.key.remoteJid;
      if (!command || !jid) continue;

      try {
        switch (command.toLowerCase()) {
          case "menu":
          case "help":
            await sendText(
              jid,
              `*SyntraxBot*\n\n${prefix}ping - Verifica se o bot está online\n${prefix}info - Mostra informações da mensagem\n${prefix}menu - Exibe este menu`,
              message,
            );
            break;
          case "ping":
            await sendText(jid, "Pong!", message);
            break;
          case "info":
            await sendText(
              jid,
              JSON.stringify({ chat: jid, id: message.key.id, args }, null, 2),
              message,
            );
            break;
          default:
            await sendText(jid, `Comando não encontrado. Use ${prefix}menu.`, message);
        }
      } catch (error) {
        logger.error({ err: error }, "Erro ao processar mensagem");
      }
    }
  });

  if (!state.creds.registered && pairingNumber) {
    await sleep(1_000);
    const code = await socket.requestPairingCode(pairingNumber);
    logger.info({ pairingCode: code }, "Código de pareamento gerado");
  }
}

const server = createServer((request, response) => {
  if (["/", "/health", "/api/health"].includes(request.url)) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: "ok", connected: Boolean(socket) }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Not found" }));
});

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Encerrando processo");
  try {
    socket?.end(new Error("Encerramento solicitado"));
  } finally {
    server.close(() => process.exit(0));
  }
}

server.listen(port, () => {
  logger.info({ port, sessionDir }, "Servidor HTTP iniciado");
  connect().catch((error) => {
    logger.error({ err: error }, "Falha ao iniciar o bot");
    process.exitCode = 1;
  });
});

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
