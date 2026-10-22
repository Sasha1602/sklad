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
  if(/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Нет связи с сервером. Проверьте интернет.";
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

let me = null, items = [], profiles = {}, logRows = [], events = [], lines = [], crew = [], schedules = [], periods = [], kits = [], kitItems = [], venues = [], halls = [], channel = null, started = false, recovering = false;

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
  let { data: prof, error } = await sb.from("profiles").select("*").eq("id", uid).maybeSingle();
  if(error && isNetErr(error)){ const snap = loadSnap(uid); if(snap && snap.me){ prof = snap.me; error = null; } }
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
  $("usersTab").hidden = !can("manager");
  $("meName").onclick = () => openSchedule(me.id);
  $("addBtn").hidden = !can("manager");

  // мгновенно показываем последний снимок, потом подтягиваем свежие данные
  const snap = loadSnap(me.id);
  if(snap){ applySnap(snap); renderStock(); renderEvents(); renderUsers(); renderLog(); renderToday(); }
  const ok = await loadAll();
  subscribe();
  if(ok) flushOutbox();
  refreshPushState();
  route(location.hash.slice(1) || "today");
}
// Переход по адресу: #today, #stock, #ev-12, #i-5 (позиция), #k-3 (комплект)…
function route(h){
  if(/^ev-\d+$/.test(h)) return openEvent(+h.slice(3));
  if(/^i-\d+$/.test(h)){ const it = items.find(x => x.id === +h.slice(2)); setStockView("items"); setTab("stock"); if(it) openEditor(it); else toast("Позиция не найдена — возможно, её удалили"); return; }
  if(/^k-\d+$/.test(h)){ setStockView("kits"); setTab("stock"); KIT.focus = +h.slice(2); renderKits(); return; }
  if(["today","stock","events","log","users"].includes(h)){ if(h === "events") EV.open = null; setTab(h); renderEvents(); return; }
  setTab("today");
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
    .on("postgres_changes", { event:"*", schema:"public", table:"kits" }, p => {
      kits = upsertRow(kits, p); renderKits(); renderEvents();
    })
    .on("postgres_changes", { event:"*", schema:"public", table:"kit_items" }, p => {
      kitItems = upsertRow(kitItems, p); renderKits(); renderEvents();
    })
    .on("postgres_changes", { event:"*", schema:"public", table:"staff_schedule" }, p => {
      if(p.eventType === "DELETE") schedules = schedules.filter(x => x.user_id !== p.old.user_id);
      else { const k = schedules.findIndex(x => x.user_id === p.new.user_id); if(k >= 0) schedules[k] = p.new; else schedules.push(p.new); }
      renderUsers(); renderEvents(); if(!$("scScrim").hidden) renderScheduleSheet();
    })
    .on("postgres_changes", { event:"*", schema:"public", table:"staff_periods" }, p => {
      periods = upsertRow(periods, p); renderUsers(); renderEvents(); if(!$("scScrim").hidden) renderScheduleSheet();
    })
    .on("postgres_changes", { event:"*", schema:"public", table:"event_crew" }, p => {
      crew = upsertRow(crew, p); renderEvents(); renderUsers();
    })
    .on("postgres_changes", { event:"*", schema:"public", table:"venues" }, p => {
      venues = upsertRow(venues, p); renderEvents(); if(!$("vnScrim").hidden) renderVenues();
    })
    .on("postgres_changes", { event:"*", schema:"public", table:"venue_halls" }, p => {
      halls = upsertRow(halls, p); renderEvents(); if(!$("vnScrim").hidden) renderVenues();
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
  if(t === "users" && !can("manager")) t = "stock";
  document.querySelectorAll("#mainTabs .tab").forEach(b => b.classList.toggle("active", b.dataset.tab === t));
  ["today","stock","events","log","users"].forEach(x => $("tab-" + x).hidden = x !== t);
  if(t === "today") renderToday();
  if(t === "events" && EV.open){ history.replaceState(null, "", "#ev-" + EV.open); }
  else history.replaceState(null, "", "#" + t);
}
window.addEventListener("hashchange", () => {
  if(!me) return;
  const h = location.hash.slice(1);
  route(h);
});
document.querySelectorAll("#mainTabs .tab").forEach(b => b.onclick = () => {
  if(b.dataset.tab === "events" && b.classList.contains("active") && EV.open){ closeEvent(); return; }
  setTab(b.dataset.tab);
});

// ---------- склад ----------
function placesOf(){ return [...new Set(items.map(i => i.place || "Без места"))].sort((a,b) => a.localeCompare(b,"ru")); }
function renderStock(){
  if(me) scheduleToday();
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
  const { error } = await dbUpdate("items", id, patch);
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
function updFilterCount(){
  const n = ["fPlace","fCat","fState","fStatus"].filter(id => $(id).value).length + ($("fIssues").checked ? 1 : 0);
  $("fCount").textContent = n; $("fCount").hidden = !n;
}
["fPlace","fCat","fState","fStatus","fIssues"].forEach(id => $(id).addEventListener("input", updFilterCount));
$("fToggle").onclick = () => { const f = $("fToggle").parentElement, on = !f.classList.contains("open"); f.classList.toggle("open", on); $("fToggle").setAttribute("aria-expanded", on); };

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
  ["evScrim","pkScrim","prScrim","crScrim","scScrim","kitScrim","ekScrim","qkScrim","bdScrim","calScrim","vnScrim"].forEach(id => $(id).hidden = true);
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
    if(r.kind === "loss"){ const t = new Date(r.created_at), c = r.changes || {}; return `<div class="ev"><time datetime="${esc(r.created_at)}">${t.toLocaleDateString("ru-RU", { day:"2-digit", month:"2-digit" })} ${t.toLocaleTimeString("ru-RU", { hour:"2-digit", minute:"2-digit" })}</time><div class="what"><span class="who">${esc(name(r.user_id))}</span> <span class="act ${r.action === "found" ? "insert" : "delete"}">${r.action === "found" ? "нашёл(ась)" : "списал(а) потерю"}</span> ${esc(c._item || "позиция")} × ${esc(fmt(c.n))} — ${evById(r.item_id) ? `<a href="#ev-${r.item_id}" data-ev="${r.item_id}">«${esc(r.item_name)}»</a>` : `«${esc(r.item_name || "")}»`}</div></div>`; }
    if(r.kind === "kit"){ const t = new Date(r.created_at); return `<div class="ev"><time datetime="${esc(r.created_at)}">${t.toLocaleDateString("ru-RU", { day:"2-digit", month:"2-digit" })} ${t.toLocaleTimeString("ru-RU", { hour:"2-digit", minute:"2-digit" })}</time><div class="what"><span class="who">${esc(name(r.user_id))}</span> <span class="act ${r.action}">${{ insert:"создал(а) комплект", update:"изменил(а) комплект", delete:"удалил(а) комплект" }[r.action]}</span> ${esc(r.item_name || "")}</div></div>`; }
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
  if(!can("manager")) return;
  const A = can("admin");
  const list = Object.values(profiles).sort((a,b) => (a.role === "pending" ? -1 : 0) - (b.role === "pending" ? -1 : 0) || (a.full_name || "").localeCompare(b.full_name || "", "ru"));
  const pend = list.filter(p => p.role === "pending").length;
  $("pendingCount").textContent = pend; $("pendingCount").hidden = !pend || !A;
  $("userList").innerHTML = list.map(p => `<div class="urow${p.role === "pending" ? " pend" : ""}" data-uid="${p.id}">
    <div><div class="nm">${esc(p.full_name || "Без имени")}${p.id === me.id ? " (вы)" : ""}</div><div class="em">${esc(p.email || "")} · с ${new Date(p.created_at).toLocaleDateString("ru-RU")}</div>
      ${p.role !== "pending" ? `<div class="em">${esc(scheduleSummary(p.id))}</div>` : ""}</div>
    <div class="uact">${p.role !== "pending" && !EV.schedMissing ? `<button type="button" class="btn sm" data-sched="${p.id}">График</button>` : ""}
    <select class="field" data-uid="${p.id}" aria-label="Роль" ${p.id === me.id || !A ? "disabled" : ""}>${Object.keys(ROLES).map(r => `<option value="${r}" ${r === p.role ? "selected" : ""}>${ROLES[r]}</option>`).join("")}</select></div>
  </div>`).join("");
  renderAvail();
  renderPushSetup();
}
function renderPushSetup(){
  const box = $("pushSetup"); if(!box) return;
  if(!can("admin")){ box.innerHTML = ""; return; }
  box.innerHTML = pushKey()
    ? `<h3 class="sect">Уведомления</h3><p class="hint">Ключ уведомлений настроен. Каждый сотрудник включает уведомления у себя на экране «Сегодня».</p>`
    : `<h3 class="sect">Уведомления</h3><p class="hint">Уведомления ещё не настроены. Сгенерируйте ключи и следуйте инструкции из README («Push-уведомления»). Ключи создаются прямо в вашем браузере и никуда не отправляются.</p>
       <button type="button" class="btn" data-genkeys>Сгенерировать ключи</button><div id="keysOut"></div>`;
}
document.addEventListener("click", async e => {
  if(!e.target.closest("[data-genkeys]")) return;
  let k;
  try { k = await genVapid(); } catch(ex){ $("keysOut").innerHTML = `<p class="msg">Не удалось создать ключи: браузер не поддерживает шифрование или сайт открыт не по https. Откройте сайт по адресу https://… в Chrome или Safari.</p>`; return; }
  $("keysOut").innerHTML = `<div class="keys">
    <p><b>1. В config.js</b> добавьте строку (публичный ключ):</p><pre>PUSH_PUBLIC_KEY: "${k.pub}",</pre>
    <p><b>2. В Supabase → Edge Functions → Secrets</b> добавьте секреты:</p>
    <pre>VAPID_PUBLIC_KEY = ${k.pub}\nVAPID_PRIVATE_KEY = ${k.priv}\nVAPID_SUBJECT = mailto:${esc(me.email || "admin@example.com")}\nNOTIFY_SECRET = ${k.secret}</pre>
    <p><b>3. Секрет NOTIFY_SECRET</b> также понадобится в 07_push.sql (шаг из README).</p>
    <p class="hint">Сохраните эти значения сейчас: закрытый ключ больше нигде не появится. Никому его не пересылайте.</p></div>`.replace(/\\n/g, "\n");
});
$("userList").addEventListener("click", e => { const b = e.target.closest("[data-sched]"); if(b) openSchedule(b.dataset.sched); });
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
    const sent = l.qty_out != null ? +l.qty_out : +l.qty, back = l.qty_back != null ? +l.qty_back : sent, wo = num(l.written_off) || 0;
    return sent - back - wo > 0 ? { l, it:itemById(l.item_id), miss:sent - back - wo, back, wo } : null;
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
  scheduleToday();
  const outN = events.filter(e => e.status === "out").length;
  $("outCount").textContent = outN; $("outCount").hidden = !outN;
  $("outCount").title = "На выезде: " + outN;
  $("evAddBtn").hidden = !can("manager") || EV.missing;
  $("venuesBtn").hidden = !can("viewer") || EV.missing;
  $("quickBtn").hidden = !can("worker") || EV.missing;
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
    if(evs.length) cls.push("has");
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
  const t = todayKey();
  let html = mineNote() + `<div class="dp-head"><h3>${fmtD(k, { weekday:"long", day:"numeric", month:"long" })}</h3>${can("manager") ? `<button class="btn" type="button" data-newev="${k}">+ Мероприятие на этот день</button>` : ""}</div>`;
  if(evs.length) html += `<div class="evcards">${evs.map(evCard).join("")}</div>`;
  else {
    html += `<p class="hint">В этот день мероприятий нет${can("manager") ? " — можно создать новое" : ""}.</p>`;
    const next = events.filter(e => evVisible(e) && (e.status === "out" || (e.status === "planned" && e.date_to >= t))).sort((a, b) => a.date_from.localeCompare(b.date_from)).slice(0, 5);
    if(next.length) html += `<h3 class="sect" style="margin:6px 0 0">Ближайшие</h3><div class="evcards">${next.map(evCard).join("")}</div>`;
  }
  $("dayPanel").innerHTML = html;
}

function evCard(e){
  const ls = linesOf(e.id), units = ls.reduce((a, l) => a + lineQty(l, e), 0);
  const c = conflictsOf(e), s = shortagesOf(e), d = dparse(e.date_from), resp = personName(e.responsible), cr = crewOf(e.id);
  const busyN = cr.filter(x => crewBusy(x, e).length || (x.user_id && !EV.schedMissing && personIssues(x.user_id, e.date_from, e.date_to).length)).length;
  const tags = [...(e.quick ? [`<span class="chip c-off">быстрый прокат</span>`] : []), `<span class="chip ${evSt(e).c}">${evSt(e).t}</span>`, `<span class="cnt">${ls.length} поз. · ${units} ед.</span>`];
  if(c.length) tags.push(`<span class="chip c-bad">Не хватает: ${c.length} поз.</span>`);
  if(s.length) tags.push(`<span class="chip c-bad">Не вернулось: ${s.reduce((a, x) => a + x.miss, 0)} ед.</span>`);
  if(!ls.length && isActive(e)) tags.push(`<span class="chip c-warn">Оборудование не выбрано</span>`);
  if(busyN && isActive(e)) tags.push(`<span class="chip c-bad">Люди заняты: ${busyN}</span>`);
  if(me && isActive(e) && cr.some(c => c.user_id === me.id)) tags.unshift(`<span class="chip c-ok">вы едете</span>`);
  else if(me && isActive(e) && e.responsible === me.id) tags.unshift(`<span class="chip c-ok">вы ответственный</span>`);
  return `<button type="button" class="evcard st-${e.status}" data-ev="${e.id}">
    <span class="evdate"><b>${d.getDate()}</b><small>${d.toLocaleDateString("ru-RU", { month:"short" }).replace(/\./g, "")}</small></span>
    <span class="evbody"><span class="evtitle">${esc(e.title)}</span>
      <span class="evmeta">${esc(fmtRange(e))}${e.venue ? " · " + esc(e.venue) : ""}${resp ? " · отв. " + esc(resp) : ""}</span>
      ${cr.length ? `<span class="evcrew">Едут: ${esc(cr.slice(0, 4).map(crewName).join(", "))}${cr.length > 4 ? " и ещё " + (cr.length - 4) : ""}</span>` : ""}
      <span class="evtags">${tags.join("")}</span></span>
  </button>`;
}

// подсказка, если фильтр «только мои» что-то скрывает
function mineNote(){
  if(!EV.mine) return "";
  const hidden = events.filter(e => e.status !== "cancelled" && !isMine(e) && (e.status === "out" || e.date_to >= todayKey())).length;
  return hidden ? `<div class="banner warn mine">Включён фильтр «только мои» — скрыто мероприятий: ${hidden}. <button type="button" class="link" data-showall>Показать все</button></div>` : "";
}
function renderEvList(){
  const t = todayKey(), evs = events.filter(evVisible);
  const overdue = evs.filter(e => e.status === "planned" && e.date_to < t).sort((a, b) => a.date_from.localeCompare(b.date_from));
  const up = evs.filter(e => e.status === "out" || (e.status === "planned" && e.date_to >= t)).sort((a, b) => a.date_from.localeCompare(b.date_from));
  const past = evs.filter(e => e.status === "returned" || e.status === "cancelled").sort((a, b) => b.date_from.localeCompare(a.date_from)).slice(0, 40);
  let h = mineNote();
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
  if(e.target.closest("[data-showall]")){ EV.mine = false; try { localStorage.setItem("sklad.evMine", "0"); } catch(_) {} renderEvents(); return; }
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
  if(e.status === "planned" && W) acts.push(btn("build", "Собрать сканером", ls.length ? "" : "primary"));
  if(e.status === "out" && W) acts.push(btn("return", "Принять возврат", "primary"));
  if(M && (e.status === "planned" || e.status === "out")) acts.push(btn("pick", "+ Оборудование"));
  if(M && (e.status === "planned" || e.status === "out") && kits.length) acts.push(btn("kit", "+ Комплект"));
  if(M) acts.push(btn("edit", "Изменить"));
  if(ls.length) acts.push(btn("copy", "Копировать список", "ghost"));
  if(e.status !== "cancelled") acts.push(btn("cal", "В календарь", "ghost"));
  acts.push(`<span class="sp"></span>`);
  if(M && e.status === "planned") acts.push(btn("cancel", "Отменить мероприятие", "ghost"));
  if(M && e.status === "cancelled") acts.push(btn("restore", "Восстановить"));
  if(M && e.status === "returned") acts.push(btn("reopen", "Вернуть в «На выезде»", "ghost"));
  if(M && e.status !== "out") acts.push(btn("delete", "Удалить", "danger"));

  let banner = "";
  if(c.length) banner += `<div class="banner bad"><b>Не хватает оборудования на эти даты</b><ul>${c.map(x => `<li>${esc(x.it.name)}: нужно ${x.need}, свободно ${Math.max(0, x.free)}${x.others.length ? ` — занято: ${x.others.map(o => `<a href="#ev-${o.ev.id}" data-ev="${o.ev.id}">«${esc(o.ev.title)}»</a> (${o.qty})`).join(", ")}` : ""}</li>`).join("")}</ul></div>`;
  if(s.length) banner += `<div class="banner bad losses"><b>Не вернулось с мероприятия — разберите недостачу</b>
    ${s.map(x => `<div class="lossrow" data-loss="${x.l.id}"><span class="lossname">${esc(x.it ? x.it.name : "позиция")} — <b>${x.miss}</b> ${esc(x.it ? x.it.unit || "шт." : "шт.")}${x.wo ? ` <span class="muted">(списано ${x.wo})</span>` : ""}</span>
      <span class="lossacts">${x.miss > 1 ? `<input type="number" class="field lossn" min="1" max="${x.miss}" value="${x.miss}" aria-label="Сколько">` : ""}
      ${W ? `<button type="button" class="btn sm" data-found="${x.l.id}">Нашёлся</button>` : ""}${M ? `<button type="button" class="btn sm danger" data-wo="${x.l.id}">Списать</button>` : ""}</span></div>`).join("")}
    <p class="hint">«Нашёлся» — вернули позже (забыли в машине, привёз техник). «Списать» — потеряно: количество на складе уменьшится, в журнале останется запись.</p></div>`;
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
          ${e.venue ? `<span><small>Площадка</small>${esc(e.venue)}${venueAddrHtml(e)}</span>` : ""}
          ${e.client ? `<span><small>Заказчик</small>${esc(e.client)}</span>` : ""}
          ${resp ? `<span><small>Ответственный</small>${esc(resp)}</span>` : ""}
          <span><small>Оборудование</small>${ls.length} поз. · ${units} ед.</span>
          ${kitsInEvent(e).length ? `<span><small>Комплекты</small>${kitsInEvent(e).map(k => esc(k.name) + (isActive(e) && kitIncomplete(k.id).length ? ` <span class="chip c-bad xs">неполный</span>` : "")).join(", ")}</span>` : ""}
        </div>
        ${e.note ? `<p class="evnote">${esc(e.note)}</p>` : ""}
        ${venueNoteHtml(e)}
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
    const iss = isActive(e) && c.user_id && !EV.schedMissing ? personIssues(c.user_id, e.date_from, e.date_to) : [];
    const ph = c.phone || "";
    return `<div class="crow${busy.length || iss.length ? " bad" : ""}" data-crew="${c.id}">
      <div class="cwho"><b>${esc(crewName(c))}</b>${c.user_id === me.id ? ` <span class="chip xs c-info">вы</span>` : ""}${c.job ? ` <span class="job">${esc(c.job)}</span>` : ""}
        ${c.note ? `<div class="sub">${esc(c.note)}</div>` : ""}
        ${busy.length ? `<div class="neg cwarn">В эти даты также на ${busy.map(o => `<a href="#ev-${o.id}" data-ev="${o.id}">«${esc(o.title)}»</a>`).join(", ")}</div>` : ""}
        ${iss.length ? `<div class="neg cwarn">${esc(issuesText(iss))}</div>` : ""}</div>
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
  const fb = ev.target.closest("[data-found],[data-wo]");
  if(fb){ resolveLoss(e, fb); return; }
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
  if(a === "kit") openEvKits(e);
  if(a === "build") openBuild(e);
  if(a === "load") openProcess(e, "load");
  if(a === "return") openProcess(e, "return");
  if(a === "copy") copyEventList(e);
  if(a === "cal") openCal(e);
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
    const { error } = await dbUpdate("event_items", l.id, { qty:v });
    if(error) toast(errText(error));
  }, 600);
}
async function setEvStatus(e, status, msg){
  const { error } = await dbUpdate("events", e.id, { status });
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
  $("venueList").innerHTML = venues.map(v => `<option value="${esc(v.name)}">${v.address ? esc(v.address) : ""}</option>`).join("");
  const ve = e && e.venue_id ? venueById(e.venue_id) : null;
  if(ve) $("v_venue").value = ve.name;
  venueFormSync(e ? e.hall_id : null);
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
  // Площадка из справочника (или новая — менеджер добавит её туда автоматически) и зал.
  if(!VN.missing){
    let v = venueByName(d.venue);
    if(!v && d.venue && can("manager")){
      const r = await sb.from("venues").insert({ name:d.venue }).select().single();
      if(!r.error && r.data){ v = r.data; if(!venueById(v.id)) venues.push(v); }
    }
    const h = v && $("v_hall").value ? halls.find(x => x.id === +$("v_hall").value) : null;
    d.venue_id = v ? v.id : null; d.hall_id = h ? h.id : null;
    if(v) d.venue = v.name + (h ? " · " + h.name : "");
  }
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
  KC.kit = null; PR.zeroed = false; setTimeout(renderKitCheck, 0);
  PR.ev = e; PR.mode = mode; PR.vals = new Map();
  linesOf(e.id).forEach(l => PR.vals.set(l.id, mode === "load" ? +l.qty : (l.qty_out != null ? +l.qty_out : +l.qty)));
  $("prTitle").textContent = mode === "load" ? "Отгрузка на мероприятие" : "Приём возврата";
  $("prHint").textContent = mode === "load"
    ? `«${e.title}». Проверьте, сколько реально погрузили. Если чего-то меньше — исправьте число.`
    : `«${e.title}». Пересчитайте, что вернулось. Всё, чего не хватает, будет отмечено как «не вернулось».`;
  $("prSave").textContent = mode === "load" ? "Отгрузить" : "Принять возврат";
  $("prErr").hidden = true; renderProcess(); $("prScrim").hidden = false;
}
function renderProcess(hl){
  const e = PR.ev;
  const ls = linesOf(e.id).map(l => ({ l, it:itemById(l.item_id) })).filter(x => x.it)
    .sort((a, b) => (a.it.place || "").localeCompare(b.it.place || "", "ru") || a.it.name.localeCompare(b.it.name, "ru", { numeric:true }));
  let lastPlace = null, diffN = 0;
  $("prList").innerHTML = ls.map(({ l, it }) => {
    const target = PR.mode === "load" ? +l.qty : (l.qty_out != null ? +l.qty_out : +l.qty);
    const v = PR.vals.get(l.id), less = v < target; if(less) diffN++;
    const head = it.place !== lastPlace ? `<div class="pkcat">${esc(it.place || "Без места")}</div>` : ""; lastPlace = it.place;
    return head + `<div class="pkrow${less ? " bad" : " on"}${l.id === hl ? " flash" : ""}" data-pr="${l.id}">
      <div class="lname">${esc(it.name)}${it.maker ? ` <span class="maker">${esc(it.maker)}</span>` : ""}<div class="sub mono">${itemCode(it.id)}</div></div>
      <div class="pkfree">${PR.mode === "load" ? "нужно" : "уехало"} <b>${target}</b> ${esc(it.unit || "шт.")}${less ? `<span class="neg">${PR.mode === "load" ? "погружено меньше" : "не вернулось " + (target - v)}</span>` : ""}</div>
      <span class="qtyBox sm"><button type="button" data-pa="dec" aria-label="Меньше">−</button><input type="number" min="0" inputmode="numeric" value="${v}" data-pa="qty" aria-label="${PR.mode === "load" ? "Погружено" : "Вернулось"}"><button type="button" data-pa="inc" aria-label="Больше">+</button></span>
    </div>`;
  }).join("");
  $("prSum").textContent = diffN ? `С расхождением: ${diffN} поз.` : "Всё полностью";
  if(hl){ const r = $("prList").querySelector(`[data-pr="${hl}"]`); if(r) r.scrollIntoView({ block:"nearest" }); }
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
  const res = await Promise.all([...PR.vals].map(([id, v]) => dbUpdate("event_items", id, { [field]:v })));
  const bad = res.find(r => r.error);
  if(bad){ $("prSave").disabled = false; $("prErr").textContent = errText(bad.error); $("prErr").hidden = false; return; }
  PR.vals.forEach((v, id) => { const l = lines.find(x => x.id === id); if(l) l[field] = v; });
  const ok = await setEvStatus(e, PR.mode === "load" ? "out" : "returned");
  $("prSave").disabled = false;
  if(!ok) return;
  $("prScrim").hidden = true; stopScan();
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
    const busy = crewBusy({ user_id:p.id }, e), iss = EV.schedMissing ? [] : personIssues(p.id, e.date_from, e.date_to);
    const why = busy.length ? "на «" + busy[0].title + "»" : iss.length ? (iss[0].t === "shift" ? "смена " + fmtD(iss[0].k) : "недоступен") : "";
    return `<option value="${p.id}">${esc(p.full_name || p.email)}${why ? " — " + esc(why) : " — свободен"}</option>`;
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
["evScrim","pkScrim","prScrim","crScrim","kitScrim","ekScrim","qkScrim","calScrim"].forEach(id => $(id).addEventListener("mousedown", e => { if(e.target === $(id)) $(id).hidden = true; }));

// =====================================================================
// ---------- графики сотрудников ----------
// =====================================================================
const dayMs = 864e5;
const addDays = (k, n) => { const d = dparse(k); d.setDate(d.getDate() + n); return dkey(d); };
const dayDiff = (a, b) => Math.round((dparse(a) - dparse(b)) / dayMs);
const scheduleOf = uid => schedules.find(x => x.user_id === uid);
const periodsOf = uid => periods.filter(p => p.user_id === uid).sort((a, b) => a.date_from.localeCompare(b.date_from));

// Что у человека в этот день по графику: null — свободен.
function personDay(uid, k){
  const ps = periods.filter(p => p.user_id === uid && p.date_from <= k && p.date_to >= k);
  const busy = ps.find(p => p.kind === "busy");
  if(busy) return { t:"busy", why:busy.note || "Недоступен" };
  const sc = scheduleOf(uid);
  if(sc){
    const vac = ps.find(p => p.kind === "free");
    const cyc = sc.work_days + sc.off_days, m = ((dayDiff(k, sc.anchor) % cyc) + cyc) % cyc;
    if(m < sc.work_days) return vac ? { t:"vac", why:vac.note || "Отпуск на основной работе" } : { t:"shift", why:(sc.label || "Основная работа") + " — смена" };
    if(vac) return { t:"vac", why:vac.note || "Отпуск на основной работе" };
  }
  return null;
}
// Проблемные дни человека в диапазоне дат (смены и недоступность).
function personIssues(uid, from, to){
  const res = [];
  for(let k = from; k <= to; k = addDays(k, 1)){ const d = personDay(uid, k); if(d && (d.t === "shift" || d.t === "busy")) res.push({ k, ...d }); }
  return res;
}
function nextShifts(uid, n){
  const res = [], sc = scheduleOf(uid); if(!sc) return res;
  for(let i = 0, k = todayKey(); i < 400 && res.length < n; i++, k = addDays(k, 1)){ const d = personDay(uid, k); if(d && d.t === "shift") res.push(k); }
  return res;
}
function scheduleSummary(uid){
  if(EV.schedMissing) return "";
  const sc = scheduleOf(uid), now = todayKey();
  const parts = [];
  if(sc){ const nx = nextShifts(uid, 1); parts.push(`${sc.label || "Основная работа"}: ${sc.work_days}/${sc.off_days}` + (nx.length ? `, ближайшая смена ${fmtD(nx[0])}` : "")); }
  const cur = periodsOf(uid).filter(p => p.date_to >= now).slice(0, 2).map(p => `${p.kind === "free" ? "отпуск на основной" : "недоступен"} ${fmtD(p.date_from)}–${fmtD(p.date_to)}`);
  parts.push(...cur);
  return parts.length ? parts.join(" · ") : "График не задан";
}
function issuesText(iss){
  if(!iss.length) return "";
  const shifts = iss.filter(x => x.t === "shift").map(x => fmtD(x.k)), busy = iss.filter(x => x.t === "busy");
  const out = [];
  if(shifts.length) out.push(`Смена на основной работе: ${shifts.join(", ")}`);
  if(busy.length) out.push(`Недоступен ${busy.map(x => fmtD(x.k)).join(", ")}${busy[0].why ? " (" + busy[0].why + ")" : ""}`);
  return out.join(". ");
}

// ---------- таблица «Кто свободен» ----------
const AV = { start:null, days:21 };
function renderAvail(){
  if(!$("avTable") || !can("manager")) return;
  if(!AV.start) AV.start = todayKey();
  const ppl = Object.values(profiles).filter(p => LV[p.role] >= LV.viewer).sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", "ru"));
  const days = Array.from({ length:AV.days }, (_, i) => addDays(AV.start, i)), t = todayKey();
  $("avTitle").textContent = `${fmtD(days[0])} – ${fmtD(days[days.length - 1])}`;
  if(EV.schedMissing){ $("avTable").innerHTML = `<tr><td class="hint" style="padding:14px">Чтобы вести графики, выполните в Supabase файл <code>supabase/04_schedule.sql</code>.</td></tr>`; return; }
  const head = `<tr><th class="nmcol"></th>${days.map(k => { const d = dparse(k), we = d.getDay() === 0 || d.getDay() === 6;
    return `<th class="${we ? "we" : ""}${k === t ? " today" : ""}"><small>${d.toLocaleDateString("ru-RU", { weekday:"short" })}</small>${d.getDate()}</th>`; }).join("")}</tr>`;
  const rows = ppl.map(p => `<tr><th class="nmcol"><button type="button" class="link" data-sched="${p.id}">${esc(p.full_name || p.email)}</button></th>${days.map(k => {
    const d = personDay(p.id, k);
    const evs = events.filter(e => isActive(e) && e.date_from <= k && e.date_to >= k && crewOf(e.id).some(c => c.user_id === p.id));
    const cls = [d ? d.t : "", evs.length ? "ev" : "", (evs.length && d && (d.t === "shift" || d.t === "busy")) ? "clash" : "", k === t ? "today" : ""].filter(Boolean).join(" ");
    const tip = [d ? d.why : "", ...evs.map(e => "Мероприятие: " + e.title)].filter(Boolean).join("\n") || "Свободен";
    const label = evs.length ? (evs.length > 1 ? evs.length : esc(evs[0].title.slice(0, 2))) : (d && d.t === "shift" ? "С" : d && d.t === "busy" ? "—" : "");
    return `<td class="${cls}" title="${esc(fmtD(k, { weekday:"short", day:"numeric", month:"short" }) + ": " + tip)}"${evs.length === 1 ? ` data-ev="${evs[0].id}"` : ""}>${label}</td>`;
  }).join("")}</tr>`).join("");
  $("avTable").innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
}
$("avPrev").onclick = () => { AV.start = addDays(AV.start || todayKey(), -7); renderAvail(); };
$("avNext").onclick = () => { AV.start = addDays(AV.start || todayKey(), 7); renderAvail(); };
$("avToday").onclick = () => { AV.start = todayKey(); renderAvail(); };
$("avTable").addEventListener("click", e => {
  const b = e.target.closest("[data-sched]"); if(b){ openSchedule(b.dataset.sched); return; }
  const c = e.target.closest("td[data-ev]"); if(c) openEvent(+c.dataset.ev);
});

// ---------- окно графика ----------
const SC = { uid:null };
function canEditSchedule(uid){ return can("manager") || (uid === me.id && can("viewer")); }
function openSchedule(uid){
  if(EV.schedMissing){ toast("Графики ещё не подключены: нужно выполнить 04_schedule.sql в Supabase"); return; }
  SC.uid = uid;
  const sc = scheduleOf(uid);
  $("s_on").checked = !!sc;
  $("s_label").value = sc ? sc.label || "" : "Основная работа";
  $("s_work").value = sc ? sc.work_days : 1; $("s_off").value = sc ? sc.off_days : 3;
  $("s_anchor").value = sc ? sc.anchor : "";
  $("p_kind").value = "free"; $("p_from").value = todayKey(); $("p_to").value = ""; $("p_note").value = "";
  $("scErr").hidden = true; renderScheduleSheet(); $("scScrim").hidden = false;
}
function renderScheduleSheet(){
  const uid = SC.uid, ed = canEditSchedule(uid), p = profiles[uid];
  $("scTitle").textContent = "График: " + (p ? p.full_name || p.email : "сотрудник");
  $("scFields").hidden = !$("s_on").checked;
  [...$("scForm").elements, ...$("spForm").elements].forEach(el => el.disabled = !ed);
  $("scSave").hidden = !ed; $("spForm").hidden = !ed;
  // предпросмотр по введённым значениям
  if($("s_on").checked && +$("s_work").value > 0 && $("s_anchor").value){
    const tmp = { user_id:uid, label:$("s_label").value, work_days:+$("s_work").value, off_days:+$("s_off").value || 0, anchor:$("s_anchor").value };
    const saved = schedules; schedules = [...schedules.filter(x => x.user_id !== uid), tmp];
    const nx = nextShifts(uid, 6); schedules = saved;
    $("scPreview").textContent = nx.length ? "Ближайшие смены (с учётом исключений): " + nx.map(k => fmtD(k, { weekday:"short", day:"numeric", month:"short" })).join(", ") : "Ближайших смен нет.";
  } else $("scPreview").textContent = $("s_on").checked ? "Укажите график и дату смены — здесь появятся ближайшие смены." : "Сменной работы нет — человек свободен, кроме периодов «недоступен».";
  const ps = periodsOf(uid);
  $("scPeriods").innerHTML = ps.length ? ps.map(x => `<div class="prow${x.date_to < todayKey() ? " past" : ""}">
      <span class="chip ${x.kind === "free" ? "c-ok" : "c-bad"} xs">${x.kind === "free" ? "отпуск на основной" : "недоступен"}</span>
      <b>${fmtD(x.date_from)} – ${fmtD(x.date_to, { day:"numeric", month:"short", year:"numeric" })}</b>${x.note ? ` <span class="muted">${esc(x.note)}</span>` : ""}
      ${ed ? `<button type="button" class="edit" data-pdel="${x.id}" aria-label="Удалить период">✕</button>` : ""}</div>`).join("")
    : `<p class="hint">Исключений нет.</p>`;
}
["s_on","s_work","s_off","s_anchor","s_label"].forEach(id => $(id).addEventListener("input", renderScheduleSheet));
$("scForm").addEventListener("submit", async e => {
  e.preventDefault();
  const err = t => { $("scErr").textContent = t; $("scErr").hidden = false; };
  $("scErr").hidden = true;
  if(!$("s_on").checked){
    const { error } = await sb.from("staff_schedule").delete().eq("user_id", SC.uid);
    if(error) return err(errText(error));
    schedules = schedules.filter(x => x.user_id !== SC.uid);
  } else {
    const d = { user_id:SC.uid, label:$("s_label").value.trim() || "Основная работа", work_days:Math.round(+$("s_work").value), off_days:Math.round(+$("s_off").value || 0), anchor:$("s_anchor").value };
    if(!(d.work_days >= 1 && d.work_days <= 14)) return err("Рабочих дней подряд — от 1 до 14.");
    if(!(d.off_days >= 0 && d.off_days <= 28)) return err("Выходных — от 0 до 28.");
    if(!d.anchor) return err("Укажите дату любой смены.");
    const { error } = await sb.from("staff_schedule").upsert(d);
    if(error) return err(errText(error));
    const k = schedules.findIndex(x => x.user_id === SC.uid); if(k >= 0) schedules[k] = { ...schedules[k], ...d }; else schedules.push(d);
  }
  toast("График сохранён"); renderScheduleSheet(); renderUsers(); renderEvents();
});
$("p_from").addEventListener("change", () => { if(!$("p_to").value || $("p_to").value < $("p_from").value) $("p_to").value = $("p_from").value; });
$("spForm").addEventListener("submit", async e => {
  e.preventDefault();
  const err = t => { $("scErr").textContent = t; $("scErr").hidden = false; };
  const d = { user_id:SC.uid, kind:$("p_kind").value, date_from:$("p_from").value, date_to:$("p_to").value || $("p_from").value, note:$("p_note").value.trim() || null };
  if(!d.date_from) return err("Укажите, с какого числа.");
  if(d.date_to < d.date_from) return err("«По» не может быть раньше «С».");
  const res = await sb.from("staff_periods").insert(d).select().single();
  if(res.error) return err(errText(res.error));
  if(res.data && !periods.find(x => x.id === res.data.id)) periods.push(res.data);
  $("p_note").value = ""; $("scErr").hidden = true; toast("Период добавлен"); renderScheduleSheet(); renderUsers(); renderEvents();
});
$("scPeriods").addEventListener("click", async e => {
  const b = e.target.closest("[data-pdel]"); if(!b) return;
  const { error } = await sb.from("staff_periods").delete().eq("id", +b.dataset.pdel);
  if(error){ toast(errText(error)); return; }
  periods = periods.filter(x => x.id !== +b.dataset.pdel); renderScheduleSheet(); renderUsers(); renderEvents();
});
$("scScrim").addEventListener("mousedown", e => { if(e.target === $("scScrim")) $("scScrim").hidden = true; });

// ---------- маска телефона: +7 (9XX) XXX-XX-XX ----------
function phoneCore(v){
  let d = String(v || "").replace(/\D/g, "");
  if(d[0] === "7" || d[0] === "8") d = d.slice(1);                  // код страны (+7 или 8)
  if(d.length > 10 && (d[0] === "7" || d[0] === "8")) d = d.slice(1); // вставили «+7 8900…» целиком
  return d.slice(0, 10);
}
function phoneFmt(d){
  if(!d) return "";
  let r = "+7 (" + d.slice(0, 3);
  if(d.length >= 3) r += ")";
  if(d.length > 3) r += " " + d.slice(3, 6);
  if(d.length > 6) r += "-" + d.slice(6, 8);
  if(d.length > 8) r += "-" + d.slice(8, 10);
  return r;
}
function phoneMask(inp){
  let prev = phoneCore(inp.value);
  inp.addEventListener("input", e => {
    let d = phoneCore(inp.value);
    const del = (e.inputType || "").startsWith("delete");
    if(del && d.length >= prev.length && prev.length) d = prev.slice(0, -1);   // стёрли скобку или дефис — стираем и цифру
    if(!d && !del && /\d/.test(inp.value)){ inp.value = "+7 "; prev = ""; inp._pfx = true; return; }   // начали с 7 или 8 — это код страны
    if(!prev && !del && !inp._pfx && (d === "7" || d === "8")){ inp.value = "+7 "; inp._pfx = true; return; } // «+7 » уже стоит, ввели 8
    if(!d){ inp.value = del ? "" : "+7 "; prev = ""; inp._pfx = false; return; }
    inp.value = phoneFmt(d); prev = d;
  });
  inp.addEventListener("focus", () => { if(!inp.value){ inp.value = "+7 "; inp._pfx = false; } prev = phoneCore(inp.value); });
  inp.addEventListener("blur", () => { if(!phoneCore(inp.value)) inp.value = ""; });
}
phoneMask($("c_phone"));

// =====================================================================
// ---------- комплекты (кейсы) ----------
// =====================================================================
const KIT = { missing:false, focus:null, edit:null, sel:new Map(), orig:new Map() };
const kitById = id => kits.find(k => k.id === id);
const kitLines = kitId => kitItems.filter(x => x.kit_id === kitId);
const byName = (a, b) => (a.name || "").localeCompare(b.name || "", "ru", { numeric:true });
// Сколько таких комплектов можно собрать на эти даты с учётом других броней.
function kitFree(kitId, from, to, exceptId){
  const ls = kitLines(kitId); if(!ls.length) return 0;
  return Math.min(...ls.map(x => { const it = itemById(x.item_id); return it ? Math.floor(Math.max(0, freeQty(it, from, to, exceptId)) / +x.qty) : 0; }));
}
// Комплекты, которые целиком входят в список мероприятия.
function kitsInEvent(e){
  const ls = linesOf(e.id);
  return kits.filter(k => { const kl = kitLines(k.id); return kl.length && kl.every(x => { const l = ls.find(y => y.item_id === x.item_id); return l && +l.qty >= +x.qty; }); });
}

let SVIEW = "items";
function setStockView(v){
  SVIEW = v;
  document.querySelectorAll("[data-sview]").forEach(b => b.classList.toggle("active", b.dataset.sview === v));
  $("stockMain").hidden = v !== "items"; $("kitsView").hidden = v !== "kits"; $("labelsView").hidden = v !== "labels";
  if(v === "kits") renderKits();
  if(v === "labels") renderLabels();
}
document.querySelectorAll("[data-sview]").forEach(b => b.onclick = () => setStockView(b.dataset.sview));

function renderKits(){
  if(!me || $("kitsView").hidden && !KIT.focus) return;
  const M = can("manager");
  if(KIT.missing){ $("kitsView").innerHTML = `<div class="empty"><strong>Комплекты ещё не подключены</strong>Администратору нужно один раз выполнить <code>supabase/05_kits.sql</code> в Supabase → SQL Editor.</div>`; return; }
  const head = `<div class="filters kithead"><p class="hint">Комплект — кейс или набор с постоянным содержимым. В мероприятие добавляется одной кнопкой, при отгрузке сканируется одной наклейкой.</p><span class="sp"></span>${M ? `<button type="button" class="btn primary" data-kitnew>+ Комплект</button>` : ""}</div>`;
  if(!kits.length){ $("kitsView").innerHTML = head + `<div class="empty"><strong>Комплектов пока нет</strong>${M ? "Создайте первый — например, «Кейс коммутации»: его состав можно взять из места хранения одной кнопкой." : "Менеджер ещё не собрал комплекты."}</div>`; return; }
  $("kitsView").innerHTML = head + `<div class="kitgrid">` + [...kits].sort(byName).map(k => {
    const ls = kitLines(k.id).map(x => ({ x, it:itemById(x.item_id) })).filter(o => o.it).sort((a, b) => byName(a.it, b.it));
    const out = events.filter(e => e.status === "out" && kitsInEvent(e).some(z => z.id === k.id));
    const short = ls.filter(o => (num(o.it.qty_fact) || 0) < +o.x.qty);
    return `<section class="group kit${KIT.focus === k.id ? " focus" : ""}" id="kit-${k.id}">
      <div class="ghead"><h2>${esc(k.name)}</h2><small>${ls.length} поз. · ${ls.reduce((a, o) => a + +o.x.qty, 0)} ед.</small>
        ${M ? `<span class="kitbtns"><button type="button" class="btn sm" data-kitedit="${k.id}">Изменить</button><button type="button" class="btn sm danger" data-kitdel="${k.id}">Удалить</button></span>` : ""}</div>
      <div class="kitmeta"><span class="mono">K-${k.id}</span>${k.place ? `<span>${esc(k.place)}</span>` : ""}${k.note ? `<span class="muted">${esc(k.note)}</span>` : ""}
        ${out.length ? `<span class="chip c-warn xs">на выезде: ${out.map(e => esc(e.title)).join(", ")}</span>` : ""}
        ${short.length ? `<span class="chip c-bad xs">на складе меньше, чем в составе: ${short.length} поз.</span>` : ""}
        ${(inc => inc.length ? `<span class="chip c-bad xs">неполный: ${esc(incText(inc))}</span>` : "")(kitIncomplete(k.id))}</div>
      <div class="kitlist">${ls.map(o => `<div class="kitrow"><span>${esc(o.it.name)}${o.it.maker ? ` <span class="maker">${esc(o.it.maker)}</span>` : ""}</span><b class="mono">× ${+o.x.qty}</b></div>`).join("") || `<p class="hint">Состав пуст — нажмите «Изменить».</p>`}</div>
    </section>`;
  }).join("") + `</div>`;
  if(KIT.focus){ const el = $("kit-" + KIT.focus); if(el) el.scrollIntoView({ block:"center" }); KIT.focus = null; }
}
$("kitsView").addEventListener("click", async e => {
  if(e.target.closest("[data-kitnew]")) return openKit(null);
  const ed = e.target.closest("[data-kitedit]"); if(ed) return openKit(kitById(+ed.dataset.kitedit));
  const del = e.target.closest("[data-kitdel]");
  if(del){
    if(!del.classList.contains("armed")){ del.classList.add("armed"); del.textContent = "Точно удалить?"; return; }
    const { error } = await sb.from("kits").delete().eq("id", +del.dataset.kitdel);
    if(error){ toast(errText(error)); return; }
    const id = +del.dataset.kitdel; kits = kits.filter(k => k.id !== id); kitItems = kitItems.filter(x => x.kit_id !== id);
    toast("Комплект удалён (оборудование на складе не тронуто)"); renderKits();
  }
});

function openKit(k){
  KIT.edit = k || null; KIT.sel = new Map(); KIT.orig = new Map();
  if(k) kitLines(k.id).forEach(x => { KIT.sel.set(x.item_id, +x.qty); KIT.orig.set(x.item_id, x); });
  $("kitTitle").textContent = k ? "Комплект: " + k.name : "Новый комплект";
  $("k_name").value = k ? k.name : ""; $("k_place").value = k ? k.place || "" : ""; $("k_note").value = k ? k.note || "" : "";
  opts($("kFromPlace"), placesOf(), true); $("kFromPlace").options[0].textContent = "Взять всё из места…"; $("kFromPlace").value = "";
  $("kQ").value = ""; $("kOnly").checked = !!k; $("kitErr").hidden = true;
  renderKitPick(); $("kitScrim").hidden = false; setTimeout(() => $("k_name").focus(), 30);
}
function renderKitPick(){
  const q = $("kQ").value.trim().toLowerCase(), only = $("kOnly").checked;
  const list = items.filter(i => i.state !== "Списано" && (!only || KIT.sel.get(i.id) > 0) && (!q || [i.name, i.maker, i.model, i.place].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => (a.place || "").localeCompare(b.place || "", "ru") || byName(a, b));
  let last = null;
  $("kList").innerHTML = list.length ? list.map(i => {
    const v = KIT.sel.get(i.id) || 0, head = i.place !== last ? `<div class="pkcat">${esc(i.place || "Без места")}</div>` : ""; last = i.place;
    return head + `<div class="pkrow${v ? " on" : ""}" data-ki="${i.id}">
      <div class="lname">${esc(i.name)}${i.maker ? ` <span class="maker">${esc(i.maker)}</span>` : ""}<div class="sub">${esc(i.category || "")}</div></div>
      <div class="pkfree">на складе <b>${num(i.qty_fact) || 0}</b></div>
      <span class="qtyBox sm"><button type="button" data-ka="dec" aria-label="Меньше">−</button><input type="number" min="0" inputmode="numeric" value="${v || ""}" placeholder="0" data-ka="qty" aria-label="В комплекте"><button type="button" data-ka="inc" aria-label="Больше">+</button></span>
    </div>`;
  }).join("") : `<div class="empty" style="border:0">${only ? "Пока ничего не выбрано — снимите «только выбранное» или возьмите всё из места хранения." : "Ничего не найдено."}</div>`;
  let n = 0, u = 0; KIT.sel.forEach(v => { if(v > 0){ n++; u += v; } });
  $("kSum").textContent = `В комплекте: ${n} поз. · ${u} ед.`;
}
["kQ","kOnly"].forEach(id => $(id).addEventListener("input", renderKitPick));
$("kFromPlace").addEventListener("change", () => {
  const p = $("kFromPlace").value; if(!p) return;
  items.filter(i => (i.place || "Без места") === p && i.state !== "Списано").forEach(i => KIT.sel.set(i.id, Math.max(1, num(i.qty_fact) || 1)));
  if(!$("k_place").value) $("k_place").value = p;
  if(!$("k_name").value) $("k_name").value = p;
  $("kFromPlace").value = ""; $("kOnly").checked = true; renderKitPick();
  toast("Добавлено всё из «" + p + "» — поправьте количество, если в кейсе лежит не всё");
});
$("kList").addEventListener("click", e => {
  const b = e.target.closest("button[data-ka]"); if(!b) return;
  const id = +b.closest("[data-ki]").dataset.ki; KIT.sel.set(id, Math.max(0, (KIT.sel.get(id) || 0) + (b.dataset.ka === "inc" ? 1 : -1))); renderKitPick();
});
$("kList").addEventListener("change", e => {
  if(e.target.dataset.ka !== "qty") return;
  KIT.sel.set(+e.target.closest("[data-ki]").dataset.ki, Math.max(0, Math.round(num(e.target.value) || 0))); renderKitPick();
});
$("kitForm").addEventListener("submit", async e => {
  e.preventDefault();
  const err = t => { $("kitErr").textContent = t; $("kitErr").hidden = false; };
  const d = { name:$("k_name").value.trim(), place:$("k_place").value.trim() || null, note:$("k_note").value.trim() || null };
  if(!d.name) return err("Укажите название комплекта.");
  let n = 0; KIT.sel.forEach(v => { if(v > 0) n++; });
  if(!n) return err("Добавьте в комплект хотя бы одну позицию.");
  $("kitSave").disabled = true;
  try {
    let kit = KIT.edit;
    if(kit){ const r = await sb.from("kits").update(d).eq("id", kit.id); if(r.error) throw r.error; Object.assign(kit, d); }
    else { const r = await sb.from("kits").insert(d).select().single(); if(r.error) throw r.error; kit = r.data; if(!kitById(kit.id)) kits.push(kit); }
    const ins = [], upd = [], del = [];
    KIT.sel.forEach((v, itemId) => { const o = KIT.orig.get(itemId);
      if(v > 0 && !o) ins.push({ kit_id:kit.id, item_id:itemId, qty:v });
      else if(v > 0 && o && +o.qty !== v) upd.push([o.id, v]);
      else if(v <= 0 && o) del.push(o.id); });
    if(ins.length){ const r = await sb.from("kit_items").insert(ins).select(); if(r.error) throw r.error; (r.data || []).forEach(x => { if(!kitItems.find(y => y.id === x.id)) kitItems.push(x); }); }
    for(const [id, v] of upd){ const r = await sb.from("kit_items").update({ qty:v }).eq("id", id); if(r.error) throw r.error; const x = kitItems.find(y => y.id === id); if(x) x.qty = v; }
    if(del.length){ const r = await sb.from("kit_items").delete().in("id", del); if(r.error) throw r.error; kitItems = kitItems.filter(x => !del.includes(x.id)); }
    $("kitScrim").hidden = true; toast(KIT.edit ? "Комплект сохранён" : "Комплект создан"); renderKits(); renderEvents();
  } catch(ex){ err(errText(ex)); }
  finally { $("kitSave").disabled = false; }
});

// ---------- комплект в мероприятие ----------
const EK = { ev:null };
function openEvKits(e){ EK.ev = e; $("ekErr").hidden = true; renderEvKits(); $("ekScrim").hidden = false; }
function renderEvKits(){
  const e = EK.ev, inEv = kitsInEvent(e).map(k => k.id);
  $("ekHint").textContent = `«${e.title}», ${fmtRange(e)}. Состав комплекта добавится в список оборудования.`;
  $("ekList").innerHTML = kits.length ? [...kits].sort(byName).map(k => {
    const free = kitFree(k.id, e.date_from, e.date_to, e.id), ls = kitLines(k.id);
    return `<div class="pkrow${inEv.includes(k.id) ? " on" : ""}">
      <div class="lname">${esc(k.name)}<div class="sub">${ls.length} поз. · ${ls.reduce((a, x) => a + +x.qty, 0)} ед.${k.place ? " · " + esc(k.place) : ""}</div></div>
      <div class="pkfree ${free <= 0 ? "neg" : ""}">${inEv.includes(k.id) ? "уже в списке" : free > 0 ? `можно взять: <b>${free}</b>` : "не хватает на эти даты"}${(inc => inc.length ? `<span class="neg">неполный: ${esc(incText(inc))}</span>` : "")(kitIncomplete(k.id))}</div>
      <button type="button" class="btn sm" data-ekadd="${k.id}"${ls.length ? "" : " disabled"}>+ Добавить</button>
    </div>`;
  }).join("") : `<div class="empty" style="border:0">Комплектов пока нет. Создайте их в «Склад → Комплекты».</div>`;
}
$("ekList").addEventListener("click", async ev => {
  const b = ev.target.closest("[data-ekadd]"); if(!b) return;
  const e = EK.ev, k = kitById(+b.dataset.ekadd), cur = linesOf(e.id);
  const ins = [], upd = [];
  kitLines(k.id).forEach(x => { const l = cur.find(y => y.item_id === x.item_id); if(l) upd.push([l, +l.qty + +x.qty]); else ins.push({ event_id:e.id, item_id:x.item_id, qty:+x.qty }); });
  b.disabled = true;
  try {
    if(ins.length){ const r = await sb.from("event_items").insert(ins).select(); if(r.error) throw r.error; (r.data || []).forEach(x => { if(!lines.find(y => y.id === x.id)) lines.push(x); }); }
    for(const [l, v] of upd){ const r = await sb.from("event_items").update({ qty:v }).eq("id", l.id); if(r.error) throw r.error; l.qty = v; }
    toast(`Комплект «${k.name}» добавлен: ${ins.length + upd.length} поз.`); renderEvents(); renderStock(); renderEvKits();
  } catch(ex){ $("ekErr").textContent = errText(ex); $("ekErr").hidden = false; b.disabled = false; }
});

// =====================================================================
// ---------- QR-коды и этикетки ----------
// =====================================================================
const siteBase = () => location.origin + location.pathname;
const itemCode = id => "I-" + id, kitCode = id => "K-" + id;
function qrSvg(text){
  if(!window.SkladQR) return "";
  const q = new SkladQR(-1, SkladQR.L.M); q.addData(text); q.make();
  const n = q.getModuleCount(); let d = "";
  for(let r = 0; r < n; r++){ let c = 0; while(c < n){ if(q.isDark(r, c)){ let s = c; while(c < n && q.isDark(r, c)) c++; d += `M${s} ${r}h${c - s}v1h-${c - s}z`; } else c++; } }
  return `<svg class="qr" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges" aria-hidden="true"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
const LB = { what:"items", sel:new Set(), selK:new Set() };
document.querySelectorAll("[data-lbwhat]").forEach(b => b.onclick = () => { LB.what = b.dataset.lbwhat; renderLabels(); });
function lbList(){
  const q = $("lbQ").value.trim().toLowerCase(), p = $("lbPlace").value;
  if(LB.what === "kits") return [...kits].filter(k => (!p || (k.place || "") === p) && (!q || [k.name, k.place].join(" ").toLowerCase().includes(q))).sort(byName);
  return items.filter(i => i.state !== "Списано" && (!p || (i.place || "Без места") === p) && (!q || [i.name, i.maker, i.model, i.inv, i.place].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => (a.place || "").localeCompare(b.place || "", "ru") || byName(a, b));
}
function lbLabels(){
  const out = [], copies = $("lbCopies").value;
  if(LB.what === "kits") kits.filter(k => LB.selK.has(k.id)).sort(byName).forEach(k => out.push({ code:kitCode(k.id), url:siteBase() + "#k-" + k.id, name:k.name, sub:"Комплект" + (k.place ? " · " + k.place : "") }));
  else items.filter(i => LB.sel.has(i.id)).sort((a, b) => (a.place || "").localeCompare(b.place || "", "ru") || byName(a, b)).forEach(i => {
    const n = copies === "qty" ? Math.max(1, Math.min(200, num(i.qty_fact) || 1)) : 1;
    for(let c = 0; c < n; c++) out.push({ code:itemCode(i.id), url:siteBase() + "#i-" + i.id, name:i.name + (i.maker ? " " + i.maker : ""), sub:i.inv || i.place || "" });
  });
  return out;
}
function renderLabels(){
  if(!me || $("labelsView").hidden) return;
  document.querySelectorAll("[data-lbwhat]").forEach(b => b.classList.toggle("active", b.dataset.lbwhat === LB.what));
  const pl = LB.what === "kits" ? [...new Set(kits.map(k => k.place).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru")) : placesOf();
  const cur = $("lbPlace").value; opts($("lbPlace"), pl, true); $("lbPlace").value = pl.includes(cur) ? cur : "";
  $("lbCopies").hidden = LB.what === "kits";
  const list = lbList(), set = LB.what === "kits" ? LB.selK : LB.sel;
  if(LB.what === "kits" && KIT.missing){ $("lbPick").innerHTML = `<div class="empty">Комплекты ещё не подключены (нужен <code>05_kits.sql</code>).</div>`; return; }
  $("lbPick").innerHTML = list.length ? list.map(x => `<label class="lbrow${set.has(x.id) ? " on" : ""}">
      <input type="checkbox" data-lb="${x.id}"${set.has(x.id) ? " checked" : ""}>
      <span class="lbqr">${set.has(x.id) ? qrSvg(siteBase() + (LB.what === "kits" ? "#k-" : "#i-") + x.id) : ""}</span>
      <span class="lname">${esc(x.name)}${x.maker ? ` <span class="maker">${esc(x.maker)}</span>` : ""}<span class="sub">${esc(LB.what === "kits" ? (x.place || "Комплект") : (x.place || ""))}${LB.what === "items" ? ` · ${num(x.qty_fact) || 0} ${esc(x.unit || "шт.")}` : ""}</span></span>
      <span class="mono lbcode">${LB.what === "kits" ? kitCode(x.id) : itemCode(x.id)}</span>
    </label>`).join("") : `<div class="empty" style="border:0">${LB.what === "kits" ? "Комплектов нет." : "Ничего не найдено."}</div>`;
  $("lbAll").checked = list.length > 0 && list.every(x => set.has(x.id));
  const labels = lbLabels(), g = lbGeo(), per = g.per;
  $("lbDia").hidden = !g.flag;
  $("lbSum").textContent = labels.length ? `Наклеек: ${labels.length} · листов А4: ${Math.ceil(labels.length / per)}${g.flag ? " · печатайте на целом самоклеящемся листе и режьте по серым линиям" : ""}` : "Отметьте, что печатать";
  $("lbPrint").disabled = !labels.length;
}
["lbQ","lbPlace","lbSize","lbCopies","lbDia"].forEach(id => $(id).addEventListener("input", renderLabels));
$("lbPick").addEventListener("change", e => {
  const id = +e.target.dataset.lb; if(!id) return;
  const set = LB.what === "kits" ? LB.selK : LB.sel; e.target.checked ? set.add(id) : set.delete(id); renderLabels();
});
$("lbAll").addEventListener("change", () => {
  const set = LB.what === "kits" ? LB.selK : LB.sel;
  lbList().forEach(x => $("lbAll").checked ? set.add(x.id) : set.delete(x.id)); renderLabels();
});
function lbMenu(open){ $("lbMenu").hidden = !open; $("lbPrint").setAttribute("aria-expanded", open ? "true" : "false"); }
$("lbPrint").onclick = ev => { ev.stopPropagation(); lbMenu($("lbMenu").hidden); };
document.addEventListener("click", ev => { if(!ev.target.closest(".menuwrap")) lbMenu(false); });
document.addEventListener("keydown", ev => { if(ev.key === "Escape") lbMenu(false); });
$("lbDoPrint").onclick = () => {
  lbMenu(false);
  const labels = lbLabels(), g = lbGeo(), per = g.per; if(!labels.length) return;
  const pages = []; for(let i = 0; i < labels.length; i += per) pages.push(labels.slice(i, i + per));
  const txt = l => `<div class="lt"><b>${esc(l.name)}</b>${l.sub ? `<span>${esc(l.sub)}</span>` : ""}<code>${l.code}</code></div>`;
  $("printSheet").innerHTML = g.flag
    ? pages.map(pg => `<div class="lpage sflag" style="grid-template-columns:repeat(${g.cols},${g.L}mm);grid-auto-rows:${g.H}mm;padding:${g.py}mm ${g.px}mm">${pg.map(l =>
        `<div class="fl" style="grid-template-columns:${g.panel}mm ${g.wrap}mm ${g.panel}mm"><div class="fq"><div class="lq" style="width:${g.q}mm;height:${g.q}mm">${qrSvg(l.url)}</div></div><div class="fw"></div><div class="fb">${txt(l)}</div></div>`).join("")}</div>`).join("")
    : pages.map(pg => `<div class="lpage s${per}">${pg.map(l => `<div class="lbl"><div class="lq">${qrSvg(l.url)}</div>${txt(l)}</div>`).join("")}</div>`).join("");
  setTimeout(() => window.print(), 50);
};
$("lbDoPdf").onclick = async () => {
  lbMenu(false);
  const labels = lbLabels(), g = lbGeo(); if(!labels.length) return;
  const b = $("lbPrint"), was = b.innerHTML; b.disabled = true; b.textContent = "Готовлю PDF…";
  try {
    const blob = await labelsPdf(labels, g);
    await saveFile(blob, g.flag ? `QR-флажки на кабель до ${g.d} мм.pdf` : `QR-наклейки (${g.per} на А4).pdf`);
  } catch(ex){ console.error(ex); toast("Не получилось сделать PDF: " + (ex.message || ex)); }
  finally { b.innerHTML = was; b.disabled = false; }
};

// ---------- PDF с наклейками (без библиотек) ----------
// Сетка совпадает с печатью из браузера (style.css, @media print). Размеры в мм.
const LBGEO = {
  24:{ cols:3, rows:8,  w:70,   h:37.125, px:0,  py:0,    py0:2,   px0:2.5, gap:2,   b:9,   clamp:3, sp:7, code:9, mt:1 },
  40:{ cols:4, rows:10, w:48.5, h:25.4,   px:8,  py:21.5, py0:2,   px0:2.5, gap:2,   b:7.5, clamp:2, sp:6, code:9, mt:1 },
  65:{ cols:5, rows:13, w:38,   h:21.2,   px:10, py:10.7, py0:1.2, px0:1.5, gap:1.2, b:6.5, clamp:2, sp:0, code:7, mt:.5 }
};
// Флажок: [QR | обмотка вокруг кабеля | название]. Концы склеиваются между собой — QR остаётся плоским.
function flagGeo(d){
  const H = 22, panel = 24, wrap = Math.ceil(Math.PI * d) + 2, L = 2 * panel + wrap, M = 5;
  const cols = Math.max(1, Math.floor((210 - 2 * M) / L)), rows = Math.floor((297 - 2 * M) / H);
  return { flag:true, d, H, panel, wrap, L, cols, rows, per:cols * rows, px:(210 - cols * L) / 2, py:(297 - rows * H) / 2, q:18, b:7, clamp:3, sp:6, code:8, mt:.8 };
}
function lbGeo(){
  const v = $("lbSize").value;
  return v === "flag" ? flagGeo(+$("lbDia").value || 10) : { ...LBGEO[v], per:+v };
}
function qrMatrix(text){ const q = new SkladQR(-1, SkladQR.L.M); q.addData(text); q.make(); return q; }
function fitLine(x, s, W){
  if(x.measureText(s).width <= W) return s;
  while(s && x.measureText(s + "…").width > W) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}
function wrapText(x, text, W, max){
  const lines = []; let cur = "";
  for(const w of String(text).split(/\s+/).filter(Boolean)){
    const t = cur ? cur + " " + w : w;
    if(x.measureText(t).width <= W){ cur = t; continue; }
    if(cur) lines.push(cur);
    cur = w;
    while(x.measureText(cur).width > W && cur.length > 1){
      let k = cur.length; while(k > 1 && x.measureText(cur.slice(0, k)).width > W) k--;
      lines.push(cur.slice(0, k)); cur = cur.slice(k);
    }
  }
  if(cur) lines.push(cur);
  if(lines.length > max){ lines.length = max; lines[max - 1] = fitLine(x, lines[max - 1] + "…", W); }
  return lines;
}
// Текст наклейки — картинкой 600 dpi (кириллица без встраивания шрифтов), QR — векторами.
function lblTextCanvas(l, g, wmm, hmm){
  const D = 600 / 25.4, W = Math.round(wmm * D), H = Math.round(hmm * D), pt = v => v * 25.4 / 72 * D;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  const fb = pt(g.b), fs = pt(g.sp), fc = pt(g.code), SANS = "Arial, Helvetica, sans-serif";
  x.font = `700 ${fb}px ${SANS}`; const nl = wrapText(x, l.name, W, g.clamp);
  let sub = ""; if(g.sp && l.sub){ x.font = `400 ${fs}px ${SANS}`; sub = fitLine(x, l.sub, W); }
  const lb = fb * 1.15, ls = fs * 1.15, lc = fc * 1.15, mt = g.mt * D;
  let y = Math.max(0, (H - (nl.length * lb + (sub ? ls : 0) + mt + lc)) / 2);
  x.textBaseline = "middle"; x.fillStyle = "#000";
  x.font = `700 ${fb}px ${SANS}`; nl.forEach(s => { x.fillText(s, 0, y + lb / 2); y += lb; });
  if(sub){ x.font = `400 ${fs}px ${SANS}`; x.fillStyle = "#333"; x.fillText(sub, 0, y + ls / 2); y += ls; x.fillStyle = "#000"; }
  y += mt; x.font = `700 ${fc}px "Courier New", Courier, monospace`; x.fillText(l.code, 0, y + lc / 2);
  return c;
}
async function deflate(u8){
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function pdfImage(c){
  const W = c.width, H = c.height;
  if(window.CompressionStream){
    const d = c.getContext("2d").getImageData(0, 0, W, H).data, g = new Uint8Array(W * H);
    for(let i = 0; i < g.length; i++) g[i] = d[i * 4];
    return { W, H, cs:"/DeviceGray", filter:"/FlateDecode", data:await deflate(g) };
  }
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.95));
  return { W, H, cs:"/DeviceRGB", filter:"/DCTDecode", data:new Uint8Array(await blob.arrayBuffer()) };
}
async function labelsPdf(labels, g){
  if(!window.SkladQR) throw new Error("не загрузился генератор QR");
  const per = g.per, K = 72 / 25.4, f = v => (+v).toFixed(3), PH = 297;
  const qr = g.flag ? g.q : g.h - 2 * g.py0, tw = g.flag ? g.panel - 3 : g.w - 2 * g.px0 - qr - g.gap, th = g.flag ? g.H - 3 : qr;
  const imgs = [], imgIdx = new Map(), qrCache = new Map(), pages = [];
  for(let p = 0; p < labels.length; p += per){
    let s = "";
    for(const [i, l] of labels.slice(p, p + per).entries()){
      const cw = g.flag ? g.L : g.w, ch = g.flag ? g.H : g.h;
      const X = g.px + (i % g.cols) * cw, Y = g.py + Math.floor(i / g.cols) * ch;
      let qx = X + g.px0, qy = Y + g.py0, tx = qx + qr + g.gap, ty = qy;
      if(g.flag){
        qx = X + (g.panel - qr) / 2; qy = Y + (g.H - qr) / 2;
        tx = X + g.panel + g.wrap + 1.5; ty = Y + 1.5;
        // линия отреза и пунктир сгиба
        const y0 = f((PH - Y - g.H) * K), y1 = f((PH - Y) * K);
        s += `0.55 G 0.35 w ${f(X * K)} ${y0} ${f(g.L * K)} ${f(g.H * K)} re S\n[2 1.5] 0 d 0.75 G`;
        for(const fx of [X + g.panel, X + g.panel + g.wrap]) s += ` ${f(fx * K)} ${y0} m ${f(fx * K)} ${y1} l`;
        s += " S [] 0 d\n";
      }
      // QR: каждая полоса тёмных модулей — прямоугольник
      let rects = qrCache.get(l.url);
      if(!rects){
        const q = qrMatrix(l.url), n = q.getModuleCount(); rects = { n, runs:[] };
        for(let r = 0; r < n; r++){ let c = 0; while(c < n){ if(q.isDark(r, c)){ const a = c; while(c < n && q.isDark(r, c)) c++; rects.runs.push([r, a, c - a]); } else c++; } }
        qrCache.set(l.url, rects);
      }
      const m = qr / (rects.n + 4);
      s += "0 g\n";
      for(const [r, a, w] of rects.runs){
        const yt = qy + (2 + r) * m;
        s += `${f((qx + (2 + a) * m) * K)} ${f((PH - yt - m - 0.01) * K)} ${f(w * m * K)} ${f((m + 0.01) * K)} re\n`;
      }
      s += "f\n";
      // текст
      const key = l.name + "\u0001" + l.sub + "\u0001" + l.code;
      if(!imgIdx.has(key)){ imgIdx.set(key, imgs.length); imgs.push(await pdfImage(lblTextCanvas(l, g, tw, th))); }
      s += `q ${f(tw * K)} 0 0 ${f(th * K)} ${f(tx * K)} ${f((PH - ty - th) * K)} cm /Im${imgIdx.get(key)} Do Q\n`;
    }
    pages.push(s);
  }
  return buildPdf(pages, imgs);
}
async function buildPdf(pages, imgs){
  const enc = new TextEncoder(), parts = [], offs = []; let len = 0;
  const push = u => { if(typeof u === "string") u = enc.encode(u); parts.push(u); len += u.length; };
  const obj = (n, body) => { offs[n] = len; push(`${n} 0 obj\n`); body(); push("\nendobj\n"); };
  const first = 4 + imgs.length, N = pages.length, total = first + 2 * N;
  push("%PDF-1.4\n%âãÏÓ\n");
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Count ${N} /Kids [${pages.map((_, i) => `${first + 2 * i} 0 R`).join(" ")}] >>`));
  obj(3, () => push(`<< /ProcSet [/PDF /ImageB /ImageC] /XObject << ${imgs.map((_, i) => `/Im${i} ${4 + i} 0 R`).join(" ")} >> >>`));
  imgs.forEach((m, i) => obj(4 + i, () => {
    push(`<< /Type /XObject /Subtype /Image /Width ${m.W} /Height ${m.H} /ColorSpace ${m.cs} /BitsPerComponent 8 /Filter ${m.filter} /Length ${m.data.length} >>\nstream\n`);
    push(m.data); push("\nendstream");
  }));
  for(let i = 0; i < N; i++){
    const n = first + 2 * i;
    obj(n, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.276 841.89] /Resources 3 0 R /Contents ${n + 1} 0 R >>`));
    let body = enc.encode(pages[i]), filt = "";
    if(window.CompressionStream){ body = await deflate(body); filt = " /Filter /FlateDecode"; }
    obj(n + 1, () => { push(`<< /Length ${body.length}${filt} >>\nstream\n`); push(body); push("\nendstream"); });
  }
  const xref = len;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for(let n = 1; n < total; n++) push(String(offs[n]).padStart(10, "0") + " 00000 n \n");
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type:"application/pdf" });
}
// На телефоне — «Поделиться» (сохранить в Файлы, отправить в мессенджер), на компьютере — скачивание.
async function saveFile(blob, name){
  const file = new File([blob], name, { type:blob.type });
  if(matchMedia("(pointer:coarse)").matches && navigator.canShare && navigator.canShare({ files:[file] })){
    try { await navigator.share({ files:[file], title:name }); return; }
    catch(ex){ if(ex.name === "AbortError") return; }
  }
  const u = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
  toast("PDF скачан: " + name);
}

// =====================================================================
// ---------- сканер при отгрузке / возврате ----------
// =====================================================================
const SCAN = { stream:null, timer:null, last:"", lastAt:0, detector:null, canvas:null, audio:null, busy:false };
function parseCode(t){
  t = String(t || "").trim();
  const m = t.match(/#([ik])-(\d+)/i) || t.match(/^([ik])[-\s]?(\d+)$/i) || (/^\d+$/.test(t) ? ["", "i", t] : null);
  return m ? { kind:m[1].toLowerCase(), id:+m[2] } : null;
}
const prTarget = l => PR.mode === "load" ? +l.qty : (l.qty_out != null ? +l.qty_out : +l.qty);
function beep(ok){
  try {
    const a = SCAN.audio || (SCAN.audio = new (window.AudioContext || window.webkitAudioContext)());
    const o = a.createOscillator(), g = a.createGain(); o.frequency.value = ok ? 1320 : 220; o.type = ok ? "sine" : "square";
    g.gain.value = 0.08; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + (ok ? 0.08 : 0.25));
  } catch(_) {}
}
function scanFeedback(ok, msg){
  $("scanMsg").textContent = msg; $("scanMsg").className = "scanmsg " + (ok ? "ok" : "bad");
  if($("scanBox").hidden) toast(msg);
  try { navigator.vibrate && navigator.vibrate(ok ? 40 : [90, 60, 90]); } catch(_) {}
  beep(ok);
}
function onScanCode(text, manual){
  if(!$("bdScrim").hidden) return buildScan(text, manual);
  if(!PR.ev || $("prScrim").hidden) return;
  const now = Date.now();
  if(!manual && text === SCAN.last && now - SCAN.lastAt < 1600) return;
  SCAN.last = text; SCAN.lastAt = now;
  const c = parseCode(text);
  if(!c) return scanFeedback(false, "Это не наклейка склада");
  const ls = linesOf(PR.ev.id);
  if(c.kind === "i"){
    const it = itemById(c.id), l = ls.find(x => x.item_id === c.id);
    if(!l) return scanFeedback(false, it ? `«${it.name}» нет в списке этого мероприятия` : "Позиция не найдена");
    const v = (PR.vals.get(l.id) || 0) + 1; PR.vals.set(l.id, v);
    if(KC.kit){ const kq = kitLines(KC.kit.id).find(x => x.item_id === c.id); if(kq && (KC.counts.get(c.id) || 0) < +kq.qty) KC.counts.set(c.id, (KC.counts.get(c.id) || 0) + 1); }
    renderProcess(l.id); renderKitCheck();
    const t = prTarget(l);
    return scanFeedback(true, `${it.name}: ${v} из ${t}` + (v > t ? " — больше, чем нужно" : v === t ? " ✓" : ""));
  }
  const k = kitById(c.id); if(!k) return scanFeedback(false, "Комплект не найден");
  if(PR.mode === "return") return openKitCheck(k);
  const inc = kitIncomplete(k.id);
  let n = 0, miss = 0;
  kitLines(k.id).forEach(x => { const l = ls.find(y => y.item_id === x.item_id); if(l){ PR.vals.set(l.id, (PR.vals.get(l.id) || 0) + +x.qty); n++; } else miss++; });
  renderProcess();
  scanFeedback(n > 0 && !inc.length, n ? `Комплект «${k.name}»: +${n} поз.` + (miss ? `, ещё ${miss} поз. нет в списке` : "") + (inc.length ? ` — внимание: кейс неполный (${inc.map(x => x.it.name + " × " + x.n).join(", ")})` : "") : `Комплекта «${k.name}» нет в списке`);
}
function loadJsQR(){
  const urls = ["vendor/jsQR.js", "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js", "https://unpkg.com/jsqr@1.4.0/dist/jsQR.js"];
  return new Promise(res => { let i = 0; const next = () => { if(window.jsQR || i >= urls.length) return res(); const s = document.createElement("script"); s.src = urls[i++]; s.onload = () => window.jsQR ? res() : next(); s.onerror = next; document.body.appendChild(s); }; next(); });
}
async function startScan(){
  beep(true);
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ scanFeedback(false, "Камера недоступна в этом браузере. Откройте сайт в Safari или Chrome, либо вводите код вручную."); return; }
  $("scanBox").hidden = false; $("scanMsg").textContent = "Включаю камеру…"; $("scanMsg").className = "scanmsg";
  try { SCAN.stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:"environment" } }, audio:false }); }
  catch(_) { $("scanMsg").textContent = "Нет доступа к камере. Разрешите её в настройках браузера или вводите код с наклейки вручную."; $("scanMsg").className = "scanmsg bad"; return; }
  const v = $("scanVideo"); v.srcObject = SCAN.stream; try { await v.play(); } catch(_) {}
  if(!SCAN.detector && "BarcodeDetector" in window){ try { const f = await BarcodeDetector.getSupportedFormats(); if(f.includes("qr_code")) SCAN.detector = new BarcodeDetector({ formats:["qr_code"] }); } catch(_) {} }
  if(!SCAN.detector && !window.jsQR){ $("scanMsg").textContent = "Загружаю распознавание…"; await loadJsQR(); }
  if(!SCAN.detector && !window.jsQR){ $("scanMsg").textContent = "Не удалось загрузить распознавание QR. Вводите код с наклейки вручную."; $("scanMsg").className = "scanmsg bad"; return; }
  $("scanMsg").textContent = "Наведите камеру на QR-код"; $("scanMsg").className = "scanmsg";
  scanTick();
}
async function scanTick(){
  if(!SCAN.stream) return;
  const v = $("scanVideo");
  if(v.readyState >= 2 && !SCAN.busy){
    SCAN.busy = true;
    try {
      if(SCAN.detector){ const r = await SCAN.detector.detect(v); if(r && r[0]) onScanCode(r[0].rawValue); }
      else if(window.jsQR){
        const w = v.videoWidth, h = v.videoHeight, k = Math.min(1, 640 / Math.max(w, h)), cw = Math.round(w * k), ch = Math.round(h * k);
        const c = SCAN.canvas || (SCAN.canvas = document.createElement("canvas")); c.width = cw; c.height = ch;
        const x = c.getContext("2d", { willReadFrequently:true }); x.drawImage(v, 0, 0, cw, ch);
        const r = window.jsQR(x.getImageData(0, 0, cw, ch).data, cw, ch, { inversionAttempts:"dontInvert" });
        if(r && r.data) onScanCode(r.data);
      }
    } catch(_) {}
    SCAN.busy = false;
  }
  SCAN.timer = setTimeout(scanTick, 120);
}
function stopScan(){
  clearTimeout(SCAN.timer);
  if(SCAN.stream){ SCAN.stream.getTracks().forEach(t => t.stop()); SCAN.stream = null; }
  $("scanVideo").srcObject = null; $("scanBox").hidden = true;
}
$("prScan").onclick = () => SCAN.stream ? stopScan() : startScan();
$("scanClose").onclick = stopScan;
$("prZero").onclick = () => { linesOf(PR.ev.id).forEach(l => PR.vals.set(l.id, 0)); renderProcess(); toast("Счётчики обнулены — сканируйте наклейки"); if(!SCAN.stream) startScan(); };
$("prCodeForm").addEventListener("submit", e => { e.preventDefault(); const v = $("prCode").value; $("prCode").value = ""; if(v.trim()) onScanCode(v, true); });
$("prScrim").querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", stopScan));
$("prScrim").addEventListener("mousedown", e => { if(e.target === $("prScrim")) stopScan(); });
document.addEventListener("keydown", e => { if(e.key === "Escape") stopScan(); });

// =====================================================================
// ---------- экран «Сегодня» ----------
// =====================================================================
let _todayQ = null;
function scheduleToday(){ if(_todayQ) return; _todayQ = setTimeout(() => { _todayQ = null; renderToday(); saveSnap(); if(SVIEW === "kits") renderKits(); if(SVIEW === "labels") renderLabels(); }, 0); }
function renderToday(){
  if(!me || !$("todayView")) return;
  const t = todayKey(), tm = addDays(t, 1), wk = addDays(t, 14);
  const leavingToday = events.filter(e => e.status === "planned" && e.date_from <= t && e.date_to >= t).sort((a, b) => a.date_from.localeCompare(b.date_from));
  const leavingTom = events.filter(e => e.status === "planned" && e.date_from === tm).sort((a, b) => a.id - b.id);
  const leaving = [...leavingToday, ...leavingTom];
  const out = events.filter(e => e.status === "out").sort((a, b) => a.date_to.localeCompare(b.date_to));
  const notLoaded = events.filter(e => e.status === "planned" && e.date_to < t);
  const missing = events.filter(e => e.status === "returned").map(e => ({ e, s:shortagesOf(e) })).filter(x => x.s.length).sort((a, b) => b.e.date_to.localeCompare(a.e.date_to));
  const confl = events.filter(e => isActive(e) && e.date_from <= wk && e.date_to >= t && (conflictsOf(e).length || crewOf(e.id).some(c => crewBusy(c, e).length || (c.user_id && !EV.schedMissing && personIssues(c.user_id, e.date_from, e.date_to).length))));
  const repair = items.filter(i => i.state === "Требует ремонта" || i.state === "В ремонте" || i.status === "Не найдено");
  const mineAll = events.filter(e => isActive(e) && e.date_to >= t && isMine(e)).sort((a, b) => a.date_from.localeCompare(b.date_from));
  const shown = new Set([...leaving, ...out, ...notLoaded, ...confl].map(e => e.id));
  const mine = mineAll.filter(e => !shown.has(e.id)).slice(0, 3);
  const alerts = out.filter(e => e.date_to < t).length + notLoaded.length + missing.length + confl.length;
  $("todayCount").textContent = alerts; $("todayCount").hidden = !alerts;

  // люди сегодня
  const todayEv = events.filter(e => isActive(e) && e.date_from <= t && e.date_to >= t);
  const onEvents = []; todayEv.forEach(e => crewOf(e.id).forEach(c => onEvents.push({ who:crewName(c), job:c.job, e })));
  const staff = Object.values(profiles).filter(p => LV[p.role] >= LV.viewer);
  const onShift = EV.schedMissing ? [] : staff.map(p => ({ p, d:personDay(p.id, t) })).filter(x => x.d && (x.d.t === "shift" || x.d.t === "busy"));

  const h = new Date().getHours(), hello = h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
  const card = (title, body, cls = "", count) => body ? `<section class="tcard ${cls}"><h3>${title}${count != null ? ` <span class="tcnt">${count}</span>` : ""}</h3>${body}</section>` : "";
  const evs = list => list.length ? `<div class="evcards">${list.map(evCard).join("")}</div>` : "";
  const outRows = out.map(e => { const late = e.date_to < t, today = e.date_to === t;
    return `<button type="button" class="trow${late ? " bad" : ""}" data-ev="${e.id}"><span class="tmain"><b>${esc(e.title)}</b><small>${esc(e.venue || "")}${crewOf(e.id).length ? " · " + esc(crewOf(e.id).map(crewName).slice(0, 3).join(", ")) : ""}</small></span>
      <span class="ttag">${late ? `<span class="chip c-bad xs">должно было вернуться ${fmtD(e.date_to)}</span>` : today ? `<span class="chip c-warn xs">возвращается сегодня</span>` : `<span class="muted">вернётся ${fmtD(e.date_to)}</span>`}</span></button>`; }).join("");
  const missRows = missing.map(({ e, s }) => `<button type="button" class="trow bad" data-ev="${e.id}"><span class="tmain"><b>${esc(e.title)}</b><small>${esc(s.map(x => (x.it ? x.it.name : "позиция") + " — " + x.miss).join(", "))}</small></span><span class="ttag muted">${fmtD(e.date_to)}</span></button>`).join("");
  const repRows = repair.map(i => `<button type="button" class="trow" data-item="${i.id}"><span class="tmain"><b>${esc(i.name)}</b><small>${esc(i.note || i.place || "")}</small></span><span class="ttag"><span class="chip ${i.status === "Не найдено" ? "c-bad" : STATES[i.state] || "c-off"} xs">${esc(i.status === "Не найдено" ? "Не найдено" : i.state)}</span></span></button>`).join("");
  const pplRows = (onEvents.length ? onEvents.map(x => `<button type="button" class="trow" data-ev="${x.e.id}"><span class="tmain"><b>${esc(x.who)}</b><small>${esc(x.job || "")}</small></span><span class="ttag muted">${esc(x.e.title)}</span></button>`).join("") : "")
    + onShift.map(x => `<div class="trow static"><span class="tmain"><b>${esc(x.p.full_name || x.p.email)}</b><small>${esc(x.d.why)}</small></span><span class="ttag"><span class="chip ${x.d.t === "busy" ? "c-bad" : "c-off"} xs">${x.d.t === "busy" ? "недоступен" : "на смене"}</span></span></div>`).join("");

  const nothing = !leaving.length && !out.length && !alerts && !repair.length;
  $("todayView").innerHTML = `
    <div class="thead"><h2 class="evh">${hello}, ${esc((me.full_name || "").split(" ")[0] || "коллега")}</h2><span class="muted">${fmtD(t, { weekday:"long", day:"numeric", month:"long" })}</span>
      ${can("worker") && !EV.missing ? `<button type="button" class="btn tquick" data-quick><svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg> Быстрый прокат</button>` : ""}</div>
    ${appBanner()}
    ${nothing ? `<div class="empty"><strong>Сегодня спокойно</strong>Выездов и возвратов нет, всё оборудование на месте.</div>` : ""}
    <div class="tgrid">
      ${card("Требует внимания", (notLoaded.length ? `<p class="hint">Дата прошла, а отгрузка не отмечена:</p>${evs(notLoaded)}` : "") + (confl.length ? `<p class="hint">Не хватает оборудования или люди заняты (ближайшие 2 недели):</p>${evs(confl)}` : ""), "alert", notLoaded.length + confl.length || null)}
      ${card("Уезжает сегодня", evs(leavingToday), "", leavingToday.length || null)}
      ${card("Уезжает завтра, " + fmtD(tm, { weekday:"short", day:"numeric", month:"short" }), evs(leavingTom), "", leavingTom.length || null)}
      ${card("На выезде", outRows, "", out.length || null)}
      ${card("Недостачи — не разобраны", missRows, "alert", missing.length || null)}
      ${mine.length ? card("Мои следующие выезды", evs(mine)) : ""}
      ${card("Люди сегодня", pplRows)}
      ${card("Ремонт и потери", repRows, "", repair.length || null)}
    </div>`;
}
$("todayView").addEventListener("click", e => {
  if(e.target.closest("[data-quick]")){ openQuick(); return; }
  const ev = e.target.closest("[data-ev]"); if(ev){ openEvent(+ev.dataset.ev); return; }
  const it = e.target.closest("[data-item]"); if(it){ const x = itemById(+it.dataset.item); setStockView("items"); setTab("stock"); if(x) openEditor(x); }
});

// =====================================================================
// ---------- быстрый прокат и сборка сканером ----------
// =====================================================================
function openQuick(){
  $("q_who").value = ""; $("q_phone").value = ""; $("q_note").value = "";
  $("q_to").value = addDays(todayKey(), 1); $("q_to").min = todayKey();
  $("qkErr").hidden = true; $("qkScrim").hidden = false; setTimeout(() => $("q_who").focus(), 30);
}
$("quickBtn").onclick = openQuick;
phoneMask($("q_phone"));
$("qkForm").addEventListener("submit", async e => {
  e.preventDefault();
  const err = t => { $("qkErr").textContent = t; $("qkErr").hidden = false; };
  const who = $("q_who").value.trim(), to = $("q_to").value || todayKey();
  if(!who) return err("Укажите, кому прокат.");
  if(to < todayKey()) return err("Дата возврата не может быть в прошлом.");
  const d = { title:"Прокат: " + who, date_from:todayKey(), date_to:to, client:$("q_phone").value.trim() || null,
    note:$("q_note").value.trim() || null, responsible:me.id, quick:true };
  $("qkSave").disabled = true;
  let res = await sb.from("events").insert(d).select().single();
  if(res.error && /quick/.test(res.error.message || "")){ delete d.quick; res = await sb.from("events").insert(d).select().single(); } // 06_quick.sql ещё не запущен
  $("qkSave").disabled = false;
  if(res.error) return err(errText(res.error));
  const row = { status:"planned", ...res.data };
  if(!evById(row.id)) events.push(row);
  $("qkScrim").hidden = true;
  openEvent(row.id); openBuild(evById(row.id));
});

const BD = { ev:null, map:new Map() };
function openBuild(e){
  BD.ev = e; BD.map = new Map();
  linesOf(e.id).forEach(l => BD.map.set(l.item_id, +l.qty));
  $("bdTitle").textContent = "Сборка: " + e.title;
  $("bdCode").value = ""; $("bdFind").hidden = true; $("bdErr").hidden = true;
  $("bdShip").hidden = !can("worker");
  renderBuild(); $("bdScrim").hidden = false;
}
function renderBuild(hl){
  const e = BD.ev;
  const rows = [...BD.map].filter(([, v]) => v > 0).map(([id, v]) => ({ it:itemById(id), v })).filter(x => x.it)
    .sort((a, b) => (a.it.place || "").localeCompare(b.it.place || "", "ru") || byName(a.it, b.it));
  let last = null, over = 0;
  $("bdList").innerHTML = rows.length ? rows.map(({ it, v }) => {
    const free = freeQty(it, e.date_from, e.date_to, e.id), bad = v > free; if(bad) over++;
    const head = it.place !== last ? `<div class="pkcat">${esc(it.place || "Без места")}</div>` : ""; last = it.place;
    return head + `<div class="pkrow on${bad ? " bad" : ""}${it.id === hl ? " flash" : ""}" data-bd="${it.id}">
      <div class="lname">${esc(it.name)}${it.maker ? ` <span class="maker">${esc(it.maker)}</span>` : ""}<div class="sub mono">${itemCode(it.id)}</div></div>
      <div class="pkfree ${bad ? "neg" : ""}">свободно <b>${Math.max(0, free)}</b> из ${num(it.qty_fact) || 0}${bad ? `<span class="neg">больше, чем свободно</span>` : ""}</div>
      <span class="qtyBox sm"><button type="button" data-ba="dec" aria-label="Меньше">−</button><input type="number" min="0" inputmode="numeric" value="${v}" data-ba="qty" aria-label="Количество"><button type="button" data-ba="inc" aria-label="Больше">+</button></span>
    </div>`;
  }).join("") : `<div class="empty" style="border:0"><strong>Сумка пока пустая</strong>Нажмите «Сканировать» и наводите камеру на наклейки — или впишите код либо название выше.</div>`;
  let u = 0; rows.forEach(x => u += x.v);
  $("bdSum").textContent = `${rows.length} поз. · ${u} ед.` + (over ? ` · не хватает: ${over}` : "");
  $("bdShip").disabled = $("bdSave").disabled = false;
  if(hl){ const r = $("bdList").querySelector(`[data-bd="${hl}"]`); if(r) r.scrollIntoView({ block:"nearest" }); }
}
function buildAdd(itemId, n){
  const it = itemById(itemId); if(!it) return false;
  const v = Math.max(0, (BD.map.get(itemId) || 0) + n); BD.map.set(itemId, v); renderBuild(itemId); return v;
}
function buildScan(text, manual){
  const now = Date.now();
  if(!manual && text === SCAN.last && now - SCAN.lastAt < 1600) return;
  SCAN.last = text; SCAN.lastAt = now;
  const c = parseCode(text);
  if(!c) return scanFeedback(false, "Это не наклейка склада");
  if(c.kind === "i"){
    const it = itemById(c.id); if(!it) return scanFeedback(false, "Позиция не найдена");
    if(it.state === "Списано") return scanFeedback(false, `«${it.name}» списан`);
    const v = buildAdd(c.id, 1), free = freeQty(it, BD.ev.date_from, BD.ev.date_to, BD.ev.id);
    return scanFeedback(true, `${it.name}: ${v}` + (v > free ? ` — свободно только ${Math.max(0, free)}` : ""));
  }
  const k = kitById(c.id); if(!k) return scanFeedback(false, "Комплект не найден");
  kitLines(k.id).forEach(x => BD.map.set(x.item_id, (BD.map.get(x.item_id) || 0) + +x.qty));
  renderBuild(); scanFeedback(true, `Комплект «${k.name}»: +${kitLines(k.id).length} поз.`);
}
$("bdList").addEventListener("click", e => {
  const b = e.target.closest("button[data-ba]"); if(!b) return;
  buildAdd(+b.closest("[data-bd]").dataset.bd, b.dataset.ba === "inc" ? 1 : -1);
});
$("bdList").addEventListener("change", e => {
  if(e.target.dataset.ba !== "qty") return;
  const id = +e.target.closest("[data-bd]").dataset.bd; BD.map.set(id, Math.max(0, Math.round(num(e.target.value) || 0))); renderBuild();
});
// Поле «код или название»: код — сразу +1, текст — подсказки.
$("bdCode").addEventListener("input", () => {
  const q = $("bdCode").value.trim().toLowerCase();
  if(q.length < 2 || parseCode(q)){ $("bdFind").hidden = true; return; }
  const words = q.split(/\s+/).filter(Boolean);
  const found = items.filter(i => { if(i.state === "Списано") return false; const h = [i.name, i.maker, i.model, i.place].join(" ").toLowerCase(); return words.every(w => h.includes(w)); }).sort(byName).slice(0, 8);
  $("bdFind").innerHTML = found.length ? found.map(i => `<button type="button" class="bdhit" data-bdadd="${i.id}"><span>${esc(i.name)}${i.maker ? ` <span class="maker">${esc(i.maker)}</span>` : ""}</span><small>${esc(i.place || "")}</small><b>+1</b></button>`).join("") : `<p class="hint" style="padding:8px 12px">Ничего не найдено</p>`;
  $("bdFind").hidden = false;
});
$("bdFind").addEventListener("click", e => {
  const b = e.target.closest("[data-bdadd]"); if(!b) return;
  const id = +b.dataset.bdadd, v = buildAdd(id, 1); toast(`${itemById(id).name}: ${v}`);
});
$("bdCodeForm").addEventListener("submit", e => {
  e.preventDefault();
  const v = $("bdCode").value.trim(); if(!v) return;
  if(parseCode(v)){ $("bdCode").value = ""; $("bdFind").hidden = true; buildScan(v, true); return; }
  const first = $("bdFind").querySelector("[data-bdadd]"); if(first) first.click();
});
function mountScanner(afterEl){ if($("scanBox").previousElementSibling !== afterEl) afterEl.after($("scanBox")); }
$("bdScan").onclick = () => { if(SCAN.stream) return stopScan(); mountScanner($("bdTools")); startScan(); };
const _prScanOrig = $("prScan").onclick;
$("prScan").onclick = () => { mountScanner(document.querySelector("#prScrim .prTools")); _prScanOrig(); };
const _prZeroOrig = $("prZero").onclick;
$("prZero").onclick = () => { mountScanner(document.querySelector("#prScrim .prTools")); _prZeroOrig(); };
function closeBuild(){ stopScan(); $("bdScrim").hidden = true; }
$("bdCancel").onclick = closeBuild;
$("bdScrim").addEventListener("mousedown", e => { if(e.target === $("bdScrim")) closeBuild(); });

async function saveBuild(ship){
  const e = BD.ev, cur = linesOf(e.id), err = t => { $("bdErr").textContent = t; $("bdErr").hidden = false; };
  const ins = [], upd = [], del = [];
  BD.map.forEach((v, itemId) => { const l = cur.find(x => x.item_id === itemId);
    if(v > 0 && !l) ins.push({ event_id:e.id, item_id:itemId, qty:v });
    else if(v > 0 && l && +l.qty !== v) upd.push([l, v]);
    else if(v <= 0 && l) del.push(l.id); });
  cur.forEach(l => { if(!BD.map.has(l.item_id)) del.push(l.id); });
  if(ship && ![...BD.map.values()].some(v => v > 0)) return err("Сумка пустая — отсканируйте или добавьте оборудование.");
  $("bdShip").disabled = $("bdSave").disabled = true;
  try {
    if(ins.length){ const r = await sb.from("event_items").insert(ins).select(); if(r.error) throw r.error; (r.data || []).forEach(x => { if(!lines.find(y => y.id === x.id)) lines.push(x); }); }
    for(const [l, v] of upd){ const r = await sb.from("event_items").update({ qty:v }).eq("id", l.id); if(r.error) throw r.error; l.qty = v; }
    if(del.length){ const r = await sb.from("event_items").delete().in("id", del); if(r.error) throw r.error; lines = lines.filter(x => !del.includes(x.id)); }
    if(ship){
      const res = await Promise.all(linesOf(e.id).map(l => sb.from("event_items").update({ qty_out:+l.qty }).eq("id", l.id)));
      const bad = res.find(r => r.error); if(bad) throw bad.error;
      linesOf(e.id).forEach(l => l.qty_out = +l.qty);
      if(!await setEvStatus(e, "out")) throw new Error("Не удалось отметить отгрузку");
    }
    closeBuild(); renderEvents(); renderStock();
    toast(ship ? "Отгружено — прокат на выезде" : "Список сохранён");
  } catch(ex){ err(errText(ex)); $("bdShip").disabled = $("bdSave").disabled = false; }
}
$("bdShip").onclick = () => saveBuild(true);
$("bdSave").onclick = () => saveBuild(false);

// =====================================================================
// ---------- приложение: установка, календарь, офлайн, уведомления ----------
// =====================================================================
const isStandalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; scheduleToday(); });
window.addEventListener("appinstalled", () => { installEvt = null; toast("Приложение установлено"); scheduleToday(); });
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch(_) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(_) {} };

// Карточка «Приложение» на экране «Сегодня»: установка и уведомления.
function appBanner(){
  if(lsGet("sklad.appBannerHidden", false)) return "";
  const parts = [];
  if(!isStandalone()){
    if(installEvt) parts.push(`<p>Установите «Склад» как приложение — иконка на экране, открывается без браузера, работает без связи.</p><button type="button" class="btn primary" data-install>Установить приложение</button>`);
    else if(isIOS()) parts.push(`<p><b>Установите приложение:</b> в Safari нажмите <span class="kbd">Поделиться</span> (квадрат со стрелкой) → <span class="kbd">На экран «Домой»</span>. Уведомления на iPhone работают только в установленном приложении.</p>`);
  }
  const ps = pushState();
  if(ps === "can") parts.push(`<p>Получайте уведомления: завтрашние выезды, просроченные возвраты, ремонт.</p><button type="button" class="btn" data-pushon>Включить уведомления</button>`);
  if(ps === "denied") parts.push(`<p class="muted">Уведомления запрещены в настройках браузера или телефона.</p>`);
  if(!parts.length) return "";
  return `<section class="tcard appcard"><h3>Приложение <button type="button" class="link appclose" data-apphide aria-label="Скрыть">скрыть</button></h3>${parts.join("")}</section>`;
}

// ---------- календарь телефона ----------
function icsEsc(s){ return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
function icsFold(line){
  const enc = new TextEncoder(), out = []; let cur = "", len = 0;
  for(const ch of line){ const b = enc.encode(ch).length; if(len + b > 73){ out.push(cur); cur = " " + ch; len = 1 + b; } else { cur += ch; len += b; } }
  out.push(cur); return out.join("\r\n");
}
const icsDate = k => k.replace(/-/g, "");
function eventIcs(e){
  const cr = crewOf(e.id).map(c => crewName(c) + (c.job ? " (" + c.job + ")" : "") + (c.phone ? " " + c.phone : ""));
  const ls = linesOf(e.id), link = siteBase() + "#ev-" + e.id;
  const desc = [e.client ? "Заказчик: " + e.client : "", personName(e.responsible) ? "Ответственный: " + personName(e.responsible) : "",
    cr.length ? "Команда: " + cr.join(", ") : "", ls.length ? "Оборудование: " + ls.length + " поз." : "", e.note || "", link].filter(Boolean).join("\n");
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sklad prokata//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    "UID:sklad-ev-" + e.id + "@" + location.hostname, "DTSTAMP:" + now,
    "DTSTART;VALUE=DATE:" + icsDate(e.date_from), "DTEND;VALUE=DATE:" + icsDate(addDays(e.date_to, 1)),
    "SUMMARY:" + icsEsc(e.title), e.venue ? "LOCATION:" + icsEsc(e.venue) : "", "DESCRIPTION:" + icsEsc(desc), "URL:" + link,
    "BEGIN:VALARM", "TRIGGER:-PT6H", "ACTION:DISPLAY", "DESCRIPTION:" + icsEsc(e.title), "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"].filter(Boolean).map(icsFold).join("\r\n") + "\r\n";
}
function addToCalendar(e){
  const ics = eventIcs(e), name = "event-" + e.id + ".ics";
  if(isIOS()){ location.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type:"text/calendar;charset=utf-8" })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  toast("Файл календаря скачан — откройте его, чтобы добавить событие");
}
function googleCalUrl(e){
  const p = new URLSearchParams({ action:"TEMPLATE", text:e.title, dates:icsDate(e.date_from) + "/" + icsDate(addDays(e.date_to, 1)),
    details:(e.client ? "Заказчик: " + e.client + "\n" : "") + siteBase() + "#ev-" + e.id, location:e.venue || "" });
  return "https://calendar.google.com/calendar/render?" + p.toString();
}

// =====================================================================
// ---------- офлайн: снимок данных и очередь изменений ----------
// =====================================================================
const OFF = { offline:false, snapAt:null, q:lsGet("sklad.outbox", []), flushing:false };
const isNetErr = e => !!e && /Failed to fetch|NetworkError|Load failed|network|fetch failed|Network request failed|ERR_INTERNET|timed? ?out/i.test(String(e.message || e));
function saveSnap(){
  if(!me) return;
  lsSet("sklad.snap", { t:Date.now(), uid:me.id, me, items, profiles, logRows:logRows.slice(0, 100), events, lines, crew, schedules, periods, kits, kitItems, venues, halls,
    flags:{ ev:EV.missing, cr:EV.crewMissing, sc:EV.schedMissing, kit:KIT.missing } });
}
function loadSnap(uid){
  const s = lsGet("sklad.snap", null); if(!s || (uid && s.uid !== uid)) return null; return s;
}
function applySnap(s){
  items = s.items || []; profiles = s.profiles || {}; logRows = s.logRows || []; events = s.events || []; lines = s.lines || [];
  crew = s.crew || []; schedules = s.schedules || []; periods = s.periods || []; kits = s.kits || []; kitItems = s.kitItems || []; venues = s.venues || []; halls = s.halls || [];
  EV.missing = !!s.flags?.ev; EV.crewMissing = !!s.flags?.cr; EV.schedMissing = !!s.flags?.sc; KIT.missing = !!s.flags?.kit;
  OFF.snapAt = s.t;
}
function setOffline(on){
  OFF.offline = on; renderNetBadge();
  if(on && !OFF.retry) OFF.retry = setInterval(tryReconnect, 20000);
  if(!on && OFF.retry){ clearInterval(OFF.retry); OFF.retry = null; }
}
function renderNetBadge(){
  let b = $("netBanner");
  if(!b){ b = document.createElement("div"); b.id = "netBanner"; b.className = "netbanner"; document.querySelector("#appView main").prepend(b); }
  const n = OFF.q.length;
  if(!OFF.offline && !n){ b.hidden = true; return; }
  b.hidden = false;
  b.className = "netbanner" + (OFF.offline ? " off" : "");
  b.innerHTML = OFF.offline
    ? `<b>Нет связи с базой.</b> Показаны данные от ${OFF.snapAt ? new Date(OFF.snapAt).toLocaleString("ru-RU", { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" }) : "последнего входа"}. Отметки количества, отгрузки и возврата сохраняются${n ? ` — в очереди: ${n}` : ""} и отправятся, когда связь появится. <button type="button" class="link" data-retry>Проверить связь</button>`
    : `Отправляю отложенные изменения: ${n}…`;
}
document.addEventListener("click", e => { if(e.target.closest("[data-retry]")) tryReconnect(true); });
window.addEventListener("online", () => tryReconnect());
async function tryReconnect(manual){
  if(!me) return;
  const r = await sb.from("profiles").select("id").eq("id", me.id).limit(1);
  if(r.error){ if(manual) toast("Связи пока нет"); return; }
  const wasOff = OFF.offline;
  setOffline(false);
  await flushOutbox();
  if(wasOff){ await loadAll(); toast("Связь восстановлена — данные обновлены"); }
}
// Обновление с очередью: без связи изменение откладывается, а не теряется.
async function dbUpdate(table, id, patch){
  if(!OFF.offline){
    const r = await sb.from(table).update(patch).eq("id", id);
    if(!r.error || !isNetErr(r.error)) return r;
    setOffline(true);
  }
  OFF.q.push({ table, id, patch, at:Date.now() }); lsSet("sklad.outbox", OFF.q); renderNetBadge(); scheduleToday();
  return { error:null, queued:true };
}
async function flushOutbox(){
  if(OFF.flushing || !OFF.q.length) return;
  OFF.flushing = true; renderNetBadge();
  let sent = 0;
  while(OFF.q.length){
    const x = OFF.q[0];
    const r = await sb.from(x.table).update(x.patch).eq("id", x.id);
    if(r.error && isNetErr(r.error)){ setOffline(true); break; }
    if(r.error) toast("Не удалось отправить отложенное изменение: " + errText(r.error));
    else sent++;
    OFF.q.shift(); lsSet("sklad.outbox", OFF.q);
  }
  OFF.flushing = false; renderNetBadge();
  if(sent) toast(`Отправлено отложенных изменений: ${sent}`);
}

// Загрузка всех данных (используется при старте и после восстановления связи).
async function loadAll(){
  const res = await Promise.all([
    sb.from("items").select("*").order("id"),
    sb.from("profiles").select("*").order("created_at"),
    sb.from("item_log").select("*").order("created_at", { ascending:false }).limit(300),
    sb.from("events").select("*").order("date_from"),
    sb.from("event_items").select("*").order("id"),
    sb.from("event_crew").select("*").order("id"),
    sb.from("staff_schedule").select("*"),
    sb.from("staff_periods").select("*").order("date_from"),
    sb.from("kits").select("*").order("name"),
    sb.from("kit_items").select("*").order("id")
  ]);
  const [it, pr, lg, ev, el, cr, ss, sp, kt, ki] = res;
  if(it.error && isNetErr(it.error)){
    const s = loadSnap(me.id);
    if(s){ applySnap(s); setOffline(true); return false; }
    toast(errText(it.error)); setOffline(true); return false;
  }
  if(it.error) toast(errText(it.error));
  items = it.data || []; logRows = lg.data || [];
  profiles = {}; (pr.data || []).forEach(p => profiles[p.id] = p);
  if(ev.error || el.error){ EV.missing = true; } else { EV.missing = false; events = ev.data || []; lines = el.data || []; }
  if(cr.error){ EV.crewMissing = true; } else { EV.crewMissing = false; crew = cr.data || []; }
  if(ss.error || sp.error){ EV.schedMissing = true; } else { EV.schedMissing = false; schedules = ss.data || []; periods = sp.data || []; }
  if(kt.error || ki.error){ KIT.missing = true; } else { KIT.missing = false; kits = kt.data || []; kitItems = ki.data || []; }
  { // площадки и залы (11_venues.sql); если файл не запускали — просто пусто
    const [vn, vh] = await Promise.all([sb.from("venues").select("*").order("name"), sb.from("venue_halls").select("*").order("name")]);
    VN.missing = !!(vn.error || vh.error); venues = vn.data || []; halls = vh.data || [];
  }
  // локальные отложенные изменения поверх свежих данных
  OFF.q.forEach(x => { const arr = { items, event_items:lines, events }[x.table]; const r = arr && arr.find(y => y.id === x.id); if(r) Object.assign(r, x.patch); });
  renderStock(); renderLog(); renderUsers(); renderEvents(); renderKits(); renderToday();
  saveSnap();
  return true;
}

// =====================================================================
// ---------- push-уведомления ----------
// =====================================================================
const pushKey = () => (cfg.PUSH_PUBLIC_KEY || "").trim();
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && location.protocol === "https:";
let pushSubscribed = null;
function pushState(){
  if(!pushKey() || !pushSupported()) return "none";
  if(Notification.permission === "denied") return "denied";
  if(pushSubscribed === true) return "on";
  return pushSubscribed === null ? "unknown" : "can";
}
async function refreshPushState(){
  if(!pushKey() || !pushSupported()){ pushSubscribed = false; return; }
  try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); pushSubscribed = !!sub; if(sub) savePushSub(sub); }
  catch(_) { pushSubscribed = false; }
  scheduleToday();
}
const b64uToBytes = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while(s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const bytesToB64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function savePushSub(sub){
  const j = sub.toJSON();
  const { error } = await sb.from("push_subs").upsert({ endpoint:j.endpoint, p256dh:j.keys.p256dh, auth:j.keys.auth, user_id:me.id, ua:navigator.userAgent.slice(0, 200) }, { onConflict:"endpoint" });
  return error;
}
async function enablePush(){
  if(isIOS() && !isStandalone()){ toast("На iPhone сначала установите приложение на экран «Домой», затем включите уведомления в нём"); return; }
  try {
    const perm = await Notification.requestPermission();
    if(perm !== "granted"){ toast("Уведомления не разрешены"); scheduleToday(); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:b64uToBytes(pushKey()) });
    const err = await savePushSub(sub);
    if(err){ toast(/push_subs/.test(err.message || "") ? "Уведомления ещё не настроены в базе (нужен 07_push.sql)" : errText(err)); return; }
    pushSubscribed = true; toast("Уведомления включены"); scheduleToday();
  } catch(ex){ toast("Не удалось включить уведомления: " + (ex.message || ex)); }
}
async function disablePush(){
  try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
    if(sub){ await sb.from("push_subs").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); } } catch(_) {}
  pushSubscribed = false; toast("Уведомления выключены"); scheduleToday();
}
$("todayView").addEventListener("click", e => {
  if(e.target.closest("[data-install]") && installEvt){ installEvt.prompt(); installEvt.userChoice.finally(() => { installEvt = null; scheduleToday(); }); }
  if(e.target.closest("[data-pushon]")) enablePush();
  if(e.target.closest("[data-pushoff]")) disablePush();
  if(e.target.closest("[data-apphide]")){ lsSet("sklad.appBannerHidden", true); renderToday(); }
});

// ---------- ключи для уведомлений (администратор, один раз) ----------
async function genVapid(){
  const kp = await crypto.subtle.generateKey({ name:"ECDSA", namedCurve:"P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { pub:bytesToB64u(pub), priv:jwk.d, secret:bytesToB64u(crypto.getRandomValues(new Uint8Array(24))) };
}

const CAL = { ev:null, link:null };
// Ссылка на календарь с сервера (09_calendar.sql + функция уведомлений). Без неё — файл из браузера.
async function calLink(){
  if(CAL.link) return CAL.link;
  try {
    const a = await sb.from("app_links").select("cal_url").eq("id", 1).maybeSingle();
    if(a.error || !a.data?.cal_url) return null;
    let t = await sb.from("cal_tokens").select("token").eq("user_id", me.id).maybeSingle();
    if(!t.error && !t.data) t = await sb.from("cal_tokens").insert({}).select("token").single();
    if(t.error || !t.data) return null;
    return CAL.link = { url:a.data.cal_url, token:t.data.token };
  } catch(_){ return null; }
}
const calFeed = (L, q) => `${L.url}?cal=${L.token}${q || ""}&s=${encodeURIComponent(siteBase())}`;
const webcal = u => u.replace(/^https?:/, "webcal:");
async function openCal(e){
  $("calHint").textContent = `«${e.title}», ${fmtRange(e)}${e.venue ? ", " + e.venue : ""}`;
  $("calGoogle").href = googleCalUrl(e); CAL.ev = e;
  $("calSub").hidden = true; $("calScrim").hidden = false;
  const L = await calLink(); if(!L || CAL.ev !== e) return;
  const apple = isIOS() || /Macintosh/.test(navigator.userAgent);
  const sub = q => apple ? webcal(calFeed(L, q)) : "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(webcal(calFeed(L, q)));
  $("calSubMine").href = sub(""); $("calSubAll").href = sub("&all=1"); $("calSubAll").hidden = !can("manager");
  $("calSubShifts").href = sub("&t=shifts"); $("calSubShifts").hidden = !scheduleOf(me.id);
  $("calSubHint").textContent = apple
    ? "iPhone спросит «Подписаться на календарь?» — нажмите «Подписаться». Цвет можно сменить там же или потом: Календарь → «Календари» → ⓘ у календаря. Чтобы приходили напоминания о выездах: Настройки → Календарь → Учётные записи → Подписные календари → «Склад — мои выезды» → выключите «Удалить напоминания»."
    : "Откроется Google Календарь — нажмите «Добавить». На Android календарь Google покажет эти события сам.";
  $("calSub").hidden = false;
}
$("calIcs").onclick = async () => {
  const e = CAL.ev; if(!e) return;
  const L = CAL.link;
  // iPhone: файл из приложения на экране «Домой» не открывается — открываем ссылку с сервера.
  if(L && isIOS()){ window.open(calFeed(L, "&ev=" + e.id), "_blank"); $("calScrim").hidden = true; return; }
  if(isIOS() && matchMedia("(display-mode: standalone)").matches && !L){ toast("Подключите календарь по ссылке (09_calendar.sql) или откройте сайт в Safari"); return; }
  addToCalendar(e); $("calScrim").hidden = true;
};
$("calGoogle").addEventListener("click", () => setTimeout(() => $("calScrim").hidden = true, 100));
$("calSubMine").addEventListener("click", () => setTimeout(() => $("calScrim").hidden = true, 300));
$("calSubAll").addEventListener("click", () => setTimeout(() => $("calScrim").hidden = true, 300));
$("calSubShifts").addEventListener("click", () => setTimeout(() => $("calScrim").hidden = true, 300));
$("calCopy").onclick = async () => {
  const L = CAL.link; if(!L) return;
  try { await navigator.clipboard.writeText(calFeed(L, "")); toast("Ссылка скопирована — вставьте её в календаре как «Подписку»"); }
  catch(_){ prompt("Скопируйте ссылку:", calFeed(L, "")); }
};

// =====================================================================
// ---------- проверка кейса при возврате и разбор недостач ----------
// =====================================================================
const KC = { kit:null, counts:new Map() };
// Кейс неполный, если из него что-то не вернулось и недостача не разобрана.
function kitIncomplete(kitId){
  const kl = kitLines(kitId), out = [];
  events.filter(e => e.status === "returned" && kitsInEvent(e).some(k => k.id === kitId)).forEach(e =>
    shortagesOf(e).forEach(s => { const x = kl.find(y => y.item_id === s.l.item_id); if(x && s.it) out.push({ it:s.it, n:Math.min(s.miss, +x.qty), e }); }));
  return out;
}
const incText = inc => inc.map(x => `${x.it.name} × ${x.n} (после «${x.e.title}»)`).join(", ");

function openKitCheck(k){
  const ls = linesOf(PR.ev.id), kl = kitLines(k.id).filter(x => ls.some(l => l.item_id === x.item_id));
  if(!kl.length) return scanFeedback(false, `Комплекта «${k.name}» нет в списке`);
  // Если счётчики не обнулялись, кейс уже засчитан целиком — убираем его и считаем заново.
  if(!PR.zeroed) kl.forEach(x => { const l = ls.find(y => y.item_id === x.item_id); PR.vals.set(l.id, Math.max(0, (PR.vals.get(l.id) || 0) - +x.qty)); });
  KC.kit = k; KC.counts = new Map();
  renderProcess(); renderKitCheck();
  $("kcBox").scrollIntoView({ block:"nearest" });
  scanFeedback(true, `Кейс «${k.name}»: сканируйте содержимое или нажмите «Всё на месте»`);
}
function renderKitCheck(){
  const box = $("kcBox"); if(!box) return;
  if(!KC.kit || !PR.ev){ box.hidden = true; return; }
  const ls = linesOf(PR.ev.id), kl = kitLines(KC.kit.id).filter(x => ls.some(l => l.item_id === x.item_id)).map(x => ({ x, it:itemById(x.item_id) })).filter(o => o.it).sort((a, b) => byName(a.it, b.it));
  let miss = 0;
  box.innerHTML = `<div class="kchead"><b>Проверка кейса «${esc(KC.kit.name)}»</b><span class="hint">сканируйте то, что лежит в кейсе</span></div>` +
    kl.map(({ x, it }) => { const n = KC.counts.get(it.id) || 0, q = +x.qty; if(n < q) miss += q - n;
      return `<div class="pkrow ${n >= q ? "on" : "bad"}" data-kc="${it.id}"><div class="lname">${esc(it.name)}</div>
        <div class="pkfree"><b>${n}</b> из ${q}${n < q ? `<span class="neg">не хватает ${q - n}</span>` : " ✓"}</div>
        <span class="qtyBox sm"><button type="button" data-kca="dec" aria-label="Меньше">−</button><input type="number" value="${n}" readonly aria-label="Найдено"><button type="button" data-kca="inc" aria-label="Больше">+</button></span></div>`; }).join("") +
    `<div class="kcacts"><button type="button" class="btn" data-kcall>Всё на месте</button><button type="button" class="btn primary" data-kcdone>Готово${miss ? ` — не хватает ${miss}` : ""}</button></div>`;
  box.hidden = false;
}
function kcAdjust(itemId, d){
  const kq = kitLines(KC.kit.id).find(x => x.item_id === itemId), l = linesOf(PR.ev.id).find(x => x.item_id === itemId); if(!kq || !l) return;
  const cur = KC.counts.get(itemId) || 0, nv = Math.max(0, Math.min(+kq.qty, cur + d)), delta = nv - cur; if(!delta) return;
  KC.counts.set(itemId, nv); PR.vals.set(l.id, Math.max(0, (PR.vals.get(l.id) || 0) + delta));
}
document.addEventListener("click", e => {
  if(!KC.kit) return;
  const b = e.target.closest("[data-kca]");
  if(b){ kcAdjust(+b.closest("[data-kc]").dataset.kc, b.dataset.kca === "inc" ? 1 : -1); renderProcess(); renderKitCheck(); return; }
  if(e.target.closest("[data-kcall]")){ kitLines(KC.kit.id).forEach(x => kcAdjust(x.item_id, +x.qty)); renderProcess(); renderKitCheck(); return; }
  if(e.target.closest("[data-kcdone]")){
    const miss = kitLines(KC.kit.id).filter(x => (KC.counts.get(x.item_id) || 0) < +x.qty && linesOf(PR.ev.id).some(l => l.item_id === x.item_id))
      .map(x => `${itemById(x.item_id)?.name || "позиция"} × ${+x.qty - (KC.counts.get(x.item_id) || 0)}`);
    scanFeedback(!miss.length, miss.length ? `В кейсе «${KC.kit.name}» не хватает: ${miss.join(", ")}` : `Кейс «${KC.kit.name}» полный ✓`);
    KC.kit = null; renderKitCheck(); renderProcess();
  }
});
$("prZero").addEventListener("click", () => { PR.zeroed = true; if(KC.kit){ KC.counts = new Map(); renderKitCheck(); } });

// «Нашёлся» и «Списать» в карточке мероприятия.
async function resolveLoss(e, b){
  const id = +(b.dataset.found || b.dataset.wo), l = lines.find(x => x.id === id), s = shortagesOf(e).find(x => x.l.id === id);
  if(!l || !s) return;
  const inp = b.closest("[data-loss]").querySelector(".lossn");
  const n = Math.max(1, Math.min(s.miss, Math.round(num(inp ? inp.value : s.miss) || s.miss)));
  const name = s.it ? s.it.name : "позиция";
  if(b.dataset.found){
    const { error } = await dbUpdate("event_items", id, { qty_back:s.back + n });
    if(error){ toast(errText(error)); return; }
    l.qty_back = s.back + n; toast(`Нашёлся: ${name} × ${n}`);
  } else {
    if(!b.classList.contains("armed")){ b.classList.add("armed"); b.textContent = `Списать ${n} со склада?`; return; }
    const { error } = await sb.rpc("write_off", { line_id:id, n });
    if(error){ toast(/write_off|function/i.test(error.message || "") && !/менеджер|списать от/i.test(error.message || "") ? "Списание ещё не подключено: выполните 08_losses.sql в Supabase" : errText(error)); return; }
    l.written_off = (num(l.written_off) || 0) + n;
    if(s.it) s.it.qty_fact = Math.max(0, (num(s.it.qty_fact) || 0) - n);
    toast(`Списано: ${name} × ${n}. На складе теперь ${s.it ? num(s.it.qty_fact) : "—"}`);
  }
  renderEvents(); renderStock(); renderKits();
}

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

// =====================================================================
// ---------- площадки и залы ----------
// =====================================================================
const VN = { missing:false, edit:null, halls:[] };
const venueById = id => venues.find(v => v.id === id);
const venueByName = n => { const k = String(n || "").trim().toLowerCase(); return k ? venues.find(v => v.name.trim().toLowerCase() === k) : null; };
const hallsOf = vid => halls.filter(h => h.venue_id === vid).sort((a, b) => a.name.localeCompare(b.name, "ru"));
const mapsUrl = a => "https://yandex.ru/maps/?text=" + encodeURIComponent(a);

function venueAddrHtml(e){
  const v = e.venue_id && venueById(e.venue_id); if(!v || !v.address) return "";
  return `<br><a href="${mapsUrl(v.address)}" target="_blank" rel="noopener" class="muted">${esc(v.address)}</a>`;
}
function venueNoteHtml(e){
  const v = e.venue_id && venueById(e.venue_id), h = e.hall_id && halls.find(x => x.id === e.hall_id);
  const parts = [v && v.contact ? "Контакт: " + v.contact : "", v && v.note ? v.note : "", h && h.note ? h.name + ": " + h.note : ""].filter(Boolean);
  return parts.length ? `<p class="evnote venueinfo">${esc(parts.join("\n"))}</p>` : "";
}

// В форме мероприятия: выбрали площадку — показать её залы и заметки.
function venueFormSync(hallId){
  const v = venueByName($("v_venue").value), hs = v ? hallsOf(v.id) : [];
  $("v_hallWrap").hidden = !hs.length;
  $("v_hall").innerHTML = `<option value="">— весь объект / не важно —</option>` + hs.map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
  if(hallId && hs.some(h => h.id === hallId)) $("v_hall").value = String(hallId);
  const info = v ? [v.address, v.contact, v.note].filter(Boolean).join(" · ") : ($("v_venue").value.trim() && !VN.missing && can("manager") ? "Новая площадка — добавится в справочник при сохранении." : "");
  $("v_venueInfo").textContent = info; $("v_venueInfo").hidden = !info;
}
$("v_venue").addEventListener("input", () => venueFormSync(null));
$("v_hall").addEventListener("change", () => {
  const h = halls.find(x => x.id === +$("v_hall").value);
  if(h && h.note){ $("v_venueInfo").textContent = h.name + ": " + h.note; $("v_venueInfo").hidden = false; } else venueFormSync(+$("v_hall").value || null);
});

// Справочник площадок
function openVenues(){
  if(VN.missing){ toast("Площадки ещё не подключены: выполните 11_venues.sql в Supabase"); return; }
  VN.edit = null; $("vnQ").value = ""; renderVenues(); $("vnScrim").hidden = false;
}
function renderVenues(){
  const M = can("manager"), editing = VN.edit !== null;
  $("vnForm").hidden = !editing; $("vnList").hidden = editing; document.querySelector(".vnbar").hidden = editing; $("vnClose").hidden = editing;
  $("vnNew").hidden = !M;
  if(editing){ renderVenueHalls(); return; }
  const q = $("vnQ").value.trim().toLowerCase();
  const list = venues.filter(v => !q || [v.name, v.address, v.note].join(" ").toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const used = id => events.filter(e => e.venue_id === id).length;
  $("vnList").innerHTML = list.length ? list.map(v => {
    const hs = hallsOf(v.id);
    return `<button type="button" class="vnrow" data-vn="${v.id}"><span><b>${esc(v.name)}</b>
      <small>${[v.address, hs.length ? "залы: " + hs.map(h => h.name).join(", ") : ""].filter(Boolean).map(esc).join(" · ") || "&nbsp;"}</small></span>
      <small>${used(v.id)} мероп.</small></button>`;
  }).join("") : `<div class="empty" style="border:0">${q ? "Ничего не найдено." : "Площадок пока нет — они появятся из мероприятий или добавьте вручную."}</div>`;
}
function openVenueForm(v){
  const M = can("manager");
  VN.edit = v ? v.id : 0;
  VN.halls = v ? hallsOf(v.id).map(h => ({ ...h })) : [];
  $("vn_name").value = v ? v.name : ""; $("vn_addr").value = v ? v.address || "" : "";
  $("vn_contact").value = v ? v.contact || "" : ""; $("vn_note").value = v ? v.note || "" : "";
  $("vn_hall").value = ""; $("vn_hallNote").value = "";
  [...$("vnForm").elements].forEach(el => { if(el.id !== "vnBack") el.disabled = !M; });
  $("vnSave").hidden = !M; $("vnDel").hidden = !(M && v); $("vnDel").classList.remove("armed"); $("vnDel").textContent = "Удалить";
  document.querySelector(".vnhalladd").hidden = !M;
  $("vnErr").hidden = true; renderVenues();
}
function renderVenueHalls(){
  const M = can("manager");
  $("vnHalls").innerHTML = VN.halls.filter(h => !h._del).length ? VN.halls.map((h, i) => h._del ? "" : `<div class="vnhall"><span><b>${esc(h.name)}</b>${h.note ? ` <small>${esc(h.note)}</small>` : ""}</span>
    ${M ? `<button type="button" class="edit" data-hdel="${i}" aria-label="Убрать зал">✕</button>` : ""}</div>`).join("") : `<p class="hint">Залов нет — площадка выбирается целиком.</p>`;
}
$("venuesBtn").onclick = openVenues;
$("vnQ").addEventListener("input", renderVenues);
$("vnNew").onclick = () => openVenueForm(null);
$("vnBack").onclick = () => { VN.edit = null; renderVenues(); };
$("vnList").addEventListener("click", e => { const b = e.target.closest("[data-vn]"); if(b) openVenueForm(venueById(+b.dataset.vn)); });
$("vnHalls").addEventListener("click", e => {
  const b = e.target.closest("[data-hdel]"); if(!b) return;
  const h = VN.halls[+b.dataset.hdel]; if(h.id) h._del = true; else VN.halls.splice(+b.dataset.hdel, 1);
  renderVenueHalls();
});
$("vnHallAdd").onclick = () => {
  const n = $("vn_hall").value.trim(); if(!n) return;
  if(VN.halls.some(h => !h._del && h.name.toLowerCase() === n.toLowerCase())){ toast("Такой зал уже есть"); return; }
  VN.halls.push({ name:n, note:$("vn_hallNote").value.trim() || null });
  $("vn_hall").value = ""; $("vn_hallNote").value = ""; renderVenueHalls(); $("vn_hall").focus();
};
$("vn_hall").addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); $("vnHallAdd").click(); } });
$("vnForm").addEventListener("submit", async e => {
  e.preventDefault();
  const err = t => { $("vnErr").textContent = t; $("vnErr").hidden = false; };
  const d = { name:$("vn_name").value.trim(), address:$("vn_addr").value.trim() || null, contact:$("vn_contact").value.trim() || null, note:$("vn_note").value.trim() || null };
  if(!d.name) return err("Укажите название площадки.");
  const dup = venueByName(d.name); if(dup && dup.id !== VN.edit) return err("Такая площадка уже есть.");
  $("vnSave").disabled = true;
  try {
    let id = VN.edit;
    if(id){ const r = await sb.from("venues").update(d).eq("id", id); if(r.error) throw r.error; Object.assign(venueById(id), d); }
    else { const r = await sb.from("venues").insert(d).select().single(); if(r.error) throw r.error; id = r.data.id; if(!venueById(id)) venues.push(r.data); }
    const del = VN.halls.filter(h => h.id && h._del).map(h => h.id);
    const ins = VN.halls.filter(h => !h.id && !h._del).map(h => ({ venue_id:id, name:h.name, note:h.note }));
    if(del.length){ const r = await sb.from("venue_halls").delete().in("id", del); if(r.error) throw r.error; halls = halls.filter(h => !del.includes(h.id)); }
    if(ins.length){ const r = await sb.from("venue_halls").insert(ins).select(); if(r.error) throw r.error; (r.data || []).forEach(h => { if(!halls.find(x => x.id === h.id)) halls.push(h); }); }
    // Название площадки поменяли — обновить подпись в её мероприятиях.
    if(VN.edit){
      const evs = events.filter(x => x.venue_id === id);
      for(const ev of evs){ const h = ev.hall_id && halls.find(x => x.id === ev.hall_id); const t = d.name + (h ? " · " + h.name : "");
        if(ev.venue !== t){ const r = await sb.from("events").update({ venue:t }).eq("id", ev.id); if(!r.error) ev.venue = t; } }
    }
    toast("Площадка сохранена"); VN.edit = null; renderVenues(); renderEvents();
  } catch(ex){ err(/duplicate/i.test(ex.message || "") ? "Такая площадка или зал уже есть." : errText(ex)); }
  finally { $("vnSave").disabled = false; }
});
$("vnDel").onclick = async () => {
  const b = $("vnDel"), v = venueById(VN.edit); if(!v) return;
  if(!b.classList.contains("armed")){ b.classList.add("armed"); b.textContent = "Точно удалить?"; return; }
  const { error } = await sb.from("venues").delete().eq("id", v.id);
  if(error){ toast(errText(error)); return; }
  venues = venues.filter(x => x.id !== v.id); halls = halls.filter(h => h.venue_id !== v.id);
  toast("Площадка удалена (мероприятия остались)"); VN.edit = null; renderVenues();
};
$("vnScrim").addEventListener("mousedown", e => { if(e.target === $("vnScrim")) $("vnScrim").hidden = true; });

boot();
})();
