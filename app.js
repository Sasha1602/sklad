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
if(!cfg.SUPABASE_URL || /ВАШ-ПРОЕКТ/.test(cfg.SUPABASE_URL) || !cfg.SUPABASE_KEY || /ВСТАВЬТЕ/.test(cfg.SUPABASE_KEY) || !window.supabase){
  show("setupView"); return;
}
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, { auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true } });

let me = null, items = [], profiles = {}, logRows = [], channel = null, started = false, recovering = false;

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

  const [it, pr, lg] = await Promise.all([
    sb.from("items").select("*").order("id"),
    sb.from("profiles").select("*").order("created_at"),
    sb.from("item_log").select("*").order("created_at", { ascending:false }).limit(300)
  ]);
  if(it.error){ toast(errText(it.error)); }
  items = it.data || []; logRows = lg.data || [];
  (pr.data || []).forEach(p => profiles[p.id] = p);
  renderStock(); renderLog(); renderUsers();
  subscribe();
  const h = location.hash.slice(1); if(["stock","log","users"].includes(h)) setTab(h);
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
    .on("postgres_changes", { event:"INSERT", schema:"public", table:"item_log" }, p => {
      logRows.unshift(p.new); logRows = logRows.slice(0, 300); renderLog();
    })
    .on("postgres_changes", { event:"*", schema:"public", table:"profiles" }, p => {
      if(p.eventType === "DELETE") delete profiles[p.old.id]; else profiles[p.new.id] = p.new;
      if(p.new && p.new.id === me.id && p.new.role !== me.role){ toast("Ваша роль изменилась — обновляю страницу"); setTimeout(() => location.reload(), 1200); }
      renderUsers(); renderStock();
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
  ["stock","log","users"].forEach(x => $("tab-" + x).hidden = x !== t);
  history.replaceState(null, "", "#" + t);
}
document.querySelectorAll("#mainTabs .tab").forEach(b => b.onclick = () => setTab(b.dataset.tab));

// ---------- склад ----------
function placesOf(){ return [...new Set(items.map(i => i.place || "Без места"))].sort((a,b) => a.localeCompare(b,"ru")); }
function renderStock(){
  const pl = placesOf(), cur = $("fPlace").value;
  opts($("fPlace"), pl, true); $("fPlace").value = pl.includes(cur) ? cur : "";
  $("placesList").innerHTML = pl.map(p => `<option value="${esc(p)}">`).join("");

  $("sItems").textContent = items.length;
  $("sUnits").textContent = items.reduce((a,i) => a + (num(i.qty_fact) || 0), 0);
  $("sIssues").textContent = items.filter(isIssue).length;
  $("sOut").textContent = items.filter(i => i.status === "В прокате" || i.status === "На мероприятии").reduce((a,i) => a + (num(i.qty_fact) || 0), 0);
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
      <button type="button" data-act="inc" aria-label="Плюс один" ${w}>+</button><span class="u">${esc(i.unit || "шт.")}</span></div>${diff}</div>
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
document.addEventListener("keydown", e => { if(e.key === "Escape" && !$("scrim").hidden) closeEditor(); });
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
  const rows = logRows.filter(r => !q || [r.item_name, name(r.user_id)].join(" ").toLowerCase().includes(q));
  if(!rows.length){ $("logList").innerHTML = `<div class="empty" style="border:0">${q ? "Нет записей по этому запросу." : "Изменений пока не было. Здесь появится каждое изменение на складе."}</div>`; return; }
  const ACT = { insert:"добавил(а)", update:"изменил(а)", delete:"удалил(а)" };
  $("logList").innerHTML = rows.map(r => {
    const ch = r.changes ? Object.entries(r.changes).filter(([k]) => FIELDS[k]).map(([k,[a,b]]) => `<li>${FIELDS[k]}: ${esc(fmt(a))} → <b>${esc(fmt(b))}</b></li>`).join("") : "";
    const t = new Date(r.created_at);
    return `<div class="ev"><time datetime="${esc(r.created_at)}" title="${t.toLocaleString("ru-RU")}">${t.toLocaleDateString("ru-RU",{day:"2-digit",month:"2-digit"})} ${t.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})}</time>
      <div class="what"><span class="who">${esc(name(r.user_id))}</span> <span class="act ${r.action}">${ACT[r.action] || r.action}</span> ${esc(r.item_name || "")}${ch ? `<ul>${ch}</ul>` : ""}</div></div>`;
  }).join("");
}
$("logQ").addEventListener("input", renderLog);

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

boot();
})();
