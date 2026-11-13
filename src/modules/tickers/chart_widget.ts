import { deflateSync } from "node:zlib";
import type { AllTimeDataset } from "./alltime_chart.ts";
import type { ChartBenchmark } from "./chart_benchmark.ts";
import { chartPointValue, chartUsesPercentages } from "./chart_points.ts";
import { percentageGrid } from "./chart_grid.ts";

// Both benchmark snapshots travel with the message. The selector is local and
// needs neither widget queries nor changes to the bot's update polling.
export function renderChartWidget(
  dataset: AllTimeDataset,
  sp500: ChartBenchmark,
  iumo: ChartBenchmark,
): string {
  const points = dataset.points;
  if (!points.length || sp500.symbol !== "CSPX.L" || iumo.symbol !== "IUMO.L") {
    throw new Error(
      "The chart widget requires portfolio, CSPX.L and IUMO.L history.",
    );
  }
  const benchmarks = [sp500, iumo].map((benchmark) =>
    new Map(benchmark.points.map((point) => [point.date, point]))
  );
  const rows = points.map((point) => {
    const peers = benchmarks.map((benchmark) => benchmark.get(point.date) ?? { date: point.date, gain: null, percentage: null });
    return [point, ...peers];
  });
  const percent = chartUsesPercentages([dataset]);
  const rate = dataset.displayRate ?? 1;
  const values = rows.map((row) =>
    row.map((point) => chartPointValue(point, percent, rate))
  );
  if (values.some((row) => row.some((value) => value !== null && !Number.isFinite(value)))) {
    throw new Error("Invalid chart widget values.");
  }

  const purchases = new Set(dataset.purchaseDates ?? []);
  const grids = percent ? [1, 2].map(curve => {
    const { min, max, step } = percentageGrid(values.flatMap(row => [row[0], row[curve]]), 10);
    return { min, max, step };
  }) : undefined;
  for (const budget of [120, 84, 60, 36, 18, 8]) {
    // Retain the first/last dates and each curve's extrema in every time bucket.
    const selected = new Set([0, points.length - 1]);
    points.forEach((point, i) => { if (purchases.has(point.date)) selected.add(i); });
    // Keep both sides of gaps so downsampling cannot draw through missing data.
    for (let i = 1; i < values.length; i++) if (values[i].some((value, curve) =>
      (value === null) !== (values[i - 1][curve] === null))) { selected.add(i - 1); selected.add(i); }
    const buckets = Math.max(1, Math.floor((budget - 2) / 6));
    for (let bucket = 0; bucket < buckets; bucket++) {
      const start = Math.floor(bucket * points.length / buckets);
      const end = Math.floor((bucket + 1) * points.length / buckets);
      for (let curve = 0; curve < 3; curve++) {
        let low = start, high = start;
        for (let i = start + 1; i < end; i++) {
          if (values[i][curve] === null) continue;
          if (values[low][curve] === null || values[i][curve]! < values[low][curve]!) low = i;
          if (values[high][curve] === null || values[i][curve]! > values[high][curve]!) high = i;
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
      ...(grids ? { grids } : {}),
      currency: dataset.displayCurrency ?? "USD",
      dates: indices.map((i) => points[i].date),
      values: indices.map((i) =>
        values[i].map((value) => value === null ? null : Math.round(value * 100) / 100)
      ),
      purchases: indices.map(i => purchases.has(points[i].date) ? 1 : 0),
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
    "Chart widget exceeds Telegram's size limit. Use /chart for the full image.",
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
</style></head><body><h3 id="title"></h3><div class="controls"><button id="sp500" class="active">S&P 500</button><button id="iumo">IUMO</button></div>
<svg id="plot" viewBox="0 0 360 210"></svg><div class="key actual"><span>Portfolio</span><span id="actual"></span></div>
<div class="key benchmark"><span id="benchmarkName"></span><span id="benchmarkValue"></span></div><p id="notes"></p>
<script>
const D=${json};
const el=id=>document.getElementById(id), ns='http://www.w3.org/2000/svg';
let index=0;
el('title').textContent=D.title;el('notes').textContent=D.notes;
function format(v){return v===null?'Value unavailable':D.percent?v.toFixed(2)+'%':v.toLocaleString(undefined,{style:'currency',currency:D.currency,maximumFractionDigits:2})}
function draw(){
 const svg=el('plot');svg.innerHTML='';
 const light=typeof TelegramWidget!=='undefined'&&TelegramWidget.colorScheme==='light';
 const rows=D.values, n=rows.length, all=rows.flatMap(r=>[r[0],r[index+1]]).filter(v=>v!==null);
 const g=D.grids&&D.grids[index];let low=g?g.min:Math.min(0,...all),high=g?g.max:Math.max(0,...all);if(!g){const pad=(high-low||1)*.08;low-=pad;high+=pad}
 const first=Date.parse(D.dates[0]),last=Date.parse(D.dates[n-1]);
 const x=i=>54+(last===first ? .5 : (Date.parse(D.dates[i])-first)/(last-first))*296;
 const y=v=>176-(v-low)/(high-low)*162;
 function add(tag,attrs,text){const node=document.createElementNS(ns,tag);Object.keys(attrs).forEach(k=>node.setAttribute(k,attrs[k]));if(text!==undefined)node.textContent=text;svg.appendChild(node);return node}
 const count=g?Math.round((high-low)/g.step)*2:3;for(let i=0;i<=count;i++){const v=low+(high-low)*i/count,yy=y(v),major=!g||i%2===0;add('line',{x1:54,x2:350,y1:yy,y2:yy,stroke:'#87909d','stroke-opacity':Math.abs(v)<1e-10?'.6':major?'.25':'.1'});if(major)add('text',{x:49,y:yy+4,'text-anchor':'end'},D.percent?new Intl.NumberFormat('en-US',{maximumFractionDigits:8}).format(Math.abs(v)<1e-10?0:v)+'%':new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(v))}
 function line(curve,color,dashed){let connected=false;const path=rows.map((r,i)=>{if(r[curve]===null){connected=false;return ''}const part=(connected?'L':'M')+x(i).toFixed(1)+','+y(r[curve]).toFixed(1);connected=true;return part}).join('');add('path',{d:path,fill:'none',stroke:color,'stroke-width':2,'stroke-linejoin':'round',...(dashed?{'stroke-dasharray':'5 4'}:{})});if(rows[n-1][curve]!==null)add('circle',{cx:x(n-1),cy:y(rows[n-1][curve]),r:3,fill:dashed?'var(--tg-theme-bg-color,#15191f)':color,stroke:color,'stroke-width':1.5});if(curve===0)rows.forEach((r,i)=>{if(r[0]!==null&&(D.purchases[i]||(i>0&&rows[i-1][0]===null&&i<n-1&&rows[i+1][0]===null)))add('circle',{cx:x(i),cy:y(r[0]),r:3.5,fill:'var(--tg-theme-bg-color,#15191f)',stroke:color,'stroke-width':1.5})})}
 line(index+1,light?'#96630c':'#e7c678',true);line(0,light?'#087e62':'#59d6ad',false);
 add('text',{x:54,y:201},D.dates[0]);add('text',{x:350,y:201,'text-anchor':'end'},D.dates[n-1]);
 el('actual').textContent=format(rows[n-1][0]);el('benchmarkName').textContent='If '+(index?'IUMO.L':'CSPX.L');el('benchmarkValue').textContent=format(rows[n-1][index+1]);
 el('sp500').classList.toggle('active',index===0);el('iumo').classList.toggle('active',index===1);
}
el('sp500').addEventListener('click',()=>{index=0;draw()});el('iumo').addEventListener('click',()=>{index=1;draw()});draw();
</script></body></html>`;
}
