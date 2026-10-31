import plugin from "../../lib/plugins/plugin.js"
import { RepeatTracker } from "../../lib/plugins/autoRepeat.js"

const tracker = new RepeatTracker()

export class AutoRepeat extends plugin {
  constructor() {
    super({
      name: "自动复读",
      dsc: "连续相同消息由两名不同群友发送后跟读一次",
      event: "message.group",
      priority: -10000,
    })
  }

  async accept(e = this.e) {
    if (!e.group_id || !e.user_id) return false
    const bots = [e.self_id, ...(Bot.uin || [])].map(String)
    if (bots.includes(String(e.user_id)) || e.sender?.is_bot) return false
    const message = tracker.observe(e.group_id, e.user_id, e.message)
    if (message) {
      const result = await this.reply(message)
      if (result === false || result?.error) {
        logger.warn(`[自动复读] ${e.group_id} 跟读发送失败`)
      }
    }
    return false
  }
}
