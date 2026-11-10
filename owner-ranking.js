/* Additional display-only owner labels for the existing daily prize TOP10.
   Uses public result metadata, never downloads private Firebase registrations.
   The original 3D viewer, race calculations and site.js are not modified. */
(()=>{
  'use strict';
  const body=document.getElementById('vs-ranking-body');
  if(!body)return;
  const SLOT_MS=900000,PAPER_MS=30000,DAY_MS=86400000;
  let manifest=null, loading=false, rendering=false;
  const dateKey=ms=>new Intl.DateTimeFormat('en-CA',{
    timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
  }).format(new Date(ms));
  const prize=amount=>new Intl.NumberFormat('ja-JP').format(amount)+'円';
  const startMs=m=>m.slot*(m.intervalMinutes===15?SLOT_MS:600000);
  const completedMs=m=>startMs(m)+PAPER_MS+m.durationMs;
  const releaseMs=m=>startMs(m)+(m.intervalMinutes===15?SLOT_MS:600000);
  const normalOwner=name=>typeof name==='string' && [...name].length<=24 &&
    !/[\u0000-\u001f\u007f]/.test(name) ? name.trim():'';
  function rows(){
    if(!manifest?.records)return null;
    const now=Date.now(),today=dateKey(now),total=new Map();
    for(const meta of manifest.records){
      if(!meta || !Number.isSafeInteger(meta.slot) || !Number.isFinite(meta.durationMs) || !Array.isArray(meta.results))continue;
      const completed=completedMs(meta);
      if(now<completed || now<releaseMs(meta) || now>=completed+DAY_MS || dateKey(completed)!==today)continue;
      for(const row of meta.results){
        if(!row || typeof row.name!=='string' || !Number.isSafeInteger(row.prizeYen) || row.prizeYen<=0)continue;
        const owner=normalOwner(row.ownerName),key=owner?'player\u0000'+owner+'\u0000'+row.name:'horse\u0000'+row.name;
        if(!total.has(key))total.set(key,{name:row.name,owner,amount:0});
        total.get(key).amount+=row.prizeYen;
      }
    }
    return [...total.values()].sort((a,b)=>b.amount-a.amount||a.name.localeCompare(b.name,'ja')).slice(0,10);
  }
  function render(){
    if(rendering)return;
    const ranking=rows();
    // Before public owner-bearing race results exist, the original site.js
    // handles all ranking behaviour unchanged, including older COM results.
    if(!ranking || !ranking.some(row=>row.owner))return;
    const signature=JSON.stringify(ranking);
    if(body.dataset.ownerRankingSignature===signature && body.querySelector('tr[data-owner-ranking-row]'))return;
    rendering=true;
    try{
      const fragment=document.createDocumentFragment();
      ranking.forEach((entry,i)=>{
        const tr=document.createElement('tr');tr.dataset.ownerRankingRow='1';
        const pos=document.createElement('td');pos.textContent=(i+1)+'位';
        const horse=document.createElement('td');horse.textContent=entry.name;
        if(entry.owner){
          const owner=document.createElement('div');owner.className='vs-ranking-owner';
          owner.textContent='オーナー：'+entry.owner;
          owner.style.cssText='font-size:11px;color:#cbb277;line-height:1.5;margin-top:3px;';
          horse.append(owner);
        }
        const amount=document.createElement('td');amount.textContent=prize(entry.amount);
        tr.append(pos,horse,amount);fragment.append(tr);
      });
      body.dataset.ownerRankingSignature=signature;
      body.replaceChildren(fragment);
    }finally{rendering=false;}
  }
  const observer=new MutationObserver(()=>{
    if(!rendering)queueMicrotask(render);
  });
  observer.observe(body,{childList:true,subtree:false});
  async function refresh(){
    if(loading)return;
    loading=true;
    try{
      const response=await fetch('./race_playlist.json?owner='+Date.now(),{cache:'no-store'});
      if(!response.ok)throw Error('レース一覧取得失敗');
      const doc=await response.json();
      if(doc?.version!==2 || !Array.isArray(doc.records))throw Error('レース一覧形式不一致');
      manifest=doc;render();
    }catch(e){console.warn('オーナー付き賞金ランキングを取得できません',e);}
    finally{loading=false;}
  }
  refresh();
  setInterval(refresh,30000);
  setInterval(render,10000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
})();
