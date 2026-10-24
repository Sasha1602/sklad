// =====================================================================
//  Склад проката — Edge Function «notify»: push-уведомления.
//  Supabase → Edge Functions → Deploy a new function → Via Editor →
//  имя: notify → вставить этот файл → Deploy. В настройках функции
//  выключите «Verify JWT» (функцию защищает свой секрет NOTIFY_SECRET).
//
//  Секреты (Edge Functions → Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
//  VAPID_SUBJECT, NOTIFY_SECRET. SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY
//  Supabase подставляет сам.
//  Приложение для iPhone (необязательно, см. 10_apns.sql): APNS_KEY (содержимое .p8),
//  APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID.
//
//  Вызовы (из базы, см. 07_push.sql):
//    { kind:"daily" }                     — каждый вечер: завтрашние выезды, просрочки
//    { kind:"event_returned", id:<event> } — не вернулось с мероприятия
//    { kind:"item_repair", id:<item> }     — прибор в ремонт / не найден
//    { kind:"crew_added", id:<event_crew> } — человека поставили на выезд
//    { kind:"crew_reply", id:<event_crew> } — человек ответил «смогу / не смогу» (менеджерам)
//    { kind:"test", user_id:"…" }          — проверка: уведомление себе
//  Календарь (GET, см. 09_calendar.sql): ?cal=<токен>[&ev=<id>][&all=1][&t=shifts] — файл .ics
//    для календаря телефона: подписка «мои выезды», «смены основной работы» или одно мероприятие.
//  Без внешних библиотек: шифрование Web Push (RFC 8291) и подпись VAPID (RFC 8292) на WebCrypto.
// =====================================================================

// Значение секрета без лишних пробелов и кавычек (частая ошибка при вставке «ИМЯ = значение»).
const env = (k) => String((typeof Deno !== "undefined" ? Deno.env.get(k) : globalThis.process?.env?.[k]) || "").trim().replace(/^["']|["']$/g, "").trim();
const enc = new TextEncoder();

// ---------- base64url ----------
export function b64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
const concat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };

// ---------- HKDF (extract + expand за один вызов WebCrypto) ----------
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

// ---------- шифрование тела push: RFC 8291 (aes128gcm) ----------
// asKeys/salt можно передать для проверки на тестовых векторах; иначе генерируются.
export async function encryptPush(payload, p256dhB64u, authB64u, opts = {}) {
  const uaPublic = unb64u(p256dhB64u), authSecret = unb64u(authB64u);
  const asKeys = opts.asKeys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const plain = concat(typeof payload === "string" ? enc.encode(payload) : payload, new Uint8Array([2]));
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const rs = 4096, head = new Uint8Array(21); head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, rs); head[20] = asPublic.length;
  return concat(head, asPublic, ct);
}

// ---------- подпись VAPID: RFC 8292 (ES256 JWT) ----------
export async function vapidAuth(endpoint, pubB64u, privD, subject) {
  const pub = unb64u(pubB64u);
  const jwk = { kty: "EC", crv: "P-256", x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: privD, ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body)));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${pubB64u}`;
}

export async function sendPush(sub, msg) {
  const body = await encryptPush(JSON.stringify(msg), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(sub.endpoint, env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY"), env("VAPID_SUBJECT") || "mailto:admin@example.com"),
      "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high",
    },
    body,
  });
  return res.status;
}

// ---------- APNs: push в приложение для iPhone ----------
let apnsCache = { t: 0, jwt: "" };
let apnsError = "";
export const apnsReady = () => !!(env("APNS_KEY") && env("APNS_KEY_ID") && env("APNS_TEAM_ID") && env("APNS_BUNDLE_ID"));
async function apnsJwt() {
  const now = Math.floor(Date.now() / 1000);
  if (apnsCache.jwt && now - apnsCache.t < 50 * 60) return apnsCache.jwt;
  // Ключ .p8 можно вставить целиком (с BEGIN/END и переносами) или одной строкой.
  const b64 = env("APNS_KEY").replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ alg: "ES256", kid: env("APNS_KEY_ID") })));
  const body = b64u(enc.encode(JSON.stringify({ iss: env("APNS_TEAM_ID"), iat: now })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body)));
  apnsCache = { t: now, jwt: `${head}.${body}.${b64u(sig)}` };
  return apnsCache.jwt;
}
export async function sendApns(tok, msg) {
  const host = tok.env === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const ev = /#ev-(\d+)/.exec(msg.url || "");
  const payload = { aps: { alert: { title: msg.title, body: msg.body }, sound: "default" } };
  if (ev) payload.ev = +ev[1];
  const headers = { authorization: "bearer " + await apnsJwt(), "apns-topic": env("APNS_BUNDLE_ID"), "apns-push-type": "alert", "apns-priority": "10", "content-type": "application/json" };
  if (msg.tag) headers["apns-collapse-id"] = String(msg.tag).slice(0, 64);
  const res = await fetch(`${host}/3/device/${tok.token}`, { method: "POST", headers, body: JSON.stringify(payload) });
  let reason = "";
  if (res.status !== 200) { try { reason = (await res.json()).reason || ""; } catch (_) { /* пусто */ } }
  return { status: res.status, reason };
}

// ---------- данные из базы (REST с ключом service_role) ----------
async function db(path) {
  const r = await fetch(env("SUPABASE_URL") + "/rest/v1/" + path, {
    headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: "Bearer " + env("SUPABASE_SERVICE_ROLE_KEY") },
  });
  if (!r.ok) throw new Error(path + " → " + r.status + " " + await r.text());
  return await r.json();
}
async function dbDelete(path) {
  await fetch(env("SUPABASE_URL") + "/rest/v1/" + path, {
    method: "DELETE", headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: "Bearer " + env("SUPABASE_SERVICE_ROLE_KEY") },
  });
}
const inList = (ids) => "(" + [...new Set(ids)].map((x) => encodeURIComponent(String(x))).join(",") + ")";
// Даты по Москве (UTC+3, без перехода на летнее время).
const mskDay = (shift = 0) => new Date(Date.now() + 3 * 3600e3 + shift * 864e5).toISOString().slice(0, 10);
const ruDate = (k) => { const [y, m, d] = k.split("-"); return `${+d}.${m}`; };

async function managers() { return (await db("profiles?select=id&role=in.(manager,admin)")).map((p) => p.id); }

// Отправить одно сообщение списку пользователей; мёртвые подписки удаляются.
async function notifyUsers(userIds, msg) {
  userIds = [...new Set(userIds.filter(Boolean))];
  if (!userIds.length) return 0;
  let sent = 0;
  let subs = [];
  try { subs = await db("push_subs?select=*&user_id=in." + inList(userIds)); } catch (_) { /* таблицы нет */ }
  for (const s of subs) {
    try {
      const st = await sendPush(s, msg);
      if (st === 404 || st === 410) await dbDelete("push_subs?id=eq." + s.id);
      else if (st < 300) sent++;
    } catch (_) { /* одна плохая подписка не мешает остальным */ }
  }
  // Приложение для iPhone.
  if (apnsReady()) {
    let toks = [];
    try { toks = await db("apns_tokens?select=token,env&user_id=in." + inList(userIds)); } catch (_) { /* 10_apns.sql не запущен */ }
    for (const t of toks) {
      try {
        const r = await sendApns(t, msg);
        if (r.status === 200) sent++;
        else if (r.status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(r.reason)) await dbDelete("apns_tokens?token=eq." + encodeURIComponent(t.token));
        else apnsError = `APNs ${r.status} ${r.reason}`;
      } catch (e) { apnsError = "APNs: " + String(e.message || e); }
    }
  }
  return sent;
}

async function daily() {
  const today = mskDay(0), tomorrow = mskDay(1);
  let sent = 0;
  // 1. Завтрашние выезды — команде и ответственному.
  const tom = await db(`events?select=id,title,venue,responsible&status=eq.planned&date_from=eq.${tomorrow}`);
  if (tom.length) {
    const crew = await db("event_crew?select=event_id,user_id&event_id=in." + inList(tom.map((e) => e.id)));
    for (const e of tom) {
      const who = [e.responsible, ...crew.filter((c) => c.event_id === e.id).map((c) => c.user_id)];
      sent += await notifyUsers(who, { title: "Завтра выезд", body: e.title + (e.venue ? " — " + e.venue : ""), url: "./#ev-" + e.id, tag: "tomorrow-" + e.id });
    }
  }
  // 2. Просрочки — менеджерам и ответственному.
  const mg = await managers();
  const late = await db(`events?select=id,title,date_to,responsible&status=eq.out&date_to=lt.${today}`);
  for (const e of late) sent += await notifyUsers([...mg, e.responsible], { title: "Не вернули вовремя", body: `${e.title} — должно было вернуться ${ruDate(e.date_to)}`, url: "./#ev-" + e.id, tag: "late-" + e.id });
  const notOut = await db(`events?select=id,title,date_to,responsible&status=eq.planned&date_to=lt.${today}`);
  for (const e of notOut) sent += await notifyUsers([...mg, e.responsible], { title: "Отгрузка не отмечена", body: `${e.title} (${ruDate(e.date_to)}) — отметьте отгрузку и возврат или отмените`, url: "./#ev-" + e.id, tag: "notout-" + e.id });
  return sent;
}

async function eventReturned(id) {
  const [e] = await db(`events?select=id,title,responsible&id=eq.${id}`); if (!e) return 0;
  const ls = await db(`event_items?select=item_id,qty,qty_out,qty_back&event_id=eq.${id}`);
  const miss = ls.map((l) => ({ id: l.item_id, n: (l.qty_out ?? l.qty) - (l.qty_back ?? (l.qty_out ?? l.qty)) })).filter((x) => x.n > 0);
  if (!miss.length) return 0;
  const names = await db("items?select=id,name&id=in." + inList(miss.map((m) => m.id)));
  const text = miss.map((m) => (names.find((x) => x.id === m.id)?.name || "позиция") + " — " + m.n).join(", ");
  return await notifyUsers([...(await managers()), e.responsible], { title: "Не вернулось с мероприятия", body: `${e.title}: ${text}`, url: "./#ev-" + id, tag: "miss-" + id });
}

async function crewAdded(id) {
  const [c] = await db(`event_crew?select=event_id,user_id,job&id=eq.${id}`);
  if (!c || !c.user_id) return 0;
  const [e] = await db(`events?select=id,title,venue,date_from,date_to,status&id=eq.${c.event_id}`);
  if (!e || e.status === "cancelled" || e.status === "returned") return 0;
  const d = e.date_from === e.date_to ? ruDate(e.date_from) : ruDate(e.date_from) + "–" + ruDate(e.date_to);
  return await notifyUsers([c.user_id], { title: "Вас поставили на выезд", body: `${e.title}, ${d}` + (c.job ? " — " + c.job : "") + (e.venue ? " · " + e.venue : ""), url: "./#ev-" + e.id, tag: "crew-" + e.id });
}

async function crewReply(id) {
  const [c] = await db(`event_crew?select=event_id,user_id,job,reply,reply_note&id=eq.${id}`);
  if (!c || !c.user_id || !c.reply) return 0;
  const [e] = await db(`events?select=id,title,date_from,date_to,responsible,status&id=eq.${c.event_id}`);
  if (!e || e.status === "cancelled") return 0;
  const [p] = await db(`profiles?select=full_name,email&id=eq.${c.user_id}`);
  const who = (p && (p.full_name || p.email)) || "Сотрудник";
  const d = e.date_from === e.date_to ? ruDate(e.date_from) : ruDate(e.date_from) + "–" + ruDate(e.date_to);
  const to = [...new Set([...(await managers()), e.responsible].filter((u) => u && u !== c.user_id))];
  return await notifyUsers(to, {
    title: `${who}: ${c.reply === "yes" ? "смогу ✓" : "не смогу ✕"}`,
    body: `${e.title}, ${d}` + (c.reply_note ? " — " + c.reply_note : ""),
    url: "./#ev-" + e.id, tag: "reply-" + id,
  });
}

async function itemRepair(id) {
  const [it] = await db(`items?select=id,name,state,status,note&id=eq.${id}`); if (!it) return 0;
  const what = it.status === "Не найдено" ? "не найден" : it.state.toLowerCase();
  return await notifyUsers(await managers(), { title: `${it.name}: ${what}`, body: it.note || "Открыть карточку", url: "./#i-" + id, tag: "item-" + id });
}

// ---------- календарь телефона (.ics) ----------
const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function icsFold(line) {
  const out = []; let cur = "", len = 0;
  for (const ch of line) { const b = enc.encode(ch).length; if (len + b > 73) { out.push(cur); cur = " " + ch; len = 1 + b; } else { cur += ch; len += b; } }
  out.push(cur); return out.join("\r\n");
}
const icsDate = (k) => k.replace(/-/g, "");
const nextDay = (k) => new Date(Date.parse(k + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);
const STATUS_RU = { planned: "", out: "на выезде", returned: "вернулось" };
export function buildIcs(evs, crew, people, opts = {}) {
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const name = (id) => { const p = people.find((x) => x.id === id); return p ? (p.full_name || p.email) : ""; };
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sklad prokata//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  if (opts.title) L.push("X-WR-CALNAME:" + icsEsc(opts.title), "X-WR-TIMEZONE:Europe/Moscow", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H");
  if (opts.color) L.push("X-APPLE-CALENDAR-COLOR:" + opts.color, "COLOR:" + opts.colorName);
  for (const e of evs) {
    const cr = crew.filter((c) => c.event_id === e.id).map((c) => (c.user_id ? name(c.user_id) : c.name || "") + (c.job ? " (" + c.job + ")" : "") + (c.phone ? " " + c.phone : ""));
    const link = opts.site ? opts.site + "#ev-" + e.id : "";
    const desc = [e.client ? "Заказчик: " + e.client : "", e.responsible && name(e.responsible) ? "Ответственный: " + name(e.responsible) : "",
      cr.length ? "Команда: " + cr.join(", ") : "", e.note || "", link].filter(Boolean).join("\n");
    const st = STATUS_RU[e.status] ? " (" + STATUS_RU[e.status] + ")" : "";
    L.push("BEGIN:VEVENT", "UID:sklad-ev-" + e.id + "@sklad", "DTSTAMP:" + now,
      "DTSTART;VALUE=DATE:" + icsDate(e.date_from), "DTEND;VALUE=DATE:" + icsDate(nextDay(e.date_to)),
      "SUMMARY:" + icsEsc(e.title + st));
    if (e.venue) L.push("LOCATION:" + icsEsc(e.venue));
    L.push("DESCRIPTION:" + icsEsc(desc));
    if (link) L.push("URL:" + link);
    if (e.status === "planned") L.push("BEGIN:VALARM", "TRIGGER:-PT6H", "ACTION:DISPLAY", "DESCRIPTION:" + icsEsc("Завтра выезд: " + e.title), "END:VALARM");
    L.push("END:VEVENT");
  }
  for (const sh of opts.shifts || []) {
    L.push("BEGIN:VEVENT", "UID:sklad-shift-" + sh.uid + "-" + sh.from + "@sklad", "DTSTAMP:" + now,
      "DTSTART;VALUE=DATE:" + icsDate(sh.from), "DTEND;VALUE=DATE:" + icsDate(nextDay(sh.to)),
      "SUMMARY:" + icsEsc(sh.title), "DESCRIPTION:" + icsEsc("График основной работы со склада. Изменить: «Люди» → «График»."), "END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.map(icsFold).join("\r\n") + "\r\n";
}
// Смены основной работы (как на сайте: график work/off по кругу от anchor; «отпуск» и «недоступен» смен не дают).
const dayNum = (k) => Math.round(Date.parse(k + "T00:00:00Z") / 864e5);
export function shiftRuns(sc, periods, from, to, uid = "", days = [], types = []) {
  // Отметки по дням (приложение «Смены») важнее графика; график действует с даты смены в нём.
  const typeOf = (id) => types.find((t) => t.id === id);
  const hhmm = (t) => (t ? String(t).slice(0, 5) : "");
  const label = (st) => st.name + (st.start_time && st.end_time ? ` ${hhmm(st.start_time)}–${hhmm(st.end_time)}` : "");
  const ov = new Map(days.map((d) => [d.day, d]));
  const patType = sc && sc.shift_type_id ? typeOf(sc.shift_type_id) : null;
  const patTitle = sc ? (patType ? label(patType) : (sc.label || "Основная работа") + " — смена") : "";
  const cyc = sc ? sc.work_days + sc.off_days : 0, a = sc ? dayNum(sc.anchor) : 0;
  const out = []; let run = null;
  for (let k = from; k <= to; k = nextDay(k)) {
    let title = null;
    const o = ov.get(k);
    if (o) {
      const st = o.shift_type_id ? typeOf(o.shift_type_id) : null;
      if (st && st.is_work !== false) title = label(st);
    } else if (sc && sc.work_days > 0 && k >= sc.anchor) {
      const m = (((dayNum(k) - a) % cyc) + cyc) % cyc;
      const off = periods.some((p) => p.date_from <= k && p.date_to >= k);
      if (m < sc.work_days && !off) title = patTitle;
    }
    if (title) { if (run && run.title === title && nextDay(run.to) === k) run.to = k; else out.push(run = { uid, from: k, to: k, title }); }
  }
  return out;
}
async function calendar(url) {
  const t = url.searchParams.get("cal") || "";
  if (!/^[0-9a-f]{32}$/.test(t)) return null;
  const [tk] = await db("cal_tokens?select=user_id&token=eq." + t); if (!tk) return null;
  const [me] = await db("profiles?select=id,role&id=eq." + tk.user_id); if (!me || me.role === "pending") return null;
  const ev = +url.searchParams.get("ev") || 0, all = url.searchParams.get("all") === "1", onlyShifts = url.searchParams.get("t") === "shifts";
  const site = /^https:\/\/[^\s"<>]+$/.test(url.searchParams.get("s") || "") ? url.searchParams.get("s") : "";
  const from = mskDay(-60), cols = "id,title,venue,client,note,date_from,date_to,status,responsible";
  if (onlyShifts) {
    let shifts = [];
    try {
      const [sc] = await db("staff_schedule?select=*&user_id=eq." + me.id);
      let days = [], types = [];
      try {
        days = await db(`staff_days?select=day,shift_type_id&user_id=eq.${me.id}&day=gte.${mskDay(-30)}`);
        types = await db("shift_types?select=*&user_id=eq." + me.id);
      } catch (_) { /* 12_shifts.sql не запущен */ }
      if (sc || days.length) shifts = shiftRuns(sc, sc ? await db("staff_periods?select=kind,date_from,date_to&user_id=eq." + me.id) : [], mskDay(-30), mskDay(180), me.id, days, types);
    } catch (_) { /* графиков нет */ }
    return buildIcs([], [], [], { shifts, title: "Склад — смены основной работы", color: "#8E8E93", colorName: "gray" });
  }
  let evs;
  if (ev) evs = await db(`events?select=${cols}&id=eq.${ev}&status=neq.cancelled`);
  else if (all) evs = await db(`events?select=${cols}&status=neq.cancelled&date_to=gte.${from}&order=date_from`);
  else {
    const ids = (await db("event_crew?select=event_id&user_id=eq." + me.id)).map((c) => c.event_id);
    const or = "(responsible.eq." + me.id + (ids.length ? ",id.in." + inList(ids) : "") + ")";
    evs = await db(`events?select=${cols}&status=neq.cancelled&date_to=gte.${from}&or=${encodeURIComponent(or)}&order=date_from`);
  }
  const crew = evs.length ? await db("event_crew?select=event_id,user_id,name,phone,job&event_id=in." + inList(evs.map((e) => e.id))) : [];
  const people = await db("profiles?select=id,full_name,email");
  return buildIcs(evs, crew, people, { site, title: ev ? "" : all ? "Склад — все мероприятия" : "Склад — мои выезды", color: ev ? "" : "#FF9500", colorName: "orange" });
}

if (typeof Deno !== "undefined") {
  Deno.serve(async (req) => {
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
    const url = new URL(req.url);
    if (req.method === "GET" && url.searchParams.has("cal")) {
      try {
        const ics = await calendar(url);
        if (!ics) return new Response("Ссылка на календарь недействительна", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        return new Response(ics, { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="sklad.ics"', "Cache-Control": "no-cache" } });
      } catch (e) { return new Response("Ошибка: " + String(e.message || e), { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } }); }
    }
    let body = {};
    apnsError = "";
    try { body = await req.json(); } catch (_) { /* пусто */ }
    const given = String(req.headers.get("x-notify-secret") || body.secret || "").trim();
    if (!env("NOTIFY_SECRET")) return json({ error: "forbidden: секрет NOTIFY_SECRET не задан в Edge Functions → Secrets" }, 403);
    if (given !== env("NOTIFY_SECRET")) return json({ error: "forbidden: секрет из базы не совпадает с NOTIFY_SECRET" }, 403);
    try {
      let sent = 0;
      if (body.kind === "daily") sent = await daily();
      else if (body.kind === "event_returned") sent = await eventReturned(body.id);
      else if (body.kind === "item_repair") sent = await itemRepair(body.id);
      else if (body.kind === "crew_added") sent = await crewAdded(body.id);
      else if (body.kind === "crew_reply") sent = await crewReply(body.id);
      else if (body.kind === "test") sent = await notifyUsers([body.user_id], { title: "Склад проката", body: "Уведомления работают ✓", url: "./#today" });
      else return json({ error: "unknown kind" }, 400);
      return json(apnsError ? { ok: true, sent, apns_error: apnsError } : { ok: true, sent });
    } catch (e) { return json({ error: String(e.message || e) }, 500); }
  });
}
