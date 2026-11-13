/* DBF public visitor counter V16.
   First-party anonymous browser ID, stored locally; no IP, name, or account ID.
   One unique browser per day and per lifetime; totals are approximate. */
(function () {
  'use strict';
  const TODAY=document.getElementById('dbf-visitors-today');
  const TOTAL=document.getElementById('dbf-visitors-total');
  if (!TODAY || !TOTAL) return;
  const KEY='dbf-official-visitor-id-v1';
  const ENDPOINT='https://derby-vs-registration.aomusi45.workers.dev/visitors';
  function makeId() {
    const bytes=new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
  }
  let id='';
  try {
    id=localStorage.getItem(KEY)||'';
    if (!/^[a-f0-9]{32}$/.test(id)) { id=makeId();localStorage.setItem(KEY,id); }
  } catch (_) {
    // Browser storage may be disabled. Keep a stable ID within the current tab.
    try {
      id=sessionStorage.getItem(KEY)||'';
      if (!/^[a-f0-9]{32}$/.test(id)) {id=makeId();sessionStorage.setItem(KEY,id);}
    } catch (_) {id=makeId();}
  }
  fetch(ENDPOINT, {
    method:'POST', mode:'cors', cache:'no-store',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({visitorId:id})
  }).then(async r=>{
    if (!r.ok) throw Error('visitor HTTP '+r.status);
    const data=await r.json();
    if (!data.ok || !Number.isSafeInteger(data.today) || !Number.isSafeInteger(data.total) ||
        data.today<0 || data.total<0) throw Error('invalid visitor count');
    TODAY.textContent=data.today.toLocaleString('ja-JP');
    TOTAL.textContent=data.total.toLocaleString('ja-JP');
  }).catch(e=>{
    // Never show 0 when the service is unavailable; no fake counts.
    TODAY.textContent='—';TOTAL.textContent='—';
    console.warn('DBF visitor counter is unavailable:',e?.message||e);
  });
})();
