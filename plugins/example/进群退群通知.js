function displayText(value) {
  return String(value ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").trim()
}

export class newcomer extends plugin {
  constructor() {
    super({
      name: "欢迎新人",
      dsc: "新人入群欢迎",
      event: "notice.group.increase",
    })
  }

  async accept() {
    const e = this.e
    if (e.user_id == e.self_id) return

    // 沿用每群 30 秒冷却，避免集中进群时刷屏。
    const key = `Yz:newcomers:${e.group_id}`
    if (await redis.get(key)) return
    await redis.set(key, "1", { EX: 30 })

    const groupName = displayText(e.group_name || e.group?.name || e.group?.group_name)
    await this.reply([
      `🌸 欢迎来到${groupName ? `「${groupName}」` : "本群"}\n\n`,
      segment.at(e.user_id),
      " 欢迎加入～\n先看看群公告，有问题随时交流。",
    ])
  }
}

export class outNotice extends plugin {
  constructor() {
    super({
      name: "退群通知",
      dsc: "群成员离开或被移出时发送提示",
      event: "notice.group.decrease",
    })
  }

  async accept() {
    const e = this.e
    if (e.user_id == e.self_id || e.dismiss) return

    const name = displayText(e.member?.card) || displayText(e.member?.nickname) || displayText(e.nickname)
    const who = name ? `${name}（${e.user_id}）` : `QQ ${e.user_id}`
    const kicked = e.operator_id && String(e.operator_id) !== String(e.user_id)
    const msg = kicked
      ? `📋 成员变动\n\n${who} 已被移出本群。`
      : `🍃 成员离开\n\n${who} 已退出本群。\n有缘再见，祝一切顺利。`
    logger.mark(`[退出通知]${e.logText} ${msg}`)
    await this.reply(msg)
  }
}
