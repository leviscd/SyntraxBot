/**
 * ============================================================
 *  BASE DE BOT WHATSAPP - BAILEYS
 * ============================================================
 *
 * Funcionalidades:
 *  - Pairing Code (sem QR Code) + regeneração automática se expirar
 *  - Sessão persistente (path absoluto, não depende do cwd)
 *  - ?menu / ?help          -> enquete nativa; só o voto de quem pediu conta
 *  - ?sticker / ?s / ?fig   -> imagem -> figurinha (esticada, 512x512)
 *  - ?img / ?toimg          -> figurinha -> imagem
 *  - ?ban / ?promote / ?demote @usuario -> ações de grupo (admin)
 *  - ?everyone / ?all       -> menciona todo mundo do grupo (admin)
 *  - ?uptime / ?ping        -> utilitários
 *  - ?info (respondendo uma mensagem) -> despeja os metadados dela em JSON
 *  - ?execute / ?exec / ?eval -> SÓ o dono, SÓ no privado. Roda JS arbitrário.
 *  - Logs detalhados em pontos críticos (poll, execute, conexão)
 *  - Reconexão controlada, com backoff e sem loop infinito
 *
 * IMPORTANTE:
 *  1) Precisa de um processo rodando 24/7 com DISCO PERSISTENTE.
 *     No Railway isso significa ter um Volume anexado ao projeto -
 *     sem isso, TODOS os arquivos (inclusive a sessão) somem a cada
 *     redeploy/restart, não importa o que o código faça.
 *  2) Confira o OWNER_JID abaixo - se estiver com dígito errado, o
 *     ?execute nunca vai reconhecer você (vai ficar em silêncio).
 *
 * INSTALAÇÃO:
 *  npm install
 *  node index.js
 * ============================================================
 */

const path = require('path')
const fs = require('fs')

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

const PHONE_NUMBER = '5562996664760' // número que recebe o pairing code
const OWNER_JID = '556299269098@s.whatsapp.net' // ⚠️ confira se está certo - ver aviso no topo
const PREFIX = '?'
const SESSION_DIR = path.join(__dirname, 'auth_info_baileys') // path absoluto de propósito
const MAX_RECONNECT_DELAY_MS = 30000
const PAIRING_CODE_TIMEOUT_MS = 60000 // se ninguém digitar o código nesse tempo, gera outro
const DEBUG = true // deixa true até resolvermos os bugs relatados; dá pra desligar depois

const logger = pino({ level: 'silent' })

function debugLog(...args) {
  if (DEBUG) console.log('[debug]', ...args)
}

// ============================================================
// ESTADO EM MEMÓRIA
// ============================================================

const activeMenus = new Map() // pollMsgId -> { owner, chatId, placeholderKey, pollMsg }
const startTime = Date.now()

let pairingCodeRequested = false
let pairingTimeoutHandle = null
let reconnectAttempts = 0
let botControllerRunning = false

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
    `• ${PREFIX}uptime - tempo que o bot está rodando\n` +
    `• ${PREFIX}info - responda uma mensagem pra ver os metadados dela`,
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

// JSON.stringify "seguro" pra objetos do baileys: eles têm Buffers, Uint8Array
// e às vezes objetos tipo Long (protobuf) que não viram JSON legível de boa.
function safeStringifyDeep(obj) {
  const seen = new WeakSet()
  return JSON.stringify(
    obj,
    (_key, value) => {
      if (typeof value === 'bigint') return value.toString()
      if (value instanceof Uint8Array || Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]'
        seen.add(value)
        if ('low' in value && 'high' in value && typeof value.toString === 'function') {
          return value.toString() // objetos tipo Long do protobufjs
        }
      }
      return value
    },
    2
  )
}

async function getGroupInfo(sock, chatId, jid) {
  const groupMeta = await sock.groupMetadata(chatId)
  const participants = groupMeta.participants
  const normalized = normalizeJid(jid)
  const data = participants.find((p) => normalizeJid(p.id) === normalized)
  return { participants, isAdmin: Boolean(data?.admin) }
}

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

async function wipeSession() {
  try {
    await fs.promises.rm(SESSION_DIR, { recursive: true, force: true })
    console.log(`🗑️ Pasta "${SESSION_DIR}" apagada com sucesso.`)
  } catch (err) {
    console.error(`❌ Não consegui apagar a pasta "${SESSION_DIR}":`, err?.stack || err)
  }
}

function forceCloseSocket(sock, reason) {
  try {
    if (typeof sock.end === 'function') {
      sock.end(new Error(reason))
    } else if (sock.ws && typeof sock.ws.close === 'function') {
      sock.ws.close()
    }
  } catch (err) {
    console.error('Erro ao forçar fechamento do socket:', err?.stack || err)
  }
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

  debugLog(`[menu] Enquete criada. id=${pollMsg.key.id} owner=${normalizeJid(senderJid)}`)
}

async function handlePollUpdate(sock, key, update) {
  const session = activeMenus.get(key.id)

  debugLog(`[poll] Update recebido. key.id=${key.id} sessãoEncontrada=${Boolean(session)}`)
  debugLog('[poll] pollUpdates bruto:', safeStringifyDeep(update.pollUpdates))

  if (!session) return

  try {
    const ownerNormalized = normalizeJid(session.owner)

    const ownerVotes = (update.pollUpdates || []).filter((pollUpdate) => {
      const voterJid =
        pollUpdate.pollUpdateMessageKey?.participant ||
        pollUpdate.pollUpdateMessageKey?.remoteJid ||
        ''
      return normalizeJid(voterJid) === ownerNormalized
    })

    debugLog(`[poll] Votos do dono (${ownerNormalized}) encontrados: ${ownerVotes.length}`)

    if (ownerVotes.length === 0) return

    const results = await getAggregateVotesInPollMessage({
      message: session.pollMsg.message,
      pollUpdates: ownerVotes
    })

    debugLog('[poll] Resultado agregado:', safeStringifyDeep(results))

    const chosen = results.find((option) => option.voters?.length > 0)
    if (!chosen) {
      debugLog('[poll] Nenhuma opção com voto encontrada no resultado agregado.')
      return
    }

    const content = SUBMENUS[chosen.name] || '❓ Opção inválida.'

    await sock.sendMessage(session.chatId, {
      text: content,
      edit: session.placeholderKey
    })

    activeMenus.delete(key.id)
  } catch (err) {
    console.error('[poll] Erro ao processar voto da enquete:', err?.stack || err)
  }
}

// Alguns forks/versões do Baileys entregam o voto da enquete via
// "messages.upsert" (como uma mensagem com pollUpdateMessage) em vez de
// "messages.update". Esse é um caminho alternativo pra cobrir esse caso -
// se o listener de cima nunca disparar, esse aqui é o plano B.
async function handlePollUpdateFromUpsert(sock, msg) {
  const pollUpdateMessage = msg.message?.pollUpdateMessage
  const pollCreationKey = pollUpdateMessage?.pollCreationMessageKey
  if (!pollCreationKey?.id) return

  debugLog(`[poll-upsert] Voto recebido via messages.upsert pra poll ${pollCreationKey.id}`)

  const fakeUpdate = {
    pollUpdates: [
      {
        pollUpdateMessageKey: msg.key,
        vote: pollUpdateMessage.vote,
        senderTimestampMs: pollUpdateMessage.senderTimestampMs
      }
    ]
  }

  await handlePollUpdate(sock, pollCreationKey, fakeUpdate)
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

    const webpBuffer = await sharp(buffer).resize(512, 512, { fit: 'fill' }).webp().toBuffer()

    await sock.sendMessage(chatId, { sticker: webpBuffer }, { quoted: msg })
  } catch (err) {
    console.error('Erro ao criar figurinha:', err?.stack || err)
    await sock.sendMessage(chatId, { text: `❌ Não consegui transformar essa imagem em figurinha.\n\nErro: ${err.message}` }, { quoted: msg })
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
    console.error('Erro ao converter figurinha:', err?.stack || err)
    await sock.sendMessage(chatId, { text: `❌ Não consegui converter essa figurinha.\n\nErro: ${err.message}` }, { quoted: msg })
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
    console.error(`Erro ao executar ${action}:`, err?.stack || err)
    await sock.sendMessage(chatId, { text: `❌ Não consegui fazer isso.\n\nErro: ${err.message}` }, { quoted: msg })
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
    console.error('Erro ao mencionar todo mundo:', err?.stack || err)
  }
}

// ============================================================
// ?INFO - metadados de uma mensagem marcada (respondida)
// ============================================================

async function handleInfo(sock, msg, chatId) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo
  const quotedMessage = contextInfo?.quotedMessage

  if (!quotedMessage) {
    await sock.sendMessage(chatId, { text: `❌ Marque (responda) uma mensagem com *${PREFIX}info* pra ver os metadados dela.` }, { quoted: msg })
    return
  }

  const info = {
    remoteJid: msg.key.remoteJid,
    quotedMessageId: contextInfo.stanzaId,
    quotedParticipant: contextInfo.participant || null,
    contextInfo,
    quotedMessageContent: quotedMessage
  }

  const json = safeStringifyDeep(info)
  const MAX_LENGTH = 3500
  const trimmed = json.length > MAX_LENGTH ? `${json.slice(0, MAX_LENGTH)}\n\n... (cortado - JSON completo tinha ${json.length} caracteres)` : json

  await sock.sendMessage(chatId, { text: '```' + trimmed + '```' }, { quoted: msg })
}

// ============================================================
// ?EXECUTE / ?EXEC / ?EVAL - SÓ O DONO, SÓ NO PRIVADO
// ============================================================

async function handleExecute(sock, msg, chatId, senderJid, isGroup, code) {
  const senderNormalized = normalizeJid(senderJid)
  const ownerNormalized = normalizeJid(OWNER_JID)
  const isOwner = !isGroup && senderNormalized === ownerNormalized

  // Log sempre, mesmo se não for o dono - é o jeito mais rápido de descobrir
  // se o OWNER_JID configurado está diferente do jid real de quem tentou usar.
  console.log(`[execute] Tentativa de uso | senderJid="${senderNormalized}" | OWNER_JID="${ownerNormalized}" | isGroup=${isGroup} | autorizado=${isOwner}`)

  if (!isOwner) return

  if (!code) {
    await sock.sendMessage(
      chatId,
      { text: `Uso: ${PREFIX}execute <código js>\n\nVariáveis disponíveis: sock (ou client), msg, chatId (ou jid), senderJid` },
      { quoted: msg }
    )
    return
  }

  const client = sock
  const jid = chatId

  try {
    // eslint-disable-next-line no-eval
    const result = await eval(`(async () => {\n${code}\n})()`)
    const output = result === undefined ? '✅ Executado (sem retorno).' : `✅ Resultado:\n${stringifyResult(result)}`
    await sock.sendMessage(chatId, { text: output }, { quoted: msg })
  } catch (err) {
    console.error('[execute] Erro ao rodar o código:', err?.stack || err)
    await sock.sendMessage(chatId, { text: `❌ Erro:\n${err.stack || err.message}` }, { quoted: msg })
  }
}

// ============================================================
// CRIAÇÃO DO SOCKET
// ============================================================

async function createSocket() {
  const hasExistingSession = fs.existsSync(path.join(SESSION_DIR, 'creds.json'))
  console.log(`📁 Pasta de sessão: ${SESSION_DIR}`)
  console.log(`📁 Sessão salva já existe? ${hasExistingSession ? 'SIM' : 'NÃO'}`)

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
    await delay(2000)
    const code = await sock.requestPairingCode(PHONE_NUMBER)
    console.log('\n========================================')
    console.log('📱 CÓDIGO DE PAREAMENTO:', code)
    console.log('Abra o WhatsApp > Dispositivos conectados > Conectar com número de telefone')
    console.log('e digite esse código (ele expira em pouco tempo).')
    console.log('========================================\n')

    // Se ninguém digitar a tempo, força o fechamento pra gerar um código novo
    // automaticamente na próxima volta do loop de reconexão.
    if (pairingTimeoutHandle) clearTimeout(pairingTimeoutHandle)
    pairingTimeoutHandle = setTimeout(() => {
      if (!sock.authState.creds.registered) {
        console.log('⏰ O código de pareamento expirou sem uso. Reiniciando a conexão pra gerar um novo...')
        forceCloseSocket(sock, 'Pairing code expirado')
      }
    }, PAIRING_CODE_TIMEOUT_MS)
  } catch (err) {
    console.error('❌ Erro ao solicitar pairing code:', err?.stack || err)
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
        if (pairingTimeoutHandle) {
          clearTimeout(pairingTimeoutHandle)
          pairingTimeoutHandle = null
        }
      }

      if (update.qr && !sock.authState.creds.registered) {
        await requestPairingCode(sock)
      }

      if (connection === 'close' && !connectionClosed) {
        connectionClosed = true

        if (pairingTimeoutHandle) {
          clearTimeout(pairingTimeoutHandle)
          pairingTimeoutHandle = null
        }

        const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : null
        const reason = lastDisconnect?.error?.message || 'sem detalhes'

        console.log(`❌ Conexão fechada. Código: ${statusCode ?? 'desconhecido'} | Motivo: ${reason}`)
        if (DEBUG && lastDisconnect?.error?.stack) console.log(lastDisconnect.error.stack)

        const wipeAndRetryReasons = [DisconnectReason.loggedOut, DisconnectReason.badSession]
        const stopReasons = [DisconnectReason.connectionReplaced]

        const shouldWipeSession = wipeAndRetryReasons.includes(statusCode)
        const shouldStop = stopReasons.includes(statusCode)

        resolve({ shouldReconnect: !shouldStop, shouldWipeSession, statusCode })
      }
    })
  })

  // ------------------------------------------------------------
  // POLLS (menu) - caminho principal
  // ------------------------------------------------------------
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (update.pollUpdates) {
        await handlePollUpdate(sock, key, update)
      }
    }
  })

  // ------------------------------------------------------------
  // MENSAGENS -> COMANDOS (+ caminho alternativo de poll, ver função)
  // ------------------------------------------------------------
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0]
      if (!msg?.message) return
      if (msg.key.fromMe) return
      if (msg.key.remoteJid === 'status@broadcast') return

      // Plano B: se o voto da enquete chegar aqui em vez de messages.update
      if (msg.message.pollUpdateMessage) {
        await handlePollUpdateFromUpsert(sock, msg)
        return
      }

      const chatId = msg.key.remoteJid
      const isGroup = chatId.endsWith('@g.us')
      const senderJid = isGroup ? msg.key.participant : chatId

      const text = getMessageText(msg).trim()
      if (!text.startsWith(PREFIX)) return

      const withoutPrefix = text.slice(PREFIX.length)
      const firstSpace = withoutPrefix.search(/\s/)
      const rawCommand = firstSpace === -1 ? withoutPrefix : withoutPrefix.slice(0, firstSpace)
      const commandBody = firstSpace === -1 ? '' : withoutPrefix.slice(firstSpace + 1).trim()
      const command = rawCommand.toLowerCase()

      debugLog(`[comando] "${command}" recebido de ${normalizeJid(senderJid)} em ${isGroup ? 'grupo' : 'privado'}`)

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

        case 'info':
          await handleInfo(sock, msg, chatId)
          break

        case 'execute':
        case 'exec':
        case 'eval':
          await handleExecute(sock, msg, chatId, senderJid, isGroup, commandBody)
          break

        default:
          break
      }
    } catch (err) {
      console.error('❌ Erro ao processar mensagem:', err?.stack || err)
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

      if (result.shouldWipeSession) {
        console.log(`🗑️ Sessão inválida (código ${result.statusCode}). Apagando "${SESSION_DIR}" e gerando um novo pairing code...`)
        await wipeSession()
        pairingCodeRequested = false
        reconnectAttempts = 0
        continue
      }

      if (!result.shouldReconnect) {
        console.log('❌ Essa sessão foi aberta em outra instância. Verifique se não há outro processo rodando com a mesma pasta de sessão.')
        break
      }

      reconnectAttempts++
      const waitMs = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS)
      console.log(`🔄 Reconectando em ${Math.round(waitMs / 1000)}s (tentativa ${reconnectAttempts})...`)
      await delay(waitMs)
      pairingCodeRequested = false
    } catch (err) {
      console.error('❌ Erro no controlador:', err?.stack || err)
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

process.on('uncaughtException', (err) => console.error('💥 Erro não tratado:', err?.stack || err))
process.on('unhandledRejection', (err) => console.error('💥 Promise rejeitada:', err?.stack || err))

// ============================================================
// START
// ============================================================

startBot()
