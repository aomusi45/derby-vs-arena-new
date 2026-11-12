/* Persistent weekly TOP10 + archived champions; no private identifiers on the site. */
(()=>{
  'use strict';
  const body=document.getElementById('vs-ranking-body');
  const description=document.getElementById('vs-ranking-description');
  const archive=document.getElementById('vs-awards-list');
  const more=document.getElementById('vs-awards-more');
  if(!body||!archive||!description||!more)return;
  let data=null,visible=20,fetching=false;
  const money=n=>new Intl.NumberFormat('ja-JP').format(n)+'円';
  const weekKey=()=>{
    const formatted=new Intl.DateTimeFormat('en-CA',{
      timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
    }).format(new Date());
    const d=new Date(formatted+'T00:00:00Z');
    const shift=(d.getUTCDay()+6)%7;
    d.setUTCDate(d.getUTCDate()-shift);
    return d.toISOString().slice(0,10);
  };
  function cell(row,value){
    const td=document.createElement('td');td.textContent=value;row.append(td);
  }
  function render(){
    if(!data)return;
    body.replaceChildren();
    if(data.weekStart!==weekKey()){
      const tr=document.createElement('tr');cell(tr,'新しい週の集計データを更新中です。');
      tr.firstChild.colSpan=4;body.append(tr);
      description.textContent='日本時間の週間ランキングを更新中です。';
    }else{
      description.textContent='日本時間 '+data.weekStart+'（月）～'+data.weekEnd+'（日）／毎週月曜日に0円から再集計';
      if(!data.top10.length){
        const tr=document.createElement('tr');cell(tr,'今週の確定賞金はまだありません。');
        tr.firstChild.colSpan=4;body.append(tr);
      }
      data.top10.slice(0,10).forEach((h,i)=>{
        const tr=document.createElement('tr');
        cell(tr,(i+1)+'位');cell(tr,h.horseName);
        cell(tr,h.ownerName||'COM');cell(tr,money(h.prizeYen));
        body.append(tr);
      });
    }
    archive.replaceChildren();
    const rows=data.awards||[];
    if(!rows.length){archive.textContent='歴代年度代表馬はまだ決定していません。';}
    rows.slice(0,visible).forEach(x=>{
      const item=document.createElement('div');item.className='vs-award-row';
      const title=document.createElement('strong');
      title.textContent='第'+x.generation+'代 年度代表馬　'+x.horseName;
      const detail=document.createElement('div');detail.className='meta';
      detail.textContent='オーナー：'+(x.ownerName||'COM')+' ／ 週間賞金：'+money(x.prizeYen)+' ／ '+(x.awardWeekLabel||'受賞週')+'（'+x.weekStart+'～'+x.weekEnd+'）'+(x.hasReplayHorse?' ／ 受賞馬データ保存済':'');
      item.append(title,detail);archive.append(item);
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
           Number.isSafeInteger(r.prizeYen)&&r.prizeYen>=0))
        throw Error('賞金集計の形式が不正です');
      data=next;render();
    }catch(error){
      console.warn('週間賞金の更新を確認できません',error);
      if(!data){body.replaceChildren();const tr=document.createElement('tr');
        cell(tr,'週間賞金データを確認中です。');tr.firstChild.colSpan=4;body.append(tr);
        archive.textContent='受賞記録の公開を確認中です。';}
    }finally{fetching=false;}
  }
  refresh();setInterval(refresh,30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  setInterval(render,60000);
})();
