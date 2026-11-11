/* DBF official VS arena: 15-minute status and delayed results. No live or archive viewer. */
(()=>{
  'use strict';
  const SLOT_MS=15*60*1000, DAY_MS=24*60*60*1000, PAPER_MS=30000;
  const $=id=>document.getElementById(id);
  const state={catalog:[],records:[],error:'',manifestLast:0,listLast:0,lastJSTDate:'',refreshing:false};
  const slotAt=time=>Math.floor(time/SLOT_MS);
  const two=n=>String(n).padStart(2,'0');
  const clock=ms=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ms));
  const dateKey=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
  const countdown=ms=>{const s=Math.max(0,Math.ceil(ms/1000));return `${two(Math.floor(s/60))}:${two(s%60)}`};
  const yen=n=>new Intl.NumberFormat('ja-JP').format(n)+'円';
  const fileSafe=f=>typeof f==='string' && /^races\/[0-9]+\.json(?:\.gz)?$/.test(f);
  // Old 10-minute records stay available for their original 24-hour retention period.
  const slotStartMs=meta=>meta.slot*(meta.intervalMinutes===15?SLOT_MS:600000);
  const completedAt=meta=>slotStartMs(meta)+PAPER_MS+meta.durationMs;
  const publishAt=meta=>slotStartMs(meta)+(meta.intervalMinutes===15?SLOT_MS:600000);
  const isPublished=(meta,now)=>now>=publishAt(meta)&&now>=completedAt(meta);
  const isRetained=(meta,now)=>completedAt(meta)+DAY_MS>now;
  const idForSlot=slot=>{
    if(!state.catalog.length)return null;
    const origin=slotAt(Date.parse('2026-11-09T00:00:00+09:00'));
    const n=((slot-origin)%state.catalog.length+state.catalog.length)%state.catalog.length;
    return state.catalog[n];
  };
  async function fetchJSON(url){
    const response=await fetch(url,{cache:'no-store'});
    if(!response.ok)throw Error('取得できません（HTTP '+response.status+'）：'+url);
    return response.json();
  }
  function validateMeta(row){
    return row && Number.isSafeInteger(row.slot) && row.slot>0 && fileSafe(row.file) &&
      Number.isFinite(row.durationMs) && row.durationMs>0 && row.durationMs<SLOT_MS-PAPER_MS &&
      (row.intervalMinutes===undefined||row.intervalMinutes===10||row.intervalMinutes===15) &&
      typeof row.name==='string' && row.name.length<=100 && typeof row.venue==='string' &&
      Number.isInteger(row.distance) && row.distance>0 &&
      Number.isInteger(row.firstPrizeYen) && row.firstPrizeYen>=0 &&
      Array.isArray(row.results) && row.results.length>=1 && row.results.length<=18 &&
      row.results.every((r,i)=>r && r.place===i+1 && typeof r.name==='string' &&
        r.name.length>0 && Number.isInteger(r.prizeYen) && r.prizeYen>=0);
  }
  async function initializeCatalog(){
    const payload=await fetchJSON('./race_catalog.json');
    if(payload?.version!==1||payload.intervalMinutes!==15||!Array.isArray(payload.races)||payload.races.length<1)
      throw Error('GⅠレース一覧が不正です。');
    state.catalog=payload.races;
  }
  async function loadManifest(){
    try{
      const payload=await fetchJSON('./race_playlist.json');
      if(payload?.version!==2 || !Array.isArray(payload.records) || payload.records.length>200 ||
         !payload.records.every(validateMeta) || new Set(payload.records.map(m=>m.file)).size!==payload.records.length)
        throw Error('開催記録一覧が不正です。');
      // Preserve released races during brief manifest publication delays.
      if(state.records.some(old=>isPublished(old,Date.now()) && isRetained(old,Date.now()) &&
         !payload.records.some(next=>next.file===old.file)))
        throw Error('前レースの結果の更新を確認中です。');
      state.records=payload.records;
      state.error='';
    }catch(e){
      state.error='配信データを取得できません：'+String(e.message||e);
    }
    state.manifestLast=Date.now();
    updateLists();
    showAvailability();
  }
  function updateLists(){
    const now=Date.now(),today=dateKey(now);
    state.listLast=now;state.lastJSTDate=today;
    const released=state.records.filter(r=>isPublished(r,now) && isRetained(r,now))
      .sort((a,b)=>slotStartMs(b)-slotStartMs(a));
    const results=$('vs-result-list');results.replaceChildren();
    $('vs-result-status').textContent=released.length?'結果公開中':'開催記録なし';
    if(!released.length){
      const p=document.createElement('p');
      p.textContent='次のレースが開催中になると、前レースの結果が公開されます。';
      results.append(p);
    }
    for(const meta of released){
      const box=document.createElement('div');box.className='vs-result-item';
      const heading=document.createElement('div');heading.className='vs-result-title';
      heading.textContent=meta.name;
      const play=document.createElement('button');
      play.type='button';play.className='vs-watch-btn';play.textContent='▶ 記録を観戦';
      play.addEventListener('click',()=>{
        if(window.DBFArchiveLegacy?.open) window.DBFArchiveLegacy.open(meta);
        else window.alert('再生機能を読み込めませんでした。ページを再読み込みしてください。');
      });
      box.append(heading,play);results.append(box);
    }
    const total=new Map();
    for(const meta of released){
      if(dateKey(completedAt(meta))!==today)continue;
      for(const row of meta.results){
        if(row.prizeYen===0)continue;
        total.set(row.name,(total.get(row.name)||0)+row.prizeYen);
      }
    }
    const ranking=[...total.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ja')).slice(0,10);
    const body=$('vs-ranking-body');body.replaceChildren();
    if(!ranking.length){
      const tr=document.createElement('tr');const td=document.createElement('td');
      td.colSpan=3;td.textContent='本日の公開済み賞金記録はまだありません。';tr.append(td);body.append(tr);
    }
    ranking.forEach(([name,prize],i)=>{
      const tr=document.createElement('tr');
      for(const value of [String(i+1)+'位',name,yen(prize)]){
        const td=document.createElement('td');td.textContent=value;tr.append(td);
      }
      body.append(tr);
    });
    $('vs-ranking-description').textContent='日本時間 '+today+' 0:00～23:59 ／ 次レース開始時に公開された賞金を集計';
  }
  function showAvailability(){
    const now=Date.now(),slot=slotAt(now),end=(slot+1)*SLOT_MS;
    const card=idForSlot(slot);
    const active=!!card;
    $('vs-header-status').textContent=active?'VS ARENA · 開催中':'VS ARENA · 準備中';
    $('live-race-status').textContent=active?'開催中':'開催準備中';
    $('live-race-name').textContent=card?.name||'GⅠレース一覧を取得中';
    $('live-race-info').textContent=active?'':(state.error||'開催情報を確認しています。');
    // Result disclosure remains gated by the existing publication logic.
    // The next 15-minute slot is only an estimated display time.
    const resultTimer=$('vs-live-result-countdown');
    if(resultTimer)resultTimer.textContent=active?'あと '+countdown(end-now):'確認中…';
    $('live-race-next').textContent='開催枠（日本時間）：'+clock(slot*SLOT_MS)+'～'+clock(end)+' ／ 次の切替まで '+countdown(end-now);
  }
  async function refresh(){
    if(state.refreshing)return;
    state.refreshing=true;
    try{
      const now=Date.now();
      if(now-state.manifestLast>15000)await loadManifest();
      showAvailability();
      if(now-state.listLast>=5000 || dateKey(now)!==state.lastJSTDate)updateLists();
    }finally{state.refreshing=false;}
  }
  initializeCatalog().then(()=>loadManifest()).catch(e=>{
    state.error='レース一覧が読み込めません：'+String(e.message||e);
    showAvailability();
  });
  setInterval(()=>refresh().catch(e=>{state.error=String(e.message||e);showAvailability();}),1000);
})();
