/* Firebase VS horse registration. UI code is isolated from the race viewer.
   Google-only login; owner name and horse roster stay bound to UID until 20 starts.
   The website NEVER receives or stores service-account credentials. */
(()=>{
  'use strict';
  const $=id=>document.getElementById(id);
  const file=$('vs-entry-file'),submit=$('vs-entry-submit'),message=$('vs-entry-message');
  const preview=$('vs-entry-preview'),loginStatus=$('vs-entry-login-status');
  const google=$('vs-entry-google');
  const ownerInput=$('vs-entry-ownername'),ownerHint=$('vs-entry-owner-status');
  if(!file||!submit||!message||!preview||!loginStatus||!google||!ownerInput)return;
  const cleanOwner=value=>typeof value==='string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g,'') : '';
  const validOwner=value=>value.length>=1 && [...value].length<=24 && !/[\u0000-\u001f\u007f]/.test(value);
  const cfg=window.VS_FIREBASE_CONFIG;
  let auth=null,db=null, sdk=null,chosen=null,busy=false,ready=false;
  let authPending=false,authPersistence='local';
  let selectionSerial=0;
  let reservedOwnerName='',profileLoaded=false;
  let lockedHorse=null,lockedCount=null,weeklyRegistered=null,weeklyCheckedIndex=null;
  // Enter your deployed Worker URL here. This URL is public; never put the private key here.
  const SECURE_REGISTER_URL='https://derby-vs-registration.aomusi45.workers.dev';
  const workerReady=()=>/^https:\/\/[^\s/]+\/?.*$/i.test(SECURE_REGISTER_URL) && !SECURE_REGISTER_URL.includes('SET_YOUR_');
  const say=s=>{message.textContent=s;};

  // Public racing calendar and privacy-safe registration counts.
  // The Firestore "vs_entries" collection is intentionally NOT listable from
  // browsers; its aggregate is published by the existing server recording job.
  const SLOT_MS=15*60*1000;
  const REGISTRATION_OPEN_MS=8*60*1000; // Close seven minutes before the next heat.
  const WEEK_MS=7*24*60*60*1000;
  const WEEK_EPOCH_MS=Date.UTC(1970,0,4,15); // Monday 00:00 JST
  const jstWeekIndex=ms=>Math.floor((ms-WEEK_EPOCH_MS)/WEEK_MS);
  const currentWeek=()=>jstWeekIndex(Date.now());
  const acceptingNow=()=>Date.now()%SLOT_MS<REGISTRATION_OPEN_MS &&
    currentWeek()===jstWeekIndex((Math.floor(Date.now()/SLOT_MS)+1)*SLOT_MS);
  const registrationForm=$('vs-entry-form'),persisted=$('vs-entry-persisted');
  const nextRaceName=$('vs-next-race-name');
  const nextRaceDetail=$('vs-next-race-detail');
  const nextRaceCountdown=$('vs-next-race-countdown');
  const totalLabel=$('vs-entry-total');
  const entryRace=$('vs-entry-race-name');
  const entryRoster=$('vs-entry-roster');
  const entryDeadline=$('vs-entry-deadline');
  const ownerLockLabel=$('vs-owner-horse-lock');
  const weeklyCapLabel=$('vs-weekly-registration-cap');
  let publicCatalog=null,publicManifest=null,ownRegistration=null,ownRegistrationId=null;
  let sharedEntries=null,sharedEntriesError='',sharedEntriesLoading=false;
  let publicError='',refreshingPublic=false,lastRegistrationName='';
  // Show this browser's server-confirmed registration before the next public snapshot.
  let localConfirmed=null;
  const jpDate=ms=>new Intl.DateTimeFormat('ja-JP',{
    timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',weekday:'short',
    hour:'2-digit',minute:'2-digit',hour12:false
  }).format(new Date(ms));
  const jpClock=ms=>new Intl.DateTimeFormat('ja-JP',{
    timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hour12:false
  }).format(new Date(ms));
  const jpDay=ms=>new Intl.DateTimeFormat('sv-SE',{
    timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
  }).format(new Date(ms));
  const nextSlot=()=>Math.floor(Date.now()/SLOT_MS)+1;
  // A registration belongs only to the immediately following 15-minute heat.
  // The Firestore server timestamp, not browser cache or local clock at signup,
  // identifies the slot. Older public records are never shown in later heats.
  const assignedSlot=stamp=>{
    const ms=stamp?.toMillis?.() ?? (typeof stamp==='string'?Date.parse(stamp):NaN);
    return Number.isFinite(ms)&&ms>0?Math.floor(ms/SLOT_MS)+1:null;
  };
  const ownForCurrentSlot=()=>!!ownRegistration&&assignedSlot(ownRegistration.updatedAt)===nextSlot();
  const slotCard=slot=>{
    if(!publicCatalog?.races?.length)return null;
    const anchor=Math.floor(Date.parse(publicCatalog.cycleStartsAt)/SLOT_MS);
    const i=((slot-anchor)%publicCatalog.races.length+publicCatalog.races.length)%publicCatalog.races.length;
    return publicCatalog.races[i];
  };
  const timeRemaining=ms=>{
    const total=Math.max(0,Math.ceil(ms/1000));
    const pad=n=>String(n).padStart(2,'0');
    return pad(Math.floor(total/60))+':'+pad(total%60);
  };
  const nextRecorded=slot=>publicManifest?.records?.find(row=>row?.intervalMinutes===15&&row.slot===slot)||null;
  const validAppearances=count=>Number.isSafeInteger(count)&&count>=0&&count<=20;
  const horseWithCount=row=>String(row.horseName||'不明')+'（'+
    (validAppearances(row.appearanceCount)?row.appearanceCount+'/20回':'出走回数確認中')+'）';
  function renderEntryRoster(rows){
    if(!entryRoster)return;
    entryRoster.replaceChildren();
    if(!rows?.length){entryRoster.textContent='登録済み馬はありません（または集計待ちです）。';return;}
    const head=document.createElement('div');head.className='vs-entry-row vs-entry-row-head';
    for(const label of ['馬名','オーナー名']){const cell=document.createElement('span');cell.textContent=label;head.append(cell);}
    entryRoster.append(head);
    for(const row of rows){
      const item=document.createElement('div');item.className='vs-entry-row';
      for(const value of [horseWithCount(row),row.ownerName||'未設定']){
        const cell=document.createElement('span');cell.textContent=value;item.append(cell);
      }
      entryRoster.append(item);
    }
  }
  function renderPublicStatus(){
    const slot=nextSlot(),slotMs=slot*SLOT_MS;
    const card=slotCard(slot);
    if(nextRaceName)nextRaceName.textContent=card?.name||'番組表を確認中';
    if(nextRaceDetail)nextRaceDetail.textContent=card
      ?jpDate(slotMs)+' 発走予定 ／ '+card.venue+'・芝'+card.distance+'m'
      :'開催番組表を読み込んでいます。';
    if(nextRaceCountdown)nextRaceCountdown.textContent=card
      ?'次回開催まで '+timeRemaining(slotMs-Date.now())
      :'次回開催まで ――';
    if(entryRace)entryRace.textContent=card?.name||'番組表を確認中';
    // Recording starts at :08/:23/:38/:53, seven minutes before each race.
    // Applications arriving after the server snapshot cannot enter this heat.
    const closingMs=slotMs-7*60*1000;
    const activeLock=lockedHorse;
    if(ownerLockLabel){
      ownerLockLabel.textContent=!activeLock?'登録馬：未登録':
        '保存済みの愛馬：'+activeLock.horseName+'（'+
          (lockedCount===null?'出走履歴確認中':lockedCount+'/20戦')+
          '）。20戦終了後に新しい馬を登録できます。';
    }
    if(weeklyCapLabel){
      weeklyCapLabel.textContent='今週の登録枠：'+
        (weeklyCheckedIndex===currentWeek()&&Number.isInteger(weeklyRegistered)
          ?weeklyRegistered+' / 120頭':'確認中 / 120頭')+
        '（1頭につき1週間のみ・再登録不可）';
    }
    if(persisted)persisted.textContent=ownForCurrentSlot()
      ?'登録済み：'+String(ownRegistration.horseName||'不明')+' ／ オーナー：'+String(ownRegistration.ownerName||'不明')+'（差し替え不可）'
      :(ownRegistration?'前回の登録はこの開催の対象外です。結果確定後のサーバー整理を確認中です。'
      :(!card?'受付状況を確認中':(!acceptingNow()?'現在は出走登録の受付時間外です。':'')));
    if(entryDeadline)entryDeadline.textContent=!card?'受付終了まで ――':
      Date.now()>=closingMs?'このレースの受付時間は終了しました':
      '受付終了まで '+timeRemaining(closingMs-Date.now());
    const summary=publicManifest?.registrationSummary;
    const valid=summary?.version===1 && Number.isInteger(summary.nextCandidateCount) &&
      summary.nextCandidateCount>=0 && summary.nextCandidateCount<=18 &&
      Number.isSafeInteger(summary.asOfMs) && summary.asOfMs>0 && summary.nextSlot===slot;
    const rows=valid&&Array.isArray(summary.nextEntries)&&
      summary.nextEntries.length===summary.nextCandidateCount&&
      summary.nextEntries.every(row=>typeof row.horseName==='string'&&typeof row.ownerName==='string')
      ?summary.nextEntries:null;
    // Public Firestore mirror is authoritative across devices. The GitHub
    // snapshot is used only as a fallback when mirror reads fail.
    const shared=Array.isArray(sharedEntries)?sharedEntries.filter(row=>row.slot===slot):null;
    const publishedRows=shared===null?rows:shared;
    // The public roster comes from the server. Only this user's verified
    // registration may be shown early; never replace another owner's record.
    let displayed=publishedRows?publishedRows.map(row=>({horseName:row.horseName,ownerName:row.ownerName,appearanceCount:row.appearanceCount})):[];
    const local=localConfirmed?.slot===slot&&localConfirmed?.uid===auth?.currentUser?.uid
      ?localConfirmed:null;
    if(local){
      const existing=displayed.findIndex(row=>row.ownerName===local.ownerName);
      const ownRow={horseName:local.horseName,ownerName:local.ownerName,
        appearanceCount:local.appearanceCount};
      if(existing>=0){
        // Do not discard a server-published count during the own-device overlay.
        if(!validAppearances(ownRow.appearanceCount)&&
           validAppearances(displayed[existing].appearanceCount))
          ownRow.appearanceCount=displayed[existing].appearanceCount;
        displayed[existing]=ownRow;
      }
      else if(displayed.length<18)displayed.push(ownRow);
    }
    if(totalLabel){
      const count=shared!==null?displayed.length:(valid?Math.max(summary.nextCandidateCount,displayed.length):
        (local?displayed.length:null));
      totalLabel.textContent='18頭中 '+(count===null?'―':Math.min(18,count))+'頭登録済み'+
        (local?'（自分の登録は反映済み）':'');
    }
    if(entryRoster){
      if(publishedRows||local)renderEntryRoster(displayed);
      else entryRoster.textContent=valid?'馬名・オーナー名の公開集計を確認中です。':
        '次回レースの登録馬を集計中です。';
    }
  }
  async function refreshPublicStatus(){
    if(refreshingPublic)return;
    refreshingPublic=true;
    try{
      const [catalogResponse,manifestResponse]=await Promise.all([
        fetch('./race_catalog.json?ts='+Date.now(),{cache:'no-store'}),
        fetch('./race_playlist.json?ts='+Date.now(),{cache:'no-store'})
      ]);
      if(!catalogResponse.ok||!manifestResponse.ok)throw Error('公開データを取得できません');
      const [catalog,manifest]=await Promise.all([catalogResponse.json(),manifestResponse.json()]);
      if(catalog.version!==1||catalog.intervalMinutes!==15||
         !Array.isArray(catalog.races)||!catalog.races.length||
         !Number.isFinite(Date.parse(catalog.cycleStartsAt))||
         manifest.version!==2||!Array.isArray(manifest.records))
        throw Error('公開データの形式が不正です');
      publicCatalog=catalog;publicManifest=manifest;publicError='';
    }catch(err){publicError=String(err.message||err);}
    finally{refreshingPublic=false;renderPublicStatus();}
  }
  function applySharedSnapshot(snapshot){
    if(snapshot.size>150)throw Error('公開登録数が上限を超えています');
    const rows=[];
    snapshot.forEach(doc=>{
      const d=doc.data();
      if(typeof d.ownerName==='string'&&typeof d.horseName==='string'&&
          d.ownerName===doc.id&&d.ownerName.length<=96&&d.horseName.length<=60)
        rows.push({ownerName:d.ownerName,horseName:d.horseName,
          appearanceCount:validAppearances(d.appearanceCount)?d.appearanceCount:null,
          slot:assignedSlot(d.updatedAt)});
    });
    rows.sort((a,b)=>a.ownerName.localeCompare(b.ownerName,'ja'));
    sharedEntries=rows;sharedEntriesError='';renderPublicStatus();
  }
  async function refreshSharedEntries(){
    if(sharedEntriesLoading||!ready||!db||!sdk)return;
    sharedEntriesLoading=true;
    try{
      // This intentionally uses the restricted public collection, NOT vs_entries.
      const snapshot=await sdk.getDocsFromServer(sdk.collection(db,'vs_public_entries'));
      applySharedSnapshot(snapshot);
    }catch(err){
      sharedEntriesError=String(err.code||err.message||err);
      console.warn('公開出走登録一覧の取得失敗',sharedEntriesError);
    }finally{sharedEntriesLoading=false;renderPublicStatus();}
  }
  // Read immediately on first SDK initialization and periodically across devices.
  // No client-provided horse data is treated as a server-confirmed registration.
  async function hashRegisteredHorse(uid,horseId,serverTime){
    // Match registered_horses.py: each Firestore submission has a unique receipt ID.
    if(!globalThis.crypto?.subtle)return null;
    if(!serverTime || !Number.isFinite(serverTime.seconds) || !Number.isFinite(serverTime.nanoseconds))return null;
    const micros=serverTime.seconds*1000000+Math.floor(serverTime.nanoseconds/1000);
    if(!Number.isSafeInteger(micros))return null;
    const bytes=new TextEncoder().encode(uid+'|'+horseId+'|'+String(micros));
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    return [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('').slice(0,24);
  }
  async function updateOwnFromDocument(user,docData,confirmedCount=null){
    if(auth?.currentUser?.uid!==user.uid)return;
    ownRegistration=docData;ownRegistrationId=null;
    if(docData?.horseName)lastRegistrationName=String(docData.horseName);
    localConfirmed=docData?{slot:assignedSlot(docData.updatedAt),uid:user.uid,
      horseName:String(docData.horseName||''),ownerName:String(docData.ownerName||''),
      appearanceCount:validAppearances(confirmedCount)?confirmedCount:null}:null;
    if(docData?.ownerName && !reservedOwnerName && !ownerInput.value)ownerInput.value=cleanOwner(docData.ownerName);
    updateSubmit();renderPublicStatus();
    // Server-side lifetime ledger is the source of truth for the owner as well.
    // Missing ledger document means this horse has completed zero official races.
    if(docData?.horseKey && !validAppearances(confirmedCount) &&
       /^[a-f0-9]{64}$/.test(docData.horseKey)){
      try{
        const countSnap=await sdk.getDocFromServer(sdk.doc(db,'vs_horse_usage',docData.horseKey));
        const count=countSnap.exists()?Number(countSnap.data().count):0;
        if(auth?.currentUser?.uid===user.uid && localConfirmed?.uid===user.uid &&
           localConfirmed?.horseName===docData.horseName && validAppearances(count)){
          localConfirmed.appearanceCount=count;
          renderPublicStatus();
        }
      }catch(err){console.warn('出走回数を取得できません',err);}
    }
    if(docData?.horseId){
      try{
        const id=await hashRegisteredHorse(user.uid,docData.horseId,docData.updatedAt);
        if(auth.currentUser?.uid===user.uid){ownRegistrationId=id;renderPublicStatus();}
      }catch(err){console.warn('出走照合IDを計算できません',err);}
    }
  }
  renderPublicStatus();
  refreshPublicStatus();
  setInterval(()=>{renderPublicStatus();updateSubmit();},1000);
  setInterval(refreshPublicStatus,30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){refreshPublicStatus();refreshSharedEntries();}});
  const num=(raw,def,lo,hi)=>{
    if(raw===null||raw===undefined||raw==='')return def;
    const n=Number(raw);
    return Number.isFinite(n)?Math.min(hi,Math.max(lo,n)):def;
  };
  function normalize(snapshot){
    if(!snapshot || snapshot.format!=='derby-fantasy-battle-horse' || snapshot.schema!==1 ||
        !snapshot.horse || !snapshot.raceStats || typeof snapshot.snapshotId!=='string' ||
        !snapshot.snapshotId || snapshot.snapshotId.length>180)
      throw Error('ゲームで書き出したVS登録馬ファイルを選んでください。');
    const name=String(snapshot.name||'').trim();
    if(!name||name.length>60)throw Error('馬名が正しくありません。');
    const horseId=String(snapshot.sourceHorseId||snapshot.snapshotId);
    if(!horseId||horseId.length>180)throw Error('馬の識別番号が正しくありません。');
    const stats={};
    for(const key of ['sp','sta','kick','early','sustain','grit','stability']){
      const value=snapshot.raceStats[key]?.total;
      if(value===null||value===undefined||value===''||!Number.isFinite(Number(value)) ||
         Number(value)<0||Number(value)>500)
        throw Error('能力データが不足または不正です：'+key);
      stats[key]=Number(value);
    }
    const context=snapshot.raceContext||{}, horse=snapshot.horse||{};
    const going=context.goingAptitude||{};
    const age=num(snapshot.age,4,2,8);
    const growth=['持続','早熟','普通','晩成'].includes(snapshot.growth)?snapshot.growth:
      (['持続','早熟','普通','晩成'].includes(horse.growth)?horse.growth:'普通');
    const runner={
      name,sex:['牡','牝','セ'].includes(snapshot.sex)?snapshot.sex:'牡',
      coatType:String(snapshot.coatType||'鹿毛').slice(0,16),age,growth,
      tactic:['逃げ','先行','差し','追込'].includes(context.tactic)?context.tactic:'先行',
      speed:stats.sp,sta:stats.sta,kick:stats.kick,early:stats.early,
      sustain:stats.sustain,grit:stats.grit,stability:stats.stability,
      bestDistance:num(context.bestDistance,2000,800,4000),
      aptMin:num(context.aptMin,1200,800,4000),aptMax:num(context.aptMax,3000,800,4000),
      health:num(context.health,90,0,110),temperament:num(context.temperament,85,0,110),
      form:num(context.form,75,0,100),fatigue:num(context.fatigue,0,0,100),
      g1Wins:num(horse.g1Wins,0,0,1000),
      earnedPrize:num(horse.prize??snapshot.career?.prize,0,0,10000000000000),
      going:Object.fromEntries(['良','稍重','重','不良'].map(k=>[k,num(going[k],100,0,200)]))
    };
    if(runner.aptMin>runner.aptMax)throw Error('距離適性の範囲が不正です。');
    // The current DBF game can embed an owner's public name in its VS JSON.
    // Older exports have none; the player can enter a public name separately.
    const ownerCandidates=[snapshot.ownerName,snapshot.playerName,snapshot.owner,
      snapshot.owner?.name,snapshot.player?.name,snapshot.horse?.ownerName,
      snapshot.horse?.owner,snapshot.horse?.owner?.name,
      snapshot.profile?.ownerName,snapshot.farm?.ownerName];
    const jsonOwner=ownerCandidates.map(cleanOwner).find(validOwner)||'';
    return {horseId,name,runner,jsonOwner,originalSnapshot:snapshot};
  }
  // V24 stage UI. Status is read from the authenticated Worker, never from
  // browser storage; same Google UID works across devices without re-upload.
  const ownerSetup=$('vs-owner-setup'),ownerSave=$('vs-owner-save');
  const raceApply=$('vs-race-apply'),raceSubmit=$('vs-entry-race-submit');
  const profileCard=$('vs-entry-profile'),savedOwnerText=$('vs-saved-owner');
  const savedHorseText=$('vs-saved-horse');
  let serverChecked=false,savedHorse=null,loadSeq=0;
  const GOOGLE_PROVIDER='google.com';
  const isGoogle=()=>!!auth?.currentUser&&!auth.currentUser.isAnonymous&&
    auth.currentUser.providerData?.some(p=>p.providerId===GOOGLE_PROVIDER);
  const countValid=n=>Number.isInteger(n)&&n>=0&&n<=20;
  function showStages(){
    const allowed=!!isGoogle()&&profileLoaded&&serverChecked;
    const hasOwner=allowed&&validOwner(reservedOwnerName);
    const completed=!!savedHorse&&savedHorse.appearances===20;
    if(ownerSetup)ownerSetup.hidden=!allowed||hasOwner;
    if(registrationForm)registrationForm.hidden=!hasOwner||!!savedHorse&&(!completed||savedHorse.registered);
    if(raceApply)raceApply.hidden=!hasOwner||!savedHorse||completed;
    if(profileCard)profileCard.hidden=!hasOwner;
    if(savedOwnerText)savedOwnerText.textContent=hasOwner?reservedOwnerName:'未登録';
    if(savedHorseText)savedHorseText.textContent=!savedHorse?'まだ馬が登録されていません':
      savedHorse.horseName+'（'+savedHorse.appearances+'/20戦）'+(completed?'・登録終了':'');
    ownerInput.readOnly=hasOwner;
    ownerSave.disabled=busy||authPending||!allowed||!validOwner(cleanOwner(ownerInput.value));
    const newHorse=hasOwner&&(!savedHorse||completed);
    submit.textContent=completed?'新しい馬を保存する':'この馬を保存する';
    submit.disabled=busy||authPending||!newHorse||!chosen||!workerReady();
    const needsWeek=savedHorse&&savedHorse.weekIndex!==currentWeek();
    const capFull=weeklyCheckedIndex===currentWeek()&&weeklyRegistered>=120&&needsWeek;
    const wasApplied=!!ownRegistration||!!savedHorse?.registered;
    raceSubmit.disabled=busy||authPending||!ready||!hasOwner||!savedHorse||completed||
      !workerReady()||!acceptingNow()||wasApplied||capFull;
    raceSubmit.textContent=wasApplied?'今回のレースに登録済み':
      !acceptingNow()?'受付時間外（次回受付をお待ちください）':
      capFull?'今週の120人枠は満員です':'このレースに登録';
    google.disabled=!ready||authPending||busy;
    google.textContent=authPending?'Google認証中…':(isGoogle()?'Googleログイン済み':'Googleでログイン');
  }
  const updateSubmit=showStages;
  // V25: Restore this missing V23 routine. Its absence caused
  // `refreshWeeklyCapacity is not defined` during init(), before the Firebase
  // auth-state observer was installed. Quota is read-only; failures must not
  // prevent Google login or mutate owner/horse/entry records.
  async function refreshWeeklyCapacity(){
    if(!ready||!db||!sdk)return;
    const week=currentWeek();
    try{
      const cap=await sdk.getDocFromServer(sdk.doc(db,'vs_weekly_registration_counts','w'+week));
      const n=cap.exists()?Number(cap.data().count):0;
      if(!Number.isInteger(n)||n<0||n>120)throw Error('週間登録数が不正です');
      // Ignore an out-of-date async reply that crossed the JST week boundary.
      if(currentWeek()!==week)return;
      weeklyRegistered=n;
      weeklyCheckedIndex=week;
      renderPublicStatus();updateSubmit();
    }catch(err){
      // Insufficient Firestore read permission should NOT disable authentication.
      if(currentWeek()!==week)return;
      weeklyRegistered=null;weeklyCheckedIndex=null;
      console.warn('週間登録枠を取得できません',err);
      renderPublicStatus();updateSubmit();
    }
  }
  async function workerRequest(path,data={},user=auth?.currentUser){
    if(!workerReady())throw Error('公式登録サーバーが利用できません');
    if(!user||!user.providerData?.some(p=>p.providerId===GOOGLE_PROVIDER)||user.isAnonymous)
      throw Error('Googleアカウントでログインしてください');
    const token=await sdk.getIdToken(user);
    const r=await fetch(SECURE_REGISTER_URL.replace(/\/+$/,'')+path,{
      method:'POST',mode:'cors',cache:'no-store',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify(data)});
    let result;
    try{result=await r.json();}catch(_){throw Error('登録サーバーの応答を読み込めません');}
    if(!r.ok||!result?.ok)throw Error(String(result?.error||'サーバーで登録できませんでした'));
    return result;
  }
  async function loadProfile(user,displayNotice=true){
    const seq=++loadSeq;
    const result=await workerRequest('/profile',{},user);
    if(seq!==loadSeq||auth?.currentUser?.uid!==user.uid)return;
    const count=result.horseName?Number(result.appearances):null;
    if(result.horseName&&!countValid(count))throw Error('保存済みの出走回数が不正です');
    reservedOwnerName=cleanOwner(result.ownerName||'');
    if(reservedOwnerName&&!validOwner(reservedOwnerName))throw Error('登録済みオーナー名が不正です');
    ownerInput.value=reservedOwnerName||ownerInput.value;
    profileLoaded=true;serverChecked=true;
    savedHorse=result.horseName?{
      horseName:String(result.horseName),horseId:String(result.horseId||''),
      appearances:count,weekIndex:result.weekIndex,registered:!!result.registered}:null;
    lockedHorse=savedHorse?{
      horseId:savedHorse.horseId,horseName:savedHorse.horseName,weekIndex:savedHorse.weekIndex}:null;
    lockedCount=count;
    if(ownerHint)ownerHint.textContent=reservedOwnerName?
      'オーナー名はGoogleアカウントに保存済みです。変更できません。':
      '最初の一度だけ登録してください。同じ名前は他の人が使えません。';
    if(displayNotice){
      say(!reservedOwnerName?'初回設定：オーナー名を登録してください。':
        !savedHorse?'初回設定：愛馬のVS登録ファイルを1回だけ選んで保存してください。':
        count>=20?'20戦を完走しました。別の新しい馬を登録できます。':
        'おかえりなさい。保存済みの「'+savedHorse.horseName+'」で、レース登録ボタンを押すだけです。');
    }
    renderPublicStatus();updateSubmit();
  }
  // Read only the owner-authenticated live entry. This is a single current
  // race application, not the permanent horse profile. A race consumes it.
  async function refreshOwnRegistration(user=auth?.currentUser){
    if(!ready||!user||busy||!isGoogle())return;
    try{
      const doc=await sdk.getDocFromServer(sdk.doc(db,'vs_entries',user.uid));
      if(auth?.currentUser?.uid!==user.uid)return;
      if(doc.exists()){
        if(!ownRegistration||ownRegistration.updatedAt?.toMillis?.()!==doc.data().updatedAt?.toMillis?.())
          await updateOwnFromDocument(user,doc.data());
      }else if(ownRegistration){
        ownRegistration=null;ownRegistrationId=null;localConfirmed=null;
        renderPublicStatus();
      }
      await loadProfile(user,false);
    }catch(err){console.warn('登録状況を確認できません',err);}
  }
  async function init(){
    if(!cfg||cfg.projectId!=='derby-vs-arena'||!cfg.apiKey){
      say('Firebaseの公開設定が見つかりません');return;
    }
    const base='https://www.gstatic.com/firebasejs/13.2.0/';
    const [appSdk,authSdk,fsSdk]=await Promise.all([
      import(base+'firebase-app.js'),import(base+'firebase-auth.js'),
      import(base+'firebase-firestore.js')]);
    sdk={...authSdk,...fsSdk};
    const app=appSdk.getApps().find(a=>a.options.projectId===cfg.projectId)||
      appSdk.initializeApp(cfg,'vs-arena-registration');
    auth=authSdk.getAuth(app);
    try{await authSdk.setPersistence(auth,authSdk.browserLocalPersistence);}catch(_){
      try{await authSdk.setPersistence(auth,authSdk.browserSessionPersistence);authPersistence='session';}
      catch(_){await authSdk.setPersistence(auth,authSdk.inMemoryPersistence);authPersistence='memory';}
    }
    db=fsSdk.getFirestore(app);ready=true;
    fsSdk.onSnapshot(fsSdk.collection(db,'vs_public_entries'),snapshot=>{
      try{applySharedSnapshot(snapshot);}catch(err){console.warn(err);}
    },err=>{sharedEntriesError=String(err.code||err.message||err);console.warn(err);});
    refreshSharedEntries();refreshWeeklyCapacity();
    authSdk.onAuthStateChanged(auth,async user=>{
      const seq=++loadSeq;
      ownRegistration=null;ownRegistrationId=null;localConfirmed=null;
      lockedHorse=null;lockedCount=null;savedHorse=null;
      reservedOwnerName='';profileLoaded=false;serverChecked=false;chosen=null;
      file.value='';preview.textContent='';ownerInput.value='';ownerInput.readOnly=false;
      updateSubmit();renderPublicStatus();
      if(!user){loginStatus.textContent='未ログイン';say('Googleでログインしてください。');return;}
      if(!user.providerData?.some(p=>p.providerId===GOOGLE_PROVIDER)||user.isAnonymous){
        loginStatus.textContent='Google連携待ち';say('ゲスト登録は終了しました。Googleでログインしてください。');return;}
      loginStatus.textContent='Googleログイン済み';
      try{
        await loadProfile(user,true);
        if(seq===loadSeq-1||auth?.currentUser?.uid===user.uid)
          await refreshOwnRegistration(user);
      }catch(err){
        if(auth?.currentUser?.uid!==user.uid)return;
        serverChecked=false;profileLoaded=false;
        say('オーナー・登録馬の読み込みに失敗：'+String(err.message||err)+'。Cloudflareの新しいWorkerが公開済みか確認してください。');
        updateSubmit();
      }
    });
    setInterval(()=>{refreshWeeklyCapacity();refreshOwnRegistration();},30000);
    document.addEventListener('visibilitychange',()=>{
      if(!document.hidden){refreshOwnRegistration();refreshSharedEntries();}
    });
    updateSubmit();
    say('Googleログイン後、保存済みのオーナー名と馬を読み込みます。');
  }
  google.addEventListener('click',async()=>{
    if(!ready||busy||authPending)return;
    if(isGoogle()){say('すでにGoogleログイン済みです。');return;}
    authPending=true;loginStatus.textContent='Google認証中…';updateSubmit();
    try{
      const provider=new sdk.GoogleAuthProvider();
      provider.setCustomParameters({prompt:'select_account'});
      if(auth.currentUser?.isAnonymous){
        // Preserve existing anonymous UID/horse if this account was not yet linked.
        try{await sdk.linkWithPopup(auth.currentUser,provider);}
        catch(err){
          if(err?.code==='auth/credential-already-in-use'||err?.code==='auth/email-already-in-use'){
            say('そのGoogleアカウントは登録済みです。ゲストの馬は自動移行できないため、続行する前に旧データの控えを確認してください。');
            throw err;
          }
          throw err;
        }
      }else await sdk.signInWithPopup(auth,provider);
      loginStatus.textContent='Googleログイン済み';
      if(isGoogle())await loadProfile(auth.currentUser,true);
    }catch(err){
      const code=String(err?.code||'unknown');
      const hints={
        'auth/popup-blocked':'ポップアップを許可してください。',
        'auth/popup-closed-by-user':'Googleログインがキャンセルされました。',
        'auth/unauthorized-domain':'Firebase承認済みドメインに aomusi45.github.io が必要です。',
        'auth/operation-not-allowed':'FirebaseでGoogle認証を有効にしてください。',
        'auth/network-request-failed':'通信状況を確認してください。',
        'auth/credential-already-in-use':'Googleアカウントが別ユーザーで使用中です。運営者にご相談ください。'
      };
      say('Googleログインに失敗：'+(hints[code]||'通常のChromeなどで開いて再試行してください。')+' ['+code+']');
    }finally{authPending=false;updateSubmit();}
  });
  ownerInput.addEventListener('input',updateSubmit);
  ownerSave.addEventListener('click',async()=>{
    if(!isGoogle()||busy||authPending||reservedOwnerName||!profileLoaded)return;
    const ownerName=cleanOwner(ownerInput.value);
    if(!validOwner(ownerName)){say('オーナー名は1〜24文字で入力してください。');return;}
    busy=true;updateSubmit();say('Googleアカウントへオーナー名を保存中…');
    try{
      await workerRequest('/owner',{ownerName});
      await loadProfile(auth.currentUser,true);
    }catch(err){say('オーナー名を登録できません：'+String(err.message||err));}
    finally{busy=false;updateSubmit();}
  });
  const SEALED_FORMAT='derby-fantasy-vs-sealed';
  const SEALED_KEY_ID='dbf-vs-20261110-k1';
  function validSealed(raw){return raw&&raw.format===SEALED_FORMAT&&raw.version===2&&
    raw.keyId===SEALED_KEY_ID&&raw.keyWrap==='RSA-OAEP-SHA256'&&
    raw.cipher==='AES-256-GCM'&&typeof raw.wrappedKey==='string'&&raw.wrappedKey.length<1024&&
    typeof raw.iv==='string'&&raw.iv.length<80&&typeof raw.data==='string'&&raw.data.length<1600000;}
  file.addEventListener('change',async()=>{
    const serial=++selectionSerial;chosen=null;preview.textContent='';updateSubmit();
    const f=file.files?.[0];if(!f)return;
    if(f.size>1048576||f.size===0||!(/\.(json|dbfvs)$/i.test(f.name))){
      say('1MB以下のVS登録馬ファイルを選んでください。');return;
    }
    try{
      const raw=await f.text();if(serial!==selectionSerial)return;
      const parsed=JSON.parse(raw);
      const sealedFile=/\.dbfvs(?:\.json)?$/i.test(f.name)||parsed?.format===SEALED_FORMAT;
      if(sealedFile){
        if(!validSealed(parsed))throw Error('非対応の暗号化データです。新しいゲームから書き出し直してください。');
        chosen={sealed:true,envelope:parsed};
        preview.textContent='暗号化VS馬ファイル：'+f.name+'（登録サーバーで検証します）';
      }else{
        if(parsed?.format==='derby-fantasy-vs-locked')throw Error('旧式ファイルです。新しいゲームから書き出してください。');
        chosen=normalize(parsed);
        preview.textContent='登録予定の馬：'+chosen.name+' ／ '+chosen.runner.age+'歳';
      }
      say('この馬を保存すると、20戦終了まで変更できません。');
    }catch(err){if(serial===selectionSerial)say('馬データを読み込めません：'+String(err.message||err));}
    updateSubmit();
  });
  submit.addEventListener('click',async()=>{
    if(!isGoogle()||busy||!chosen||!reservedOwnerName||!profileLoaded)return;
    if(savedHorse&&savedHorse.appearances!==20){say('20戦終了まで新しい馬に変更できません。');return;}
    busy=true;updateSubmit();say('愛馬の能力を公式サーバーに保存しています…');
    try{
      const result=await workerRequest(chosen.sealed?'/horse/save':'/horse/save-json',
        chosen.sealed?{envelope:chosen.envelope}:{snapshot:chosen.originalSnapshot});
      await loadProfile(auth.currentUser,false);
      chosen=null;file.value='';preview.textContent='';
      say('愛馬「'+result.horseName+'」を保存しました。次からファイル選択は不要です。受付時間になったら「このレースに登録」を押してください。');
    }catch(err){say('登録馬を保存できません：'+String(err.message||err));}
    finally{busy=false;updateSubmit();}
  });
  raceSubmit.addEventListener('click',async()=>{
    if(!isGoogle()||busy||!savedHorse||savedHorse.appearances>=20||!acceptingNow())return;
    busy=true;updateSubmit();say('保存済みの愛馬でレースへの申込みを処理中…');
    try{
      const result=await workerRequest('/enter');
      const doc=await sdk.getDocFromServer(sdk.doc(db,'vs_entries',auth.currentUser.uid));
      if(!doc.exists()||doc.data().horseName!==result.horseName)
        throw Error('サーバーで申込みの確認ができません。少ししてから状態を再確認してください。');
      await updateOwnFromDocument(auth.currentUser,doc.data(),result.appearances);
      await loadProfile(auth.currentUser,false);await refreshSharedEntries();
      say('レース登録完了：'+result.horseName+'（'+result.appearances+'/20戦終了）。レース結果の確定後、次のレースに登録できます。');
    }catch(err){say('レースへの登録を確認できません：'+String(err.message||err));}
    finally{busy=false;updateSubmit();}
  });
  window.DBFMyArenaIdentity=Object.freeze({snapshot(){
    if(!isGoogle()||!profileLoaded||!validOwner(reservedOwnerName))return null;
    return {ownerName:reservedOwnerName,
      horseName:savedHorse?.horseName||'',weekIndex:currentWeek()};
  }});
  window.VSEntry=Object.freeze({normalize});
  init().catch(err=>{ready=false;updateSubmit();say('Firebase初期化エラー：'+String(err.message||err));});
})();
