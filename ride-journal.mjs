import { WorkspaceError } from './sync-workspace.mjs';
import { processRide } from './tracks.mjs';

function field(value, label, length, multiline = false) {
  if (typeof value !== 'string') throw new WorkspaceError(400, `${label}格式无效。`);
  const normalized = value.trim().normalize('NFC');
  const singleLineControls = /[\u0000-\u001f\u007f]/;
  const multilineControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
  if (normalized.length > length || (multiline ? multilineControls : singleLineControls).test(normalized)) {
    throw new WorkspaceError(400, `${label}最多 ${length} 个字符，请检查输入。`);
  }
  return normalized;
}

export function updateRideJournal(input, workspace, remove) {
  const { id } = input;
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new WorkspaceError(400, '请选择有效的骑行文件。');
  const { store } = workspace;
  if (remove) {
    store.removeRideJournalEntry(id);
  } else {
    const title = field(input.title, '路线名称', 120);
    if (!title) throw new WorkspaceError(400, '请填写路线名称。');
    if (!Array.isArray(input.tags) || input.tags.length > 12) throw new WorkspaceError(400, '每条路线最多添加 12 个标签。');
    const tags = [...new Set(input.tags.map(tag => field(tag, '每个标签', 24)).filter(Boolean))];
    const water = field(input.water ?? '', '补水点', 800, true);
    const road = field(input.road ?? '', '路况', 800, true);
    if (!store.hasRideJournalEntry(id) && !processRide({ id }, workspace).mapSegments.length) {
      throw new WorkspaceError(422, '这项活动缺少可用于收藏的标准 GPS 路线。');
    }
    store.saveRideJournalEntry(id, { title, tags, water, road });
  }
  return { entries: store.rideJournal() };
}
