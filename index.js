/**
 * ============================================================
 * SYNTRAXBOT - BAILEYS
 * ============================================================
 *
 * Node.js 20+
 * Baileys 6.7.24
 *
 * Recursos:
 *  - Pairing Code
 *  - Sessão persistente
 *  - Reconexão automática
 *  - ?menu / ?help
 *  - Menu por enquete
 *  - ?sticker / ?s / ?fig
 *  - ?img / ?toimg / ?imagem
 *  - ?ban
 *  - ?promote
 *  - ?demote
 *  - ?everyone / ?all
 *  - ?ping
 *  - ?uptime
 *  - ?info
 *  - ?execute / ?exec / ?eval
 *
 * ============================================================
 */

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
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
 * ============================================================
 * RAILWAY
 * ============================================================
 *
 * Se você tiver um Volume Railway montado em /data,
 * use:
 *
 * const SESSION_DIR = '/data/auth_info_baileys'
 *
 * Se NÃO tiver Volume, pode deixar o caminho abaixo,
 * mas a sessão será perdida quando o container for recriado.
 */

// const SESSION_DIR = '/data/auth_info_baileys'

const SESSION_DIR = path.join(
  __dirname,
  'auth_info_baileys'
)

const MAX_RECONNECT_DELAY_MS = 30000

const DEBUG = true

// ============================================================
// LOGGER
// ============================================================

const logger = pino({
  level: DEBUG ? 'info' : 'silent'
})

// ============================================================
// ESTADO GLOBAL
// ============================================================

const activeMenus = new Map()

const startTime = Date.now()

let botRunning = false
let reconnectAttempts = 0

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
    `• ${PREFIX}sticker - imagem → figurinha\n` +
    `• ${PREFIX}s - imagem → figurinha\n` +
    `• ${PREFIX}fig - imagem → figurinha\n` +
    `• ${PREFIX}img - figurinha → imagem\n` +
    `• ${PREFIX}toimg - figurinha → imagem`,

  '🛡️ Administração':
    '🛡️ *ADMINISTRAÇÃO*\n\n' +
    `• ${PREFIX}ban @usuario\n` +
    `• ${PREFIX}promote @usuario\n` +
    `• ${PREFIX}demote @usuario\n` +
    `• ${PREFIX}everyone mensagem`,

  '🔧 Utilitários':
    '🔧 *UTILITÁRIOS*\n\n' +
    `• ${PREFIX}ping\n` +
    `• ${PREFIX}uptime\n` +
    `• ${PREFIX}info`,

  'ℹ️ Sobre o Bot':
    'ℹ️ *SOBRE*\n\n' +
    'SyntraXBot\n' +
    'WhatsApp Bot usando Baileys.\n\n' +
    `Prefixo: *${PREFIX}*`
}

// ============================================================
// HELPERS
// ============================================================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeJid(jid = '') {
  return String(jid).replace(/:\d+(?=@)/, '')
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
// GROUP INFO
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

  // Mensagem respondida
  if (
    quotedMessage &&
    quotedMessage[mediaType]
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

  // Mídia diretamente enviada
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
            '📋 MENU PRINCIPAL - Escolha uma categoria:',

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
    `[MENU] Criado: ${pollMsg.key.id}`
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
      await getAggregateVotesInPollMessage({
        message:
          session.pollMsg.message,

        pollUpdates:
          ownerVotes
      })

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
      '[POLL ERROR]',
      err?.stack || err
    )
  }
}

async function handlePollFromUpsert(
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
            `❌ Responda uma imagem com *${PREFIX}sticker*.`
        },
        {
          quoted: msg
        }
      )

      return
    }

    const webp =
      await sharp(buffer)
        .resize(
          512,
          512,
          {
            fit: 'fill'
          }
        )
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
          `❌ Erro ao criar figurinha:\n\n${err.message}`
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
            `❌ Responda uma figurinha com *${PREFIX}img*.`
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
          `❌ Erro ao converter figurinha:\n\n${err.message}`
      },
      {
        quoted: msg
      }
    )
  }
}

// ============================================================
// GROUP ACTION
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
            '❌ Eu preciso ser administrador do grupo.'
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
            `❌ Marque alguém.\n\nExemplo: *${PREFIX}${action} @usuario*`
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

    const responses = {

      remove:
        '✅ Membro removido!',

      promote:
        '✅ Membro promovido a administrador!',

      demote:
        '✅ Administrador rebaixado!'
    }

    await sock.sendMessage(
      chatId,
      {
        text:
          responses[action]
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
          `❌ Erro:\n\n${err.message}`
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
        p => p.id
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
          `❌ Responda uma mensagem com *${PREFIX}info*.`
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

  const MAX =
    3500

  const output =
    json.length > MAX
      ? `${json.slice(0, MAX)}\n\n... JSON cortado.`
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
// EXECUTE
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
    normalizeJid(
      senderJid
    )

  const owner =
    normalizeJid(
      OWNER_JID
    )

  const authorized =
    !isGroup &&
    sender === owner

  console.log(
    `[EXEC] sender=${sender} owner=${owner} authorized=${authorized}`
  )

  if (!authorized) {
    return
  }

  if (!code) {

    await sock.sendMessage(
      chatId,
      {
        text:
          `Uso:\n\n${PREFIX}exec <código JS>\n\n` +
          `Variáveis:\n` +
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
// CREATE SOCKET
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
    '========================================'
  )

  console.log(
    '📁 Sessão:',
    SESSION_DIR
  )

  console.log(
    '📄 creds.json:',
    fs.existsSync(credsPath)
      ? 'EXISTE'
      : 'NÃO EXISTE'
  )

  console.log(
    '========================================'
  )

  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      SESSION_DIR
    )

  /*
   * Busca a versão atual do WhatsApp Web
   * suportada pelo Baileys.
   */
  let version

  try {

    const latest =
      await fetchLatestBaileysVersion()

    version =
      latest.version

    console.log(
      `🌐 WhatsApp Web: ${version.join('.')}`
    )

    console.log(
      `🌐 isLatest: ${latest.isLatest}`
    )

  } catch (err) {

    console.log(
      '⚠️ Não consegui buscar versão do WhatsApp Web.'
    )

    console.log(
      '⚠️ Usando versão padrão do Baileys.'
    )

    version =
      undefined
  }

  const sock =
    makeWASocket({

      ...(version
        ? { version }
        : {}),

      auth: state,

      /*
       * IMPORTANTE:
       *
       * Chrome é utilizado deliberadamente.
       * O WhatsApp passou a rejeitar determinados
       * identificadores "Desktop" em algumas situações.
       */
      browser:
        Browsers.ubuntu('Chrome'),

      printQRInTerminal:
        false,

      syncFullHistory:
        false,

      markOnlineOnConnect:
        false,

      connectTimeoutMs:
        60000,

      defaultQueryTimeoutMs:
        60000,

      keepAliveIntervalMs:
        30000,

      logger
    })

  /*
   * Salva TODA alteração das credenciais.
   *
   * Isso é fundamental para o pairing.
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

  /*
   * Guardamos o state no próprio socket apenas
   * para os handlers internos desta aplicação.
   *
   * NÃO usamos isso como fonte oficial da sessão.
   */
  sock.__authState =
    state

  return sock
}

// ============================================================
// CONNECTION + PAIRING
// ============================================================

function setupConnection(
  sock
) {

  let pairingRequested =
    false

  let closed =
    false

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

          /*
           * --------------------------------------------------
           * DEBUG
           * --------------------------------------------------
           */

          if (DEBUG) {

            console.log(
              '[CONNECTION]',
              {
                connection,
                qr: Boolean(qr),
                registered:
                  Boolean(
                    sock.__authState
                      ?.creds
                      ?.registered
                  )
              }
            )
          }

          /*
           * --------------------------------------------------
           * PAIRING CODE
           * --------------------------------------------------
           *
           * O exemplo oficial do Baileys dispara o
           * requestPairingCode quando recebe o evento qr.
           *
           * Isso é importante.
           */
          if (
            qr &&
            !sock.__authState.creds.registered &&
            !pairingRequested
          ) {

            pairingRequested =
              true

            try {

              const number =
                PHONE_NUMBER.replace(
                  /\D/g,
                  ''
                )

              console.log('')
              console.log(
                '📱 Solicitando Pairing Code...'
              )

              console.log(
                '📱 Número:',
                number
              )

              const code =
                await sock.requestPairingCode(
                  number
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

              console.error(
                '❌ Erro ao solicitar Pairing Code:',
                err?.stack || err
              )

              /*
               * Permite tentar novamente se o socket
               * continuar vivo.
               */
              pairingRequested =
                false
            }
          }

          /*
           * --------------------------------------------------
           * CONNECTED
           * --------------------------------------------------
           */

          if (
            connection === 'open'
          ) {

            reconnectAttempts =
              0

            console.log('')
            console.log(
              '========================================'
            )

            console.log(
              '✅ WHATSAPP CONECTADO!'
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

            resolve({
              shouldReconnect:
                false,

              shouldWipeSession:
                false,

              statusCode:
                null
            })

            return
          }

          /*
           * --------------------------------------------------
           * CLOSED
           * --------------------------------------------------
           */

          if (
            connection === 'close' &&
            !closed
          ) {

            closed =
              true

            const error =
              lastDisconnect?.error

            let statusCode =
              null

            if (
              error instanceof Boom
            ) {

              statusCode =
                error.output?.statusCode

            } else {

              statusCode =
                error?.output?.statusCode ||
                error?.statusCode ||
                null
            }

            const reason =
              error?.message ||
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
              error?.stack
            ) {

              console.log(
                error.stack
              )
            }

            /*
             * LOGGED OUT
             *
             * Só aqui devemos apagar a sessão
             * automaticamente.
             */
            if (
              statusCode ===
              DisconnectReason.loggedOut
            ) {

              console.log(
                '🔐 WhatsApp deslogou a sessão.'
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

            /*
             * BAD SESSION
             */
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

            /*
             * CONNECTION REPLACED
             */
            if (
              statusCode ===
              DisconnectReason.connectionReplaced
            ) {

              console.log(
                '⚠️ Outra instância substituiu esta sessão.'
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

            /*
             * TODOS OS OUTROS CASOS
             *
             * 408
             * 428
             * 515
             * 503
             * 500
             * connectionClosed
             * connectionLost
             *
             * NÃO apagamos a sessão.
             *
             * O socket será recriado e a sessão
             * será carregada novamente do disco.
             */
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
// MESSAGE HANDLERS
// ============================================================

function setupMessageHandlers(
  sock
) {

  // ==========================================================
  // POLLS
  // ==========================================================

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

  // ==========================================================
  // MESSAGES
  // ==========================================================

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

          if (
            msg.key.fromMe
          ) {
            continue
          }

          if (
            msg.key.remoteJid ===
            'status@broadcast'
          ) {
            continue
          }

          /*
           * Poll fallback
           */
          if (
            msg.message
              .pollUpdateMessage
          ) {

            await handlePollFromUpsert(
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

          const commandText =
            text.slice(
              PREFIX.length
            )

          const parts =
            commandText
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

            // ==========================================
            // MENU
            // ==========================================

            case 'menu':
            case 'help':

              await sendMenu(
                sock,
                msg,
                chatId,
                senderJid
              )

              break

            // ==========================================
            // STICKER
            // ==========================================

            case 'sticker':
            case 's':
            case 'fig':

              await handleStickerCreate(
                sock,
                msg,
                chatId
              )

              break

            // ==========================================
            // IMG
            // ==========================================

            case 'img':
            case 'toimg':
            case 'imagem':

              await handleStickerToImage(
                sock,
                msg,
                chatId
              )

              break

            // ==========================================
            // BAN
            // ==========================================

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

            // ==========================================
            // PROMOTE
            // ==========================================

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

            // ==========================================
            // DEMOTE
            // ==========================================

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

            // ==========================================
            // EVERYONE
            // ==========================================

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

            // ==========================================
            // PING
            // ==========================================

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

            // ==========================================
            // UPTIME
            // ==========================================

            case 'uptime':

              await sock.sendMessage(
                chatId,
                {
                  text:
                    `⏱️ Bot rodando há ${formatUptime(
                      Date.now() -
                      startTime
                    )}`
                },
                {
                  quoted: msg
                }
              )

              break

            // ==========================================
            // INFO
            // ==========================================

            case 'info':

              await handleInfo(
                sock,
                msg,
                chatId
              )

              break

            // ==========================================
            // EXECUTE
            // ==========================================

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
      `🗑️ Sessão apagada: ${SESSION_DIR}`
    )

  } catch (err) {

    console.error(
      '❌ Erro apagando sessão:',
      err?.stack || err
    )
  }
}

// ============================================================
// MAIN
// ============================================================

async function startBot() {

  if (botRunning) {
    return
  }

  botRunning =
    true

  console.log('')
  console.log(
    '🚀 Iniciando SyntraXBot...'
  )

  console.log(
    '📦 Baileys: 6.7.24'
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

      /*
       * Eventos de mensagem ficam registrados
       * antes de conectar.
       */
      setupMessageHandlers(
        sock
      )

      /*
       * Espera conexão fechar ou abrir.
       */
      const result =
        await setupConnection(
          sock
        )

      /*
       * Sessão inválida:
       * apaga e começa pairing novamente.
       */
      if (
        result.shouldWipeSession
      ) {

        await wipeSession()

        reconnectAttempts =
          0

        await delay(1000)

        continue
      }

      /*
       * Sessão substituída.
       */
      if (
        !result.shouldReconnect
      ) {

        console.log(
          '🛑 Bot encerrado.'
        )

        break
      }

      /*
       * Reconexão.
       */
      reconnectAttempts++

      const wait =
        Math.min(
          1000 *
            Math.pow(
              2,
              reconnectAttempts
            ),
          MAX_RECONNECT_DELAY_MS
        )

      console.log(
        `🔄 Reconectando em ${Math.round(
          wait / 1000
        )}s...`
      )

      await delay(wait)

    } catch (err) {

      console.error(
        '💥 Erro no controlador:',
        err?.stack || err
      )

      reconnectAttempts++

      const wait =
        Math.min(
          1000 *
            Math.pow(
              2,
              reconnectAttempts
            ),
          MAX_RECONNECT_DELAY_MS
        )

      console.log(
        `🔄 Tentando novamente em ${Math.round(
          wait / 1000
        )}s...`
      )

      await delay(wait)
    }
  }

  botRunning =
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

startBot()
