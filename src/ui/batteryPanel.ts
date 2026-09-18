import { capacityWh, chargeBlock, chargeEtaS, CHARGER_SLOTS, type Battery, type BatteryParkState } from '../game/batteries';

/*
 * Окно «Аккумуляторы»: какая АКБ на аппарате, какие на зарядке и в машине — заряд, температура,
 * циклы, износ, сколько ещё заряжаться; кнопки поставить на аппарат, на зарядку и снять;
 * хранить в тепле; «Ждать 15 мин» — время на земле идёт, батареи заряжаются, вылет позже.
 */

export interface BatteryPanelHandlers {
  onInstall(id: string): void;
  onCharger(id: string): void;
  onWarm(on: boolean): void;
  onWait(): void;
}

const fmtEta = (s: number) => (s < 60 ? 'меньше минуты' : s < 3600 ? `${Math.round(s / 60)} мин` : `${Math.floor(s / 3600)} ч ${Math.round((s % 3600) / 60)} мин`);

export class BatteryPanel {
  constructor(
    private readonly el: HTMLElement,
    h: BatteryPanelHandlers,
  ) {
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-bat]');
      if (!b || b.disabled) return;
      const id = b.dataset.id!;
      if (b.dataset.bat === 'install') h.onInstall(id);
      else if (b.dataset.bat === 'charger') h.onCharger(id);
      else if (b.dataset.bat === 'wait') h.onWait();
    });
    el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.bat === 'warm') h.onWarm(t.checked);
    });
  }

  /** canSwap — аппарат на земле без АРМ; ambientC — температура воздуха у площадки. */
  render(p: BatteryParkState, canSwap: boolean, ambientC: number) {
    const onCharger = p.batteries.filter((b) => b.place === 'charger').length;
    const row = (b: Battery) => {
      const pct = Math.round(b.soc * 100);
      const block = chargeBlock(b);
      const status =
        b.place === 'aircraft'
          ? 'на аппарате'
          : b.place === 'charger'
            ? block
              ? `на зарядке · ${block}`
              : `на зарядке · ещё ${fmtEta(chargeEtaS(b))}`
            : b.soc >= 0.99
              ? 'заряжена · в машине'
              : 'в машине';
      const cls = b.soc < 0.3 ? 'low' : b.soc < 0.9 ? 'mid' : 'full';
      const charging = b.place === 'charger' && !block;
      return `<tr class="${b.place}">
        <td><b>${b.name}</b><br><small>${status}</small></td>
        <td><span class="bat-bar ${cls}${charging ? ' charging' : ''}"><i style="width:${pct}%"></i></span><small>${pct} % · ${Math.round(capacityWh(b))} Вт·ч</small></td>
        <td><small>${b.tempC >= 0 ? '+' : ''}${Math.round(b.tempC)} °C<br>${Math.round(b.cycles)} цикл. · ${Math.round(b.health * 100)} %</small></td>
        <td class="bat-act">
          ${b.place === 'aircraft' ? '' : `<button class="small" data-bat="install" data-id="${b.id}" ${canSwap ? '' : 'disabled title="Только на земле без АРМ"'}>На аппарат</button>`}
          ${b.place === 'aircraft' ? '' : `<button class="small" data-bat="charger" data-id="${b.id}" ${b.place !== 'charger' && onCharger >= CHARGER_SLOTS ? 'disabled title="Зарядное занято"' : ''}>${b.place === 'charger' ? 'Снять' : 'На зарядку'}</button>`}
        </td></tr>`;
    };
    this.el.innerHTML = `
      <table class="bat-table"><tbody>${p.batteries.map(row).join('')}</tbody></table>
      <p class="hint">Зарядное: ${CHARGER_SLOTS} места, ${onCharger} занято. Li-ion заряжают от 0 до +45 °C — после мороза батарею отогревают, после полёта она остывает. Ёмкость зависит от температуры самой батареи и износа.</p>
      <label class="check"><input type="checkbox" data-bat="warm" ${p.warmStore ? 'checked' : ''}> Запасные — в тепле, в машине (+20 °C); на улице ${ambientC >= 0 ? '+' : ''}${Math.round(ambientC)} °C</label>
      <div class="row"><button class="small" data-bat="wait" data-id="" ${canSwap ? '' : 'disabled title="Только на земле без АРМ"'}>Ждать 15 мин</button><span class="hint">время идёт: батареи заряжаются, вылет позже</span></div>`;
  }
}
