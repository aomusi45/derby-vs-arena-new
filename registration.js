/* Firebase VS horse registration. UI code is isolated from the race viewer.
   Login may be Google or anonymous; one account has one immutable active horse.
   The website NEVER receives or stores service-account credentials. */
(()=>{
  'use strict';
  const $=id=>document.getElementById(id);
  const file=$('vs-entry-file'),submit=$('vs-entry-submit'),message=$('vs-entry-message');
  const preview=$('vs-entry-preview'),loginStatus=$('vs-entry-login-status');
  const google=$('vs-entry-google'),guest=$('vs-entry-guest');
  const ownerInput=$('vs-entry-ownername'),ownerHint=$('vs-entry-owner-status');
  if(!file||!submit||!message||!preview||!loginStatus||!google||!guest||!ownerInput)return;
  const cleanOwner=value=>typeof value==='string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g,'') : '';
  const validOwner=value=>value.length>=1 && [...value].length<=24 && !/[\u0000-\u001f\u007f]/.test(value);
  const cfg=window.VS_FIREBASE_CONFIG;
  let auth=null,db=null, sdk=null,chosen=null,busy=false,ready=false;
  let selectionSerial=0;
  let reservedOwnerName='',profileLoaded=false;
  // Enter your deployed Worker URL here. This URL is public; never put the private key here.
  const SECURE_REGISTER_URL='https://derby-vs-registration.aomusi45.workers.dev';
  const workerReady=()=>/^https:\/\/[^\s/]+\/?.*$/i.test(SECURE_REGISTER_URL) && !SECURE_REGISTER_URL.includes('SET_YOUR_');
  const say=s=>{message.textContent=s;};

  // Public racing calendar and privacy-safe registration counts.
  // The Firestore "vs_entries" collection is intentionally NOT listable from
  // browsers; its aggregate is published by the existing server recording job.
  const SLOT_MS=15*60*1000;
  const REGISTRATION_OPEN_MS=8*60*1000; // Close seven minutes before the next heat.
  const acceptingNow=()=>Date.now()%SLOT_MS<REGISTRATION_OPEN_MS;
  const registrationForm=$('vs-entry-form'),persisted=$('vs-entry-persisted');
  const nextRaceName=$('vs-next-race-name');
  const nextRaceDetail=$('vs-next-race-detail');
  const nextRaceCountdown=$('vs-next-race-countdown');
  const totalLabel=$('vs-entry-total');
  const entryRace=$('vs-entry-race-name');
  const entryRoster=$('vs-entry-roster');
  const entryDeadline=$('vs-entry-deadline');
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
  function renderEntryRoster(rows){
    if(!entryRoster)return;
    entryRoster.replaceChildren();
    if(!rows?.length){entryRoster.textContent='登録済み馬はありません（または集計待ちです）。';return;}
    const head=document.createElement('div');head.className='vs-entry-row vs-entry-row-head';
    for(const label of ['馬名','オーナー名']){const cell=document.createElement('span');cell.textContent=label;head.append(cell);}
    entryRoster.append(head);
    for(const row of rows){
      const item=document.createElement('div');item.className='vs-entry-row';
      for(const value of [row.horseName,row.ownerName||'未設定']){
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
    if(registrationForm)registrationForm.hidden=!card||!acceptingNow()||!!ownRegistration;
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
    let displayed=publishedRows?publishedRows.map(row=>({horseName:row.horseName,ownerName:row.ownerName})):[];
    const local=localConfirmed?.slot===slot&&localConfirmed?.uid===auth?.currentUser?.uid
      ?localConfirmed:null;
    if(local){
      const existing=displayed.findIndex(row=>row.ownerName===local.ownerName);
      const ownRow={horseName:local.horseName,ownerName:local.ownerName};
      if(existing>=0)displayed[existing]=ownRow;
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
        rows.push({ownerName:d.ownerName,horseName:d.horseName,slot:assignedSlot(d.updatedAt)});
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
  async function updateOwnFromDocument(user,docData){
    if(auth?.currentUser?.uid!==user.uid)return;
    ownRegistration=docData;ownRegistrationId=null;
    if(docData?.horseName)lastRegistrationName=String(docData.horseName);
    localConfirmed=docData?{slot:assignedSlot(docData.updatedAt),uid:user.uid,horseName:String(docData.horseName||''),ownerName:String(docData.ownerName||'')}:null;
    if(docData?.ownerName && !reservedOwnerName && !ownerInput.value)ownerInput.value=cleanOwner(docData.ownerName);
    updateSubmit();renderPublicStatus();
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
  const updateSubmit=()=>{
    submit.textContent=ownRegistration ? '登録済み（変更不可）' : 'この馬を公式VSに登録する';
    submit.disabled=busy||!ready||!profileLoaded||!workerReady()||!!ownRegistration||!acceptingNow()||
    !chosen||!auth?.currentUser||
    (!chosen.sealed&&!validOwner(cleanOwner(ownerInput.value)));};
  ownerInput.addEventListener('input',updateSubmit);
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
    // Live Firestore listener: other devices update as soon as the mirror changes.
    fsSdk.onSnapshot(fsSdk.collection(db,'vs_public_entries'),
      snapshot=>{try{applySharedSnapshot(snapshot);}catch(err){console.warn(err);}},
      err=>{sharedEntriesError=String(err.code||err.message||err);console.warn('公開一覧の監視に失敗',err);});
    refreshSharedEntries();
    authSdk.onAuthStateChanged(auth,async user=>{
      ownRegistration=null;ownRegistrationId=null;localConfirmed=null;
      reservedOwnerName='';profileLoaded=false;
      ownerInput.readOnly=false;
      if(ownerHint)ownerHint.textContent='ログインするとオーナー名の取得状況を確認します。';
      updateSubmit();renderPublicStatus();
      if(!user){
        loginStatus.textContent='未ログイン';
        say('Googleまたはゲストでログインして馬を登録してください。');
        return;
      }
      loginStatus.textContent=(user.isAnonymous?'ゲスト':'ログイン中')+'：登録可能';
      try{
        // Unlike vs_entries, this profile survives after a horse has raced.
        const profile=await fsSdk.getDocFromServer(fsSdk.doc(db,'vs_owner_profiles',user.uid));
        if(auth?.currentUser?.uid!==user.uid)return;
        if(profile.exists()){
          reservedOwnerName=cleanOwner(profile.data().ownerName);
          if(!validOwner(reservedOwnerName))throw Error('保存済みのオーナー名が不正です');
          ownerInput.value=reservedOwnerName;
          ownerInput.readOnly=true;
          if(ownerHint)ownerHint.textContent='取得済みの専用オーナー名です。出走後も保持され、変更できません。';
        }else{
          ownerInput.readOnly=false;
          if(ownerHint)ownerHint.textContent='最初の登録でオーナー名を取得します。ほかのユーザーと同じ名前は使えません。';
        }
        profileLoaded=true;updateSubmit();
        const snap=await fsSdk.getDocFromServer(fsSdk.doc(db,'vs_entries',user.uid));
        if(auth.currentUser?.uid!==user.uid)return;
        if(snap.exists()){
          say('現在の登録馬：'+String(snap.data().horseName||'不明')+'。1回出走後に登録解除されます。');
          if(snap.data().ownerName && !reservedOwnerName && !ownerInput.value)
            ownerInput.value=cleanOwner(snap.data().ownerName);
          await updateOwnFromDocument(user,snap.data());
        }else{
          say(acceptingNow()?'登録受付中。ゲームのVS登録馬ファイルを選んでください。':'現在は受付時間外です。次の受付開始までお待ちください。');
        }
      }catch(err){
        profileLoaded=false;updateSubmit();
        say('オーナー名・登録状態を確認できません：'+String(err.code||err.message||err));
      }
    });
    say('ログイン後、VS登録馬ファイルを選んで登録できます。');
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
  // New encrypted VS files: the browser cannot decrypt them, by design.
  // Only the private-key Worker can decrypt and persist the normalized roster.
  const SEALED_FORMAT='derby-fantasy-vs-sealed';
  const SEALED_KEY_ID='dbf-vs-20261110-k1';
  function validSealed(raw){
    return raw && raw.format===SEALED_FORMAT && raw.version===2 &&
      raw.keyId===SEALED_KEY_ID && raw.keyWrap==='RSA-OAEP-SHA256' &&
      raw.cipher==='AES-256-GCM' &&
      typeof raw.wrappedKey==='string' && raw.wrappedKey.length<1024 &&
      typeof raw.iv==='string' && raw.iv.length<80 &&
      typeof raw.data==='string' && raw.data.length<1600000;
  }
  function applyParsedHorse(data,serial){
    if(serial!==selectionSerial)return;
    chosen=normalize(data);
    if(reservedOwnerName)ownerInput.value=reservedOwnerName;
    else if(chosen.jsonOwner)ownerInput.value=chosen.jsonOwner;
    else if(!ownerInput.value && auth?.currentUser?.displayName){
      const publicName=cleanOwner(auth.currentUser.displayName);
      if(validOwner(publicName))ownerInput.value=publicName;
    }
    preview.textContent='登録予定：'+chosen.name+' ／ '+chosen.runner.age+'歳 ／ 装備反映後の7能力';
    say(ownRegistration ? '登録済みの馬は変更できません。出走完了まで登録は固定です。' :
      (auth?.currentUser?'「この馬を公式VSに登録する」を押してください。':'ログインしてから登録してください。'));
    updateSubmit();
  }
  file.addEventListener('change',async()=>{
    const serial=++selectionSerial;
    chosen=null; preview.textContent=''; updateSubmit();
    const f=file.files?.[0];if(!f)return;
    if(f.size>1048576||f.size===0||!(/\.(json|dbfvs)$/i.test(f.name))){
      say('1MB以下の .dbfvs または .json を選択してください。');return;
    }
    try{
      const raw=await f.text();
      if(serial!==selectionSerial)return;
      const parsed=JSON.parse(raw);
      if(/\.dbfvs$/i.test(f.name)){
        if(!validSealed(parsed))throw Error('旧式または非対応の .dbfvs です。新しいDBFゲームから書き出し直してください。');
        chosen={sealed:true,envelope:parsed};
        preview.textContent='自動暗号化VS馬：'+f.name+'（馬名・能力は登録サーバーで確認）';
        say(workerReady()?'パスワード不要です。「この馬を公式VSに登録する」を押してください。':
          '管理者による暗号化登録サーバーの設定がまだ終わっていません。');
      }else{
        if(parsed?.format===SEALED_FORMAT || parsed?.format==='derby-fantasy-vs-locked')
          throw Error('暗号化馬は .dbfvs ファイルを選択してください。');
        applyParsedHorse(parsed,serial);
      }
    }catch(err){if(serial===selectionSerial)say('読み込めません：'+String(err.message||err));}
    updateSubmit();
  });
  submit.addEventListener('click',async()=>{
    if(!ready||!chosen||!auth.currentUser||busy||ownRegistration)return;
    if(!acceptingNow()){say('受付時間外のため登録できません。');renderPublicStatus();return;}
    const ownerName=cleanOwner(ownerInput.value);
    if(ownerName&&!validOwner(ownerName)){say('公開するオーナー名は1〜24文字にしてください。');return;}
    if(!chosen.sealed&&!validOwner(ownerName)){say('公開するオーナー名を1〜24文字で入力してください。');return;}
    busy=true;updateSubmit();say('公式VS登録処理中…');
    try{
      const user=auth.currentUser;
      let horseName,horseId,publicOwner;
      if(!workerReady())throw Error('公式登録サーバーの設定が必要です。');
      if(ownRegistration)throw Error('登録済みの馬は出走まで変更できません。');
      if(!acceptingNow())throw Error('受付時間外のため登録できません。');
      // Registration is immutable until a published, completed race consumes it.
      const existingSnap=await sdk.getDocFromServer(sdk.doc(db,'vs_entries',user.uid));
      if(existingSnap.exists()){
        const oldHorse=String(existingSnap.data().horseName||'登録済み馬');
        throw Error('「'+oldHorse+'」は登録済みです。出走まで差し替え・再登録できません。');
      }
      const token=await sdk.getIdToken(user);
      // All registration paths now use the server's atomic owner-name claim.
      // Never send a password or private key to the server.
      const response=await fetch(SECURE_REGISTER_URL.replace(/\/+$/,'')+
        (chosen.sealed?'/register':'/register-json'),{
        method:'POST',mode:'cors',cache:'no-store',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
        body:JSON.stringify(chosen.sealed?
          {envelope:chosen.envelope,ownerName}:
          {snapshot:chosen.originalSnapshot,ownerName})
      });
      let result;
      try{result=await response.json();}
      catch(_){throw Error('登録サーバーからの応答が不正です。');}
      if(!response.ok||!result.ok){
        const errorTag=typeof result.code==='string' ? ' ['+result.code+']' : '';
        throw Error((result.error||'登録に失敗しました。')+errorTag);
      }
      horseName=result.horseName;horseId=result.horseId;publicOwner=result.ownerName;
      // Verify what Firestore actually committed, never claim success early.
      const stored=await sdk.getDocFromServer(sdk.doc(db,'vs_entries',user.uid));
      if(!stored.exists()||stored.data().horseId!==horseId)
        throw Error('登録情報を読み戻せませんでした。');
      reservedOwnerName=publicOwner;
      profileLoaded=true;ownerInput.value=publicOwner;ownerInput.readOnly=true;
      if(ownerHint)ownerHint.textContent='専用オーナー名として取得済み。出走後も保存されます。';
      say('登録完了：'+horseName+'（オーナー：'+publicOwner+'）。このオーナー名は本人専用です。1回出走すると馬の登録だけ解除されます。');
      preview.textContent='※ 1登録1出走・登録後の変更不可・同じ馬の通算出走上限20回。';
      localConfirmed={slot:nextSlot(),uid:user.uid,horseName:String(stored.data().horseName||horseName),
        ownerName:String(stored.data().ownerName||publicOwner)};
      await updateOwnFromDocument(user,stored.data());
      await refreshSharedEntries();
      renderPublicStatus();
    }catch(err){say('登録に失敗：'+String(err.code||err.message||err));}
    finally{busy=false;updateSubmit();}
  });
  window.VSEntry=Object.freeze({normalize});
  init().catch(err=>{
    ready=false;updateSubmit();say('Firebaseに接続できません：'+String(err.code||err.message||err));
  });
})();
