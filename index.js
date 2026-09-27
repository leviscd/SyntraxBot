/**
 * ============================================================
 *  BASE DE BOT WHATSAPP - BAILEYS
 * ============================================================
 *
 * Funcionalidades:
 *  - Pairing Code (sem QR Code)
 *  - Sessão persistente
 *  - ?menu / ?help          -> enquete nativa; só o voto de quem pediu conta
 *  - ?sticker / ?s / ?fig   -> imagem -> figurinha (esticada, 512x512)
 *  - ?img / ?toimg          -> figurinha -> imagem
 *  - ?ban @usuario          -> remove membro do grupo (admin)
 *  - ?promote @usuario      -> promove a admin (admin)
 *  - ?demote @usuario       -> remove admin (admin)
 *  - ?everyone / ?all       -> menciona todo mundo do grupo (admin)
 *  - ?uptime                -> tempo que o bot está rodando
 *  - ?ping                  -> teste rápido
 *  - ?execute / ?exec / ?eval -> SÓ para o dono do bot, SÓ no privado.
 *                                Executa JS arbitrário no processo do bot.
 *  - Reconexão controlada (com backoff, sem loop infinito)
 *
 * IMPORTANTE:
 *  O processo precisa ficar rodando continuamente e com disco persistente
 *  pra pasta de sessão. Use VPS, Railway, Render (Web Service), Fly.io, etc.
 *  NÃO funciona em serverless (ex: Vercel).
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

const fs = require('fs')
const { Boom } = require('@hapi/boom')
const pino = require('pino')
const sharp = require('sharp')

// ============================================================
// CONFIGURAÇÕES
// ============================================================

const PHONE_NUMBER = '5562996664760' // número que recebe o pairing code
const OWNER_JID = '556299269098@s.whatsapp.net' // único número que pode usar ?execute
const PREFIX = '?'
const SESSION_DIR = 'auth_info_baileys'
const MAX_RECONNECT_DELAY_MS = 30000

const logger = pino({ level: 'silent' })

// ============================================================
// ESTADO EM MEMÓRIA
// ============================================================

const activeMenus = new Map() // pollMsgId -> { owner, chatId, placeholderKey, pollMsg }
const startTime = Date.now()

let pairingCodeRequested = false
let reconnectAttempts = 0
let botControllerRunning = false // impede duas instâncias do controlador ao mesmo tempo

// ============================================================
// MENU
// ============================================================

const MENU_OPTIONS = ['🎨 Figurinhas', '🛡️ Administração', '🔧 Utilitários', 'ℹ️ Sobre o Bot']

const SUBMENUS = {
  '🎨 Figurinhas':
    '🎨 *FIGURINHAS*\n\n' +
    `• ${PREFIX}sticker (ou ${PREFIX}s) - responda uma imagem para virar figurinha\n` +
    `• ${PREFIX}img (ou ${PREFIX}toimg) - responda uma figurinha para virar imagem`,
  '🛡️ Administração':
    '🛡️ *ADMINISTRAÇÃO* (grupos, precisa ser admin)\n\n' +
    `• ${PREFIX}ban @usuario - remove um membro\n` +
    `• ${PREFIX}promote @usuario - torna admin\n` +
    `• ${PREFIX}demote @usuario - remove admin\n` +
    `• ${PREFIX}everyone <mensagem> - menciona todo mundo`,
  '🔧 Utilitários':
    '🔧 *UTILITÁRIOS*\n\n' +
    `• ${PREFIX}ping - testa se o bot está respondendo\n` +
    `• ${PREFIX}uptime - tempo que o bot está rodando`,
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

// Remove o sufixo ":device" do jid, pra poder comparar dois jids da mesma pessoa
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

function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${hours}h ${minutes}m ${seconds}s`
}

function stringifyResult(result) {
  try {
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

// Apaga a pasta de sessão inteira (usado quando a sessão morreu de vez)
async function wipeSession() {
  try {
    await fs.promises.rm(SESSION_DIR, { recursive: true, force: true })
    console.log(`🗑️ Pasta "${SESSION_DIR}" apagada com sucesso.`)
  } catch (err) {
    console.error(`❌ Não consegui apagar a pasta "${SESSION_DIR}":`, err)
  }
}

// Busca infos de admin do grupo de uma vez só (usado por ban/promote/demote/everyone)
async function getGroupInfo(sock, chatId, jid) {
  const groupMeta = await sock.groupMetadata(chatId)
  const participants = groupMeta.participants
  const normalized = normalizeJid(jid)
  const data = participants.find((p) => normalizeJid(p.id) === normalized)
  return { participants, isAdmin: Boolean(data?.admin) }
}

// Busca o buffer de mídia direto da mensagem OU de uma mensagem citada (respondida)
async function getMediaBuffer(sock, msg, mediaType) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo
  const quotedMessage = contextInfo?.quotedMessage

  let targetMsg = null

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
  } else if (msg.message?.[mediaType]) {
    targetMsg = msg
  }

  if (!targetMsg) return null

  return downloadMediaMessage(targetMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
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
    { quoted: msg }
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

// Chamado sempre que chega uma atualização de voto de qualquer enquete
async function handlePollUpdate(sock, key, update) {
  const session = activeMenus.get(key.id)
  if (!session) return // não é um menu que estamos rastreando

  try {
    const ownerNormalized = normalizeJid(session.owner)

    // Filtra ANTES de agregar, usando o participant de cada voto individual
    // (o mesmo tipo de campo que usamos pra guardar quem é o "dono" do menu).
    // Isso evita problemas de formato de jid (ex: @lid vs @s.whatsapp.net)
    // que a lista de "voters" devolvida pela função de agregação pode ter.
    const ownerVotes = (update.pollUpdates || []).filter((pollUpdate) => {
      const voterJid =
        pollUpdate.pollUpdateMessageKey?.participant ||
        pollUpdate.pollUpdateMessageKey?.remoteJid ||
        ''
      return normalizeJid(voterJid) === ownerNormalized
    })

    if (ownerVotes.length === 0) return // só outras pessoas votaram, ou o dono ainda não votou

    const results = await getAggregateVotesInPollMessage({
      message: session.pollMsg.message,
      pollUpdates: ownerVotes
    })

    const chosen = results.find((option) => option.voters?.length > 0)
    if (!chosen) return

    const content = SUBMENUS[chosen.name] || '❓ Opção inválida.'

    await sock.sendMessage(session.chatId, {
      text: content,
      edit: session.placeholderKey
    })

    activeMenus.delete(key.id) // já usamos, não precisa mais rastrear
  } catch (err) {
    console.error('Erro ao processar voto da enquete:', err)
  }
}

// ============================================================
// ?STICKER (imagem -> figurinha esticada)
// ============================================================

async function handleStickerCreate(sock, msg, chatId) {
  try {
    const buffer = await getMediaBuffer(sock, msg, 'imageMessage')

    if (!buffer) {
      await sock.sendMessage(
        chatId,
        { text: `❌ Responda a uma imagem com *${PREFIX}sticker*, ou envie a imagem com essa legenda.` },
        { quoted: msg }
      )
      return
    }

    // fit: 'fill' estica a imagem pra caber exatamente em 512x512, sem manter a proporção
    const webpBuffer = await sharp(buffer).resize(512, 512, { fit: 'fill' }).webp().toBuffer()

    await sock.sendMessage(chatId, { sticker: webpBuffer }, { quoted: msg })
  } catch (err) {
    console.error('Erro ao criar figurinha:', err)
    await sock.sendMessage(chatId, { text: '❌ Não consegui transformar essa imagem em figurinha.' }, { quoted: msg })
  }
}

// ============================================================
// ?IMG (figurinha -> imagem)
// ============================================================

async function handleStickerToImage(sock, msg, chatId) {
  try {
    const buffer = await getMediaBuffer(sock, msg, 'stickerMessage')

    if (!buffer) {
      await sock.sendMessage(chatId, { text: `❌ Responda a uma figurinha com *${PREFIX}img*.` }, { quoted: msg })
      return
    }

    const pngBuffer = await sharp(buffer).png().toBuffer()

    await sock.sendMessage(chatId, { image: pngBuffer, caption: '✅ Aqui está sua imagem!' }, { quoted: msg })
  } catch (err) {
    console.error('Erro ao converter figurinha:', err)
    await sock.sendMessage(chatId, { text: '❌ Não consegui converter essa figurinha.' }, { quoted: msg })
  }
}

// ============================================================
// ?BAN / ?PROMOTE / ?DEMOTE
// ============================================================

async function handleGroupAction(sock, msg, chatId, senderJid, isGroup, action) {
  if (!isGroup) {
    await sock.sendMessage(chatId, { text: '❌ Esse comando só funciona em grupos.' }, { quoted: msg })
    return
  }

  try {
    const { participants, isAdmin: senderIsAdmin } = await getGroupInfo(sock, chatId, senderJid)

    if (!senderIsAdmin) {
      await sock.sendMessage(chatId, { text: '❌ Só administradores podem usar esse comando.' }, { quoted: msg })
      return
    }

    const botJid = normalizeJid(sock.user.id)
    const botIsAdmin = Boolean(participants.find((p) => normalizeJid(p.id) === botJid)?.admin)

    if (!botIsAdmin) {
      await sock.sendMessage(chatId, { text: '❌ Preciso ser administrador do grupo pra fazer isso.' }, { quoted: msg })
      return
    }

    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid

    if (!mentioned?.length) {
      await sock.sendMessage(chatId, { text: `❌ Marque quem você quer afetar. Ex: *${PREFIX}${action} @usuario*` }, { quoted: msg })
      return
    }

    await sock.groupParticipantsUpdate(chatId, mentioned, action)

    const messages = {
      remove: '✅ Membro removido com sucesso!',
      promote: '✅ Membro promovido a administrador!',
      demote: '✅ Membro rebaixado de administrador!'
    }

    await sock.sendMessage(chatId, { text: messages[action] })
  } catch (err) {
    console.error(`Erro ao executar ${action}:`, err)
    await sock.sendMessage(chatId, { text: '❌ Não consegui fazer isso. Confira se o bot ainda é admin do grupo.' }, { quoted: msg })
  }
}

// ============================================================
// ?EVERYONE / ?ALL
// ============================================================

async function handleEveryone(sock, msg, chatId, senderJid, isGroup, customText) {
  if (!isGroup) {
    await sock.sendMessage(chatId, { text: '❌ Esse comando só funciona em grupos.' }, { quoted: msg })
    return
  }

  try {
    const { participants, isAdmin } = await getGroupInfo(sock, chatId, senderJid)

    if (!isAdmin) {
      await sock.sendMessage(chatId, { text: '❌ Só administradores podem usar esse comando.' }, { quoted: msg })
      return
    }

    const mentions = participants.map((p) => p.id)
    const text = customText?.trim() || '📢 Atenção geral!'

    await sock.sendMessage(chatId, { text, mentions }, { quoted: msg })
  } catch (err) {
    console.error('Erro ao mencionar todo mundo:', err)
  }
}

// ============================================================
// ?EXECUTE / ?EXEC / ?EVAL - SÓ O DONO, SÓ NO PRIVADO
// ============================================================
//
// ⚠️ ATENÇÃO: esse comando executa JS arbitrário dentro do processo do bot,
// com acesso total ao socket do WhatsApp, ao sistema de arquivos, etc.
// Isso é essencialmente controle total do servidor onde o bot roda.
// - Só funciona no privado (nunca em grupo) pra ninguém ver o que você roda.
// - Só funciona pro OWNER_JID configurado lá em cima.
// - Se esse número do WhatsApp for comprometido, quem o controlar também
//   ganha esse acesso. Trate o ?execute como uma senha de root.
//
async function handleExecute(sock, msg, chatId, senderJid, isGroup, code) {
  const isOwner = !isGroup && normalizeJid(senderJid) === normalizeJid(OWNER_JID)

  if (!isOwner) {
    return // finge que o comando não existe pra qualquer outra pessoa/lugar
  }

  if (!code) {
    await sock.sendMessage(chatId, { text: `Uso: ${PREFIX}execute <código js>\n\nVariáveis disponíveis: sock (ou client), msg, chatId (ou jid), senderJid` }, { quoted: msg })
    return
  }

  // Aliases convenientes, do jeito que você pediu (client.sendMessage(jid, ...))
  const client = sock
  const jid = chatId

  try {
    // eslint-disable-next-line no-eval
    const result = await eval(`(async () => {\n${code}\n})()`)
    const output = result === undefined ? '✅ Executado (sem retorno).' : `✅ Resultado:\n${stringifyResult(result)}`
    await sock.sendMessage(chatId, { text: output }, { quoted: msg })
  } catch (err) {
    await sock.sendMessage(chatId, { text: `❌ Erro:\n${err.message}` }, { quoted: msg })
  }
}

// ============================================================
// CRIAÇÃO DO SOCKET
// ============================================================

async function createSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()

  console.log(`🔌 Iniciando Baileys ${version.join('.')}`)

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

  return sock
}

// ============================================================
// PAIRING CODE
// ============================================================

async function requestPairingCode(sock) {
  if (sock.authState.creds.registered || pairingCodeRequested) return

  pairingCodeRequested = true

  try {
    await delay(2000) // dá um tempinho pro socket ficar pronto
    const code = await sock.requestPairingCode(PHONE_NUMBER)
    console.log('\n========================================')
    console.log('📱 CÓDIGO DE PAREAMENTO:', code)
    console.log('Abra o WhatsApp > Dispositivos conectados > Conectar com número de telefone')
    console.log('e digite esse código (ele expira em pouco tempo).')
    console.log('========================================\n')
  } catch (err) {
    console.error('❌ Erro ao solicitar pairing code:', err)
    pairingCodeRequested = false
  }
}

// ============================================================
// EVENTOS DO SOCKET
// ============================================================

function setupSocketEvents(sock) {
  let connectionClosed = false

  const connectionClosedPromise = new Promise((resolve) => {
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update

      if (connection === 'open') {
        console.log('✅ Bot conectado com sucesso!')
        reconnectAttempts = 0
        pairingCodeRequested = false
      }

      if (update.qr && !sock.authState.creds.registered) {
        await requestPairingCode(sock)
      }

      if (connection === 'close' && !connectionClosed) {
        connectionClosed = true

        const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : null
        const reason = lastDisconnect?.error?.message || 'sem detalhes'

        console.log(`❌ Conexão fechada. Código: ${statusCode ?? 'desconhecido'} | Motivo: ${reason}`)

        // Sessão morta de vez - reaproveitar os arquivos salvos não adianta,
        // então apaga tudo e já parte pra gerar um pairing code novo.
        const wipeAndRetryReasons = [DisconnectReason.loggedOut, DisconnectReason.badSession]
        // Outra instância assumiu essa mesma sessão - apagar aqui poderia
        // brigar com ela, então só paramos e avisamos.
        const stopReasons = [DisconnectReason.connectionReplaced]

        const shouldWipeSession = wipeAndRetryReasons.includes(statusCode)
        const shouldStop = stopReasons.includes(statusCode)

        resolve({ shouldReconnect: !shouldStop, shouldWipeSession, statusCode })
      }
    })
  })

  // ------------------------------------------------------------
  // POLLS (menu)
  // ------------------------------------------------------------
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (update.pollUpdates) {
        await handlePollUpdate(sock, key, update)
      }
    }
  })

  // ------------------------------------------------------------
  // MENSAGENS -> COMANDOS
  // ------------------------------------------------------------
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0]
      if (!msg?.message) return
      if (msg.key.fromMe) return
      if (msg.key.remoteJid === 'status@broadcast') return

      const chatId = msg.key.remoteJid
      const isGroup = chatId.endsWith('@g.us')
      const senderJid = isGroup ? msg.key.participant : chatId

      const text = getMessageText(msg).trim()
      if (!text.startsWith(PREFIX)) return

      // Extrai o comando e o "corpo" preservando espaços/quebras de linha
      // originais (importante pro ?execute, que pode ter código multi-linha).
      const withoutPrefix = text.slice(PREFIX.length)
      const firstSpace = withoutPrefix.search(/\s/)
      const rawCommand = firstSpace === -1 ? withoutPrefix : withoutPrefix.slice(0, firstSpace)
      const commandBody = firstSpace === -1 ? '' : withoutPrefix.slice(firstSpace + 1).trim()
      const command = rawCommand.toLowerCase()

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
          await handleGroupAction(sock, msg, chatId, senderJid, isGroup, 'remove')
          break

        case 'promote':
          await handleGroupAction(sock, msg, chatId, senderJid, isGroup, 'promote')
          break

        case 'demote':
          await handleGroupAction(sock, msg, chatId, senderJid, isGroup, 'demote')
          break

        case 'everyone':
        case 'all':
          await handleEveryone(sock, msg, chatId, senderJid, isGroup, commandBody)
          break

        case 'uptime':
          await sock.sendMessage(chatId, { text: `⏱️ Bot rodando há ${formatUptime(Date.now() - startTime)}` }, { quoted: msg })
          break

        case 'ping':
          await sock.sendMessage(chatId, { text: 'Pong! 🏓' }, { quoted: msg })
          break

        case 'execute':
        case 'exec':
        case 'eval':
          await handleExecute(sock, msg, chatId, senderJid, isGroup, commandBody)
          break

        default:
          // comando desconhecido - fica em silêncio de propósito
          break
      }
    } catch (err) {
      console.error('❌ Erro ao processar mensagem:', err)
    }
  })

  return connectionClosedPromise
}

// ============================================================
// CONTROLADOR PRINCIPAL
// ============================================================

async function startBot() {
  if (botControllerRunning) {
    console.log('⚠️ O controlador do bot já está rodando.')
    return
  }

  botControllerRunning = true
  console.log('🚀 Iniciando controlador do bot...')

  while (true) {
    try {
      const sock = await createSocket()
      const result = await setupSocketEvents(sock)

      if (!result.shouldReconnect) {
        if (result.statusCode === DisconnectReason.loggedOut) {
          console.log(`❌ Sessão desconectada pelo WhatsApp. Apague "${SESSION_DIR}" e pareie novamente.`)
        } else if (result.statusCode === DisconnectReason.badSession) {
          console.log(`❌ Sessão corrompida. Apague "${SESSION_DIR}" e pareie novamente.`)
        } else if (result.statusCode === DisconnectReason.connectionReplaced) {
          console.log('❌ Essa sessão foi aberta em outra instância. Verifique se não há outro processo rodando.')
        }
        break
      }

      reconnectAttempts++
      const waitMs = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS)
      console.log(`🔄 Reconectando em ${Math.round(waitMs / 1000)}s (tentativa ${reconnectAttempts})...`)
      await delay(waitMs)
      pairingCodeRequested = false
    } catch (err) {
      console.error('❌ Erro no controlador:', err)
      reconnectAttempts++
      const waitMs = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS)
      console.log(`🔄 Tentando novamente em ${Math.round(waitMs / 1000)}s...`)
      await delay(waitMs)
      pairingCodeRequested = false
    }
  }

  botControllerRunning = false
  console.log('🛑 Controlador do bot encerrado.')
}

// ============================================================
// ERROS GLOBAIS
// ============================================================

process.on('uncaughtException', (err) => console.error('💥 Erro não tratado:', err))
process.on('unhandledRejection', (err) => console.error('💥 Promise rejeitada:', err))

// ============================================================
// START
// ============================================================

startBot()
