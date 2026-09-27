import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  getAggregateVotesInPollMessage
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import sharp from 'sharp'
// ============================================================
// PATH
// ============================================================
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// ============================================================
// CONFIGURAÇÃO
// ============================================================
const PHONE_NUMBER = '5562996664760'
const OWNER_JID =
  '556299269098@s.whatsapp.net'
const PREFIX = '?'
/*
 * LOCAL:
 *   ./auth_info_baileys
 *
 * RAILWAY:
 *   Se você tiver Volume montado em /data,
 *   prefira:
 *
 *   const SESSION_DIR = '/data/auth_info_baileys'
 *
 * O diretório precisa ser persistente.
 */
const SESSION_DIR = path.resolve(
  __dirname,
  'auth_info_baileys'
)
const MAX_RECONNECT_DELAY_MS = 30000
const DEBUG = true
// ============================================================
// LOGGER
// ============================================================
const logger = pino({
  level: DEBUG ? 'debug' : 'silent'
})
// ============================================================
// ESTADO
// ============================================================
const activeMenus = new Map()
const startTime = Date.now()
let reconnectAttempts = 0
let botControllerRunning = false
// ============================================================
// MENU
// ============================================================
const MENU_OPTIONS = [
  '🎨 Figurinhas',
  '🛡️ Administração',
  '🔧 Utilitários',
  'ℹ️ Sobre o Bot'
]
const SUBMENUS = {
  '🎨 Figurinhas':
    '🎨 *FIGURINHAS*\n\n' +
    `• ${PREFIX}sticker (ou ${PREFIX}s) - responda uma imagem\n` +
    `• ${PREFIX}img (ou ${PREFIX}toimg) - responda uma figurinha`,
  '🛡️ Administração':
    '🛡️ *ADMINISTRAÇÃO*\n\n' +
    `• ${PREFIX}ban @usuario - remove um membro\n` +
    `• ${PREFIX}promote @usuario - torna admin\n` +
    `• ${PREFIX}demote @usuario - remove admin\n` +
    `• ${PREFIX}everyone <mensagem> - menciona todos`,
  '🔧 Utilitários':
    '🔧 *UTILITÁRIOS*\n\n' +
    `• ${PREFIX}ping - testa o bot\n` +
    `• ${PREFIX}uptime - mostra o uptime\n` +
    `• ${PREFIX}info - mostra metadados de uma mensagem`,
  'ℹ️ Sobre o Bot':
    'ℹ️ *SOBRE*\n\n' +
    'Bot base usando Baileys v7.\n' +
    `Prefixo: *${PREFIX}*`
}
// ============================================================
// HELPERS
// ============================================================
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
function normalizeJid(jid = '') {
  return jid.replace(/:\d+(?=@)/, '')
}
function getMessageText(msg) {
  const message = msg?.message
  if (!message) {
    return ''
  }
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ''
  )
}
function formatUptime(ms) {
  const totalSeconds =
    Math.floor(ms / 1000)
  const hours =
    Math.floor(totalSeconds / 3600)
  const minutes =
    Math.floor(
      (totalSeconds % 3600) / 60
    )
  const seconds =
    totalSeconds % 60
  return `${hours}h ${minutes}m ${seconds}s`
}
function stringifyResult(result) {
  try {
    if (typeof result === 'string') {
      return result
    }
    return JSON.stringify(
      result,
      null,
      2
    )
  } catch {
    return String(result)
  }
}
function safeStringifyDeep(obj) {
  const seen = new WeakSet()
  return JSON.stringify(
    obj,
    (_key, value) => {
      if (typeof value === 'bigint') {
        return value.toString()
      }
      if (
        value instanceof Uint8Array ||
        Buffer.isBuffer(value)
      ) {
        return `<Buffer ${value.length} bytes>`
      }
      if (
        value &&
        typeof value === 'object'
      ) {
        if (seen.has(value)) {
          return '[Circular]'
        }
        seen.add(value)
        if (
          'low' in value &&
          'high' in value &&
          typeof value.toString === 'function'
        ) {
          return value.toString()
        }
      }
      return value
    },
    2
  )
}
// ============================================================
// GRUPOS
// ============================================================
async function getGroupInfo(
  sock,
  chatId,
  jid
) {
  const metadata =
    await sock.groupMetadata(chatId)
  const normalized =
    normalizeJid(jid)
  const participant =
    metadata.participants.find(
      p =>
        normalizeJid(p.id) ===
        normalized
    )
  return {
    participants:
      metadata.participants,
    isAdmin:
      Boolean(participant?.admin)
  }
}
// ============================================================
// MEDIA
// ============================================================
async function getMediaBuffer(
  sock,
  msg,
  mediaType
) {
  const contextInfo =
    msg.message
      ?.extendedTextMessage
      ?.contextInfo
  const quotedMessage =
    contextInfo?.quotedMessage
  let targetMsg = null
  if (
    quotedMessage?.[mediaType]
  ) {
    targetMsg = {
      key: {
        remoteJid:
          msg.key.remoteJid,
        id:
          contextInfo.stanzaId,
        participant:
          contextInfo.participant,
        fromMe: false
      },
      message:
        quotedMessage
    }
  }
  else if (
    msg.message?.[mediaType]
  ) {
    targetMsg = msg
  }
  if (!targetMsg) {
    return null
  }
  return downloadMediaMessage(
    targetMsg,
    'buffer',
    {},
    {
      logger,
      reuploadRequest:
        sock.updateMediaMessage
    }
  )
}
// ============================================================
// MENU
// ============================================================
async function sendMenu(
  sock,
  msg,
  chatId,
  senderJid
) {
  const pollMsg =
    await sock.sendMessage(
      chatId,
      {
        poll: {
          name:
            '📋 MENU PRINCIPAL',
          values:
            MENU_OPTIONS,
          selectableCount: 1
        }
      },
      {
        quoted: msg
      }
    )
  const placeholder =
    await sock.sendMessage(
      chatId,
      {
        text:
          '🕒 Aguardando sua escolha...'
      }
    )
  activeMenus.set(
    pollMsg.key.id,
    {
      owner:
        normalizeJid(senderJid),
      chatId,
      placeholderKey:
        placeholder.key,
      pollMsg
    }
  )
  console.log(
    `[MENU] Poll criada: ${pollMsg.key.id}`
  )
}
// ============================================================
// POLL
// ============================================================
async function handlePollUpdate(
  sock,
  key,
  update
) {
  const session =
    activeMenus.get(key.id)
  if (!session) {
    return
  }
  try {
    const owner =
      normalizeJid(
        session.owner
      )
    const ownerVotes =
      (update.pollUpdates || [])
        .filter(pollUpdate => {
          const voter =
            pollUpdate
              .pollUpdateMessageKey
              ?.participant ||
            pollUpdate
              .pollUpdateMessageKey
              ?.remoteJid ||
            ''
          return (
            normalizeJid(voter) ===
            owner
          )
        })
    if (!ownerVotes.length) {
      return
    }
    const results =
      await getAggregateVotesInPollMessage(
        {
          message:
            session.pollMsg.message,
          pollUpdates:
            ownerVotes
        }
      )
    const chosen =
      results.find(
        option =>
          option.voters?.length > 0
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
        edit:
          session.placeholderKey
      }
    )
    activeMenus.delete(key.id)
  } catch (err) {
    console.error(
      '[POLL]',
      err?.stack || err
    )
  }
}
async function handlePollUpdateFromUpsert(
  sock,
  msg
) {
  const pollUpdate =
    msg.message
      ?.pollUpdateMessage
  const creationKey =
    pollUpdate
      ?.pollCreationMessageKey
  if (!creationKey?.id) {
    return
  }
  await handlePollUpdate(
    sock,
    creationKey,
    {
      pollUpdates: [
        {
          pollUpdateMessageKey:
            msg.key,
          vote:
            pollUpdate.vote,
          senderTimestampMs:
            pollUpdate.senderTimestampMs
        }
      ]
    }
  )
}
// ============================================================
// STICKER
// ============================================================
async function handleStickerCreate(
  sock,
  msg,
  chatId
) {
  try {
    const buffer =
      await getMediaBuffer(
        sock,
        msg,
        'imageMessage'
      )
    if (!buffer) {
      await sock.sendMessage(
        chatId,
        {
          text:
            `❌ Responda uma imagem com ` +
            `*${PREFIX}sticker*.`
        },
        {
          quoted: msg
        }
      )
      return
    }
    const webp =
      await sharp(buffer)
        .resize(512, 512, {
          fit: 'fill'
        })
        .webp()
        .toBuffer()
    await sock.sendMessage(
      chatId,
      {
        sticker: webp
      },
      {
        quoted: msg
      }
    )
  } catch (err) {
    console.error(
      '[STICKER]',
      err?.stack || err
    )
    await sock.sendMessage(
      chatId,
      {
        text:
          `❌ Não consegui criar a figurinha.\n\n` +
          `${err.message}`
      },
      {
        quoted: msg
      }
    )
  }
}
// ============================================================
// IMG
// ============================================================
async function handleStickerToImage(
  sock,
  msg,
  chatId
) {
  try {
    const buffer =
      await getMediaBuffer(
        sock,
        msg,
        'stickerMessage'
      )
    if (!buffer) {
      await sock.sendMessage(
        chatId,
        {
          text:
            `❌ Responda uma figurinha com ` +
            `*${PREFIX}img*.`
        },
        {
          quoted: msg
        }
      )
      return
    }
    const png =
      await sharp(buffer)
        .png()
        .toBuffer()
    await sock.sendMessage(
      chatId,
      {
        image: png,
        caption:
          '✅ Aqui está sua imagem!'
      },
      {
        quoted: msg
      }
    )
  } catch (err) {
    console.error(
      '[IMG]',
      err?.stack || err
    )
    await sock.sendMessage(
      chatId,
      {
        text:
          `❌ Não consegui converter a figurinha.\n\n` +
          `${err.message}`
      },
      {
        quoted: msg
      }
    )
  }
}
// ============================================================
// BAN / PROMOTE / DEMOTE
// ============================================================
async function handleGroupAction(
  sock,
  msg,
  chatId,
  senderJid,
  isGroup,
  action
) {
  if (!isGroup) {
    await sock.sendMessage(
      chatId,
      {
        text:
          '❌ Esse comando só funciona em grupos.'
      },
      {
        quoted: msg
      }
    )
    return
  }
  try {
    const {
      participants,
      isAdmin
    } =
      await getGroupInfo(
        sock,
        chatId,
        senderJid
      )
    if (!isAdmin) {
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
      normalizeJid(
        sock.user?.id || ''
      )
    const botParticipant =
      participants.find(
        p =>
          normalizeJid(p.id) ===
          botJid
      )
    if (!botParticipant?.admin) {
      await sock.sendMessage(
        chatId,
        {
          text:
            '❌ Preciso ser administrador do grupo.'
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
            `❌ Marque alguém.\n\n` +
            `Exemplo: *${PREFIX}${action} @usuario*`
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
      action
    )
    const response = {
      remove:
        '✅ Membro removido com sucesso!',
      promote:
        '✅ Membro promovido a administrador!',
      demote:
        '✅ Membro rebaixado de administrador!'
    }
    await sock.sendMessage(
      chatId,
      {
        text:
          response[action]
      }
    )
  } catch (err) {
    console.error(
      `[GROUP ${action}]`,
      err?.stack || err
    )
    await sock.sendMessage(
      chatId,
      {
        text:
          `❌ Não consegui executar.\n\n` +
          `${err.message}`
      },
      {
        quoted: msg
      }
    )
  }
}
// ============================================================
// EVERYONE
// ============================================================
async function handleEveryone(
  sock,
  msg,
  chatId,
  senderJid,
  isGroup,
  customText
) {
  if (!isGroup) {
    await sock.sendMessage(
      chatId,
      {
        text:
          '❌ Esse comando só funciona em grupos.'
      },
      {
        quoted: msg
      }
    )
    return
  }
  try {
    const {
      participants,
      isAdmin
    } =
      await getGroupInfo(
        sock,
        chatId,
        senderJid
      )
    if (!isAdmin) {
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
    const mentions =
      participants.map(
        participant =>
          participant.id
      )
    const text =
      customText?.trim() ||
      '📢 Atenção geral!'
    await sock.sendMessage(
      chatId,
      {
        text,
        mentions
      },
      {
        quoted: msg
      }
    )
  } catch (err) {
    console.error(
      '[EVERYONE]',
      err?.stack || err
    )
  }
}
// ============================================================
// INFO
// ============================================================
async function handleInfo(
  sock,
  msg,
  chatId
) {
  const contextInfo =
    msg.message
      ?.extendedTextMessage
      ?.contextInfo
  const quotedMessage =
    contextInfo?.quotedMessage
  if (!quotedMessage) {
    await sock.sendMessage(
      chatId,
      {
        text:
          `❌ Responda uma mensagem com ` +
          `*${PREFIX}info*.`
      },
      {
        quoted: msg
      }
    )
    return
  }
  const info = {
    remoteJid:
      msg.key.remoteJid,
    quotedMessageId:
      contextInfo.stanzaId,
    quotedParticipant:
      contextInfo.participant ||
      null,
    contextInfo,
    quotedMessageContent:
      quotedMessage
  }
  const json =
    safeStringifyDeep(info)
  const MAX_LENGTH = 3500
  const output =
    json.length > MAX_LENGTH
      ? json.slice(0, MAX_LENGTH) +
        `\n\n... JSON cortado. Total: ${json.length} caracteres`
      : json
  await sock.sendMessage(
    chatId,
    {
      text:
        '```' +
        output +
        '```'
    },
    {
      quoted: msg
    }
  )
}
// ============================================================
// EXEC
// ============================================================
async function handleExecute(
  sock,
  msg,
  chatId,
  senderJid,
  isGroup,
  code
) {
  const sender =
    normalizeJid(senderJid)
  const owner =
    normalizeJid(OWNER_JID)
  const isOwner =
    !isGroup &&
    sender === owner
  console.log(
    `[EXEC] sender=${sender} owner=${owner} authorized=${isOwner}`
  )
  if (!isOwner) {
    return
  }
  if (!code) {
    await sock.sendMessage(
      chatId,
      {
        text:
          `Uso:\n\n` +
          `${PREFIX}exec <código JS>\n\n` +
          `Variáveis disponíveis:\n` +
          `sock\n` +
          `client\n` +
          `msg\n` +
          `chatId\n` +
          `jid\n` +
          `senderJid`
      },
      {
        quoted: msg
      }
    )
    return
  }
  const client = sock
  const jid = chatId
  try {
    const result =
      await eval(
        `(async () => {\n${code}\n})()`
      )
    const output =
      result === undefined
        ? '✅ Executado sem retorno.'
        : `✅ Resultado:\n${stringifyResult(result)}`
    await sock.sendMessage(
      chatId,
      {
        text: output
      },
      {
        quoted: msg
      }
    )
  } catch (err) {
    console.error(
      '[EXEC]',
      err?.stack || err
    )
    await sock.sendMessage(
      chatId,
      {
        text:
          `❌ Erro:\n${err.stack || err.message}`
      },
      {
        quoted: msg
      }
    )
  }
}
// ============================================================
// SESSION
// ============================================================
async function createSocket() {
  await fs.promises.mkdir(
    SESSION_DIR,
    {
      recursive: true
    }
  )
  const credsPath =
    path.join(
      SESSION_DIR,
      'creds.json'
    )
  console.log('')
  console.log(
    `📁 Diretório da sessão:\n${SESSION_DIR}`
  )
  console.log(
    `📄 creds.json: ${
      fs.existsSync(credsPath)
        ? 'EXISTE'
        : 'NÃO EXISTE'
    }`
  )
  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      SESSION_DIR
    )
  const sock =
    makeWASocket({
      auth: state,
      browser:
        Browsers.ubuntu(
          'Chrome'
        ),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs:
        60000,
      keepAliveIntervalMs:
        30000,
      logger
    })
  /*
   * FUNDAMENTAL:
   * Salva continuamente as credenciais/chaves.
   */
  sock.ev.on(
    'creds.update',
    async () => {
      try {
        await saveCreds()
        if (DEBUG) {
          console.log(
            '💾 Credenciais salvas.'
          )
        }
      } catch (err) {
        console.error(
          '❌ Erro salvando credenciais:',
          err?.stack || err
        )
      }
    }
  )
  return sock
}
// ============================================================
// CONNECTION
// ============================================================
function setupConnection(
  sock
) {
  let pairingRequested = false
  let connectionClosed = false
  return new Promise(
    resolve => {
      sock.ev.on(
        'connection.update',
        async update => {
          const {
            connection,
            lastDisconnect,
            qr
          } = update
          if (DEBUG) {
            console.log(
              '[CONNECTION]',
              {
                connection,
                hasQR:
                  Boolean(qr),
                registered:
                  Boolean(
                    sock.authState
                      ?.creds
                      ?.registered
                  )
              }
            )
          }
          // ==================================================
          // PAIRING CODE
          // ==================================================
          if (
            !sock.authState.creds.registered &&
            !pairingRequested &&
            (
              connection ===
                'connecting' ||
              Boolean(qr)
            )
          ) {
            pairingRequested = true
            try {
              /*
               * IMPORTANTE:
               * requestPairingCode recebe somente
               * os dígitos do telefone.
               *
               * Ex:
               * 5562996664760
               */
              const code =
                await sock.requestPairingCode(
                  PHONE_NUMBER
                )
              console.log('')
              console.log(
                '========================================'
              )
              console.log(
                '📱 PAIRING CODE:',
                code
              )
              console.log(
                '========================================'
              )
              console.log(
                'WhatsApp → Configurações'
              )
              console.log(
                '→ Dispositivos conectados'
              )
              console.log(
                '→ Conectar dispositivo'
              )
              console.log(
                '→ Conectar com número de telefone'
              )
              console.log(
                '→ Digite o código acima'
              )
              console.log('')
            } catch (err) {
              pairingRequested =
                false
              console.error(
                '❌ Erro ao solicitar pairing code:',
                err?.stack || err
              )
            }
          }
          // ==================================================
          // OPEN
          // ==================================================
          if (
            connection === 'open'
          ) {
            console.log('')
            console.log(
              '========================================'
            )
            console.log(
              '✅ WHATSAPP CONECTADO'
            )
            console.log(
              '========================================'
            )
            console.log(
              '👤 Conta:',
              sock.user?.id
            )
            console.log(
              '📁 Sessão:',
              SESSION_DIR
            )
            console.log('')
            reconnectAttempts = 0
            resolve({
              shouldReconnect:
                false,
              shouldWipeSession:
                false,
              statusCode:
                null
            })
          }
          // ==================================================
          // CLOSE
          // ==================================================
          if (
            connection === 'close' &&
            !connectionClosed
          ) {
            connectionClosed = true
            const statusCode =
              lastDisconnect
                ?.error instanceof Boom
                ? lastDisconnect.error
                    .output
                    .statusCode
                : lastDisconnect
                    ?.error
                    ?.output
                    ?.statusCode
            const reason =
              lastDisconnect
                ?.error
                ?.message ||
              'sem detalhes'
            console.log('')
            console.log(
              '========================================'
            )
            console.log(
              '❌ CONEXÃO FECHADA'
            )
            console.log(
              'Código:',
              statusCode ??
                'desconhecido'
            )
            console.log(
              'Motivo:',
              reason
            )
            console.log(
              '========================================'
            )
            if (
              DEBUG &&
              lastDisconnect
                ?.error
                ?.stack
            ) {
              console.log(
                lastDisconnect
                  .error
                  .stack
              )
            }
            // ----------------------------------------------
            // LOGGED OUT
            // ----------------------------------------------
            if (
              statusCode ===
              DisconnectReason.loggedOut
            ) {
              console.log(
                '🔐 A sessão foi deslogada pelo WhatsApp.'
              )
              resolve({
                shouldReconnect:
                  false,
                shouldWipeSession:
                  true,
                statusCode
              })
              return
            }
            // ----------------------------------------------
            // BAD SESSION
            // ----------------------------------------------
            if (
              statusCode ===
              DisconnectReason.badSession
            ) {
              console.log(
                '⚠️ Sessão inválida.'
              )
              resolve({
                shouldReconnect:
                  true,
                shouldWipeSession:
                  true,
                statusCode
              })
              return
            }
            // ----------------------------------------------
            // CONNECTION REPLACED
            // ----------------------------------------------
            if (
              statusCode ===
              DisconnectReason.connectionReplaced
            ) {
              console.log(
                '⚠️ A sessão foi substituída por outro dispositivo/processo.'
              )
              resolve({
                shouldReconnect:
                  false,
                shouldWipeSession:
                  false,
                statusCode
              })
              return
            }
            // ----------------------------------------------
            // NORMAL RECONNECT
            // ----------------------------------------------
            resolve({
              shouldReconnect:
                true,
              shouldWipeSession:
                false,
              statusCode
            })
          }
        }
      )
    }
  )
}
// ============================================================
// MESSAGE EVENTS
// ============================================================
function setupMessageHandlers(
  sock
) {
  // ========================================================
  // POLLS
  // ========================================================
  sock.ev.on(
    'messages.update',
    async updates => {
      for (
        const {
          key,
          update
        } of updates
      ) {
        if (
          update.pollUpdates
        ) {
          await handlePollUpdate(
            sock,
            key,
            update
          )
        }
      }
    }
  )
  // ========================================================
  // MESSAGES
  // ========================================================
  sock.ev.on(
    'messages.upsert',
    async ({
      messages
    }) => {
      try {
        for (
          const msg of messages
        ) {
          if (!msg?.message) {
            continue
          }
          if (msg.key.fromMe) {
            continue
          }
          if (
            msg.key.remoteJid ===
            'status@broadcast'
          ) {
            continue
          }
          // -----------------------------------------------
          // POLL FALLBACK
          // -----------------------------------------------
          if (
            msg.message
              .pollUpdateMessage
          ) {
            await handlePollUpdateFromUpsert(
              sock,
              msg
            )
            continue
          }
          const chatId =
            msg.key.remoteJid
          if (!chatId) {
            continue
          }
          const isGroup =
            chatId.endsWith(
              '@g.us'
            )
          const senderJid =
            isGroup
              ? msg.key.participant
              : chatId
          const text =
            getMessageText(
              msg
            ).trim()
          if (
            !text.startsWith(
              PREFIX
            )
          ) {
            continue
          }
          const withoutPrefix =
            text.slice(
              PREFIX.length
            )
          const parts =
            withoutPrefix
              .split(/\s+/)
          const command =
            parts
              .shift()
              ?.toLowerCase()
          const commandBody =
            parts
              .join(' ')
              .trim()
          console.log(
            `[COMMAND] ${command} | ${normalizeJid(senderJid)}`
          )
          switch (
            command
          ) {
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
              await handleGroupAction(
                sock,
                msg,
                chatId,
                senderJid,
                isGroup,
                'remove'
              )
              break
            case 'promote':
              await handleGroupAction(
                sock,
                msg,
                chatId,
                senderJid,
                isGroup,
                'promote'
              )
              break
            case 'demote':
              await handleGroupAction(
                sock,
                msg,
                chatId,
                senderJid,
                isGroup,
                'demote'
              )
              break
            case 'everyone':
            case 'all':
              await handleEveryone(
                sock,
                msg,
                chatId,
                senderJid,
                isGroup,
                commandBody
              )
              break
            case 'uptime':
              await sock.sendMessage(
                chatId,
                {
                  text:
                    `⏱️ Bot rodando há ` +
                    `${formatUptime(
                      Date.now() -
                      startTime
                    )}`
                },
                {
                  quoted: msg
                }
              )
              break
            case 'ping':
              await sock.sendMessage(
                chatId,
                {
                  text:
                    'Pong! 🏓'
                },
                {
                  quoted: msg
                }
              )
              break
            case 'info':
              await handleInfo(
                sock,
                msg,
                chatId
              )
              break
            case 'execute':
            case 'exec':
            case 'eval':
              await handleExecute(
                sock,
                msg,
                chatId,
                senderJid,
                isGroup,
                commandBody
              )
              break
            default:
              break
          }
        }
      } catch (err) {
        console.error(
          '❌ Erro processando mensagem:',
          err?.stack || err
        )
      }
    }
  )
}
// ============================================================
// WIPE SESSION
// ============================================================
async function wipeSession() {
  try {
    await fs.promises.rm(
      SESSION_DIR,
      {
        recursive: true,
        force: true
      }
    )
    console.log(
      '🗑️ Sessão apagada.'
    )
  } catch (err) {
    console.error(
      '❌ Erro apagando sessão:',
      err?.stack || err
    )
  }
}
// ============================================================
// MAIN CONTROLLER
// ============================================================
async function startBot() {
  if (
    botControllerRunning
  ) {
    console.log(
      '⚠️ Controlador já está rodando.'
    )
    return
  }
  botControllerRunning =
    true
  console.log('')
  console.log(
    '🚀 Iniciando bot Baileys...'
  )
  console.log(
    '📦 Baileys: 7.0.0-rc14'
  )
  console.log(
    '🟢 Node:',
    process.version
  )
  console.log('')
  while (true) {
    try {
      const sock =
        await createSocket()
      setupMessageHandlers(
        sock
      )
      const result =
        await setupConnection(
          sock
        )
      // -----------------------------------------------
      // SESSION INVALID
      // -----------------------------------------------
      if (
        result.shouldWipeSession
      ) {
        await wipeSession()
        reconnectAttempts =
          0
        continue
      }
      // -----------------------------------------------
      // STOP
      // -----------------------------------------------
      if (
        !result.shouldReconnect
      ) {
        console.log(
          '🛑 Controlador encerrado.'
        )
        break
      }
      // -----------------------------------------------
      // RECONNECT
      // -----------------------------------------------
      reconnectAttempts++
      const waitMs =
        Math.min(
          1000 *
            2 **
              reconnectAttempts,
          MAX_RECONNECT_DELAY_MS
        )
      console.log(
        `🔄 Reconectando em ${
          Math.round(
            waitMs / 1000
          )
        }s...`
      )
      await delay(
        waitMs
      )
    } catch (err) {
      console.error(
        '💥 Erro no controlador:',
        err?.stack || err
      )
      reconnectAttempts++
      const waitMs =
        Math.min(
          1000 *
            2 **
              reconnectAttempts,
          MAX_RECONNECT_DELAY_MS
        )
      console.log(
        `🔄 Nova tentativa em ${
          Math.round(
            waitMs / 1000
          )
        }s...`
      )
      await delay(
        waitMs
      )
    }
  }
  botControllerRunning =
    false
}
// ============================================================
// GLOBAL ERRORS
// ============================================================
process.on(
  'uncaughtException',
  err => {
    console.error(
      '💥 uncaughtException:',
      err?.stack || err
    )
  }
)
process.on(
  'unhandledRejection',
  err => {
    console.error(
      '💥 unhandledRejection:',
      err?.stack || err
    )
  }
)
// ============================================================
// START
// ============================================================
start()
