// The poster layouts use a 360 × 408 artboard.
import { posterData, tracePath } from './ride-share-data.js';

const escapeXml = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

const t=(x,y,str,size=13,cls='cn',extra='')=>'<text x="'+x+'" y="'+y+'" font-size="'+size+'" class="'+cls+'" '+extra+'>'+escapeXml(str)+'</text>';
const p=(d,stroke,width=1,extra='')=>'<path d="'+d+'" stroke="'+stroke+'" stroke-width="'+width+'" fill="none" stroke-linejoin="round" stroke-linecap="round" '+extra+'/>';
const box=(x,y,w,h,color,extra='')=>'<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" fill="'+color+'" '+extra+'/>';
const g=(transform,content)=>'<g transform="'+transform+'">'+content+'</g>';
const windowed=(x,y,w,h,content)=>'<svg x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" overflow="hidden">'+content+'</svg>';
const circ=(x,y,r,fill,extra='')=>'<circle cx="'+x+'" cy="'+y+'" r="'+r+'" fill="'+fill+'" '+extra+'/>';
const line=(x,y,x2,y2,color)=>p('M'+x+' '+y+'L'+x2+' '+y2,color);
const river='M-35 155C20 137 42 112 76 112S135 154 176 150 229 91 268 90 333 113 362 72';
const street='M-10 32 375 167M-10 55 375 190M-10 80 375 215M-10 105 375 240M-10 130 375 265M-10 155 375 290M49 -10 12 280M83 -10 45 280M119 -10 87 280M155 -10 115 280M195 -10 162 280M231 -10 201 280M273 -10 237 280M321 -10 277 280';
const map=(road,water)=>p(street,road,1)+p(river,water,14)+p('M0 197 85 159 157 179 239 134 360 154M-10 91 80 79 145 105 229 63 371 72',road,3);
const filled=(d,color)=>'<path d="'+d+'" fill="'+color+'"/>';
const dash=(x,y,x2,y2,color)=>p('M'+x+' '+y+'L'+x2+' '+y2,color,1,'stroke-dasharray="3 4"');
function contour(cx,cy,count){
 let paths='';
 for(let n=1;n<=count;n++){
  const pts=Array.from({length:48},(_,i)=>{const a=i*Math.PI/24;const r=n*10+Math.sin(3*a+n*.37)*7+Math.cos(5*a)*4;return (cx+Math.cos(a)*r*1.22).toFixed(1)+','+(cy+Math.sin(a)*r*.74).toFixed(1)});
  paths+=p('M'+pts.join('L')+'Z',n%4===0?'#4d7969':'#2b534c',n%4===0?1.3:.8);
 }
 return paths;
}
const speedColors=['#4196ff','#44dbc9','#ffce61','#ff7260'];
const ticketInk='#29485c', ticketPaper='#f9d77a';
const zineInk='#133637', zinePaper='#f6ebcb';
const newsInk='#221e1a';
const blueprintInk='#d9edff';
const jersey='M111 98 141 84C150 113 190 113 199 84L229 98 255 132 226 153 210 137 210 221 130 221 130 137 114 153 85 132Z';
function bicycle(color,shirt){
 return circ(20,60,18,'none','stroke="'+color+'" stroke-width="3"')+
  circ(81,60,18,'none','stroke="'+color+'" stroke-width="3"')+
  p('M20 60 39 38 54 60 20 60M39 38H69L54 60H81L70 29H77M35 34H45',color,3)+
  p('M50 24 41 37 58 46 53 57',color,5)+
  p('M50 24 61 15 67 28 76 31',shirt,7)+circ(64,7,6,color);
}
const filmCream='#e9ecce';
const comicInk='#24213a';
const dialPoint=(percent,radius)=>{
 const angle=(155+230*percent/100)*Math.PI/180;
 return [180+Math.cos(angle)*radius,208+Math.sin(angle)*radius];
};
const dialArc=(percent,color)=>{
 const [x,y]=dialPoint(0,111), [endX,endY]=dialPoint(percent,111);
 return p('M'+x+' '+y+'A111 111 0 '+(percent>180/230*100?1:0)+' 1 '+endX+' '+endY,color,11);
};
const dialTicks=Array.from({length:21},(_,i)=>{
 const major=i%5===0, [x,y]=dialPoint(i*5,major?91:96), [endX,endY]=dialPoint(i*5,101);
 return p('M'+x+' '+y+'L'+endX+' '+endY,major?'#fff4d0':'#6e756c',major?2:1);
}).join('');
const crestOutline='M19 197 151 108 338 184 207 275Z';

function gridArt(grid) {
  if (!grid) return Array.from({ length: 96 }, (_, index) =>
    box(24 + index % 12 * 26, 95 + Math.floor(index / 12) * 26, 25, 25, 'none', 'stroke="#9ab7b8" stroke-width=".5"')).join('');
  const { current, previous, fresh } = grid;
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (const [x, y] of current) {
    left = Math.min(left, x - 1); right = Math.max(right, x + 1);
    bottom = Math.min(bottom, y - 1); top = Math.max(top, y + 1);
  }
  const stride = Math.ceil(Math.max(1, (right - left + 1) / 76, (top - bottom + 1) / 48));
  const cols = Math.ceil((right - left + 1) / stride), rows = Math.ceil((top - bottom + 1) / stride);
  const step = Math.min(38, 298 / cols, 190 / rows);
  const dx = 180 - cols * step / 2, dy = 198 - rows * step / 2;
  const cells = new Map();
  const setCell = (x, y, color) => {
    const col = Math.floor((x - left) / stride), row = Math.floor((top - y) / stride);
    cells.set(`${col},${row}`, [col, row, color]);
  };
  for (const [x, y] of previous) {
    if (x >= left && x <= right && y >= bottom && y <= top) setCell(x, y, '#377882');
  }
  for (const [x, y] of current) setCell(x, y, '#377882');
  for (const [x, y] of fresh) setCell(x, y, '#ffca55');
  return [...cells.values()].map(([col, row, color]) => box(dx + col * step, dy + row * step,
    step, step, color, 'stroke="#cadbd8" stroke-width=".4"')).join('');
}

function speedTrace(lines) {
  return lines.map(points => points.slice(1).map(([x, y, speed], index) => {
    const [previousX, previousY] = points[index];
    const kmh = speed * 3.6;
    const bin = kmh < 18 ? 0 : kmh < 26 ? 1 : kmh < 34 ? 2 : 3;
    return p(`M${previousX} ${previousY}L${x} ${y}`, Number.isFinite(speed) ? speedColors[bin] : '#a4b1bd', 5);
  }).join('')).join('');
}

function stationArt(distanceKm) {
  if (!Number.isFinite(distanceKm)) return t(180,205,'缺少活动里程',14,'cn','text-anchor="middle"');
  const stations = [
    [55,250,71,255,'出发'], [98,179,98,160,.2], [160,103,160,91,.4],
    [240,144,255,148,.6], [301,229,285,232,.8], [203,289,203,315,'到达'],
  ];
  const path = 'M55 250V201Q55 179 77 179H109Q131 179 131 157V123Q131 103 151 103H216Q240 103 240 127V169Q240 192 263 192H277Q301 192 301 216V266Q301 289 278 289H203';
  return p(path, '#c0d9ce', 13) + p(path, '#297263', 7) + stations.map(([x,y,tx,ty,label], i) => {
    const alignment = [2,5].includes(i) ? 'middle' : i === 4 ? 'end' : 'start';
    const value = typeof label === 'number' ? `${(distanceKm * label).toFixed(1)} km` : label;
    return circ(x,y,7,i === 0 || i === 5 ? '#f3cd65' : '#f5f8f3','stroke="#236252" stroke-width="3"') +
      t(tx,ty,value,10,'cn',`text-anchor="${alignment}" font-weight="700"`);
  }).join('');
}

function stitchArt(lines) {
  const cells = new Set();
  for (const points of lines) for (let i = 1; i < points.length; i++) {
    const [x,y] = points[i - 1], [endX,endY] = points[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(endX - x, endY - y) / 3));
    for (let step = 0; step <= steps; step++) {
      const col = Math.round((x + (endX - x) * step / steps - 55) / 7);
      const row = Math.round((y + (endY - y) * step / steps - 24) / 7);
      cells.add(`${col},${row}`);
    }
  }
  return [...cells].map(key => {
    const [col,row] = key.split(',').map(Number);
    const x = 54 + col * 8, y = 111 + row * 7.15;
    return p(`M${x} ${y}l6 6m0 -6l-6 6`,col < 7 ? '#ad563b' : '#425f54',2.2);
  }).join('');
}

function terrainArt(lines) {
  const heights = lines.flat().map(point => point[2]).filter(Number.isFinite);
  const minimum = Math.min(...heights), span = Math.max(...heights) - minimum || 1;
  const path = tracePath(lines.map(points => points.map(([x,y,altitude]) => {
    const lift = Number.isFinite(altitude) ? (altitude - minimum) / span * 37 : 0;
    return [94 + .78 * x - .34 * y, 132 + .19 * x + .40 * y - lift];
  })));
  return p(path,'#305b4d',7) + p(path,'#fbecaf',3);
}

function chapterArt(lines, color) {
  const points = lines.flat();
  if (!points.length) return '';
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const left = Math.min(...xs), top = Math.min(...ys);
  const width = Math.max(...xs) - left, height = Math.max(...ys) - top;
  const fit = Math.min(139 / (width || 1), 60 / (height || 1));
  return p(tracePath(lines.map(segment => segment.map(([x,y]) =>
    [154 + (139 - width * fit) / 2 + (x - left) * fit, 14 + (60 - height * fit) / 2 + (y - top) * fit]))), color, 2.6);
}

function recipes(d) {
  const route = d?.route;
  const profile = d?.profile;
  const strokeRoute = (color, width = 4) => p(route, color, width);
  const routeMark = (color, size) => d.first ? circ(...d.first, size, color) : '';
  return [
    ['路线贴纸', '日常分享', '#173cda', '#fffdf2', () =>
      t(22,29,'RIDE / ROUTE EDITION',11,'en')+t(336,29,'01',11,'en','text-anchor="end"')+line(22,41,338,41,'#91a4f9')+
  t(22,86,d.title,37,'cn','font-weight="800"')+t(22,109,d.date,11,'en')+
  g('translate(9 108) scale(1.04)',p(route,'#102ea6',22,'transform="translate(1 6)"')+strokeRoute('#fffdf2',21)+strokeRoute('#213fe0',8)+routeMark('#ffca51',5))+
  line(22,316,338,316,'#91a4f9')+t(22,360,d.distanceNumber,40,'num')+t(22,385,'DISTANCE / KM',11,'en')+t(212,350,d.ascentSigned,22,'num')+t(212,373,d.durationLabel,12)],
    ['山脊等高线', '爬坡与长途', '#112f2b', '#f4f2d9', () =>
      contour(168,160,16)+contour(317,232,6)+box(0,0,360,92,'#112f2b')+t(21,28,'RIDE / TOPOGRAPHIC SERIES',11,'en','fill="#c7e5a2"')+t(21,72,'山脊之上',34,'cn','font-weight="800"')+
  g('translate(19 80) scale(.99 .92)',p(route,'#112f2b',8)+strokeRoute('#dcf5a6',3.5))+
  box(0,273,360,135,'#112f2b')+line(22,273,338,273,'#648474')+t(22,311,d.ascentSigned,32,'num','fill="#dcf5a6"')+t(174,298,'累计爬升',12)+t(174,318,d.titleDistance,12)+
  g('translate(22 323) scale(1 .7)',p(profile,'#dcf5a6',2))+line(22,385,338,385,'#648474')+t(22,399,profile?'所选路线海拔':'等高线为装饰',9)+t(338,399,d.distance,9,'en','text-anchor="end"')],
    ['竞速黑牌', '同路线挑战', '#1a1c1f', '#fff8ec', () =>
      box(22,23,7,15,'#ff7848')+t(38,35,'RIDE / SAME ROUTE',11,'en')+line(22,50,338,50,'#5e6061')+
  t(22,83,d.resultTitle,23,'cn','font-weight="700"')+t(19,163,d.resultValue,d.resultValue.length>7?54:70,'num','fill="#ff7848"')+
  g('translate(108 178) scale(.76 .63)',strokeRoute('#494d51',5)+p(route,'#fff8ec',2.8,'stroke-dasharray="2 7"'))+
  t(22,202,d.title,15)+t(22,226,d.distance,14,'en')+t(22,250,d.resultNote,12,'cn','fill="#cbc7bc"')+
  box(22,304,316,79,'#292d31')+t(34,328,d.currentLabel,11)+t(183,328,d.baselineLabel,11)+t(34,361,d.currentValue,23,'num')+t(183,361,d.baselineValue,23,'num')+line(167,319,167,368,'#55585a')],
    ['街区解锁', '探索与新格子', '#dfe7e3', '#102f3a', () =>
      t(21,28,'RIDE / EXPLORER MAP',11,'en')+t(21,69,'今天开了新图',29,'cn','font-weight="800"')+
  box(0,87,360,222,'#cadbd8')+gridArt(d.grid)+
  (d.grid ? '' : t(180,204,'仅显示探索统计',17,'cn','text-anchor="middle" font-weight="700"'))+
  t(21,364,d.explored,52,'num')+t(122,355,'新增格子',17,'cn','font-weight="800"')+t(122,378,d.exploredTotal,12)+box(248,344,10,10,'#ffca55')+t(264,354,'本次新增',10)+box(248,365,10,10,'#377882')+t(264,375,'历史走过',10)],
    ['骑行月刊', '月度明信片', '#f8ecdd', '#513126', () =>
      t(22,29,"RIDE LETTER / MONTHLY",11,'en')+t(337,29,d.month.slice(0,4),11,'en','text-anchor="end"')+line(22,41,338,41,'#ad8e77')+
  t(22,88,d.monthTitle,29,'serif','font-weight="800"')+
  box(22,105,316,178,'#eedcc8')+windowed(22,105,316,178,g('translate(15 8) scale(.90 .75)',map('#d3bca3','#e1b8a1')+g('translate(24 4)',strokeRoute('#92503a',5))))+
  t(32,268,d.hasRoute ? "当月代表路线" : "当月骑行统计",10,'cn','fill="#684533"')+line(22,306,338,306,'#ad8e77')+
  t(22,346,d.monthDistance,30,'num')+t(131,346,d.monthAscent,30,'num')+t(260,346,d.monthRideCount,30,'num')+
  t(22,367,'总距离 km',11)+t(131,367,'累计爬升 m',11)+t(260,367,'骑行次数',11)+t(22,392,d.monthFooter,11)],
    ['周末路书', '路线手账 / 约骑', '#f9f5e6', '#303823', () =>
      t(21,27,'RIDE / FIELD NOTES',11,'en')+line(21,39,339,39,'#9eaa8a')+
  t(21,80,'周末走这条',34,'serif','font-weight="800"')+t(22,104,d.facts,12)+
  box(22,119,316,139,'#e4ead5')+windowed(22,119,316,139,g('translate(10 7) scale(.84 .64)',map('#ccd6b8','#b4cebf')+p(route,'#f4f2dc',7)+strokeRoute('#496438',3.5)))+
  d.tags.map((tag,i)=>box(23+i*101,269,94,21,'#dce5cb')+t(32+i*101,284,tag,11)).join('')+
  line(22,308,338,308,'#a6ae92')+t(22,331,'01  补水',12,'cn','font-weight="700"')+t(114,331,d.water,12)+
  line(22,344,338,344,'#a6ae92')+t(22,367,'02  路况',12,'cn','font-weight="700"')+t(114,367,d.road,12)+line(22,380,338,380,'#a6ae92')],
    ['周末车票', '给骑过的路线留张票', ticketInk, ticketInk, () =>
      box(26,24,308,360,ticketPaper,'rx="5"')+box(37,35,286,337,'none','stroke="#746a47"')+
  t(48,57,'RIDE RAIL / WEEKEND PASS',11,'en')+t(312,57,"RIDE 07",11,'en','text-anchor="end"')+
  line(48,69,312,69,'#8a7649')+t(48,111,d.title,33,'serif','font-weight="800"')+
  t(48,133,d.date || "骑行纪念票",11)+
  g('translate(82 131) scale(.65 .59)',strokeRoute(ticketInk,4)+routeMark(ticketInk,6))+
  t(48,251,'DISTANCE',9,'en')+t(162,251,'TIME',9,'en')+t(245,251,'ASCENT',9,'en')+
  t(48,278,d.distance,20,'num')+t(162,278,d.duration,20,'num')+t(245,278,d.ascent,20,'num')+
  dash(34,300,326,300,'#75633a')+circ(26,300,8,ticketInk)+circ(334,300,8,ticketInk)+
  Array.from({length:36},(_,i)=>box(49+i*4.3,320,i%4===0?2.5:1,23,ticketInk)).join('')+
  t(312,340,'已骑完',17,'serif','text-anchor="end" font-weight="800"')+t(49,360,"RIDE / ACTIVITY ARCHIVE",9,'en')],
    ['路线指纹', '用轨迹做一枚印章', '#efebfa', '#28244c', () =>
      t(23,30,'RIDE / ROUTE IMPRESSION',11,'en')+t(337,30,'08',11,'en','text-anchor="end"')+
  line(23,43,337,43,'#a4a0b6')+t(23,86,'骑过的痕迹',33,'cn','font-weight="800"')+
  box(24,106,312,199,'#e5dff4')+
  [30,324].map(x=>[112,293].map(y=>p('M'+x+' '+(y+5)+'h10M'+(x+5)+' '+y+'v10','#8f86ad')).join('')).join('')+
  g('translate(20 101) scale(1 .94)',Array.from({length:8},(_,i)=>
    g(`translate(160 103) scale(${1-i*.1}) translate(-160 -103)`,p(route,i?'#67628b':'#28244c',i?2.3:4,'vector-effect="non-scaling-stroke"'))).join('')+routeMark('#d2485c',4))+
  t(180,288,"RIDE / GPS TRACE",10,'en','text-anchor="middle"')+
  line(23,325,337,325,'#a4a0b6')+t(23,352,d.title,19,'cn','font-weight="800"')+
  t(23,379,d.date,11,'en')+t(337,367,d.distance,28,'num','text-anchor="end"')],
    ['公路杂志', '把周末骑成封面', zinePaper, zineInk, () =>
      t(23,32,'RIDE / THE WEEKEND EDITION',11,'en')+t(337,32,'VOL. 09',11,'en','text-anchor="end"')+
  box(15,47,330,326,'#a5cbb7')+
  circ(276,138,47,'#ef815e')+
  filled('M15 219 73 167 101 183 151 145 206 193 261 172 345 211V373H15Z','#70a08e')+
  filled('M15 257 67 207 110 239 166 186 219 230 255 201 345 251V373H15Z','#306d65')+
  filled('M15 291 79 268 117 284 170 246 226 288 273 250 345 289V373H15Z','#174f4c')+
  filled('M122 373C210 331 90 330 159 298S259 261 219 246C284 262 220 294 191 314S216 345 215 373Z',zinePaper)+
  p('M172 373C222 335 124 331 178 306S260 264 219 246','#e97d59',2,'stroke-dasharray="5 7"')+
  t(24,120,'公路之外',58,'serif','font-weight="800"')+t(28,143,'THE ROAD OUT',12,'en')+
  box(24,304,152,53,zineInk)+t(33,326,d.title,13,'cn','fill="#fbefce"')+t(33,344,d.distance+" / "+d.ascent,10,'en','fill="#fbefce"')+
  t(23,394,d.date,10,'en')+t(337,394,'骑行专刊',11,'cn','text-anchor="end"')],
    ['速度光谱', '看哪一段骑得最快', '#15202b', '#f5f7f7', () =>
      t(23,30,'RIDE / SPEED TRACE',11,'en','fill="#a8bbc5"')+
  t(23,74,'快慢，都有颜色',30,'cn','font-weight="800"')+
  box(20,94,320,191,'#1b2d39')+windowed(20,94,320,191,g('translate(-3 -12)',map('#2a4350','#26495a')))+
  g('translate(20 95)',strokeRoute('#132231',10)+speedTrace(d.speedLines)+routeMark('#f5f7f7',4))+
  (d.hasSpeeds ? speedColors.map((color,i)=>box(23+i*80,302,73,5,color)+t(23+i*80,324,['<18','18–<26','26–<34','≥34 km/h'][i],10,'en')).join('') :
    t(23,324,d.hasRoute?'所选路线缺少分段速度':'显示路线后可查看分段速度',12))+
  (d.hasSpeeds && d.speedEstimated ? t(337,338,'含估算速度',9,'cn','text-anchor="end"') : '')+
  line(23,342,337,342,'#52646f')+t(23,381,d.speedNumber,39,'num')+
  t(113,366,'平均速度',12)+t(113,384,'km/h',11,'en')+t(337,381,d.titleDistance,11,'cn','text-anchor="end"')],
    ['爬坡勋章', '给这次爬升颁个奖', '#302638', '#f9e6b7', () =>
      t(23,31,'RIDE / CLIMB COLLECTION',11,'en')+line(23,46,337,46,'#806775')+
  filled('M118 60H161L182 133 149 151Z','#d2605c')+filled('M199 60H242L211 151 178 133Z','#aa4d5b')+
  circ(180,207,99,'#1f1725')+circ(180,201,96,'#edbb67')+circ(180,201,87,'#302638')+
  circ(180,201,77,'none','stroke="#d5a457" stroke-width="1" stroke-dasharray="2 4"')+
  filled('M119 209 153 166 170 184 194 150 240 209Z','#edbb67')+filled('M170 184 194 150 217 181 199 175 192 181 182 175Z','#fff0c3')+
  t(180,246,d.ascentSigned,33,'num','text-anchor="middle"')+t(180,263,'累计爬升',11,'cn','text-anchor="middle"')+
  t(180,342,'今日爬坡勋章',29,'serif','text-anchor="middle" font-weight="800"')+
  line(23,359,337,359,'#806775')+t(23,383,d.titleDistance,11)+t(337,383,d.date,11,'en','text-anchor="end"')],
    ['骑迹三格', '三幕讲完这一趟', '#f7efdf', '#302d33', () =>
      t(23,29,'RIDE / THREE PANELS',11,'en')+t(23,72,'一趟骑行，三幕',32,'cn','font-weight="800"')+
  box(22,90,316,90,'#e8b76d','stroke="#302d33" stroke-width="2"')+
  windowed(23,91,314,88,filled('M111 88 171 56 213 66 285 34 314 43V88Z','#d19a52')+circ(241,37,25,'#fff0bb')+chapterArt(d.chapters[0],'#302d33'))+
  t(34,114,'CHAPTER 01',11,'en')+t(34,153,'起段',22,'cn','font-weight="800"')+
  box(22,189,316,90,'#c5d6bb','stroke="#302d33" stroke-width="2"')+
  windowed(23,190,314,88,filled('M104 88 161 55 182 62 219 24 243 48 267 21 314 67V88Z','#8fa890')+
  chapterArt(d.chapters[1],'#303c30'))+
  t(34,213,'CHAPTER 02',11,'en')+t(34,252,'中段',22,'cn','font-weight="800"')+
  box(22,288,316,90,'#bfcfe1','stroke="#302d33" stroke-width="2"')+
  windowed(23,289,314,88,filled('M118 88 167 48 199 61 221 51 269 76 314 65V88Z','#91abc7')+
  chapterArt(d.chapters[2],'#2f4b60'))+
  t(34,312,'CHAPTER 03',11,'en')+t(34,351,'末段',22,'cn','font-weight="800"')+
  t(23,398,d.facts,10)],
    ['骑行日报', '把这一趟放上头版', '#f2ead8', newsInk, () =>
      t(21,26,'VOL. 01  /  WEEKEND EDITION',10,'en')+t(339,26,d.date,10,'en','text-anchor="end"')+
  line(21,39,339,39,newsInk)+t(180,94,'骑 行 日 报',41,'serif','text-anchor="middle" font-weight="800"')+
  line(21,107,339,107,newsInk)+line(21,110,339,110,newsInk)+
  t(21,133,"今日头条 / "+d.title,12,'cn','fill="#813a32" font-weight="800"')+
  t(21,169,"又骑了一趟",29,'serif','font-weight="800"')+
  box(21,185,188,134,'#dfd4bd')+
  g('translate(7 195) scale(.66 .61)',strokeRoute(newsInk,3.4)+routeMark('#813a32',4))+
  line(221,185,221,319,'#b0a48e')+t(233,212,d.distance,23,'num')+t(233,232,'骑行距离',10)+
  t(233,262,d.ascent,23,'num')+t(233,282,'累计爬升',10)+t(233,309,d.durationLabel,11)+
  line(21,335,339,335,newsInk)+t(21,359,d.facts,13,'serif')+
  t(21,386,"RIDE / ACTIVITY ARCHIVE",10,'en')+t(339,386,'01',10,'en','text-anchor="end"')],
    ['车手闪卡', '一趟骑行一张收藏卡', '#232633', '#242934', () =>
      box(20,18,320,372,'#e4e1cf','rx="16"')+
  box(30,28,300,352,'#b4cbda','rx="10"')+
  windowed(31,29,298,350,filled('M0 166 190 0H240L0 214ZM0 234 266 0H296L0 259ZM41 350 298 136V180L90 350Z','#d8e8dd')+
   filled('M113 350 298 206V246L167 350ZM0 110 128 0H165L0 142Z','#9faac9'))+
  t(46,55,'RIDE / COLLECTOR SERIES',10,'en')+t(315,55,'#014',11,'en','text-anchor="end"')+
  circ(180,158,85,'#dfe9e0','stroke="#76849c"')+circ(180,158,72,'none','stroke="#8697a5" stroke-dasharray="2 3"')+
  g('translate(21 19) scale(.93 .88)',filled(jersey,'#283b65')+
   filled('M130 151H210V166H130ZM130 171H210V177H130Z','#eab65a')+
   p(jersey,'#243447',2.4)+t(170,147,'RIDE',20,'en','text-anchor="middle" fill="#f6ead5"'))+
  box(40,242,280,121,'#f3eddb','rx="6"')+t(52,273,d.title,25,'cn','font-weight="800"')+
  t(309,273,'LOOP',10,'en','text-anchor="end"')+line(52,284,308,284,'#9e9b94')+
  t(52,319,d.distanceNumber,26,'num')+t(141,319,d.ascentNumber,26,'num')+t(233,319,d.speedNumber,26,'num')+
  t(52,340,'距离 / km',10)+t(141,340,'爬升 / m',10)+t(233,340,'均速 / km/h',10)],
    ['路线蓝图', '适合标记关键路段', '#133f72', blueprintInk, () =>
      box(14,14,332,380,'none','stroke="#8aafd6"')+
  t(26,39,'RIDE / ROUTE BLUEPRINT',10,'en')+t(334,39,'REV. 01',10,'en','text-anchor="end"')+
  line(26,50,334,50,'#8aafd6')+t(26,87,'路线蓝图',28,'cn','font-weight="800"')+
  Array.from({length:14},(_,i)=>line(26+i*22,101,26+i*22,283,'#315e8b')).join('')+
  Array.from({length:9},(_,i)=>line(26,102+i*22,334,102+i*22,'#315e8b')).join('')+
  g('translate(31 99)',strokeRoute('#e7f5ff',2.6)+routeMark('#e9c879',4))+
  (d.hasRoute?'':t(180,200,'路线已隐藏或缺少定位',12,'cn','text-anchor="middle"'))+
  line(26,297,334,297,'#8aafd6')+t(26,319,'DISTANCE',9,'en')+t(136,319,'ASCENT',9,'en')+t(239,319,'MOVING TIME',9,'en')+
  t(26,348,d.distance,22,'num')+t(136,348,d.ascent,22,'num')+t(239,348,d.duration,22,'num')+
  line(26,364,334,364,'#8aafd6')+t(26,383,d.titleDate,10)+t(334,383,'示意比例',10,'cn','text-anchor="end"')],
    ['骑行唱片', '把每一趟做成一张专辑', '#f5ad93', '#231f29', () =>
      t(21,27,"RIDE RECORDS",10,'en')+t(339,27,'VOL. 16',10,'en','text-anchor="end"')+
  t(21,72,'这一趟的节奏',34,'serif','font-weight="800"')+
  circ(180,191,104,'#1d1d28')+
  Array.from({length:8},(_,i)=>circ(180,191,54+i*6,'none','stroke="'+(i%2?'#454553':'#333340')+'" stroke-width="1.2"')).join('')+
  p('M112 141A84 84 0 0 1 160 111M209 273A87 87 0 0 0 261 227','#9d7775',2)+
  circ(180,191,48,'#f1dbac')+g('translate(132 155) scale(.3 .29)',strokeRoute('#533f43',4))+
  circ(180,191,4,'#1d1d28')+t(180,225,d.duration,13,'en','text-anchor="middle"')+
  line(23,308,337,308,'#99675f')+t(23,331,d.hasSpeeds?'速度节奏':'未显示分段速度',10)+
  d.tempo.map((height,i)=>box(24+i*9.8,363-height,5,height,'#744955')).join('')+
  line(23,369,337,369,'#99675f')+t(23,389,d.titleDistance,10)+t(337,389,d.date,10,'en','text-anchor="end"')],
    ['骑行站牌', '用几个地标讲清路线', '#e8f0ed', '#173a39', () =>
      t(21,29,'RIDE / LOOP LINE',11,'en')+t(339,29,'LINE 01',11,'en','text-anchor="end"')+
  t(21,66,'骑行站牌',31,'cn','font-weight="800"')+
  box(21,78,318,250,'#f5f8f3','stroke="#c5d8d0"')+
  stationArt(d.distanceKm)+
  line(21,342,339,342,'#9fb4ad')+t(21,379,d.distance,29,'num')+t(339,368,d.title,13,'cn','text-anchor="end"')+
  t(339,387,'按里程等分 · 示意站牌',10,'cn','text-anchor="end"')],
    ['骑友合影框', '给一起骑的人留个纪念', '#f3e7d4', '#3f2c38', () =>
      t(21,28,'RIDE / GROUP RIDE',11,'en')+t(339,28,d.date,10,'en','text-anchor="end"')+
  box(22,47,316,277,'#aa817b')+box(19,44,316,276,'#fffbec')+
  (d.photo ? '<image x="29" y="54" width="296" height="213" preserveAspectRatio="xMidYMid slice" href="'+escapeXml(d.photo)+'"/>' :
  windowed(29,54,296,213,box(0,0,296,213,'#d8a89e')+circ(237,54,33,'#ffdf9e')+
   filled('M0 108 69 78 133 104 177 78 241 109 296 97V213H0Z','#b48482')+
   filled('M0 149 59 120 102 131 168 105 229 139 296 122V213H0Z','#7f7181')+
   filled('M0 181 296 156V213H0Z','#574e61')+p('M0 193 296 169','#b29498',1,'stroke-dasharray="14 7"')+
   g('translate(29 96) scale(1.14)',bicycle('#302c3c','#f7d38e'))+
   g('translate(151 100) scale(1.12)',bicycle('#302c3c','#b9d9cd'))+
   box(10,10,61,18,'#f2dbba')+t(15,23,'示意插画',9)))+
  t(32,298,d.title,22,'serif','font-weight="800"')+t(321,298,d.distance,21,'num','text-anchor="end"')+
  t(21,360,'今天，有人一起骑',29,'serif','font-weight="800"')+
  line(21,374,339,374,'#b29a92')+t(21,393,'GROUP RIDE MEMORY',10,'en')+t(339,393,d.durationLabel,11,'cn','text-anchor="end"')],
    ['运动电影海报', '把长骑做成电影主视觉', '#102125', filmCream, () =>
      box(15,14,330,380,'none','stroke="#7a8f80"')+t(27,37,'RIDE CINEMA  /  FEATURE 019',10,'en')+
  t(333,37,d.date,10,'en','text-anchor="end"')+
  circ(181,207,94,'#b66950')+circ(181,207,76,'#df9970')+
  filled('M16 210 69 159 93 171 133 145 155 181 211 163 231 194 267 155 344 208V319H16Z','#42564e')+
  filled('M16 258 69 215 116 226 144 214 206 244 267 211 344 229V335H16Z','#263f3c')+
  filled('M69 341 171 240 183 240 298 341Z','#58655a')+
  p('M169 341 177 250',filmCream,2,'stroke-dasharray="8 9"')+
  g('translate(126 226) scale(1.06)',bicycle('#0f2023','#ebbf8b'))+
  t(27,86,'逆风而行',43,'serif','font-weight="800"')+t(29,112,'INTO THE WIND',14,'en')+
  box(16,339,328,54,'#102125')+line(27,340,333,340,'#7a8f80')+
  t(27,366,d.title,16,'serif','font-weight="800"')+
  t(333,366,d.distance+" / "+d.ascentSigned,16,'num','text-anchor="end"')+t(27,383,'A WEEKEND RIDE',9,'en')],
    ['漫画爆发', '适合晒爬坡和冲刺', '#f8d252', comicInk, () =>
      box(16,15,328,378,'none','stroke="#24213a" stroke-width="3"')+
  windowed(18,17,324,374,Array.from({length:13},(_,i)=>{
   const angle=(i*31-20)*Math.PI/180, x=162+Math.cos(angle)*240, y=173+Math.sin(angle)*240;
   return filled('M162 173 '+x+' '+y+' '+(x+18)+' '+(y+9)+'Z','#efad3f');
  }).join(''))+
  box(26,25,171,22,comicInk)+t(33,41,'RIDE / COMIC BOOK',11,'en','fill="#fff1b9"')+
  filled('M45 143 100 130 73 91 131 108 141 64 175 99 216 65 218 107 279 88 256 127 320 146 276 173 321 200 262 207 278 249 227 230 197 272 176 233 117 260 122 215 60 222 89 181Z','#fff4c0')+
  p('M45 143 100 130 73 91 131 108 141 64 175 99 216 65 218 107 279 88 256 127 320 146 276 173 321 200 262 207 278 249 227 230 197 272 176 233 117 260 122 215 60 222 89 181Z',comicInk,3)+
  t(176,195,'冲！',83,'cn','font-weight="900" fill="#b6393d" text-anchor="middle" transform="rotate(-9 176 170)"')+
  g('translate(43 253) scale(.47 .32)',strokeRoute(comicInk,5)+routeMark('#b6393d',5))+
  t(192,290,d.title,17,'cn','font-weight="800"')+
  box(26,329,307,49,comicInk)+t(38,361,d.distance,25,'num','fill="#fff1b9"')+
  t(322,359,"爬升 "+d.ascent,15,'cn','text-anchor="end" fill="#fff1b9"')],
    ['织纹路线', '把轨迹织成一枚布标', '#d7d5bd', '#334b42', () =>
      box(21,22,318,364,'#e9e4cb','stroke="#6a7b68" stroke-width="1.5" rx="6"')+
  box(28,29,304,350,'none','stroke="#879281" stroke-dasharray="3 4" rx="5"')+
  t(40,55,'RIDE / WOVEN ROUTES',10,'en')+t(320,55,'NO. 021',10,'en','text-anchor="end"')+
  t(40,89,d.title,24,'serif','font-weight="800"')+
  box(39,101,282,195,'#dcdcc2')+
  Array.from({length:33},(_,i)=>line(46+i*8,107,46+i*8,277,'#c1c8ac')).join('')+
  Array.from({length:24},(_,i)=>line(46,107+i*7.15,310,107+i*7.15,'#c1c8ac')).join('')+
  stitchArt(d.lines)+
  t(180,290,'GPS STITCH PATTERN',9,'en','text-anchor="middle"')+
  dash(40,308,320,308,'#82907d')+t(40,343,d.distance,29,'num')+
  t(320,340,"爬升 "+d.ascent,12,'cn','text-anchor="end"')+t(320,360,d.date,10,'en','text-anchor="end"')],
    ['山地积木', '把真实轨迹放进一块立体地形', '#e1dfd0', '#213f3c', () =>
      t(22,30,'RIDE / TERRAIN OBJECT',10,'en')+t(338,30,'PLATE 22',10,'en','text-anchor="end"')+
  t(22,73,'把山带回家',35,'serif','font-weight="800"')+
  filled('M19 197 207 275 207 317 19 239Z','#789183')+
  filled('M207 275 338 184 338 226 207 317Z','#4a7166')+
  p('M19 208 207 286 338 195M19 220 207 298 338 207M19 231 207 309 338 218','#c0c7a7',1.5)+
  filled(crestOutline,'#a6baa0')+
  filled('M19 197 81 158 100 171 130 142 151 108 188 143 215 133 267 157 338 184 207 275Z','#bac8a5')+
  filled('M19 197 81 158 100 171 117 160 144 194 183 172 224 194 250 188 285 220 207 275Z','#8ba78d')+
  filled('M100 171 130 142 151 108 188 143 183 172 144 194 117 160Z','#648b78')+
  filled('M183 172 188 143 215 133 267 157 250 188 224 194Z','#cad0a8')+
  p('M19 197 81 158 100 171 130 142 151 108 188 143 215 133 267 157 338 184M100 171 144 194 183 172 224 194 250 188 285 220M144 194 207 275', '#6d907d',1.2)+
  terrainArt(d.lines)+
  line(22,330,338,330,'#a2a893')+t(22,374,d.ascentSigned,38,'num')+
  t(338,358,d.titleDistance,12,'cn','text-anchor="end"')+
  t(338,378,'示意地形模型',10,'cn','text-anchor="end"')],
    ['骑行日历', '看看这个月哪几天骑过', '#f0ece0', '#214940', () =>
      t(22,29,'RIDE / MONTH GRID',10,'en')+t(338,29,d.month,10,'en','text-anchor="end"')+
  t(22,79,d.monthTitle,32,'serif','font-weight="800"')+
  box(22,99,316,180,'#e4e8d9')+
  ['日','一','二','三','四','五','六'].map((day,i)=>t(43+i*45.5,121,day,12,'cn','text-anchor="middle"')).join('')+
  Array.from({length:d.daysInMonth},(_,i)=>{
   const day=i+1, slot=i+d.monthOffset, x=43+slot%7*45.5, y=144+Math.floor(slot/7)*24;
   const mark=d.calendarDays.has(day);
   return (mark?circ(x,y-4,10,day===d.highlightDay?'#a84c3a':'#2c695b'):'')+
    t(x,y,day,10,'en',mark?'text-anchor="middle" fill="#fff9e5"':'text-anchor="middle"');
  }).join('')+
  circ(32,296,5,'#2c695b')+t(43,300,'骑行日',10)+(d.highlightDay?circ(105,296,5,'#a84c3a')+t(116,300,'所选活动',10):'')+
  line(22,317,338,317,'#8e9b88')+t(22,355,d.monthDayCount,29,'num')+t(133,355,d.monthDistance,29,'num')+t(250,355,d.monthAscent,29,'num')+
  t(22,375,'骑行日',11)+t(133,375,'总距离 km',11)+t(250,375,'累计爬升 m',11)],
    ['百公里刻度', '用机械仪表显示挑战进度', '#222925', '#f4efd9', () =>
      t(22,30,'RIDE / DISTANCE CHALLENGE',10,'en')+t(338,30,d.target+" KM TARGET",10,'en','text-anchor="end"')+
  line(22,44,338,44,'#74786a')+t(22,84,'今天，骑到哪一格',29,'cn','font-weight="800"')+
  dialArc(100,'#4c5549')+(d.progress?dialArc(d.progress,'#efbd62'):'')+dialTicks+
  t(180,186,'已完成',12,'cn','text-anchor="middle"')+t(180,236,d.distanceNumber,61,'num','text-anchor="middle"')+
  t(180,259,"KM / "+d.target+" KM",12,'en','text-anchor="middle"')+
  t(66,291,'0',12,'en','text-anchor="middle"')+t(294,291,String(d.target),12,'en','text-anchor="middle"')+
  box(22,320,316,57,'#303b33')+t(36,354,d.remainingLabel,12)+t(324,356,d.remaining,28,'num','text-anchor="end" fill="#f0bd62"')+
  t(22,394,d.title,10)],
  ];
}

export const shareThemes = recipes().map(([name, description], index) => ({ id: index + 1, name, description }));

export function rideShareSvg(id, options) {
  const [, , background, ink, draw] = recipes(posterData(id, options))[id - 1];
  return '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1224" viewBox="0 0 360 408">' +
    '<style>.en{font-family:Consolas,monospace;font-weight:700}.cn{font-family:system-ui,"Microsoft YaHei","PingFang SC",sans-serif}.serif{font-family:"Songti SC",SimSun,serif}.num{font-family:Bahnschrift,Arial,sans-serif;font-weight:700;font-variant-numeric:tabular-nums}</style>' +
    box(0,0,360,408,background) + '<g fill="' + ink + '">' + draw() + '</g></svg>';
}
