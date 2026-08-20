// 截图脚本：用 Electron 离屏渲染真实页面（桌宠 + 聊天窗口），并合成 README 所需截图。
// 用法：./node_modules/.bin/electron scripts/capture.js
// 输出：docs/screenshots/{hero,conversation,workspace-model,states}.png
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'docs', 'screenshots')
const BG = '#eef4fb' // 浅蓝白背景，呼应蓝白像素主题
const PRELOAD = path.join(__dirname, 'capture-preload.cjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function capture(win) {
  const img = await win.webContents.capturePage()
  return img.toPNG()
}

// 在隐藏窗口里用 canvas 合成，返回 PNG。
// drawBody 运行在页面里，可用 ctx / done。
async function drawToPng(width, height, drawBody) {
  const win = new BrowserWindow({
    width, height, show: true, frame: false, backgroundColor: BG,
    webPreferences: { webSecurity: false },
  })
  await win.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:${BG}"><canvas id="c"></canvas></body>`))
  await sleep(120)
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const c = document.getElementById('c')
      c.width = ${width}; c.height = ${height}
      const ctx = c.getContext('2d')
      const done = () => resolve(true)
      ;(function draw() { ${drawBody} })()
    })
  `)
  const png = await capture(win)
  win.destroy()
  return png
}

function b64(p) { return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') }

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })

  // ── 1) 桌宠 ──
  const pet = new BrowserWindow({
    width: 240, height: 240, show: true, transparent: false, backgroundColor: BG,
    frame: false, webPreferences: { preload: PRELOAD, webSecurity: false },
  })
  await pet.loadFile(path.join(ROOT, 'index.html'))
  await sleep(1600)
  const petPng = await capture(pet)
  fs.writeFileSync(path.join(OUT, 'pet.png'), petPng)
  const petData = b64(path.join(OUT, 'pet.png'))

  // ── 2) 聊天窗口（高度贴合气泡）──
  const chat = new BrowserWindow({
    width: 400, height: 330, show: true, transparent: false, backgroundColor: BG,
    frame: false, webPreferences: { preload: PRELOAD, webSecurity: false },
  })
  await chat.loadFile(path.join(ROOT, 'chat.html'))
  await sleep(1600)
  const bubbleH = await chat.webContents.executeJavaScript(`document.querySelector('.bubble')?.offsetHeight || 0`)
  const chatH = Math.round(bubbleH + 16)
  chat.setSize(400, chatH)
  await sleep(400)
  const chatPng = await capture(chat)
  fs.writeFileSync(path.join(OUT, 'conversation.png'), chatPng)
  const chatData = b64(path.join(OUT, 'conversation.png'))

  // ── 3) Hero：聊天气泡在上，桌宠在下 ──
  const heroW = 440
  const heroH = chatH + 24 + 240 + 24
  const hero = await drawToPng(heroW, heroH, `
    ctx.fillStyle = '${BG}'; ctx.fillRect(0, 0, ${heroW}, ${heroH});
    const chat = new Image(); const pet = new Image(); let n = 0;
    const on = () => { if (++n !== 2) return;
      ctx.drawImage(chat, (${heroW} - 400) / 2, 12);
      ctx.drawImage(pet, (${heroW} - 240) / 2, 12 + ${chatH} + 12);
      done(); };
    chat.onload = on; pet.onload = on;
    chat.src = '${chatData}'; pet.src = '${petData}';
  `)
  fs.writeFileSync(path.join(OUT, 'hero.png'), hero)

  // ── 4) Workspace / Model：截取标题栏 + 会话导航条 ──
  const cropH = 66
  const wm = await drawToPng(400, cropH, `
    const chat = new Image();
    chat.onload = () => { ctx.drawImage(chat, 0, 0, 400, ${cropH}, 0, 0, 400, ${cropH}); done(); };
    chat.src = '${chatData}';
  `)
  fs.writeFileSync(path.join(OUT, 'workspace-model.png'), wm)

  // ── 5) 角色状态：待机 / 走路 / 睡觉（真实动画帧，各取一帧）──
  const stills = [
    { label: 'idle', file: path.join(ROOT, 'Deepseek', 'animations', 'Breathing_Idle', 'south', 'frame_000.png') },
    { label: 'walk', file: path.join(ROOT, 'Deepseek', 'animations', 'Crouched_Walking', 'south', 'frame_002.png') },
    { label: 'sleep', file: path.join(ROOT, 'Deepseek', 'animations', 'Close_eyes_and_sleeping', 'south', 'frame_004.png') },
  ]
  const sw = 200, sh = 200, gap = 16, pad = 16
  const statesW = pad + (sw + gap) * stills.length
  const statesH = sh + 44
  const stillData = stills.map((s) => b64(s.file))
  const states = await drawToPng(statesW, statesH, `
    ctx.fillStyle = '${BG}'; ctx.fillRect(0, 0, ${statesW}, ${statesH});
    const imgs = []; let loaded = 0;
    const srcs = ${JSON.stringify(stillData)};
    srcs.forEach((src, i) => { const im = new Image(); im.onload = () => { if (++loaded === srcs.length) {
      const labels = ${JSON.stringify(stills.map((s) => s.label))};
      ctx.font = '12px sans-serif'; ctx.fillStyle = '#1f3a5c'; ctx.textAlign = 'center';
      srcs.forEach((_, j) => {
        const x = ${pad} + j * (${sw} + ${gap});
        ctx.drawImage(imgs[j], x, 24, ${sw}, ${sh});
        ctx.fillText(labels[j], x + ${sw} / 2, 12);
      });
      done();
    } }; im.onerror = () => done(); im.src = src; imgs.push(im); });
  `)
  fs.writeFileSync(path.join(OUT, 'states.png'), states)

  console.log('截图完成 →', OUT)
  app.quit()
}).catch((e) => { console.error(e); app.exit(1) })
