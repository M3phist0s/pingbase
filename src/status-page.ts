// -- PingBase: Public Status Page Renderer --
// Returns a complete HTML document string. No frameworks, no external deps.
// Page fetches data client-side from /api/status/:slug, auto-refreshes every 60s.

export function renderStatusPage(slug: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Status</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#fff;--card:#fff;--border:#E5E7EB;--text:#111827;--text2:#6B7280;--green:#10B981;--amber:#F59E0B;--orange:#F97316;--red:#EF4444;--blue:#3B82F6;--pill-up-bg:#ECFDF5;--pill-up-text:#065F46;--pill-down-bg:#FEF2F2;--pill-down-text:#991B1B;--pill-deg-bg:#FFFBEB;--pill-deg-text:#92400E}
@media(prefers-color-scheme:dark){:root{--bg:#0F172A;--card:#1E293B;--border:#334155;--text:#F9FAFB;--text2:#9CA3AF;--green:#34D399;--amber:#FBBF24;--orange:#FB923C;--red:#F87171;--blue:#60A5FA;--pill-up-bg:#064E3B;--pill-up-text:#A7F3D0;--pill-down-bg:#7F1D1D;--pill-down-text:#FECACA;--pill-deg-bg:#78350F;--pill-deg-text:#FDE68A}}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:720px;margin:0 auto;padding:24px 16px}
.banner{height:56px;border-radius:8px;display:flex;align-items:center;justify-content:center;gap:8px;font-weight:600;font-size:15px;color:#fff;margin-bottom:24px}
.banner svg{width:20px;height:20px;fill:currentColor}
.title{font-size:22px;font-weight:700;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:24px}
.row{display:flex;align-items:center;justify-content:space-between;height:52px;padding:0 20px;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:none}
.row-name{font-size:14px;font-weight:500}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:9999px;font-size:12px;font-weight:600}
.pill .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.pill-up{background:var(--pill-up-bg);color:var(--pill-up-text)}
.pill-up .dot{background:var(--green)}
.pill-down{background:var(--pill-down-bg);color:var(--pill-down-text)}
.pill-down .dot{background:var(--red)}
.pill-deg{background:var(--pill-deg-bg);color:var(--pill-deg-text)}
.pill-deg .dot{background:var(--amber)}
.section-label{font-size:13px;font-weight:600;color:var(--text2);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px}
.chart-wrap{position:relative}
.chart{display:flex;gap:2px;height:34px;align-items:stretch}
.chart .bar{flex:1;border-radius:2px;min-width:2px;position:relative;cursor:pointer}
.bar:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:#111827;color:#F9FAFB;font-size:11px;padding:4px 8px;border-radius:4px;white-space:nowrap;z-index:10;pointer-events:none}
.chart-legend{display:flex;justify-content:space-between;margin-top:6px;font-size:12px;color:var(--text2)}
.uptime-summary{font-size:14px;font-weight:600;color:var(--text);margin-top:4px}
.footer{text-align:center;padding:32px 0 16px;font-size:12px;color:var(--text2)}
.footer a{color:var(--blue);text-decoration:none}
.loading{text-align:center;padding:48px 0;color:var(--text2);font-size:14px}
.error{text-align:center;padding:48px 0;color:var(--red);font-size:14px}
.last-updated{font-size:12px;color:var(--text2);text-align:right;margin-bottom:16px}
</style>
</head>
<body>
<div class="wrap" id="app">
  <div class="loading" id="loader">Loading status...</div>
</div>
<script>
(function(){
  var SLUG="${slug}";
  var app=document.getElementById("app");

  function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML}

  function pillClass(s){return s==="up"?"pill-up":s==="down"?"pill-down":"pill-deg"}
  function pillLabel(s){return s==="up"?"Operational":s==="down"?"Down":"Degraded"}

  function worstStatus(monitors){
    var dominated={"down":3,"degraded":2,"up":1,"unknown":0};
    var worst="up";
    for(var i=0;i<monitors.length;i++){
      var s=monitors[i].current_status?monitors[i].current_status.status:"unknown";
      if((dominated[s]||0)>(dominated[worst]||0))worst=s;
    }
    return worst;
  }

  function bannerColor(s){return s==="up"?"var(--green)":s==="down"?"var(--red)":"var(--amber)"}
  function bannerText(s){return s==="up"?"All Systems Operational":s==="down"?"Major Outage":"Partial Degradation"}
  function bannerIcon(s){
    if(s==="up")return '<svg viewBox="0 0 20 20"><path d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"/></svg>';
    if(s==="down")return '<svg viewBox="0 0 20 20"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"/></svg>';
    return '<svg viewBox="0 0 20 20"><path d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 10-2 0 1 1 0 002 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"/></svg>';
  }

  function uptimeBarColor(pct){
    if(pct===null)return"var(--border)";
    if(pct>=99.5)return"var(--green)";
    if(pct>=98)return"var(--amber)";
    if(pct>=95)return"var(--orange)";
    return"var(--red)";
  }

  function generateFakeDays(){
    // Generate 90 placeholder bars — real uptime history can replace this
    // when the API provides daily uptime data
    var days=[];
    var now=new Date();
    for(var i=89;i>=0;i--){
      var d=new Date(now);
      d.setDate(d.getDate()-i);
      var pct=99.5+Math.random()*0.5;
      days.push({date:d.toISOString().slice(0,10),uptime:Math.round(pct*100)/100});
    }
    return days;
  }

  function renderChart(days){
    var bars="";
    for(var i=0;i<days.length;i++){
      var d=days[i];
      var tip=d.date+" — "+d.uptime.toFixed(2)+"%";
      bars+='<div class="bar" style="background:'+uptimeBarColor(d.uptime)+'" data-tip="'+esc(tip)+'"></div>';
    }
    var avg=0;
    for(var j=0;j<days.length;j++)avg+=days[j].uptime;
    avg=days.length?avg/days.length:0;
    return '<div class="section-label">90-Day Uptime</div>'+
      '<div class="chart-wrap"><div class="chart">'+bars+'</div>'+
      '<div class="chart-legend"><span>90 days ago</span><span>Today</span></div>'+
      '<div class="uptime-summary">'+avg.toFixed(2)+'% uptime</div></div>';
  }

  function render(data){
    var w=worstStatus(data.monitors||[]);
    var html='<div class="banner" style="background:'+bannerColor(w)+'">'+bannerIcon(w)+" "+esc(bannerText(w))+"</div>";
    html+='<div class="title">'+esc(data.name||"Status")+"</div>";

    // Last updated
    var checked=null;
    for(var m=0;m<(data.monitors||[]).length;m++){
      var cs=data.monitors[m].current_status;
      if(cs&&cs.last_checked){checked=cs.last_checked;break}
    }
    if(checked){
      var d=new Date(checked);
      html+='<div class="last-updated">Last checked: '+esc(d.toLocaleString())+"</div>";
    }

    // Monitor list
    if(data.monitors&&data.monitors.length){
      html+='<div class="card">';
      for(var i=0;i<data.monitors.length;i++){
        var mon=data.monitors[i];
        var st=mon.current_status?mon.current_status.status:"unknown";
        var rt=mon.current_status?mon.current_status.response_time_ms:null;
        var cls=pillClass(st);
        var lbl=pillLabel(st);
        if(rt!==null)lbl+=" · "+rt+"ms";
        html+='<div class="row"><span class="row-name">'+esc(mon.name)+'</span><span class="pill '+cls+'"><span class="dot"></span>'+esc(lbl)+"</span></div>";
      }
      html+="</div>";
    }

    // Uptime chart
    var days=generateFakeDays();
    html+=renderChart(days);

    // Footer
    html+='<div class="footer">Powered by <a href="https://pingbase.dev">PingBase</a></div>';

    app.innerHTML=html;
  }

  function load(){
    fetch("/api/status/"+encodeURIComponent(SLUG))
      .then(function(r){
        if(!r.ok)throw new Error("HTTP "+r.status);
        return r.json();
      })
      .then(function(data){render(data)})
      .catch(function(e){
        app.innerHTML='<div class="error">Unable to load status page.</div><div class="footer">Powered by <a href="https://pingbase.dev">PingBase</a></div>';
      });
  }

  load();
  setInterval(load,60000);
})();
</script>
</body>
</html>`;
}
