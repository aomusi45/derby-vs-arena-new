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
    auth=authSdk.getAuth(app);db=fsSdk.getFirestore(app);ready=true;
    authSdk.onAuthStateChanged(auth,async user=>{
      updateSubmit();
      if(!user){loginStatus.textContent='未ログイン';say('Googleまたはゲストでログインして馬を登録してください。');return;}
      loginStatus.textContent=(user.isAnonymous?'ゲスト':'ログイン中')+'：登録可能';
      try{
        const snap=await fsSdk.getDoc(fsSdk.doc(db,'vs_entries',user.uid));
        if(snap.exists())say('現在の登録馬：'+String(snap.data().horseName||'不明')+'。別の馬で上書き登録できます。');
        else say('登録受付中。ゲームの対戦馬JSONを選んでください。');
      }catch(err){say('登録状態を確認できません：'+String(err.code||err.message||err));}
    });
    say('ログイン後、対戦馬JSONを選んで登録できます。');
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
      say('登録完了：'+chosen.name+'。次回以降のGⅠで出走抽選の対象になります。');
      preview.textContent='※ 1レース1組・最大18頭。同じ馬が同じGⅠに出走できるのは日本時間で1日1回まで。';
    }catch(err){say('登録に失敗：'+String(err.code||err.message||err));}
    finally{busy=false;updateSubmit();}
  });
  window.VSEntry=Object.freeze({normalize});
  init().catch(err=>{
    ready=false;updateSubmit();say('Firebaseに接続できません：'+String(err.code||err.message||err));
  });
})();
