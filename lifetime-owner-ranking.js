/* Independent lifetime owner ranking, using the existing public weekly feed. */
(()=>{
  'use strict';
  const list=document.getElementById('vs-lifetime-owner-list');if(!list)return;
  let ranks=[],busy=false;
  const ns='http://www.w3.org/2000/svg';
  function mark(rank){
    if(rank<1||rank>70)return null;
    const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 64 64');
    svg.setAttribute('width','24');svg.setAttribute('height','24');svg.style.verticalAlign='middle';svg.style.flexShrink='0';
    svg.setAttribute('role','img');svg.setAttribute('aria-label',rank===1?'DRA純金杯':rank<=10?'金冠':rank<=30?'銀冠':'銅冠');
    const color=rank<=10?'#e8b936':rank<=30?'#d0d7df':'#c58a59';
    const edge=rank<=10?'#a47816':rank<=30?'#85919e':'#8e5733';
    function path(d){const p=document.createElementNS(ns,'path');p.setAttribute('d',d);p.setAttribute('fill',color);p.setAttribute('stroke',edge);p.setAttribute('stroke-width','2');svg.append(p);}
    if(rank===1){path('M17 8H47V25Q47 40 32 42Q17 40 17 25Z M17 12H7V20Q7 32 20 32L17 25 M47 12H57V20Q57 32 44 32L47 25 M29 40H35V51H44V59H20V51H29Z');const t=document.createElementNS(ns,'text');t.setAttribute('x','32');t.setAttribute('y','26');t.setAttribute('font-size','10');t.setAttribute('text-anchor','middle');t.setAttribute('fill','#704b09');t.textContent='DRA';svg.append(t);}
    else path('M6 14L20 28L32 7L44 28L58 14L49 47H15Z M15 50H49V56H15Z');
    return svg;
  }
  function formatPrize(yen){
    if(!Number.isFinite(yen)||yen<0)return '—';
    const trillion=yen>=1e12;
    return (yen/(trillion?1e12:1e8)).toLocaleString('ja-JP',{minimumFractionDigits:2,maximumFractionDigits:2})+(trillion?'兆円':'億円');
  }
  function render(){
    list.replaceChildren();
    for(const start of [1,26]){const col=document.createElement('div');col.style.minWidth='0';
      for(let i=start;i<start+25;i++){const row=document.createElement('div');row.style.cssText='display:flex;align-items:center;gap:4px;min-height:29px;border-bottom:1px solid #ffffff20;font-size:clamp(11px,2.5vw,14px)';
        const n=document.createElement('span');n.style.flex='0 0 2.4em';n.textContent=i+'位';row.append(n);
        const owner=ranks[i-1];if(owner){row.append(mark(i));const name=document.createElement('span');name.style.overflowWrap='anywhere';name.textContent=owner.ownerName;name.style.minWidth='0';row.append(name);const prize=document.createElement('span');prize.style.cssText='margin-left:auto;flex-shrink:0;white-space:nowrap;font-variant-numeric:tabular-nums';prize.textContent=formatPrize(owner.prizeYen);row.append(prize);}else row.append('—');col.append(row);}
      list.append(col);}
  }
  function own(){const target=document.getElementById('vs-saved-owner');if(!target)return;
    const identity=window.DBFMyArenaIdentity?.snapshot();const rank=identity?ranks.find(x=>x.ownerName===identity.ownerName)?.rank:null;
    const old=target.querySelector('[data-lifetime-mark]');if(old&&old.dataset.lifetimeMark===String(rank)&&identity&&target.textContent.replace(/^DRA/,'')===identity.ownerName)return;if(old)old.remove();
    if(rank&&target.textContent===identity.ownerName){const icon=mark(rank);icon.dataset.lifetimeMark=String(rank);target.prepend(icon);}
  }
  async function refresh(){if(busy)return;busy=true;try{const res=await fetch('./weekly_awards.json?lifetime='+Date.now(),{cache:'no-store'});if(!res.ok)throw Error('HTTP '+res.status);const data=await res.json();const rows=data.lifetimeOwners;
    if(!Array.isArray(rows)||rows.length>70||!rows.every((x,i)=>x.rank===i+1&&typeof x.ownerName==='string'&&x.ownerName.length>0&&x.ownerName.length<=24))throw Error('Lifetime ranking not ready');ranks=rows;render();own();
  }catch(e){console.warn('Lifetime owner ranking:',e);}finally{busy=false;}}
  refresh();setInterval(refresh,30000);setInterval(own,1000);
})();
