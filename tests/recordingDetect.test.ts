import { describe, expect, it } from 'vitest';
import { looksLikeRecordingJson, serialize, type Recording } from '../src/game/recorder';

/* Что за файл открывают в разборе: запись симулятора (JSON) или бортовой журнал без сжатия. */

describe('запись или журнал', () => {
  it('запись симулятора — JSON, в том числе с отступами', () => {
    const rec: Recording = { version: 1, meta: { title: 'т', startedAt: '2026-06-20T08:00:00Z', profileTitle: 'п', source: 'sim' }, samples: [], events: [] };
    expect(looksLikeRecordingJson(serialize(rec))).toBe(true);
    expect(looksLikeRecordingJson(`\n  ${JSON.stringify(rec, null, 2)}`)).toBe(true);
  });

  it('журнал без сжатия начинается с «{», но это не запись', () => {
    const head = '{\n\t"logtype" : "log",\n\t"startup_timestamp" : "2026-06-20T08:00:00+0000",\n\t"var" : {\n\t\t"name" : "lat",\n\t\t"type" : "double",\n\t\t"frame_id" : 2\n\t}\n}\n';
    expect(looksLikeRecordingJson(head)).toBe(false);
    expect(looksLikeRecordingJson('{\n\t"var" : {\n\t\t"name" : "x"')).toBe(false);
  });

  it('сжатый журнал и прочее — не запись', () => {
    expect(looksLikeRecordingJson('BZh91AY&SY')).toBe(false);
    expect(looksLikeRecordingJson('')).toBe(false);
  });
});
