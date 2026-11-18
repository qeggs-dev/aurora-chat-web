// SSE decoding (src/services/api/sse.ts): WHATWG event-stream interpretation,
// multi-line data, comments, CRLF/CR splitting across chunks, and EOF behavior.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { ServerSentEventDecoder, readServerSentEvents } = await import(
  '../.test-build/services/api/sse.js'
)

const collect = (chunks) => {
  const decoder = new ServerSentEventDecoder()
  const events = []
  for (const chunk of chunks) {
    events.push(...decoder.push(chunk))
  }
  events.push(...decoder.end())
  return events
}

test('单个 data 事件：缺省 event=message，空 id', () => {
  assert.deepEqual(collect(['data: hello\n\n']), [
    { event: 'message', data: 'hello', lastEventId: '' },
  ])
})

test('data 值只去掉一个前导空格，冒号后的其余内容原样保留', () => {
  assert.deepEqual(collect(['data:  two spaces\n\n'])[0].data, ' two spaces')
  assert.deepEqual(collect(['data:no-space\n\n'])[0].data, 'no-space')
  assert.deepEqual(collect(['data:\n\n'])[0].data, '')
})

test('event / id 字段生效，id 跨事件保留', () => {
  const events = collect(['id: 42\nevent: ping\ndata: a\n\n', 'data: b\n\n'])
  assert.equal(events[0].event, 'ping')
  assert.equal(events[0].lastEventId, '42')
  assert.equal(events[1].event, 'message')
  assert.equal(events[1].lastEventId, '42')
  // 含 NUL 的 id 按规范忽略
  const withNul = collect(['id: a\0b\n\ndata: x\n\n'])
  assert.equal(withNul[0].lastEventId, '')
})

test('多行 data 用换行连接', () => {
  assert.deepEqual(collect(['data: line1\ndata: line2\ndata: line3\n\n']), [
    { event: 'message', data: 'line1\nline2\nline3', lastEventId: '' },
  ])
})

test('注释行与未知字段被忽略，不影响事件派发', () => {
  assert.deepEqual(collect([': keep-alive\nretry: 5000\nfoo: bar\ndata: x\n\n']), [
    { event: 'message', data: 'x', lastEventId: '' },
  ])
  // 只有注释 / 字段但没有 data 的块不产生事件
  assert.deepEqual(collect([': ping\n\n: ping\n\n']), [])
})

test('CRLF、单独 CR、单独 LF 都能切行', () => {
  assert.deepEqual(collect(['data: a\r\n\r\n'])[0].data, 'a')
  assert.deepEqual(collect(['data: b\r\r'])[0].data, 'b')
  assert.deepEqual(collect(['data: c\n\n'])[0].data, 'c')
})

test('跨 chunk 的 CRLF / 多字节边界安全（结尾 CR 等下一段）', () => {
  assert.deepEqual(collect(['data: a\r', '\n\r', '\n'])[0].data, 'a')
  assert.deepEqual(collect(['da', 'ta: he', 'llo\n', '\n'])[0].data, 'hello')
})

test('一次 chunk 里的多个事件全部返回', () => {
  assert.deepEqual(collect(['data: one\n\ndata: two\n\n']), [
    { event: 'message', data: 'one', lastEventId: '' },
    { event: 'message', data: 'two', lastEventId: '' },
  ])
})

test('end()：结尾的 CR 作为行分隔，只有补出空行才派发；未以空行结尾的事件丢弃', () => {
  const decoder = new ServerSentEventDecoder()
  assert.deepEqual(decoder.push('data: tail\r\r'), [])
  assert.deepEqual(decoder.end(), [{ event: 'message', data: 'tail', lastEventId: '' }])

  // 只有一个结尾 CR：它是 data 行的行尾，没有空行 → 事件按规范丢弃
  const noBlankLine = new ServerSentEventDecoder()
  assert.deepEqual(noBlankLine.push('data: dropped\r'), [])
  assert.deepEqual(noBlankLine.end(), [])

  const incomplete = new ServerSentEventDecoder()
  assert.deepEqual(incomplete.push('data: dropped\n'), [])
  assert.deepEqual(incomplete.end(), [])
})

test('readServerSentEvents 按 UTF-8 分片读取，跨分片的多字节字符不截断', async () => {
  const encoder = new TextEncoder()
  const bytes = encoder.encode('data: 你好\n\ndata: ok\n\n')
  // 在汉字中间切开
  const chunks = [bytes.slice(0, 9), bytes.slice(9)]
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
  const events = []
  for await (const event of readServerSentEvents(stream)) {
    events.push(event)
  }
  assert.deepEqual(events, [
    { event: 'message', data: '你好', lastEventId: '' },
    { event: 'message', data: 'ok', lastEventId: '' },
  ])
})
