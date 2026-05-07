'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmitter, parseSseStream } = require('../website/app/lib/progress-emitter');

test('createEmitter — disabled mode is a no-op', () => {
  const e = createEmitter({ enabled: false });
  assert.strictEqual(e.enabled, false);
  assert.strictEqual(e.response, null);
  // No-ops shouldn't throw.
  e.emit('whatever', { x: 1 });
  return e.end({ y: 2 });
});

test('createEmitter — enabled mode returns a Response with text/event-stream', () => {
  const e = createEmitter({ enabled: true });
  assert.strictEqual(e.enabled, true);
  assert.ok(e.response instanceof Response);
  assert.match(
    e.response.headers.get('content-type') || '',
    /text\/event-stream/,
  );
});

test('emit + end produce correctly-framed SSE events', async () => {
  const e = createEmitter({ enabled: true });
  // Push a couple of events synchronously, then close.
  e.emit('file-start', { path: 'src/a.ts', issues: 2 });
  e.emit('file-complete', { path: 'src/a.ts', success: true });
  await e.end({ totalFixed: 1 });

  // Drain the stream into one string and verify framing.
  const text = await e.response.text();
  // Each event must end with the blank-line separator.
  const blocks = text.split('\n\n').filter((s) => s.length > 0);
  assert.strictEqual(blocks.length, 3, 'three events: file-start, file-complete, done');
  assert.match(blocks[0], /^event: file-start\ndata: \{"path":"src\/a\.ts","issues":2\}$/);
  assert.match(blocks[1], /^event: file-complete\ndata: \{"path":"src\/a\.ts","success":true\}$/);
  assert.match(blocks[2], /^event: done\ndata: \{"totalFixed":1\}$/);
});

test('parseSseStream — round-trips events from the emitter back into typed objects', async () => {
  const e = createEmitter({ enabled: true });
  e.emit('file-start', { path: 'a.ts' });
  e.emit('file-complete', { path: 'a.ts', success: true });
  await e.end({ total: 1 });

  // Re-read the response body as a stream and parse it back.
  const reader = e.response.body.getReader();
  const events = [];
  await parseSseStream(reader, (ev) => events.push(ev));

  assert.strictEqual(events.length, 3);
  assert.deepStrictEqual(events[0], { name: 'file-start', data: { path: 'a.ts' } });
  assert.deepStrictEqual(events[1], { name: 'file-complete', data: { path: 'a.ts', success: true } });
  assert.deepStrictEqual(events[2], { name: 'done', data: { total: 1 } });
});

test('emit after end is silently dropped (no throw)', async () => {
  const e = createEmitter({ enabled: true });
  await e.end({});
  // Must not throw — the route's worker callbacks may continue to
  // emit briefly after the run wrapper has closed the stream.
  e.emit('file-start', { path: 'late.ts' });
  // No way to verify silent drop other than "didn't throw" — confirmed.
  assert.ok(true);
});

test('parseSseStream — handles split-across-chunk events', async () => {
  // Manually craft a stream that splits a single event across two reads.
  const enc = new TextEncoder();
  const chunks = [
    enc.encode('event: file-start\ndata: {"path":'),
    enc.encode('"split.ts"}\n\n'),
  ];
  const stream = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  const events = [];
  await parseSseStream(stream.getReader(), (ev) => events.push(ev));
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0], { name: 'file-start', data: { path: 'split.ts' } });
});

test('parseSseStream — handles a multi-event chunk', async () => {
  const enc = new TextEncoder();
  const blob = enc.encode(
    'event: a\ndata: {"i":1}\n\nevent: b\ndata: {"i":2}\n\nevent: c\ndata: {"i":3}\n\n',
  );
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(blob);
      c.close();
    },
  });
  const events = [];
  await parseSseStream(stream.getReader(), (ev) => events.push(ev));
  assert.strictEqual(events.length, 3);
  assert.deepStrictEqual(events.map((e) => e.name), ['a', 'b', 'c']);
});

test('parseSseStream — non-JSON data passes through as a string', async () => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('event: ping\ndata: heartbeat\n\n'));
      c.close();
    },
  });
  const events = [];
  await parseSseStream(stream.getReader(), (ev) => events.push(ev));
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].name, 'ping');
  assert.strictEqual(events[0].data, 'heartbeat');
});

test('parseSseStream — malformed events with no data field are skipped', async () => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('event: empty\n\nevent: real\ndata: {"ok":true}\n\n'));
      c.close();
    },
  });
  const events = [];
  await parseSseStream(stream.getReader(), (ev) => events.push(ev));
  assert.strictEqual(events.length, 1, 'only the event with a data: line is reported');
  assert.deepStrictEqual(events[0], { name: 'real', data: { ok: true } });
});
