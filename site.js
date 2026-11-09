/* DBF official VS website: timetable, recorded 3D spectator, 24h archive and JST daily prize table.
   Record data is published by the race-generation job. The audience never runs a new race. */
(()=>{
  'use strict';
  const SLOT_MS=15*60*1000, DAY_MS=24*60*60*1000, PAPER_MS=30000;
  const $=id=>document.getElementById(id);
  const state={catalog:[],records:[],error:'',slot:null,meta:null,record:null,
    slotSerial:0,watchSerial:0,enginePromise:null,watchMode:'',archiveMeta:null,liveAutoStarted:false,
    manifestLast:0,listLast:0,lastJSTDate:'',refreshing:false,loadingSlot:null,lastRecordAttempt:0,lastRecordFile:''};
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
  const isComplete=(meta,now)=>now>=completedAt(meta);
  const isRetained=(meta,now)=>completedAt(meta)+DAY_MS>now;
  const idForSlot=slot=>{
    if(!state.catalog.length)return null;
    const origin=slotAt(Date.parse('2026-11-09T00:00:00+09:00'));
    const n=((slot-origin)%state.catalog.length+state.catalog.length)%state.catalog.length;
    return state.catalog[n];
  };
  const recordCheck=obj=>!!obj && obj.schema==='derby-fantasy-official-vs-replay' && obj.version===2 && obj.status==='complete' &&
    typeof obj.race?.name==='string' && Number.isFinite(obj.durationMs) && obj.durationMs>0 && obj.durationMs<SLOT_MS-PAPER_MS &&
    obj.newspaper && typeof obj.newspaper.heading==='string' && typeof obj.newspaper.entries==='string' &&
    Array.isArray(obj.field) && obj.field.length>=1 && obj.field.length<=18 &&
    Array.isArray(obj.frames) && obj.frames.length>=2 && Array.isArray(obj.results) && obj.results.length===obj.field.length;
  async function fetchJSON(url){
    const response=await fetch(url,{cache:'no-store'});
    if(!response.ok)throw Error('取得できません（HTTP '+response.status+'）：'+url);
    if(!url.endsWith('.gz'))return response.json();
    if(typeof DecompressionStream!=='function')throw Error('このブラウザは圧縮レース記録の再生に対応していません。');
    // GitHub Pages serves .gz as a file, not with content-encoding gzip.
    return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
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
      // A new manifest must not remove the previous race's results or prize
      // before its 24-hour retention expires. Keep the last complete list.
      if(state.meta && state.record && isRetained(state.meta,Date.now()) &&
         !payload.records.some(r=>r.file===state.meta.file))
        throw Error('前レースの結果・賞金の反映を確認中です。');
      state.records=payload.records;
      state.error='';
    }catch(e){
      // Keep last known valid manifest on transient network failures.
      state.error='配信データを取得できません：'+String(e.message||e);
    }
    state.manifestLast=Date.now();
    updateLists();
    await selectCurrentSlot();
  }
  function updateLists(){
    const now=Date.now(),today=dateKey(now);
    state.listLast=now;state.lastJSTDate=today;
    const finished=state.records.filter(r=>isComplete(r,now) && isRetained(r,now)).sort((a,b)=>slotStartMs(b)-slotStartMs(a));
    const results=$('vs-result-list');results.replaceChildren();
    $('vs-result-status').textContent=finished.length?'結果公開中':'開催記録なし';
    if(!finished.length){const p=document.createElement('p');p.textContent='過去24時間に公開されたレース記録はありません。';results.append(p);}
    for(const meta of finished){
      const box=document.createElement('div');box.className='vs-result-item';
      const h=document.createElement('div');h.className='vs-result-title';h.textContent=clock(slotStartMs(meta))+'　'+meta.name;
      const sub=document.createElement('div');sub.className='vs-result-info';
      const winner=meta.results[0];sub.textContent='1着 '+winner.name+' ／ '+yen(winner.prizeYen);
      const btn=document.createElement('button');btn.type='button';btn.className='vs-watch-btn';btn.textContent='▶ 記録を観戦';
      btn.addEventListener('click',()=>openWatch('archive',meta));
      box.append(h,sub,btn);results.append(box);
    }
    const total=new Map();
    for(const meta of finished){
      if(dateKey(completedAt(meta))!==today)continue;
      for(const result of meta.results){
        if(result.prizeYen===0)continue;
        const name=result.name;
        total.set(name,(total.get(name)||0)+result.prizeYen);
      }
    }
    const ranking=[...total.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ja')).slice(0,10);
    const body=$('vs-ranking-body');body.replaceChildren();
    if(!ranking.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=3;td.textContent='本日の賞金記録はまだありません。';tr.append(td);body.append(tr);}
    ranking.forEach(([name,prize],i)=>{
      const tr=document.createElement('tr');
      for(const text of [String(i+1)+'位',name,yen(prize)]){const td=document.createElement('td');td.textContent=text;tr.append(td);}body.append(tr);
    });
    $('vs-ranking-description').textContent='日本時間 '+today+' 0:00～23:59 ／ 確定済みレースの獲得賞金を集計';
  }
  function showAvailability(){
    const now=Date.now(),wanted=slotAt(now),end=(wanted+1)*SLOT_MS;
    const card=idForSlot(wanted),meta=state.meta;
    const record=meta && isRetained(meta,now) ? state.record : null;
    const waiting=!!record && slotStartMs(meta)<wanted*SLOT_MS;
    $('live-race-next').textContent='開催枠（日本時間）：'+clock(wanted*SLOT_MS)+'～'+clock(end)+' ／ 次の切替まで '+countdown(end-now);
    const btn=$('live-watch-button');btn.disabled=!record;
    $('vs-header-status').textContent=record?(waiting?'VS ARENA · 前回の記録':'VS ARENA · 開催中'):'VS ARENA · 準備中';
    if(!meta||!record){
      $('live-race-status').textContent='開催準備中';
      $('live-race-name').textContent=card?.name||'GⅠレース一覧を取得中';
      $('live-race-info').textContent=state.error||'この開催枠の完走済み記録はまだ公開されていません。';
      return;
    }
    const over=isComplete(meta,now);
    $('live-race-status').textContent=waiting?'前回のレース・再生可能':over?'レース終了・再生可能':'開催中';
    $('live-race-name').textContent=meta.name;
    $('live-race-info').textContent=waiting
      ?clock(slotStartMs(meta))+'の公開済みレースを観戦できます。'+(card?.name||'次のGⅠ')+'の記録は準備中です。公開後に自動で切り替わります。'
      :meta.venue+' 芝'+meta.distance+'m ／ '+(over?'保存したレースを再生できます':now<slotStartMs(meta)+PAPER_MS?'競馬新聞を表示中':'保存済みレースを放映中');
  }
  async function loadRecord(meta){
    const record=await fetchJSON('./'+meta.file);
    if(!recordCheck(record) || record.race.name!==meta.name || Number(record.race.distance)!==meta.distance ||
       record.durationMs!==meta.durationMs || record.results.length!==meta.results.length)
      throw Error('記録内容が開催情報と一致しません。');
    return record;
  }
  async function selectCurrentSlot(){
    const now=Date.now();
    // Show the latest actual recording, not only the slot matching the clock.
    // On a fresh page load, GitHub's delayed schedule must not disable watching.
    const candidates=state.records.filter(r=>slotStartMs(r)<=now && isRetained(r,now))
      .sort((a,b)=>slotStartMs(b)-slotStartMs(a));
    if(state.meta && !isRetained(state.meta,now)){
      state.slot=null;state.meta=null;state.record=null;
    }
    const newest=candidates[0]||null;
    if(state.meta?.file===newest?.file && state.record){showAvailability();return;}
    if(!newest || (state.record && state.meta && slotStartMs(newest)<slotStartMs(state.meta))){
      showAvailability();return;
    }
    if(state.loadingSlot===newest.file)return;
    if(state.lastRecordFile===newest.file && now-state.lastRecordAttempt<10000)return;
    state.loadingSlot=newest.file;state.lastRecordAttempt=now;state.lastRecordFile=newest.file;
    const serial=++state.slotSerial;
    let lastError=null;
    try{
      // If a new manifest has arrived before its recording file, keep the
      // previous recording accessible even on a newly opened device.
      for(const meta of candidates.slice(0,5)){
        if(state.meta?.file===meta.file && state.record){showAvailability();return;}
        if(state.record && state.meta && slotStartMs(meta)<slotStartMs(state.meta))break;
        let record;
        try{record=await loadRecord(meta);}
        catch(e){lastError=e;continue;}
        if(serial!==state.slotSerial || !isRetained(meta,Date.now()))return;
        if(state.meta && state.record && state.meta.file!==meta.file && isRetained(state.meta,Date.now())){
          const previous=state.records.find(r=>r.file===state.meta.file);
          if(!previous||!isComplete(previous,Date.now())){showAvailability();return;}
        }
        updateLists(); // Results and prize totals before a switch; never interrupt viewers.
        state.slot=slotAt(slotStartMs(meta));state.meta=meta;state.record=record;state.error='';
        showAvailability();
        if(state.watchMode==='live'&&!state.liveAutoStarted){
          state.liveAutoStarted=true;
          startWatch(record,meta,'live');
        }
        return;
      }
      if(serial===state.slotSerial && lastError){
        state.error='レース記録を読み込めません：'+String(lastError.message||lastError);
        showAvailability();
      }
    }finally{
      if(state.loadingSlot===newest.file)state.loadingSlot=null;
    }
  }
  function displayWatchError(message){
    $('vs-watchroom-state').textContent='現在、このレースを観戦できません。';
    $('vs-watchroom-loading').textContent=message;
    $('vs-watchroom-loading').hidden=false;$('vs-watchroom-frame').hidden=true;
  }
  function prepareEngineHTML(html){
    const hook='window.DFOfficialVSProduction.start();';
    const anchor='window.DFOfficialVSProduction=dfOfficialVSProduction;';
    if(html.split(hook).length!==2||html.split(anchor).length!==2)
      throw Error('レースエンジンの形式が対応版ではありません。');
    html=html.replace(hook,'if(!window.__dfOfficialSpectator)'+hook);
    const bridge=`\nwindow.DFOfficialViewerBridge=Object.freeze({
      prepare(record){
        const result=window.DFOfficialVSReplay.play(record);
        if(!result?.ok)throw Error('保存したレースを準備できませんでした。');
        document.getElementById('newspaperRaceStart').disabled=true;
        dfV2SetGameScreenNow('newspaper');
        if(document.body.dataset.gameScreen!=='newspaper')throw Error('競馬新聞を開けませんでした。');
      },
      playAt(offsetMs){
        dfV2SetGameScreenNow('race-view');
        if(document.body.dataset.gameScreen!=='race-view')throw Error('レース画面を開けませんでした。');
        document.getElementById('start').click();
        if(race!=='running')throw Error('保存済みレースの再生に失敗しました。');
        if(offsetMs>0&&!window.DFOfficialVSReplay.seek(offsetMs))throw Error('再生位置を設定できませんでした。');
      }
    });\n`;
    html=html.replace(anchor,anchor+bridge);
    const shim=`<script>(function(){window.__dfOfficialSpectator=true;
      const values=new Map();const store={getItem(k){k=String(k);return values.has(k)?values.get(k):null},
      setItem(k,v){values.set(String(k),String(v))},removeItem(k){values.delete(String(k))},
      clear(){values.clear()},key(i){return [...values.keys()][i]??null},get length(){return values.size}};
      Object.defineProperty(window,'localStorage',{configurable:true,value:store});
    })();<\/script>`;
    return html.replace(/<head[^>]*>/i,tag=>tag+shim);
  }
  async function loadEngine(){
    if(!state.enginePromise)state.enginePromise=Promise.all(['vs_replay_engine_part1.txt','vs_replay_engine_part2.txt']
      .map(name=>fetch('./'+name).then(r=>{if(!r.ok)throw Error('レースエンジンの'+name+'がありません。');return r.text();})))
      .then(parts=>prepareEngineHTML(parts.join(''))).catch(e=>{state.enginePromise=null;throw e;});
    return state.enginePromise;
  }
  function loadFrame(html,serial){
    return new Promise((resolve,reject)=>{
      const frame=$('vs-watchroom-frame');
      const timer=setTimeout(()=>{cleanup();reject(Error('ゲームエンジンの読み込みが時間切れです。'));},150000);
      const cleanup=()=>{clearTimeout(timer);frame.removeEventListener('load',onload);frame.removeEventListener('error',onerror)};
      const onload=()=>{cleanup();serial===state.watchSerial?resolve(frame.contentWindow):reject(Error('観戦対象が切り替わりました。'))};
      const onerror=()=>{cleanup();reject(Error('ゲームエンジンが起動できません。'))};
      frame.addEventListener('load',onload);frame.addEventListener('error',onerror);frame.srcdoc=html;
    });
  }
  async function waitEngine(w,serial){
    const begin=performance.now();let booted=false;
    while(serial===state.watchSerial){
      if(w.__df47BootError)throw Error('3D起動エラー：'+w.__df47BootError);
      if(!booted&&typeof w.__df47Start3D==='function'){booted=true;w.__df47Start3D();}
      if(w.__raceReady3D&&w.DFOfficialViewerBridge)return;
      if(performance.now()-begin>120000)throw Error('3Dエンジンの準備が完了しませんでした。');
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    throw Error('観戦対象が切り替わりました。');
  }
  // Spectator-only navigation. The race engine and automatic recorder stay unchanged.
  function installResultHomeLink(w){
    const doc=w.document,results=doc.getElementById('postRacePanel');
    if(!results)throw Error('着順掲示板が見つかりません。');
    // Remove obsolete VS selection buttons instead of merely hiding them.
    for(const id of ['dfV30VsReturn','dfV30VsReturnResult'])doc.getElementById(id)?.remove();
    // Do not show a duplicate homepage link above the finishing order.
    results.querySelectorAll('.vs-home-return-wrap').forEach(node=>node.remove());
    if(doc.getElementById('vsOfficialResultHome'))return;
    const style=doc.createElement('style');
    style.textContent=`#vsOfficialResultHome{display:flex;align-items:center;justify-content:center;
      box-sizing:border-box;width:100%;min-height:56px;margin:16px auto 8px;padding:12px 16px;
      border:2px solid #d9b67a;border-radius:12px;background:linear-gradient(#24465c,#142d3e);
      color:#ffedbf!important;font-size:clamp(15px,3.5vw,18px);font-weight:900;
      text-align:center;text-decoration:none;cursor:pointer}
      #vsOfficialResultHome:focus-visible{outline:3px solid #f4d58f;outline-offset:3px}`;
    doc.head.append(style);
    const link=doc.createElement('a');
    link.id='vsOfficialResultHome';
    link.textContent='ホームページに戻る';
    link.href=new URL('./',location.href).href;
    link.target='_top';
    results.append(link);
  }
  async function startWatch(record,meta,mode){
    const serial=++state.watchSerial,frame=$('vs-watchroom-frame');
    frame.hidden=true;$('vs-watchroom-loading').hidden=false;
    $('vs-watchroom-loading').textContent='保存済みの競馬新聞と3Dレースを準備しています。';
    $('vs-watchroom-title').textContent='公式VS観戦：'+meta.name;
    try{
      const html=await loadEngine();if(serial!==state.watchSerial)return;
      const w=await loadFrame(html,serial);if(serial!==state.watchSerial)return;
      await waitEngine(w,serial);if(serial!==state.watchSerial)return;
      w.DFOfficialViewerBridge.prepare(record);
      installResultHomeLink(w);
      // A live viewer uses the public race clock. An archive viewer starts its own 30s newspaper.
      const started=mode==='live'?slotStartMs(meta):Date.now();
      const beginVideo=()=>{
        const offset=mode==='live'?Math.max(0,Date.now()-started-PAPER_MS):0;
        w.DFOfficialViewerBridge.playAt(Math.min(offset,record.durationMs));
        $('vs-watchroom-state').textContent='保存済みの同一レース映像を再生しています（再計算なし）。';
      };
      frame.hidden=false;$('vs-watchroom-loading').hidden=true;
      if(Date.now()<started+PAPER_MS){
        while(serial===state.watchSerial && (mode==='archive'||slotAt(Date.now())===meta.slot) && Date.now()<started+PAPER_MS){
          $('vs-watchroom-state').textContent='保存した競馬新聞を表示中（発走まで '+countdown(started+PAPER_MS-Date.now())+'）';
          await new Promise(resolve=>setTimeout(resolve,200));
        }
        if(serial!==state.watchSerial || (mode==='live'&&slotAt(Date.now())!==meta.slot))return;
        beginVideo();
      }else if(Date.now()-started>=PAPER_MS+record.durationMs){
        $('vs-watchroom-state').textContent='この枠のレースは終了しました。保存記録を最初から再生します。';
        w.DFOfficialViewerBridge.playAt(0);
      }else beginVideo();
    }catch(e){if(serial===state.watchSerial)displayWatchError(String(e.message||e));}
  }
  async function openWatch(mode,meta){
    state.watchMode=mode;
    if(mode==='live')state.liveAutoStarted=true;
    state.archiveMeta=mode==='archive'?meta:null;
    document.body.classList.add('vs-watch-view');$('vs-watchroom').hidden=false;
    if(mode==='live'){
      const url=new URL(location.href);url.searchParams.set('watch','live');history.replaceState(null,'',url);
    }
    let record=null;
    try{
      if(mode==='live')record=state.record;
      else record=await loadRecord(meta);
    }catch(e){displayWatchError(String(e.message||e));return;}
    if(!record){displayWatchError('公開済みの記録がありません。');return;}
    startWatch(record,meta,mode);
  }
  function leaveWatch(){
    ++state.watchSerial;state.watchMode='';state.archiveMeta=null;
    const frame=$('vs-watchroom-frame');frame.hidden=true;frame.removeAttribute('srcdoc');
    $('vs-watchroom').hidden=true;document.body.classList.remove('vs-watch-view');
    const url=new URL(location.href);url.searchParams.delete('watch');history.replaceState(null,'',url);
  }
  $('live-watch-button').addEventListener('click',()=>{if(state.record&&state.meta)openWatch('live',state.meta);});
  $('vs-watchroom-back').addEventListener('click',leaveWatch);
  const watchQuery=new URLSearchParams(location.search).get('watch')==='live';
  if(watchQuery){state.watchMode='live';document.body.classList.add('vs-watch-view');$('vs-watchroom').hidden=false;}
  async function refresh(){
    if(state.refreshing)return;
    state.refreshing=true;
    try{
    const now=Date.now();
    if(now-state.manifestLast>15000)await loadManifest();
    else if(state.slot!==slotAt(now))await selectCurrentSlot();
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
