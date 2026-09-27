/**
 * ============================================================
 * BASE DE BOT WHATSAPP - BAILEYS
 * ============================================================
 *
 * Funcionalidades:
 *  - Pairing Code
 *  - Sessão persistente
 *  - ?menu / ?help
 *  - Poll nativa
 *  - ?sticker / ?s / ?fig
 *  - ?img / ?toimg / ?imagem
 *  - ?ban @usuario
 *  - ?ping
 *  - Reconexão controlada
 *
 * IMPORTANTE:
 * O processo precisa ficar rodando continuamente.
 * Use VPS, Railway, Render Web Service, Fly.io, PM2 etc.
 *
 * INSTALAÇÃO:
 * npm install
 * node index.js
 * ============================================================
 */
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  getAggregateVotesInPollMessage
} = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const pino = require('pino')
const sharp = require('sharp')
// ============================================================
// CONFIGURAÇÕES
// ============================================================
const PHONE_NUMBER = '5562996664760'
const PREFIX = '?'
const SESSION_DIR = 'auth_info_baileys'
const logger = pino({
  level: 'silent'
})
// ============================================================
// ESTADO
// ============================================================
const activeMenus = new Map()
let pairingCodeRequested = false
let reconnectAttempts = 0
const MAX_RECONNECT_DELAY_MS = 30000
// Impede que duas instâncias do controlador sejam iniciadas.
let botControllerRunning = false
// ============================================================
// MENU
// ============================================================
const MENU_OPTIONS = [
  '🎨 Figurinhas',
  '🛡️ Administração',
  'ℹ️ Sobre o Bot'
]
const SUBMENUS = {
  '🎨 Figurinhas':
    '🎨 *FIGURINHAS*\n\n' +
    `• ${PREFIX}sticker (ou ${PREFIX}s) - responda uma imagem com esse comando para virar figurinha\n` +
    `• ${PREFIX}img (ou ${PREFIX}toimg) - responda uma figurinha com esse comando para virar imagem`,
  '🛡️ Administração':
    '🛡️ *ADMINISTRAÇÃO*\n\n' +
    `• ${PREFIX}ban @usuario - remove um membro do grupo (você e o bot precisam ser admins)`,
  'ℹ️ Sobre o Bot':
    'ℹ️ *SOBRE*\n\n' +
    'Bot base criado com Baileys.\n' +
    `Prefixo dos comandos: *${PREFIX}*\n` +
    `Digite *${PREFIX}menu* a qualquer momento para abrir esse menu de novo.`
}
// ============================================================
// HELPERS
// ============================================================
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
function normalizeJid(jid = '') {
  return jid.replace(/:\d+(?=@)/, '')
}
function getMessageText(msg) {
  const m = msg.message
  if (!m) return ''
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  )
}
// ============================================================
// DOWNLOAD DE MÍDIA
// ============================================================
async function getMediaBuffer(sock, msg, mediaType) {
  const contextInfo =
    msg.message?.extendedTextMessage?.contextInfo
  const quotedMessage = contextInfo?.quotedMessage
  let targetMsg = null
  // Mensagem respondida
  if (quotedMessage && quotedMessage[mediaType]) {
    targetMsg = {
      key: {
        remoteJid: msg.key.remoteJid,
        id: contextInfo.stanzaId,
        participant: contextInfo.participant,
        fromMe: false
      },
      message: quotedMessage
    }
  }
  // Mídia enviada diretamente
  else if (msg.message?.[mediaType]) {
    targetMsg = msg
  }
  if (!targetMsg) {
    return null
  }
  const buffer = await downloadMediaMessage(
    targetMsg,
    'buffer',
    {},
    {
      logger,
      reuploadRequest: sock.updateMediaMessage
    }
  )
  return buffer
}
// ============================================================
// ?MENU
// ============================================================
async function sendMenu(sock, msg, chatId, senderJid) {
  const pollMsg = await sock.sendMessage(
    chatId,
    {
      poll: {
        name: '📋 MENU PRINCIPAL - Escolha uma categoria:',
        values: MENU_OPTIONS,
        selectableCount: 1
      }
    },
    {
      quoted: msg
    }
  )
  const placeholder = await sock.sendMessage(chatId, {
    text: '🕒 Aguardando sua escolha no menu acima...'
  })
  activeMenus.set(pollMsg.key.id, {
    owner: senderJid,
    chatId,
    placeholderKey: placeholder.key,
    pollMsg
  })
}
// ============================================================
// POLL
// ============================================================
async function handlePollUpdate(sock, key, update) {
  const session = activeMenus.get(key.id)
  if (!session) {
    return
  }
  try {
    const results =
      await getAggregateVotesInPollMessage({
        message: session.pollMsg.message,
        pollUpdates: update.pollUpdates
      })
    const ownerNormalized =
      normalizeJid(session.owner)
    const chosen = results.find((option) =>
      option.voters?.some(
        (voter) =>
          normalizeJid(voter) === ownerNormalized
      )
    )
    if (!chosen) {
      return
    }
    const content =
      SUBMENUS[chosen.name] ||
      '❓ Opção inválida.'
    await sock.sendMessage(
      session.chatId,
      {
        text: content,
        edit: session.placeholderKey
      }
    )
    // Depois que o dono escolheu, não precisamos mais
    // continuar mantendo essa enquete na memória.
    activeMenus.delete(key.id)
  } catch (err) {
    console.error(
      'Erro ao processar voto da enquete:',
      err
    )
  }
}
// ============================================================
// ?STICKER
// ============================================================
async function handleStickerCreate(
  sock,
  msg,
  chatId
) {
  try {
    const buffer = await getMediaBuffer(
      sock,
      msg,
      'imageMessage'
    )
    if (!buffer) {
      await sock.sendMessage(
        chatId,
        {
          text:
            `❌ Responda a uma imagem com *${PREFIX}sticker*, ` +
            `ou envie a imagem com essa legenda.`
        },
        {
          quoted: msg
        }
      )
      return
    }
    const webpBuffer = await sharp(buffer)
      .resize(512, 512, {
        fit: 'fill'
      })
      .webp()
      .toBuffer()
    await sock.sendMessage(
      chatId,
      {
        sticker: webpBuffer
      },
      {
        quoted: msg
      }
    )
  } catch (err) {
    console.error(
      'Erro ao criar figurinha:',
      err
    )
    await sock.sendMessage(
      chatId,
      {
        text: '❌ Não consegui transformar essa imagem em figurinha.'
      },
      {
        quoted: msg
      }
    )
  }
}
// ============================================================
// ?IMG
// ============================================================
async function handleStickerToImage(
  sock,
  msg,
  chatId
) {
  try {
    const buffer = await getMediaBuffer(
      sock,
      msg,
      'stickerMessage'
    )
    if (!buffer) {
      await sock.sendMessage(
        chatId,
        {
          text:
            `❌ Responda a uma figurinha com *${PREFIX}img*.`
        },
        {
          quoted: msg
        }
      )
      return
    }
    const pngBuffer = await sharp(buffer)
      .png()
      .toBuffer()
    await sock.sendMessage(
      chatId,
      {
        image: pngBuffer,
        caption: '✅ Aqui está sua imagem!'
      },
      {
        quoted: msg
      }
    )
  } catch (err) {
    console.error(
      'Erro ao converter figurinha:',
      err
    )
    await sock.sendMessage(
      chatId,
      {
        text: '❌ Não consegui converter essa figurinha.'
      },
      {
        quoted: msg
      }
    )
  }
}
// ============================================================
// ?BAN
// ============================================================
async function handleBan(
  sock,
  msg,
  chatId,
  senderJid,
  isGroup
) {
  if (!isGroup) {
    await sock.sendMessage(
      chatId,
      {
        text: '❌ Esse comando só funciona em grupos.'
      },
      {
        quoted: msg
      }
    )
    return
  }
  try {
    const groupMeta =
      await sock.groupMetadata(chatId)
    const participants =
      groupMeta.participants
    const senderData =
      participants.find(
        (p) =>
          normalizeJid(p.id) ===
          normalizeJid(senderJid)
      )
    if (!senderData?.admin) {
      await sock.sendMessage(
        chatId,
        {
          text:
            '❌ Só administradores podem usar esse comando.'
        },
        {
          quoted: msg
        }
      )
      return
    }
    const botJid =
      normalizeJid(sock.user.id)
    const botData =
      participants.find(
        (p) =>
          normalizeJid(p.id) === botJid
      )
    if (!botData?.admin) {
      await sock.sendMessage(
        chatId,
        {
          text:
            '❌ Preciso ser administrador do grupo para remover membros.'
        },
        {
          quoted: msg
        }
      )
      return
    }
    const mentioned =
      msg.message
        ?.extendedTextMessage
        ?.contextInfo
        ?.mentionedJid
    if (!mentioned?.length) {
      await sock.sendMessage(
        chatId,
        {
          text:
            `❌ Marque quem você quer remover.\n\n` +
            `Ex: *${PREFIX}ban @usuario*`
        },
        {
          quoted: msg
        }
      )
      return
    }
    await sock.groupParticipantsUpdate(
      chatId,
      mentioned,
      'remove'
    )
    await sock.sendMessage(
      chatId,
      {
        text: '✅ Membro removido com sucesso!'
      }
    )
  } catch (err) {
    console.error(
      'Erro ao executar ban:',
      err
    )
    await sock.sendMessage(
      chatId,
      {
        text:
          '❌ Não consegui remover o membro.'
      },
      {
        quoted: msg
      }
    )
  }
}
// ============================================================
// CRIAÇÃO DO SOCKET
// ============================================================
async function createSocket() {
  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(
    SESSION_DIR
  )
  const {
    version
  } = await fetchLatestBaileysVersion()
  console.log(
    `🔌 Iniciando Baileys ${version.join('.')}`
  )
  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser:
      Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false
  })
  sock.ev.on(
    'creds.update',
    saveCreds
  )
  return sock
}
// ============================================================
// PAIRING CODE
// ============================================================
async function requestPairingCode(sock) {
  if (
    sock.authState.creds.registered ||
    pairingCodeRequested
  ) {
    return
  }
  pairingCodeRequested = true
  try {
    // Pequeno atraso para garantir que o socket
    // esteja pronto.
    await delay(2000)
    const code =
      await sock.requestPairingCode(
        PHONE_NUMBER
      )
    console.log('')
    console.log(
      '========================================'
    )
    console.log(
      '📱 CÓDIGO DE PAREAMENTO:',
      code
    )
    console.log(
      'Abra o WhatsApp > Dispositivos conectados'
    )
    console.log(
      '> Conectar com número de telefone'
    )
    console.log(
      'e digite esse código.'
    )
    console.log(
      '========================================'
    )
    console.log('')
  } catch (err) {
    console.error(
      '❌ Erro ao solicitar pairing code:',
      err
    )
    pairingCodeRequested = false
  }
}
// ============================================================
// EVENTOS DO SOCKET
// ============================================================
function setupSocketEvents(sock) {
  let connectionClosed = false
  const connectionClosedPromise =
    new Promise((resolve) => {
      sock.ev.on(
        'connection.update',
        async (update) => {
          const {
            connection,
            lastDisconnect
          } = update
          // --------------------------------------------------
          // Conexão aberta
          // --------------------------------------------------
          if (connection === 'open') {
            console.log(
              '✅ Bot conectado com sucesso!'
            )
            reconnectAttempts = 0
            pairingCodeRequested = false
          }
          // --------------------------------------------------
          // QR / Pairing
          // --------------------------------------------------
          if (
            update.qr &&
            !sock.authState.creds.registered
          ) {
            await requestPairingCode(sock)
          }
          // --------------------------------------------------
          // Conexão fechada
          // --------------------------------------------------
          if (
            connection === 'close' &&
            !connectionClosed
          ) {
            connectionClosed = true
            const statusCode =
              lastDisconnect?.error instanceof Boom
                ? lastDisconnect.error.output.statusCode
                : null
            const reason =
              lastDisconnect?.error?.message ||
              'sem detalhes'
            console.log(
              `❌ Conexão fechada. ` +
              `Código: ${statusCode ?? 'desconhecido'} | ` +
              `Motivo: ${reason}`
            )
            const permanentDisconnects = [
              DisconnectReason.loggedOut,
              DisconnectReason.badSession,
              DisconnectReason.connectionReplaced
            ]
            const shouldStop =
              permanentDisconnects.includes(
                statusCode
              )
            resolve({
              shouldReconnect:
                !shouldStop,
              statusCode
            })
          }
        }
      )
    })
  // ------------------------------------------------------------
  // POLLS
  // ------------------------------------------------------------
  sock.ev.on(
    'messages.update',
    async (updates) => {
      for (
        const { key, update }
        of updates
      ) {
        if (update.pollUpdates) {
          await handlePollUpdate(
            sock,
            key,
            update
          )
        }
      }
    }
  )
  // ------------------------------------------------------------
  // MENSAGENS
  // ------------------------------------------------------------
  sock.ev.on(
    'messages.upsert',
    async ({ messages }) => {
      try {
        const msg = messages[0]
        if (!msg?.message) {
          return
        }
        if (msg.key.fromMe) {
          return
        }
        if (
          msg.key.remoteJid ===
          'status@broadcast'
        ) {
          return
        }
        const chatId =
          msg.key.remoteJid
        const isGroup =
          chatId.endsWith('@g.us')
        const senderJid =
          isGroup
            ? msg.key.participant
            : chatId
        const text =
          getMessageText(msg).trim()
        if (!text.startsWith(PREFIX)) {
          return
        }
        const [
          rawCommand,
          ...args
        ] =
          text
            .slice(PREFIX.length)
            .trim()
            .split(/\s+/)
        const command =
          (rawCommand || '').toLowerCase()
        switch (command) {
          case 'menu':
          case 'help':
            await sendMenu(
              sock,
              msg,
              chatId,
              senderJid
            )
            break
          case 'sticker':
          case 's':
          case 'fig':
            await handleStickerCreate(
              sock,
              msg,
              chatId
            )
            break
          case 'img':
          case 'toimg':
          case 'imagem':
            await handleStickerToImage(
              sock,
              msg,
              chatId
            )
            break
          case 'ban':
            await handleBan(
              sock,
              msg,
              chatId,
              senderJid,
              isGroup
            )
            break
          case 'ping':
            await sock.sendMessage(
              chatId,
              {
                text: 'Pong! 🏓'
              },
              {
                quoted: msg
              }
            )
            break
          default:
            // Silêncio proposital.
            break
        }
      } catch (err) {
        console.error(
          '❌ Erro ao processar mensagem:',
          err
        )
      }
    }
  )
  return connectionClosedPromise
}
// ============================================================
// CONTROLADOR PRINCIPAL
// ============================================================
async function startBot() {
  // Impede múltiplos controladores.
  if (botControllerRunning) {
    console.log(
      '⚠️ O controlador do bot já está rodando.'
    )
    return
  }
  botControllerRunning = true
  console.log(
    '🚀 Iniciando controlador do bot...'
  )
  while (true) {
    try {
      const sock =
        await createSocket()
      const result =
        await setupSocketEvents(sock)
      // ------------------------------------------------------
      // Não reconectar em casos permanentes
      // ------------------------------------------------------
      if (!result.shouldReconnect) {
        console.log('')
        if (
          result.statusCode ===
          DisconnectReason.loggedOut
        ) {
          console.log(
            `❌ Sessão desconectada pelo WhatsApp.`
          )
          console.log(
            `Apague "${SESSION_DIR}" e faça o pairing novamente.`
          )
        }
        else if (
          result.statusCode ===
          DisconnectReason.badSession
        ) {
          console.log(
            `❌ Sessão corrompida.`
          )
          console.log(
            `Apague "${SESSION_DIR}" e faça o pairing novamente.`
          )
        }
        else if (
          result.statusCode ===
          DisconnectReason.connectionReplaced
        ) {
          console.log(
            '❌ Essa sessão foi aberta em outra instância.'
          )
          console.log(
            'Verifique se existe outro processo usando a mesma sessão.'
          )
        }
        break
      }
      // ------------------------------------------------------
      // Reconexão
      // ------------------------------------------------------
      reconnectAttempts++
      const waitMs =
        Math.min(
          1000 *
            2 ** reconnectAttempts,
          MAX_RECONNECT_DELAY_MS
        )
      console.log(
        `🔄 Reconectando em ` +
        `${Math.round(waitMs / 1000)}s...`
      )
      await delay(waitMs)
      // Permite pedir pairing novamente caso
      // ainda não esteja registrado.
      pairingCodeRequested = false
    } catch (err) {
      console.error(
        '❌ Erro no controlador:',
        err
      )
      reconnectAttempts++
      const waitMs =
        Math.min(
          1000 *
            2 ** reconnectAttempts,
          MAX_RECONNECT_DELAY_MS
        )
      console.log(
        `🔄 Tentando novamente em ` +
        `${Math.round(waitMs / 1000)}s...`
      )
      await delay(waitMs)
      pairingCodeRequested = false
    }
  }
  botControllerRunning = false
  console.log(
    '🛑 Controlador do bot encerrado.'
  )
}
// ============================================================
// ERROS GLOBAIS
// ============================================================
process.on(
  'uncaughtException',
  (err) => {
    console.error(
      '💥 Erro não tratado:',
      err
    )
  }
)
process.on(
  'unhandledRejection',
  (err) => {
    console.error(
      '💥 Promise rejeitada:',
      err
    )
  }
)
// ============================================================
// START
// ============================================================
startBot()
