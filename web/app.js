/* Spare — web app (also bundled into the Android app). */
'use strict';
const LSK='spare-budget-state-v1',LANGK='spare-lang';

/* ---------- language ---------- */
const LOCALES={fr:'fr-BE',nl:'nl-BE',en:'en-GB'};
let LANG=(()=>{try{const l=localStorage.getItem(LANGK);if(LOCALES[l])return l}catch(e){}const n=String((typeof navigator!=='undefined'&&navigator.language)||'en').slice(0,2);return LOCALES[n]?n:'en'})();
function T(s,...a){const d=(window.SPARE_I18N||{})[LANG];let o=(d&&d[s])||s;a.forEach((v,i)=>{o=o.split('{'+i+'}').join(v)});return o}
const LANGNAME={fr:'Français',nl:'Nederlands',en:'English'};
const LANGPROMPT={fr:'French',nl:'Dutch',en:'English'};
function setLang(l){if(!LOCALES[l])return;LANG=l;try{localStorage.setItem(LANGK,l)}catch(e){}document.documentElement.lang=l;render();scheduleNotifs()}

/* ---------- helpers ---------- */
const CATS=[['groceries','Groceries','need'],['cat','Cat','need'],['household','Household','need'],['hygiene','Hygiene','need'],['snacks','Snacks & sweets','want'],['drinks','Drinks','want'],['eatout','Eating out','want'],['clothing','Clothing','want'],['tech','Tech & media','want'],['leisure','Leisure','want'],['other','Other','want']];
const CATKEYS=new Set(CATS.map(c=>c[0])),CATPREF=Object.fromEntries(CATS.map(c=>[c[0],c[2]]));
const catName=k=>T((CATS.find(c=>c[0]===k)||[k,k])[1]);
const FREQ=['m','q','y'],freqName=f=>({m:T('Monthly'),q:T('Every 3 months'),y:T('Yearly')})[f];
const uid=()=>Math.random().toString(36).slice(2,10);
const r2=n=>Math.round((+n||0)*100)/100;
const num=v=>{const x=parseFloat(String(v??'').replace(/\s/g,'').replace(',','.').replace(/[^\d.\-]/g,''));return isFinite(x)?x:0};
const EUR=new Intl.NumberFormat('fr-BE',{style:'currency',currency:'EUR'});
const fmt=n=>EUR.format(r2(n));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
const iso=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const today=()=>iso(new Date());
const mkey=ds=>String(ds||today()).slice(0,7);
const mname=(mk,short)=>new Date(mk+'-01T12:00:00').toLocaleDateString(LOCALES[LANG],short?{month:'short'}:{month:'long',year:'numeric'});
const dshort=ds=>new Date(ds+'T12:00:00').toLocaleDateString(LOCALES[LANG],{day:'numeric',month:'short'});
function daysLeft(){const d=new Date();return new Date(d.getFullYear(),d.getMonth()+1,0).getDate()-d.getDate()+1}
const dayDiff=(a,b)=>Math.round((new Date(a+'T12:00:00')-new Date(b+'T12:00:00'))/864e5);
function hash(s){let h=5381;for(let i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))|0;return(h>>>0).toString(36)}

/* ---------- state ---------- */
function defaults(){return{v:2,updatedAt:0,setupDone:false,
 settings:{income:0,target:0,monthlyStep:10,tripStep:0.5,trips:8,foodShare:75,minCap:15,notif:{bills:true,weekly:true,alerts:true}},
 bills:[],entries:[],deleted:[],prefs:{},list:[],cur:{month:null,level:0,alerted:[]},months:{},tips:null,notice:null,flash:null,trophiesSeen:[]}}
function migrate(s){const d=defaults();if(s.setupDone===undefined)s.setupDone=(s.updatedAt||0)>0||(s.entries||[]).length>0||(s.bills||[]).length>0;
 for(const k in d)if(s[k]===undefined)s[k]=d[k];for(const k in d.settings)if(s.settings[k]===undefined)s.settings[k]=d.settings[k];
 if(!s.cur.alerted)s.cur.alerted=[];return s}

let S,sync='idle',pubT=null,notifT=null;
let ui={photos:[],queue:[],storeName:'',draft:null,busy:false,err:'',open:null,del:null,tipsBusy:false,tipsErr:'',copied:false,imp:false,bank:null,bankBusy:false,bankErr:'',q:''};

function load(){let loc=null;try{loc=JSON.parse(localStorage.getItem(LSK))}catch(e){}S=migrate(loc||defaults())}
function localSave(){try{localStorage.setItem(LSK,JSON.stringify(S))}catch(e){}}
function persist(){S.updatedAt=Date.now();localSave();schedulePush();clearTimeout(notifT);notifT=setTimeout(scheduleNotifs,1500)}

/* ---------- budget math ---------- */
const billMonthly=b=>b.freq==='q'?b.amount/3:b.freq==='y'?b.amount/12:b.amount;
const commit=()=>r2(S.bills.reduce((a,b)=>a+billMonthly(b),0));
const fixedOnly=()=>r2(S.bills.filter(b=>b.freq==='m').reduce((a,b)=>a+b.amount,0));
const targetFor=mk=>(S.months[mk]&&S.months[mk].target!=null)?S.months[mk].target:S.settings.target;
const entriesIn=mk=>S.entries.filter(e=>mkey(e.date)===mk);
const spentIn=mk=>r2(entriesIn(mk).reduce((a,e)=>a+e.total,0));
const savedFor=mk=>r2(S.settings.income-commit()-spentIn(mk));
const living=mk=>r2(S.settings.income-commit()-targetFor(mk));
function tripCap(){const st=S.settings,base=living(mkey())*st.foodShare/100/Math.max(1,st.trips);return r2(Math.max(st.minCap,base-S.cur.level*st.tripStep))}
const prefOf=(name,cat)=>S.prefs[norm(name)]||CATPREF[cat]||'want';

function rollover(){const mk=mkey();
 if(!S.cur.month){S.cur={month:mk,level:0,alerted:[]};S.months[mk]={target:S.settings.target};return}
 if(S.cur.month===mk){if(!S.months[mk])S.months[mk]={target:S.settings.target};return}
 const prev=S.cur.month,t=targetFor(prev),saved=savedFor(prev);
 if(saved>=t){S.settings.target=r2(S.settings.target+S.settings.monthlyStep);S.notice={k:'hit',m:prev,saved,t,n:S.settings.target,s:S.settings.monthlyStep}}
 else S.notice={k:'miss',m:prev,saved,t,n:S.settings.target};
 S.cur={month:mk,level:0,alerted:[]};S.months[mk]={target:S.settings.target};S.updatedAt=Date.now();localSave()}
function noticeText(n){if(!n)return'';if(typeof n==='string')return esc(n);
 return n.k==='hit'?T('{0}: you saved {1} (goal {2}). New goal: {3}, {4} more than last month.',mname(n.m),fmt(n.saved),fmt(n.t),fmt(n.n),fmt(n.s))
  :T('{0}: you saved {1}, short of your {2} goal. The goal stays at {3} this month.',mname(n.m),fmt(n.saved),fmt(n.t),fmt(n.n))}

function cutsFor(items,over){const w=items.filter(i=>i.pref==='want'&&i.price>0);
 const one=w.filter(i=>i.price>=over).sort((a,b)=>a.price-b.price)[0];if(one)return{cuts:[one],short:0};
 const g=[...w].sort((a,b)=>b.price-a.price),out=[];let s=0;for(const i of g){if(s>=over)break;out.push(i);s+=i.price}
 return{cuts:out,short:r2(Math.max(0,over-s))}}

/* ---------- prices ---------- */
const BRAND_RE=[['Colruyt',/colruyt/],['Okay',/\bokay\b/],['Bio-Planet',/bio.?planet/],['Delhaize',/delhaize/],['Aldi',/\baldi\b/],['Lidl',/\blidl\b/],['Carrefour',/carrefour/],['Albert Heijn',/albert heijn|\bah\b/],['Intermarché',/intermarche/],['Spar',/\bspar\b/],['Cora',/\bcora\b/],['Match',/\bs?match\b/],['Jumbo',/\bjumbo\b/],['Action',/\baction\b/],['Kruidvat',/kruidvat/],['Zooplus',/zooplus/],['Tom&Co',/tom ?& ?co/],['Maxi Zoo',/maxi ?zoo/],['Rewe',/\brewe\b/],['Edeka',/edeka/],['Amazon',/amazon/],['Bol.com',/bol\.com/]];
function storeOf(s){const n=norm(s);if(!n)return null;for(const [name,re] of BRAND_RE)if(re.test(n))return{key:norm(name),name};const w=String(s).trim().split(/\s+/)[0];return{key:norm(w),name:w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()}}
const prodKey=it=>norm(it.gen||it.name);
function priceIndex(){const idx={},alias={};
 for(const e of [...S.entries].sort((a,b)=>a.date<b.date?-1:1)){if(e.kind==='bank')continue;const st=storeOf(e.store);if(!st)continue;
  for(const it of e.items){if(!(it.price>0))continue;const k=prodKey(it);if(!k)continue;const unit=r2(it.price/(it.qty>0?it.qty:1));
   const p=idx[k]||(idx[k]={key:k,label:it.name,stores:{},n:0});p.n++;p.label=it.name;alias[norm(it.name)]=k;
   const s=p.stores[st.key]||(p.stores[st.key]={name:st.name,price:unit,date:e.date,n:0,min:unit});s.price=unit;s.date=e.date;s.min=Math.min(s.min,unit);s.n++}}
 for(const p of Object.values(idx)){const ss=Object.values(p.stores).sort((a,b)=>a.price-b.price);p.best=ss[0];p.sorted=ss;p.spread=ss.length>1?r2(ss[ss.length-1].price-ss[0].price):0}
 return{idx,alias}}
function findProd(PI,name){const n=norm(name);return PI.idx[PI.alias[n]]||PI.idx[n]||null}
function missedSavings(PI,mk){let t=0;for(const e of entriesIn(mk)){if(e.kind==='bank')continue;const st=storeOf(e.store);
 for(const it of e.items){const p=PI.idx[prodKey(it)];if(!p||!p.best||!st||p.best.name===st.name)continue;const unit=it.price/(it.qty>0?it.qty:1);if(unit>p.best.price)t+=(unit-p.best.price)*(it.qty||1)}}return r2(t)}

function planList(cap){const needs=S.list.filter(i=>i.pref==='need'),wants=S.list.filter(i=>i.pref!=='need');let cum=0;const res={};
 for(const i of [...needs,...wants]){const p=num(i.price);if(cum+p<=cap+1e-9){cum+=p;res[i.id]={fits:true,cum}}else res[i.id]={fits:false,short:r2(cum+p-cap)}}
 return{res,total:r2(cum),needsTotal:r2(needs.reduce((a,i)=>a+num(i.price),0)),all:r2(S.list.reduce((a,i)=>a+num(i.price),0))}}

/* ---------- bills: due dates ---------- */
function nextDue(b){if(!b.due)return null;let d=new Date(b.due+'T12:00:00');const t=new Date(today()+'T12:00:00'),step=b.freq==='q'?3:b.freq==='y'?12:1;let g=0;while(d<t&&g++<400)d.setMonth(d.getMonth()+step);return iso(d)}
function upcoming(days=14){return S.bills.map(b=>({b,d:nextDue(b)})).filter(x=>x.d&&dayDiff(x.d,today())<=days).sort((a,b)=>a.d<b.d?-1:1)}

/* ---------- notifications (Android app) ---------- */
const LN=()=>{try{return window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.LocalNotifications||null}catch(e){return null}};
let notifPerm=null;
async function notifAllowed(ask){const ln=LN();if(!ln)return false;try{let p=await ln.checkPermissions();if(p.display!=='granted'&&ask)p=await ln.requestPermissions();notifPerm=p.display;return p.display==='granted'}catch(e){return false}}
async function scheduleNotifs(){const ln=LN();if(!ln||!AUTH.token||!S.setupDone)return;if(!(await notifAllowed(false)))return;
 try{const p=await ln.getPending();if(p.notifications.length)await ln.cancel({notifications:p.notifications.map(n=>({id:n.id}))})}catch(e){}
 const n=S.settings.notif||{},list=[],now=new Date();
 if(n.bills)S.bills.forEach((b,i)=>{const d=nextDue(b);if(!d)return;const at=new Date(d+'T10:00:00');at.setDate(at.getDate()-3);if(at>now)list.push({id:1000+i,title:T('{0} in 3 days',b.name),body:T('About {0} will leave your account on {1}.',fmt(b.amount),dshort(d)),schedule:{at,allowWhileIdle:true}})});
 const mk=mkey(),left=r2(living(mk)-spentIn(mk));
 if(n.weekly){const at=new Date();at.setDate(at.getDate()+((7-at.getDay())%7));at.setHours(18,0,0,0);if(at<=now)at.setDate(at.getDate()+7);
  const wk=S.entries.filter(e=>dayDiff(today(),e.date)<7&&dayDiff(today(),e.date)>=0).reduce((a,e)=>a+e.total,0);
  list.push({id:2001,title:T('Your week with Spare'),body:T('Spent this week: {0}. Left this month: {1}.',fmt(wk),fmt(left)),schedule:{at,allowWhileIdle:true}})}
 if(n.weekly){const at=new Date(now.getFullYear(),now.getMonth()+1,0,19,0,0);if(at>now)list.push({id:2002,title:T('Last day of the month'),body:left>=0?T('You\'re on track to save {0}. Hold on until tomorrow!',fmt(targetFor(mk)+left)):T('You\'re {0} over this month. Tomorrow is a fresh start.',fmt(-left)),schedule:{at,allowWhileIdle:true}})}
 if(list.length)try{await ln.schedule({notifications:list.map(x=>({...x,smallIcon:'ic_stat_spare',iconColor:'#f5bf3c'}))})}catch(e){}}
function checkAlerts(){const mk=mkey(),liv=living(mk),sp=spentIn(mk);if(!(liv>0)||!(S.settings.notif||{}).alerts)return null;const pct=sp/liv*100;let hit=null;
 for(const lvl of [100,80])if(pct>=lvl&&!S.cur.alerted.includes(lvl)){hit=lvl;break}
 if(hit==null)return null;S.cur.alerted.push(hit);if(hit===100&&!S.cur.alerted.includes(80))S.cur.alerted.push(80);
 const title=hit===100?T('Monthly budget used up'):T('80% of your monthly budget used'),body=hit===100?T('You\'ve spent {0} of {1}. Every extra euro now comes out of your savings.',fmt(sp),fmt(liv)):T('{0} left for {1} days.',fmt(liv-sp),daysLeft());
 const ln=LN();if(ln)notifAllowed(false).then(ok=>ok&&ln.schedule({notifications:[{id:3000+hit,title,body,schedule:{at:new Date(Date.now()+1500)},smallIcon:'ic_stat_spare',iconColor:'#f5bf3c'}]})).catch(()=>{});
 return{title,body}}

/* ---------- render ---------- */
const $=document.getElementById('root');
const VIEWS=['overview','scan','list','prices','history','settings','store','trophies'];
const view=()=>{const h=location.hash.slice(1);return VIEWS.includes(h)?h:'overview'};
function status(){const el=document.getElementById('sync');if(el)el.innerHTML=({saving:'<span class="spin"></span>'+T('Syncing…'),synced:'✓ '+T('Synced'),offline:T('Offline, will sync'),error:T('Sync problem, retrying'),idle:''})[sync]||''}
const logo=(w=84)=>`<img src="icon-192.png" alt="" width="${w}" height="${w}" style="border-radius:${Math.round(w/4)}px;display:block;margin-bottom:12px">`;
function render(){if(!$)return;document.documentElement.lang=LANG;if(!AUTH.token)return renderAuth();
 if(ui.pulling){$.innerHTML=`<div class="auth">${logo()}<h1>Spare</h1><div class="note warn"><span class="spin"></span>${T('Loading your data…')}</div></div>`;return}
 if(!S.setupDone)return renderSetup();const v=view();
 const vn=v==='trophies'?'overview':v;const nav=[['overview','◔',T('Overview')],['scan','⊡',T('Scan')],['list','☰',T('List')],['prices','€',T('Prices')],['history','↺',T('History')],['settings','⚙',T('Settings')]].map(([k,i,t])=>`<a href="#${k}" class="${vn===k?'on':''}"><b>${i}</b>${t}</a>`).join('');
 $.innerHTML=`<div class="top"><h1 style="display:flex;align-items:center;gap:10px"><img src="favicon.png" alt="" width="34" height="34" style="border-radius:9px">Spare</h1><span class="status" id="sync"></span></div>${({overview:vOverview,scan:vScan,list:vList,prices:vPrices,history:vHistory,settings:vSettings,store:vStore,trophies:vTrophies})[v]()}${v==='store'?'':`<nav>${nav}</nav>`}`;status();wakeLock(v==='store')}

function flashHtml(){const f=S.flash;if(!f||Date.now()-f.at>10*60*1000)return'';let h='';
 if(f.kind==='online')h=`<div class="note good">${T('Saved {0} of spending. {1} left to live on this month.',fmt(f.total),fmt(f.left))}</div>`;
 else if(f.kind==='edit')h=`<div class="note good">${T('Ticket updated.')}</div>`;
 else if(f.kind==='auto')h=`<div class="note good">${T('Your ticket from {0} ({1}) was read and saved. Check it in History.',esc(f.store||T('a store')),fmt(f.total))} <a href="#history">${T('History')}</a></div>`;
 else if(f.kind==='bank')h=`<div class="note good">${T('Imported {0} payments ({1}) from your bank statement.',f.n,fmt(f.total))}</div>`;
 else if(f.under)h=`<div class="note good"><b>${T('Under the cap by {0}.',fmt(f.cap-f.total))}</b> ${T('Your next trip cap is {0}, {1} tighter. Keep it going.',fmt(f.next),fmt(S.settings.tripStep))}</div>`;
 else h=`<div class="note bad"><b>${T('{0} over the {1} cap.',fmt(f.total-f.cap),fmt(f.cap))}</b> ${f.cuts.length?T('Leaving {0} on the shelf would have kept you under.',f.cuts.map(c=>esc(c.name)+' ('+fmt(c.price)+')').join(', ')):T('Everything on it was a need. Consider raising the minimum cap in Settings.')} ${T('Next cap: {0}.',fmt(f.next))}</div>`;
 if(f.alert)h+=`<div class="note warn"><b>${esc(f.alert.title)}</b> ${esc(f.alert.body)}</div>`;return h}

function vOverview(){const mk=mkey(),inc=S.settings.income,cm=commit(),tg=targetFor(mk),liv=living(mk),sp=spentIn(mk),left=r2(liv-sp),dl=daysLeft(),cap=tripCap();
 const pct=liv>0?Math.min(100,sp/liv*100):100;
 const trips=entriesIn(mk).filter(e=>e.kind==='shop'&&e.cap!=null),bonus=r2(trips.reduce((a,e)=>a+Math.max(0,e.cap-e.total),0));
 const cats={};let wantSum=0;const wantItems={};
 for(const e of entriesIn(mk))for(const it of e.items){cats[it.cat]=(cats[it.cat]||0)+it.price;if(it.pref==='want'){wantSum+=it.price;const k=norm(it.name);wantItems[k]=wantItems[k]||{name:it.name,t:0,n:0};wantItems[k].t+=it.price;wantItems[k].n++}}
 const diff=r2(sp-entriesIn(mk).reduce((a,e)=>a+e.items.reduce((x,i)=>x+i.price,0),0));if(diff>0.01)cats.other=(cats.other||0)+diff;
 const cmax=Math.max(1,...Object.values(cats));
 const catRows=Object.entries(cats).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`<div class="hbar"><span>${esc(catName(c))}</span><span class="t"><i class="${CATPREF[c]==='want'?'want':''}" style="width:${v/cmax*100}%"></i></span><span class="num" style="text-align:right">${fmt(v)}</span></div>`).join('');
 const leaks=Object.values(wantItems).sort((a,b)=>b.t-a.t).slice(0,5).map(w=>`<div class="row"><span>${esc(w.name)} <span class="mute small">×${w.n}</span></span><span class="num">${fmt(w.t)}</span></div>`).join('');
 const mks=[...new Set([...Object.keys(S.months),mk])].sort().slice(-6);const vals=mks.map(m=>({m,s:Math.max(0,m===mk?r2(inc-cm-sp):savedFor(m)),t:targetFor(m)}));const vmax=Math.max(1,...vals.map(x=>Math.max(x.s,x.t)));
 const cols=vals.map(x=>`<div class="c"><span class="num">${Math.round(x.s)}</span><i class="${x.m!==mk&&x.s<x.t?'miss':''}" style="height:${x.s/vmax*80}px;${x.m===mk?'opacity:.45':''}"></i>${mname(x.m,1)}</div>`).join('');
 const plan=planList(cap),noFit=S.list.filter(i=>plan.res[i.id]&&!plan.res[i.id].fits);
 const PI=priceIndex(),missed=missedSavings(PI,mk),up=upcoming(14);
 let tips='';if(S.tips&&S.tips.items)tips=S.tips.items.map(t=>`<div class="tip"><div class="row" style="padding:0"><h3>${esc(t.title)}</h3><span class="num" style="color:var(--acc)">~${fmt(t.monthly)}${T('/mo')}</span></div><div class="small mute">${esc(t.detail)}</div></div>`).join('');
 const st=stats(),earned=TROPHIES.filter(t=>t[4](st)),fresh=earned.filter(t=>!(S.trophiesSeen||[]).includes(t[0])),toCheck=S.entries.filter(e=>e.review).length;
 return `${fresh.length?`<div class="note good">🎉 <b>${fresh.length>1?T('{0} new trophies!',fresh.length):T('New trophy!')}</b> ${fresh.map(t=>t[1]+' '+esc(T(t[2]))).join(' · ')} <button class="link" data-act="trophyok">${T('Nice!')}</button></div>`:''}${toCheck?`<div class="note warn">${T('{0} ticket(s) read automatically while you were away. Give them a quick check.',toCheck)} <a href="#history">${T('History')}</a></div>`:''}${S.notice?`<div class="note good">${noticeText(S.notice)} <button class="link" data-act="dismiss">${T('Dismiss')}</button></div>`:''}${flashHtml()}
 <div class="card hero"><div class="mute small">${T('Left to live on in {0}',mname(mk))}</div><div class="big" style="color:${left<0?'var(--bad)':'inherit'}">${fmt(left)}</div>
 <div class="bar ${left<0?'over':''}"><i style="width:${pct}%"></i></div><div class="small mute">${T('{0} spent of {1}',fmt(sp),fmt(liv))} · ${dl>1?T('{0} days left',dl):T('last day')} · <b class="num" style="color:var(--ink)">${fmt(Math.max(0,left)/dl)}</b>${T('/day')}</div>
 <div class="grid2" style="margin-top:14px"><div class="stat"><div class="tiny mute">${T('Savings goal')}</div><div class="v">${fmt(tg)}</div><div class="tiny mute">${left>=0?T('on track'):T('at risk, {0} short',fmt(-left))}</div></div>
 <div class="stat"><div class="tiny mute">${T('Next shopping trip cap')}</div><div class="v">${fmt(cap)}</div><div class="tiny mute">${T('squeeze level {0} · −{1} per win',S.cur.level,fmt(S.settings.tripStep))}</div></div></div>
 ${bonus>0?`<div class="note good small" style="margin-bottom:0">${T('Extra saved by staying under your trip caps: {0} on top of the goal.','<b>'+fmt(bonus)+'</b>')}</div>`:''}</div>
 <div class="card"><div class="row" style="padding:0"><h2 style="margin:0">${T('Streaks & trophies')}</h2><a href="#trophies" class="small">${T('See all')}</a></div>
 <div class="grid2" style="margin-top:10px"><div class="stat"><div class="tiny mute">${T('Trips under the cap in a row')}</div><div class="v">🔥 ${st.streak}</div><div class="tiny mute">${T('best: {0}',st.bestStreak)}</div></div><div class="stat"><div class="tiny mute">${T('Saved since you started')}</div><div class="v">${fmt(st.savedPast)}</div><div class="tiny mute">${T('+ {0} this month so far',fmt(st.savedNow))}</div></div></div>
 ${earned.length?`<div style="font-size:22px;margin-top:10px;letter-spacing:4px" title="${T('Trophies')}">${earned.map(t=>t[1]).join('')}</div>`:`<div class="tiny mute" style="margin-top:8px">${T('Your first trophy is one ticket away.')}</div>`}</div>
 ${up.length?`<div class="card"><h2>${T('Coming up')}</h2>${up.map(x=>{const dd=dayDiff(x.d,today());return `<div class="row"><span>${esc(x.b.name)} <span class="mute small">${dd===0?T('today'):dd===1?T('tomorrow'):T('in {0} days',dd)} · ${dshort(x.d)}</span></span><span class="num">${fmt(x.b.amount)}</span></div>`}).join('')}<div class="tiny mute" style="margin-top:6px">${T('Already set aside in your monthly budget.')}</div></div>`:''}
 ${noFit.length?`<div class="card"><h2>${T('Not affordable on your next trip')}</h2>${noFit.map(i=>`<div class="row"><span>${esc(i.name)}</span><span class="small" style="color:var(--bad)">${T('short by {0}',fmt(plan.res[i.id].short))}</span></div>`).join('')}<div class="tiny mute" style="margin-top:6px">${T('From your shopping list.')} <a href="#list">${T('Edit list')}</a></div></div>`:''}
 ${missed>0.5?`<div class="card"><div class="row" style="padding:0"><span>${T('Paid more than the cheapest store you know this month')}</span><b class="num" style="color:var(--warn)">${fmt(missed)}</b></div><div class="tiny mute" style="margin-top:4px"><a href="#prices">${T('See where to buy what')}</a></div></div>`:''}
 <div class="card"><h2>${T('Where the money goes this month')}</h2>${catRows||`<div class="mute small">${T('Nothing logged yet. Scan your first receipt.')}</div>`}${wantSum>0?`<div class="tiny mute" style="margin-top:6px">${T('Orange = nice-to-haves: {0} this month.',fmt(wantSum))}</div>`:''}</div>
 ${leaks?`<div class="card"><h2>${T('Biggest nice-to-haves')}</h2>${leaks}</div>`:''}
 <div class="card"><h2>${T('Savings by month')}</h2><div class="cols">${cols}</div><div class="tiny mute" style="margin-top:6px">${T('Current month is faded (in progress). Orange = goal missed.')}</div></div>
 <div class="card"><h2>${T('Your month on paper')}</h2>
 <div class="row"><span>${T('Income')}</span><span class="num">${fmt(inc)}</span></div>
 <div class="row"><span>${T('Monthly bills')}</span><span class="num">−${fmt(fixedOnly())}</span></div>
 <div class="row"><span>${T('Set aside for quarterly & yearly bills')}</span><span class="num">−${fmt(cm-fixedOnly())}</span></div>
 <div class="row"><span>${T('Savings goal')}</span><span class="num">−${fmt(tg)}</span></div>
 <div class="row"><b>${T('Left to live on')}</b><b class="num">${fmt(liv)}</b></div>
 <div class="tiny mute" style="margin-top:6px">${T('Shopping trips get {0}% of that over {1} trips. Hit the goal and next month\'s goal rises by {2}.',S.settings.foodShare,S.settings.trips,fmt(S.settings.monthlyStep))}</div></div>
 <div class="card"><div class="row" style="padding:0 0 6px"><h2 style="margin:0">${T('Savings ideas')}</h2><button class="ghost" data-act="tips" ${ui.tipsBusy?'disabled':''}>${ui.tipsBusy?'<span class="spin"></span>'+T('Thinking…'):S.tips?T('Refresh'):T('Get ideas')}</button></div>
 ${tips||`<div class="small mute">${T('AI reads your last 60 days of receipts and bills and suggests specific cuts and swaps.')}</div>`}${ui.tipsErr?`<div class="note bad small">${esc(ui.tipsErr)}</div>`:''}</div>`}

function vScan(){if(ui.draft)return vReview();if(ui.bank)return vBank();
 return `${flashHtml()}<div class="card"><h2>${T('Scan a receipt')}</h2>
 ${ui.busy?`<div class="note warn"><span class="spin"></span>${T('Reading your receipt…')}</div>`:''}${ui.err?`<div class="note bad">${esc(ui.err)}</div>`:''}
 ${ui.photos.length?`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${ui.photos.map((p,i)=>`<div style="position:relative"><img src="${p}" alt="" style="width:76px;height:100px;object-fit:cover;border-radius:10px;border:1px solid var(--line)"><button class="link" data-act="phrm" data-i="${i}" style="position:absolute;top:-6px;right:-6px;background:var(--card);border-radius:99px;padding:0 7px">×</button><span class="tiny mute" style="position:absolute;bottom:4px;left:6px;background:var(--card);border-radius:6px;padding:0 4px">${i+1}</span></div>`).join('')}</div>
 ${ui.photos.length<4?`<label class="drop" style="padding:14px"><input type="file" accept="image/*" capture="environment" data-act="file" multiple><b>+ ${T('Add the next part of the ticket')}</b><div class="small mute">${T('For long tickets: up to 4 photos, top to bottom.')}</div></label>`:''}
 <div class="btns">${online()?`<button class="acc" data-act="phread" ${ui.busy?'disabled':''}>${ui.photos.length>1?T('Read ticket ({0} photos)',ui.photos.length):T('Read ticket')}</button><button class="ghost" data-act="phlater">${T('Read later')}</button>`:`<button class="acc" data-act="phlater">${T('Save, read when online')}</button>`}<button class="link" data-act="phclear">${T('Cancel')}</button></div>`
 :`<label class="drop"><input type="file" accept="image/*" capture="environment" data-act="file" multiple><div class="ic">⊡</div><b>${T('Take or choose a photo of the ticket')}</b><div class="small mute">${T('Shop receipts or screenshots of online orders. Long ticket? Add several photos.')}</div></label>${online()?'':`<div class="tiny mute" style="margin-top:6px">${T('You\'re offline: photos are kept and read automatically once you\'re back online.')}</div>`}`}</div>
 ${ui.queue.length?`<div class="card"><h2>${T('Waiting to be read')}</h2>${ui.queue.map(q=>`<div class="row"><span>${q.images?T('Ticket photo'):T('Online order')} <span class="mute small">${dshort(q.date)}${q.images&&q.images.length>1?' · '+T('{0} photos',q.images.length):''}</span>${q.failed?`<br><span class="tiny" style="color:var(--bad)">${T('Couldn\'t be read.')}</span>`:''}</span><span>${q.failed?`<button class="link" data-act="qretry" data-id="${q.id}">${T('Retry')}</button><button class="link" data-act="qhand" data-id="${q.id}">${T('By hand')}</button>`:`<span class="tiny mute">${online()?T('reading…'):T('offline')}</span>`}<button class="link" data-act="qdel" data-id="${q.id}">×</button></span></div>`).join('')}</div>`:''}
 <div class="card"><h2>${T('Bank statement')}</h2><div class="small mute">${T('Export your transactions from your banking app or website and import the file. Spare adds the card and online payments you didn\'t scan, and skips bills, transfers and anything already logged.')}</div>
 ${ui.bankBusy?`<div class="note warn"><span class="spin"></span>${T('Reading your statement…')}</div>`:''}${ui.bankErr?`<div class="note bad">${esc(ui.bankErr)}</div>`:''}
 <label class="drop" style="margin-top:10px;padding:18px"><input type="file" accept=".csv,.txt,.xml,.ofx,.qfx,.xlsx,.xls,.sta,text/csv,text/plain,application/xml,text/xml,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" data-act="bankfile"><b>${T('Choose a statement file')}</b><div class="small mute">CSV · Excel · CAMT.053 (XML) · OFX</div></label>
 <div class="tiny mute" style="margin-top:6px">${T('Works with KBC, Belfius, ING, BNP Paribas Fortis, Argenta, Crelan, Revolut, N26, Wise and most European banks.')}</div></div>
 <div class="card"><h2>${T('Online order')}</h2><div class="small mute">${T('Paste the confirmation email or order summary.')}</div>
 <textarea id="paste" placeholder="${T('Order #… 1× … €…')}"></textarea><div class="btns"><button data-act="paste" ${ui.busy?'disabled':''}>${T('Read order')}</button></div></div>
 <div class="card"><h2>${T('By hand')}</h2><div class="btns" style="margin-top:0"><button class="ghost" data-act="manual" data-kind="shop">${T('Shop ticket')}</button><button class="ghost" data-act="manual" data-kind="online">${T('Online purchase')}</button></div>
 <div class="tiny mute" style="margin-top:8px">${T('Next shopping trip cap:')} <b class="num">${fmt(tripCap())}</b></div></div>`}

const catOpts=c=>CATS.map(([k])=>`<option value="${k}" ${k===c?'selected':''}>${esc(catName(k))}</option>`).join('');
function draftSum(){return r2(ui.draft.items.reduce((a,i)=>a+num(i.price),0))}
function vReview(){const d=ui.draft,sum=draftSum(),tot=d.total===''||d.total==null?sum:num(d.total),cap=tripCap(),cur=mkey(d.date)===mkey();
 const PI=priceIndex(),st=storeOf(d.store);
 const rows=d.items.map((it,i)=>{const p=findProd(PI,it.gen||it.name)||PI.idx[norm(it.gen||'')];const unit=num(it.price)/(it.qty>0?it.qty:1);
  const hint=p&&p.best&&st&&p.best.name!==st.name&&unit>p.best.price+0.01?`<tr><td colspan="5" class="tiny" style="color:var(--warn);padding-top:0">${T('{0} at {1} last time ({2} less)',fmt(p.best.price),esc(p.best.name),fmt(unit-p.best.price))}</td></tr>`:'';
  return `<tr><td><input data-f="name" data-i="${i}" value="${esc(it.name)}"></td><td class="c"><select data-f="cat" data-i="${i}">${catOpts(it.cat)}</select></td><td class="p"><input class="num" inputmode="decimal" data-f="price" data-i="${i}" value="${esc(it.price)}"></td><td><button class="pill ${it.pref}" data-act="pref" data-i="${i}">${it.pref==='need'?T('Need'):T('Want')}</button></td><td><button class="link" data-act="rmitem" data-i="${i}">×</button></td></tr>${hint}`}).join('');
 let check='';
 if(d.kind==='shop'&&cur&&!d.editId){const over=r2(tot-cap);
  if(over<=0)check=`<div class="note good">${T('{0} under your {1} cap. Saving this tightens the next trip by {2}.',fmt(-over),fmt(cap),fmt(S.settings.tripStep))}</div>`;
  else{const c=cutsFor(d.items.map(i=>({...i,price:num(i.price)})),over);check=`<div class="note bad"><b>${T('{0} over your {1} cap.',fmt(over),fmt(cap))}</b> ${c.cuts.length?T('Skip next time: {0}.',c.cuts.map(x=>esc(x.name)+' ('+fmt(x.price)+')').join(', ')):''}${c.short>0?' '+T('Even without every want you\'d be {0} over.',fmt(c.short)):''}</div>`}}
 return `<div class="card"><h2>${d.editId?T('Edit the ticket'):T('Check the ticket')}</h2>
 <div class="grid2"><div><label class="f">${T('Store')}</label><input data-f="store" value="${esc(d.store)}"></div><div><label class="f">${T('Date')}</label><input type="date" data-f="date" value="${esc(d.date)}"></div></div>
 <label class="f">${T('Type')}</label><select data-f="kind"><option value="shop" ${d.kind==='shop'?'selected':''}>${T('Shopping trip (counts toward trip cap)')}</option><option value="online" ${d.kind==='online'?'selected':''}>${T('Online / other spending')}</option></select>
 <label class="f">${T('Items: tap Need/Want to teach the app what you can cut')}</label>
 <table class="items">${rows}</table><button class="link" data-act="additem">+ ${T('Add line')}</button>
 <div class="row" style="margin-top:8px"><span>${T('Items add up to')}</span><span class="num">${fmt(sum)}</span></div>
 <div class="row"><span>${T('Total paid')}</span><span style="width:110px"><input class="num" inputmode="decimal" data-f="total" value="${esc(d.total??'')}" placeholder="${sum.toFixed(2)}"></span></div>
 ${Math.abs(sum-tot)>0.01?`<div class="tiny mute">${T('Difference of {0} (discounts, deposits…). The total paid is what counts.',fmt(tot-sum))}</div>`:''}
 ${check}<div class="btns"><button class="acc" data-act="save">${T('Save ticket')}</button><button class="ghost" data-act="discard">${T('Discard')}</button></div></div>`}

function vBank(){const b=ui.bank,rows=b.rows,sel=rows.filter(r=>r.inc),tot=r2(sel.reduce((a,r)=>a-r.amount,0));
 const reason={seen:T('already imported'),scanned:T('already scanned'),bill:T('bill'),transfer:T('transfer'),cash:T('cash')};
 const list=rows.slice(0,400).map((r,i)=>`<div class="li" style="grid-template-columns:24px 1fr auto auto;${r.inc?'':'opacity:.55'}"><input type="checkbox" data-act="bk" data-i="${i}" ${r.inc?'checked':''}><span><span class="nm">${esc(r.label)}</span><br><span class="tiny mute">${dshort(r.date)}${r.why?` · <span class="tag">${reason[r.why]}</span>`:''}</span></span><select data-bkcat="${i}" style="width:118px;padding:6px 8px;font-size:13px">${catOpts(r.cat)}</select><span class="num">${fmt(-r.amount)}</span></div>`).join('');
 return `<div class="card"><h2>${T('Check the payments')}</h2><div class="small mute">${T('{0} file · {1} payments out · {2} incoming skipped.',esc(b.format),rows.length,b.income)}</div>
 <div class="small mute" style="margin-top:6px">${T('Unticked: bills (already in your budget), transfers to your own accounts, and anything you already scanned or imported.')}</div>
 <div class="btns"><button class="ghost" data-act="bkall">${T('Tick all')}</button><button class="ghost" data-act="bknone">${T('Untick all')}</button><button class="ghost" data-act="bkmonth">${T('Only this month')}</button></div>
 <div style="margin-top:8px">${list||`<div class="mute small">${T('No outgoing payments found.')}</div>`}</div>
 <div class="row" style="margin-top:8px"><b>${T('{0} selected',sel.length)}</b><b class="num">${fmt(tot)}</b></div>
 <div class="btns"><button class="acc" data-act="bkgo" ${sel.length?'':'disabled'}>${T('Import {0} payments',sel.length)}</button><button class="ghost" data-act="bkcancel">${T('Cancel')}</button></div></div>`}

function vList(){const cap=tripCap(),p=planList(cap),PI=priceIndex();
 const items=[...S.list.filter(i=>i.pref==='need'),...S.list.filter(i=>i.pref!=='need')].map(i=>{const r=p.res[i.id]||{},pr=findProd(PI,i.name);
  const cheap=pr&&pr.best?`<span class="why" style="color:var(--mute)">${pr.sorted.length>1?T('Cheapest at {0}: {1}',esc(pr.best.name),fmt(pr.best.price)):T('{0} at {1}',fmt(pr.best.price),esc(pr.best.name))}</span>`:'';
  return `<div class="li ${r.fits?'':'no'}"><input type="checkbox" data-act="done" data-id="${i.id}" ${i.done?'checked':''}><span class="nm">${esc(i.name)}</span><button class="pill ${i.pref}" data-act="lpref" data-id="${i.id}">${i.pref==='need'?T('Need'):T('Want')}</button><input class="num" style="width:78px;padding:6px 8px" inputmode="decimal" data-lprice="${i.id}" value="${esc(i.price)}"><button class="link" data-act="lrm" data-id="${i.id}">×</button>${r.fits?cheap:`<span class="why">${T('Doesn\'t fit this trip, short by {0}',fmt(r.short))}</span>`}</div>`}).join('');
 const stores={};for(const it of S.list){const pr=findProd(PI,it.name);if(!pr)continue;for(const s of Object.values(pr.stores)){const x=stores[s.name]||(stores[s.name]={name:s.name,t:0,n:0});x.t+=s.price;x.n++}}
 const best=Object.values(stores).sort((a,b)=>b.n-a.n||a.t-b.t).slice(0,3);
 const bestHtml=best.length>1?`<div class="card"><h2>${T('Best store for this list')}</h2>${best.map((s,k)=>`<div class="row"><span>${k===0?'🏆 ':''}${esc(s.name)} <span class="mute small">${T('{0} of {1} items known',s.n,S.list.length)}</span></span><span class="num">${fmt(s.t)}</span></div>`).join('')}<div class="tiny mute" style="margin-top:6px">${T('Based on the last price you paid in each store.')}</div></div>`:'';
 const dl=Object.values(PI.idx).map(x=>`<option value="${esc(x.label)}">`).join('');
 return `<div class="card"><h2>${T('Next trip')}</h2><div class="grid2"><div class="stat"><div class="tiny mute">${T('Your cap')}</div><div class="v">${fmt(cap)}</div></div><div class="stat"><div class="tiny mute">${T('What fits')}</div><div class="v">${fmt(p.total)}</div><div class="tiny mute">${T('of {0} listed',fmt(p.all))}</div></div></div>
 ${p.needsTotal>cap?`<div class="note warn small">${T('Your needs alone come to {0}, above the cap. Drop or swap something, or adjust the minimum cap in Settings.',fmt(p.needsTotal))}</div>`:''}
 <div class="small mute" style="margin-top:10px">${T('Needs are counted first, then wants in the order you added them. Whatever doesn\'t fit gets struck out with the exact amount you\'re short.')}</div></div>
 ${S.list.length?`<a href="#store" class="btn acc" style="display:block;text-align:center;text-decoration:none;margin-bottom:12px;background:var(--acc);color:#fff">🛒 ${T('Start shopping')}</a>`:''}
 ${bestHtml}
 <div class="card"><h2>${T('Shopping list')}</h2><form data-form="add" style="display:grid;grid-template-columns:1fr 90px auto;gap:8px"><input id="lname" list="known" placeholder="${T('Item (prices fill in from past tickets)')}" autocomplete="off"><input id="lprice" class="num" inputmode="decimal" placeholder="€"><button>${T('Add')}</button></form><datalist id="known">${dl}</datalist>
 <div style="margin-top:10px">${items||`<div class="mute small">${T('Empty. Add what you plan to buy.')}</div>`}</div>
 ${S.list.length?`<div class="btns"><button class="ghost" data-act="lclear">${T('Clear list')}</button></div>`:''}</div>`}

function vPrices(){const PI=priceIndex(),all=Object.values(PI.idx),mk=mkey(),missed=missedSavings(PI,mk);
 const multi=all.filter(p=>p.sorted.length>1).sort((a,b)=>b.spread*b.n-a.spread*a.n),single=all.filter(p=>p.sorted.length===1).sort((a,b)=>b.n-a.n);
 const row=p=>`<div class="entry" data-pk="${esc(norm(p.label+' '+p.key+' '+p.sorted.map(s=>s.name).join(' ')))}"><div class="row" style="padding:0"><span><b>${esc(p.label)}</b> <span class="tiny mute">×${p.n}</span></span><span class="num" style="color:var(--acc)">${fmt(p.best.price)}</span></div>
  <div class="tiny mute">${p.sorted.map((s,k)=>`${k===0?'✓ ':''}${esc(s.name)} ${fmt(s.price)}${s.min<s.price-0.009?` <span title="${T('lowest seen')}">(↓${fmt(s.min)})</span>`:''}`).join(' · ')}</div>
  ${p.sorted.length>1?`<div class="tiny" style="color:var(--warn)">${T('Save {0} each time by buying it at {1}',fmt(p.spread),esc(p.best.name))}</div>`:''}</div>`;
 const stores={};for(const p of multi)stores[p.best.name]=(stores[p.best.name]||0)+1;const champ=Object.entries(stores).sort((a,b)=>b[1]-a[1])[0];
 return `<div class="card"><h2>${T('Price comparison')}</h2><div class="small mute">${T('Every ticket you scan teaches Spare what each product costs in each store.')}</div>
 <div class="grid2" style="margin-top:12px"><div class="stat"><div class="tiny mute">${T('Products tracked')}</div><div class="v">${all.length}</div><div class="tiny mute">${T('{0} seen in 2+ stores',multi.length)}</div></div>
 <div class="stat"><div class="tiny mute">${T('Overpaid this month')}</div><div class="v" style="color:${missed>0?'var(--warn)':'inherit'}">${fmt(missed)}</div><div class="tiny mute">${T('vs the cheapest store you know')}</div></div></div>
 ${champ?`<div class="note good small" style="margin-bottom:0">${T('{0} is cheapest for {1} of your products.',esc(champ[0]),champ[1])}</div>`:''}
 <input id="pq" placeholder="${T('Search a product or store')}" style="margin-top:12px" value="${esc(ui.q)}"></div>
 ${multi.length?`<div class="card"><h2>${T('Compared across stores')}</h2>${multi.map(row).join('')}</div>`:''}
 ${single.length?`<div class="card"><h2>${T('Seen in one store')}</h2>${single.map(row).join('')}<div class="tiny mute" style="margin-top:6px">${T('Scan a ticket from another store to compare.')}</div></div>`:''}
 ${all.length?'':`<div class="card"><div class="mute small">${T('Nothing to compare yet. Scan a few tickets from different stores.')}</div></div>`}`}

let wl=null;function wakeLock(on){try{if(on&&!wl&&navigator.wakeLock)navigator.wakeLock.request('screen').then(l=>{wl=l;l.addEventListener('release',()=>{wl=null})}).catch(()=>{});else if(!on&&wl){wl.release();wl=null}}catch(e){}}
function vStore(){const cap=tripCap(),PI=priceIndex(),cart=S.list.filter(i=>i.done),tot=r2(cart.reduce((a,i)=>a+num(i.price),0)),rem=r2(cap-tot),pct=cap>0?Math.min(100,tot/cap*100):100;
 const order=[...S.list].sort((a,b)=>(a.done?1:0)-(b.done?1:0)||(a.pref==='need'?0:1)-(b.pref==='need'?0:1));
 const stores=[...new Set(S.entries.filter(e=>e.kind==='shop'&&e.store).map(e=>storeOf(e.store).name))];
 const rows=order.map(i=>{const p=num(i.price),fits=i.done||p<=rem+1e-9,pr=findProd(PI,i.name),here=pr&&ui.storeName?pr.stores[storeOf(ui.storeName).key]:null;
  const hint=!i.done&&!fits?`<span class="why">${T('Doesn\'t fit any more, short by {0}',fmt(p-rem))}</span>`:pr&&pr.best&&ui.storeName&&storeOf(ui.storeName).name!==pr.best.name&&(!here||here.price>pr.best.price+0.01)?`<span class="why" style="color:var(--warn)">${T('Cheaper at {0}: {1}',esc(pr.best.name),fmt(pr.best.price))}</span>`:'';
  return `<div class="li big ${i.done?'in':''} ${fits?'':'no'}"><input type="checkbox" data-act="cart" data-id="${i.id}" ${i.done?'checked':''}><span class="nm">${esc(i.name)}</span><span class="pill ${i.pref}" style="cursor:default">${i.pref==='need'?T('Need'):T('Want')}</span><input class="num" style="width:82px;padding:8px" inputmode="decimal" data-lprice="${i.id}" value="${esc(i.price)}" title="${T('Shelf price')}"><span></span>${hint}</div>`}).join('');
 return `<div class="card hero" style="position:sticky;top:0;z-index:2"><div class="row" style="padding:0"><span class="mute small">🛒 ${T('In the cart')}</span><a href="#list" class="small">${T('Exit')}</a></div>
 <div class="big" style="color:${rem<0?'var(--bad)':'inherit'}">${fmt(tot)} <span class="mute" style="font-size:18px">/ ${fmt(cap)}</span></div>
 <div class="bar ${rem<0?'over':''}"><i style="width:${pct}%"></i></div><div class="small ${rem<0?'':'mute'}" style="${rem<0?'color:var(--bad);font-weight:600':''}">${rem>=0?T('{0} left for this trip',fmt(rem)):T('{0} over the cap: put something back',fmt(-rem))}</div></div>
 <div class="card"><label class="f" style="margin-top:0">${T('Store')}</label><input data-act="storename" list="stores" value="${esc(ui.storeName)}" placeholder="Colruyt, Aldi…"><datalist id="stores">${stores.map(x=>`<option value="${esc(x)}">`).join('')}</datalist>
 <div style="margin-top:10px">${rows||`<div class="mute small">${T('Your list is empty.')}</div>`}</div>
 <form data-form="add" style="display:grid;grid-template-columns:1fr 90px auto;gap:8px;margin-top:10px"><input id="lname" list="known" placeholder="${T('Forgot something?')}" autocomplete="off"><input id="lprice" class="num" inputmode="decimal" placeholder="€"><button>${T('Add')}</button></form><datalist id="known">${Object.values(PI.idx).map(x=>`<option value="${esc(x.label)}">`).join('')}</datalist>
 <div class="tiny mute" style="margin-top:8px">${T('Tick items as they go in the cart. Change a price if the shelf says otherwise.')}</div></div>
 <div class="btns" style="margin-bottom:20px"><button class="acc" data-act="storedone" ${cart.length?'':'disabled'}>${T('Done: save this trip')}</button><button class="ghost" data-act="storescan">${T('I\'ll scan the ticket instead')}</button></div>`}

function stats(){const trips=S.entries.filter(e=>e.kind==='shop'&&e.cap!=null).sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
 let cur=0,best=0;const perMonth={};for(const e of trips){if(e.total<=e.cap){cur++;best=Math.max(best,cur);const m=mkey(e.date);perMonth[m]=(perMonth[m]||0)+1}else cur=0}
 const cm=mkey(),past=Object.keys(S.months).filter(m=>m<cm).sort();let gs=0,bgs=0,hits=0,saved=0;
 for(const m of past){const sv=savedFor(m);saved+=Math.max(0,sv);if(sv>=targetFor(m)){hits++;gs++;bgs=Math.max(bgs,gs)}else gs=0}
 const PI=priceIndex();
 return{tickets:S.entries.filter(e=>e.kind!=='bank').length,streak:cur,bestStreak:best,bestMonthUnder:Math.max(0,...Object.values(perMonth)),
  noWantTrip:S.entries.some(e=>e.kind==='shop'&&e.items.length>=3&&e.items.every(i=>i.pref==='need')),goalHits:hits,goalStreak:gs,bestGoalStreak:bgs,
  savedPast:r2(saved),savedNow:r2(Math.max(0,S.settings.income-commit()-spentIn(cm))),compared:Object.values(PI.idx).filter(p=>p.sorted.length>1).length,bankImports:S.entries.filter(e=>e.kind==='bank').length}}
const TROPHIES=[
 ['first','🧾','First ticket','Log your first ticket.',s=>s.tickets>=1,s=>[s.tickets,1]],
 ['streak3','🔥','On a roll','3 shopping trips in a row under the cap.',s=>s.bestStreak>=3,s=>[s.bestStreak,3]],
 ['streak10','🔥','Unstoppable','10 shopping trips in a row under the cap.',s=>s.bestStreak>=10,s=>[s.bestStreak,10]],
 ['streak25','☄️','Squeeze master','25 shopping trips in a row under the cap.',s=>s.bestStreak>=25,s=>[s.bestStreak,25]],
 ['month10','🗜️','Squeezed','10 trips under the cap in one month.',s=>s.bestMonthUnder>=10,s=>[s.bestMonthUnder,10]],
 ['nowant','🥦','Needs only','A trip of 3 or more items with no wants at all.',s=>s.noWantTrip,null],
 ['goal1','🎯','Goal!','Reach your monthly savings goal.',s=>s.goalHits>=1,s=>[s.goalHits,1]],
 ['goal3','🏅','Hat trick','Reach your goal 3 months in a row.',s=>s.bestGoalStreak>=3,s=>[s.bestGoalStreak,3]],
 ['goal12','🏆','A whole year','Reach your goal 12 months in a row.',s=>s.bestGoalStreak>=12,s=>[s.bestGoalStreak,12]],
 ['save500','💶','Nest egg','Save €500 in total.',s=>s.savedPast>=500,s=>[s.savedPast,500]],
 ['save1000','💰','Four figures','Save €1,000 in total.',s=>s.savedPast>=1000,s=>[s.savedPast,1000]],
 ['save5000','💎','Treasure','Save €5,000 in total.',s=>s.savedPast>=5000,s=>[s.savedPast,5000]],
 ['compare10','🔎','Bargain hunter','Compare 10 products across stores.',s=>s.compared>=10,s=>[s.compared,10]],
 ['bank','🏦','Nothing slips through','Import a bank statement.',s=>s.bankImports>=1,null]];
function vTrophies(){const st=stats();
 return `<div class="card"><h2>${T('Streaks & trophies')}</h2><div class="grid2"><div class="stat"><div class="tiny mute">${T('Trips under the cap in a row')}</div><div class="v">🔥 ${st.streak}</div><div class="tiny mute">${T('best: {0}',st.bestStreak)}</div></div>
 <div class="stat"><div class="tiny mute">${T('Months with the goal reached')}</div><div class="v">🎯 ${st.goalHits}</div><div class="tiny mute">${T('in a row: {0}',st.goalStreak)}</div></div>
 <div class="stat"><div class="tiny mute">${T('Saved since you started')}</div><div class="v">${fmt(st.savedPast)}</div><div class="tiny mute">${T('+ {0} this month so far',fmt(st.savedNow))}</div></div>
 <div class="stat"><div class="tiny mute">${T('Products compared')}</div><div class="v">🔎 ${st.compared}</div></div></div></div>
 <div class="card">${TROPHIES.map(t=>{const ok=t[4](st),pr=!ok&&t[5]?t[5](st):null;return `<div class="row" style="${ok?'':'opacity:.45'}"><span style="display:flex;gap:12px;align-items:center"><span style="font-size:26px;${ok?'':'filter:grayscale(1)'}">${t[1]}</span><span><b>${esc(T(t[2]))}</b><br><span class="tiny mute">${esc(T(t[3]))}</span></span></span><span class="tiny mute">${ok?'✓':pr?`${t[0].startsWith('save')?fmt(Math.min(pr[0],pr[1])):Math.min(pr[0],pr[1])} / ${t[0].startsWith('save')?fmt(pr[1]):pr[1]}`:''}</span></div>`}).join('')}</div>
 <div class="tiny mute" style="text-align:center;margin-bottom:12px">${T('Savings count once a month is over.')}</div>`}

function vHistory(){const by={};for(const e of S.entries){(by[mkey(e.date)]=by[mkey(e.date)]||[]).push(e)}
 const ms=Object.keys(by).sort().reverse();
 if(!ms.length)return `<div class="card"><h2>${T('History')}</h2><div class="mute small">${T('No tickets yet.')}</div></div>`;
 return ms.map(m=>{const es=by[m].sort((a,b)=>a.date<b.date?1:-1);return `<div class="card"><div class="row" style="padding:0 0 8px"><h2 style="margin:0">${mname(m)}</h2><span class="num">${fmt(es.reduce((a,e)=>a+e.total,0))}</span></div>
 ${es.map(e=>`<div class="entry"><div class="head" data-act="open" data-id="${e.id}"><span>${esc(e.store||T('Ticket'))} <span class="mute small">${dshort(e.date)}</span>${e.review?`<span class="tag no">${T('to check')}</span>`:''}${e.kind==='online'?`<span class="tag">${T('online')}</span>`:e.kind==='bank'?`<span class="tag">${T('bank')}</span>`:e.cap!=null?`<span class="tag ${e.total<=e.cap?'ok':'no'}">${e.total<=e.cap?T('under {0}',fmt(e.cap)):T('over {0}',fmt(e.cap))}</span>`:''}</span><span class="num">${fmt(e.total)}</span></div>
 ${ui.open===e.id?`<div style="margin-top:8px">${e.items.map(i=>`<div class="row small"><span>${esc(i.name)} <span class="tag">${esc(catName(i.cat))}</span></span><span class="num">${fmt(i.price)}</span></div>`).join('')}
 <div class="btns">${ui.del===e.id?`<span class="small">${T('Delete this ticket?')}</span><button class="ghost" data-act="delyes" data-id="${e.id}" style="color:var(--bad)">${T('Delete')}</button><button class="link" data-act="delno">${T('Cancel')}</button>`:`<button class="link" data-act="edit" data-id="${e.id}">${e.review?T('Check & edit'):T('Edit')}</button><button class="link" data-act="del" data-id="${e.id}">${T('Delete ticket')}</button>`}</div></div>`:''}</div>`).join('')}</div>`}).join('')}

function billRows(placeholder){return S.bills.map(b=>`<div class="bill"><input data-bill="name" data-id="${b.id}" value="${esc(b.name)}"><input class="num" inputmode="decimal" data-bill="amount" data-id="${b.id}" value="${placeholder&&!b.amount?'':b.amount}" placeholder="€"><select data-bill="freq" data-id="${b.id}">${FREQ.map(k=>`<option value="${k}" ${b.freq===k?'selected':''}>${esc(freqName(k))}</option>`).join('')}</select><button class="link" data-act="brm" data-id="${b.id}">×</button>
 ${b.freq!=='m'?`<label class="tiny mute" style="grid-column:1/2;align-self:center;text-align:right">${T('Next payment')}</label><input type="date" data-bill="due" data-id="${b.id}" value="${esc(b.due||'')}" style="grid-column:2/4;padding:6px 8px">`:''}</div>`).join('')}

function vSettings(){const s=S.settings,f=(k,l,h)=>`<div><label class="f">${l}</label><input class="num" inputmode="decimal" data-set="${k}" value="${s[k]}">${h?`<div class="tiny mute">${h}</div>`:''}</div>`;
 const n=s.notif||{},ln=LN(),tg=(k,l,h)=>`<label class="row" style="cursor:pointer"><span>${l}<br><span class="tiny mute">${h}</span></span><input type="checkbox" data-notif="${k}" ${n[k]?'checked':''} style="width:20px;height:20px"></label>`;
 return accountCard()+(AUTH.admin?adminCard():'')+`<div class="card"><h2>${T('Language')}</h2><select data-act="lang">${Object.keys(LOCALES).map(l=>`<option value="${l}" ${l===LANG?'selected':''}>${LANGNAME[l]}</option>`).join('')}</select></div>
 <div class="card"><h2>${T('Notifications')}</h2>${ln?`${notifPerm==='denied'?`<div class="note warn small">${T('Notifications are blocked for Spare. Allow them in your phone\'s settings.')}</div>`:notifPerm!=='granted'?`<div class="btns" style="margin-top:0"><button data-act="notifon">${T('Turn on notifications')}</button></div>`:''}
 ${tg('bills',T('Bill reminders'),T('3 days before a quarterly or yearly bill (set its next payment date below).'))}${tg('weekly',T('Weekly summary'),T('Sunday evening, plus a reminder on the last day of the month.'))}${tg('alerts',T('Budget alerts'),T('When you\'ve used 80% and 100% of your money for the month.'))}`
 :`<div class="small mute">${T('Notifications work in the Android app. Here on the website you\'ll see upcoming bills and alerts on the overview.')}</div>`}</div>
 <div class="card"><h2>${T('Money')}</h2><div class="grid2">${f('income',T('Monthly income (€)'))}${f('target',T('Savings goal this month (€)'))}${f('monthlyStep',T('Goal rises by (€) after a good month'))}${f('tripStep',T('Trip cap shrinks by (€) per win'))}${f('trips',T('Shopping trips per month'))}${f('foodShare',T('% of living money for trips'))}${f('minCap',T('Never squeeze a trip below (€)'))}</div><div class="tiny mute" style="margin-top:8px">${T('Changes save as you leave each field.')}</div></div>
 <div class="card"><h2>${T('Bills')}</h2>${billRows()}<button class="link" data-act="badd">+ ${T('Add bill')}</button><div class="row" style="margin-top:8px"><span>${T('Monthly equivalent')}</span><b class="num">${fmt(commit())}</b></div></div>
 <div class="card"><h2>${T('Backup')}</h2><div class="small mute">${T('Copy your data to keep it somewhere safe, or paste a backup to restore it.')}</div><div class="btns"><button class="ghost" data-act="export">${ui.copied?T('Copied ✓'):T('Copy backup')}</button><button class="ghost" data-act="imp">${T('Restore…')}</button></div>
 ${ui.imp?`<textarea id="impt" placeholder="${T('Paste backup here')}"></textarea><div class="btns"><button data-act="impgo">${T('Restore this backup')}</button></div>`:''}</div>`}

/* ---------- receipt scanning ---------- */
async function shrink(file){try{const bmp=await createImageBitmap(file),m=1600,sc=Math.min(1,m/Math.max(bmp.width,bmp.height));const c=document.createElement('canvas');c.width=Math.round(bmp.width*sc);c.height=Math.round(bmp.height*sc);c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);return await new Promise(r=>c.toBlob(b=>r(b||file),'image/jpeg',.85))}catch(e){return file}}
const PARSE=`You read a shopping receipt or an online order confirmation from Europe (prices in EUR; text may be French, Dutch, German or English).
Return ONLY a JSON object, no prose:
{"store":string,"date":"YYYY-MM-DD" or null,"kind":"shop" or "online","items":[{"name":string,"generic":string,"qty":number,"price":number,"category":string}],"total":number}
Rules:
- "store": the shop's brand name (e.g. "Colruyt", "Aldi", "Delhaize").
- "name": short readable product name as printed, keep brand if shown (e.g. "Boni lait demi-écrémé 1L").
- "generic": the same product described generically in lowercase English with size, no brand, so the same product can be matched across stores (e.g. "semi-skimmed milk 1l", "cat food wet 12x85g", "bananas 1kg").
- "qty": number of units on that line (1 if not shown; for weighed goods use 1).
- "price": what was actually paid for that line (quantity × unit price, minus any discount printed right under it). Negative only for a stand-alone discount line.
- "category": one of ${CATS.map(c=>c[0]).join(', ')}. Pet food/litter = cat. Alcohol, soda, juice, coffee = drinks. Chips, chocolate, cookies, candy = snacks. Restaurant/takeaway = eatout.
- "total": the final amount paid (TOTAL / À PAYER / TE BETALEN / SUMME). Ignore VAT tables, payment card lines, loyalty points, change given.
- "kind": "online" for web orders/confirmation emails, otherwise "shop".`;
function toDraft(j,kind){const items=(Array.isArray(j&&j.items)?j.items:[]).map(i=>{const cat=CATKEYS.has(i.category)?i.category:'other';return{name:String(i.name||'Item'),gen:i.generic?String(i.generic).toLowerCase():'',qty:+i.qty>0?+i.qty:1,price:r2(num(i.price)),cat,pref:prefOf(i.name,cat)}});
 const d=/^\d{4}-\d{2}-\d{2}$/.test(j&&j.date)?j.date:today();
 return{store:String((j&&j.store)||''),date:d,kind:(j&&j.kind==='online')||kind==='online'?'online':'shop',items:items.length?items:[{name:'',price:'',cat:'groceries',pref:'need',qty:1}],total:j&&j.total!=null?r2(num(j.total)):''}}
async function parse(body,kind){ui.busy=true;ui.err='';render();
 try{const j=await api('/api/scan',{method:'POST',body:{prompt:PARSE,...body}});ui.draft=toDraft(j,kind);ui.photos=[]}
 catch(e){if(e.offline){await queueAdd({...body,kind});ui.photos=[];ui.err=T('You\'re offline. Saved: it will be read automatically when you\'re back online.')}
  else ui.err=e.status===429?e.message:T('Couldn\'t read that ticket. Try a sharper, flatter photo, or enter it by hand.')}
 ui.busy=false;render()}

function afterSpend(){const a=checkAlerts();if(a&&S.flash)S.flash.alert=a}
function commitDraft(d,auto){const items=d.items.filter(i=>String(i.name).trim()||num(i.price)).map(i=>({name:String(i.name).trim()||T('Item'),price:r2(num(i.price)),cat:i.cat,pref:i.pref,...(i.gen?{gen:i.gen}:{}),...(i.qty>1?{qty:i.qty}:{})}));
 const sum=r2(items.reduce((a,i)=>a+i.price,0)),total=d.total===''||d.total==null?sum:r2(num(d.total));
 if(!items.length&&!total)return null;
 if(!auto)for(const i of items)S.prefs[norm(i.name)]=i.pref;
 if(d.editId){const e=S.entries.find(x=>x.id===d.editId);if(!e)return null;Object.assign(e,{date:d.date||e.date,store:String(d.store).trim(),kind:d.kind,items,total});delete e.review;S.flash={at:Date.now(),kind:'edit',total};return e}
 const e={id:uid(),date:d.date||today(),store:String(d.store).trim(),kind:d.kind,items,total};if(auto)e.review=true;
 const mk=mkey();
 if(e.kind==='shop'&&mkey(e.date)===mk){const cap=tripCap();e.cap=cap;const under=total<=cap;S.cur.level=under?S.cur.level+1:Math.max(0,S.cur.level-1);
  const over=r2(total-cap);S.flash={at:Date.now(),kind:'shop',total,cap,under,next:tripCap(),cuts:under?[]:cutsFor(items,over).cuts.map(c=>({name:c.name,price:c.price}))}}
 else S.flash={at:Date.now(),kind:'online',total,left:0};
 S.entries.push(e);if(S.flash.kind==='online')S.flash.left=r2(living(mk)-spentIn(mk));
 const bought=new Set(items.map(i=>norm(i.name)));if(e.kind==='shop')S.list=S.list.filter(l=>!(l.done||bought.has(norm(l.name))));
 if(auto)S.flash={at:Date.now(),kind:'auto',store:e.store,total};
 afterSpend();return e}
function saveDraft(){const e=commitDraft(ui.draft,false);if(!e){ui.err=T('Add at least one line or a total.');return render()}
 ui.draft=null;ui.err='';ui.photos=[];persist();location.hash='overview';render()}
function editEntry(id){const e=S.entries.find(x=>x.id===id);if(!e)return;ui.draft={editId:e.id,store:e.store||'',date:e.date,kind:e.kind==='bank'?'online':e.kind,items:e.items.map(i=>({...i,qty:i.qty||1})),total:Math.abs(e.items.reduce((x,i)=>x+i.price,0)-e.total)<0.01?'':e.total};location.hash='scan';render()}

/* ---------- photos & offline queue ---------- */
const online=()=>typeof navigator==='undefined'||navigator.onLine!==false;
const QDB={p:null,open(){if(!this.p)this.p=new Promise((res,rej)=>{try{const r=indexedDB.open('spare',1);r.onupgradeneeded=()=>r.result.createObjectStore('queue',{keyPath:'id'});r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}catch(e){rej(e)}});return this.p},
 async run(mode,fn){const db=await this.open();return new Promise((res,rej)=>{const t=db.transaction('queue',mode),q=fn(t.objectStore('queue'));t.oncomplete=()=>res(q&&q.result);t.onerror=()=>rej(t.error)})},
 put(x){return this.run('readwrite',s=>s.put(x))},all(){return this.run('readonly',s=>s.getAll())},del(id){return this.run('readwrite',s=>s.delete(id))}};
async function refreshQueue(){try{ui.queue=((await QDB.all())||[]).sort((a,b)=>a.at-b.at)}catch(e){ui.queue=ui.queue||[]}}
async function queueAdd(item){item={id:uid(),at:Date.now(),date:today(),...item};try{await QDB.put(item)}catch(e){ui.queue.push(item)}await refreshQueue();if(!ui.queue.find(q=>q.id===item.id))ui.queue.push(item)}
async function queueDel(id){try{await QDB.del(id)}catch(e){}ui.queue=ui.queue.filter(q=>q.id!==id);await refreshQueue()}
let qBusy=false;
async function processQueue(){if(qBusy||!AUTH.token||!online())return;await refreshQueue();const todo=ui.queue.filter(q=>!q.failed);if(!todo.length)return;qBusy=true;render();
 for(const it of todo){try{const j=await api('/api/scan',{method:'POST',body:{prompt:PARSE,...(it.images?{images:it.images}:{text:it.text})}});
   const d=toDraft(j,it.kind);if(!(j&&/^\d{4}-\d{2}-\d{2}$/.test(j.date)))d.date=it.date;
   const e=commitDraft(d,true);if(e)persist();await queueDel(it.id)}
  catch(e){if(e.offline||e.status===429)break;it.failed=true;try{await QDB.put(it)}catch(x){}}}
 qBusy=false;await refreshQueue();render()}
async function addPhotos(files){for(const f of [...files].slice(0,4-ui.photos.length)){try{ui.photos.push(await toDataURL(await shrink(f)))}catch(e){}}ui.err='';render()}

/* ---------- bank import ---------- */
function loadScript(src){return new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.onload=res;s.onerror=rej;document.head.appendChild(s)})}
async function readBankFile(file){const name=(file.name||'').toLowerCase();
 if(/\.xlsx?$/.test(name)||/sheet|excel/.test(file.type||'')){if(!window.XLSX)await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
  const wb=window.XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:false,raw:false});return window.XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]],{FS:';',blankrows:false})}
 const buf=await file.arrayBuffer();try{return new TextDecoder('utf-8',{fatal:true}).decode(buf)}catch(e){return new TextDecoder('windows-1252').decode(buf)}}
async function aiMapping(text){const prompt=`These are the first lines of a bank statement export (line number: content). Work out how to read it.
${window.SpareBank.sample(text)}
Return ONLY JSON: {"delimiter":";" or "," or "\\t" or "|","headerRow":line number of the column headers or -1,"columns":{"date":index,"amount":index or null,"debit":index or null,"credit":index or null,"sign":index of a debit/credit indicator column or null,"desc":[indexes of the counterparty name and description columns, most useful first]}}
Column indexes start at 0. Use "amount" for a single signed amount column, otherwise "debit"/"credit". Never use a balance column.`;
 return api('/api/tips',{method:'POST',body:{prompt}})}
async function bankFile(file){ui.bankBusy=true;ui.bankErr='';render();
 try{const text=await readBankFile(file);let r=window.SpareBank.parse(text);
  if(!r.ok||!r.rows.length){const m=await aiMapping(text).catch(()=>null);if(m&&m.columns)r=window.SpareBank.parseWithMapping(text,m)}
  if(!r.ok||!r.rows.length)throw new Error(T('Couldn\'t find dates and amounts in this file. Try another export format (CSV or CAMT.053) from your bank.'));
  const out=r.rows.filter(x=>x.amount<0),income=r.rows.length-out.length;
  const seen=new Set(S.entries.map(e=>e.bank).filter(Boolean));
  const billWords=S.bills.flatMap(b=>norm(b.name).split(/[^a-z0-9]+/).filter(w=>w.length>=4));
  for(const x of out){x.h=hash(x.date+'|'+x.amount+'|'+norm(x.desc));
   const d=norm(x.desc+' '+x.label);
   x.why=seen.has(x.h)?'seen':S.entries.some(e=>e.kind!=='bank'&&Math.abs(e.total+x.amount)<0.02&&Math.abs(dayDiff(e.date,x.date))<=2)?'scanned':billWords.some(w=>d.includes(w))?'bill':x.transfer?'transfer':x.cash?'cash':'';
   x.inc=!x.why||x.why==='cash';if(x.why==='cash')x.label=x.label||T('Cash withdrawal')}
  ui.bank={format:r.format,rows:out,income}}
 catch(e){ui.bankErr=e.status===429?e.message:e.offline?T('You\'re offline.'):(e.message||T('Couldn\'t read that file.'))}
 ui.bankBusy=false;render()}
function importBank(){const sel=ui.bank.rows.filter(r=>r.inc);let total=0;
 for(const r of sel){const amt=r2(-r.amount);total+=amt;S.entries.push({id:uid(),date:r.date,store:r.label,kind:'bank',bank:r.h,items:[{name:r.label,price:amt,cat:r.cat,pref:CATPREF[r.cat]||'want'}],total:amt})}
 S.flash={at:Date.now(),kind:'bank',n:sel.length,total:r2(total)};afterSpend();ui.bank=null;persist();location.hash='overview';render()}

/* ---------- savings ideas ---------- */
async function getTips(){ui.tipsBusy=true;ui.tipsErr='';render();
 const since=iso(new Date(Date.now()-60*864e5)),agg={};
 for(const e of S.entries.filter(e=>e.date>=since))for(const i of e.items){const k=norm(i.name);agg[k]=agg[k]||{n:i.name,c:0,t:0,cat:i.cat,p:i.pref,s:new Set()};agg[k].c++;agg[k].t+=i.price;if(e.store)agg[k].s.add(storeOf(e.store).name)}
 const lines=Object.values(agg).sort((a,b)=>b.t-a.t).slice(0,50).map(a=>`- ${a.n} — ${a.c}× — €${a.t.toFixed(2)} — ${a.cat} — ${a.p} — ${[...a.s].join('/')}`).join('\n')||'(no receipts logged yet)';
 const prompt=`You are a practical, frugal budgeting coach for someone living in Belgium.
Net income €${S.settings.income}/month. Savings goal €${targetFor(mkey())}/month (rises each month it is hit). Next shopping-trip cap €${tripCap()}.
Bills: ${S.bills.map(b=>`${b.name} €${b.amount} ${({m:'monthly',q:'quarterly',y:'yearly'})[b.freq]}`).join('; ')||'none listed'}.
Purchases in the last 60 days (name — times — total — category — need/want — stores):
${lines}
Give 5 concrete savings suggestions grounded in this data: e.g. buy a product at the cheaper store where it was already bought, swap a brand for a discount own brand (Colruyt Boni, Aldi, Lidl), buy in bulk, cut or reduce a recurring "want", downgrade or pause a subscription if a cheaper plan exists. Do not invent purchases that are not listed. Estimate the monthly saving in euros conservatively.
Write "title" and "detail" in ${LANGPROMPT[LANG]}.
Return ONLY JSON: [{"title":"short","detail":"one or two sentences","monthly":number}]`;
 try{const j=await api('/api/tips',{method:'POST',body:{prompt}});const items=(Array.isArray(j)?j:j&&j.items||[]).slice(0,6).map(t=>({title:String(t.title||''),detail:String(t.detail||''),monthly:r2(num(t.monthly))}));
  S.tips={at:Date.now(),items};persist()}
 catch(e){ui.tipsErr=e.status===429?e.message:e.offline?T('You\'re offline.'):T('Couldn\'t get ideas right now.')}
 ui.tipsBusy=false;render()}

/* ---------- events ---------- */
if($){
$.addEventListener('click',ev=>{const t=ev.target.closest('[data-act]');if(!t||t.tagName==='INPUT'||t.tagName==='SELECT')return;const a=t.dataset.act,id=t.dataset.id,i=+t.dataset.i;
 if(a==='dismiss'){S.notice=null;persist();render()}
 else if(a==='tips')getTips();
 else if(a==='paste'){const v=(document.getElementById('paste').value||'').trim();if(v)parse({text:v},'online')}
 else if(a==='manual'){ui.draft={store:'',date:today(),kind:t.dataset.kind,items:[{name:'',price:'',qty:1,cat:t.dataset.kind==='online'?'other':'groceries',pref:t.dataset.kind==='online'?'want':'need'}],total:''};render()}
 else if(a==='pref'){const it=ui.draft.items[i];it.pref=it.pref==='need'?'want':'need';render()}
 else if(a==='rmitem'){ui.draft.items.splice(i,1);render()}
 else if(a==='additem'){ui.draft.items.push({name:'',price:'',qty:1,cat:'groceries',pref:'need'});render()}
 else if(a==='save')saveDraft();
 else if(a==='discard'){ui.draft=null;render()}
 else if(a==='bkall'||a==='bknone'){ui.bank.rows.forEach(r=>r.inc=a==='bkall');render()}
 else if(a==='bkmonth'){const mk=mkey();ui.bank.rows.forEach(r=>r.inc=mkey(r.date)===mk&&(!r.why||r.why==='cash'));render()}
 else if(a==='bkgo')importBank();
 else if(a==='phrm'){ui.photos.splice(i,1);render()}
 else if(a==='phclear'){ui.photos=[];render()}
 else if(a==='phread'){if(ui.photos.length)parse({images:[...ui.photos]},'shop')}
 else if(a==='phlater'){const imgs=[...ui.photos];ui.photos=[];queueAdd({images:imgs,kind:'shop'}).then(()=>{ui.err='';render();processQueue()})}
 else if(a==='qdel'){queueDel(id).then(render)}
 else if(a==='qretry'){const q=ui.queue.find(x=>x.id===id);if(q){q.failed=false;(async()=>{try{await QDB.put(q)}catch(e){}processQueue()})()}}
 else if(a==='qhand'){queueDel(id).then(()=>{ui.draft={store:'',date:today(),kind:'shop',items:[{name:'',price:'',qty:1,cat:'groceries',pref:'need'}],total:''};render()})}
 else if(a==='edit')editEntry(id);
 else if(a==='trophyok'){const st=stats();S.trophiesSeen=TROPHIES.filter(t=>t[4](st)).map(t=>t[0]);persist();render()}
 else if(a==='storedone'){const PI=priceIndex(),cart=S.list.filter(x=>x.done);ui.draft={store:ui.storeName||'',date:today(),kind:'shop',items:cart.map(x=>{const p=findProd(PI,x.name),src=p&&S.entries.flatMap(e=>e.items).find(it=>prodKey(it)===p.key);const cat=src?src.cat:'groceries';return{name:x.name,price:num(x.price),qty:1,cat,pref:x.pref,gen:p?p.key:''}}),total:''};location.hash='scan';render()}
 else if(a==='storescan'){location.hash='scan';render()}
 else if(a==='bkcancel'){ui.bank=null;render()}
 else if(a==='lpref'){const it=S.list.find(x=>x.id===id);it.pref=it.pref==='need'?'want':'need';S.prefs[norm(it.name)]=it.pref;persist();render()}
 else if(a==='lrm'){S.list=S.list.filter(x=>x.id!==id);persist();render()}
 else if(a==='lclear'){S.list=[];persist();render()}
 else if(a==='open'){ui.open=ui.open===id?null:id;ui.del=null;render()}
 else if(a==='del'){ui.del=id;render()}
 else if(a==='delno'){ui.del=null;render()}
 else if(a==='delyes'){S.entries=S.entries.filter(e=>e.id!==id);S.deleted=[...(S.deleted||[]),id];ui.del=null;ui.open=null;persist();render()}
 else if(a==='brm'){S.bills=S.bills.filter(b=>b.id!==id);persist();render()}
 else if(a==='badd'){S.bills.push({id:uid(),name:T('New bill'),amount:0,freq:'m'});persist();render()}
 else if(a==='notifon'){notifAllowed(true).then(()=>{scheduleNotifs();render()})}
 else if(a==='export'){const p=navigator.clipboard&&navigator.clipboard.writeText(JSON.stringify(S));if(p)p.then(()=>{ui.copied=true;render();setTimeout(()=>{ui.copied=false;render()},2000)}).catch(()=>{})}
 else if(a==='imp'){ui.imp=!ui.imp;render()}
 else if(a==='impgo'){try{const s=JSON.parse(document.getElementById('impt').value);if(!s||!s.settings||!Array.isArray(s.entries))throw 0;
  if(typeof s.notice==='string')s.notice=null;S=migrate(s);ui.imp=false;persist();render()}catch(e){const x=document.getElementById('impt');if(x)x.style.borderColor='var(--bad)'}}
});
$.addEventListener('change',ev=>{const t=ev.target;
 if(t.dataset.act==='file'&&t.files&&t.files.length){addPhotos(t.files);return}
 if(t.dataset.act==='cart'){const it=S.list.find(x=>x.id===t.dataset.id);if(it){it.done=t.checked;persist();render()}return}
 if(t.dataset.act==='storename'){ui.storeName=t.value;render();return}
 if(t.dataset.act==='bankfile'&&t.files&&t.files[0]){bankFile(t.files[0]);return}
 if(t.dataset.act==='lang'){setLang(t.value);return}
 if(t.dataset.act==='bk'){ui.bank.rows[+t.dataset.i].inc=t.checked;render();return}
 if(t.dataset.bkcat!==undefined){ui.bank.rows[+t.dataset.bkcat].cat=t.value;return}
 if(t.dataset.notif){S.settings.notif={...S.settings.notif,[t.dataset.notif]:t.checked};if(t.checked)notifAllowed(true);persist();render();return}
 if(t.dataset.act==='done'){const it=S.list.find(x=>x.id===t.dataset.id);it.done=t.checked;persist();return}
 if(t.dataset.f&&ui.draft){if(t.dataset.i!==undefined){const it=ui.draft.items[+t.dataset.i];if(t.dataset.f==='cat'){it.cat=t.value;if(!S.prefs[norm(it.name)])it.pref=CATPREF[t.value]}else if(t.dataset.f==='name'){it.name=t.value;it.gen='';if(S.prefs[norm(t.value)])it.pref=S.prefs[norm(t.value)]}else it[t.dataset.f]=t.value}else ui.draft[t.dataset.f]=t.value;render();return}
 if(t.dataset.lprice){const it=S.list.find(x=>x.id===t.dataset.lprice);it.price=r2(num(t.value));persist();render();return}
 if(t.dataset.set){const k=t.dataset.set;S.settings[k]=Math.max(0,num(t.value));if(k==='target'){S.months[mkey()]={target:S.settings.target}}if(k==='trips')S.settings.trips=Math.max(1,Math.round(S.settings.trips));if(k==='foodShare')S.settings.foodShare=Math.min(100,S.settings.foodShare);persist();render();return}
 if(t.dataset.bill){const b=S.bills.find(x=>x.id===t.dataset.id);const k=t.dataset.bill;b[k]=k==='amount'?r2(num(t.value)):t.value;persist();render()}
});
$.addEventListener('input',ev=>{const t=ev.target;
 if(t.id==='lname'){const p=findProd(priceIndex(),t.value);const pe=document.getElementById('lprice');if(p&&pe&&!pe.value)pe.value=p.best.price}
 if(t.id==='pq'){ui.q=t.value;const q=norm(t.value);document.querySelectorAll('[data-pk]').forEach(el=>{el.style.display=!q||el.dataset.pk.includes(q)?'':'none'})}});
$.addEventListener('submit',ev=>{if(ev.target.dataset.form!=='add')return;ev.preventDefault();const n=document.getElementById('lname').value.trim();if(!n)return;
 const p=findProd(priceIndex(),n),pv=document.getElementById('lprice').value;const cat=p?(S.entries.flatMap(e=>e.items).find(i=>prodKey(i)===p.key)||{}).cat||'groceries':'groceries';
 S.list.push({id:uid(),name:n,price:pv?r2(num(pv)):(p?p.best.price:0),pref:prefOf(n,cat),done:false});persist();render();const x=document.getElementById('lname');if(x)x.focus()});
window.addEventListener('hashchange',()=>{ui.open=null;ui.del=null;render()});
}

/* ---------- account & sync ---------- */
const AK='spare-auth-v1';
let AUTH={token:null,email:null,api:'',serverAt:0};
try{Object.assign(AUTH,JSON.parse(localStorage.getItem(AK))||{})}catch(e){}
if(!AUTH.api)AUTH.api=(window.SPARE_API||'').replace(/\/$/,'');
const saveAuth=()=>{try{localStorage.setItem(AK,JSON.stringify(AUTH))}catch(e){}};
let authUi={mode:'login',err:'',busy:false,pw:null};

async function api(path,{method='GET',body}={}){let r;
 try{r=await fetch(AUTH.api+path,{method,headers:{'Content-Type':'application/json',...(AUTH.token?{Authorization:'Bearer '+AUTH.token}:{})},body:body?JSON.stringify(body):undefined})}
 catch(e){const x=new Error('offline');x.offline=true;throw x}
 let j=null;try{j=await r.json()}catch(e){}
 if(r.status===401&&AUTH.token&&!path.startsWith('/api/login')){AUTH.token=null;saveAuth();render()}
 if(!r.ok&&r.status!==409){const x=new Error((j&&j.error)||('HTTP '+r.status));x.status=r.status;throw x}
 return Array.isArray(j)?j:Object.assign(j||{},{_status:r.status})}

function mergeStates(a,b){ // a = local, b = server; newest wins for settings, tickets are combined
 const newer=(a.updatedAt||0)>=(b.updatedAt||0)?a:b,older=newer===a?b:a;
 const del=new Set([...(a.deleted||[]),...(b.deleted||[])]);
 const ents=new Map();for(const e of [...older.entries,...newer.entries])if(!del.has(e.id))ents.set(e.id,e);
 const m=migrate(JSON.parse(JSON.stringify(newer)));
 m.entries=[...ents.values()];m.deleted=[...del].slice(-500);m.prefs={...older.prefs,...newer.prefs};
 m.months={...older.months,...newer.months};m.updatedAt=Math.max(a.updatedAt||0,b.updatedAt||0);return m}

async function pull(){if(!AUTH.token)return;try{const r=await api('/api/state');AUTH.admin=!!r.admin;if(ui.pulling){ui.pulling=false}
  if(r.data){const local=S,hadLocal=S.entries.length||S.updatedAt>AUTH.serverAt;
   S=hadLocal&&AUTH.serverAt!==r.updatedAt?mergeStates(local,migrate(r.data)):migrate(r.data);AUTH.serverAt=r.updatedAt;saveAuth();rollover();localSave();
   sync='synced';render();if(hadLocal&&S.updatedAt>r.updatedAt)schedulePush(0)}
  else{sync='synced';render();schedulePush(0)}
  scheduleNotifs();processQueue()}
 catch(e){sync=e.offline?'offline':sync;if(ui.pulling){ui.pulling=false;render()}status()}}

function schedulePush(delay=900){if(!AUTH.token)return;clearTimeout(pubT);sync='saving';status();pubT=setTimeout(push,delay)}
async function push(tries=0){try{const r=await api('/api/state',{method:'PUT',body:{data:S,base:AUTH.serverAt}});
  if(r._status===409&&r.conflict&&tries<3){S=mergeStates(S,migrate(r.data));AUTH.serverAt=r.updatedAt;saveAuth();localSave();render();return push(tries+1)}
  if(r.updatedAt){AUTH.serverAt=r.updatedAt;saveAuth();sync='synced'}status()}
 catch(e){sync=e.offline?'offline':'error';status();clearTimeout(pubT);pubT=setTimeout(push,30000)}}

if(typeof window.addEventListener==='function'){window.addEventListener('online',()=>{if(AUTH.token){schedulePush(0);processQueue()}render()});window.addEventListener('offline',()=>render())}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&AUTH.token&&sync!=='saving')pull()});

function toDataURL(blob){return new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=rej;fr.readAsDataURL(blob)})}

function langPicker(){return `<select data-act="lang" style="width:auto;padding:6px 8px;font-size:13px;float:right">${Object.keys(LOCALES).map(l=>`<option value="${l}" ${l===LANG?'selected':''}>${LANGNAME[l]}</option>`).join('')}</select>`}
function renderAuth(){const m=authUi.mode,f=authUi.f||{};
 const title={login:T('Log in'),signup:T('Create account'),forgot:T('Reset password'),forgot2:T('Reset password')}[m];
 let fields='';
 if(m==='login'||m==='signup')fields=`<label class="f">${T('Email')}</label><input id="aemail" type="email" autocomplete="email" required value="${esc(f.email||'')}">
 <label class="f">${T('Password')}${m==='signup'?' '+T('(8+ characters)'):''}</label><input id="apw" type="password" autocomplete="${m==='signup'?'new-password':'current-password'}" required minlength="${m==='signup'?8:1}">
 ${m==='signup'?`<label class="f">${T('Invite code')}</label><input id="ainv" autocapitalize="characters" autocomplete="off" placeholder="${T('From the person who invited you')}" value="${esc(f.invite||'')}">`:''}`;
 else if(m==='forgot')fields=`<div class="small mute">${T('Enter your email. If email is set up on this server you\'ll get a code; otherwise ask the person who invited you for a reset code.')}</div><label class="f">${T('Email')}</label><input id="aemail" type="email" autocomplete="email" required value="${esc(f.email||'')}">`;
 else fields=`${authUi.info?`<div class="note good small">${esc(authUi.info)}</div>`:''}<label class="f">${T('Email')}</label><input id="aemail" type="email" required value="${esc(f.email||'')}"><label class="f">${T('Reset code')}</label><input id="acode" autocapitalize="characters" autocomplete="one-time-code" required><label class="f">${T('New password')} ${T('(8+ characters)')}</label><input id="apw" type="password" autocomplete="new-password" required minlength="8">`;
 $.innerHTML=`<div class="auth">${langPicker()}${logo()}<h1>Spare</h1><div class="mute">${T('Scan tickets, squeeze a little more out of every trip.')}</div>
 <div class="tabs"><button class="${m==='login'?'':'ghost'}" data-auth="login">${T('Log in')}</button><button class="${m==='signup'?'':'ghost'}" data-auth="signup">${T('Create account')}</button></div>
 <form data-form="auth" class="card">${m.startsWith('forgot')?`<h2>${title}</h2>`:''}${fields}
 <details ${AUTH.api?'':'open'} style="margin-top:10px"><summary class="small mute">${T('Server')}</summary><input id="aapi" placeholder="https://spare.yourname.workers.dev" value="${esc(AUTH.api)}"><div class="tiny mute">${T('Leave empty on the website itself. The Android app needs the server\'s address.')}</div></details>
 ${authUi.err?`<div class="err">${esc(authUi.err)}</div>`:''}
 <div class="btns"><button ${authUi.busy?'disabled':''}>${authUi.busy?'<span class="spin"></span>':''}${m==='forgot'?T('Get a code'):m==='forgot2'?T('Set new password'):title}</button>
 ${m==='login'?`<button type="button" class="link" data-auth="forgot">${T('Forgot password?')}</button>`:''}${m.startsWith('forgot')?`<button type="button" class="link" data-auth="forgot2">${T('I have a code')}</button>`:''}</div></form>
 <div class="tiny mute">${T('New accounts need an invite code. Your tickets and settings are private to your account.')}</div></div>`}

if($){
$.addEventListener('click',ev=>{const t=ev.target.closest('[data-auth]');if(!t)return;const e=document.getElementById('aemail');authUi.f={...(authUi.f||{}),email:e?e.value:(authUi.f||{}).email};authUi.mode=t.dataset.auth;authUi.err='';authUi.info='';renderAuth()});
$.addEventListener('submit',async ev=>{if(ev.target.dataset.form!=='auth')return;ev.preventDefault();
 const g=id=>{const x=document.getElementById(id);return x?x.value:''};const m=authUi.mode;
 const email=g('aemail').trim(),password=g('apw');authUi.f={email,invite:g('ainv')};
 AUTH.api=g('aapi').trim().replace(/\/$/,'');saveAuth();
 authUi.busy=true;authUi.err='';renderAuth();
 try{
  if(m==='forgot'){const r=await api('/api/reset/request',{method:'POST',body:{email}});authUi.busy=false;authUi.mode='forgot2';
   authUi.info=r.emailed?T('If that account exists, a code is on its way to your inbox (check spam). It works for 1 hour.'):T('Email isn\'t set up on this server. Ask the person who invited you for a reset code.');renderAuth();return}
  const path=m==='login'?'/api/login':m==='signup'?'/api/signup':'/api/reset/confirm';
  const body=m==='forgot2'?{email,code:g('acode'),newPassword:password}:{email,password,invite:g('ainv')};
  const r=await api(path,{method:'POST',body});
  AUTH.token=r.token;AUTH.email=r.email;AUTH.serverAt=-1;saveAuth();authUi.busy=false;authUi.f={};ui.pulling=true;render();await pull();if(ui.pulling){ui.pulling=false;render()}}
 catch(e){authUi.busy=false;authUi.err=e.offline?T('Can\'t reach the server. Check the address and your connection.'):e.message;renderAuth()}});
}

/* ---------- first-run setup ---------- */
const QUICK=[['Rent','m'],['Electricity','m'],['Gas / heating','m'],['Water','q'],['Internet','m'],['Phone','m'],['Health insurance / mutuality','m'],['Home insurance','y'],['Transport','m'],['Streaming / music','m']];
function renderSetup(){const s=S.settings,cm=commit(),liv=r2(s.income-cm-s.target);
 const f=(k,l,h)=>`<div><label class="f">${l}</label><input class="num" inputmode="decimal" data-set="${k}" value="${s[k]||''}" placeholder="0">${h?`<div class="tiny mute">${h}</div>`:''}</div>`;
 const have=new Set(S.bills.map(b=>norm(b.name)));
 const chips=QUICK.filter(q=>!have.has(norm(T(q[0])))).map(q=>`<button class="ghost" style="padding:6px 10px;font-size:13px" data-act="bquick" data-name="${esc(T(q[0]))}" data-freq="${q[1]}">+ ${esc(T(q[0]))}</button>`).join('');
 $.innerHTML=`<div class="top"><h1>${T('Welcome')}</h1>${langPicker()}</div>
 <div class="card"><h2>${T('Your month')}</h2><div class="small mute">${T('Spare works out how much you can spend after bills and savings, then makes each shopping trip a little tighter.')}</div>
 <div class="grid2">${f('income',T('Monthly income after tax (€)'))}${f('target',T('Savings goal per month (€)'),T('It rises a little each month you hit it.'))}</div></div>
 <div class="card"><h2>${T('Bills')}</h2><div class="small mute" style="margin-bottom:8px">${T('Everything that leaves your account on its own. Pick a frequency for bills that aren\'t monthly.')}</div>${billRows(true)}
 <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">${chips}<button class="ghost" style="padding:6px 10px;font-size:13px" data-act="badd">+ ${T('Other')}</button></div></div>
 <div class="card"><div class="row"><span>${T('Income')}</span><span class="num">${fmt(s.income)}</span></div><div class="row"><span>${T('Bills (monthly average)')}</span><span class="num">−${fmt(cm)}</span></div><div class="row"><span>${T('Savings goal')}</span><span class="num">−${fmt(s.target)}</span></div><div class="row"><b>${T('Left to live on')}</b><b class="num" style="color:${liv<0?'var(--bad)':'inherit'}">${fmt(liv)}</b></div>
 ${ui.setupErr?`<div class="err">${esc(ui.setupErr)}</div>`:''}<div class="btns"><button class="acc" data-act="setupdone">${T('Start saving')}</button><button class="link" data-act="logout">${T('Log out')}</button></div>
 <div class="tiny mute" style="margin-top:6px">${T('You can change all of this later in Settings.')}</div></div>
 <div class="card"><div class="small mute">${T('Already using the claude.ai version? There, Settings → Copy backup, then paste it here.')}</div>${ui.imp?`<textarea id="impt" placeholder="${T('Paste backup here')}"></textarea><div class="btns"><button data-act="impgo">${T('Restore this backup')}</button></div>`:`<div class="btns"><button class="ghost" data-act="imp">${T('Paste a backup')}</button></div>`}</div>`;status()}

/* ---------- admin ---------- */
async function loadAdmin(){try{ui.admin={...(ui.admin||{}),...(await api('/api/admin/overview')),loading:false}}catch(e){ui.admin={...(ui.admin||{}),err:e.message,loading:false}}render()}
function adminCard(){const a=ui.admin;if(!a){ui.admin={loading:true};loadAdmin();return `<div class="card"><h2>${T('Invites & people')}</h2><span class="spin"></span></div>`}
 const d=t=>t?new Date(t).toLocaleDateString(LOCALES[LANG],{day:'numeric',month:'short'}):T('never');
 const inv=(a.invites||[]).map(i=>`<div class="row small"><span><b class="num">${esc(i.code)}</b> ${esc(i.note)} <span class="mute">${T('{0}/{1} used',i.uses,i.max_uses)}</span></span><span><button class="link" data-act="invcopy" data-code="${esc(i.code)}">${a.copied===i.code?T('Copied ✓'):T('Copy')}</button><button class="link" data-act="invdel" data-code="${esc(i.code)}">×</button></span></div>`).join('');
 const users=(a.users||[]).map((u,k)=>`<div class="row small"><span>${esc(u.email)} ${k===0?`<span class="tag ok">${T('admin')}</span>`:''}<br><span class="tiny mute">${T('joined {0} · last sync {1}',d(u.created_at),d(u.synced))}</span></span>${k===0?'':`<span>${a.reset&&a.reset.email===u.email?`<b class="num">${esc(a.reset.code)}</b>`:`<button class="link" data-act="ureset" data-email="${esc(u.email)}">${T('Reset code')}</button>`}</span>`}</div>`).join('');
 return `<div class="card"><h2>${T('Invites & people')}</h2><div class="small mute">${T('You\'re the admin. New accounts need one of these codes.')}</div>
 <div style="display:grid;grid-template-columns:1fr 70px auto;gap:8px;margin-top:10px"><input id="invnote" placeholder="${T('Who is it for? (optional)')}"><input id="invuses" class="num" inputmode="numeric" value="1" title="${T('How many accounts can use it')}"><button data-act="invnew">${T('New code')}</button></div>
 <div style="margin-top:8px">${inv||`<div class="tiny mute">${T('No codes yet.')}</div>`}</div>
 <h3 style="margin-top:14px">${T('People ({0})',(a.users||[]).length)}</h3>${users}
 ${a.reset?`<div class="note good small">${T('Give this code to {0}: on the login screen they tap "Forgot password?" then "I have a code". It works for 24 hours.',esc(a.reset.email))}</div>`:''}${a.err?`<div class="err">${esc(a.err)}</div>`:''}</div>`}

function accountCard(){const p=authUi.pw;return `<div class="card"><h2>${T('Account')}</h2><div class="row"><span class="mute">${T('Signed in as')}</span><span>${esc(AUTH.email||'')}</span></div>
 ${p?`<label class="f">${T('Current password')}</label><input id="pwold" type="password"><label class="f">${T('New password')}</label><input id="pwnew" type="password" minlength="8">${p.err?`<div class="err">${esc(p.err)}</div>`:''}${p.ok?`<div class="note good small">${T('Password changed.')}</div>`:''}<div class="btns"><button data-act="pwgo">${T('Change password')}</button><button class="link" data-act="pwcancel">${T('Cancel')}</button></div>`
 :`<div class="btns"><button class="ghost" data-act="sync">${T('Sync now')}</button><button class="ghost" data-act="pwopen">${T('Change password')}</button><button class="ghost" data-act="logout">${T('Log out')}</button></div>`}</div>`}

if($)$.addEventListener('click',async ev=>{const t=ev.target.closest('[data-act]');if(!t||t.tagName==='SELECT'||t.tagName==='INPUT')return;const a=t.dataset.act;
 if(a==='bquick'){S.bills.push({id:uid(),name:t.dataset.name,amount:0,freq:t.dataset.freq});persist();render()}
 else if(a==='setupdone'){if(!(S.settings.income>0)){ui.setupErr=T('Enter your monthly income first.');return render()}ui.setupErr='';S.bills=S.bills.filter(b=>b.amount>0);S.setupDone=true;S.months[mkey()]={target:S.settings.target};persist();location.hash='overview';render()}
 else if(a==='invnew'){try{await api('/api/admin/invite',{method:'POST',body:{note:document.getElementById('invnote').value,uses:+document.getElementById('invuses').value||1}});ui.admin.copied=null;await loadAdmin()}catch(e){ui.admin.err=e.message;render()}}
 else if(a==='invdel'){await api('/api/admin/invite/delete',{method:'POST',body:{code:t.dataset.code}}).catch(()=>{});loadAdmin()}
 else if(a==='invcopy'){const c=t.dataset.code;try{await navigator.clipboard.writeText(c)}catch(e){}ui.admin.copied=c;render()}
 else if(a==='ureset'){try{const r=await api('/api/admin/reset',{method:'POST',body:{email:t.dataset.email}});ui.admin.reset={email:t.dataset.email,code:r.code};render()}catch(e){ui.admin.err=e.message;render()}}
 else if(a==='sync')pull();
 else if(a==='pwopen'){authUi.pw={};render()}
 else if(a==='pwcancel'){authUi.pw=null;render()}
 else if(a==='pwgo'){try{await api('/api/password',{method:'POST',body:{oldPassword:document.getElementById('pwold').value,newPassword:document.getElementById('pwnew').value}});authUi.pw={ok:true};render();setTimeout(()=>{authUi.pw=null;render()},2500)}catch(e){authUi.pw={err:e.offline?T('You\'re offline.'):e.message};render()}}
 else if(a==='logout'){try{await api('/api/logout',{method:'POST'})}catch(e){}const ln=LN();if(ln)try{const p=await ln.getPending();if(p.notifications.length)await ln.cancel({notifications:p.notifications.map(n=>({id:n.id}))})}catch(e){}
  AUTH.token=null;AUTH.serverAt=0;AUTH.admin=false;ui.admin=null;saveAuth();try{localStorage.removeItem(LSK)}catch(e){}S=defaults();rollover();render()}});

load();rollover();refreshQueue().then(render);render();if(AUTH.token){pull();notifAllowed(false).then(()=>{if(view()==='settings')render()})}
