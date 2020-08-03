const Diffy = require('diffy')
const input = require('diffy/input')()
const pino = require('pino')
const pull = require('pull-stream')
const connect = require('ssb-client')
const ref = require('ssb-ref')
const colors = require('colorette')
const wrap = require('word-wrap')
const { version } = require('./package.json')

const dbg = pino(pino.destination(2)) // log to stderr

const constants = {
  SYSTEM: '<scat>',
  DATE_TIME_OPTS: {
    month: 'numeric',
    year: 'numeric',
    day: 'numeric',
    hour: 'numeric', 
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  },
  MESSAGE_TYPE: 'scat_message',
  MODE: {
    PUBLIC: 'PUBLIC',
    PRIVATE: 'PRIVATE'
  },
  PROGRAM_DIR: '.scat',
  TIME_WINDOW: 7 * 24 * 60 * 60 * 1000, // 7 days
}

const { gray, whiteBright: white, bold, black, bgWhite, bgYellow } = colors

function randomColor () {
  const colorList = ['green', 'cyan', 'magenta', 'blue', 'red']
  return colorList[Math.floor(Math.random() * colorList.length)]
}

class MessageStore {
  constructor () {
    this.publicMsgs = []
    this.privateMsgs = new Map() // [recps] => [msgs]
    this.msgs = this.publicMsgs
    this.colorMap = {}
    this.nameMap = {}
    this.realMsgLength = 0
  }

  goPrivate (recps) {
    dbg.info([...this.privateMsgs.entries()])
    const recpKey = recps.sort().toString()
    if (!this.privateMsgs.has(recpKey)) {
      this.privateMsgs.set(recpKey, [])
    }
    this.msgs = this.privateMsgs.get(recpKey)
  }

  goPublic () {
    this.msgs = this.publicMsgs
  }
  
  getAuthorColor (author) {
    if (!this.colorMap[author]) {
      this.colorMap[author] = randomColor()
    }
    return this.colorMap[author]
  }

  colorAuthor (author) {
    return `${bold(colors[this.getAuthorColor(author)](author))}`
  }

  addMsg (msg) {
    if (msg.private) {
      const recpsKey = msg.recps.map(ref => ref.link).sort().toString()
      if (!this.privateMsgs.has(recpsKey)) {
        this.privateMsgs.set(recpsKey, [msg])
      } else {
        this.privateMsgs.get(recpsKey).push(msg)
        this.privateMsgs.get(recpsKey).sort((a, b) => a.sentAt - b.sentAt)
      }
    } else {
      this.publicMsgs.push(msg)
      this.publicMsgs.sort((a, b) => a.sentAt - b.sentAt)
    }
  }

  getName (authorId) {
    return this.nameMap[authorId]
  }

  getId (authorName) {
    if (ref.isFeed(authorName)) return authorName
    return Object.keys(this.nameMap).find(id => this.nameMap[id] === authorName)
  }

  identifyAuthor (authorId, authorName) {
    this.nameMap[authorId] = authorName
    if (this.colorMap[authorId]) {
      this.colorMap[authorName] = this.colorMap[authorId]
    }

    // find instances of the ID in the msg list and change it to name
    for (let existingMsg of this.publicMsgs) {
      if (existingMsg.author === authorId) {
        existingMsg.author = authorName
      }
    }

    for (let [recps, privateMsgList] of this.privateMsgs.entries()) {
      if (recps.includes(authorId)) {
        for (let existingMsg of privateMsgList) {
          existingMsg.author = authorName
        }
      }
    }

  }

  pretty (nonMsgSpace) {
    const msgList = this.msgs.map(({ author, timestamp, text }) => {
      const formattedTs = `[${gray(timestamp)}] `
      const formattedAuthor = `${this.colorAuthor(author)}: `
      const wrappedText = wrap(text, {
        width: process.stdout.columns - (author.length + 2) - (timestamp.length + 3),
        indent: '',
        cut: true
      })
      const formattedText = wrappedText.split('\n')
        .map(line => author === constants.SYSTEM ? bgYellow(black(line)) : white(line))
        .join('\n')
      return `${formattedTs}${formattedAuthor}${formattedText}`
    }).join('\n').split('\n')

    while (msgList.length > process.stdout.rows - nonMsgSpace) {
      msgList.shift() // remove single line from the top
    }

    return `${msgList.join('\n')}`//${spaceLines}`
  }
}


function ts (timestamp) {
  const ts = new Date(timestamp)
  return new Intl.DateTimeFormat('default', constants.DATE_TIME_OPTS).format(ts) // TODO allow timezone to be configured
}

function systemMsg (msg) {
  return { timestamp: ts(Date.now()), sentAt: Date.now(), author: constants.SYSTEM, text: msg }
}

function lineSize (args) {
  return args.reduce((total, arg) => total + arg.split('\n').length, 0)
}

async function processor (diffy, server) {
  const msgs = new MessageStore()
  const meId = server.id

  let state = {
    recps: [],
    private: false
  }

  function header () {
    const inChannel = state.channel ? ` in ${state.channel}` : ''
    let recps = state.recps.slice()
    for (let i = 0; i < recps.length; i++) {
      if (recps[i] === meId) {
        recps.splice(i, 1) // remove exactly one instance of myself
        break
      }
    }
    recps = recps.map((id) => `${msgs.getName(id)} (${id})`)
    const pubPriv = state.private ? `Chatting Privately with ${recps}` : `Chatting Publicly${inChannel}`
    const front = `scat ${version} `
    const hl = wrap(pubPriv, {
      width: process.stdout.columns - front.length,
      indent: ''
    }).split('\n').map(line => bgWhite(black(line))).join('\n')
    return `${front}${hl}\n`
  }

  function footer () {
    return 'Commands: /private <name|id>  /public  /channel <name>\n'
  }


  // setup ui
  diffy.render(() => {
    const head = header()
    const foot = footer()
    const inputLine = input.line()
    const inputLineWrapped = wrap(inputLine, { width: process.stdout.columns - 2, indent: '', cut: true }) // 2 == '> '.length
    const msgList = msgs.pretty(lineSize([head, foot, inputLineWrapped]))
    return `${head}${msgList}\n\n${foot}\n> ${inputLine}`
  })

  return {
    incoming: (msg) => {
      if (!msg || !msg.value || !msg.value.content || msg.value.content.type !== constants.MESSAGE_TYPE) {
        return
      }

      // if we don't know author name already, try to get it
      if (!msgs.getName(msg.value.author) && server.about) {
        server.about.socialValue({ key: 'name', dest: msg.value.author })
          .then((authorName) => {
            msgs.identifyAuthor(msg.value.author, authorName)
            diffy.render()
          })
          .catch((err) => {
            dbg.error(err)
          })
      }
        
      const scatMsg = {
        timestamp: ts(msg.value.timestamp),
        sentAt: msg.value.timestamp,
        private: msg.value.private,
        recps: msg.value.content.recps,
        author: msgs.getName(msg.value.author) || msg.value.author,
        text: msg.value.content.text
      }
      msgs.addMsg(scatMsg)
      diffy.render()
    },
    outgoing: (line) => {
      // handle commands
      if (line && line[0] === '/') {
        const wordBreak = line.indexOf(' ')
        const cmdEnd = wordBreak > 0 ? wordBreak : line.length
        switch (line.substring(1, cmdEnd)) {
          case 'debug': {
            dbg.info(msgs)
            dbg.info(state)
            break
          }
          case 'public': {
            msgs.goPublic()
            state.private = false
            state.recps = []
            break
          }
          case 'private': {
            const recps = line.slice(cmdEnd).trim().split(' ').filter(x => x).map(nameOrId => msgs.getId(nameOrId))
            if (recps.length > 7) {
              msgs.addMsg(systemMsg('Can only private message up to 7 recipients.'))
            } else if (!server.private) {
              msgs.addMsg(systemMsg('ssb-private plugin required to send private messages.'))
            } else if (!recps.length) {
              msgs.addMsg(systemMsg('Recipient name or id required.'))
            } else if (!recps.every(recp => ref.isFeed(recp))) {
              msgs.addMsg(systemMsg('Unknown identifier'))
            } else {
              recps.push(meId)
              msgs.goPrivate(recps)
              state.private = true
              state.recps = recps
            }
            break
          }
        }
      } else {
        if (state.private) {
          const recpLinks = state.recps.map((id) => ({ link: id }))
          server.private.publish({ type: constants.MESSAGE_TYPE, text: line, recps: recpLinks }, state.recps)
            .catch((err) => {
              msgs.addMsg(systemMsg('Failed to send private message.'))
              diffy.render()
              dbg.error(err)
            })
        } else {
          server.publish({ type: constants.MESSAGE_TYPE, text: line })
            .catch((err) => {
              msgs.addMsg(systemMsg('Failed to send message.'))
              diffy.render()
              dbg.error(err)
            })
        }
      }
    }
  }
}

async function main () {
  let server
  try {
    server = await connect()
  } catch (err) {
    console.error(err)
  }

  const since = Date.now() - constants.TIME_WINDOW
  const diffy = Diffy({ fullscreen: true })
  const { incoming, outgoing } = await processor(diffy, server)
  // setup input listeners
  input.on('update', () => diffy.render())
  input.on('enter', outgoing)

  // pull data from sbot
  pull(
    server.query.read({
      reverse: true,
      live: true,
      query: [{
        $filter: {
          value: {
            content: { type: constants.MESSAGE_TYPE },
            timestamp: { $gte: since }
          }
        }
      }]
    }),
    pull.drain(incoming)
  )
}

main()
