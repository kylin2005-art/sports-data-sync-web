const WINDOW_MS = 300_000;
const MAX_SAMPLE_GAP_MS = 5_000;

function bestWindow(samples) {
  if (samples.length < 2 || samples.at(-1).time - samples[0].time < WINDOW_MS) return null;
  const energy = [0];
  for (let i = 1; i < samples.length; i++) {
    const prior = samples[i - 1];
    energy.push(energy[i - 1] + prior.power * (samples[i].time - prior.time));
  }
  // A rolling integral reaches a maximum when either edge crosses a sample.
  let best = 0;
  for (const edge of [0, WINDOW_MS]) {
    let other = 0;
    for (let i = 0; i < samples.length; i++) {
      const at = samples[i].time + (edge === 0 ? WINDOW_MS : -WINDOW_MS);
      if (at < samples[0].time) continue;
      if (at > samples.at(-1).time) break;
      while (other + 1 < samples.length && samples[other + 1].time <= at) other++;
      const integral = energy[other] + samples[other].power * (at - samples[other].time);
      best = Math.max(best, (edge === 0 ? integral - energy[i] : energy[i] - integral) / WINDOW_MS);
    }
  }
  return best;
}

export function bestFiveMinutePower(segments) {
  let best = null;
  for (const segment of segments) {
    let span = [];
    const flush = () => {
      const value = bestWindow(span);
      if (value !== null) best = best === null ? value : Math.max(best, value);
      span = [];
    };
    for (const sample of segment) {
      if (!Number.isFinite(sample.time) || !Number.isFinite(sample.power) || sample.power < 0 || sample.paused) {
        flush();
        continue;
      }
      const prior = span.at(-1);
      const gap = prior && sample.time - prior.time;
      if (prior && (gap <= 0 || gap > MAX_SAMPLE_GAP_MS || prior.timer !== sample.timer)) flush();
      span.push(sample);
    }
    flush();
  }
  return best;
}
