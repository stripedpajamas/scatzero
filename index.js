process.env.CHLORIDE_JS=1 // prefer pure JS crypto

const Diffy = require('diffy')
const Input = require('diffy/input')
const pino = require('pino')
const pull = require('pull-stream')
const connect = require('ssb-client')
const ref = require('ssb-ref')
const colors = require('colorette')
const wrap = require('word-wrap')
const { version } = require('./package.json')

// allow debugging on stderr with `--debug`
const dbg = process.argv.slice().includes('--debug') ? pino(pino.destination(2)) : { info: () => {}, error: () => {} }

const constants = {
  SYSTEM: 'scat',
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
    this.channelMsgs = new Map() // channel => [msgs]
    this.msgs = this.publicMsgs
    this.colorMap = {}
    this.nameMap = {}
  }

  goPrivate (recps) {
    const recpKey = recps.sort().toString()
    if (!this.privateMsgs.has(recpKey)) {
      this.privateMsgs.set(recpKey, [])
    }
    this.msgs = this.privateMsgs.get(recpKey)
  }

  goPublic () {
    this.msgs = this.publicMsgs
  }

  goChannel (channel) {
    if (!this.channelMsgs.has(channel)) {
      this.channelMsgs.set(channel, [])
    }
    this.msgs = this.channelMsgs.get(channel)
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
    if (msg.author === constants.SYSTEM) {
      this.msgs.push(msg) // wherever we are, put the system msg there
      return
    }
    if (msg.private) {
      const recpsKey = msg.recps.map(ref => ref.link).sort().toString()
      if (!this.privateMsgs.has(recpsKey)) {
        this.privateMsgs.set(recpsKey, [msg])
      } else {
        this.privateMsgs.get(recpsKey).push(msg)
        this.privateMsgs.get(recpsKey).sort((a, b) => a.sentAt - b.sentAt)
      }
    } else if (msg.channel) {
      if (!this.channelMsgs.has(msg.channel)) {
        this.channelMsgs.set(msg.channel, [msg])
      } else {
        this.channelMsgs.get(msg.channel).push(msg)
        this.channelMsgs.get(msg.channel).sort((a, b) => a.sentAt - b.sentAt)
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
    return Object.keys(this.nameMap).find(id => this.nameMap[id] === authorName) || authorName
  }

  getAuthorIds () {
    return Object.keys(this.nameMap)
  }

  getAuthorNames () {
    return Object.values(this.nameMap)
  }

  getChannels () {
    return [...this.channelMsgs.keys()]
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
          if (existingMsg.author === authorId) {
            existingMsg.author = authorName
          }
        }
      }
    }

    for (let channelMsgList of this.channelMsgs.values()) {
      for (let existingMsg of channelMsgList) {
        if (existingMsg.author === authorId) {
          existingMsg.author = authorName
        }
      }
    }
  }

  pretty (nonMsgSpace) {
    const msgList = this.msgs.map(({ author, timestamp, text }) => {
      const formattedTs = `[${gray(timestamp)}] `
      const shortAuthor = author.slice(0, 20)
      const formattedAuthor = `<${this.colorAuthor(shortAuthor)}> `
      const nonMsgPrefixSize = shortAuthor.length + 3 + timestamp.length + 3
      const wrappedText = wrap(text, {
        width: process.stdout.columns - nonMsgPrefixSize,
        indent: '',
        cut: true,
        trim: true,
        newline: `\n${' '.repeat(nonMsgPrefixSize)}`,
        escape: (line) => author === constants.SYSTEM ? bgYellow(black(line)) : white(line)
      })
      return `${formattedTs}${formattedAuthor}${wrappedText}`
    }).join('\n').split('\n')

    while (msgList.length > process.stdout.rows - nonMsgSpace) {
      msgList.shift() // remove single line from the top
    }

    while (msgList.length < process.stdout.rows - nonMsgSpace) {
      msgList.push('') // we also want to fill available space
    }

    return `${msgList.join('\n')}`
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

async function processor (diffy, input, server) {
  const msgs = new MessageStore()
  const meId = server.id

  let state = {
    recps: [],
    private: false,
    channel: ''
  }

  function header () {
    const inChannel = state.channel ? ` in ${state.channel}` : ''
    let recps = [...new Set(state.recps)].map((id) => `${msgs.getName(id)} (${id})`)
    const pubPriv = state.private ? `Chatting Privately with ${recps}` : `Chatting Publicly${inChannel}`
    const front = `scat ${version} `
    const hl = wrap(pubPriv, {
      width: process.stdout.columns - front.length,
      indent: ''
    }).split('\n').map(line => bgWhite(black(line))).join('\n')
    return `${front}${hl}\n`
  }

  function footer () {
    const foot = 'Commands: /private <name|id>  |  /public (leaves private or channel)  |  /channel <name>  (omit name for no channel)'
    return wrap(foot, { width: process.stdout.columns, indent: '' })
  }


  // setup ui
  diffy.render(() => {
    if (process.stdout.columns < constants.MIN_WIDTH) {
      return bgYellow(black('Terminal is too small'))
    }
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
            if (!authorName) return
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
        channel: msg.value.content.channel,
        recps: msg.value.content.recps,
        author: msgs.getName(msg.value.author) || msg.value.author,
        text: msg.value.content.text
      }
      msgs.addMsg(scatMsg)
      diffy.render()
    },
    outgoing: (line) => {
      if (!line || !line.trim()) return
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
            state.channel = ''
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
              msgs.addMsg(systemMsg(`Unknown identifier: ${recps.filter(recp => !ref.isFeed(recp))}`))
            } else {
              recps.push(meId)
              msgs.goPrivate(recps)
              state.private = true
              state.channel = ''
              state.recps = recps
            }
            break
          }
          case 'channel': {
            let channel = line.slice(cmdEnd).trim().split(' ').filter(x => x).shift()
            if (!channel || channel === '#') {
              msgs.goPublic()
              state.channel = ''
            } else {
              if (channel[0] !== '#') channel = `#${channel}`
              msgs.goChannel(channel)
              state.channel = channel
              state.private = false
              state.recps = []
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
          server.publish({ type: constants.MESSAGE_TYPE, text: line, channel: state.channel })
            .catch((err) => {
              msgs.addMsg(systemMsg('Failed to send message.'))
              diffy.render()
              dbg.error(err)
            })
        }
      }
    },
    tabComplete: (line) => {
      const split = line.split(' ')
      let beginning = split.slice(0, split.length - 1).join(' ')
      let lastWord = split[split.length - 1]
      let matches = []
      dbg.info({ line, split, beginning, lastWord })

      if (split.length === 1 && lastWord[0] === '/') { // command
        matches = ['/private ', '/public ', '/channel '].filter(cmd => cmd.startsWith(lastWord))
      } else if (lastWord[0] === '@') { // author id
        matches = msgs.getAuthorIds().filter(id => id.startsWith(lastWord))
      } else if (lastWord[0] === '#') { // channel name
        matches = msgs.getChannels().filter(name => name.startsWith(lastWord))
      } else { // author names
        matches = msgs.getAuthorNames().filter(name => name.startsWith(lastWord))
      }

      // keep a separation between what's being tab-completed and what came before
      if (beginning) {
        beginning = `${beginning} `
      }

      let idx = -1
      return () => {
        if (!matches.length) return line
        const match = matches[++idx % matches.length]
        return `${beginning}${match}`
      }
    }
  }
}

async function main () {
  // don't waste time on tight terms
  //  - we clip author names at 20
  //  - timestamps are localized using ts()
  //  - padding on authors and timestamps total to 6
  // make sure we can at least fit timestamp+author+5 char msg
  constants.MIN_WIDTH = 20 + ts(Date.now()).length + 6 + 5
  if (process.stdout.columns < constants.MIN_WIDTH) {
    console.error('scat requires a terminal width of at least %d', minWidth)
    return
  }

  let server
  try {
    server = await connect()
  } catch (err) {
    console.error(err)
    return
  }

  const since = Date.now() - constants.TIME_WINDOW
  const diffy = Diffy({ fullscreen: true })
  const input = Input()
  const { incoming, outgoing, tabComplete } = await processor(diffy, input, server)

  // setup input listeners
  let tabCompleter
  input.on('ctrl-c', () => {
    server.close()
    process.exit()
  })
  input.on('update', () => diffy.render())
  input.on('keypress', (_, key) => {
    // on any key press that isn't a tab, cancel tab completion
    if (!key || (key && key.name !== 'tab')) {
      tabCompleter = null
      diffy.render()
    }
  })
  input.on('tab', () => {
    if (!tabCompleter) {
      tabCompleter = tabComplete(input.rawLine())
    }
    input.set(tabCompleter())
  })
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
