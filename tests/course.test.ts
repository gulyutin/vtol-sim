import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addStudent, COURSE, exportStudents, importStudents, judgeExercise, logbookCsv, quizPassed, recordFlight, totals, unlocked, type CourseStore, type LogEntry } from '../src/game/course';
import { FAILURES } from '../src/sim/failures';
import { DIFFICULTY } from '../src/game/scoring';

const entry = (o: Partial<LogEntry> = {}): LogEntry => ({
  at: '2026-09-19T10:00:00.000Z',
  task: 'Перелёт А → Б',
  region: 'Хибины',
  difficulty: 'Штатный полёт',
  airborneS: 600,
  distanceKm: 12.3,
  landings: 1,
  failures: [],
  score: 80,
  passed: true,
  crashed: false,
  ...o,
});

describe('курс: данные', () => {
  const scoring = readFileSync(new URL('../src/game/scoring.ts', import.meta.url), 'utf8');
  it('у каждого упражнения — вопросы с верным ответом, известные отказы, режим и пункты оценки', () => {
    expect(new Set(COURSE.map((e) => e.id)).size).toBe(COURSE.length);
    for (const ex of COURSE) {
      expect(ex.quiz.length).toBeGreaterThan(0);
      for (const q of ex.quiz) expect(q.answer).toBeLessThan(q.options.length);
      for (const f of ex.failures ?? []) expect(FAILURES.some((x) => x.id === f.id)).toBe(true);
      expect(DIFFICULTY.some((d) => d.id === ex.difficulty)).toBe(true);
      for (const i of ex.pass.items ?? []) expect(scoring).toContain(`title: '${i.title}'`);
    }
  });
});

describe('курс: зачёт и допуск', () => {
  const ex = COURSE.find((e) => e.pass.items?.length)!;
  const item = ex.pass.items![0]!;
  it('баллы, авария и пункт оценки', () => {
    expect(judgeExercise(ex, { total: 90, items: [{ title: item.title, points: 10, max: 10 }] }, false).passed).toBe(true);
    expect(judgeExercise(ex, { total: 90, items: [{ title: item.title, points: 10, max: 10 }] }, true).reasons).toContain('авария');
    expect(judgeExercise(ex, { total: ex.pass.minScore - 1, items: [] }, false).passed).toBe(false);
    const low = judgeExercise(ex, { total: 90, items: [{ title: item.title, points: 1, max: 10 }] }, false);
    expect(low.passed).toBe(false);
    expect(low.reasons[0]).toContain(item.title);
  });
  it('допуск — только все ответы верны', () => {
    const e = COURSE[0]!;
    expect(quizPassed(e, e.quiz.map((q) => q.answer))).toBe(true);
    expect(quizPassed(e, e.quiz.map((q, i) => (i === 0 ? (q.answer + 1) % q.options.length : q.answer)))).toBe(false);
    expect(quizPassed(e, [])).toBe(false);
  });
  it('следующее упражнение открывается после сдачи предыдущего', () => {
    const c: CourseStore = { active: null, students: [] };
    const s = addStudent(c, 'Иванов И. И.');
    expect(unlocked(s, COURSE[0]!)).toBe(true);
    expect(unlocked(s, COURSE[1]!)).toBe(false);
    recordFlight(s, entry({ exerciseId: COURSE[0]!.id, passed: false, score: 50 }));
    expect(unlocked(s, COURSE[1]!)).toBe(false);
    recordFlight(s, entry({ exerciseId: COURSE[0]!.id, passed: true, score: 75 }));
    expect(unlocked(s, COURSE[1]!)).toBe(true);
    expect(s.progress[COURSE[0]!.id]).toMatchObject({ attempts: 2, best: 75, passed: true });
  });
});

describe('курс: журнал', () => {
  it('итоги, CSV для Excel и перенос файлом', () => {
    const c: CourseStore = { active: null, students: [] };
    const s = addStudent(c, 'Петров; П. "П."');
    recordFlight(s, entry({ failures: ['Потеря связи с НСУ'] }));
    recordFlight(s, entry({ crashed: true, landings: 0, passed: null, score: 20, airborneS: 300 }));
    const t = totals(s);
    expect(t).toMatchObject({ flights: 2, airborneS: 900, landings: 1, failures: 1, crashes: 1 });
    const csv = logbookCsv(s);
    expect(csv.startsWith('﻿Дата;Курсант')).toBe(true);
    expect(csv).toContain('"Петров; П. ""П."""');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(3);
    const other: CourseStore = { active: null, students: [] };
    expect(importStudents(other, exportStudents(c))).toBe(1);
    expect(other.students[0]!.log).toHaveLength(2);
    expect(() => importStudents(other, '{"x":1}')).toThrow();
  });
});
