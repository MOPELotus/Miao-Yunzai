import plugin from "../../lib/plugins/plugin.js"
import fs from "node:fs"
import YAML from "yaml"

const configFile = new URL("../../config/config/group-leave-blacklist.yaml", import.meta.url)

function enabled(e) {
  if (!fs.existsSync(configFile)) return false
  const config = YAML.parse(fs.readFileSync(configFile, "utf8")) || {}
  return config.enable === true && (config.groups || []).map(String).includes(String(e.group_id))
}

function key(e) {
  return `Yz:group-leave-blacklist:${e.group_id}`
}

export class LeaveBlacklistNotice extends plugin {
  constructor() {
    super({ name: "退群自动拉黑", event: "notice.group", priority: -10002 })
  }

  async accept(e = this.e) {
    if (!enabled(e) || String(e.user_id) === String(e.self_id) || e.dismiss) return false
    if (e.sub_type === "decrease") {
      // 管理员移出不当成主动退群；缺少操作者时不猜测。
      if (!e.operator_id || String(e.operator_id) !== String(e.user_id)) return false
      await redis.hSet(key(e), String(e.user_id), JSON.stringify({
        time: e.time || Math.floor(Date.now() / 1000),
        self_id: e.self_id,
        name: e.member?.card || e.member?.nickname || e.nickname || "",
      }))
      logger.mark(`[退群自动拉黑] ${e.group_id} 已记录主动退群成员 ${e.user_id}`)
    } else if (e.sub_type === "increase" && await redis.hGet(key(e), String(e.user_id))) {
      await e.group.kickMember(e.user_id, true)
      logger.mark(`[退群自动拉黑] ${e.group_id} 已移出重新加入的黑名单成员 ${e.user_id}`)
      return "return"
    }
    return false
  }
}

export class LeaveBlacklistRequest extends plugin {
  constructor() {
    super({ name: "退群黑名单入群拦截", event: "request.group", priority: -10002 })
  }

  async accept(e = this.e) {
    if (!enabled(e) || String(e.user_id) === String(e.self_id)) return false
    if (!await redis.hGet(key(e), String(e.user_id))) return false
    await e.approve(false, "本群已开启退群自动拉黑，如需返回请联系群主")
    logger.mark(`[退群自动拉黑] ${e.group_id} 已拒绝黑名单成员 ${e.user_id} 的加群请求`)
    return "return"
  }
}

export class LeaveBlacklistManage extends plugin {
  constructor() {
    super({
      name: "退群黑名单管理", event: "message.group", priority: -10002,
      rule: [{ reg: "^#退群拉黑(解除|查询)\\s*\\d+$", fnc: "manage", permission: "master" }],
    })
  }

  async manage(e = this.e) {
    if (!e.isMaster || !enabled(e)) return false
    const userId = e.msg.match(/\d+$/)[0]
    if (e.msg.includes("解除")) {
      const removed = await redis.hDel(key(e), userId)
      return e.reply(removed ? `已解除 ${userId} 在本群的退群黑名单` : `${userId} 不在本群退群黑名单中`)
    }
    const record = await redis.hGet(key(e), userId)
    return e.reply(record ? `${userId} 在本群退群黑名单中` : `${userId} 不在本群退群黑名单中`)
  }
}
