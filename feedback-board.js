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
  let lastRequest=0,queuedReset=false;
  const say=(value,error=false)=>{msg.textContent=value;msg.style.color=error?'#ffc5b8':'#d9e8d6';};
  const googleUser=()=>currentUser&&!currentUser.isAnonymous&&
    currentUser.providerData?.some(p=>p.providerId==='google.com')?currentUser:null;
  const node=(tag,klass,content)=>{
    const el=document.createElement(tag);
    if(klass)el.className=klass;
    if(content!==undefined)el.textContent=String(content);
    return el;
  };
  async function request(path,method='GET',data){
    const user=googleUser();
    const headers=new Headers();
    if(user)headers.set('Authorization','Bearer '+await user.getIdToken());
    if(data!==undefined)headers.set('Content-Type','application/json');
    let res;
    try{res=await fetch(endpoint+path,{method,headers,
      ...(data!==undefined?{body:JSON.stringify(data)}:{}),cache:'no-store'});}
    catch(_){throw Error('掲示板サーバーに接続できません');}
    let payload;
    try{payload=await res.json();}catch(_){throw Error('掲示板サーバーの応答が不正です');}
    if(!res.ok||payload.ok===false)throw Error(String(payload.error||'通信エラー（'+res.status+'）'));
    return payload;
  }
  function controls(){
    const ok=!!googleUser();
    identity.textContent=ok?'Googleログイン済み：投稿・返信できます':'閲覧は誰でも可能です。投稿・返信にはGoogleログインが必要です。';
    login.hidden=ok;
    show.disabled=!ok;
    const send=/** @type {HTMLButtonElement} */(form.querySelector('button[type="submit"]'));
    send.disabled=!ok||posting;
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
        say('返信を投稿しました。');await load(true);
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
      if(reset&&!posts.length)list.textContent='掲示板を読み込めません。';
    }finally{
      loading=false;refresh.disabled=false;more.disabled=false;
      if(queuedReset){queuedReset=false;load(true);}
    }
  }
  show.addEventListener('click',()=>{editor.hidden=false;show.hidden=true;title.focus();});
  cancel.addEventListener('click',()=>{editor.hidden=true;show.hidden=false;form.reset();});
  refresh.addEventListener('click',()=>load(true));
  more.addEventListener('click',()=>load(false));
  // The board can sign in directly, even if the horse-registration UI has
  // not initialized. Both UIs reuse the same named Firebase app/auth session.
  login.addEventListener('click',async()=>{
    if(googleUser())return;
    if(!auth||!authSdk){
      say('Googleログインの準備ができません。ページを再読み込みしてください。',true);return;
    }
    login.disabled=true;
    try{
      const provider=new authSdk.GoogleAuthProvider();
      provider.setCustomParameters({prompt:'select_account'});
      await authSdk.signInWithPopup(auth,provider);
      say('Googleログインしました。新しく投稿するボタンから投稿できます。');
    }catch(err){
      const code=String(err?.code||'unknown');
      const hints={
        'auth/popup-blocked':'Googleログインのポップアップを許可してください。',
        'auth/popup-closed-by-user':'Googleログインがキャンセルされました。',
        'auth/unauthorized-domain':'Firebaseで aomusi45.github.io を承認済みドメインに登録してください。',
        'auth/operation-not-allowed':'FirebaseでGoogleログインを有効にしてください。',
        'auth/network-request-failed':'通信状況を確認して再試行してください。'
      };
      say('ログインできません：'+(hints[code]||'もう一度お試しください。')+' ['+code+']',true);
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
      say('投稿しました。ありがとうございます。');await load(true);
    }catch(err){say(String(err.message||err),true);}
    finally{posting=false;controls();}
  });
  async function initAuth(){
    const cfg=/** @type {any} */(window).VS_FIREBASE_CONFIG;
    if(!cfg||cfg.projectId!=='derby-vs-arena'||!cfg.apiKey){
      say('Firebase公開設定を読み込めません。掲示板からログインできません。',true);return;
    }
    try{
      const base='https://www.gstatic.com/firebasejs/13.2.0/';
      const [appSdk,moduleAuth]=await Promise.all([
        import(base+'firebase-app.js'),import(base+'firebase-auth.js')]);
      const app=appSdk.getApps().find(a=>a.options.projectId===cfg.projectId)||
        appSdk.initializeApp(cfg,'vs-arena-registration');
      authSdk=moduleAuth;
      auth=authSdk.getAuth(app);
      authSdk.onAuthStateChanged(auth,user=>{
        currentUser=user;controls();load(true);
      });
    }catch(err){
      console.warn('掲示板：ログイン状態を確認できません',err);
      say('Googleログインの初期化に失敗しました：'+String(err?.code||err?.message||err),true);
    }
  }
  controls();load(true);initAuth();
})();
