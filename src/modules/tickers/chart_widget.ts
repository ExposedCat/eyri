import { deflateSync } from "node:zlib";
import type { AllTimeDataset } from "./alltime_chart.ts";
import type { ChartBenchmark } from "./chart_benchmark.ts";

// Both benchmark snapshots travel with the message. The selector is local and
// needs neither widget queries nor changes to the bot's update polling.
export function renderChartWidget(
  dataset: AllTimeDataset,
  spyl: ChartBenchmark,
  iumo: ChartBenchmark,
): string {
  const points = dataset.points;
  if (!points.length || spyl.symbol !== "SPYL.L" || iumo.symbol !== "IUMO.L") {
    throw new Error(
      "The chart widget requires portfolio, SPYL.L and IUMO.L history.",
    );
  }
  const benchmarks = [spyl, iumo].map((benchmark) =>
    new Map(benchmark.points.map((point) => [point.date, point]))
  );
  const rows = points.map((point) => {
    const peers = benchmarks.map((benchmark) => benchmark.get(point.date));
    if (peers.some((peer) => !peer)) {
      throw new Error(
        `Widget benchmark history is incomplete on ${point.date}.`,
      );
    }
    return [point, ...peers as NonNullable<typeof peers[number]>[]];
  });
  const percent = dataset.kind !== "worth" &&
    rows.every((row) => row.every((point) => point.percentage !== null));
  const rate = dataset.displayRate ?? 1;
  const values = rows.map((row) =>
    row.map((point) => percent ? point.percentage! : point.gain * rate)
  );
  if (values.some((row) => row.some((value) => !Number.isFinite(value)))) {
    throw new Error("Invalid chart widget values.");
  }

  for (const budget of [120, 84, 60, 36, 18, 8]) {
    // Retain the first/last dates and each curve's extrema in every time bucket.
    const selected = new Set([0, points.length - 1]);
    const buckets = Math.max(1, Math.floor((budget - 2) / 6));
    for (let bucket = 0; bucket < buckets; bucket++) {
      const start = Math.floor(bucket * points.length / buckets);
      const end = Math.floor((bucket + 1) * points.length / buckets);
      for (let curve = 0; curve < 3; curve++) {
        let low = start, high = start;
        for (let i = start + 1; i < end; i++) {
          if (values[i][curve] < values[low][curve]) low = i;
          if (values[i][curve] > values[high][curve]) high = i;
        }
        if (start < end) {
          selected.add(low);
          selected.add(high);
        }
      }
    }
    const indices = [...selected].sort((a, b) => a - b);
    const data = {
      title: `${dataset.label} · ${dataset.kind ?? "alltime"}`,
      percent,
      currency: dataset.displayCurrency ?? "USD",
      dates: indices.map((i) => points[i].date),
      values: indices.map((i) =>
        values[i].map((value) => Math.round(value * 100) / 100)
      ),
      notes: dataset.notes?.join(" ") ?? "",
    };
    // User-supplied labels/notes must stay data even when they contain </script>.
    const json = JSON.stringify(data).replaceAll("<", "\\u003c").replaceAll(
      ">",
      "\\u003e",
    )
      .replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
    const html = widgetHtml(json);
    if (
      new TextEncoder().encode(html).length <= 32768 &&
      deflateSync(html, { level: 9 }).length <= 4096
    ) return html;
  }
  throw new Error(
    "Chart widget exceeds Telegram's size limit. Use /chart alltime for the full image.",
  );
}

function widgetHtml(json: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:14px 14px 24px;font:13px system-ui;color:var(--tg-theme-text-color,#e4e8ed);background:var(--tg-theme-bg-color,#15191f)}
h3{font-size:15px;margin:0 0 10px;overflow-wrap:break-word}.controls{display:flex;gap:8px;margin-bottom:8px}
button{padding:7px 18px;border:1px solid var(--tg-theme-hint-color,#87909d);border-radius:16px;background:transparent;color:inherit;font:inherit}
button.active{background:var(--tg-theme-button-color,#4486c7);color:var(--tg-theme-button-text-color,#fff);border-color:transparent}
svg{width:100%;height:210px;display:block}text{fill:var(--tg-theme-hint-color,#87909d);font:11px system-ui}
.key{display:flex;justify-content:space-between;gap:8px;margin-top:5px}.actual{color:#59d6ad}.benchmark{color:#e7c678}
@media(prefers-color-scheme:light){.actual{color:#087e62}.benchmark{color:#96630c}}
#notes{font-size:11px;line-height:1.3;color:var(--tg-theme-hint-color,#87909d);margin:8px 0 0;overflow-wrap:break-word}
</style></head><body><h3 id="title"></h3><div class="controls"><button id="spyl" class="active">SPYL</button><button id="iumo">IUMO</button></div>
<svg id="plot" viewBox="0 0 360 210"></svg><div class="key actual"><span>Portfolio</span><span id="actual"></span></div>
<div class="key benchmark"><span id="benchmarkName"></span><span id="benchmarkValue"></span></div><p id="notes"></p>
<script>
const D=${json};
const el=id=>document.getElementById(id), ns='http://www.w3.org/2000/svg';
let index=0;
el('title').textContent=D.title;el('notes').textContent=D.notes;
function format(v){return D.percent?v.toFixed(2)+'%':v.toLocaleString(undefined,{style:'currency',currency:D.currency,maximumFractionDigits:2})}
function draw(){
 const svg=el('plot');svg.innerHTML='';
 const light=typeof TelegramWidget!=='undefined'&&TelegramWidget.colorScheme==='light';
 const rows=D.values, n=rows.length, all=rows.flatMap(r=>[r[0],r[index+1]]);
 let low=Math.min(0,...all),high=Math.max(0,...all),pad=(high-low||1)*.08;low-=pad;high+=pad;
 const first=Date.parse(D.dates[0]),last=Date.parse(D.dates[n-1]);
 const x=i=>54+(last===first ? .5 : (Date.parse(D.dates[i])-first)/(last-first))*296;
 const y=v=>176-(v-low)/(high-low)*162;
 function add(tag,attrs,text){const node=document.createElementNS(ns,tag);Object.keys(attrs).forEach(k=>node.setAttribute(k,attrs[k]));if(text!==undefined)node.textContent=text;svg.appendChild(node);return node}
 for(let i=0;i<4;i++){const v=low+(high-low)*i/3,yy=y(v);add('line',{x1:54,x2:350,y1:yy,y2:yy,stroke:'#87909d','stroke-opacity':'.2'});add('text',{x:49,y:yy+4,'text-anchor':'end'},D.percent?v.toFixed(1)+'%':new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(v))}
 function line(curve,color,dashed){const path=rows.map((r,i)=>(i?'L':'M')+x(i).toFixed(1)+','+y(r[curve]).toFixed(1)).join('');add('path',{d:path,fill:'none',stroke:color,'stroke-width':2,'stroke-linejoin':'round',...(dashed?{'stroke-dasharray':'5 4'}:{})});add('circle',{cx:x(n-1),cy:y(rows[n-1][curve]),r:3,fill:color})}
 line(index+1,light?'#96630c':'#e7c678',true);line(0,light?'#087e62':'#59d6ad',false);
 add('text',{x:54,y:201},D.dates[0]);add('text',{x:350,y:201,'text-anchor':'end'},D.dates[n-1]);
 el('actual').textContent=format(rows[n-1][0]);el('benchmarkName').textContent='If '+(index?'IUMO.L':'SPYL.L');el('benchmarkValue').textContent=format(rows[n-1][index+1]);
 el('spyl').classList.toggle('active',index===0);el('iumo').classList.toggle('active',index===1);
}
el('spyl').addEventListener('click',()=>{index=0;draw()});el('iumo').addEventListener('click',()=>{index=1;draw()});draw();
</script></body></html>`;
}
