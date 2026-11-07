const missing = '—';
const finite = Number.isFinite;
const short = (value, length) => {
  const chars = Array.from(String(value ?? '').trim().replace(/[\s\u0000-\u001f]/g, ' ').replace(/ +/g, ' '));
  return chars.length > length ? chars.slice(0, length - 1).join('') + '…' : chars.join('');
};
const number = (value, digits = 0) => finite(value) ? value.toFixed(digits) : missing;
const unit = (value, label) => value === missing ? missing : `${value} ${label}`;
const estimate = (value, estimated) => estimated && value !== missing ? `≈${value}` : value;

function timeLabel(value) {
  if (!finite(value) || value < 0) return missing;
  const seconds = Math.round(value);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(part => String(part).padStart(2, '0')).join(':');
}

// Keep separate subpaths when privacy trimming or the source file breaks a route.
export function tracePath(lines) {
  return lines.map(line => line.map(([x, y], index) =>
    `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')).join(' ');
}

function routeLines(ride, scope) {
  const lines = scope === 'full' ? ride?.route : scope === 'trimmed' ? ride?.trimmedRoute : [];
  return (lines ?? []).map(line => line.map(([x, y, altitude]) => [58 + x * 205, 25 + y * 154, altitude]));
}

function profilePath(lines) {
  const samples = [];
  for (const line of lines) {
    let run = [];
    for (const point of line) {
      if (finite(point[2])) run.push(point);
      else {
        if (run.length >= 2) samples.push(run);
        run = [];
      }
    }
    if (run.length >= 2) samples.push(run);
  }
  const heights = samples.flat().map(point => point[2]);
  if (!heights.length) return '';
  const min = Math.min(...heights), span = Math.max(...heights) - min || 1;
  const total = heights.length - 1;
  let index = 0;
  return tracePath(samples.map(line => line.map(([, , altitude]) => [310 * index++ / total, 81 - 71 * (altitude - min) / span])));
}

function chapterRoutes(lines) {
  const points = lines.flat();
  if (points.length < 2) return [[], [], []];
  const lengths = new Map();
  let total = 0;
  for (const line of lines) line.forEach((point, index) => {
    const previous = line[index - 1];
    if (previous) total += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    lengths.set(point, total);
  });
  return [0, 1, 2].map(index => lines.map(line => line.filter(point => {
    const fraction = lengths.get(point) / total;
    return fraction >= index / 3 && fraction <= (index + 1) / 3;
  })).filter(line => line.length >= 2));
}

export function posterData(id, {
  ride, title: customTitle, scope = 'hidden', showDate = false, comparison, record, monthly, exploration, journal, photo, target = 100,
} = {}) {
  const derived = Object.fromEntries(Object.entries(ride?.shareMetrics ?? {}).filter(([, value]) => finite(value)));
  const metrics = { ...ride?.metrics, ...derived };
  const estimated = [...(ride?.estimated ?? []), ...Object.keys(derived)];
  const title = short(customTitle, 8) || '骑行记录';
  const date = showDate && ride?.startTime ? new Date(ride.startTime).toLocaleDateString('zh-CN') : '';
  const distanceNumber = estimate(number(metrics.distanceM / 1000, 1), estimated.includes('distanceM'));
  const ascentNumber = estimate(number(metrics.ascentM), estimated.includes('ascentM'));
  const ascentSignedNumber = finite(metrics.ascentM) ? estimate('+' + number(metrics.ascentM), estimated.includes('ascentM')) : missing;
  const duration = estimate(timeLabel(metrics.durationSeconds), estimated.includes('durationSeconds'));
  const durationKind = metrics.durationKind === 'elapsed' ? '经过用时' : '骑行用时';
  const distance = unit(distanceNumber, 'km'), ascent = unit(ascentNumber, 'm');
  const lines = routeLines(ride, scope);
  const speeds = scope === 'full' ? ride?.routeSpeeds : scope === 'trimmed' ? ride?.trimmedRouteSpeeds : [];
  const speedLines = lines.map((line, index) => line.map(([x, y], point) => [x, y, speeds?.[index]?.[point]]));
  const hasSpeeds = speedLines.some(line => line.some(([, , speed]) => finite(speed)));
  const isMonthly = id === 5 || id === 23;
  const route = isMonthly ? routeLines(monthly?.representative, scope) : lines;
  const month = monthly?.month ?? '';
  const [year, monthIndex] = month.split('-').map(Number);
  const monthOffset = month ? new Date(Date.UTC(year, monthIndex - 1, 1)).getUTCDay() : 0;
  const daysInMonth = month ? new Date(Date.UTC(year, monthIndex, 0)).getUTCDate() : 0;
  const activityDate = date ? new Date(ride.startTime) : null;
  const day = activityDate && activityDate.getFullYear() === year && activityDate.getMonth() + 1 === monthIndex
    ? activityDate.getDate() : 0;
  const saved = comparison?.secondsSaved;
  const recordValue = record?.value;
  const hasDistance = finite(metrics.distanceM);
  const distanceKm = hasDistance ? metrics.distanceM / 1000 : NaN;
  const remaining = Math.max(0, target - distanceKm);
  const tempoSamples = speedLines.flat().map(([, , speed]) => speed);
  const tempo = hasSpeeds ? Array.from({ length: 32 }, (_, i) => {
    const start = Math.floor(i * tempoSamples.length / 32);
    const end = Math.max(start + 1, Math.floor((i + 1) * tempoSamples.length / 32));
    const values = tempoSamples.slice(start, end).filter(finite);
    return values.length ? Math.min(35, values.reduce((sum, speed) => sum + speed, 0) / values.length * 2.4) : 0;
  }) : [];
  const grid = scope === 'full' && exploration?.currentCells.length
    ? { current: exploration.currentCells, previous: exploration.previousCells, fresh: exploration.newCells } : null;
  const exploredTotal = exploration ? new Set([...exploration.currentCells, ...exploration.previousCells].map(String)).size : 0;
  return {
    title, customTitle: short(customTitle, 24), date, distanceNumber, distance, ascentNumber, ascent, ascentSignedNumber, ascentSigned: unit(ascentSignedNumber, 'm'),
    duration, durationLabel: `${duration} ${durationKind}`,
    speedNumber: estimate(number(finite(metrics.avgSpeedMps) ? metrics.avgSpeedMps * 3.6 : NaN, 1), estimated.includes('avgSpeedMps')),
    titleDistance: `${title} / ${distance}`, titleDate: [title, date].filter(Boolean).join(' / '),
    facts: `${title} / ${distance} / ${ascent}`,
    lines: route, route: tracePath(route), first: scope === 'full' ? route[0]?.[0]?.slice(0, 2) : null,
    hasRoute: route.length > 0, profile: profilePath(route), speedLines, hasSpeeds, tempo,
    speedEstimated: Boolean(ride?.shareSpeedEstimated),
    month, monthTitle: month ? `${year} 年 ${monthIndex} 月` : '月度骑行',
    monthOffset, daysInMonth, highlightDay: day, calendarDays: new Set(monthly?.days ?? []),
    monthRideCount: monthly?.rideCount ?? missing, monthDayCount: monthly?.days?.length ?? missing,
    monthDistance: estimate(number(monthly?.distanceM / 1000, 1), monthly?.estimatedDistance),
    monthAscent: estimate(number(monthly?.ascentM), monthly?.estimatedAscent),
    monthFooter: monthly ? `统计 ${monthly.rideCount ?? 0} 次有日期的骑行` : '',
    resultTitle: record ? short(record.title, 13) : comparison ? (finite(saved) ? (saved > 0 ? '同一条路，快了' : saved < 0 ? '同一条路，慢了' : '同一条路，用时持平') : '两趟骑行对比') : '本次骑行成绩',
    resultValue: recordValue ?? (finite(saved) ? timeLabel(Math.abs(saved)) : duration),
    resultNote: comparison ? (finite(saved) ? '同向、同计时口径' : '用时不可直接比较') : record ? '年度骑行高光' : durationKind,
    currentLabel: comparison ? '本次' : '里程', currentValue: comparison ? timeLabel(comparison.ride.metrics.durationSeconds) : distance,
    baselineLabel: comparison ? '上次' : '累计爬升', baselineValue: comparison ? timeLabel(comparison.baseline.metrics.durationSeconds) : ascent,
    grid, explored: exploration ? `+${exploration.newCells.length}` : missing,
    exploredTotal: exploration ? `累计点亮 ${exploredTotal} 格` : '暂无探索记录',
    tags: (journal?.tags ?? []).slice(0, 3).map(tag => short(tag, 6)),
    water: short(journal?.water, 16) || missing, road: short(journal?.road, 16) || missing,
    photo, chapters: id === 12 ? chapterRoutes(lines) : [], distanceKm,
    target, progress: hasDistance ? Math.min(100, distanceKm / target * 100) : 0,
    remainingLabel: remaining === 0 ? '已达成目标' : '离目标还差', remaining: unit(number(remaining, 1), 'km'),
  };
}
