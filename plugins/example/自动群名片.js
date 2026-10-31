import plugin from "../../lib/plugins/plugin.js"
import fs from "node:fs"
import YAML from "yaml"

const configFile = new URL("../../config/config/auto-group-card.yaml", import.meta.url)
const suffixes = [
  "本机器人拒绝服务酷狗！",
  "米游社区寄生的酷狗能不能滚一边去！",
  "Hello，Kugou！",
  "MC是Minecraft，别连简称也蹭！",
  "在米游社区跳脸就接受后果！",
  "推广米游不好玩呜哇好玩有素质没？",
]
let updating = false

function readConfig() {
  const config = fs.existsSync(configFile)
    ? YAML.parse(fs.readFileSync(configFile, "utf8")) || {}
    : {}
  return {
    enable: config.enable ?? true,
    cron: config.cron || "0 0,30 * * * *",
    nickname: config.nickname || "",
    notGroup: (config.notGroup || []).map(String),
  }
}

export class AutoGroupCard extends plugin {
  constructor() {
    super({
      name: "自动群名片",
      dsc: "使用 fkKugou 文案定时更新机器人的群名片",
      event: "message",
      priority: 4644,
      rule: [{ reg: "^#更新群名片$", fnc: "updateManually", permission: "master" }],
    })
    const config = readConfig()
    this.task = config.enable
      ? { name: this.name, cron: config.cron, fnc: () => this.updateCards(), log: false }
      : []
  }

  init() {
    logger.info(`[自动群名片] fkKugou 模板${this.task.cron ? `已启用，定时：${this.task.cron}` : "已关闭"}`)
  }

  async updateManually() {
    if (!this.e.isMaster) return false
    const result = await this.updateCards()
    if (!result) return this.reply("群名片功能已关闭或正在更新，请稍后再试")
    return this.reply(
      `群名片更新完成：成功 ${result.updated} 个，未变 ${result.unchanged} 个，失败 ${result.failed} 个`,
    )
  }

  async updateCards() {
    const config = readConfig()
    if (!config.enable || updating) return false
    updating = true
    const result = { updated: 0, unchanged: 0, failed: 0 }
    try {
      const suffix = suffixes[Math.floor(Math.random() * suffixes.length)]
      for (const selfId of Bot.uin) {
        const bot = Bot[selfId]
        if (!bot?.gl || typeof bot.pickGroup !== "function") continue
        const card = `${config.nickname || bot.nickname}｜${suffix}`
        for (const groupId of bot.gl.keys()) {
          if (config.notGroup.includes(String(groupId))) continue
          try {
            const group = bot.pickGroup(groupId)
            if (group.pickMember(bot.uin).card === card) {
              result.unchanged++
              continue
            }
            const ret = await group.setCard(bot.uin, card)
            if (ret === false) throw new Error("接口返回失败")
            result.updated++
          } catch (error) {
            result.failed++
            logger.warn(`[自动群名片] ${selfId}/${groupId} 更新失败：${error.message}`)
          }
        }
      }
      return result
    } finally {
      updating = false
    }
  }
}
