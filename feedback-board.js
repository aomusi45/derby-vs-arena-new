/* DERBY FANTASY VS ARENA - opinions and bug reports board V36.
   Public read. Posting/replying require the same Firebase Google sign-in as registration.
   All writes are server-authorized by the existing Cloudflare Worker; do NOT ship credentials. */
(()=>{
  'use strict';
  const $=id=>document.getElementById(id);
  const root=$('vs-feedback-panel');
  if(!root)return;
  const endpoint='https://derby-vs-registration.aomusi45.workers.dev';
  const list=$('dbf-feedback-list'),msg=$('dbf-feedback-message');
  const editor=$('dbf-feedback-editor'),form=/** @type {HTMLFormElement} */($('dbf-feedback-form'));
  const type=/** @type {HTMLSelectElement} */($('dbf-feedback-type'));
  const title=/** @type {HTMLInputElement} */($('dbf-feedback-title'));
  const body=/** @type {HTMLTextAreaElement} */($('dbf-feedback-body'));
  const show=/** @type {HTMLButtonElement} */($('dbf-feedback-open')),cancel=$('dbf-feedback-cancel');
  const refresh=/** @type {HTMLButtonElement} */($('dbf-feedback-refresh'));
  const more=/** @type {HTMLButtonElement} */($('dbf-feedback-more'));
  const login=/** @type {HTMLButtonElement} */($('dbf-feedback-login'));
  const identity=$('dbf-feedback-auth');
  if(!list||!form||!msg||!login||!more)return;
  let auth=null,authSdk=null,currentUser=null,posts=[],pageToken=null,loading=false,posting=false;
  let lastRequest=0,queuedReset=false,authInitBusy=false,authInitError='';
  const REQUEST_TIMEOUT_MS=12000;
  function limited(promise,ms,message){
    let timer;
    return Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error(message)),ms);
    })]).finally(()=>clearTimeout(timer));
  }
  const say=(value,error=false)=>{msg.textContent=value;msg.style.color=error?'#ffc5b8':'#d9e8d6';};
  const googleUser=()=>{
    const user=auth?.currentUser||currentUser;
    return user&&!user.isAnonymous&&
      user.providerData?.some(p=>p.providerId==='google.com')?user:null;
  };
  const node=(tag,klass,content)=>{
    const el=document.createElement(tag);
    if(klass)el.className=klass;
    if(content!==undefined)el.textContent=String(content);
    return el;
  };
  async function request(path,method='GET',data){
    const isPublicList=method==='GET'&&path.startsWith('/board/list');
    const user=googleUser();
    if(!isPublicList&&!user)throw Error('投稿・返信にはGoogleログインが必要です。');
    const headers=new Headers();
    if(user){
      try{
        const token=await limited(user.getIdToken(),7000,
          'Google認証が時間切れです。再ログインしてお試しください。');
        headers.set('Authorization','Bearer '+token);
      }catch(err){
        // The public list must remain readable even if the auth token hangs.
        if(!isPublicList)throw err;
      }
    }
    if(data!==undefined)headers.set('Content-Type','application/json');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
    let res,payload;
    try{
      res=await fetch(endpoint+path,{method,headers,signal:controller.signal,
        ...(data!==undefined?{body:JSON.stringify(data)}:{}),cache:'no-store'});
      payload=await res.json();
    }catch(err){
      if(controller.signal.aborted)throw Error(method==='POST'
        ?'送信の確認が時間切れです。重複投稿を避けるため一覧を更新してご確認ください。'
        :'掲示板の通信が時間切れです。「投稿を更新」で再試行できます。');
      throw Error('掲示板サーバーに接続できません。通信環境またはCloudflareの公開状態を確認してください。');
    }finally{clearTimeout(timer);}
    if(!res.ok||payload?.ok===false)
      throw Error(String(payload?.error||'通信エラー（HTTP '+res.status+'）'));
    return payload;
  }
  function controls(){
    const ok=!!googleUser();
    identity.textContent=ok?'Googleログイン済み：投稿・返信できます':
      authInitBusy?'Googleログイン機能を準備中です。投稿内容は先に入力できます。':
      authInitError?'Googleログインの準備に失敗しました。下のログインボタンで再試行してください。':
      '閲覧・投稿内容の入力はできます。送信にはGoogleログインが必要です。';
    login.hidden=ok;
    // Never prevent the editor from opening just because Firebase is still loading.
    show.disabled=posting;
    const send=/** @type {HTMLButtonElement} */(form.querySelector('button[type="submit"]'));
    send.disabled=posting;
    send.title=ok?'': '送信するには「Googleでログインして投稿」を押してください';
  }
  function button(label,action,cls='dbf-feedback-small'){
    const b=node('button',cls,label);b.type='button';b.addEventListener('click',action);return b;
  }
  function date(iso){
    const d=new Date(iso||'');
    return Number.isNaN(d.getTime())?'日時未記録':new Intl.DateTimeFormat('ja-JP',{
      timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit'}).format(d);
  }
  function statusLabel(s){
    return ['受付済み','確認中','対応予定','修正済み'].includes(s)?s:'受付済み';
  }
  async function applyAction(path,data,okText){
    if(!googleUser()){say('Googleログインしてください。',true);return;}
    try{
      await request(path,'POST',data);
      say(okText);await load(true);
    }catch(e){say(String(e.message||e),true);}
  }
  function replyForm(post,container){
    const f=node('form','dbf-feedback-reply-form');
    const ta=node('textarea');ta.placeholder='返信を入力してください（500文字以内）';
    ta.required=true;ta.maxLength=500;ta.rows=3;
    const b=node('button','vs-action-btn','返信する');b.type='submit';
    f.append(ta,b);
    f.addEventListener('submit',async e=>{
      e.preventDefault();
      if(!googleUser())return say('Googleログインしてください。',true);
      const message=ta.value.trim();if(!message||[...message].length>500)return;
      b.disabled=true;
      try{
        await request('/board/reply','POST',{postId:post.id,body:message});
        await load(true);say('返信を投稿しました。');
      }catch(err){say(String(err.message||err),true);b.disabled=false;}
    });
    container.append(f);
  }
  function render(){
    list.replaceChildren();
    if(!posts.length){list.append(node('p','small','まだ投稿はありません。最初のご意見・不具合報告をお待ちしています。'));}
    for(const post of posts){
      const item=node('article','dbf-feedback-item');
      const header=node('div','dbf-feedback-post-header');
      const category=node('span','dbf-feedback-category',post.type==='bug'?'不具合報告':'ご意見・要望');
      const st=node('span','dbf-feedback-status',statusLabel(post.status));
      header.append(category,st);
      const h=node('h3','dbf-feedback-post-title',post.deleted?'削除された投稿':post.title);
      const meta=node('p','dbf-feedback-post-meta',String(post.ownerName||'テスター')+' ・ '+date(post.createdAt));
      const text=node('p','dbf-feedback-post-body',post.deleted?'この投稿は削除されました。':post.body);
      item.append(header,h,meta,text);
      const action=node('div','dbf-feedback-actions');
      if(!post.deleted&&googleUser()){
        action.append(button('返信する',()=>{
          const existing=item.querySelector('.dbf-feedback-reply-form');
          if(existing){existing.remove();return;}
          replyForm(post,item);
        }));
      }
      if(!post.deleted&&post.canDelete){
        action.append(button('投稿を削除',()=>{
          if(window.confirm('この投稿を削除しますか？'))applyAction('/board/delete',{postId:post.id},'投稿を削除しました。');
        }));
      }
      if(post.canModerate&&!post.deleted){
        const select=node('select','dbf-feedback-moderation');
        ['受付済み','確認中','対応予定','修正済み'].forEach(s=>{
          const o=node('option',null,s);o.value=s;o.selected=s===post.status;select.append(o);
        });
        select.setAttribute('aria-label','運営向け：対応状況');
        select.addEventListener('change',()=>applyAction('/board/status',{
          postId:post.id,status:select.value},'対応状況を変更しました。'));
        action.append(select);
      }
      if(action.childNodes.length)item.append(action);
      if(Array.isArray(post.replies)&&post.replies.length){
        const replies=node('div','dbf-feedback-replies');
        const heading=node('h4',null,'返信（最新'+post.replies.length+'件）');replies.append(heading);
        for(const reply of post.replies){
          const r=node('div','dbf-feedback-reply');
          r.append(node('p','dbf-feedback-post-meta',String(reply.ownerName||'テスター')+' ・ '+date(reply.createdAt)),
            node('p','dbf-feedback-post-body',reply.deleted?'この返信は削除されました。':reply.body));
          if(reply.canDelete&&!reply.deleted){
            r.append(button('返信を削除',()=>{
              if(window.confirm('この返信を削除しますか？'))applyAction('/board/delete',{
                postId:post.id,replyId:reply.id},'返信を削除しました。');
            }));
          }
          replies.append(r);
        }
        item.append(replies);
      }
      list.append(item);
    }
    more.hidden=!pageToken;
    controls();
  }
  async function load(reset=false){
    if(loading){if(reset)queuedReset=true;return;}
    loading=true;refresh.disabled=true;more.disabled=true;
    const seq=++lastRequest;
    try{
      const token=reset?'':pageToken||'';
      const data=await request('/board/list'+(token?'?pageToken='+encodeURIComponent(token):''));
      if(seq!==lastRequest)return;
      if(reset)posts=[];
      posts.push(...(Array.isArray(data.posts)?data.posts:[]));
      pageToken=typeof data.nextPageToken==='string'&&data.nextPageToken?data.nextPageToken:null;
      render();say('投稿を表示しています。');
    }catch(err){say(String(err.message||err),true);
      if(reset&&!posts.length)list.textContent='掲示板を読み込めません。「投稿を更新」で再試行できます。';
    }finally{
      loading=false;refresh.disabled=false;more.disabled=false;
      if(queuedReset){queuedReset=false;load(true);}
    }
  }
  show.addEventListener('click',()=>{
    editor.hidden=false;show.hidden=true;title.focus();
    if(!googleUser())say('投稿内容を入力できます。送信するにはGoogleログインしてください。');
  });
  cancel.addEventListener('click',()=>{editor.hidden=true;show.hidden=false;form.reset();});
  refresh.addEventListener('click',()=>load(true));
  more.addEventListener('click',()=>load(false));
  // Independent board sign-in; a stuck auth initializer may be retried by the user.
  login.addEventListener('click',async()=>{
    if(googleUser())return;
    login.disabled=true;
    try{
      if(!auth||!authSdk)await initAuth();
      if(!auth||!authSdk){
        say('ログイン機能の準備ができません。通信を確認し、もう一度ログインボタンを押してください。',true);
        return;
      }
      const provider=new authSdk.GoogleAuthProvider();
      provider.setCustomParameters({prompt:'select_account'});
      const result=await limited(authSdk.signInWithPopup(auth,provider),30000,
        'Googleログインが時間切れです。ポップアップの状態を確認してください。');
      currentUser=result?.user||auth.currentUser||currentUser;
      controls();say('Googleログインしました。「新しく投稿する」から投稿できます。');
    }catch(err){
      const code=String(err?.code||'unknown');
      const hints={
        'auth/popup-blocked':'Googleログインのポップアップを許可してください。',
        'auth/popup-closed-by-user':'Googleログインがキャンセルされました。',
        'auth/unauthorized-domain':'Firebaseで aomusi45.github.io を承認済みドメインに登録してください。',
        'auth/operation-not-allowed':'FirebaseでGoogleログインを有効にしてください。',
        'auth/network-request-failed':'通信状況を確認して再試行してください。'
      };
      say('ログインできません：'+(hints[code]||String(err?.message||'再試行してください。'))+' ['+code+']',true);
    }finally{login.disabled=false;controls();}
  });
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    if(!googleUser())return say('Googleログインしてください。',true);
    const t=title.value.trim(),b=body.value.trim();
    if(!t||[...t].length>80||!b||[...b].length>2000){
      say('件名は80文字、本文は2000文字以内で入力してください。',true);return;
    }
    posting=true;controls();
    try{
      await request('/board/create','POST',{type:type.value,title:t,body:b});
      editor.hidden=true;show.hidden=false;form.reset();
      await load(true);say('投稿しました。ありがとうございます。');
    }catch(err){say(String(err.message||err),true);}
    finally{posting=false;controls();}
  });
  async function initAuth(){
    if(authInitBusy)return;
    if(auth&&authSdk)return;
    authInitBusy=true;authInitError='';controls();
    const cfg=/** @type {any} */(window).VS_FIREBASE_CONFIG;
    try{
      if(!cfg||cfg.projectId!=='derby-vs-arena'||!cfg.apiKey)
        throw Error('Firebase公開設定を読み込めません。firebase-config.js を確認してください。');
      const base='https://www.gstatic.com/firebasejs/13.2.0/';
      const [appSdk,moduleAuth]=await limited(Promise.all([
        import(base+'firebase-app.js'),import(base+'firebase-auth.js')]),
        12000,'Firebaseログインの読み込みが時間切れです。通信を確認して再試行してください。');
      const app=appSdk.getApps().find(a=>a.options.projectId===cfg.projectId)||
        appSdk.initializeApp(cfg,'vs-arena-registration');
      authSdk=moduleAuth;
      auth=authSdk.getAuth(app);
      let firstChangeDone;
      const firstChange=new Promise(resolve=>{firstChangeDone=resolve;});
      authSdk.onAuthStateChanged(auth,user=>{
        currentUser=user;authInitError='';controls();load(true);firstChangeDone();
      },err=>{
        authInitError='Googleログインの状態を確認できません：'+String(err?.code||err?.message||err);
        say(authInitError,true);controls();firstChangeDone();
      });
      await limited(firstChange,9000,'Googleログインの状態確認が時間切れです。ログインボタンで再試行してください。');
    }catch(err){
      authInitError=String(err?.message||err);
      say(authInitError,true);
    }finally{authInitBusy=false;controls();}
  }
  controls();load(true);initAuth();
})();
