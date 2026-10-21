/* Склад проката — логика сайта (без сборки, чистый JS). */
(() => {
"use strict";

// ---------- справочники ----------
const CATS = ["Световые приборы","Звуковое оборудование","Видео / LED-экраны","Пульты и управление","Коммутация и кабели","Электропитание и дистрибьюция","Фермы и сценические конструкции","Риггинг и моторы","Спецэффекты","Кейсы и транспорт","Прочее"];
const STATES = {"Исправно":"c-ok","Мелкие дефекты":"c-warn","Требует ремонта":"c-bad","В ремонте":"c-info","Списано":"c-off"};
const STATUSES = {"На складе":"c-ok","В прокате":"c-info","На мероприятии":"c-info","У подрядчика":"c-warn","Не найдено":"c-bad"};
const UNITS = ["шт.","компл.","м","кейс","пара"];
const ROLES = {pending:"Ожидает",viewer:"Просмотр",worker:"Кладовщик",manager:"Менеджер",admin:"Администратор"};
const LV = {pending:0,viewer:1,worker:2,manager:3,admin:4};
const FIELDS = {name:"Наименование",category:"Категория",place:"Место",maker:"Производитель",model:"Модель",inv:"Инв. номер",serial:"Серийный номер",unit:"Ед.",qty_fact:"Кол-во факт",qty_plan:"Кол-во по учёту",price:"Цена",state:"Состояние",status:"Статус",note:"Примечание"};
const EDIT_FIELDS = Object.keys(FIELDS);
const NUM_FIELDS = ["qty_fact","qty_plan","price"];

// ---------- утилиты ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const num = v => (v === "" || v == null || isNaN(+v)) ? null : +v;
const isIssue = i => (i.state && i.state !== "Исправно") || i.status === "Не найдено";
const can = r => LV[me?.role] >= LV[r];
function opts(sel, list, keepFirst){ const f = keepFirst ? sel.options[0].outerHTML : ""; sel.innerHTML = f + list.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(""); }
function toast(t){ const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 3000); }
function show(view){ ["authView","pendingView","setupView","appView"].forEach(v => $(v).hidden = v !== view); }
function ago(ts){ if(!ts) return ""; const m = Math.round((Date.now() - new Date(ts)) / 60000);
  if(m < 1) return "только что"; if(m < 60) return m + " мин назад"; const h = Math.round(m / 60);
  if(h < 24) return h + " ч назад"; return new Date(ts).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}); }
function errText(e){
  const m = (e && (e.message || e.error_description)) || "";
  if(/Invalid login credentials/i.test(m)) return "Неверная почта или пароль.";
  if(/Email not confirmed/i.test(m)) return "Почта не подтверждена. Откройте письмо от Supabase и перейдите по ссылке.";
  if(/already registered/i.test(m)) return "Такая почта уже зарегистрирована. Войдите или восстановите пароль.";
  if(/row-level security|permission denied/i.test(m)) return "Недостаточно прав для этого действия.";
  if(/Failed to fetch|NetworkError/i.test(m)) return "Нет связи с сервером. Проверьте интернет.";
  return m || "Что-то пошло не так. Попробуйте ещё раз.";
}

// ---------- старт ----------
const cfg = window.SKLAD_CONFIG || {};
document.querySelectorAll(".appTitle").forEach(h => h.textContent = cfg.TITLE || "Склад проката");
document.title = cfg.TITLE || "Склад проката";
function setupError(title, html){ $("setupTitle").textContent = title; $("setupText").innerHTML = html; show("setupView"); }
if(window.SKLAD_CONFIG_FAILED){
  setupError("Не найден файл config.js", "Проверьте, что <code>config.js</code> лежит рядом с <code>index.html</code> в корне репозитория."); return;
}
if(!cfg.SUPABASE_URL || /ВАШ-ПРОЕКТ/.test(cfg.SUPABASE_URL) || !cfg.SUPABASE_KEY || /ВСТАВЬТЕ/.test(cfg.SUPABASE_KEY)){
  setupError("Сайт ещё не подключён к базе", "Откройте файл <code>config.js</code> и впишите адрес проекта Supabase и публичный ключ. Подробности — в README."); return;
}
if(!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(cfg.SUPABASE_URL.trim())){
  setupError("Неверный адрес в config.js", "<code>SUPABASE_URL</code> должен выглядеть так: <code>https://xxxx.supabase.co</code> — без пробелов и лишнего в конце."); return;
}
if(window.SKLAD_LIB_FAILED || !window.supabase){
  setupError("Не загрузилась библиотека Supabase", "Сайт настроен, но браузер не смог скачать библиотеку с cdn.jsdelivr.net и unpkg.com. Обновите страницу (Ctrl+F5). Если не помогло — попробуйте другую сеть или мобильный интернет: возможно, эти адреса блокирует провайдер."); return;
}
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, { auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true } });

let me = null, items = [], profiles = {}, logRows = [], events = [], lines = [], crew = [], channel = null, started = false, recovering = false;

opts($("fCat"), CATS, true); opts($("fState"), Object.keys(STATES), true); opts($("fStatus"), Object.keys(STATUSES), true);
opts($("e_category"), CATS); opts($("e_state"), Object.keys(STATES)); opts($("e_status"), Object.keys(STATUSES)); opts($("e_unit"), UNITS);

// ---------- вход / регистрация ----------
function authMsg(t, ok){ const el = $("authMsg"); el.textContent = t; el.className = "msg" + (ok ? " ok" : ""); el.hidden = !t; }
function authMode(mode){
  document.querySelectorAll("[data-auth]").forEach(b => b.classList.toggle("active", b.dataset.auth === mode));
  $("loginForm").hidden = mode !== "login"; $("signupForm").hidden = mode !== "signup"; $("resetForm").hidden = mode !== "reset";
  document.querySelector("#authView .tabs").hidden = mode === "reset"; authMsg("");
}
document.querySelectorAll("[data-auth]").forEach(b => b.onclick = () => authMode(b.dataset.auth));

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault(); authMsg("");
  const btn = e.submitter; btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: $("li_email").value.trim(), password: $("li_pass").value });
  btn.disabled = false; if(error) authMsg(errText(error));
});
$("signupForm").addEventListener("submit", async e => {
  e.preventDefault(); authMsg("");
  const name = $("su_name").value.trim(), email = $("su_email").value.trim(), pass = $("su_pass").value;
  if(!name){ authMsg("Укажите имя."); return; }
  if(pass.length < 6){ authMsg("Пароль должен быть не короче 6 символов."); return; }
  const btn = e.submitter; btn.disabled = true;
  const { data, error } = await sb.auth.signUp({ email, password: pass, options:{ data:{ full_name:name }, emailRedirectTo: location.origin + location.pathname } });
  btn.disabled = false;
  if(error){ authMsg(errText(error)); return; }
  if(!data.session) authMsg("Готово! Проверьте почту и подтвердите адрес, затем войдите.", true);
});
$("forgotBtn").onclick = async () => {
  const email = $("li_email").value.trim();
  if(!email){ authMsg("Впишите почту в поле выше, и мы пришлём ссылку для смены пароля."); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  authMsg(error ? errText(error) : "Письмо со ссылкой отправлено. Проверьте почту.", !error);
};
$("resetForm").addEventListener("submit", async e => {
  e.preventDefault();
  const { error } = await sb.auth.updateUser({ password: $("rs_pass").value });
  if(error){ authMsg(errText(error)); return; }
  recovering = false; toast("Пароль изменён"); boot();
});
document.querySelectorAll("[data-logout]").forEach(b => b.onclick = async () => { await sb.auth.signOut(); location.reload(); });

sb.auth.onAuthStateChange((event, session) => {
  if(event === "PASSWORD_RECOVERY"){ recovering = true; show("authView"); authMode("reset"); return; }
  if(event === "SIGNED_IN" && !started && !recovering) setTimeout(boot, 0);
  if(event === "SIGNED_OUT"){ started = false; show("authView"); authMode("login"); }
});

async function boot(){
  const { data:{ session } } = await sb.auth.getSession();
  if(!session){ show("authView"); authMode("login"); return; }
  if(recovering || started) return;
  started = true;
  const uid = session.user.id;
  const { data: prof, error } = await sb.from("profiles").select("*").eq("id", uid).maybeSingle();
  if(error){ started = false; show("authView"); authMsg(errText(error)); return; }
  if(!prof || prof.role === "pending"){
    $("pendingEmail").textContent = session.user.email; show("pendingView");
    sb.channel("me-" + uid).on("postgres_changes", { event:"UPDATE", schema:"public", table:"profiles", filter:"id=eq." + uid }, p => {
      if(p.new.role !== "pending") location.reload();
    }).subscribe();
    return;
  }
  me = prof;
  startApp();
}

// ---------- приложение ----------
async function startApp(){
  show("appView");
  $("meName").textContent = me.full_name || me.email;
  $("meRole").textContent = ROLES[me.role]; $("meRole").className = "role r-" + me.role;
  $("usersTab").hidden = !can("admin");
  $("addBtn").hidden = !can("manager");

  const [it, pr, lg, ev, el, cr] = await Promise.all([
    sb.from("items").select("*").order("id"),
    sb.from("profiles").select("*").order("created_at"),
    sb.from("item_log").select("*").order("created_at", { ascending:false }).limit(300),
    sb.from("events").select("*").order("date_from"),
    sb.from("event_items").select("*").order("id"),
    sb.from("event_crew").select("*").order("id")
  ]);
  if(it.error){ toast(errText(it.error)); }
  items = it.data || []; logRows = lg.data || [];
  (pr.data || []).forEach(p => profiles[p.id] = p);
  if(ev.error || el.error){ EV.missing = true; } else { events = ev.data || []; lines = el.data || []; }
  if(cr.error){ EV.crewMissing = true; } else crew = cr.data || [];
  renderStock(); renderLog(); renderUsers(); renderEvents();
  subscribe();
  const h = location.hash.slice(1);
  if(/^ev-\d+$/.test(h)) openEvent(+h.slice(3)); else if(["stock","events","log","users"].includes(h)) setTab(h);
}

function upsertRow(arr, p){
  if(p.eventType === "DELETE") return arr.filter(r => r.id !== p.old.id);
  const k = arr.findIndex(r => r.id === p.new.id);
  if(k >= 0){ arr[k] = p.new; return arr; }
  return [...arr, p.new];
}
function subscribe(){
  channel = sb.channel("sklad")
    .on("postgres_changes", { event:"*", schema:"public", table:"items" }, p => {
      if(p.eventType === "DELETE"){ items = items.filter(i => i.id !== p.old.id); }
      else {
        const idx = items.findIndex(i => i.id === p.new.id);
        const row = { ...p.new, _flash: true };
        if(idx >= 0){ if(pendingQty[p.new.id]) row.qty_fact = items[idx].qty_fact; items[idx] = row; } else items.push(row);
      }
      renderStock();
    })
    .on("postgres_changes", { event:"*", schema:"public", table:"events" }, p => {
      events = upsertRow(events, p); renderEvents(); renderStock();
    })
    .on("postgres_changes", { event:"*", schema:"public", table:"event_items" }, p => {
      lines = upsertRow(lines, p); renderEvents(); renderStock();
    })
    .on("postgres_changes", { event:"*", schema:"public", table:"event_crew" }, p => {
      crew = upsertRow(crew, p); renderEvents();
    })
    .on("postgres_changes", { event:"INSERT", schema:"public", table:"item_log" }, p => {
      logRows.unshift(p.new); logRows = logRows.slice(0, 300); renderLog();
    })
    .on("postgres_changes", { event:"*", schema:"public", table:"profiles" }, p => {
      if(p.eventType === "DELETE") delete profiles[p.old.id]; else profiles[p.new.id] = p.new;
      if(p.new && p.new.id === me.id && p.new.role !== me.role){ toast("Ваша роль изменилась — обновляю страницу"); setTimeout(() => location.reload(), 1200); }
      renderUsers(); renderStock(); renderEvents();
    })
    .subscribe(status => {
      const on = status === "SUBSCRIBED";
      $("live").classList.toggle("on", on);
      $("liveText").textContent = on ? "онлайн" : (status === "CHANNEL_ERROR" || status === "TIMED_OUT" ? "нет связи" : "подключаюсь…");
    });
}

// ---------- вкладки ----------
function setTab(t){
  if(t === "users" && !can("admin")) t = "stock";
  document.querySelectorAll("#mainTabs .tab").forEach(b => b.classList.toggle("active", b.dataset.tab === t));
  ["stock","events","log","users"].forEach(x => $("tab-" + x).hidden = x !== t);
  if(t === "events" && EV.open){ history.replaceState(null, "", "#ev-" + EV.open); }
  else history.replaceState(null, "", "#" + t);
}
document.querySelectorAll("#mainTabs .tab").forEach(b => b.onclick = () => {
  if(b.dataset.tab === "events" && b.classList.contains("active") && EV.open){ closeEvent(); return; }
  setTab(b.dataset.tab);
});

// ---------- склад ----------
function placesOf(){ return [...new Set(items.map(i => i.place || "Без места"))].sort((a,b) => a.localeCompare(b,"ru")); }
function renderStock(){
  const pl = placesOf(), cur = $("fPlace").value;
  opts($("fPlace"), pl, true); $("fPlace").value = pl.includes(cur) ? cur : "";
  $("placesList").innerHTML = pl.map(p => `<option value="${esc(p)}">`).join("");

  $("sItems").textContent = items.length;
  $("sUnits").textContent = items.reduce((a,i) => a + (num(i.qty_fact) || 0), 0);
  $("sIssues").textContent = items.filter(isIssue).length;
  $("sOut").textContent = items.reduce((a,i) => a + outQty(i.id), 0);
  const wp = items.filter(i => num(i.qty_plan) != null);
  $("sDiff").textContent = wp.length ? wp.filter(i => num(i.qty_fact) !== num(i.qty_plan)).length : "—";

  const q = $("q").value.trim().toLowerCase(), fp = $("fPlace").value, fc = $("fCat").value, fs = $("fState").value, ft = $("fStatus").value, fi = $("fIssues").checked;
  const shown = items.filter(i => (!fp || (i.place || "Без места") === fp) && (!fc || i.category === fc) && (!fs || i.state === fs) && (!ft || i.status === ft) && (!fi || isIssue(i)) &&
    (!q || [i.name,i.maker,i.model,i.inv,i.serial,i.note,i.place].join(" ").toLowerCase().includes(q)));

  const focusId = document.activeElement?.dataset?.act === "qty" ? document.activeElement.closest(".row")?.dataset.id : null;
  const list = $("list");
  if(!items.length){ list.innerHTML = `<div class="empty"><strong>Склад пока пуст</strong>${can("manager") ? "Нажмите «+ Позиция», чтобы добавить оборудование." : "Менеджер ещё не добавил оборудование."}</div>`; return; }
  if(!shown.length){ list.innerHTML = `<div class="empty"><strong>Ничего не найдено</strong>Измените поиск или сбросьте фильтры.</div>`; return; }
  const groups = {}; shown.forEach(i => (groups[i.place || "Без места"] ??= []).push(i));
  list.innerHTML = Object.keys(groups).sort((a,b) => a.localeCompare(b,"ru")).map(p => {
    const g = groups[p].sort((a,b) => (a.category||"").localeCompare(b.category||"","ru") || (a.name||"").localeCompare(b.name||"","ru",{numeric:true}));
    return `<section class="group"><div class="ghead"><h2>${esc(p)}</h2><small>${g.length} поз. · ${g.reduce((a,i) => a + (num(i.qty_fact)||0), 0)} ед.</small></div>${g.map(rowHtml).join("")}</section>`;
  }).join("");
  items.forEach(i => delete i._flash);
  if(focusId){ const el = list.querySelector(`.row[data-id="${focusId}"] input[data-act=qty]`); if(el){ el.focus(); const v = el.value; el.value = ""; el.value = v; } }
}
function rowHtml(i){
  const plan = num(i.qty_plan), fact = num(i.qty_fact);
  let diff = ""; if(plan != null && fact != null){ const d = fact - plan; diff = `<span class="diff ${d<0?"neg":d>0?"pos":"zero"}">${d === 0 ? "сходится с учётом" : (d>0?"+":"") + d + " к учёту (" + plan + ")"}</span>`; }
  const w = can("worker") ? "" : "disabled";
  const who = i.updated_by && profiles[i.updated_by] ? (profiles[i.updated_by].full_name || profiles[i.updated_by].email) : "";
  return `<div class="row${i._flash ? " flash" : ""}" data-id="${i.id}">
    <div><div class="name">${esc(i.name)}${i.maker ? ` <span class="maker">${esc(i.maker)}</span>` : ""}${i.model ? ` <span class="maker">${esc(i.model)}</span>` : ""}</div>
      ${(i.inv || i.serial) ? `<div class="sub">${i.inv ? `<span class="mono">${esc(i.inv)}</span>` : ""}${i.inv && i.serial ? " · " : ""}${i.serial ? `S/N <span class="mono">${esc(i.serial)}</span>` : ""}</div>` : ""}
      ${i.note ? `<div class="note">${esc(i.note)}</div>` : ""}</div>
    <div class="cat">${esc(i.category || "")}</div>
    <div class="qty"><div class="qtyBox">
      <button type="button" data-act="dec" aria-label="Минус один" ${w}>−</button>
      <input type="number" min="0" inputmode="numeric" value="${fact ?? ""}" aria-label="Количество факт" data-act="qty" ${w}>
      <button type="button" data-act="inc" aria-label="Плюс один" ${w}>+</button><span class="u">${esc(i.unit || "шт.")}</span></div>${diff}${outTag(i)}</div>
    <div class="st1"><select class="chip ${STATES[i.state] || "c-off"}" data-act="state" aria-label="Состояние" ${w}>${Object.keys(STATES).map(s => `<option ${s === i.state ? "selected" : ""}>${s}</option>`).join("")}</select></div>
    <div class="st2"><select class="chip ${STATUSES[i.status] || "c-off"}" data-act="status" aria-label="Статус" ${w}>${Object.keys(STATUSES).map(s => `<option ${s === i.status ? "selected" : ""}>${s}</option>`).join("")}</select></div>
    <button type="button" class="edit" data-act="edit" aria-label="Открыть карточку" title="Открыть карточку"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg></button>
    ${who ? `<div class="meta">изменил(а) ${esc(who)} · ${ago(i.updated_at)}</div>` : ""}
  </div>`;
}

async function updateItem(id, patch, quiet){
  const { error } = await sb.from("items").update(patch).eq("id", id);
  if(error){ toast(errText(error)); const { data } = await sb.from("items").select("*").eq("id", id).maybeSingle(); if(data){ const k = items.findIndex(i => i.id === id); if(k >= 0) items[k] = data; renderStock(); } return false; }
  if(!quiet) toast("Сохранено"); return true;
}
const pendingQty = {};
function setQty(id, v){
  const it = items.find(x => x.id === id); if(!it) return;
  v = Math.max(0, Math.round(num(v) || 0)); it.qty_fact = v;
  const inp = document.querySelector(`.row[data-id="${id}"] input[data-act=qty]`); if(inp && +inp.value !== v) inp.value = v;
  clearTimeout(pendingQty[id]);
  pendingQty[id] = setTimeout(async () => { await updateItem(id, { qty_fact: v }, true); delete pendingQty[id]; }, 700);
}
$("list").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if(!b || b.tagName === "SELECT" || b.tagName === "INPUT") return;
  const id = +b.closest(".row").dataset.id, it = items.find(x => x.id === id); if(!it) return;
  if(b.dataset.act === "inc") setQty(id, (num(it.qty_fact) || 0) + 1);
  if(b.dataset.act === "dec") setQty(id, (num(it.qty_fact) || 0) - 1);
  if(b.dataset.act === "edit") openEditor(it);
});
$("list").addEventListener("change", e => {
  const el = e.target, act = el.dataset.act; if(!act) return;
  const id = +el.closest(".row").dataset.id;
  if(act === "qty") setQty(id, el.value);
  if(act === "state"){ el.className = "chip " + (STATES[el.value] || "c-off"); updateItem(id, { state: el.value }); }
  if(act === "status"){ el.className = "chip " + (STATUSES[el.value] || "c-off"); updateItem(id, { status: el.value }); }
});
["q","fPlace","fCat","fState","fStatus","fIssues"].forEach(id => $(id).addEventListener("input", renderStock));

// ---------- карточка ----------
let editing = null;
function openEditor(it){
  editing = it || null;
  $("formTitle").textContent = it ? (can("worker") ? "Позиция" : "Карточка позиции") : "Новая позиция";
  const d = it || { category: CATS[0], unit: "шт.", state: "Исправно", status: "На складе", qty_fact: 1, place: $("fPlace").value || "" };
  EDIT_FIELDS.forEach(f => $("e_" + f).value = d[f] ?? "");
  document.querySelectorAll("#form [data-lvl]").forEach(el => el.disabled = !can(el.dataset.lvl));
  $("formNote").hidden = !(it && me.role === "worker");
  $("saveBtn").hidden = !can("worker") || (!it && !can("manager"));
  $("delBtn").hidden = !(it && can("manager")); $("delBtn").classList.remove("armed"); $("delBtn").textContent = "Удалить";
  $("histBtn").hidden = !it;
  $("formErr").hidden = true; $("scrim").hidden = false;
  setTimeout(() => { const f = document.querySelector("#form .field:not(:disabled)"); f && f.focus(); }, 30);
}
function closeEditor(){ $("scrim").hidden = true; editing = null; }
$("addBtn").onclick = () => openEditor(null);
$("cancelBtn").onclick = closeEditor;
$("scrim").addEventListener("mousedown", e => { if(e.target === $("scrim")) closeEditor(); });
document.addEventListener("keydown", e => {
  if(e.key !== "Escape") return;
  if(!$("scrim").hidden) closeEditor();
  ["evScrim","pkScrim","prScrim","crScrim"].forEach(id => $(id).hidden = true);
});
$("form").addEventListener("submit", async e => {
  e.preventDefault();
  const d = {};
  EDIT_FIELDS.forEach(f => { const el = $("e_" + f); if(el.disabled) return; let v = el.value; d[f] = NUM_FIELDS.includes(f) ? num(v) : (v.trim() || null); });
  if("name" in d && !d.name){ showErr("Укажите наименование."); return; }
  if(d.unit === null) d.unit = "шт."; if(d.state === null) d.state = "Исправно"; if(d.status === null) d.status = "На складе";
  $("saveBtn").disabled = true;
  const res = editing ? await sb.from("items").update(d).eq("id", editing.id) : await sb.from("items").insert(d);
  $("saveBtn").disabled = false;
  if(res.error){ showErr(errText(res.error)); return; }
  toast(editing ? "Сохранено" : "Позиция добавлена"); closeEditor();
});
function showErr(t){ $("formErr").textContent = t; $("formErr").hidden = false; }
$("delBtn").onclick = async () => {
  const b = $("delBtn");
  if(!b.classList.contains("armed")){ b.classList.add("armed"); b.textContent = "Точно удалить?"; return; }
  const { error } = await sb.from("items").delete().eq("id", editing.id);
  if(error){ showErr(errText(error)); return; }
  toast("Позиция удалена"); closeEditor();
};
$("histBtn").onclick = () => { const n = editing.name; closeEditor(); $("logQ").value = n; renderLog(); setTab("log"); };

// ---------- журнал ----------
const fmt = v => v == null || v === "" ? "—" : String(v);
function renderLog(){
  const q = $("logQ").value.trim().toLowerCase();
  const name = id => profiles[id] ? (profiles[id].full_name || profiles[id].email) : (id ? "удалённый пользователь" : "система");
  const rows = logRows.filter(r => !q || [r.item_name, name(r.user_id), r.changes && r.changes._item, r.changes && r.changes._who].join(" ").toLowerCase().includes(q));
  if(!rows.length){ $("logList").innerHTML = `<div class="empty" style="border:0">${q ? "Нет записей по этому запросу." : "Изменений пока не было. Здесь появится каждое изменение на складе."}</div>`; return; }
  const ACT = { insert:"добавил(а)", update:"изменил(а)", delete:"удалил(а)" };
  $("logList").innerHTML = rows.map(r => {
    if(r.kind === "event" || r.kind === "event_line" || r.kind === "event_crew") return logEventHtml(r, name);
    const ch = r.changes ? Object.entries(r.changes).filter(([k]) => FIELDS[k]).map(([k,[a,b]]) => `<li>${FIELDS[k]}: ${esc(fmt(a))} → <b>${esc(fmt(b))}</b></li>`).join("") : "";
    const t = new Date(r.created_at);
    return `<div class="ev"><time datetime="${esc(r.created_at)}" title="${t.toLocaleString("ru-RU")}">${t.toLocaleDateString("ru-RU",{day:"2-digit",month:"2-digit"})} ${t.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})}</time>
      <div class="what"><span class="who">${esc(name(r.user_id))}</span> <span class="act ${r.action}">${ACT[r.action] || r.action}</span> ${esc(r.item_name || "")}${ch ? `<ul>${ch}</ul>` : ""}</div></div>`;
  }).join("");
}
$("logQ").addEventListener("input", renderLog);
$("logList").addEventListener("click", e => { const a = e.target.closest("[data-ev]"); if(a){ e.preventDefault(); openEvent(+a.dataset.ev); } });

// ---------- пользователи ----------
function renderUsers(){
  if(!can("admin")) return;
  const list = Object.values(profiles).sort((a,b) => (a.role === "pending" ? -1 : 0) - (b.role === "pending" ? -1 : 0) || new Date(a.created_at) - new Date(b.created_at));
  const pend = list.filter(p => p.role === "pending").length;
  $("pendingCount").textContent = pend; $("pendingCount").hidden = !pend;
  $("userList").innerHTML = list.map(p => `<div class="urow${p.role === "pending" ? " pend" : ""}" data-uid="${p.id}">
    <div><div class="nm">${esc(p.full_name || "Без имени")}${p.id === me.id ? " (вы)" : ""}</div><div class="em">${esc(p.email || "")} · с ${new Date(p.created_at).toLocaleDateString("ru-RU")}</div></div>
    <select class="field" data-uid="${p.id}" aria-label="Роль" ${p.id === me.id ? "disabled" : ""}>${Object.keys(ROLES).map(r => `<option value="${r}" ${r === p.role ? "selected" : ""}>${ROLES[r]}</option>`).join("")}</select>
  </div>`).join("");
}
$("userList").addEventListener("change", async e => {
  const sel = e.target; if(!sel.dataset.uid) return;
  const uid = sel.dataset.uid, prev = profiles[uid].role;
  const { error } = await sb.from("profiles").update({ role: sel.value }).eq("id", uid);
  if(error){ toast(errText(error)); sel.value = prev; return; }
  profiles[uid] = { ...profiles[uid], role: sel.value }; renderUsers();
  toast(`${profiles[uid].full_name || profiles[uid].email}: ${ROLES[sel.value]}`);
});

// ---------- CSV ----------
$("csvBtn").onclick = () => {
  const head = ["Место хранения","Категория","Наименование","Производитель","Модель","Инв. номер","Серийный номер","Ед.","Кол-во по учёту","Кол-во факт","Расхождение","Состояние","Статус","Цена за ед.","Примечание","Изменено"];
  const rows = [...items].sort((a,b) => (a.place||"").localeCompare(b.place||"","ru") || (a.name||"").localeCompare(b.name||"","ru")).map(i => {
    const p = num(i.qty_plan), f = num(i.qty_fact);
    return [i.place,i.category,i.name,i.maker,i.model,i.inv,i.serial,i.unit,p ?? "",f ?? "",(p != null && f != null) ? f - p : "",i.state,i.status,i.price ?? "",i.note,i.updated_at ? new Date(i.updated_at).toLocaleString("ru-RU") : ""];
  });
  const csv = "﻿" + [head, ...rows].map(r => r.map(v => { v = String(v ?? ""); return /[;"\n\r]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v; }).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type:"text/csv;charset=utf-8" }));
  a.download = "sklad_" + new Date().toISOString().slice(0,10) + ".csv";
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};

// =====================================================================
// ---------- мероприятия и календарь ----------
// =====================================================================
const EV_ST = {
  planned:   { t:"Запланировано", c:"c-info" },
  out:       { t:"На выезде",     c:"c-warn" },
  returned:  { t:"Завершено",     c:"c-ok"   },
  cancelled: { t:"Отменено",      c:"c-off"  }
};
const evSt = e => EV_ST[e.status] || EV_ST.planned;
const EV_FIELDS = { title:"Название", venue:"Площадка", client:"Заказчик", date_from:"Начало", date_to:"Окончание", responsible:"Ответственный", status:"Статус", note:"Примечание" };
const MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const EV = { view:"cal", month:new Date(new Date().getFullYear(), new Date().getMonth(), 1), sel:null, open:null, missing:false, crewMissing:false, mine:false };

const pad = n => String(n).padStart(2, "0");
const dkey = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const dparse = s => { const [y,m,d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
const todayKey = () => dkey(new Date());
EV.sel = todayKey();
const isActive = e => e.status === "planned" || e.status === "out";
const fmtD = (s, o) => dparse(s).toLocaleDateString("ru-RU", o || { day:"numeric", month:"short" }).replace(/\./g, "");
function fmtRange(e){
  if(e.date_from === e.date_to) return fmtD(e.date_from, { weekday:"short", day:"numeric", month:"short" });
  const a = dparse(e.date_from), b = dparse(e.date_to);
  if(a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return a.getDate() + "–" + fmtD(e.date_to);
  return fmtD(e.date_from) + " – " + fmtD(e.date_to);
}
const personName = id => id && profiles[id] ? (profiles[id].full_name || profiles[id].email) : "";
const evById = id => events.find(e => e.id === id);
const itemById = id => items.find(i => i.id === id);
const linesOf = evId => lines.filter(l => l.event_id === evId);
// сколько единиц занимает строка: после отгрузки — сколько реально уехало
const lineQty = (l, e) => (e.status === "out" || e.status === "returned") && l.qty_out != null ? +l.qty_out : +l.qty;

// Кто ещё держит эту позицию в пересекающиеся даты
function busyFor(itemId, from, to, exceptId){
  const res = [];
  lines.forEach(l => {
    if(l.item_id !== itemId || l.event_id === exceptId) return;
    const e = evById(l.event_id);
    if(!e || !isActive(e) || !(e.date_from <= to && e.date_to >= from)) return;
    res.push({ ev:e, qty:lineQty(l, e) });
  });
  return res;
}
const freeQty = (item, from, to, exceptId) => (num(item.qty_fact) || 0) - busyFor(item.id, from, to, exceptId).reduce((a, b) => a + b.qty, 0);
function outQty(itemId){
  let n = 0;
  lines.forEach(l => { if(l.item_id !== itemId) return; const e = evById(l.event_id); if(e && e.status === "out") n += lineQty(l, e); });
  return n;
}
function outTag(i){ const o = outQty(i.id); return o ? `<span class="outtag">${o} на выезде</span>` : ""; }
function conflictsOf(e){
  if(!isActive(e)) return [];
  return linesOf(e.id).map(l => {
    const it = itemById(l.item_id); if(!it) return null;
    const need = lineQty(l, e), free = freeQty(it, e.date_from, e.date_to, e.id);
    return need > free ? { l, it, need, free, others:busyFor(it.id, e.date_from, e.date_to, e.id) } : null;
  }).filter(Boolean);
}
function shortagesOf(e){
  if(e.status !== "returned") return [];
  return linesOf(e.id).map(l => {
    const sent = l.qty_out != null ? +l.qty_out : +l.qty, back = l.qty_back != null ? +l.qty_back : sent;
    return back < sent ? { l, it:itemById(l.item_id), miss:sent - back } : null;
  }).filter(Boolean);
}

// ---------- команда ----------
const crewOf = evId => crew.filter(c => c.event_id === evId);
const crewName = c => c.user_id ? (personName(c.user_id) || c.name || "Сотрудник") : (c.name || "Без имени");
const crewKey = c => c.user_id ? "u:" + c.user_id : "n:" + String(c.name || "").trim().toLowerCase();
function crewBusy(c, e){
  const key = crewKey(c);
  return events.filter(o => o.id !== e.id && isActive(o) && o.date_from <= e.date_to && o.date_to >= e.date_from && crewOf(o.id).some(x => crewKey(x) === key));
}
const isMine = e => e.responsible === me.id || crewOf(e.id).some(c => c.user_id === me.id);
const evVisible = e => !EV.mine || isMine(e);
try { EV.mine = localStorage.getItem("sklad.evMine") === "1"; } catch(_) {}

// ---------- обзор ----------
function renderEvents(){
  if(!me) return;
  const outN = events.filter(e => e.status === "out").length;
  $("outCount").textContent = outN; $("outCount").hidden = !outN;
  $("outCount").title = "На выезде: " + outN;
  $("evAddBtn").hidden = !can("manager") || EV.missing;
  const open = EV.open ? evById(EV.open) : null;
  if(EV.open && !open && !EV.missing){ EV.open = null; if(!$("tab-events").hidden) history.replaceState(null, "", "#events"); }
  $("evBrowse").hidden = !!open; $("evDetail").hidden = !open;
  if(open){ renderEventDetail(open); return; }
  if(EV.missing){
    $("calWrap").hidden = true; $("monthNav").hidden = true; $("evList").hidden = false;
    $("evList").innerHTML = `<div class="empty"><strong>Мероприятия ещё не подключены к базе</strong>Администратору нужно один раз выполнить файл <code>supabase/02_events.sql</code> в Supabase → SQL Editor, затем обновить страницу.</div>`;
    return;
  }
  document.querySelectorAll("[data-evview]").forEach(b => b.classList.toggle("active", b.dataset.evview === EV.view));
  $("evMine").checked = EV.mine;
  $("calWrap").hidden = EV.view !== "cal"; $("monthNav").hidden = EV.view !== "cal"; $("evList").hidden = EV.view !== "list";
  EV.view === "cal" ? renderCal() : renderEvList();
}

function renderCal(){
  const y = EV.month.getFullYear(), mo = EV.month.getMonth();
  $("mTitle").textContent = MONTHS[mo] + " " + y;
  const shift = (new Date(y, mo, 1).getDay() + 6) % 7;
  const days = new Date(y, mo + 1, 0).getDate();
  const cells = Math.ceil((shift + days) / 7) * 7;
  const t = todayKey();
  const vis = events.filter(e => e.status !== "cancelled" && evVisible(e));
  let h = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"].map((d, i) => `<div class="cal-h${i > 4 ? " we" : ""}">${d}</div>`).join("");
  for(let i = 0; i < cells; i++){
    const d = new Date(y, mo, 1 - shift + i), k = dkey(d);
    const evs = vis.filter(e => e.date_from <= k && e.date_to >= k).sort((a, b) => a.date_from.localeCompare(b.date_from) || a.id - b.id);
    const cls = ["cal-d"];
    if(d.getMonth() !== mo) cls.push("other");
    if(k === t) cls.push("today");
    if(k === EV.sel) cls.push("sel");
    if(i % 7 > 4) cls.push("we");
    const chips = evs.slice(0, 3).map(e => {
      const warn = conflictsOf(e).length || shortagesOf(e).length;
      const label = (e.date_from === k || i % 7 === 0) ? esc(e.title) : "";
      return `<span class="evchip st-${e.status}${e.date_from === k ? " s" : ""}${e.date_to === k ? " e" : ""}${warn ? " warn" : ""}" data-ev="${e.id}" title="${esc(e.title)}">${label || "&#8203;"}</span>`;
    }).join("");
    const lbl = d.toLocaleDateString("ru-RU", { day:"numeric", month:"long" }) + (evs.length ? ", мероприятий: " + evs.length : "");
    h += `<div class="${cls.join(" ")}" data-day="${k}" role="button" tabindex="0" aria-label="${lbl}"><span class="dn">${d.getDate()}</span>${chips}${evs.length > 3 ? `<span class="more">ещё ${evs.length - 3}</span>` : ""}</div>`;
  }
  $("cal").innerHTML = h;
  renderDayPanel();
}

function renderDayPanel(){
  const k = EV.sel;
  const evs = events.filter(e => e.date_from <= k && e.date_to >= k && evVisible(e)).sort((a, b) => a.date_from.localeCompare(b.date_from));
  $("dayPanel").innerHTML = `<div class="dp-head"><h3>${fmtD(k, { weekday:"long", day:"numeric", month:"long" })}</h3>${can("manager") ? `<button class="btn" type="button" data-newev="${k}">+ Мероприятие на этот день</button>` : ""}</div>`
    + (evs.length ? `<div class="evcards">${evs.map(evCard).join("")}</div>` : `<p class="hint">В этот день мероприятий нет${can("manager") ? " — можно создать новое" : ""}.</p>`);
}

function evCard(e){
  const ls = linesOf(e.id), units = ls.reduce((a, l) => a + lineQty(l, e), 0);
  const c = conflictsOf(e), s = shortagesOf(e), d = dparse(e.date_from), resp = personName(e.responsible), cr = crewOf(e.id);
  const busyN = cr.filter(x => crewBusy(x, e).length).length;
  const tags = [`<span class="chip ${evSt(e).c}">${evSt(e).t}</span>`, `<span class="cnt">${ls.length} поз. · ${units} ед.</span>`];
  if(c.length) tags.push(`<span class="chip c-bad">Не хватает: ${c.length} поз.</span>`);
  if(s.length) tags.push(`<span class="chip c-bad">Не вернулось: ${s.reduce((a, x) => a + x.miss, 0)} ед.</span>`);
  if(!ls.length && isActive(e)) tags.push(`<span class="chip c-warn">Оборудование не выбрано</span>`);
  if(busyN && isActive(e)) tags.push(`<span class="chip c-bad">Люди заняты: ${busyN}</span>`);
  return `<button type="button" class="evcard st-${e.status}" data-ev="${e.id}">
    <span class="evdate"><b>${d.getDate()}</b><small>${d.toLocaleDateString("ru-RU", { month:"short" }).replace(/\./g, "")}</small></span>
    <span class="evbody"><span class="evtitle">${esc(e.title)}</span>
      <span class="evmeta">${esc(fmtRange(e))}${e.venue ? " · " + esc(e.venue) : ""}${resp ? " · отв. " + esc(resp) : ""}</span>
      ${cr.length ? `<span class="evcrew">Едут: ${esc(cr.slice(0, 4).map(crewName).join(", "))}${cr.length > 4 ? " и ещё " + (cr.length - 4) : ""}</span>` : ""}
      <span class="evtags">${tags.join("")}</span></span>
  </button>`;
}

function renderEvList(){
  const t = todayKey(), evs = events.filter(evVisible);
  const overdue = evs.filter(e => e.status === "planned" && e.date_to < t).sort((a, b) => a.date_from.localeCompare(b.date_from));
  const up = evs.filter(e => e.status === "out" || (e.status === "planned" && e.date_to >= t)).sort((a, b) => a.date_from.localeCompare(b.date_from));
  const past = evs.filter(e => e.status === "returned" || e.status === "cancelled").sort((a, b) => b.date_from.localeCompare(a.date_from)).slice(0, 40);
  let h = "";
  if(overdue.length) h += `<h3 class="sect bad">Дата прошла, но не отгружено</h3><p class="hint">Отметьте отгрузку и возврат или отмените — иначе оборудование числится забронированным.</p><div class="evcards">${overdue.map(evCard).join("")}</div>`;
  h += `<h3 class="sect">Ближайшие и на выезде</h3>` + (up.length ? `<div class="evcards">${up.map(evCard).join("")}</div>` : `<div class="empty"><strong>Впереди мероприятий нет</strong>${can("manager") ? "Нажмите «+ Мероприятие», чтобы забронировать оборудование." : "Менеджер ещё не запланировал мероприятия."}</div>`);
  if(past.length) h += `<h3 class="sect">Завершённые и отменённые</h3><div class="evcards">${past.map(evCard).join("")}</div>`;
  $("evList").innerHTML = h;
}

document.querySelectorAll("[data-evview]").forEach(b => b.onclick = () => { EV.view = b.dataset.evview; renderEvents(); });
$("mPrev").onclick = () => { EV.month = new Date(EV.month.getFullYear(), EV.month.getMonth() - 1, 1); renderCal(); };
$("mNext").onclick = () => { EV.month = new Date(EV.month.getFullYear(), EV.month.getMonth() + 1, 1); renderCal(); };
$("mToday").onclick = () => { const n = new Date(); EV.month = new Date(n.getFullYear(), n.getMonth(), 1); EV.sel = todayKey(); renderCal(); };
$("evAddBtn").onclick = () => openEvForm(null, EV.view === "cal" ? EV.sel : todayKey());
$("evBrowse").addEventListener("click", e => {
  const nb = e.target.closest("[data-newev]"); if(nb){ openEvForm(null, nb.dataset.newev); return; }
  const ev = e.target.closest("[data-ev]"); if(ev){ openEvent(+ev.dataset.ev); return; }
  const day = e.target.closest("[data-day]");
  if(day){ EV.sel = day.dataset.day; const d = dparse(EV.sel); if(d.getMonth() !== EV.month.getMonth()) EV.month = new Date(d.getFullYear(), d.getMonth(), 1); renderCal(); }
});
$("cal").addEventListener("keydown", e => { if((e.key === "Enter" || e.key === " ") && e.target.dataset.day){ e.preventDefault(); e.target.click(); } });

function openEvent(id){ EV.open = id; setTab("events"); renderEvents(); window.scrollTo(0, 0); }
function closeEvent(){ EV.open = null; history.replaceState(null, "", "#events"); renderEvents(); }

// ---------- карточка мероприятия ----------
function renderEventDetail(e){
  const M = can("manager"), W = can("worker");
  const ls = linesOf(e.id).map(l => ({ l, it:itemById(l.item_id) })).filter(x => x.it);
  const c = conflictsOf(e), s = shortagesOf(e), resp = personName(e.responsible);
  const units = ls.reduce((a, x) => a + lineQty(x.l, e), 0);
  const btn = (act, label, cls = "", dis = false) => `<button type="button" class="btn ${cls}" data-evact="${act}"${dis ? " disabled" : ""}>${label}</button>`;
  const acts = [];
  if(e.status === "planned" && W) acts.push(btn("load", "Отгрузить", "primary", !ls.length));
  if(e.status === "out" && W) acts.push(btn("return", "Принять возврат", "primary"));
  if(M && (e.status === "planned" || e.status === "out")) acts.push(btn("pick", "+ Оборудование"));
  if(M) acts.push(btn("edit", "Изменить"));
  if(ls.length) acts.push(btn("copy", "Копировать список", "ghost"));
  acts.push(`<span class="sp"></span>`);
  if(M && e.status === "planned") acts.push(btn("cancel", "Отменить мероприятие", "ghost"));
  if(M && e.status === "cancelled") acts.push(btn("restore", "Восстановить"));
  if(M && e.status === "returned") acts.push(btn("reopen", "Вернуть в «На выезде»", "ghost"));
  if(M && e.status !== "out") acts.push(btn("delete", "Удалить", "danger"));

  let banner = "";
  if(c.length) banner += `<div class="banner bad"><b>Не хватает оборудования на эти даты</b><ul>${c.map(x => `<li>${esc(x.it.name)}: нужно ${x.need}, свободно ${Math.max(0, x.free)}${x.others.length ? ` — занято: ${x.others.map(o => `<a href="#ev-${o.ev.id}" data-ev="${o.ev.id}">«${esc(o.ev.title)}»</a> (${o.qty})`).join(", ")}` : ""}</li>`).join("")}</ul></div>`;
  if(s.length) banner += `<div class="banner bad"><b>Не вернулось с мероприятия</b><ul>${s.map(x => `<li>${esc(x.it ? x.it.name : "позиция")} — ${x.miss} ${esc(x.it ? x.it.unit || "шт." : "шт.")}</li>`).join("")}</ul><p class="hint">Проверьте машину и площадку. Если оборудование потеряно — уменьшите его количество на складе.</p></div>`;
  if(e.status === "planned" && e.date_to < todayKey()) banner += `<div class="banner warn">Дата мероприятия прошла, а отгрузка не отмечена. Отметьте отгрузку и возврат или отмените мероприятие, чтобы снять бронь.</div>`;

  // колонки по статусу
  const colsHead = { planned:["Нужно","Свободно"], out:["Нужно","Погружено"], returned:["Погружено","Вернулось"], cancelled:["Было нужно",""] }[e.status];
  const groups = {};
  ls.forEach(x => (groups[x.it.place || "Без места"] ??= []).push(x));
  const body = Object.keys(groups).sort((a, b) => a.localeCompare(b, "ru")).map(place => {
    const rows = groups[place].sort((a, b) => (a.it.name || "").localeCompare(b.it.name || "", "ru", { numeric:true })).map(({ l, it }) => {
      const u = esc(it.unit || "шт.");
      let c1 = "", c2 = "", bad = false;
      if(e.status === "planned"){
        const free = freeQty(it, e.date_from, e.date_to, e.id); bad = +l.qty > free;
        c1 = M ? `<span class="qtyBox sm"><button type="button" data-lact="dec" aria-label="Меньше">−</button><input type="number" min="1" inputmode="numeric" value="${+l.qty}" data-lact="qty" aria-label="Нужно"><button type="button" data-lact="inc" aria-label="Больше">+</button></span>` : `<b>${+l.qty}</b> ${u}`;
        c2 = `<span class="${bad ? "neg" : "muted"}">${Math.max(0, free)} из ${num(it.qty_fact) || 0}</span>`;
      } else if(e.status === "out"){
        c1 = `${+l.qty} ${u}`; const o = l.qty_out != null ? +l.qty_out : +l.qty; bad = o < +l.qty;
        c2 = `<b class="${bad ? "neg" : ""}">${o}</b> ${u}`;
      } else if(e.status === "returned"){
        const o = l.qty_out != null ? +l.qty_out : +l.qty, b = l.qty_back != null ? +l.qty_back : o; bad = b < o;
        c1 = `${o} ${u}`; c2 = `<b class="${bad ? "neg" : "pos-ok"}">${b}</b> ${u}`;
      } else { c1 = `${+l.qty} ${u}`; }
      const st = it.state && it.state !== "Исправно" ? ` <span class="chip ${STATES[it.state] || "c-off"} xs">${esc(it.state)}</span>` : "";
      return `<div class="lrow${bad ? " bad" : ""}" data-line="${l.id}">
        <div class="lname">${esc(it.name)}${it.maker ? ` <span class="maker">${esc(it.maker)}</span>` : ""}${st}${it.note ? `<div class="note">${esc(it.note)}</div>` : ""}</div>
        <div class="lc">${c1}</div><div class="lc">${c2}</div>
        <div class="lx">${M && e.status === "planned" ? `<button type="button" class="edit" data-lact="del" aria-label="Убрать из списка" title="Убрать из списка">✕</button>` : ""}</div>
      </div>`;
    }).join("");
    return `<section class="group"><div class="ghead"><h2>${esc(place)}</h2><small>${groups[place].length} поз.</small></div>${rows}</section>`;
  }).join("");

  $("evDetail").innerHTML = `
    <button type="button" class="btn ghost back" data-evact="back">← Все мероприятия</button>
    <div class="evhead">
      <div class="evhead-main">
        <h2 class="evh">${esc(e.title)}</h2>
        <div class="evfacts">
          <span><small>Даты</small>${esc(fmtRange(e))}</span>
          ${e.venue ? `<span><small>Площадка</small>${esc(e.venue)}</span>` : ""}
          ${e.client ? `<span><small>Заказчик</small>${esc(e.client)}</span>` : ""}
          ${resp ? `<span><small>Ответственный</small>${esc(resp)}</span>` : ""}
          <span><small>Оборудование</small>${ls.length} поз. · ${units} ед.</span>
        </div>
        ${e.note ? `<p class="evnote">${esc(e.note)}</p>` : ""}
      </div>
      <span class="chip lg ${evSt(e).c}">${evSt(e).t}</span>
    </div>
    <div class="actions evacts">${acts.join("")}</div>
    ${crewSection(e)}
    ${banner}
    ${ls.length ? `<div class="lhead"><span>Позиция</span><span>${colsHead[0]}</span><span>${colsHead[1]}</span><span></span></div>${body}`
      : `<div class="empty"><strong>Оборудование ещё не выбрано</strong>${M && isActive(e) ? `<button type="button" class="btn primary" data-evact="pick" style="margin-top:12px">+ Добавить оборудование</button>` : ""}</div>`}`;
}

function crewSection(e){
  if(EV.crewMissing) return can("admin") ? `<div class="banner warn">Чтобы добавлять людей на выезд, выполните в Supabase файл <code>supabase/03_crew.sql</code>.</div>` : "";
  const M = can("manager"), cr = crewOf(e.id).sort((a, b) => (a.job || "я").localeCompare(b.job || "я", "ru") || crewName(a).localeCompare(crewName(b), "ru"));
  const rows = cr.map(c => {
    const busy = isActive(e) ? crewBusy(c, e) : [];
    const ph = c.phone || "";
    return `<div class="crow${busy.length ? " bad" : ""}" data-crew="${c.id}">
      <div class="cwho"><b>${esc(crewName(c))}</b>${c.user_id === me.id ? ` <span class="chip xs c-info">вы</span>` : ""}${c.job ? ` <span class="job">${esc(c.job)}</span>` : ""}
        ${c.note ? `<div class="sub">${esc(c.note)}</div>` : ""}
        ${busy.length ? `<div class="neg cwarn">В эти даты также на ${busy.map(o => `<a href="#ev-${o.id}" data-ev="${o.id}">«${esc(o.title)}»</a>`).join(", ")}</div>` : ""}</div>
      <div class="cphone">${ph ? `<a href="tel:${esc(ph.replace(/[^+\d]/g, ""))}">${esc(ph)}</a>` : ""}</div>
      <div class="lx">${M ? `<button type="button" class="edit" data-crdel="${c.id}" aria-label="Убрать из команды" title="Убрать из команды">✕</button>` : ""}</div>
    </div>`;
  }).join("");
  return `<section class="group crew"><div class="ghead"><h2>Команда</h2><small>${cr.length ? cr.length + " чел." : "никто не назначен"}</small>
    ${M && e.status !== "cancelled" ? `<button type="button" class="btn sm" data-evact="crew">+ Человек</button>` : ""}</div>
    ${rows || `<p class="hint crempty">${M ? "Добавьте, кто едет на мероприятие: техников, водителя, грузчиков." : "Команда пока не назначена."}</p>`}</section>`;
}

// действия в карточке
$("evDetail").addEventListener("click", async ev => {
  const lk = ev.target.closest("a[data-ev]"); if(lk){ ev.preventDefault(); openEvent(+lk.dataset.ev); return; }
  const e = evById(EV.open); if(!e) return;
  const cd = ev.target.closest("[data-crdel]");
  if(cd){
    const id = +cd.dataset.crdel;
    if(!cd.classList.contains("armed")){ cd.classList.add("armed"); cd.title = "Нажмите ещё раз, чтобы убрать"; cd.textContent = "?"; setTimeout(() => { if(cd.isConnected){ cd.classList.remove("armed"); cd.textContent = "✕"; } }, 3000); return; }
    const { error } = await sb.from("event_crew").delete().eq("id", id);
    if(error){ toast(errText(error)); return; }
    crew = crew.filter(c => c.id !== id); renderEvents(); toast("Убран(а) из команды"); return;
  }
  const lb = ev.target.closest("[data-lact]");
  if(lb && lb.tagName === "BUTTON"){
    const l = lines.find(x => x.id === +lb.closest("[data-line]").dataset.line); if(!l) return;
    if(lb.dataset.lact === "inc") setLineQty(l, +l.qty + 1);
    if(lb.dataset.lact === "dec") setLineQty(l, Math.max(1, +l.qty - 1));
    if(lb.dataset.lact === "del"){
      const { error } = await sb.from("event_items").delete().eq("id", l.id);
      if(error) toast(errText(error)); else { lines = lines.filter(x => x.id !== l.id); renderEvents(); renderStock(); }
    }
    return;
  }
  const b = ev.target.closest("[data-evact]"); if(!b) return;
  const a = b.dataset.evact;
  if(a === "back") closeEvent();
  if(a === "edit") openEvForm(e);
  if(a === "pick") openPicker(e);
  if(a === "crew") openCrew(e);
  if(a === "load") openProcess(e, "load");
  if(a === "return") openProcess(e, "return");
  if(a === "copy") copyEventList(e);
  if(a === "cancel") setEvStatus(e, "cancelled", "Мероприятие отменено, бронь снята");
  if(a === "restore") setEvStatus(e, "planned", "Мероприятие восстановлено");
  if(a === "reopen") setEvStatus(e, "out", "Мероприятие снова на выезде");
  if(a === "delete"){
    if(!b.classList.contains("armed")){ b.classList.add("armed"); b.textContent = "Точно удалить?"; return; }
    const { error } = await sb.from("events").delete().eq("id", e.id);
    if(error){ toast(errText(error)); return; }
    events = events.filter(x => x.id !== e.id); lines = lines.filter(x => x.event_id !== e.id); crew = crew.filter(x => x.event_id !== e.id);
    toast("Мероприятие удалено"); closeEvent(); renderStock();
  }
});
$("evDetail").addEventListener("change", ev => {
  const inp = ev.target; if(inp.dataset.lact !== "qty") return;
  const l = lines.find(x => x.id === +inp.closest("[data-line]").dataset.line); if(l) setLineQty(l, Math.max(1, Math.round(num(inp.value) || 1)));
});
const lineTimers = {};
function setLineQty(l, v){
  l.qty = v; renderEvents(); renderStock();
  clearTimeout(lineTimers[l.id]);
  lineTimers[l.id] = setTimeout(async () => {
    const { error } = await sb.from("event_items").update({ qty:v }).eq("id", l.id);
    if(error) toast(errText(error));
  }, 600);
}
async function setEvStatus(e, status, msg){
  const { error } = await sb.from("events").update({ status }).eq("id", e.id);
  if(error){ toast(errText(error)); return false; }
  e.status = status; renderEvents(); renderStock(); if(msg) toast(msg); return true;
}
async function copyEventList(e){
  const groups = {};
  linesOf(e.id).forEach(l => { const it = itemById(l.item_id); if(it) (groups[it.place || "Без места"] ??= []).push([it, lineQty(l, e)]); });
  let t = `${e.title} — ${fmtRange(e)}` + (e.venue ? `\nПлощадка: ${e.venue}` : "") + (personName(e.responsible) ? `\nОтветственный: ${personName(e.responsible)}` : "");
  const cr = crewOf(e.id);
  if(cr.length) t += `\n\nКоманда:` + cr.map(c => `\n— ${crewName(c)}${c.job ? " (" + c.job + ")" : ""}${c.phone ? ", " + c.phone : ""}`).join("");
  Object.keys(groups).sort((a, b) => a.localeCompare(b, "ru")).forEach(p => {
    t += `\n\n${p}:`;
    groups[p].sort((a, b) => a[0].name.localeCompare(b[0].name, "ru", { numeric:true })).forEach(([it, q]) => t += `\n— ${it.name}${it.maker ? " " + it.maker : ""} × ${q}`);
  });
  try { await navigator.clipboard.writeText(t); toast("Список скопирован — можно вставить в мессенджер"); }
  catch(_) { toast("Не удалось скопировать автоматически"); }
}

// ---------- форма мероприятия ----------
let evEditing = null;
function openEvForm(e, date){
  evEditing = e || null;
  $("evFormTitle").textContent = e ? "Изменить мероприятие" : "Новое мероприятие";
  const d = e || { title:"", date_from:date || todayKey(), date_to:date || todayKey(), venue:"", client:"", responsible:me.id, note:"" };
  ["title","date_from","date_to","venue","client","note"].forEach(f => $("v_" + f).value = d[f] ?? "");
  const staff = Object.values(profiles).filter(p => LV[p.role] >= LV.worker).sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", "ru"));
  $("v_responsible").innerHTML = `<option value="">— не назначен —</option>` + staff.map(p => `<option value="${p.id}">${esc(p.full_name || p.email)} · ${ROLES[p.role]}</option>`).join("");
  $("v_responsible").value = d.responsible || "";
  $("evFormErr").hidden = true; $("evScrim").hidden = false;
  setTimeout(() => $("v_title").focus(), 30);
}
$("v_date_from").addEventListener("change", () => { if(!$("v_date_to").value || $("v_date_to").value < $("v_date_from").value) $("v_date_to").value = $("v_date_from").value; });
$("evForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const d = { title:$("v_title").value.trim(), date_from:$("v_date_from").value, date_to:$("v_date_to").value || $("v_date_from").value,
    venue:$("v_venue").value.trim() || null, client:$("v_client").value.trim() || null, responsible:$("v_responsible").value || null, note:$("v_note").value.trim() || null };
  const err = t => { $("evFormErr").textContent = t; $("evFormErr").hidden = false; };
  if(!d.title) return err("Укажите название.");
  if(!d.date_from) return err("Укажите дату начала.");
  if(d.date_to < d.date_from) return err("Окончание не может быть раньше начала.");
  $("evSaveBtn").disabled = true;
  const res = evEditing ? await sb.from("events").update(d).eq("id", evEditing.id) : await sb.from("events").insert(d).select().single();
  $("evSaveBtn").disabled = false;
  if(res.error) return err(errText(res.error));
  $("evScrim").hidden = true;
  if(evEditing){ Object.assign(evEditing, d); toast("Сохранено"); renderEvents(); renderStock(); }
  else {
    const row = { status:"planned", ...res.data };
    if(!evById(row.id)) events.push(row);
    toast("Мероприятие создано — выберите оборудование");
    openEvent(row.id); openPicker(evById(row.id));
  }
});

// ---------- подбор оборудования ----------
const PK = { ev:null, sel:new Map(), orig:new Map() };
opts($("pkCat"), CATS, true);
function openPicker(e){
  PK.ev = e; PK.sel = new Map(); PK.orig = new Map();
  linesOf(e.id).forEach(l => { PK.sel.set(l.item_id, +l.qty); PK.orig.set(l.item_id, l); });
  $("pkHint").textContent = `«${e.title}», ${fmtRange(e)}. «Свободно» — сколько осталось с учётом других мероприятий в эти даты.`;
  $("pkQ").value = ""; $("pkCat").value = ""; $("pkOnly").checked = false; $("pkErr").hidden = true;
  renderPicker(); $("pkScrim").hidden = false; setTimeout(() => $("pkQ").focus(), 30);
}
function renderPicker(){
  const e = PK.ev, q = $("pkQ").value.trim().toLowerCase(), c = $("pkCat").value, only = $("pkOnly").checked;
  const list = items.filter(i => i.state !== "Списано" && (!c || i.category === c) && (!only || PK.sel.get(i.id) > 0) &&
    (!q || [i.name, i.maker, i.model, i.place, i.inv].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => (a.category || "").localeCompare(b.category || "", "ru") || (a.name || "").localeCompare(b.name || "", "ru", { numeric:true }));
  let lastCat = null;
  $("pkList").innerHTML = list.length ? list.map(i => {
    const v = PK.sel.get(i.id) || 0, free = freeQty(i, e.date_from, e.date_to, e.id), over = v > free;
    const head = i.category !== lastCat ? `<div class="pkcat">${esc(i.category || "Без категории")}</div>` : ""; lastCat = i.category;
    const st = i.state && i.state !== "Исправно" ? ` <span class="chip ${STATES[i.state] || "c-off"} xs">${esc(i.state)}</span>` : "";
    return head + `<div class="pkrow${v ? " on" : ""}${over ? " bad" : ""}" data-pk="${i.id}">
      <div class="lname">${esc(i.name)}${i.maker ? ` <span class="maker">${esc(i.maker)}</span>` : ""}${st}<div class="sub">${esc(i.place || "")}${i.note ? " · " + esc(i.note) : ""}</div></div>
      <div class="pkfree ${free <= 0 ? "neg" : ""}">свободно <b>${Math.max(0, free)}</b> из ${num(i.qty_fact) || 0}${over ? `<span class="neg">больше, чем свободно</span>` : ""}</div>
      <span class="qtyBox sm"><button type="button" data-pa="dec" aria-label="Меньше">−</button><input type="number" min="0" inputmode="numeric" value="${v || ""}" placeholder="0" data-pa="qty" aria-label="Количество"><button type="button" data-pa="inc" aria-label="Больше">+</button></span>
    </div>`;
  }).join("") : `<div class="empty" style="border:0">Ничего не найдено.</div>`;
  let n = 0, u = 0; PK.sel.forEach(v => { if(v > 0){ n++; u += v; } });
  $("pkSum").textContent = `Выбрано: ${n} поз. · ${u} ед.`;
}
["pkQ","pkCat","pkOnly"].forEach(id => $(id).addEventListener("input", renderPicker));
$("pkList").addEventListener("click", ev => {
  const b = ev.target.closest("button[data-pa]"); if(!b) return;
  const id = +b.closest("[data-pk]").dataset.pk, v = PK.sel.get(id) || 0;
  PK.sel.set(id, Math.max(0, v + (b.dataset.pa === "inc" ? 1 : -1))); renderPicker();
});
$("pkList").addEventListener("change", ev => {
  if(ev.target.dataset.pa !== "qty") return;
  PK.sel.set(+ev.target.closest("[data-pk]").dataset.pk, Math.max(0, Math.round(num(ev.target.value) || 0))); renderPicker();
});
$("pkSave").onclick = async () => {
  const e = PK.ev, ins = [], upd = [], del = [];
  PK.sel.forEach((v, itemId) => {
    const o = PK.orig.get(itemId);
    if(v > 0 && !o) ins.push({ event_id:e.id, item_id:itemId, qty:v });
    else if(v > 0 && o && +o.qty !== v) upd.push([o.id, v]);
    else if(v <= 0 && o) del.push(o.id);
  });
  $("pkSave").disabled = true;
  const results = [];
  if(ins.length) results.push(await sb.from("event_items").insert(ins).select());
  for(const [id, v] of upd) results.push(await sb.from("event_items").update({ qty:v }).eq("id", id));
  if(del.length) results.push(await sb.from("event_items").delete().in("id", del));
  $("pkSave").disabled = false;
  const bad = results.find(r => r.error);
  if(bad){ $("pkErr").textContent = errText(bad.error); $("pkErr").hidden = false; return; }
  const insRes = results[0] && ins.length ? results[0].data || [] : [];
  insRes.forEach(r => { if(!lines.find(x => x.id === r.id)) lines.push(r); });
  upd.forEach(([id, v]) => { const l = lines.find(x => x.id === id); if(l) l.qty = v; });
  lines = lines.filter(l => !del.includes(l.id));
  $("pkScrim").hidden = true; toast("Список оборудования сохранён"); renderEvents(); renderStock();
};

// ---------- отгрузка и возврат ----------
const PR = { ev:null, mode:"load", vals:new Map() };
function openProcess(e, mode){
  PR.ev = e; PR.mode = mode; PR.vals = new Map();
  linesOf(e.id).forEach(l => PR.vals.set(l.id, mode === "load" ? +l.qty : (l.qty_out != null ? +l.qty_out : +l.qty)));
  $("prTitle").textContent = mode === "load" ? "Отгрузка на мероприятие" : "Приём возврата";
  $("prHint").textContent = mode === "load"
    ? `«${e.title}». Проверьте, сколько реально погрузили. Если чего-то меньше — исправьте число.`
    : `«${e.title}». Пересчитайте, что вернулось. Всё, чего не хватает, будет отмечено как «не вернулось».`;
  $("prSave").textContent = mode === "load" ? "Отгрузить" : "Принять возврат";
  $("prErr").hidden = true; renderProcess(); $("prScrim").hidden = false;
}
function renderProcess(){
  const e = PR.ev;
  const ls = linesOf(e.id).map(l => ({ l, it:itemById(l.item_id) })).filter(x => x.it)
    .sort((a, b) => (a.it.place || "").localeCompare(b.it.place || "", "ru") || a.it.name.localeCompare(b.it.name, "ru", { numeric:true }));
  let lastPlace = null, diffN = 0;
  $("prList").innerHTML = ls.map(({ l, it }) => {
    const target = PR.mode === "load" ? +l.qty : (l.qty_out != null ? +l.qty_out : +l.qty);
    const v = PR.vals.get(l.id), less = v < target; if(less) diffN++;
    const head = it.place !== lastPlace ? `<div class="pkcat">${esc(it.place || "Без места")}</div>` : ""; lastPlace = it.place;
    return head + `<div class="pkrow${less ? " bad" : " on"}" data-pr="${l.id}">
      <div class="lname">${esc(it.name)}${it.maker ? ` <span class="maker">${esc(it.maker)}</span>` : ""}</div>
      <div class="pkfree">${PR.mode === "load" ? "нужно" : "уехало"} <b>${target}</b> ${esc(it.unit || "шт.")}${less ? `<span class="neg">${PR.mode === "load" ? "погружено меньше" : "не вернулось " + (target - v)}</span>` : ""}</div>
      <span class="qtyBox sm"><button type="button" data-pa="dec" aria-label="Меньше">−</button><input type="number" min="0" inputmode="numeric" value="${v}" data-pa="qty" aria-label="${PR.mode === "load" ? "Погружено" : "Вернулось"}"><button type="button" data-pa="inc" aria-label="Больше">+</button></span>
    </div>`;
  }).join("");
  $("prSum").textContent = diffN ? `С расхождением: ${diffN} поз.` : "Всё полностью";
}
$("prAll").onclick = () => { linesOf(PR.ev.id).forEach(l => PR.vals.set(l.id, PR.mode === "load" ? +l.qty : (l.qty_out != null ? +l.qty_out : +l.qty))); renderProcess(); };
$("prList").addEventListener("click", ev => {
  const b = ev.target.closest("button[data-pa]"); if(!b) return;
  const id = +b.closest("[data-pr]").dataset.pr; PR.vals.set(id, Math.max(0, (PR.vals.get(id) || 0) + (b.dataset.pa === "inc" ? 1 : -1))); renderProcess();
});
$("prList").addEventListener("change", ev => {
  if(ev.target.dataset.pa !== "qty") return;
  PR.vals.set(+ev.target.closest("[data-pr]").dataset.pr, Math.max(0, Math.round(num(ev.target.value) || 0))); renderProcess();
});
$("prSave").onclick = async () => {
  const e = PR.ev, field = PR.mode === "load" ? "qty_out" : "qty_back";
  $("prSave").disabled = true;
  const res = await Promise.all([...PR.vals].map(([id, v]) => sb.from("event_items").update({ [field]:v }).eq("id", id)));
  const bad = res.find(r => r.error);
  if(bad){ $("prSave").disabled = false; $("prErr").textContent = errText(bad.error); $("prErr").hidden = false; return; }
  PR.vals.forEach((v, id) => { const l = lines.find(x => x.id === id); if(l) l[field] = v; });
  const ok = await setEvStatus(e, PR.mode === "load" ? "out" : "returned");
  $("prSave").disabled = false;
  if(!ok) return;
  $("prScrim").hidden = true;
  if(PR.mode === "load") toast("Отгружено — мероприятие на выезде");
  else { const s = shortagesOf(e); toast(s.length ? `Возврат принят. Не вернулось: ${s.reduce((a, x) => a + x.miss, 0)} ед.` : "Возврат принят — всё на месте"); }
};

// ---------- добавить человека ----------
const CR = { ev:null, mode:"staff" };
function crMode(m){
  CR.mode = m;
  document.querySelectorAll("[data-crmode]").forEach(b => b.classList.toggle("active", b.dataset.crmode === m));
  $("crStaffWrap").hidden = m !== "staff"; $("crNameWrap").hidden = m !== "ext"; $("crPhoneWrap").hidden = m !== "ext";
}
document.querySelectorAll("[data-crmode]").forEach(b => b.onclick = () => crMode(b.dataset.crmode));
function openCrew(e){
  CR.ev = e;
  const taken = new Set(crewOf(e.id).filter(c => c.user_id).map(c => c.user_id));
  const staff = Object.values(profiles).filter(p => LV[p.role] >= LV.viewer && !taken.has(p.id)).sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", "ru"));
  $("c_user").innerHTML = staff.length ? staff.map(p => {
    const busy = crewBusy({ user_id:p.id }, e);
    return `<option value="${p.id}">${esc(p.full_name || p.email)}${busy.length ? " — занят: «" + esc(busy[0].title) + "»" : ""}</option>`;
  }).join("") : `<option value="">Все сотрудники уже в команде</option>`;
  ["c_name","c_phone","c_job","c_note"].forEach(id => $(id).value = "");
  $("crHint").textContent = `«${e.title}», ${fmtRange(e)}`;
  $("crErr").hidden = true; crMode(staff.length ? "staff" : "ext"); $("crScrim").hidden = false;
}
$("crForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const err = t => { $("crErr").textContent = t; $("crErr").hidden = false; };
  const d = { event_id:CR.ev.id, job:$("c_job").value.trim() || null, note:$("c_note").value.trim() || null };
  if(CR.mode === "staff"){ d.user_id = $("c_user").value; if(!d.user_id) return err("Выберите сотрудника или переключитесь на «Без аккаунта»."); }
  else { d.name = $("c_name").value.trim(); d.phone = $("c_phone").value.trim() || null; if(!d.name) return err("Впишите имя."); }
  $("crSave").disabled = true;
  const res = await sb.from("event_crew").insert(d).select().single();
  $("crSave").disabled = false;
  if(res.error) return err(/duplicate/i.test(res.error.message || "") ? "Этот сотрудник уже в команде." : errText(res.error));
  if(res.data && !crew.find(c => c.id === res.data.id)) crew.push(res.data);
  $("crScrim").hidden = true; renderEvents();
  const busy = crewBusy(res.data || d, CR.ev);
  toast(busy.length ? `Добавлен(а), но в эти даты также на «${busy[0].title}»` : "Добавлен(а) в команду");
});
$("evMine").addEventListener("change", () => { EV.mine = $("evMine").checked; try { localStorage.setItem("sklad.evMine", EV.mine ? "1" : "0"); } catch(_) {} renderEvents(); });

document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => $(b.dataset.close).hidden = true);
["evScrim","pkScrim","prScrim","crScrim"].forEach(id => $(id).addEventListener("mousedown", e => { if(e.target === $(id)) $(id).hidden = true; }));

// ---------- журнал: записи о мероприятиях ----------
function evVal(k, v){
  if(v == null || v === "") return "—";
  if(k === "status") return EV_ST[v] ? EV_ST[v].t : v;
  if(k === "responsible") return personName(v) || "—";
  if(k === "date_from" || k === "date_to") return fmtD(v, { day:"numeric", month:"short", year:"numeric" });
  return String(v);
}
function logEventHtml(r, name){
  const t = new Date(r.created_at);
  const link = evById(r.item_id) ? `<a href="#ev-${r.item_id}" data-ev="${r.item_id}">«${esc(r.item_name)}»</a>` : `«${esc(r.item_name || "")}»`;
  let what;
  if(r.kind === "event"){
    const ch = r.changes ? Object.entries(r.changes).filter(([k]) => EV_FIELDS[k]).map(([k, [a, b]]) => `<li>${EV_FIELDS[k]}: ${esc(evVal(k, a))} → <b>${esc(evVal(k, b))}</b></li>`).join("") : "";
    const verb = { insert:"создал(а) мероприятие", update:"изменил(а) мероприятие", delete:"удалил(а) мероприятие" }[r.action];
    what = `<span class="act ${r.action}">${verb}</span> ${link}${ch ? `<ul>${ch}</ul>` : ""}`;
  } else if(r.kind === "event_crew"){
    const c = r.changes || {}, who = esc(c._who || "человек") + (c.job ? ` (${esc(c.job)})` : "");
    what = r.action === "insert" ? `<span class="act insert">добавил(а) в команду</span> ${who} — ${link}`
         : r.action === "delete" ? `<span class="act delete">убрал(а) из команды</span> ${who} — ${link}`
         : `<span class="act update">изменил(а) в команде</span> ${who} — ${link}`;
  } else {
    const c = r.changes || {}, [a, b] = c.qty || [], it = esc(c._item || "позиция");
    what = r.action === "insert" ? `<span class="act insert">добавил(а)</span> ${it} × ${esc(fmt(b))} в ${link}`
         : r.action === "delete" ? `<span class="act delete">убрал(а)</span> ${it} из ${link}`
         : `<span class="act update">изменил(а)</span> ${it} в ${link}: ${esc(fmt(a))} → <b>${esc(fmt(b))}</b>`;
  }
  return `<div class="ev"><time datetime="${esc(r.created_at)}" title="${t.toLocaleString("ru-RU")}">${t.toLocaleDateString("ru-RU", { day:"2-digit", month:"2-digit" })} ${t.toLocaleTimeString("ru-RU", { hour:"2-digit", minute:"2-digit" })}</time>
    <div class="what"><span class="who">${esc(name(r.user_id))}</span> ${what}</div></div>`;
}

boot();
})();
