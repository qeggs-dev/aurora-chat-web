import type { MessageUsage } from '../api/types.js'

type ServerToolUse = NonNullable<MessageUsage['server_tool_use']>

const mergeServerToolUse = (
  total: ServerToolUse | undefined,
  next: ServerToolUse | undefined
): ServerToolUse | undefined => {
  if (!next) {
    return total
  }
  if (!total) {
    return next
  }
  return {
    web_search_requests: total.web_search_requests + next.web_search_requests,
    tool_search: total.tool_search + next.tool_search,
  }
}

/**
 * 工具循环会为同一条回复发多次请求：把各轮的 usage 累加成本轮回复的总用量。
 * 各协议的 usage 都是「本次请求」的累计值（Anthropic 的 message_delta 是累计、Chat / Responses
 * 是单次响应），跨请求相加即可；可选字段（思考 / 服务端搜索）只在出现时相加。
 */
export const mergeUsage = (
  total: MessageUsage | undefined,
  next: MessageUsage | undefined
): MessageUsage | undefined => {
  if (!next) {
    return total
  }
  if (!total) {
    return next
  }
  const reasoning = (total.reasoning_tokens ?? 0) + (next.reasoning_tokens ?? 0)
  const serverToolUse = mergeServerToolUse(total.server_tool_use, next.server_tool_use)
  return {
    input_tokens: total.input_tokens + next.input_tokens,
    cache_creation_input_tokens:
      total.cache_creation_input_tokens + next.cache_creation_input_tokens,
    cache_read_input_tokens: total.cache_read_input_tokens + next.cache_read_input_tokens,
    output_tokens: total.output_tokens + next.output_tokens,
    ...(total.reasoning_tokens === undefined && next.reasoning_tokens === undefined
      ? {}
      : { reasoning_tokens: reasoning }),
    ...(serverToolUse === undefined ? {} : { server_tool_use: serverToolUse }),
  }
}
