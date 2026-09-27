/**
 * ============================================================
 *  BASE DE BOT WHATSAPP - BAILEYS
 * ============================================================
 * Funcionalidades incluídas:
 *  - Conexão via Pairing Code (sem QR Code)
 *  - Sessão persistente (não precisa reconectar/reparear toda hora)
 *  - ?menu       -> Envia uma ENQUETE (poll) nativa do WhatsApp.
 *                   Só o usuário que pediu o menu tem o voto lido;
 *                   votos de outras pessoas na mesma enquete são ignorados.
 *                   Ao votar, a mensagem enviada logo abaixo da enquete
 *                   é EDITADA com o conteúdo do submenu escolhido.
 *  - ?sticker / ?s / ?fig  -> Converte imagem em figurinha (esticada, 512x512)
 *  - ?img / ?toimg         -> Converte figurinha em imagem
 *  - ?ban @usuario         -> Remove um membro do grupo (admin only)
 *  - ?ping                 -> Teste rápido
 *
 * IMPORTANTE - LEIA ANTES DE HOSPEDAR:
 *  Este bot precisa de um PROCESSO NODE RODANDO CONTINUAMENTE (long-running)
 *  e de um DISCO PERSISTENTE para a pasta de sessão (SESSION_DIR).
 *  A Vercel (serverless) encerra funções após cada execução e não mantém
 *  disco entre deploys/instâncias, então NÃO é compatível com este bot -
 *  a conexão cairia e a sessão salva seria perdida constantemente.
 *  Use uma VPS, Railway, Render (Web Service), Fly.io ou um PM2 local.
 *
 * INSTALAÇÃO:
 *  npm install
 *  node index.js
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

const PHONE_NUMBER = '5562996664760' // número que vai receber o pairing code (com DDI, só números)
const PREFIX = '?'
const SESSION_DIR = 'auth_info_baileys' // pasta onde a sessão fica salva (precisa ser persistente no host!)

const logger = pino({ level: 'silent' }) // mude pra 'info' se quiser ver os logs internos do baileys

// ============================================================
// ESTADO EM MEMÓRIA
// ============================================================

// Guarda os menus (enquetes) ativos.
// Chave: id da mensagem da enquete | Valor: { owner, chatId, placeholderKey, pollMsg }
const activeMenus = new Map()

let pairingCodeRequested = false

// ============================================================
// CONTEÚDO DO MENU
// ============================================================

const MENU_OPTIONS = ['🎨 Figurinhas', '🛡️ Administração', 'ℹ️ Sobre o Bot']

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

// Remove o sufixo ":device" do jid pra poder comparar dois jids do mesmo usuário
function normalizeJid(jid = '') {
  return jid.replace(/:\d+(?=@)/, '')
}

// Extrai o texto de qualquer tipo comum de mensagem (texto puro, resposta, legenda de mídia...)
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

// Busca o buffer de mídia direto da mensagem OU de uma mensagem citada (respondida)
async function getMediaBuffer(sock, msg, mediaType) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo
  const quotedMessage = contextInfo?.quotedMessage

  let targetMsg = null

  if (quotedMessage && quotedMessage[mediaType]) {
    // Monta uma mensagem "falsa" só com os dados necessários pra baixar a mídia citada
    targetMsg = {
      key: {
        remoteJid: msg.key.remoteJid,
        id: contextInfo.stanzaId,
        participant: contextInfo.participant,
        fromMe: false
      },
      message: quotedMessage
    }
  } else if (msg.message?.[mediaType]) {
    targetMsg = msg
  }

  if (!targetMsg) return null

  const buffer = await downloadMediaMessage(
    targetMsg,
    'buffer',
    {},
    { logger, reuploadRequest: sock.updateMediaMessage }
  )

  return buffer
}

// ============================================================
// COMANDO: ?menu
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
    { quoted: msg }
  )

  const placeholder = await sock.sendMessage(chatId, {
    text: '🕒 Aguardando sua escolha no menu acima...'
  })

  activeMenus.set(pollMsg.key.id, {
    owner: senderJid, // só o voto desse jid vai ser considerado
    chatId,
    placeholderKey: placeholder.key,
    pollMsg
  })
}

// Chamado sempre que chega uma atualização de voto de qualquer enquete
async function handlePollUpdate(sock, key, update) {
  const session = activeMenus.get(key.id)
  if (!session) return // não é uma enquete de menu que estamos rastreando

  try {
    const results = await getAggregateVotesInPollMessage({
      message: session.pollMsg.message,
      pollUpdates: update.pollUpdates
    })

    // Procura a opção que o DONO do menu votou. Votos de qualquer outra
    // pessoa na mesma enquete são simplesmente ignorados aqui.
    const ownerNormalized = normalizeJid(session.owner)
    const chosen = results.find((option) =>
      option.voters.some((voter) => normalizeJid(voter) === ownerNormalized)
    )

    if (!chosen) return // o dono ainda não votou (ou só outras pessoas votaram)

    const content = SUBMENUS[chosen.name] || '❓ Opção inválida.'

    await sock.sendMessage(session.chatId, {
      text: content,
      edit: session.placeholderKey
    })
  } catch (err) {
    console.error('Erro ao processar voto da enquete:', err)
  }
}

// ============================================================
// COMANDO: ?sticker / ?s / ?fig  (imagem -> figurinha esticada)
// ============================================================

async function handleStickerCreate(sock, msg, chatId) {
  const buffer = await getMediaBuffer(sock, msg, 'imageMessage')

  if (!buffer) {
    await sock.sendMessage(
      chatId,
      { text: `❌ Responda a uma imagem com *${PREFIX}sticker*, ou envie a imagem com essa legenda.` },
      { quoted: msg }
    )
    return
  }

  // fit: 'fill' estica a imagem pra caber exatamente em 512x512, sem manter a proporção original
  const webpBuffer = await sharp(buffer)
    .resize(512, 512, { fit: 'fill' })
    .webp()
    .toBuffer()

  await sock.sendMessage(chatId, { sticker: webpBuffer }, { quoted: msg })
}

// ============================================================
// COMANDO: ?img / ?toimg  (figurinha -> imagem)
// ============================================================

async function handleStickerToImage(sock, msg, chatId) {
  const buffer = await getMediaBuffer(sock, msg, 'stickerMessage')

  if (!buffer) {
    await sock.sendMessage(
      chatId,
      { text: `❌ Responda a uma figurinha com *${PREFIX}img*.` },
      { quoted: msg }
    )
    return
  }

  const pngBuffer = await sharp(buffer).png().toBuffer()

  await sock.sendMessage(
    chatId,
    { image: pngBuffer, caption: '✅ Aqui está sua imagem!' },
    { quoted: msg }
  )
}

// ============================================================
// COMANDO: ?ban @usuario
// ============================================================

async function handleBan(sock, msg, chatId, senderJid, isGroup) {
  if (!isGroup) {
    await sock.sendMessage(chatId, { text: '❌ Esse comando só funciona em grupos.' }, { quoted: msg })
    return
  }

  const groupMeta = await sock.groupMetadata(chatId)
  const participants = groupMeta.participants

  const senderData = participants.find((p) => normalizeJid(p.id) === normalizeJid(senderJid))
  if (!senderData?.admin) {
    await sock.sendMessage(chatId, { text: '❌ Só administradores podem usar esse comando.' }, { quoted: msg })
    return
  }

  const botJid = normalizeJid(sock.user.id)
  const botData = participants.find((p) => normalizeJid(p.id) === botJid)
  if (!botData?.admin) {
    await sock.sendMessage(
      chatId,
      { text: '❌ Preciso ser administrador do grupo para remover membros.' },
      { quoted: msg }
    )
    return
  }

  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid

  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(
      chatId,
      { text: `❌ Marque quem você quer remover. Ex: *${PREFIX}ban @usuario*` },
      { quoted: msg }
    )
    return
  }

  await sock.groupParticipantsUpdate(chatId, mentioned, 'remove')
  await sock.sendMessage(chatId, { text: '✅ Membro removido com sucesso!' })
}

// ============================================================
// CONEXÃO COM O WHATSAPP
// ============================================================

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false
  })

  sock.ev.on('creds.update', saveCreds)

  // ------------------------------------------------------------
  // Pairing code (login sem QR)
  // ------------------------------------------------------------
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr && !sock.authState.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true
      try {
        await delay(2000) // dá um tempinho pro socket ficar pronto pra pedir o código
        const code = await sock.requestPairingCode(PHONE_NUMBER)
        console.log('\n========================================')
        console.log('📱 CÓDIGO DE PAREAMENTO:', code)
        console.log('Abra o WhatsApp > Dispositivos conectados > Conectar com número de telefone')
        console.log('e digite esse código (ele expira em pouco tempo).')
        console.log('========================================\n')
      } catch (err) {
        console.error('Erro ao solicitar o código de pareamento:', err)
        pairingCodeRequested = false
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : null

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      console.log('Conexão fechada.', shouldReconnect ? 'Reconectando...' : 'Sessão encerrada (logout).')

      if (shouldReconnect) {
        pairingCodeRequested = false
        startBot()
      }
    } else if (connection === 'open') {
      console.log('✅ Bot conectado com sucesso!')
    }
  })

  // ------------------------------------------------------------
  // Votos de enquete (usados pelo ?menu)
  // ------------------------------------------------------------
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (update.pollUpdates) {
        await handlePollUpdate(sock, key, update)
      }
    }
  })

  // ------------------------------------------------------------
  // Mensagens recebidas -> comandos
  // ------------------------------------------------------------
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0]
      if (!msg.message) return
      if (msg.key.fromMe) return // ignora mensagens enviadas pelo próprio bot
      if (msg.key.remoteJid === 'status@broadcast') return

      const chatId = msg.key.remoteJid
      const isGroup = chatId.endsWith('@g.us')
      const senderJid = isGroup ? msg.key.participant : chatId

      const text = getMessageText(msg).trim()
      if (!text.startsWith(PREFIX)) return

      const [rawCommand, ...args] = text.slice(PREFIX.length).trim().split(/\s+/)
      const command = (rawCommand || '').toLowerCase()

      switch (command) {
        case 'menu':
        case 'help':
          await sendMenu(sock, msg, chatId, senderJid)
          break

        case 'sticker':
        case 's':
        case 'fig':
          await handleStickerCreate(sock, msg, chatId)
          break

        case 'img':
        case 'toimg':
        case 'imagem':
          await handleStickerToImage(sock, msg, chatId)
          break

        case 'ban':
          await handleBan(sock, msg, chatId, senderJid, isGroup)
          break

        case 'ping':
          await sock.sendMessage(chatId, { text: 'Pong! 🏓' }, { quoted: msg })
          break

        default:
          // comando desconhecido - fica em silêncio de propósito
          break
      }
    } catch (err) {
      console.error('Erro ao processar mensagem:', err)
    }
  })

  return sock
}

startBot()

process.on('uncaughtException', (err) => console.error('Erro não tratado:', err))
process.on('unhandledRejection', (err) => console.error('Promise rejeitada:', err))
