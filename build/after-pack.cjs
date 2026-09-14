// electron-builder 的 afterPack 钩子：打包完成后精简运行时
// 详见 trim-electron.cjs 里的说明（砍什么、为什么、刻意不砍什么）
const path = require('node:path')
const { trimDir } = require(path.join(__dirname, 'trim-electron.cjs'))

module.exports = async function afterPack(context) {
  const dir = context.appOutDir
  const r = trimDir(dir)
  if (r.skipped) { console.log('  [trim] 跳过（目录不存在）'); return }
  console.log('  [trim] 删除 ' + r.removed + ' 个文件，省 ' + r.saved.toFixed(1) + ' MB')
}
