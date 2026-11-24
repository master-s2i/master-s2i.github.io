/* ==========================================================================
   Composants partagés entre les espaces
   ========================================================================== */

/* ---------- Gestion des absences (inspirée de Canvas UM6P Attendance) ----------
   ctx : { modules: [codes], profId: id|null (null = admin, toutes séances) } */
function AttendanceView(el, ctx) {
  const st = { module: ctx.modules[0], tab: "today", cal: { y: new Date().getFullYear(), m: new Date().getMonth() } };
  const pre = AttendanceView.prefill; AttendanceView.prefill = null;
  if (pre && ctx.modules.includes(pre.module)) st.module = pre.module;
  if (!st.module) { el.innerHTML = `<div class="alert warn">Aucun module ne vous est affecté. Contactez l'administrateur.</div>`; return; }

  const sessionsOf = () => Store.all("sessions").filter((s) => s.module === st.module && (!ctx.profId || s.profId === ctx.profId))
    .sort((a, b) => (b.date + b.debut).localeCompare(a.date + a.debut));
  const studentsOf = (section) => Store.all("students").filter((s) => sectionOf(s) === section && !s.inactif).sort((a, b) => a.nom.localeCompare(b.nom));
  const studentsOfModule = () => { const y = yearOfModule(st.module); return Store.all("students").filter((s) => s.annee === y && !s.inactif); };

  const draw = () => {
    const year = yearOfModule(st.module); const secs = sectionsOfYear(year);
    const all = sessionsOf(); const t = todayISO();
    const groups = { today: all.filter((s) => s.date === t), future: all.filter((s) => s.date > t), past: all.filter((s) => s.date < t), all };
    el.innerHTML = `
      <div class="page-head"><h1>Gestion des absences</h1>
        <div class="toolbar"><div class="f"><select id="att-mod">${UI.moduleOptions(ctx.modules, st.module)}</select></div>
        <button class="btn outline" id="att-export">Exporter (CSV)</button></div></div>
      <div class="panel"><div class="panel-h">▦ ${esc(UI.moduleLabel(st.module)).toUpperCase()}</div>
        <div class="panel-stats"><span>Étudiant(s) : <b>${studentsOfModule().length}</b></span><span>Section(s) : <b>${secs.length}</b></span><span>Séance(s) : <b>${all.length}</b></span></div></div>

      <div class="panel"><div class="panel-h light">▦ Feuille de présence</div>
        <div class="table-scroll"><table class="data form-row"><thead><tr><th>Section</th><th>Date</th><th>De</th><th>À</th><th>Type de séance</th><th>Nature</th><th>Mode</th><th>Action</th></tr></thead>
        <tbody><tr>
          <td><select id="n-sec"><option value="">Choisir la section</option>${secs.map((s) => `<option>${s}</option>`).join("")}</select></td>
          <td><input type="date" id="n-date" value="${t}"></td>
          <td><input type="time" id="n-from" value="08:30"></td>
          <td><input type="time" id="n-to" value="10:30"></td>
          <td><select id="n-type">${S2I.typesSeance.map((x) => `<option>${x}</option>`).join("")}</select></td>
          <td><select id="n-nat"><option value="">-- Nature --</option>${S2I.natures.map((x) => `<option>${x}</option>`).join("")}</select></td>
          <td><select id="n-mode">${Object.entries(MODES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></td>
          <td><button class="btn" id="n-create">Créer la feuille</button></td></tr></tbody></table></div></div>

      <div class="panel"><div class="panel-h light">▦ Séances de présence</div><div class="panel-b">
        <div class="tabs">
          <button data-tab="today">Aujourd'hui (${groups.today.length})</button><button data-tab="future">À venir (${groups.future.length})</button>
          <button data-tab="past">Passées (${groups.past.length})</button><button data-tab="all">Toutes (${groups.all.length})</button>
          <button data-tab="cal">📅 Calendrier</button><button data-tab="recap">📊 Récapitulatif</button></div>
        <div id="att-body"></div></div></div>`;

    $("#att-mod", el).onchange = (e) => { st.module = e.target.value; draw(); };
    $("#att-export", el).onclick = () => exportCsv();
    $("#n-create", el).onclick = () => {
      const s = { module: st.module, section: $("#n-sec", el).value, date: $("#n-date", el).value, debut: $("#n-from", el).value, fin: $("#n-to", el).value,
        type: $("#n-type", el).value, nature: $("#n-nat", el).value, mode: $("#n-mode", el).value, profId: ctx.profId || "", records: {}, createdAt: new Date().toISOString() };
      if (!s.section || !s.date || !s.nature) return UI.toast("Choisissez la section, la date et la nature.");
      if (s.fin <= s.debut) return UI.toast("L'heure de fin doit suivre l'heure de début.");
      studentsOf(s.section).forEach((x) => (s.records[x.id] = "P"));
      Store.put("sessions", s); UI.toast("Feuille de présence créée."); rollCall(s.id);
      st.tab = s.date === t ? "today" : s.date > t ? "future" : "past"; draw();
    };
    $$("[data-tab]", el).forEach((b) => { b.classList.toggle("active", b.dataset.tab === st.tab); b.onclick = () => { st.tab = b.dataset.tab; draw(); }; });

    const body = $("#att-body", el);
    if (st.tab === "cal") {
      renderMonthCalendar(body, all.map((s) => ({ date: s.date, time: s.debut, label: `${s.section} · ${s.nature}`, title: `${s.section} ${s.debut}-${s.fin} (${s.type})`, cls: "sess" })), st.cal);
    } else if (st.tab === "recap") {
      body.innerHTML = recapHtml(all);
    } else {
      const list = groups[st.tab];
      const msg = { today: "Aucune séance prévue aujourd'hui.", future: "Aucune séance à venir.", past: "Aucune séance passée.", all: "Aucune séance pour ce module." }[st.tab];
      body.innerHTML = list.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Date</th><th>Horaire</th><th>Section</th><th>Type</th><th>Nature</th><th>Mode</th><th>P / A / R / J</th>${ctx.profId ? "" : "<th>Enseignant</th>"}<th></th></tr></thead><tbody>
        ${list.map((s) => { const c = counts(s); return `<tr><td>${fmtDate(s.date)}</td><td>${s.debut} – ${s.fin}</td><td><span class="pill sec">${s.section}</span></td><td>${esc(s.type)}</td><td>${esc(s.nature)}</td><td>${modePill(s.mode)}</td>
          <td><b style="color:var(--ok)">${c.P}</b> / <b style="color:var(--danger)">${c.A}</b> / <b style="color:var(--warn)">${c.R}</b> / <b style="color:var(--blue)">${c.J}</b></td>
          ${ctx.profId ? "" : `<td>${esc(UI.profName(s.profId))}</td>`}
          <td class="actions"><button class="btn sm" data-roll="${s.id}">Saisir l'appel</button> <button class="btn danger sm" data-dels="${s.id}">Supprimer</button></td></tr>`; }).join("")}
        </tbody></table></div>` : `<div class="alert warn">⚠ ${msg}</div>`;
      $$("[data-roll]", body).forEach((b) => b.onclick = () => rollCall(b.dataset.roll));
      $$("[data-dels]", body).forEach((b) => b.onclick = () => { if (UI.confirm("Supprimer cette séance et son appel ?")) { Store.del("sessions", b.dataset.dels); draw(); } });
    }
  };

  const counts = (s) => { const c = { P: 0, A: 0, R: 0, J: 0 }; Object.values(s.records || {}).forEach((v) => c[v] !== undefined && c[v]++); return c; };

  const rollCall = (id) => {
    const s = Store.get("sessions", id); const studs = studentsOf(s.section);
    studs.forEach((x) => { if (!s.records[x.id]) s.records[x.id] = "P"; });
    const comments = s.comments || {};
    const row = (x) => `<tr><td>${esc(x.login)}</td><td>${esc(UI.studentName(x))}</td>
      <td><div class="mark" data-sid="${x.id}">${["P", "A", "R", "J"].map((k) => `<button type="button" class="${k} ${s.records[x.id] === k ? "on" : ""}" data-k="${k}" title="${{ P: "Présent", A: "Absent", R: "Retard", J: "Absence justifiée" }[k]}">${k}</button>`).join("")}</div></td>
      <td><input data-com="${x.id}" value="${esc(comments[x.id] || "")}" placeholder="Remarque"></td></tr>`;
    const m = UI.modal({
      title: `Appel — ${s.section} · ${fmtDate(s.date)} ${s.debut}-${s.fin} · ${s.nature} · ${MODES[s.mode] || "Présentiel"}`, wide: true, submitLabel: "Enregistrer l'appel",
      body: `<p class="muted">P = Présent · A = Absent · R = Retard · J = Absence justifiée. <button type="button" class="btn outline sm" id="allP">Tous présents</button></p>
        ${studs.length ? `<table class="data"><thead><tr><th>Code</th><th>Étudiant</th><th>Présence</th><th>Remarque</th></tr></thead><tbody>${studs.map(row).join("")}</tbody></table>` : `<div class="alert warn">Aucun étudiant inscrit dans la section ${s.section}.</div>`}`,
      onSubmit: (form) => {
        $$("[data-com]", form).forEach((i) => { if (i.value.trim()) comments[i.dataset.com] = i.value.trim(); else delete comments[i.dataset.com]; });
        s.comments = comments; s.updatedAt = new Date().toISOString(); Store.put("sessions", s); UI.toast("Appel enregistré."); draw();
      }
    });
    $$(".mark", m).forEach((g) => $$("button", g).forEach((b) => b.onclick = () => { s.records[g.dataset.sid] = b.dataset.k; $$("button", g).forEach((x) => x.classList.toggle("on", x === b)); }));
    const allP = $("#allP", m); if (allP) allP.onclick = () => $$(".mark", m).forEach((g) => { s.records[g.dataset.sid] = "P"; $$("button", g).forEach((x) => x.classList.toggle("on", x.dataset.k === "P")); });
  };

  const recapHtml = (sessions) => {
    const studs = studentsOfModule().sort((a, b) => sectionOf(a).localeCompare(sectionOf(b)) || a.nom.localeCompare(b.nom));
    if (!studs.length) return `<div class="empty">Aucun étudiant.</div>`;
    return `<div class="table-scroll"><table class="data"><thead><tr><th>Code</th><th>Étudiant</th><th>Section</th><th>Séances</th><th>Absences</th><th>Retards</th><th>Justifiées</th><th>Taux d'absence</th></tr></thead><tbody>
      ${studs.map((x) => { const ss = sessions.filter((s) => s.section === sectionOf(x) && s.records && s.records[x.id]);
        const c = { A: 0, R: 0, J: 0 }; ss.forEach((s) => { const v = s.records[x.id]; if (c[v] !== undefined) c[v]++; });
        const rate = ss.length ? Math.round((c.A / ss.length) * 100) : 0;
        return `<tr><td>${esc(x.login)}</td><td>${esc(UI.studentName(x))}</td><td>${sectionOf(x)}</td><td>${ss.length}</td><td>${c.A}</td><td>${c.R}</td><td>${c.J}</td><td class="rate ${rate >= 25 ? "bad" : ""}">${rate} %</td></tr>`; }).join("")}
      </tbody></table></div><p class="muted">Le taux est calculé sur les absences non justifiées ; il s'affiche en rouge à partir de 25 %.</p>`;
  };

  const exportCsv = () => {
    const sessions = sessionsOf().slice().reverse();
    const studs = studentsOfModule().sort((a, b) => sectionOf(a).localeCompare(sectionOf(b)) || a.nom.localeCompare(b.nom));
    const head = ["Code", "Nom", "Prénom", "Section", ...sessions.map((s) => `${fmtDate(s.date)} ${s.debut} ${s.nature}`)];
    const lines = studs.map((x) => [x.login, x.nom, x.prenom, sectionOf(x), ...sessions.map((s) => (s.section === sectionOf(x) ? s.records[x.id] || "" : "—"))]);
    const csv = [head, ...lines].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\n");
    downloadFile(`absences_${st.module}.csv`, "﻿" + csv, "text/csv");
  };
  draw();
  if (pre && st.module === pre.module) {
    const set = (id, v) => { const x = $(id, el); if (x && v) x.value = v; };
    set("#n-sec", pre.section); set("#n-date", pre.date); set("#n-from", pre.debut); set("#n-to", pre.fin); set("#n-mode", pre.mode);
    const row = $("#n-create", el).closest("tr"); row.classList.add("prefilled"); row.scrollIntoView({ behavior: "smooth", block: "center" });
    UI.toast("Séance préremplie : vérifiez puis cliquez sur « Créer la feuille ».");
  }
}

/* Contenus pédagogiques : voir assets/js/contenus.js */

/* ---------- Messagerie (chat par module et par section) ----------
   ctx : { user, role, channels: [{module, section}] } */
const Chat = {
  seenKey: (u) => `s2i_seen_${u.role}_${u.id}`,
  seen(u) { try { return JSON.parse(localStorage.getItem(this.seenKey(u))) || {}; } catch { return {}; } },
  markSeen(u, key) { const s = this.seen(u); s[key] = new Date().toISOString(); localStorage.setItem(this.seenKey(u), JSON.stringify(s)); },
  key: (c) => `${c.module}|${c.section}`,
  msgsOf: (c) => Store.all("messages").filter((m) => m.module === c.module && m.section === c.section).sort((a, b) => a.date.localeCompare(b.date)),
  unread(u, c) { const t = this.seen(u)[this.key(c)] || ""; return this.msgsOf(c).filter((m) => m.date > t && !(m.authorId === u.id && m.authorRole === u.role)).length; },
  totalUnread(u, chans) { return chans.reduce((n, c) => n + this.unread(u, c), 0); }
};
function ChatView(el, ctx) {
  const st = { cur: ctx.channels[0] };
  const label = (c) => c.module === "ALL" ? "📢 Annonces générales" : `${c.module} · ${c.section}`;
  const draw = (keepDraft) => {
    if (!st.cur) { el.innerHTML = `<div class="alert warn">Aucun canal disponible.</div>`; return; }
    const prev = $("#chat-f textarea", el); const draft = keepDraft && prev ? prev.value : "";
    Chat.markSeen(ctx.user, Chat.key(st.cur));
    const msgs = Chat.msgsOf(st.cur);
    const canWrite = st.cur.module !== "ALL" || ctx.role === "admin";
    el.innerHTML = `<div class="page-head"><h1>Messagerie</h1><span class="muted">Chat par module et par section</span></div>
      <div class="chat"><div class="chans">${ctx.channels.map((c) => { const n = Chat.unread(ctx.user, c);
        return `<a href="javascript:void 0" data-k="${Chat.key(c)}" class="${Chat.key(c) === Chat.key(st.cur) ? "active" : ""}" title="${esc(UI.moduleLabel(c.module))}"><span>${esc(label(c))}</span>${n ? `<span class="badge">${n}</span>` : ""}</a>`; }).join("")}</div>
      <div class="thread"><div class="panel-h" style="border-radius:0">${esc(UI.moduleLabel(st.cur.module))}${st.cur.module !== "ALL" ? ` — ${st.cur.section}` : ""}</div>
        <div class="msgs" id="msgs">${msgs.length ? msgs.map((m) => {
          const me = m.authorId === ctx.user.id && m.authorRole === ctx.role;
          return `<div class="msg ${me ? "me" : ""} ${m.authorRole === "prof" || m.authorRole === "admin" ? "prof" : ""} ${m.system ? "sys" : ""}"><div class="meta">${esc(m.authorName)} · ${fmtDateTime(m.date)}</div><div class="bubble">${linkify(m.text)}</div></div>`; }).join("") : `<div class="empty">Aucun message pour l'instant.</div>`}</div>
        ${canWrite ? `<form id="chat-f"><textarea name="t" placeholder="Écrire un message… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)" required></textarea><button class="btn">Envoyer</button></form>` : `<div class="muted" style="padding:10px">Canal en lecture seule.</div>`}</div></div>`;
    const box = $("#msgs", el); box.scrollTop = box.scrollHeight;
    $$("[data-k]", el).forEach((a) => a.onclick = () => { st.cur = ctx.channels.find((c) => Chat.key(c) === a.dataset.k); draw(); });
    const f = $("#chat-f", el);
    if (f) {
      const send = () => {
        const t = f.t.value.trim(); if (!t) return;
        const name = ctx.role === "admin" ? "Administration" : ctx.role === "prof" ? UI.profName(ctx.user.id) : `${ctx.user.prenom} ${ctx.user.nom}`;
        Store.put("messages", { module: st.cur.module, section: st.cur.section, authorRole: ctx.role, authorId: ctx.user.id, authorName: name, text: t, system: false, date: new Date().toISOString() });
        draw();
      };
      f.onsubmit = (e) => { e.preventDefault(); send(); };
      f.t.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
      if (draft) f.t.value = draft;
      f.t.focus();
    }
    if (ctx.onRead) ctx.onRead();
  };
  // Mise à jour en direct (mode Firebase) : nouveaux messages des autres utilisateurs
  Chat.onUpdate = () => { if (el.isConnected) draw(true); };
  if (!Chat._hooked) { Chat._hooked = true; Store.onChange((c) => { if (c === "messages" && Chat.onUpdate) Chat.onUpdate(); }); }
  draw();
}

/* ---------- Emploi du temps par semaine ---------- */
function TimetableView(el, { sections, profId, student, title = "Emploi du temps", onWeek }) {
  const st = { section: sections[0] };
  const draw = () => {
    const mon = TTWeek.monday;
    const vs = typeof Visio !== "undefined" ? Visio.slots() : [];
    const rows = [...Store.all("timetable"), ...vs].filter((t) => (profId ? t.profId === profId : t.section === st.section) && slotInWeek(t, mon)
      && (!student || !(t.etudiants || []).length || t.etudiants.includes(student.id)));
    const nbDist = rows.filter((r) => r.mode === "distance").length;
    el.innerHTML = `<div class="page-head"><h1>${esc(title)}</h1><div class="toolbar">
        ${!profId && sections.length > 1 ? `<select id="tt-sec" style="width:auto">${sections.map((s) => `<option ${s === st.section ? "selected" : ""}>${s}</option>`).join("")}</select>` : ""}
        <div class="week-nav"><button class="btn outline sm" data-w="-7" ${shiftISO(mon, -7) < edtStart() ? "disabled title=\"Début de l'emploi du temps\"" : ""}>‹</button><b>${weekLabel(mon)}</b><button class="btn outline sm" data-w="7">›</button><button class="btn outline sm" data-w="0">Cette semaine</button></div></div></div>
      ${rows.length ? `<p class="muted">${rows.length} séance(s) cette semaine${nbDist ? ` dont ${nbDist} à distance` : ""}.</p>
      <div class="table-scroll"><div class="tt">${S2I.jours.map((j, i) => { const date = shiftISO(mon, i);
        return `<div class="day ${date === todayISO() ? "today" : ""}"><h4>${j}<small>${fmtDate(date)}</small></h4>${rows.filter((r) => +r.jour === i + 1).sort((a, b) => a.debut.localeCompare(b.debut))
        .map((r) => `<div class="slot ${r.mode === "distance" ? "dist" : ""}"><span class="t">${r.debut} – ${r.fin}</span><b>${esc(r.module)}</b>${esc((Store.get("modules", r.module) || {}).titre || "")}
          <div class="muted">${r.mode === "distance" ? "" : esc(r.salle)}${profId ? ` · ${r.section}` : UI.teacherOf(r) ? ` · ${esc(UI.teacherOf(r))}` : ""}</div>
          <div style="margin-top:4px">${modePill(r.mode, r.lien)}${r.visio ? ` <span class="pill t-cours">${esc(((typeof PLATFORMS !== "undefined" && PLATFORMS[r.plateforme]) || { court: "Visio" }).court)}</span>` : r.semaine ? ' <span class="pill draft" title="Séance propre à cette semaine">ponctuelle</span>' : ""}</div></div>`).join("") || '<div class="muted" style="text-align:center">—</div>'}</div>`; }).join("")}</div></div>`
      : `<div class="alert info">Aucune séance programmée pour cette semaine.</div>`}`;
    const s = $("#tt-sec", el); if (s) s.onchange = (e) => { st.section = e.target.value; draw(); };
    $$("[data-w]", el).forEach((b) => b.onclick = () => { const n = +b.dataset.w; TTWeek.monday = n ? shiftISO(TTWeek.monday, n) : mondayOf(); draw(); if (onWeek) onWeek(); });
  };
  draw();
}

/* ---------- Calendrier des examens et soutenances ---------- */
function ExamsView(el, { sections }) {
  const exams = Store.all("exams").filter((e) => sections.includes(e.section)).sort((a, b) => (a.date + a.debut).localeCompare(b.date + b.debut));
  const souts = Store.all("soutenances").slice().sort((a, b) => (a.date + a.heure).localeCompare(b.date + b.heure));
  el.innerHTML = `<div class="page-head"><h1>Calendrier des examens et des soutenances</h1></div>
    <div id="cal-x" style="margin-bottom:26px"></div>
    <div class="panel"><div class="panel-h">Examens</div>${exams.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Date</th><th>Horaire</th><th>Section</th><th>Module</th><th>Type</th><th>Salle</th></tr></thead><tbody>
      ${exams.map((e) => `<tr><td>${fmtDate(e.date)}</td><td>${e.debut} – ${e.fin}</td><td><span class="pill sec">${e.section}</span></td><td>${esc(UI.moduleLabel(e.module))}</td><td>${esc(e.type)}</td><td>${esc(e.salle)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Aucun examen programmé.</div>`}</div>
    <div class="panel"><div class="panel-h">Soutenances des projets (PFE)</div>${souts.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Date</th><th>Heure</th><th>Étudiant(e)</th><th>Sujet</th><th>Encadrant</th><th>Jury</th><th>Salle</th></tr></thead><tbody>
      ${souts.map((s) => `<tr><td>${fmtDate(s.date)}</td><td>${esc(s.heure)}</td><td>${esc(s.etudiant)}</td><td>${esc(s.sujet)}</td><td>${esc(s.encadrant)}</td><td>${esc(s.jury)}</td><td>${esc(s.salle)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Aucune soutenance programmée.</div>`}</div>`;
  renderMonthCalendar($("#cal-x", el), [
    ...exams.map((e) => ({ date: e.date, time: e.debut, label: `${e.module} ${e.section}`, title: `${e.type} — ${UI.moduleLabel(e.module)} — ${e.salle}`, cls: "exam" })),
    ...souts.map((s) => ({ date: s.date, time: s.heure, label: `PFE ${s.etudiant}`, title: `Soutenance : ${s.sujet}`, cls: "sout" }))
  ]);
}

/* ---------- Profil : changement de mot de passe ---------- */
function ProfileView(el, user, col) {
  if (Store.mode === "firebase") {
    const mustF = (Store.get(col, user.id) || {}).mustChange;
    el.innerHTML = `<div class="page-head"><h1>Mon profil</h1></div>
      ${mustF ? `<div class="alert warn" style="max-width:520px;margin-bottom:14px">Bienvenue ! Pour sécuriser votre compte, choisissez votre mot de passe avant d'utiliser la plateforme. Le mot de passe actuel est le mot de passe provisoire reçu par e-mail.</div>` : ""}
      <div class="card" style="max-width:520px"><p><b>${esc(user.prenom)} ${esc(user.nom)}</b><br><span class="muted">Connexion : ${esc(Store.me.email)}</span></p>
      <form id="pw" class="form-grid"><div class="full"><label>Mot de passe actuel</label><input type="password" name="old" required autocomplete="current-password"></div>
      <div><label>Nouveau mot de passe</label><input type="password" name="n1" minlength="8" required autocomplete="new-password"></div>
      <div><label>Confirmation</label><input type="password" name="n2" minlength="8" required autocomplete="new-password"></div>
      <div class="full"><button class="btn">Changer le mot de passe</button></div></form></div>`;
    $("#pw", el).onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      if (f.n1.value !== f.n2.value) return UI.toast("Les deux mots de passe diffèrent.");
      try {
        const u = Store.auth.currentUser;
        await u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, f.old.value));
        if (f.n1.value === f.old.value) return UI.toast("Choisissez un mot de passe différent du mot de passe provisoire.");
        await u.updatePassword(f.n1.value); f.reset(); UI.toast("Mot de passe modifié.");
        if (mustF) { try { await Store.fs.collection(col).doc(String(user.id)).update({ mustChange: false }); } catch (e2) { console.error(e2); }
          const me = Store.get(col, user.id); if (me) { me.mustChange = false; Store._local(col, me); } setTimeout(() => { location.hash = ""; location.reload(); }, 700); }
      } catch (err) { UI.toast(err.code === "auth/wrong-password" || err.code === "auth/invalid-credential" ? "Mot de passe actuel incorrect." : "Échec : " + err.message); }
    };
    return;
  }
  const must = (Store.get(col, user.id) || {}).mustChange;
  el.innerHTML = `<div class="page-head"><h1>Mon profil</h1></div>
    ${must ? `<div class="alert warn" style="max-width:520px;margin-bottom:14px">Bienvenue ! Pour sécuriser votre compte, choisissez un nouveau mot de passe avant d'utiliser la plateforme. Le mot de passe actuel est celui reçu par e-mail.</div>` : ""}
    <div class="card" style="max-width:520px"><p><b>${esc(user.prenom)} ${esc(user.nom)}</b><br><span class="muted">Identifiant : ${esc(user.login)}</span></p>
    <form id="pw" class="form-grid"><div class="full"><label>Mot de passe actuel</label><input type="password" name="old" required></div>
    <div><label>Nouveau mot de passe</label><input type="password" name="n1" minlength="8" required></div>
    <div><label>Confirmation</label><input type="password" name="n2" minlength="8" required></div>
    <div class="full"><button class="btn">Changer le mot de passe</button></div></form></div>`;
  $("#pw", el).onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; const u = Store.get(col, user.id);
    if ((await hashPwd(f.old.value)) !== u.passHash) return UI.toast("Mot de passe actuel incorrect.");
    if (f.n1.value !== f.n2.value) return UI.toast("Les deux mots de passe diffèrent.");
    if (f.n1.value === f.old.value) return UI.toast("Choisissez un mot de passe différent de l'actuel.");
    u.passHash = await hashPwd(f.n1.value); const wasMust = u.mustChange; u.mustChange = false; Store.put(col, u); f.reset(); UI.toast("Mot de passe modifié.");
    if (wasMust) setTimeout(() => { location.hash = ""; location.reload(); }, 700);
  };
}
