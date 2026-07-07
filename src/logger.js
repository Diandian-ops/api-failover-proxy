// 简单日志器：带时间戳和上游名称前缀
const ts = () => new Date().toISOString().replace('T', ' ').replace('Z', '')

export const log = {
  info: (...args) => console.log(`[${ts()}] [INFO]`, ...args),
  warn: (...args) => console.warn(`[${ts()}] [WARN]`, ...args),
  error: (...args) => console.error(`[${ts()}] [ERROR]`, ...args),
  debug: (...args) => {
    if (process.env.DEBUG) console.log(`[${ts()}] [DEBUG]`, ...args)
  }
}
