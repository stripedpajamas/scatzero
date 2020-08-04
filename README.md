# scat
## tiny chat-like CLI built on scuttlebutt

### Requirements:
- scuttlebutt server running (like Patchwork or Patchbay)
- ssb-private and ssb-about plugins installed

### Install
- Prebuilt: download from https://squi.cc/misc/scat.html
- Run from source: clone this repo, run `npm install`, then `node index.js`

### Shortcuts
Since `scat` uses `neat-input`, you can use these shortcuts while typing:

- `ctrl-a` move the cursor to the beginning of the line
- `ctrl-e` move the cursor to the end of the line
- `ctrl-b` move the cursor one character to the left
- `ctrl-f` move the cursor one character to the right
- `ctrl-k` erase all characters to the right of the cursor
- `ctrl-u` erase the whole line
- `ctrl-w` erase one word to the left of the cursor
- `alt-backspace` same as ctrl-w
- `alt-d` erase one word to the right of the cursor
- `alt-b` move the cursor one word to the left
- `alt-f` move the cursor one word to the right

### See Also
- https://cabal.chat/ -- p2p chat on Dat
- https://github.com/orbitdb/orbit -- p2p chat on IPFS
- https://github.com/clevinson/scuttle-chat -- ephemeral chats on Scuttlebutt

### License
AGPL 3.0
