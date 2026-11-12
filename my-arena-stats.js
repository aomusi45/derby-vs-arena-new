/* V10 display-only personal weekly results + standings and 24-hour replay filter.
 * Prize/rank derives from the same official weekly Firestore summary as TOP10.
 * Owner identity derives from the signed-in profile in registration.js.
 * No Firebase UID, horse data or tokens are published or stored here.
 */
(()=>{
  'use strict';
  const $=id=>document.getElementById(id);
  const horse=$('vs-my-week-horse'),prize=$('vs-my-week-prize'),rank=$('vs-my-week-rank');
  const note=$('vs-my-week-note'),weekResults=$('vs-my-week-results'),button=$('vs-my-races-toggle'),list=$('vs-my-races-list');
  if(!horse||!prize||!rank||!note||!weekResults||!button||!list)return;
  const SLOT_MS=900000,DAY_MS=86400000,DELAY_MS=30000;
  const yen=n=>new Intl.NumberFormat('ja-JP').format(n)+'円';
  const fmtTime=ms=>new Intl.DateTimeFormat('ja-JP',{
    timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'
  }).format(new Date(ms));
  const currentMonday=()=>{
    const day=new Intl.DateTimeFormat('en-CA',{
      timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
    }).format(new Date());
    const d=new Date(day+'T00:00:00Z');
    d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);
    return d.toISOString().slice(0,10);
  };
  let board=null,manifest=null,previousIdentity='',busy=false,expanded=false,lastUpdate=0;
  const getIdentity=()=>{
    const row=window.DBFMyArenaIdentity?.snapshot?.();
    return row&&typeof row.ownerName==='string'&&row.ownerName.length>0&&
      typeof row.horseName==='string'?row:null;
  };
  const identKey=id=>id?id.ownerName+'\u0000'+id.horseName+'\u0000'+id.weekIndex:'';
  const stale=payload=>payload?.weekStart!==currentMonday();
  function clearList(msg){list.replaceChildren();list.textContent=msg;}
  function showIdentity(id){
    if(!id){
      horse.textContent='ログイン後に表示します';prize.textContent='―';rank.textContent='―';
      note.textContent='オーナー名を登録済みのアカウントでログインしてください。';
      button.disabled=true;expanded=false;button.setAttribute('aria-expanded','false');
      list.hidden=true;clearList('ログイン後に確認できます。');
      weekResults.textContent='ログイン後に確認できます。';
      return;
    }
    button.disabled=false;
    horse.textContent=id.horseName||'今週の登録馬なし';
    if(!id.horseName){
      prize.textContent='―';rank.textContent='―';
      note.textContent='今週の新しい登録馬が決まると成績が表示されます。';
    }else if(!board || stale(board) || !Array.isArray(board.standings)){
      prize.textContent='確認中';rank.textContent='確認中';
      note.textContent='今週の正式な賞金集計を確認しています。';
    }else{
      const found=board.standings.find(x=>x.ownerName===id.ownerName&&x.horseName===id.horseName);
      prize.textContent=found?yen(found.prizeYen):'0円';
      rank.textContent=found?found.rank+'位':'順位なし';
      note.textContent=found?'今週の確定レース結果から集計しています。':
        '今週の賞金対象レースはまだ確定していません。';
    }
    renderWeekResults(id);
    if(expanded)renderRaces(id);
  }
  function isRetained(meta,now){
    if(!meta || meta.intervalMinutes!==15 || !Number.isSafeInteger(meta.slot) ||
      !Number.isFinite(meta.durationMs) || !Array.isArray(meta.results))return false;
    const slotMs=meta.slot*SLOT_MS;
    const ended=slotMs+DELAY_MS+meta.durationMs;
    return now>=Math.max((meta.slot+1)*SLOT_MS,ended)&&now<ended+DAY_MS;
  }
  function myRaces(records,ownerName,now){
    if(!Array.isArray(records)||!ownerName)return [];
    const matches=[];
    for(const meta of records){
      if(!isRetained(meta,now)||typeof meta.file!=='string'||
         !/^races\/[0-9]+\.json(?:\.gz)?$/.test(meta.file))continue;
      for(const result of meta.results){
        // Match the server-verified immutable owner name, not the user's typed input.
        if(result?.ownerName!==ownerName || !Number.isInteger(result.place)||
           !Number.isSafeInteger(result.prizeYen)||result.prizeYen<0)continue;
        matches.push({meta,result});
      }
    }
    return matches.sort((a,b)=>b.meta.slot-a.meta.slot);
  }
  function renderWeekResults(id){
    weekResults.replaceChildren();
    if(!id.horseName){
      weekResults.textContent='今週の登録馬はまだありません。';return;
    }
    if(!board || stale(board) || !Array.isArray(board.raceResults)){
      weekResults.textContent='今週の確定レース結果を取得中です。';return;
    }
    const rows=board.raceResults.filter(row=>
      row.ownerName===id.ownerName && row.horseName===id.horseName);
    if(!rows.length){
      weekResults.textContent='今週の出走レース結果はまだありません。';return;
    }
    // Current week's results survive the regular 24-hour replay cleanup.
    // Attach a replay only while the original race file is still retained.
    for(const row of rows){
      const item=document.createElement('div');item.className='vs-my-week-result';
      const race=document.createElement('div');race.className='vs-my-week-result-race';
      race.textContent=fmtTime(row.slot*SLOT_MS)+'　'+row.raceName;
      const details=document.createElement('div');details.className='vs-my-week-result-detail';
      details.textContent=row.place+'着 ／ 獲得賞金 '+yen(row.prizeYen);
      item.append(race,details);
      const replay=manifest?.records?.find(meta=>meta.slot===row.slot&&
        isRetained(meta,Date.now())&&meta.results.some(r=>
          r.ownerName===id.ownerName && r.name===id.horseName));
      if(replay){
        const watch=document.createElement('button');watch.type='button';
        watch.className='vs-action-btn vs-my-week-result-replay';
        watch.textContent='▶ レースを見る';
        watch.addEventListener('click',()=>{
          if(window.DBFArchiveLegacy?.open)window.DBFArchiveLegacy.open(replay);
          else alert('リプレイ機能を確認できません。ページを再読み込みしてください。');
        });
        item.append(watch);
      }else{
        const expired=document.createElement('span');
        expired.className='vs-my-week-result-expired';
        expired.textContent='リプレイは公開後24時間以内のみ再生できます。';
        item.append(expired);
      }
      weekResults.append(item);
    }
  }
  function renderRaces(id){
    if(!id||!expanded)return;
    list.replaceChildren();
    if(!manifest||!Array.isArray(manifest.records)){
      list.textContent='出走記録を確認中です。';return;
    }
    const rows=myRaces(manifest.records,id.ownerName,Date.now());
    if(!rows.length){
      list.textContent='直近24時間に公開された、ご自身の馬の出走レースはありません。';return;
    }
    for(const {meta,result} of rows){
      const item=document.createElement('div');item.className='vs-my-race-item';
      const title=document.createElement('div');title.className='vs-my-race-item-title';
      title.textContent=fmtTime(meta.slot*SLOT_MS)+'　'+meta.name;
      const detail=document.createElement('div');detail.className='vs-my-race-item-detail';
      detail.textContent=result.name+' ／ '+result.place+'着 ／ 獲得賞金 '+yen(result.prizeYen);
      const watch=document.createElement('button');watch.type='button';
      watch.className='vs-action-btn vs-my-race-watch';watch.textContent='▶ このレースを見る';
      watch.addEventListener('click',()=>{
        if(window.DBFArchiveLegacy?.open)window.DBFArchiveLegacy.open(meta);
        else alert('リプレイ機能を確認できません。ページを再読み込みしてください。');
      });
      item.append(title,detail,watch);list.append(item);
    }
  }
  function validBoard(data){
    return data?.version===1&&data?.timezone==='Asia/Tokyo'&&
      typeof data.weekStart==='string'&&Array.isArray(data.standings)&&
      data.standings.length<=500&&data.standings.every((r,i)=>
        r&&r.rank===i+1&&typeof r.horseName==='string'&&r.horseName.length>0&&
        typeof r.ownerName==='string'&&Number.isSafeInteger(r.prizeYen)&&r.prizeYen>=0)&&
      // Old V9 award files remain readable while the V10 results are deploying.
      (data.raceResults===undefined||(Array.isArray(data.raceResults)&&
       data.raceResults.length<=4000&&data.raceResults.every(r=>
         r&&Number.isSafeInteger(r.slot)&&r.slot>=0&&
         typeof r.raceName==='string'&&typeof r.ownerName==='string'&&
         typeof r.horseName==='string'&&Number.isInteger(r.place)&&
         r.place>=1&&r.place<=18&&Number.isSafeInteger(r.prizeYen)&&r.prizeYen>=0)));
  }
  async function fetchData(){
    if(busy)return;
    busy=true;
    const identity=getIdentity();
    const suffix='?v='+Date.now();
    try{
      const [a,b]=await Promise.allSettled([
        fetch('./weekly_awards.json'+suffix,{cache:'no-store'}),
        fetch('./race_playlist.json'+suffix,{cache:'no-store'})]);
      if(a.status==='fulfilled'&&a.value.ok){
        const d=await a.value.json();
        if(validBoard(d))board=d;
        else board=null;
      }
      if(b.status==='fulfilled'&&b.value.ok){
        const d=await b.value.json();
        if(d?.version===2&&Array.isArray(d.records)&&d.records.length<=200)manifest=d;
      }
      showIdentity(getIdentity());
      lastUpdate=Date.now();
    }catch(e){console.warn('自分の馬の戦績を取得できません',e);}
    finally{busy=false;}
  }
  button.addEventListener('click',()=>{
    const id=getIdentity();if(!id)return;
    expanded=!expanded;list.hidden=!expanded;button.setAttribute('aria-expanded',String(expanded));
    button.textContent=expanded?'出走レースを閉じる':'自分の馬の出走レースを見る';
    if(expanded){renderRaces(id);fetchData();}
  });
  function tick(){
    const id=getIdentity(),key=identKey(id);
    if(key!==previousIdentity){
      previousIdentity=key;
      // Revoke previously displayed owner details immediately on account switch.
      expanded=false;list.hidden=true;button.setAttribute('aria-expanded','false');
      button.textContent='自分の馬の出走レースを見る';
      clearList('出走記録を確認中です。');
    }
    showIdentity(id);
    if(Date.now()-lastUpdate>30000)fetchData();
  }
  tick();setInterval(tick,5000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){lastUpdate=0;tick();}});
})();
