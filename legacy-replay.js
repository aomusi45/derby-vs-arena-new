/* Reinstated historical recorded race viewer from Git commit 88f0dd0.
   Kept separate to preserve present scheduling, registration and rankings. */
(()=>{
'use strict';
const SLOT_MS=15*60*1000, PAPER_MS=30000;
const $=id=>document.getElementById(id);
const two=n=>String(n).padStart(2,'0');
const countdown=ms=>{const s=Math.max(0,Math.ceil(ms/1000));return `${two(Math.floor(s/60))}:${two(s%60)}`;};
const slotAt=time=>Math.floor(time/SLOT_MS);
const slotStartMs=meta=>meta.slot*(meta.intervalMinutes===15?SLOT_MS:600000);
const state={watchSerial:0,enginePromise:null,watchMode:'',archiveMeta:null,record:null};
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
    if(!/^races\/[0-9]+\.json(?:\.gz)?$/.test(meta.file))throw Error('レース記録のファイル名が不正です。');
    const record=await fetchJSON('./'+meta.file);
    if(!recordCheck(record) || record.race.name!==meta.name || Number(record.race.distance)!==meta.distance ||
       record.durationMs!==meta.durationMs || record.results.length!==meta.results.length)
      throw Error('記録内容が開催情報と一致しません。');
    return record;
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

$('vs-watchroom-back').addEventListener('click',leaveWatch);
window.DBFArchiveLegacy=Object.freeze({open(meta){if(meta&&typeof meta.file==='string')return openWatch('archive',meta); else throw Error('再生するレースが指定されていません。');}});
})();