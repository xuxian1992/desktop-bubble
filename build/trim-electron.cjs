// 打包后精简 Electron 运行时
//
// ⚠️ 绝不改动 electron.exe —— 它的哈希必须与 Electron 官方一致，
//    那是「免安装版能绕开智能应用控制」的全部依据。只删无关文件。
//
// 砍哪些、为什么：
//   locales/*.pak（除 zh-CN / en-US）  ~46 MB   Chromium 找不到语言包时回退到内置默认，无风险
//   LICENSES.chromium.html             ~19.5 MB 纯文本许可证，运行用不到
//
// 刻意不砍的：
//   vk_swiftshader.dll / dxcompiler.dll —— 省 30 MB，但前者是「没有 GPU 时的软件渲染回退」，
//   删了在显卡驱动异常的机器上可能直接花屏/白屏。为省这点体积去赌用户的显卡，不值。
const fs = require('node:fs')
const path = require('node:path')

function trimDir(dir) {
  if (!fs.existsSync(dir)) return { skipped: true }
  let saved = 0
  let removed = 0

  const loc = path.join(dir, 'locales')
  if (fs.existsSync(loc)) {
    for (const f of fs.readdirSync(loc)) {
      if (f === 'zh-CN.pak' || f === 'en-US.pak') continue
      const p = path.join(loc, f)
      try { saved += fs.statSync(p).size; fs.unlinkSync(p); removed += 1 } catch (e) {}
    }
  }

  const lic = path.join(dir, 'LICENSES.chromium.html')
  if (fs.existsSync(lic)) {
    try { saved += fs.statSync(lic).size; fs.unlinkSync(lic); removed += 1 } catch (e) {}
  }

  return { saved: saved / 1048576, removed: removed }
}

if (require.main === module) {
  const target = process.argv[2]
  if (!target) { console.log('用法: node trim-electron.cjs <electron 目录>'); process.exit(1) }
  const r = trimDir(target)
  console.log('  精简 ' + target + '  删除 ' + r.removed + ' 个文件  省 ' + (r.saved || 0).toFixed(1) + ' MB')
}

module.exports = { trimDir }
