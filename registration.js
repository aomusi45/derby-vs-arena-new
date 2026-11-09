/* Firebase VS horse registration. UI code is isolated from the race viewer.
   Login may be Google or anonymous; one account has one replaceable horse.
   The website NEVER receives or stores service-account credentials. */
(()=>{
  'use strict';
  const $=id=>document.getElementById(id);
  const file=$('vs-entry-file'),submit=$('vs-entry-submit'),message=$('vs-entry-message');
  const preview=$('vs-entry-preview'),loginStatus=$('vs-entry-login-status');
  const google=$('vs-entry-google'),guest=$('vs-entry-guest');
  if(!file||!submit||!message||!preview||!loginStatus||!google||!guest)return;
  const cfg=window.VS_FIREBASE_CONFIG;
  let auth=null,db=null, sdk=null,chosen=null,busy=false,ready=false;
  const say=s=>{message.textContent=s;};

  // Public racing calendar and privacy-safe registration counts.
  // The Firestore "vs_entries" collection is intentionally NOT listable from
  // browsers; its aggregate is published by the existing server recording job.
  const SLOT_MS=15*60*1000;
  const nextRaceName=$('vs-next-race-name');
  const nextRaceDetail=$('vs-next-race-detail');
  const nextRaceCountdown=$('vs-next-race-countdown');
  const totalLabel=$('vs-entry-total');
  const totalUpdated=$('vs-entry-updated');
  const nextCandidates=$('vs-entry-next-candidates');
  const ownHorseLabel=$('vs-entry-myhorse');
  const ownStatusLabel=$('vs-entry-my-status');
  let publicCatalog=null,publicManifest=null,ownRegistration=null,ownRegistrationId=null;
  let publicError='',refreshingPublic=false,lastRegistrationName='';
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
  function showOwnRaceStatus(card,slot,finalized){
    if(!ownHorseLabel||!ownStatusLabel)return;
    if(!auth?.currentUser){
      ownHorseLabel.textContent='自分の登録馬：ログイン後に確認できます。';
      ownStatusLabel.textContent='出走状況：未ログイン';
      return;
    }
    if(!ownRegistration){
      ownHorseLabel.textContent='自分の登録馬：未登録';
      ownStatusLabel.textContent=lastRegistrationName?'出走状況：前回の登録は終了。再登録できます':'出走状況：登録受付中';
      return;
    }
    ownHorseLabel.textContent='自分の登録馬：'+String(ownRegistration.horseName||'名称不明');
    if(!card || !publicManifest?.records){
      ownStatusLabel.textContent='出走状況：レース一覧を確認中';
      return;
    }
    if(!ownRegistrationId){
      ownStatusLabel.textContent='出走状況：本人の出走記録を確認中';
      return;
    }
    const record=finalized||nextRecorded(slot);
    if(record){
      ownStatusLabel.textContent=record.registrations?.includes(ownRegistrationId)
        ?'次回の'+card.name+'：出走が記録されています（確定）'
        :'次回の'+card.name+'：出走記録に含まれていません';
      return;
    }
    const day=jpDay(slot*SLOT_MS);
    const raced=publicManifest.records.some(row=>row?.name===card.name &&
      Number.isInteger(row.slot) &&
      jpDay(row.slot*(row.intervalMinutes===15?SLOT_MS:600000))===day &&
      Array.isArray(row.registrations)&&row.registrations.includes(ownRegistrationId));
    ownStatusLabel.textContent=raced
      ?'次回の'+card.name+'：本日同じGⅠに出走済みのため対象外'
      :'次回の'+card.name+'：出走抽選の対象（出走未確定）';
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
    const summary=publicManifest?.registrationSummary;
    const valid=summary?.version===1 && Number.isInteger(summary.registeredCount)&&
      summary.registeredCount>=0 && summary.registeredCount<=150 &&
      Number.isSafeInteger(summary.asOfMs) && summary.asOfMs>0;
    if(totalLabel){
      totalLabel.textContent=valid?'登録総数：'+summary.registeredCount+'頭（最終集計値）':'登録総数：集計待ち';
    }
    if(totalUpdated){
      const age=valid?Date.now()-summary.asOfMs:0;
      totalUpdated.textContent=valid
        ?'最終集計：'+jpDate(summary.asOfMs)+(age>45*60000?' ／ 更新が遅れています':'')+' ※登録直後は次の集計で反映'
        :(publicError?'登録数を取得できません。最新公開データを確認してください。':'GitHub Actionsの次の集計後に表示されます。');
    }
    const record=nextRecorded(slot);
    const finalCount=record && Array.isArray(record.registrations) ? record.registrations.length:null;
    if(nextCandidates){
      if(finalCount!==null){
        nextCandidates.textContent='次回GⅠの登録馬出走確定：'+finalCount+'頭／最大18頭';
      }else if(valid && summary.nextSlot===slot && !summary.nextFinal &&
          Number.isInteger(summary.nextCandidateCount) && summary.nextCandidateCount>=0){
        nextCandidates.textContent='次回GⅠの出走候補：'+summary.nextCandidateCount+'頭／最大18頭（抽選前）';
      }else{
        nextCandidates.textContent='次回GⅠの出走候補：未集計／最大18頭（出走未確定）';
      }
    }
    showOwnRaceStatus(card,slot,record);
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
  async function updateOwnFromDocument(user,docData){
    if(auth?.currentUser?.uid!==user.uid)return;
    ownRegistration=docData;ownRegistrationId=null;
    if(docData?.horseName)lastRegistrationName=String(docData.horseName);
    renderPublicStatus();
    if(docData?.horseId){
      try{
        const id=await hashRegisteredHorse(user.uid,docData.horseId,docData.updatedAt);
        if(auth.currentUser?.uid===user.uid){ownRegistrationId=id;renderPublicStatus();}
      }catch(err){console.warn('出走照合IDを計算できません',err);}
    }
  }
  renderPublicStatus();
  refreshPublicStatus();
  setInterval(renderPublicStatus,1000);
  setInterval(refreshPublicStatus,30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshPublicStatus();});
  const num=(raw,def,lo,hi)=>{
    if(raw===null||raw===undefined||raw==='')return def;
    const n=Number(raw);
    return Number.isFinite(n)?Math.min(hi,Math.max(lo,n)):def;
  };
  function normalize(snapshot){
    if(!snapshot || snapshot.format!=='derby-fantasy-battle-horse' || snapshot.schema!==1 ||
        !snapshot.horse || !snapshot.raceStats || typeof snapshot.snapshotId!=='string' ||
        !snapshot.snapshotId || snapshot.snapshotId.length>180)
      throw Error('ゲームで書き出した「対戦馬JSON」を選んでください。');
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
    return {horseId,name,runner};
  }
  const updateSubmit=()=>{submit.disabled=busy||!ready||!chosen||!auth?.currentUser;};
  async function init(){
    if(!cfg||cfg.projectId!=='derby-vs-arena'||!cfg.apiKey){
      say('Firebaseの公開設定が見つかりません。登録機能は停止中です。');return;
    }
    // Module imports are async. Failure here cannot block the existing site.js.
    const base='https://www.gstatic.com/firebasejs/13.2.0/';
    const [appSdk, authSdk, fsSdk]=await Promise.all([
      import(base+'firebase-app.js'),import(base+'firebase-auth.js'),
      import(base+'firebase-firestore.js')]);
    sdk={...authSdk,...fsSdk};
    const app=appSdk.getApps().find(a=>a.options.projectId===cfg.projectId) ||
      appSdk.initializeApp(cfg,'vs-arena-registration');
    auth=authSdk.getAuth(app);
    await authSdk.setPersistence(auth,authSdk.browserLocalPersistence);
    db=fsSdk.getFirestore(app);ready=true;
    authSdk.onAuthStateChanged(auth,async user=>{
      ownRegistration=null;ownRegistrationId=null;updateSubmit();renderPublicStatus();
      if(!user){loginStatus.textContent='未ログイン';say('Googleまたはゲストでログインして馬を登録してください。');return;}
      loginStatus.textContent=(user.isAnonymous?'ゲスト':'ログイン中')+'：登録可能';
      try{
        const snap=await fsSdk.getDoc(fsSdk.doc(db,'vs_entries',user.uid));
        if(auth.currentUser?.uid!==user.uid)return;
        if(snap.exists()){
          say('現在の登録馬：'+String(snap.data().horseName||'不明')+'。1回出走後に登録解除されます。別の馬で上書き登録できます。');
          await updateOwnFromDocument(user,snap.data());
        }else{
          say('登録受付中。ゲームの対戦馬JSONを選んでください。');
        }
      }catch(err){say('登録状態を確認できません：'+String(err.code||err.message||err));}
    });
    say('ログイン後、対戦馬JSONを選んで登録できます。');
    setInterval(refreshOwnRegistration,30000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshOwnRegistration();});
  }
  async function refreshOwnRegistration(){
    const user=auth?.currentUser;
    if(!user||busy||!ready)return;
    try{
      const snap=await sdk.getDocFromServer(sdk.doc(db,'vs_entries',user.uid));
      if(auth?.currentUser?.uid!==user.uid)return;
      if(snap.exists()){
        if(!ownRegistration || ownRegistration.updatedAt?.toMillis?.()!==snap.data().updatedAt?.toMillis?.())
          await updateOwnFromDocument(user,snap.data());
      }else if(ownRegistration){
        const racedName=String(ownRegistration.horseName||'登録馬');
        ownRegistration=null;ownRegistrationId=null;renderPublicStatus();
        say(racedName+'の登録は出走完了により解除されました。再登録できます。');
      }
    }catch(err){console.warn('登録状態の更新に失敗',err);}
  }
  google.addEventListener('click',async()=>{
    if(!ready||busy)return;
    try{await sdk.signInWithPopup(auth,new sdk.GoogleAuthProvider());}
    catch(err){say('Googleログインに失敗：'+String(err.code||err.message||err));}
  });
  guest.addEventListener('click',async()=>{
    if(!ready||busy)return;
    try{await sdk.signInAnonymously(auth);}
    catch(err){say('ゲストログインに失敗：'+String(err.code||err.message||err));}
  });
  file.addEventListener('change',async()=>{
    chosen=null;preview.textContent='';updateSubmit();
    const f=file.files?.[0];if(!f)return;
    if(f.size>1048576||!/\.json$/i.test(f.name)){
      say('1MB以下のJSONファイルを選んでください。');return;
    }
    try{
      chosen=normalize(JSON.parse(await f.text()));
      preview.textContent='登録予定：'+chosen.name+' ／ '+chosen.runner.age+'歳 ／ 装備反映後の7能力';
      say(auth?.currentUser?'「この馬を公式VSに登録する」を押してください。':'ログインしてから登録してください。');
    }catch(err){say('読み込めません：'+String(err.message||err));}
    updateSubmit();
  });
  submit.addEventListener('click',async()=>{
    if(!ready||!chosen||!auth.currentUser||busy)return;
    busy=true;updateSubmit();say('Firebaseに登録情報を保存中…');
    try{
      const user=auth.currentUser;
      const payload={ownerUid:user.uid,horseId:chosen.horseId,horseName:chosen.name,
        roster:chosen.runner,updatedAt:sdk.serverTimestamp()};
      await sdk.setDoc(sdk.doc(db,'vs_entries',user.uid),payload);
      // Server-confirmed write, then read to verify the saved horse.
      const result=await sdk.getDocFromServer(sdk.doc(db,'vs_entries',user.uid));
      if(!result.exists()||result.data().horseId!==chosen.horseId)
        throw Error('登録情報を読み戻せませんでした。');
      say('登録完了：'+chosen.name+'。1回出走すると登録が解除されます。再出走するにはもう一度登録してください。');
      preview.textContent='※ 1登録1出走・最大18頭。同じ馬が同じGⅠに出走できるのは日本時間で1日1回まで。';
      await updateOwnFromDocument(user,result.data());
    }catch(err){say('登録に失敗：'+String(err.code||err.message||err));}
    finally{busy=false;updateSubmit();}
  });
  window.VSEntry=Object.freeze({normalize});
  init().catch(err=>{
    ready=false;updateSubmit();say('Firebaseに接続できません：'+String(err.code||err.message||err));
  });
})();
