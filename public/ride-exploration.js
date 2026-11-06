import { plotRideRoute } from './ride-card.js';

const number = value => value.toLocaleString('zh-CN');

export function drawExplorationCard(canvas, { currentCells, newCells, previousCells }) {
  const ctx = canvas.getContext('2d');
  const fresh = newCells.length, current = currentCells.length, previous = previousCells.length;
  const gradient = ctx.createLinearGradient(0, 0, 1080, 1080);
  gradient.addColorStop(0, '#0a152f');
  gradient.addColorStop(1, '#163865');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1080, 1080);

  function label(text, x, y, size, color = '#f1f6ff') {
    ctx.font = `700 ${size}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y, 900);
  }
  label('RIDE / EXPLORATION', 88, 120, 30, '#93bdfc');
  label('骑行探索', 88, 234, 84);
  label('本次新增格子', 88, 354, 38);
  label(`+${fresh.toLocaleString('zh-CN')}`, 78, 534, 160, '#6eebbd');

  // Decorative proportions only: never put geographic cells on the export.
  const colored = Math.round(24 * fresh / current);
  for (let i = 0; i < 24; i++) {
    ctx.fillStyle = i < colored ? '#6eebbd' : '#456793';
    ctx.fillRect(88 + i * 38, 592, 28, 28);
  }
  label(`新格子占本次 ${Math.round(100 * fresh / current)}%`, 88, 681, 32, '#bfd3f3');
  ctx.fillStyle = '#41648f';
  ctx.fillRect(88, 746, 904, 2);
  label('本次经过', 88, 824, 34, '#bfd3f3');
  label('此前骑过', 552, 824, 34, '#bfd3f3');
  label(current.toLocaleString('zh-CN'), 88, 933, 70);
  label(previous.toLocaleString('zh-CN'), 552, 933, 70);
}

export function monthlyRecord({ highlight, previousBest }) {
  if (previousBest == null) return '年内首次建立覆盖纪录';
  if (highlight.cells > previousBest) return `刷新年内纪录 · 多覆盖 ${number(highlight.cells - previousBest)} 格`;
  if (highlight.cells === previousBest) return '追平年内单次覆盖纪录';
  return `年内此前单次最多 ${number(previousBest)} 格`;
}

export function drawMonthlyPostcard(canvas, report, route = []) {
  const ctx = canvas.getContext('2d');
  const { month, rideCount, heatCells, highlight } = report;
  const [year, monthNumber] = month.split('-');
  ctx.fillStyle = '#eaf1fb';
  ctx.fillRect(0, 0, 1080, 1440);
  ctx.fillStyle = '#102951';
  ctx.fillRect(0, 0, 1080, 410);
  function label(text, x, y, size, color = '#132c52') {
    ctx.fillStyle = color;
    ctx.font = `700 ${size}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`;
    ctx.fillText(text, x, y, 904);
  }
  label('RIDE / MONTHLY RECAP', 88, 120, 29, '#a4c9fc');
  label('月度骑行明信片', 88, 242, 78, '#f4f8ff');
  label(`${year} 年 ${Number(monthNumber)} 月`, 88, 330, 42, '#d1e3ff');
  label(number(rideCount), 88, 564, 90);
  label(number(heatCells.length), 545, 564, 90);
  label('带定位的骑行', 88, 632, 32, '#395983');
  label('当月覆盖格子', 545, 632, 32, '#395983');

  const distribution = [0, 0, 0];
  for (const [, , visits] of heatCells) distribution[visits === 1 ? 0 : visits < 4 ? 1 : 2]++;
  let x = 88;
  distribution.forEach((count, index) => {
    const width = 904 * count / heatCells.length;
    ctx.fillStyle = ['#5996e3', '#2868be', '#16396d'][index];
    ctx.fillRect(x, 722, width, 24);
    x += width;
  });
  label('格子分布 · 按当月经过次数', 88, 801, 31, '#395983');
  label(`1 次 ${number(distribution[0])} 格`, 88, 865, 30);
  label(`2–3 次 ${number(distribution[1])} 格`, 392, 865, 30);
  label(`4 次及以上 ${number(distribution[2])} 格`, 690, 865, 30);

  ctx.fillStyle = '#d5e4f7';
  ctx.fillRect(88, 940, 904, 400);
  label('代表骑行', 126, 1010, 35, '#395983');
  label(`单次覆盖 ${number(highlight.cells)} 格`, 126, 1096, 51);
  label(monthlyRecord(report), 126, 1164, 31, '#2b5087');
  if (route.length) {
    plotRideRoute(ctx, route, { x: 138, y: 1201, width: 804, height: 100 },
      { trace: '#2266b9', traceUnder: '#a9c9ee' });
  } else {
    label('RIDE / KEEP EXPLORING', 126, 1291, 25, '#446388');
  }
}
