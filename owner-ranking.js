/* V33: weekly TOP10 and historical representative: expandable official race history.
 * Read-only display from weekly_awards.json; results/replay screens are untouched.
 */
(()=>{
  'use strict';
  const body=document.getElementById('vs-ranking-body');
  const description=document.getElementById('vs-ranking-description');
  const archive=document.getElementById('vs-awards-list');
  const more=document.getElementById('vs-awards-more');
  if(!body||!archive||!description||!more)return;
  let data=null,visible=20,fetching=false,openWeekly='',openAward='';
  const money=n=>new Intl.NumberFormat('ja-JP').format(n)+'円';
  const SLOT_MS=900000;
  const fmtSlot=slot=>new Intl.DateTimeFormat('ja-JP',{
    timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hour12:false
  }).format(new Date(slot*SLOT_MS));
  const weekKey=()=>{
    const formatted=new Intl.DateTimeFormat('en-CA',{
      timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
    }).format(new Date());
    const d=new Date(formatted+'T00:00:00Z');
    d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);
    return d.toISOString().slice(0,10);
  };
  function cell(row,value){
    const td=document.createElement('td');td.textContent=value;row.append(td);return td;
  }
  function validHistory(rows){
    return Array.isArray(rows)&&rows.length<=20&&rows.every(r=>
      r&&Number.isSafeInteger(r.slot)&&r.slot>=0&&
      typeof r.raceName==='string'&&r.raceName.length>0&&r.raceName.length<=100&&
      Number.isInteger(r.place)&&r.place>=1&&r.place<=18&&
      Number.isSafeInteger(r.prizeYen)&&r.prizeYen>=0&&
      ['firstHorseName','secondHorseName','firstOwnerName','secondOwnerName','firstSecondMargin']
        .every(k=>r[k]===undefined||(typeof r[k]==='string'&&r[k].length<=
          (k.endsWith('HorseName')?60:k.endsWith('OwnerName')?24:40))));
  }
  function historyFor(h){
    // New export is per-horse: prevents crossing different COM 20-start blocks.
    if(validHistory(h.raceResults))return h.raceResults.slice().sort((a,b)=>a.slot-b.slot);
    // Compatibility with V31: the public player weekly results already exist.
    if(h.ownerName&&Array.isArray(data?.raceResults))
      return data.raceResults.filter(r=>r&&r.ownerName===h.ownerName&&
        r.horseName===h.horseName&&validHistory([r])).sort((a,b)=>a.slot-b.slot).slice(0,20);
    return [];
  }
  function historyContent(h){
    const box=document.createElement('div');box.className='vs-history-content';
    const history=historyFor(h);
    if(!history.length){
      const note=document.createElement('p');note.className='vs-history-note';
      note.textContent='この馬のレース別戦歴はまだ保存されていません。';
      box.append(note);return box;
    }
    if(Number.isSafeInteger(h.starts)&&h.starts>history.length){
      const note=document.createElement('p');note.className='vs-history-note';
      note.textContent='保存されている'+history.length+'戦分を表示しています（全'+h.starts+'戦）。過去の未保存分は表示できません。';
      box.append(note);
    }
    function podiumLine(container,label,horse,owner){
      const line=document.createElement('div');line.className='vs-history-podium-line';
      const knownHorse=typeof horse==='string'&&horse.length>0;
      const knownOwner=typeof owner==='string';
      line.textContent=label+'：'+(knownHorse?horse:'未記録')+
        '　オーナー：'+(knownOwner?(owner||'COM'):'未記録');
      container.append(line);
    }
    const header=document.createElement('div');header.className='vs-history-head';
    header.textContent='開催日時 ／ レース名 ／ 着順 ／ 獲得賞金 ／ 1・2着馬と着差';box.append(header);
    for(const r of history){
      const row=document.createElement('div');row.className='vs-history-race';
      const main=document.createElement('div');main.className='vs-history-race-name';
      main.textContent=fmtSlot(r.slot)+'　'+r.raceName;
      const result=document.createElement('div');result.className='vs-history-race-result';
      result.textContent=r.place+'着　'+money(r.prizeYen);
      row.append(main,result);
      const podium=document.createElement('div');podium.className='vs-history-podium';
      podiumLine(podium,'1着馬',r.firstHorseName,r.firstOwnerName);
      podiumLine(podium,'2着馬',r.secondHorseName,r.secondOwnerName);
      const gap=document.createElement('div');gap.className='vs-history-podium-line';
      gap.textContent='1・2着の着差：'+(typeof r.firstSecondMargin==='string'&&r.firstSecondMargin?
        r.firstSecondMargin:'未記録');
      podium.append(gap);
      row.append(podium);box.append(row);
    }
    return box;
  }
  function makeToggle(label,isOpen,onClick){
    const btn=document.createElement('button');btn.type='button';btn.className='vs-history-toggle';
    btn.setAttribute('aria-expanded',String(isOpen));
    const name=document.createElement('span');name.textContent=label;
    const symbol=document.createElement('span');symbol.className='vs-history-chevron';
    symbol.textContent=isOpen?'▲':'▼';symbol.setAttribute('aria-hidden','true');
    btn.append(name,symbol);btn.addEventListener('click',onClick);return btn;
  }
  function render(){
    if(!data)return;
    body.replaceChildren();
    if(data.weekStart!==weekKey()){
      const tr=document.createElement('tr');cell(tr,'新しい週の集計データを更新中です。');
      tr.firstChild.colSpan=5;body.append(tr);
      description.textContent='日本時間の週間ランキングを更新中です。';
    }else{
      description.textContent='日本時間 '+data.weekStart+'（月）～'+data.weekEnd+'（日）／毎週月曜日に0円から再集計';
      if(!data.top10.length){
        const tr=document.createElement('tr');cell(tr,'今週の確定賞金はまだありません。');
        tr.firstChild.colSpan=5;body.append(tr);
      }
      data.top10.slice(0,10).forEach((h,i)=>{
        const key=[data.weekStart,i,h.horseName,h.ownerName].join('\u0000');
        const active=openWeekly===key;
        const tr=document.createElement('tr');
        cell(tr,(i+1)+'位');
        const horse=cell(tr,'');
        horse.append(makeToggle(h.horseName,active,()=>{openWeekly=active?'':key;render();}));
        cell(tr,h.ownerName||'COM');
        cell(tr,Number.isSafeInteger(h.starts)&&h.starts>=0?h.starts+'戦終了':'—');
        cell(tr,money(h.prizeYen));
        body.append(tr);
        if(active){
          const detail=document.createElement('tr');detail.className='vs-history-detail-row';
          const td=cell(detail,'');td.colSpan=5;
          td.append(historyContent(h));body.append(detail);
        }
      });
    }
    archive.replaceChildren();
    const rows=data.awards||[];
    if(!rows.length){archive.textContent='歴代年度代表馬はまだ決定していません。';}
    rows.slice(0,visible).forEach(x=>{
      const key=String(x.generation);
      const active=openAward===key;
      const item=document.createElement('div');item.className='vs-award-row';
      const title=makeToggle('第'+x.generation+'代 年度代表馬　'+x.horseName,active,()=>{
        openAward=active?'':key;render();
      });
      const detail=document.createElement('div');detail.className='meta';
      detail.textContent='オーナー：'+(x.ownerName||'COM')+' ／ 週間賞金：'+money(x.prizeYen)+' ／ '+
        (x.awardWeekLabel||'受賞週')+'（'+x.weekStart+'～'+x.weekEnd+'）'+
        (x.hasReplayHorse?' ／ 受賞馬データ保存済':'');
      item.append(title,detail);
      if(active)item.append(historyContent(x));
      archive.append(item);
    });
    more.hidden=rows.length<=visible;
  }
  more.addEventListener('click',()=>{visible+=20;render();});
  async function refresh(){
    if(fetching)return;fetching=true;
    try{
      const result=await fetch('./weekly_awards.json?ts='+Date.now(),{cache:'no-store'});
      if(!result.ok)throw Error('HTTP '+result.status);
      const next=await result.json();
      if(next.version!==1||next.timezone!=='Asia/Tokyo'||
         !/^\d{4}-\d{2}-\d{2}$/.test(next.weekStart)||
         !Array.isArray(next.top10)||!Array.isArray(next.awards)||
         next.top10.length>10||next.awards.length>20000||
         !next.top10.every(r=>typeof r.horseName==='string'&&typeof r.ownerName==='string'&&
           Number.isSafeInteger(r.prizeYen)&&r.prizeYen>=0&&
           (r.starts===undefined||(Number.isSafeInteger(r.starts)&&r.starts>=0))&&
           (r.raceResults===undefined||validHistory(r.raceResults)))||
         !next.awards.every(r=>r&&typeof r.horseName==='string'&&
           (r.raceResults===undefined||validHistory(r.raceResults))))
        throw Error('賞金集計の形式が不正です');
      data=next;render();
    }catch(error){
      console.warn('週間賞金の更新を確認できません',error);
      if(!data){body.replaceChildren();const tr=document.createElement('tr');
        cell(tr,'週間賞金データを確認中です。');tr.firstChild.colSpan=5;body.append(tr);
        archive.textContent='受賞記録の公開を確認中です。';}
    }finally{fetching=false;}
  }
  refresh();setInterval(refresh,30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  setInterval(render,60000);
})();
