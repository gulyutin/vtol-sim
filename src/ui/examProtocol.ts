import type { Remark } from '../game/remarks';
import { summarize, type Recording } from '../game/recorder';
import { admission, PASS_SCORE } from '../game/admission';
import type { Assessment } from '../game/scoring';

/*
 * Протокол проверки оператора: задание, район, дата, режим, баллы по пунктам, замечания
 * инструктора, график полёта и траектория, итог (допущен / не допущен) и строки подписей.
 * Открывается в отдельном окне: ФИО и номер вписываются прямо в протокол, «Сохранить PDF» — печать
 * браузера в PDF. Для допуска: не меньше PASS_SCORE баллов, без аварии и без грубых нарушений.
 */

export interface ProtocolInput {
  rec: Recording;
  assessment?: Assessment;
  remarks: readonly Remark[];
  /** Графики полёта из разбора — картинкой. */
  chartUrl?: string;
  region: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Траектория сверху: SVG по отсчётам записи, север вверху, с точкой посадки задания. */
function trackSvg(rec: Recording): string {
  const s = rec.samples.filter((p) => p.mode !== 'ground');
  if (s.length < 2) return '';
  let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
  for (const p of s) {
    e0 = Math.min(e0, p.east);
    e1 = Math.max(e1, p.east);
    n0 = Math.min(n0, p.north);
    n1 = Math.max(n1, p.north);
  }
  const L = rec.meta.landing;
  if (L) {
    e0 = Math.min(e0, L.east);
    e1 = Math.max(e1, L.east);
    n0 = Math.min(n0, L.north);
    n1 = Math.max(n1, L.north);
  }
  const W = 520, H = 300, pad = 16;
  const k = Math.min((W - 2 * pad) / Math.max(1, e1 - e0), (H - 2 * pad) / Math.max(1, n1 - n0));
  const x = (e: number) => pad + (e - e0) * k;
  const y = (n: number) => H - pad - (n - n0) * k;
  const step = Math.max(1, Math.floor(s.length / 1500));
  const pts = s.filter((_, i) => i % step === 0).map((p) => `${x(p.east).toFixed(1)},${y(p.north).toFixed(1)}`).join(' ');
  const scaleM = [100, 200, 500, 1000, 2000, 5000, 10000].find((m) => m * k > 60) ?? 10000;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;border:1px solid #bbb;background:#f7f7f4">
    <polyline points="${pts}" fill="none" stroke="#d9480f" stroke-width="1.6"/>
    <circle cx="${x(s[0]!.east)}" cy="${y(s[0]!.north)}" r="4" fill="#2f9e44"/>
    ${L ? `<circle cx="${x(L.east)}" cy="${y(L.north)}" r="6" fill="none" stroke="#1c7ed6" stroke-width="2"/>` : ''}
    <line x1="${pad}" y1="${H - 8}" x2="${pad + scaleM * k}" y2="${H - 8}" stroke="#333" stroke-width="2"/>
    <text x="${pad + scaleM * k + 4}" y="${H - 4}" font-size="10">${scaleM >= 1000 ? `${scaleM / 1000} км` : `${scaleM} м`}</text>
    <text x="${W - 14}" y="16" font-size="12" text-anchor="middle">С↑</text>
  </svg>`;
}

/** Открыть протокол в новом окне; null — браузер не дал открыть окно. */
export function openProtocol(o: ProtocolInput): Window | null {
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) return null;
  w.document.write(protocolHtml(o));
  w.document.close();
  return w;
}

/** Протокол — страницей HTML (для окна печати). */
export function protocolHtml(o: ProtocolInput): string {
  const { rec, assessment: a, remarks } = o;
  const sum = summarize(rec);
  const started = new Date(rec.meta.startedAt);
  const date = Number.isNaN(started.getTime()) ? '' : started.toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });
  const adm = admission(rec, a, remarks);
  const exam = rec.meta.difficulty === 'exam';
  const items = a
    ? a.items.map((i) => `<tr><td>${esc(i.title)}</td><td class="n">${i.points} / ${i.max}</td><td>${esc(i.note)}</td></tr>`).join('')
    : '<tr><td colspan="3">Оценки нет — полёт не закончен</td></tr>';
  const rem = remarks.length ? remarks.map((r) => `<li class="${r.level}">${esc(r.text)}</li>`).join('') : '<li>Замечаний нет</li>';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Протокол проверки оператора</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font: 12px/1.45 'PT Sans', Arial, sans-serif; color: #111; margin: 0 auto; max-width: 780px; padding: 18px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  h2 { font-size: 13px; margin: 16px 0 6px; border-bottom: 1px solid #999; padding-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { border: 1px solid #bbb; padding: 3px 6px; vertical-align: top; text-align: left; }
  td.n { white-space: nowrap; text-align: right; }
  .meta td:first-child { width: 34%; color: #444; }
  input { font: inherit; border: 0; border-bottom: 1px solid #555; width: 100%; background: transparent; }
  .verdict { margin: 10px 0; padding: 8px 10px; border: 2px solid; font-size: 14px; font-weight: 700; }
  .verdict.pass { border-color: #2f9e44; color: #1b6e31; }
  .verdict.fail { border-color: #c92a2a; color: #a51d1d; }
  ul { margin: 0; padding-left: 18px; }
  li.bad { color: #a51d1d; }
  li.warn { color: #8a5a00; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 28px; }
  .sign div { border-top: 1px solid #333; padding-top: 3px; color: #444; font-size: 11px; }
  .tools { position: sticky; top: 0; background: #fff; padding: 6px 0 10px; }
  .tools button { padding: 5px 14px; font: inherit; cursor: pointer; }
  img { max-width: 100%; border: 1px solid #bbb; }
  @media print { .tools { display: none; } input { border-bottom-color: transparent; } }
</style></head><body>
<div class="tools"><button onclick="print()">Сохранить PDF / печать</button></div>
<h1>Протокол ${exam ? 'экзамена' : 'проверочного полёта'} оператора БАС</h1>
<div style="color:#555">${esc(rec.meta.profileTitle)} · тренажёр</div>
<h2>Сведения</h2>
<table class="meta">
  <tr><td>Оператор (Ф. И. О.)</td><td><input placeholder="вписать"></td></tr>
  <tr><td>Подразделение, номер удостоверения</td><td><input placeholder="вписать"></td></tr>
  <tr><td>Инструктор (Ф. И. О.)</td><td><input placeholder="вписать"></td></tr>
  <tr><td>Дата и время полёта</td><td>${esc(date)}</td></tr>
  <tr><td>Задание</td><td>${esc(rec.meta.title)}</td></tr>
  <tr><td>Район</td><td>${esc(o.region)}</td></tr>
  <tr><td>Режим</td><td>${exam ? 'экзамен (особые случаи — без предупреждения)' : 'тренировка'}</td></tr>
  ${rec.meta.ticket ? `<tr><td>Билет</td><td>${esc(rec.meta.ticket)} — отказы, цели и погода повторятся, если ввести этот номер в окне задания</td></tr>` : ''}
  <tr><td>Налёт / путь</td><td>${fmtT(sum.airborneS)} · ${(sum.distanceM / 1000).toFixed(1)} км · расход ${Math.round(sum.energyWh)} Вт·ч · мин. заряд ${Math.round(sum.minSoc * 100)} %</td></tr>
</table>
<div class="verdict ${adm.pass ? 'pass' : 'fail'}">Итог: ${a ? `${a.total} из 100 — ${esc(a.grade)}` : 'без оценки'}. ${adm.pass ? 'ДОПУЩЕН' : 'НЕ ДОПУЩЕН'} (${esc(adm.why)}; проходной — ${PASS_SCORE})</div>
<h2>Оценка по пунктам</h2>
<table><tr><th>Пункт</th><th>Баллы</th><th>Примечание</th></tr>${items}</table>
<h2>Замечания инструктора</h2>
<ul>${rem}</ul>
<h2>Траектория</h2>
${trackSvg(rec)}
<div style="font-size:10px;color:#666">Зелёная точка — начало записи, синий круг — точка посадки задания.</div>
${o.chartUrl ? `<h2>Графики полёта</h2><img src="${o.chartUrl}" alt="Графики полёта">` : ''}
<h2>Заключение инструктора</h2>
<input placeholder="вписать"><br><input placeholder="">
<div class="sign"><div>Инструктор — подпись, расшифровка</div><div>Оператор — подпись, расшифровка</div></div>
</body></html>`;
}
