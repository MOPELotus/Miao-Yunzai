import { createHash } from "node:crypto"

// 只复读可直接重发的文字、图片和 QQ 表情；回复、转发和文件等消息会打断这一轮。
export function prepareRepeatMessage(message) {
  if (!Array.isArray(message)) return null
  const content = []
  const payload = []
  let text = ""
  for (const segment of message) {
    const data = segment.data || segment
    switch (segment.type) {
      case "text": {
        const value = String(data.text || "").replace(/\r\n/g, "\n")
        text += value
        if (content.at(-1)?.[0] === "text") content.at(-1)[1] += value
        else content.push(["text", value])
        payload.push({ type: "text", text: value })
        break
      }
      case "image": {
        const file = String(data.file || "")
        const hash = file.match(/(?:^|[/\\])([a-f\d]{32})(?:\.[a-z\d]+)?$/i)?.[1]
        const source = data.url || file
        if (!source) return null
        // 相同图片的临时 URL/rkey 可能不同，优先按内容 MD5 比较。
        content.push(["image", hash?.toLowerCase() || source])
        payload.push({ type: "image", file: source, sub_type: data.sub_type ?? 0 })
        break
      }
      case "face":
        if (data.id === undefined) return null
        content.push(["face", String(data.id)])
        payload.push({ type: "face", id: data.id })
        break
      default:
        return null
    }
  }
  if (!content.length || /^[#＃/]/.test(text.trimStart())) return null
  if (content.every(part => part[0] === "text") && !text.trim()) return null
  return {
    signature: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
    payload,
  }
}

export class RepeatTracker {
  constructor({ windowMs = 120000, maxGroups = 2000 } = {}) {
    this.windowMs = windowMs
    this.maxGroups = maxGroups
    this.groups = new Map()
  }

  observe(groupId, userId, message, now = Date.now()) {
    const key = String(groupId)
    const prepared = prepareRepeatMessage(message)
    if (!prepared) {
      this.groups.delete(key)
      return null
    }
    let round = this.groups.get(key)
    if (!round || round.signature !== prepared.signature || now - round.lastTime > this.windowMs) {
      round = { signature: prepared.signature, users: new Set(), repeated: false }
    }
    round.lastTime = now
    // 触发后不再保存更多用户，长时间接龙也不会无限增长。
    if (!round.repeated) round.users.add(String(userId))
    this.groups.delete(key)
    this.groups.set(key, round)
    while (this.groups.size > this.maxGroups) this.groups.delete(this.groups.keys().next().value)
    if (round.repeated || round.users.size < 2) return null
    // 发送前就占位，多个账号或同时到达的消息不会重复触发。
    round.repeated = true
    return prepared.payload
  }
}
