/* DBF official VS arena: completed-race replay ONLY. No live-view entry point. */
(()=>{
  'use strict';
  const $=id=>document.getElementById(id);
  const SLOT_MS=900000,DAY_MS=86400000,PAPER_MS=30000;
  const state={watchSerial:0,enginePromise:null};
  const startMs=m=>m.slot*(m.intervalMinutes===15?SLOT_MS:600000);
  const completeMs=m=>startMs(m)+PAPER_MS+m.durationMs;
  const publishMs=m=>startMs(m)+(m.intervalMinutes===15?SLOT_MS:600000);
  const canReplay=m=>!!m&&Number.isSafeInteger(m.slot)&&m.slot>0&&
    (m.intervalMinutes===15||m.intervalMinutes===10||m.intervalMinutes===undefined)&&
    typeof m.file==='string'&&/^races\/[0-9]+\.json(?:\.gz)?$/.test(m.file)&&
    Number.isFinite(m.durationMs)&&m.durationMs>0&&m.durationMs<SLOT_MS-PAPER_MS&&
    Date.now()>=Math.max(publishMs(m),completeMs(m))&&Date.now()<completeMs(m)+DAY_MS;
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
  async function loadRecord(meta){
    const record=await fetchJSON('./'+meta.file);
    if(!recordCheck(record) || record.race.name!==meta.name || Number(record.race.distance)!==meta.distance ||
       record.durationMs!==meta.durationMs || record.results.length!==meta.results.length)
      throw Error('記録内容が開催情報と一致しません。');
    return record;
  }
  function showError(message){
    $('vs-archive-state').textContent='レース映像を再生できません。';
    $('vs-archive-loading').textContent=message;
    $('vs-archive-loading').hidden=false;
    $('vs-archive-frame').hidden=true;
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
      const frame=$('vs-archive-frame');
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
  async function open(meta){
    if(!canReplay(meta))return;
    const serial=++state.watchSerial;
    const frame=$('vs-archive-frame');
    frame.hidden=true;
    $('vs-archive-loading').hidden=false;
    $('vs-archive-loading').textContent='保存済みレースを読み込んでいます。';
    $('vs-archive-title').textContent='公式VS レース再生：'+meta.name;
    $('vs-archive-state').textContent='レース映像を最初から再生します。';
    $('vs-archive-room').hidden=false;
    document.body.classList.add('vs-archive-view');
    try{
      const record=await loadRecord(meta);if(serial!==state.watchSerial)return;
      const html=await loadEngine();if(serial!==state.watchSerial)return;
      const w=await loadFrame(html,serial);if(serial!==state.watchSerial)return;
      await waitEngine(w,serial);if(serial!==state.watchSerial)return;
      w.DFOfficialViewerBridge.prepare(record);
      installResultHomeLink(w);
      if(serial!==state.watchSerial)return;
      frame.hidden=false;
      $('vs-archive-loading').hidden=true;
      w.DFOfficialViewerBridge.playAt(0);
      $('vs-archive-state').textContent='公式レースの保存映像を再生中（再計算なし）';
    }catch(e){if(serial===state.watchSerial)showError(String(e.message||e));}
  }
  function close(){
    ++state.watchSerial;
    const frame=$('vs-archive-frame');
    frame.hidden=true;frame.removeAttribute('srcdoc');
    $('vs-archive-room').hidden=true;
    document.body.classList.remove('vs-archive-view');
  }
  $('vs-archive-back').addEventListener('click',close);
  window.DBFArchiveReplay=Object.freeze({open});
})();
