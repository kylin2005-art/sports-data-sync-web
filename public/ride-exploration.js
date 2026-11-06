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
