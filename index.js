const Diffy = require('diffy')
const input = require('diffy/input')()
const pino = require('pino')
const pull = require('pull-stream')
const connect = require('ssb-client')
const colors = require('colorette')
const wrap = require('word-wrap')

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
    this.msgs = []
    this.colorMap = {}
    this.nameMap = {}
    this.realMsgLength = 0
  }

  getMaxMsgs () {
    return process.stdout.rows - 3
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
    this.msgs.push(msg)
    this.msgs.sort((a, b) => a.sentAt - b.sentAt)
    this.pretty() // calculates real msg length

    if (this.realMsgLength > this.getMaxMsgs()) {
      this.msgs.shift() // take one off the top
    }
  }

  getName (authorId) {
    return this.nameMap[authorId]
  }

  identifyAuthor (authorId, authorName) {
    this.nameMap[authorId] = authorName
    if (this.colorMap[authorId]) {
      this.colorMap[authorName] = this.colorMap[authorId]
    }

    // find instances of the ID in the msg list and change it to name
    for (let existingMsg of this.msgs) {
      if (existingMsg.author === authorId) {
        existingMsg.author = authorName
      }
    }
  }

  pretty () {
    const msgList = this.msgs.map(({ author, timestamp, text }) => {
      const formattedTs = `[${gray(timestamp)}] `
      const formattedAuthor = `${this.colorAuthor(author)}: `
      const wrappedText = wrap(text, { width: process.stdout.columns - formattedTs.length - formattedAuthor.length, indent: '' })
      const formattedText = wrappedText.split('\n')
        .map(line => author === constants.SYSTEM ? bgYellow(black(line)) : white(line))
        .join('\n')
      return `${formattedTs}${formattedAuthor}${formattedText}`
    }).join('\n')
    const lines = msgList.split('\n').length
    const space = this.getMaxMsgs() - lines
    const spaceLines = space > 0 ? '\n'.repeat(space) : ''

    this.realMsgLength = lines

    dbg.info('we believe there are %d lines so we made %d lines of space', lines, spaceLines.length)

    return `${msgList}${spaceLines}`
  }
}


function ts (timestamp) {
  const ts = new Date(timestamp)
  return new Intl.DateTimeFormat('default', constants.DATE_TIME_OPTS).format(ts) // TODO allow timezone to be configured
}

async function processor (diffy, server) {
  const msgs = new MessageStore()
  const meId = server.id

  // setup ui
  diffy.render(() => `${msgs.pretty()}\n> ${input.line()}`)

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
            dbg.info({ colorMap, msgs })
            break
          }
        }
      } else {
        server.publish({ type: constants.MESSAGE_TYPE, text: line })
          .catch((err) => {
            msgs.push({
              timestamp: ts(Date.now()),
              sentAt: msg.value.timestamp,
              author: constants.SYSTEM,
              text: 'Failed to post message.'
            })
            diffy.render()
            dbg.error(err)
          })
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
