// 动作素材标准化脚本：统一 animations/<名字>/south/frame_NNN.png 的格式。
// 用法：node normalize-animations.mjs [素材根目录]
// 依赖：sharp（`npm i sharp` 后运行）。缺少 sharp 时仍会做校验与报告，只是跳过 GIF 拆帧。
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.argv[2] || '/Users/benjamin/Desktop/A_cute_chibi_pixel_art-Deepseek'
const DIR = 'south' // 方向（与 pet.config.json 的 direction 一致）
const animDir = path.join(ROOT, 'Deepseek', 'animations')

let sharp = null
try {
  sharp = (await import('sharp')).default
} catch {
  console.log('⚠️  未安装 sharp：跳过 GIF 拆帧（其余校验照常）。安装：npm i sharp\n')
}

const pad = (i) => String(i).padStart(3, '0')
const names = (await readdir(animDir)).filter((n) => !n.startsWith('.'))

const report = []
for (const name of names) {
  const folder = path.join(animDir, name)
  const st = await stat(folder)
  if (!st.isDirectory()) continue

  // 1) GIF → PNG 拆帧
  const gif = path.join(folder, name + '.gif')
  if (existsSync(gif) && sharp) {
    const outDir = path.join(folder, DIR)
    await mkdir(outDir, { recursive: true })
    const meta = await sharp(gif).metadata()
    for (let i = 0; i < meta.pages; i++) {
      await sharp(gif, { page: i }).png().toFile(path.join(outDir, `frame_${pad(i)}.png`))
    }
    console.log(`🔄 ${name}: 已把 GIF 拆成 ${meta.pages} 帧 → ${name}/${DIR}/frame_*.png`)
  } else if (existsSync(gif) && !sharp) {
    console.log(`⏭️  ${name}: 有 ${name}.gif 但未装 sharp，跳过拆帧`)
  }

  // 2) 校验帧序列
  const south = path.join(folder, DIR)
  if (!existsSync(south)) {
    report.push({ name, ok: false, reason: `缺少 ${DIR}/ 目录` })
    continue
  }
  const files = (await readdir(south)).filter((f) => f.endsWith('.png')).sort()
  let ok = true
  const expected = (i) => `frame_${pad(i)}.png`
  for (let i = 0; i < files.length; i++) {
    if (files[i] !== expected(i)) { ok = false; break }
  }
  // 检查是否有非 png 残留
  const others = (await readdir(south)).filter((f) => !f.endsWith('.png'))
  report.push({ name, ok: ok && others.length === 0, count: files.length, reason: !ok ? `帧命名不连续或缺失（应从 frame_000.png 起连续）` : (others.length ? `有非 png 文件: ${others.join(', ')}` : '') })
}

console.log('\n=== 动作目录校验报告 ===')
for (const r of report) {
  const mark = r.ok ? '✅' : '❌'
  const size = r.count !== undefined ? `${r.count} 帧` : ''
  console.log(`${mark} ${r.name.padEnd(26)} ${size} ${r.ok ? '' : '→ ' + r.reason}`)
}
console.log('\n提示：把上面每个名字的「帧数」填进 pet.config.json 的 animations.<名字>.count；帧率(fps)按动作节奏自定。')
