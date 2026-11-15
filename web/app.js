
const LSK='spare-budget-state-v1';
const CATS=[['groceries','Groceries','need'],['cat','Cat','need'],['household','Household','need'],['hygiene','Hygiene','need'],['snacks','Snacks & sweets','want'],['drinks','Drinks','want'],['eatout','Eating out','want'],['clothing','Clothing','want'],['tech','Tech & media','want'],['leisure','Leisure','want'],['other','Other','want']];
const CATNAME=Object.fromEntries(CATS.map(c=>[c[0],c[1]])),CATPREF=Object.fromEntries(CATS.map(c=>[c[0],c[2]]));
const FREQ={m:'Monthly',q:'Every 3 months',y:'Yearly'};
const uid=()=>Math.random().toString(36).slice(2,10);
const r2=n=>Math.round((+n||0)*100)/100;
const num=v=>{const x=parseFloat(String(v??'').replace(',','.').replace(/[^\d.\-]/g,''));return isFinite(x)?x:0};
const EUR=new Intl.NumberFormat('fr-BE',{style:'currency',currency:'EUR'});
const fmt=n=>EUR.format(r2(n));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=s=>String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
function today(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
const mkey=ds=>String(ds||today()).slice(0,7);
const mname=(mk,short)=>new Date(mk+'-01T12:00:00').toLocaleDateString('en-GB',short?{month:'short'}:{month:'long',year:'numeric'});
function daysLeft(){const d=new Date();return new Date(d.getFullYear(),d.getMonth()+1,0).getDate()-d.getDate()+1}

function defaults(){return{v:1,updatedAt:0,
 settings:{income:1300,target:500,monthlyStep:10,tripStep:0.5,trips:8,foodShare:75,minCap:15},
 bills:[['Tidal',22,'m'],['Mutuality',14.5,'m'],['FGTB',12,'m'],['Claude Pro',20,'m'],['Web access (Hong Kong)',7,'m'],['Electricity (max)',65,'m'],['Internet + phone',50,'m'],['Water bill (estimate, edit me)',60,'q'],['Discord',100,'y'],['Cloudflare',12,'y']].map(([name,amount,freq])=>({id:uid(),name,amount,freq})),
 entries:[],deleted:[],prefs:{},list:[],cur:{month:null,level:0},months:{},tips:null,notice:null,flash:null}}
function migrate(s){const d=defaults();for(const k in d)if(s[k]===undefined)s[k]=d[k];for(const k in d.settings)if(s.settings[k]===undefined)s.settings[k]=d.settings[k];return s}

let S,sync='idle',pubT=null;const SAMPLE=true,canImg=true;
let ui={draft:null,busy:false,err:'',open:null,del:null,tipsBusy:false,tipsErr:'',copied:false,imp:false};

function load(){let emb=null,loc=null;try{emb=JSON.parse(document.getElementById('state').textContent)}catch(e){}
 try{loc=JSON.parse(localStorage.getItem(LSK))}catch(e){}
 let s=emb;if(loc&&(!s||(loc.updatedAt||0)>(s.updatedAt||0)))s=loc;S=migrate(s||defaults())}
function localSave(){try{localStorage.setItem(LSK,JSON.stringify(S))}catch(e){}}
function persist(){S.updatedAt=Date.now();localSave();schedulePush()}
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
 if(!S.cur.month){S.cur={month:mk,level:0};S.months[mk]={target:S.settings.target};return}
 if(S.cur.month===mk){if(!S.months[mk])S.months[mk]={target:S.settings.target};return}
 const prev=S.cur.month,t=targetFor(prev),saved=savedFor(prev);
 if(saved>=t){S.settings.target=r2(S.settings.target+S.settings.monthlyStep);
  S.notice=`${mname(prev)}: you saved ${fmt(saved)} (goal ${fmt(t)}). New goal: ${fmt(S.settings.target)} — ${fmt(S.settings.monthlyStep)} more than last month.`}
 else S.notice=`${mname(prev)}: you saved ${fmt(saved)}, short of your ${fmt(t)} goal. The goal stays at ${fmt(S.settings.target)} this month.`;
 S.cur={month:mk,level:0};S.months[mk]={target:S.settings.target};S.updatedAt=Date.now();localSave()}

function cutsFor(items,over){const w=items.filter(i=>i.pref==='want'&&i.price>0);
 const one=w.filter(i=>i.price>=over).sort((a,b)=>a.price-b.price)[0];if(one)return{cuts:[one],short:0};
 const g=[...w].sort((a,b)=>b.price-a.price),out=[];let s=0;for(const i of g){if(s>=over)break;out.push(i);s+=i.price}
 return{cuts:out,short:r2(Math.max(0,over-s))}}

function planList(cap){const needs=S.list.filter(i=>i.pref==='need'),wants=S.list.filter(i=>i.pref!=='need');let cum=0;const res={};
 for(const i of [...needs,...wants]){const p=num(i.price);if(cum+p<=cap+1e-9){cum+=p;res[i.id]={fits:true,cum}}else res[i.id]={fits:false,short:r2(cum+p-cap)}}
 return{res,total:r2(cum),needsTotal:r2(needs.reduce((a,i)=>a+num(i.price),0)),all:r2(S.list.reduce((a,i)=>a+num(i.price),0))}}

function lastPrices(){const m={};for(const e of [...S.entries].sort((a,b)=>a.date<b.date?-1:1))for(const it of e.items)m[norm(it.name)]={name:it.name,price:it.price,cat:it.cat};return m}

/* ---------- render ---------- */
const $=document.getElementById('root');
const view=()=>{const h=location.hash.slice(1);return['overview','scan','list','history','settings'].includes(h)?h:'overview'};
function status(){const el=document.getElementById('sync');if(el)el.innerHTML=({saving:'<span class="spin"></span>Syncing…',synced:'✓ Synced',offline:'Offline — will sync',error:'Sync problem — retrying',idle:''})[sync]||''}
function render(){if(!AUTH.token)return renderAuth();const v=view();
 const nav=[['overview','◔','Overview'],['scan','⊡','Scan'],['list','☰','List'],['history','↺','History'],['settings','⚙','Settings']].map(([k,i,t])=>`<a href="#${k}" class="${v===k?'on':''}"><b>${i}</b>${t}</a>`).join('');
 $.innerHTML=`<div class="top"><h1>Spare</h1><span class="status" id="sync"></span></div>${({overview:vOverview,scan:vScan,list:vList,history:vHistory,settings:vSettings})[v]()}<nav>${nav}</nav>`;status()}

function flashHtml(){const f=S.flash;if(!f||Date.now()-f.at>10*60*1000)return'';
 if(f.kind==='online')return`<div class="note good">Saved ${fmt(f.total)} of online spending. ${fmt(f.left)} left for living this month.</div>`;
 if(f.under)return`<div class="note good"><b>Under the cap by ${fmt(f.cap-f.total)}.</b> Your next trip cap is ${fmt(f.next)} — ${fmt(S.settings.tripStep)} tighter. Keep it going.</div>`;
 return`<div class="note bad"><b>${fmt(f.total-f.cap)} over the ${fmt(f.cap)} cap.</b> ${f.cuts.length?'Leaving '+f.cuts.map(c=>esc(c.name)+' ('+fmt(c.price)+')').join(', ')+' on the shelf would have kept you under.':'Everything on it was a need — consider raising the minimum cap in Settings.'} Next cap: ${fmt(f.next)}.</div>`}

function vOverview(){const mk=mkey(),inc=S.settings.income,cm=commit(),tg=targetFor(mk),liv=living(mk),sp=spentIn(mk),left=r2(liv-sp),dl=daysLeft(),cap=tripCap();
 const pct=liv>0?Math.min(100,sp/liv*100):100;
 const trips=entriesIn(mk).filter(e=>e.kind==='shop'&&e.cap!=null),bonus=r2(trips.reduce((a,e)=>a+Math.max(0,e.cap-e.total),0));
 const cats={};let wantSum=0;const wantItems={};
 for(const e of entriesIn(mk))for(const it of e.items){cats[it.cat]=(cats[it.cat]||0)+it.price;if(it.pref==='want'){wantSum+=it.price;const k=norm(it.name);wantItems[k]=wantItems[k]||{name:it.name,t:0,n:0};wantItems[k].t+=it.price;wantItems[k].n++}}
 const diff=r2(sp-entriesIn(mk).reduce((a,e)=>a+e.items.reduce((x,i)=>x+i.price,0),0));if(diff>0.01)cats.other=(cats.other||0)+diff;
 const cmax=Math.max(1,...Object.values(cats));
 const catRows=Object.entries(cats).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`<div class="hbar"><span>${esc(CATNAME[c]||c)}</span><span class="t"><i class="${CATPREF[c]==='want'?'want':''}" style="width:${v/cmax*100}%"></i></span><span class="num" style="text-align:right">${fmt(v)}</span></div>`).join('');
 const leaks=Object.values(wantItems).sort((a,b)=>b.t-a.t).slice(0,5).map(w=>`<div class="row"><span>${esc(w.name)} <span class="mute small">×${w.n}</span></span><span class="num">${fmt(w.t)}</span></div>`).join('');
 const mks=[...new Set([...Object.keys(S.months),mk])].sort().slice(-6);const vals=mks.map(m=>({m,s:Math.max(0,m===mk?r2(inc-cm-sp):savedFor(m)),t:targetFor(m)}));const vmax=Math.max(1,...vals.map(x=>Math.max(x.s,x.t)));
 const cols=vals.map(x=>`<div class="c"><span class="num">${Math.round(x.s)}</span><i class="${x.m!==mk&&x.s<x.t?'miss':''}" style="height:${x.s/vmax*80}px;${x.m===mk?'opacity:.45':''}"></i>${mname(x.m,1)}</div>`).join('');
 const plan=planList(cap),noFit=S.list.filter(i=>plan.res[i.id]&&!plan.res[i.id].fits);
 let tips='';if(S.tips&&S.tips.items)tips=S.tips.items.map(t=>`<div class="tip"><div class="row" style="padding:0"><h3>${esc(t.title)}</h3><span class="num" style="color:var(--acc)">~${fmt(t.monthly)}/mo</span></div><div class="small mute">${esc(t.detail)}</div></div>`).join('');
 return `${S.notice?`<div class="note good">${esc(S.notice)} <button class="link" data-act="dismiss">Dismiss</button></div>`:''}${flashHtml()}
 <div class="card hero"><div class="mute small">Left to live on in ${mname(mk)}</div><div class="big ${left<0?'':''}" style="color:${left<0?'var(--bad)':'inherit'}">${fmt(left)}</div>
 <div class="bar ${left<0?'over':''}"><i style="width:${pct}%"></i></div><div class="small mute">${fmt(sp)} spent of ${fmt(liv)} · ${dl} day${dl>1?'s':''} left · <b class="num" style="color:var(--ink)">${fmt(Math.max(0,left)/dl)}</b>/day</div>
 <div class="grid2" style="margin-top:14px"><div class="stat"><div class="tiny mute">Savings goal</div><div class="v">${fmt(tg)}</div><div class="tiny mute">${left>=0?'on track':'at risk — '+fmt(-left)+' short'}</div></div>
 <div class="stat"><div class="tiny mute">Next shopping trip cap</div><div class="v">${fmt(cap)}</div><div class="tiny mute">squeeze level ${S.cur.level} · −${fmt(S.settings.tripStep)} per win</div></div></div>
 ${bonus>0?`<div class="note good small" style="margin-bottom:0">Extra saved by staying under your trip caps: <b>${fmt(bonus)}</b> on top of the goal.</div>`:''}</div>
 ${noFit.length?`<div class="card"><h2>Not affordable on your next trip</h2>${noFit.map(i=>`<div class="row"><span>${esc(i.name)}</span><span class="small" style="color:var(--bad)">short by ${fmt(plan.res[i.id].short)}</span></div>`).join('')}<div class="tiny mute" style="margin-top:6px">From your shopping list. <a href="#list">Edit list</a></div></div>`:''}
 <div class="card"><h2>Where the money goes this month</h2>${catRows||'<div class="mute small">Nothing logged yet. Scan your first receipt.</div>'}${wantSum>0?`<div class="tiny mute" style="margin-top:6px">Orange = nice-to-haves: ${fmt(wantSum)} this month.</div>`:''}</div>
 ${leaks?`<div class="card"><h2>Biggest nice-to-haves</h2>${leaks}</div>`:''}
 <div class="card"><h2>Savings by month</h2><div class="cols">${cols}</div><div class="tiny mute" style="margin-top:6px">Current month is faded (in progress). Orange = goal missed.</div></div>
 <div class="card"><h2>Your month on paper</h2>
 <div class="row"><span>Income</span><span class="num">${fmt(inc)}</span></div>
 <div class="row"><span>Monthly bills</span><span class="num">−${fmt(fixedOnly())}</span></div>
 <div class="row"><span>Set aside for water &amp; yearly subs</span><span class="num">−${fmt(cm-fixedOnly())}</span></div>
 <div class="row"><span>Savings goal</span><span class="num">−${fmt(tg)}</span></div>
 <div class="row"><b>Left to live on</b><b class="num">${fmt(liv)}</b></div>
 <div class="tiny mute" style="margin-top:6px">Shopping trips get ${S.settings.foodShare}% of that over ${S.settings.trips} trips. Hit the goal and next month's goal rises by ${fmt(S.settings.monthlyStep)}.</div></div>
 <div class="card"><div class="row" style="padding:0 0 6px"><h2 style="margin:0">Savings ideas</h2>${SAMPLE?`<button class="ghost" data-act="tips" ${ui.tipsBusy?'disabled':''}>${ui.tipsBusy?'<span class="spin"></span>Thinking…':S.tips?'Refresh':'Get ideas'}</button>`:''}</div>
 ${tips||`<div class="small mute">${SAMPLE?'AI reads your last 60 days of receipts and bills and suggests specific cuts and swaps.':'Available when the page can ask Claude.'}</div>`}${ui.tipsErr?`<div class="note bad small">${esc(ui.tipsErr)}</div>`:''}</div>`}

function vScan(){if(ui.draft)return vReview();
 return `${flashHtml()}<div class="card"><h2>Scan a receipt</h2>
 ${ui.busy?`<div class="note warn"><span class="spin"></span>Reading your receipt…</div>`:''}${ui.err?`<div class="note bad">${esc(ui.err)}</div>`:''}
 ${SAMPLE&&canImg?`<label class="drop"><input type="file" accept="image/*" capture="environment" data-act="file"><div class="ic">⊡</div><b>Take or choose a photo of the ticket</b><div class="small mute">Shop receipts or screenshots of online orders</div></label>`:`<div class="note warn small">Photo scanning needs this page to be able to ask Claude, which isn't available here. You can still paste text or enter tickets by hand.</div>`}
 </div>
 <div class="card"><h2>Online order</h2><div class="small mute">Paste the confirmation email or order summary.</div>
 <textarea id="paste" placeholder="Order #… 1× … €…"></textarea><div class="btns"><button data-act="paste" ${!SAMPLE||ui.busy?'disabled':''}>Read order</button></div></div>
 <div class="card"><h2>By hand</h2><div class="btns" style="margin-top:0"><button class="ghost" data-act="manual" data-kind="shop">Shop ticket</button><button class="ghost" data-act="manual" data-kind="online">Online purchase</button></div>
 <div class="tiny mute" style="margin-top:8px">Next shopping trip cap: <b class="num">${fmt(tripCap())}</b></div></div>`}

function draftSum(){return r2(ui.draft.items.reduce((a,i)=>a+num(i.price),0))}
function vReview(){const d=ui.draft,sum=draftSum(),tot=d.total===''||d.total==null?sum:num(d.total),cap=tripCap(),cur=mkey(d.date)===mkey();
 const opts=c=>CATS.map(([k,n])=>`<option value="${k}" ${k===c?'selected':''}>${n}</option>`).join('');
 const rows=d.items.map((it,i)=>`<tr><td><input data-f="name" data-i="${i}" value="${esc(it.name)}"></td><td class="c"><select data-f="cat" data-i="${i}">${opts(it.cat)}</select></td><td class="p"><input class="num" inputmode="decimal" data-f="price" data-i="${i}" value="${esc(it.price)}"></td><td><button class="pill ${it.pref}" data-act="pref" data-i="${i}">${it.pref==='need'?'Need':'Want'}</button></td><td><button class="link" data-act="rmitem" data-i="${i}">×</button></td></tr>`).join('');
 let check='';
 if(d.kind==='shop'&&cur){const over=r2(tot-cap);
  if(over<=0)check=`<div class="note good">${fmt(-over)} under your ${fmt(cap)} cap. Saving this tightens the next trip by ${fmt(S.settings.tripStep)}.</div>`;
  else{const c=cutsFor(d.items.map(i=>({...i,price:num(i.price)})),over);check=`<div class="note bad"><b>${fmt(over)} over your ${fmt(cap)} cap.</b> ${c.cuts.length?'Skip next time: '+c.cuts.map(x=>esc(x.name)+' ('+fmt(x.price)+')').join(', ')+'.':''}${c.short>0?' Even without every want you\'d be '+fmt(c.short)+' over.':''}</div>`}}
 return `<div class="card"><h2>Check the ticket</h2>
 <div class="grid2"><div><label class="f">Store</label><input data-f="store" value="${esc(d.store)}"></div><div><label class="f">Date</label><input type="date" data-f="date" value="${esc(d.date)}"></div></div>
 <label class="f">Type</label><select data-f="kind"><option value="shop" ${d.kind==='shop'?'selected':''}>Shopping trip (counts toward trip cap)</option><option value="online" ${d.kind==='online'?'selected':''}>Online / other spending</option></select>
 <label class="f">Items — tap Need/Want to teach the app what you can cut</label>
 <table class="items">${rows}</table><button class="link" data-act="additem">+ Add line</button>
 <div class="row" style="margin-top:8px"><span>Items add up to</span><span class="num">${fmt(sum)}</span></div>
 <div class="row"><span>Total paid</span><span style="width:110px"><input class="num" inputmode="decimal" data-f="total" value="${esc(d.total??'')}" placeholder="${sum.toFixed(2)}"></span></div>
 ${Math.abs(sum-tot)>0.01?`<div class="tiny mute">Difference of ${fmt(tot-sum)} (discounts, deposits…). The total paid is what counts.</div>`:''}
 ${check}<div class="btns"><button class="acc" data-act="save">Save ticket</button><button class="ghost" data-act="discard">Discard</button></div></div>`}

function vList(){const cap=tripCap(),p=planList(cap),lp=lastPrices();
 const items=[...S.list.filter(i=>i.pref==='need'),...S.list.filter(i=>i.pref!=='need')].map(i=>{const r=p.res[i.id]||{};return `<div class="li ${r.fits?'':'no'}"><input type="checkbox" data-act="done" data-id="${i.id}" ${i.done?'checked':''}><span class="nm">${esc(i.name)}</span><button class="pill ${i.pref}" data-act="lpref" data-id="${i.id}">${i.pref==='need'?'Need':'Want'}</button><input class="num" style="width:78px;padding:6px 8px" inputmode="decimal" data-lprice="${i.id}" value="${esc(i.price)}"><button class="link" data-act="lrm" data-id="${i.id}">×</button>${r.fits?'':`<span class="why">Doesn't fit this trip — short by ${fmt(r.short)}</span>`}</div>`}).join('');
 const dl=Object.values(lp).map(x=>`<option value="${esc(x.name)}">`).join('');
 return `<div class="card"><h2>Next trip</h2><div class="grid2"><div class="stat"><div class="tiny mute">Your cap</div><div class="v">${fmt(cap)}</div></div><div class="stat"><div class="tiny mute">What fits</div><div class="v">${fmt(p.total)}</div><div class="tiny mute">of ${fmt(p.all)} listed</div></div></div>
 ${p.needsTotal>cap?`<div class="note warn small">Your needs alone come to ${fmt(p.needsTotal)}, above the cap. Drop or swap something, or adjust the minimum cap in Settings.</div>`:''}
 <div class="small mute" style="margin-top:10px">Needs are counted first, then wants in the order you added them. Whatever doesn't fit gets struck out with the exact amount you're short.</div></div>
 <div class="card"><h2>Shopping list</h2><form data-form="add" style="display:grid;grid-template-columns:1fr 90px auto;gap:8px"><input id="lname" list="known" placeholder="Item (prices fill in from past tickets)" autocomplete="off"><input id="lprice" class="num" inputmode="decimal" placeholder="€"><button>Add</button></form><datalist id="known">${dl}</datalist>
 <div style="margin-top:10px">${items||'<div class="mute small">Empty. Add what you plan to buy.</div>'}</div>
 ${S.list.length?`<div class="btns"><button class="ghost" data-act="lclear">Clear list</button></div>`:''}</div>`}

function vHistory(){const by={};for(const e of S.entries){(by[mkey(e.date)]=by[mkey(e.date)]||[]).push(e)}
 const ms=Object.keys(by).sort().reverse();
 if(!ms.length)return `<div class="card"><h2>History</h2><div class="mute small">No tickets yet.</div></div>`;
 return ms.map(m=>{const es=by[m].sort((a,b)=>a.date<b.date?1:-1);return `<div class="card"><div class="row" style="padding:0 0 8px"><h2 style="margin:0">${mname(m)}</h2><span class="num">${fmt(es.reduce((a,e)=>a+e.total,0))}</span></div>
 ${es.map(e=>`<div class="entry"><div class="head" data-act="open" data-id="${e.id}"><span>${esc(e.store||'Ticket')} <span class="mute small">${e.date.slice(8)}/${e.date.slice(5,7)}</span>${e.kind==='online'?'<span class="tag">online</span>':e.cap!=null?`<span class="tag ${e.total<=e.cap?'ok':'no'}">${e.total<=e.cap?'under':'over'} ${fmt(e.cap)}</span>`:''}</span><span class="num">${fmt(e.total)}</span></div>
 ${ui.open===e.id?`<div style="margin-top:8px">${e.items.map(i=>`<div class="row small"><span>${esc(i.name)} <span class="tag">${esc(CATNAME[i.cat]||i.cat)}</span></span><span class="num">${fmt(i.price)}</span></div>`).join('')}
 <div class="btns">${ui.del===e.id?`<span class="small">Delete this ticket?</span><button class="ghost" data-act="delyes" data-id="${e.id}" style="color:var(--bad)">Delete</button><button class="link" data-act="delno">Cancel</button>`:`<button class="link" data-act="del" data-id="${e.id}">Delete ticket</button>`}</div></div>`:''}</div>`).join('')}</div>`}).join('')}

function vSettings(){const s=S.settings,f=(k,l,h)=>`<div><label class="f">${l}</label><input class="num" inputmode="decimal" data-set="${k}" value="${s[k]}">${h?`<div class="tiny mute">${h}</div>`:''}</div>`;
 const bills=S.bills.map(b=>`<div class="bill"><input data-bill="name" data-id="${b.id}" value="${esc(b.name)}"><input class="num" inputmode="decimal" data-bill="amount" data-id="${b.id}" value="${b.amount}"><select data-bill="freq" data-id="${b.id}">${Object.entries(FREQ).map(([k,v])=>`<option value="${k}" ${b.freq===k?'selected':''}>${v}</option>`).join('')}</select><button class="link" data-act="brm" data-id="${b.id}">×</button></div>`).join('');
 return accountCard()+`<div class="card"><h2>Money</h2><div class="grid2">${f('income','Monthly income (€)')}${f('target','Savings goal this month (€)')}${f('monthlyStep','Goal rises by (€) after a good month')}${f('tripStep','Trip cap shrinks by (€) per win')}${f('trips','Shopping trips per month')}${f('foodShare','% of living money for trips')}${f('minCap','Never squeeze a trip below (€)')}</div><div class="tiny mute" style="margin-top:8px">Changes save as you leave each field.</div></div>
 <div class="card"><h2>Bills</h2>${bills}<button class="link" data-act="badd">+ Add bill</button><div class="row" style="margin-top:8px"><span>Monthly equivalent</span><b class="num">${fmt(commit())}</b></div></div>
 <div class="card"><h2>Backup</h2><div class="small mute">Copy your data to keep it somewhere safe, or paste a backup to restore it.</div><div class="btns"><button class="ghost" data-act="export">${ui.copied?'Copied ✓':'Copy backup'}</button><button class="ghost" data-act="imp">Restore…</button></div>
 ${ui.imp?`<textarea id="impt" placeholder="Paste backup here"></textarea><div class="btns"><button data-act="impgo">Restore this backup</button></div>`:''}</div>`}

/* ---------- actions ---------- */
async function shrink(file){try{const bmp=await createImageBitmap(file),m=1600,sc=Math.min(1,m/Math.max(bmp.width,bmp.height));const c=document.createElement('canvas');c.width=Math.round(bmp.width*sc);c.height=Math.round(bmp.height*sc);c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);return await new Promise(r=>c.toBlob(b=>r(b||file),'image/jpeg',.85))}catch(e){return file}}
const PARSE=`You read a shopping receipt or an online order confirmation from Belgium (prices in EUR; text may be French, Dutch or English).
Return ONLY a JSON object, no prose:
{"store":string,"date":"YYYY-MM-DD" or null,"kind":"shop" or "online","items":[{"name":string,"price":number,"category":string}],"total":number}
Rules:
- "name": short readable product name (keep brand if shown, e.g. "Boni milk 1L").
- "price": what was actually paid for that line (quantity × unit price, minus any discount printed right under it). Negative only for a stand-alone discount line.
- "category": one of ${CATS.map(c=>c[0]).join(', ')}. Pet food/litter = cat. Alcohol, soda, juice, coffee = drinks. Chips, chocolate, cookies, candy = snacks. Restaurant/takeaway = eatout.
- "total": the final amount paid (TOTAL / À PAYER / TE BETALEN). Ignore VAT tables, payment card lines, loyalty points, change given.
- "kind": "online" for web orders/confirmation emails, otherwise "shop".`;
function toDraft(j,kind){const items=(Array.isArray(j&&j.items)?j.items:[]).map(i=>{const cat=CATNAME[i.category]?i.category:'other';return{name:String(i.name||'Item'),price:r2(num(i.price)),cat,pref:prefOf(i.name,cat)}});
 const d=/^\d{4}-\d{2}-\d{2}$/.test(j&&j.date)?j.date:today();
 return{store:String((j&&j.store)||''),date:d,kind:(j&&j.kind==='online')||kind==='online'?'online':'shop',items:items.length?items:[{name:'',price:'',cat:'groceries',pref:'need'}],total:j&&j.total!=null?r2(num(j.total)):''}}
async function parse(body,kind){ui.busy=true;ui.err='';render();
 try{const j=await api('/api/scan',{method:'POST',body:{prompt:PARSE,...body}});ui.draft=toDraft(j,kind)}
 catch(e){ui.err=e.offline?'You\'re offline — enter the ticket by hand, or scan it when you\'re back online.':'Couldn\'t read that ticket. Try a sharper, flatter photo, or enter it by hand.'}
 ui.busy=false;render()}

function saveDraft(){const d=ui.draft;const items=d.items.filter(i=>i.name.trim()||num(i.price)).map(i=>({name:i.name.trim()||'Item',price:r2(num(i.price)),cat:i.cat,pref:i.pref}));
 const sum=r2(items.reduce((a,i)=>a+i.price,0)),total=d.total===''||d.total==null?sum:r2(num(d.total));
 if(!items.length&&!total){ui.err='Add at least one line or a total.';return render()}
 for(const i of items)S.prefs[norm(i.name)]=i.pref;
 const e={id:uid(),date:d.date||today(),store:d.store.trim(),kind:d.kind,items,total};
 const mk=mkey();
 if(e.kind==='shop'&&mkey(e.date)===mk){const cap=tripCap();e.cap=cap;const under=total<=cap;S.cur.level=under?S.cur.level+1:Math.max(0,S.cur.level-1);
  const over=r2(total-cap);S.flash={at:Date.now(),kind:'shop',total,cap,under,next:tripCap(),cuts:under?[]:cutsFor(items,over).cuts.map(c=>({name:c.name,price:c.price}))}}
 else S.flash={at:Date.now(),kind:'online',total,left:0};
 S.entries.push(e);if(S.flash.kind==='online')S.flash.left=r2(living(mk)-spentIn(mk));
 const bought=new Set(items.map(i=>norm(i.name)));if(e.kind==='shop')S.list=S.list.filter(l=>!(l.done||bought.has(norm(l.name))));
 ui.draft=null;ui.err='';persist();location.hash='overview';render()}

async function getTips(){ui.tipsBusy=true;ui.tipsErr='';render();
 const since=new Date(Date.now()-60*864e5).toISOString().slice(0,10),agg={};
 for(const e of S.entries.filter(e=>e.date>=since))for(const i of e.items){const k=norm(i.name);agg[k]=agg[k]||{n:i.name,c:0,t:0,cat:i.cat,p:i.pref};agg[k].c++;agg[k].t+=i.price}
 const lines=Object.values(agg).sort((a,b)=>b.t-a.t).slice(0,50).map(a=>`- ${a.n} — ${a.c}× — €${a.t.toFixed(2)} — ${a.cat} — ${a.p}`).join('\n')||'(no receipts logged yet)';
 const prompt=`You are a practical, frugal budgeting coach for one person who lives alone with a cat in Belgium.
Net income €${S.settings.income}/month. Savings goal €${targetFor(mkey())}/month (rises each month it is hit). Next shopping-trip cap €${tripCap()}.
Bills: ${S.bills.map(b=>`${b.name} €${b.amount} ${FREQ[b.freq].toLowerCase()}`).join('; ')}.
Purchases in the last 60 days (name — times — total — category — need/want):
${lines}
Give 5 concrete savings suggestions grounded in this data: e.g. swap a brand for a Belgian discount own brand (Colruyt Boni, Aldi, Lidl), buy cat food in bulk, cut or reduce a recurring "want", downgrade or pause a subscription if a cheaper plan exists. Do not invent purchases that are not listed. Estimate the monthly saving in euros conservatively.
Return ONLY JSON: [{"title":"short","detail":"one or two sentences","monthly":number}]`;
 try{const j=await api('/api/tips',{method:'POST',body:{prompt}});const items=(Array.isArray(j)?j:j&&j.items||[]).slice(0,6).map(t=>({title:String(t.title||''),detail:String(t.detail||''),monthly:r2(num(t.monthly))}));
  S.tips={at:Date.now(),items};persist()}
 catch(e){ui.tipsErr=e.offline?'You\'re offline.':'Couldn\'t get ideas right now.'}
 ui.tipsBusy=false;render()}

$.addEventListener('click',ev=>{const t=ev.target.closest('[data-act]');if(!t||t.tagName==='INPUT')return;const a=t.dataset.act,id=t.dataset.id,i=+t.dataset.i;
 if(a==='dismiss'){S.notice=null;persist();render()}
 else if(a==='tips')getTips();
 else if(a==='paste'){const v=(document.getElementById('paste').value||'').trim();if(v)parse({text:v},'online')}
 else if(a==='manual'){ui.draft={store:'',date:today(),kind:t.dataset.kind,items:[{name:'',price:'',cat:t.dataset.kind==='online'?'other':'groceries',pref:t.dataset.kind==='online'?'want':'need'}],total:''};render()}
 else if(a==='pref'){const it=ui.draft.items[i];it.pref=it.pref==='need'?'want':'need';render()}
 else if(a==='rmitem'){ui.draft.items.splice(i,1);render()}
 else if(a==='additem'){ui.draft.items.push({name:'',price:'',cat:'groceries',pref:'need'});render()}
 else if(a==='save')saveDraft();
 else if(a==='discard'){ui.draft=null;render()}
 else if(a==='lpref'){const it=S.list.find(x=>x.id===id);it.pref=it.pref==='need'?'want':'need';S.prefs[norm(it.name)]=it.pref;persist();render()}
 else if(a==='lrm'){S.list=S.list.filter(x=>x.id!==id);persist();render()}
 else if(a==='lclear'){S.list=[];persist();render()}
 else if(a==='open'){ui.open=ui.open===id?null:id;ui.del=null;render()}
 else if(a==='del'){ui.del=id;render()}
 else if(a==='delno'){ui.del=null;render()}
 else if(a==='delyes'){S.entries=S.entries.filter(e=>e.id!==id);S.deleted=[...(S.deleted||[]),id];ui.del=null;ui.open=null;persist();render()}
 else if(a==='brm'){S.bills=S.bills.filter(b=>b.id!==id);persist();render()}
 else if(a==='badd'){S.bills.push({id:uid(),name:'New bill',amount:0,freq:'m'});persist();render()}
 else if(a==='export'){const p=navigator.clipboard&&navigator.clipboard.writeText(JSON.stringify(S));if(p)p.then(()=>{ui.copied=true;render();setTimeout(()=>{ui.copied=false;render()},2000)}).catch(()=>{})}
 else if(a==='imp'){ui.imp=!ui.imp;render()}
 else if(a==='impgo'){try{const s=JSON.parse(document.getElementById('impt').value);if(!s||!s.settings||!Array.isArray(s.entries))throw 0;S=migrate(s);ui.imp=false;persist();render()}catch(e){const x=document.getElementById('impt');x.style.borderColor='var(--bad)'}}
});
$.addEventListener('change',ev=>{const t=ev.target;
 if(t.dataset.act==='file'&&t.files&&t.files[0]){shrink(t.files[0]).then(toDataURL).then(img=>parse({image:img},'shop'));return}
 if(t.dataset.act==='done'){const it=S.list.find(x=>x.id===t.dataset.id);it.done=t.checked;persist();return}
 if(t.dataset.f&&ui.draft){if(t.dataset.i!==undefined){const it=ui.draft.items[+t.dataset.i];if(t.dataset.f==='cat'){it.cat=t.value;if(!S.prefs[norm(it.name)])it.pref=CATPREF[t.value]}else if(t.dataset.f==='name'){it.name=t.value;if(S.prefs[norm(t.value)])it.pref=S.prefs[norm(t.value)]}else it[t.dataset.f]=t.value}else ui.draft[t.dataset.f]=t.value;render();return}
 if(t.dataset.lprice){const it=S.list.find(x=>x.id===t.dataset.lprice);it.price=r2(num(t.value));persist();render();return}
 if(t.dataset.set){const k=t.dataset.set;S.settings[k]=Math.max(0,num(t.value));if(k==='target'){S.months[mkey()]={target:S.settings.target}}if(k==='trips')S.settings.trips=Math.max(1,Math.round(S.settings.trips));if(k==='foodShare')S.settings.foodShare=Math.min(100,S.settings.foodShare);persist();render();return}
 if(t.dataset.bill){const b=S.bills.find(x=>x.id===t.dataset.id);b[t.dataset.bill]=t.dataset.bill==='amount'?r2(num(t.value)):t.value;persist();render()}
});
$.addEventListener('input',ev=>{const t=ev.target;if(t.id==='lname'){const k=lastPrices()[norm(t.value)];const p=document.getElementById('lprice');if(k&&p&&!p.value)p.value=k.price}});
$.addEventListener('submit',ev=>{ev.preventDefault();if(ev.target.dataset.form!=='add')return;const n=document.getElementById('lname').value.trim();if(!n)return;
 const lp=lastPrices()[norm(n)],pv=document.getElementById('lprice').value;const cat=lp?lp.cat:'groceries';
 S.list.push({id:uid(),name:n,price:pv?r2(num(pv)):(lp?lp.price:0),pref:prefOf(n,cat),done:false});persist();render();const x=document.getElementById('lname');if(x)x.focus()});
window.addEventListener('hashchange',()=>{ui.open=null;ui.del=null;render()});


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
 return Object.assign(j||{},{_status:r.status})}

function mergeStates(a,b){ // a = local, b = server; newest wins for settings, tickets are combined
 const newer=(a.updatedAt||0)>=(b.updatedAt||0)?a:b,older=newer===a?b:a;
 const del=new Set([...(a.deleted||[]),...(b.deleted||[])]);
 const ents=new Map();for(const e of [...older.entries,...newer.entries])if(!del.has(e.id))ents.set(e.id,e);
 const m=migrate(JSON.parse(JSON.stringify(newer)));
 m.entries=[...ents.values()];m.deleted=[...del].slice(-500);m.prefs={...older.prefs,...newer.prefs};
 m.months={...older.months,...newer.months};m.updatedAt=Math.max(a.updatedAt||0,b.updatedAt||0);return m}

async function pull(){if(!AUTH.token)return;try{const r=await api('/api/state');
  if(r.data){const local=S,hadLocal=S.entries.length||S.updatedAt>AUTH.serverAt;
   S=hadLocal&&AUTH.serverAt!==r.updatedAt?mergeStates(local,migrate(r.data)):migrate(r.data);AUTH.serverAt=r.updatedAt;saveAuth();rollover();localSave();
   sync='synced';render();if(hadLocal&&S.updatedAt>r.updatedAt)schedulePush(0)}
  else{sync='synced';schedulePush(0)}}
 catch(e){sync=e.offline?'offline':sync;status()}}

function schedulePush(delay=900){if(!AUTH.token)return;clearTimeout(pubT);sync='saving';status();pubT=setTimeout(push,delay)}
async function push(tries=0){try{const r=await api('/api/state',{method:'PUT',body:{data:S,base:AUTH.serverAt}});
  if(r._status===409&&r.conflict&&tries<3){S=mergeStates(S,migrate(r.data));AUTH.serverAt=r.updatedAt;saveAuth();localSave();render();return push(tries+1)}
  if(r.updatedAt){AUTH.serverAt=r.updatedAt;saveAuth();sync='synced'}status()}
 catch(e){sync=e.offline?'offline':'error';status();clearTimeout(pubT);pubT=setTimeout(push,30000)}}

window.addEventListener('online',()=>AUTH.token&&schedulePush(0));
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&AUTH.token&&sync!=='saving')pull()});

function toDataURL(blob){return new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=rej;fr.readAsDataURL(blob)})}

function renderAuth(){const m=authUi.mode;
 $.innerHTML=`<div class="auth"><h1>Spare</h1><div class="mute">Scan tickets, squeeze a little more out of every trip.</div>
 <div class="tabs"><button class="${m==='login'?'':'ghost'}" data-auth="login">Log in</button><button class="${m==='signup'?'':'ghost'}" data-auth="signup">Create account</button></div>
 <form data-form="auth" class="card"><label class="f">Email</label><input id="aemail" type="email" autocomplete="email" required>
 <label class="f">Password${m==='signup'?' (8+ characters)':''}</label><input id="apw" type="password" autocomplete="${m==='signup'?'new-password':'current-password'}" required minlength="${m==='signup'?8:1}">
 <details ${AUTH.api?'':'open'} style="margin-top:10px"><summary class="small mute">Server</summary><input id="aapi" placeholder="https://spare.yourname.workers.dev" value="${esc(AUTH.api)}"><div class="tiny mute">Leave empty on the website itself. The Android app needs your Worker's address.</div></details>
 ${authUi.err?`<div class="err">${esc(authUi.err)}</div>`:''}
 <div class="btns"><button ${authUi.busy?'disabled':''}>${authUi.busy?'<span class="spin"></span>':''}${m==='login'?'Log in':'Create account'}</button></div></form>
 <div class="tiny mute">Your tickets, bills and settings sync to your own Cloudflare database. Anything already on this device is kept and merged in.</div></div>`}

$.addEventListener('click',ev=>{const t=ev.target.closest('[data-auth]');if(t){authUi.mode=t.dataset.auth;authUi.err='';renderAuth()}});
$.addEventListener('submit',async ev=>{if(ev.target.dataset.form!=='auth')return;ev.preventDefault();
 const email=document.getElementById('aemail').value,password=document.getElementById('apw').value;
 AUTH.api=(document.getElementById('aapi').value||'').trim().replace(/\/$/,'');
 authUi.busy=true;authUi.err='';renderAuth();
 try{const r=await api(authUi.mode==='login'?'/api/login':'/api/signup',{method:'POST',body:{email,password}});
  AUTH.token=r.token;AUTH.email=r.email;AUTH.serverAt=-1;saveAuth();authUi.busy=false;render();await pull()}
 catch(e){authUi.busy=false;authUi.err=e.offline?'Can\'t reach the server. Check the address and your connection.':e.message;renderAuth()}});

function accountCard(){const p=authUi.pw;return `<div class="card"><h2>Account</h2><div class="row"><span class="mute">Signed in as</span><span>${esc(AUTH.email||'')}</span></div>
 ${p?`<label class="f">Current password</label><input id="pwold" type="password"><label class="f">New password</label><input id="pwnew" type="password" minlength="8">${p.err?`<div class="err">${esc(p.err)}</div>`:''}${p.ok?'<div class="note good small">Password changed.</div>':''}<div class="btns"><button data-act="pwgo">Change password</button><button class="link" data-act="pwcancel">Cancel</button></div>`
 :`<div class="btns"><button class="ghost" data-act="sync">Sync now</button><button class="ghost" data-act="pwopen">Change password</button><button class="ghost" data-act="logout">Log out</button></div>`}</div>`}
$.addEventListener('click',async ev=>{const t=ev.target.closest('[data-act]');if(!t)return;const a=t.dataset.act;
 if(a==='sync')pull();
 else if(a==='pwopen'){authUi.pw={};render()}
 else if(a==='pwcancel'){authUi.pw=null;render()}
 else if(a==='pwgo'){try{await api('/api/password',{method:'POST',body:{oldPassword:document.getElementById('pwold').value,newPassword:document.getElementById('pwnew').value}});authUi.pw={ok:true};render();setTimeout(()=>{authUi.pw=null;render()},2500)}catch(e){authUi.pw={err:e.offline?'You\'re offline.':e.message};render()}}
 else if(a==='logout'){try{await api('/api/logout',{method:'POST'})}catch(e){}AUTH.token=null;AUTH.serverAt=0;saveAuth();try{localStorage.removeItem(LSK)}catch(e){}S=defaults();rollover();render()}});

load();rollover();render();if(AUTH.token)pull();
