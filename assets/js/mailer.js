/* ==========================================================================
   E-mails de création de compte (étudiants et enseignants)
   - Envoi automatique via EmailJS si configuré (Administration > Paramètres)
   - Sinon : e-mail prérempli dans la messagerie (mailto) ou export Excel pour publipostage
   ========================================================================== */
const MAIL_DEFAULTS = {
  student: {
    subject: "Master S2I – Création de votre compte sur la plateforme",
    body: `Bonjour {prenom} {nom},

Votre compte étudiant sur la plateforme du Master Systèmes Industriels Intelligents (S2I) de l'ENSIAS a été créé.

Adresse de connexion : {lien}
Identifiant : {identifiant}
Mot de passe provisoire : {motdepasse}
Section : {section} – Promotion {promotion}

À votre première connexion, vous devrez choisir un nouveau mot de passe.

Votre Espace Étudiant vous permet de :
• consulter les cours, TD, TP et devoirs publiés par vos enseignants ;
• suivre vos absences, module par module ;
• consulter votre emploi du temps de la semaine (séances en présentiel ou à distance, avec le lien pour rejoindre) ;
• recevoir les notifications et le planning de la coordination ;
• échanger avec vos enseignants par la messagerie de chaque module ;
• consulter le calendrier des examens et des soutenances.

Cordialement,
La coordination du Master S2I – ENSIAS, Université Mohammed V de Rabat`
  },
  prof: {
    subject: "Master S2I – Création de votre compte enseignant",
    body: `Bonjour Pr. {prenom} {nom},

Votre compte enseignant sur la plateforme du Master Systèmes Industriels Intelligents (S2I) de l'ENSIAS a été créé.

Adresse de connexion : {lien}
Identifiant : {identifiant}
Mot de passe provisoire : {motdepasse}
Module(s) : {modules}

À votre première connexion, vous devrez choisir un nouveau mot de passe.

Votre Espace Professeur vous permet de :
• saisir les absences de vos séances (formations TN et TAM, en présentiel ou à distance) et suivre le taux d'absence par étudiant ;
• gérer vos contenus pédagogiques (cours, TD, TP, devoirs) : ajouter, modifier, supprimer, publier ou désactiver ;
• notifier vos étudiants par la messagerie de chaque module (notification automatique à chaque publication) ;
• consulter votre emploi du temps de la semaine et le calendrier des examens et des soutenances.

Cordialement,
La coordination du Master S2I – ENSIAS, Université Mohammed V de Rabat`
  }
};

const Mailer = {
  cfg() { return Store.settings().email || {}; },
  configured() { const c = this.cfg(); return !!(c.serviceId && c.templateId && c.publicKey); },
  siteUrl() {
    return siteBase();
  },
  template(kind) { const t = (Store.settings().mailTemplates || {})[kind] || {}; return { subject: t.subject || MAIL_DEFAULTS[kind].subject, body: t.body || MAIL_DEFAULTS[kind].body }; },
  vars(item) {
    const a = item.account; const isS = item.kind === "student";
    return {
      prenom: a.prenom || "", nom: a.nom || "", identifiant: a.login, motdepasse: item.password, email: a.email || "",
      lien: `${this.siteUrl()}connexion.html?role=${isS ? "etudiant" : "prof"}`, site: this.siteUrl(),
      section: isS ? sectionOf(a) : "", promotion: isS ? a.promotion || "—" : "", formation: isS ? S2I.formations[a.formation] : "",
      modules: !isS ? (a.modules || []).map((c) => UI.moduleLabel(c)).join(", ") || "—" : ""
    };
  },
  render(item) {
    const t = this.template(item.kind); const v = this.vars(item);
    const fill = (s) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
    return { to: item.account.email || "", toName: `${item.account.prenom || ""} ${item.account.nom || ""}`.trim(), subject: fill(t.subject), body: fill(t.body) };
  },
  mailto(m) { return `mailto:${encodeURIComponent(m.to)}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.body)}`; },
  async sendOne(m) {
    if (!window.emailjs) await loadScript("assets/js/vendor/emailjs.min.js");
    const c = this.cfg();
    return emailjs.send(c.serviceId, c.templateId, {
      to_email: m.to, to_name: m.toName, subject: m.subject, message: m.body,
      from_name: c.fromName || "Coordination Master S2I", reply_to: c.replyTo || ""
    }, { publicKey: c.publicKey });
  },
  markSent(item) {
    const col = item.kind === "student" ? "students" : "profs"; const a = Store.get(col, item.account.id);
    if (a) { a.credsSentAt = new Date().toISOString(); Store.put(col, a); item.account = a; }
  }
};

/* Donne un nouveau mot de passe provisoire au compte (obligation de le changer à la connexion) */
async function resetCredentials(kind, account) {
  const col = kind === "student" ? "students" : "profs"; const a = { ...Store.get(col, account.id) };
  const password = randomPassword(); a.passHash = await hashPwd(password); a.mustChange = true; Store.put(col, a);
  return { kind, account: a, password };
}

/* items : [{ kind: "student" | "prof", account, password }] */
function sendCredentialsDialog(items, { title, onClose } = {}) {
  if (!items.length) return;
  const auto = Mailer.configured();
  const rows = items.map((it) => ({ it, m: Mailer.render(it), status: it.account.email ? "pending" : "nomail" }));
  const withMail = rows.filter((r) => r.status !== "nomail");
  const kindLbl = items.every((i) => i.kind === "prof") ? "enseignant(s)" : items.every((i) => i.kind === "student") ? "étudiant(s)" : "compte(s)";
  const md = UI.modal({
    title: title || "Envoyer les identifiants par e-mail", wide: true, submitLabel: auto ? `Envoyer ${withMail.length} e-mail(s)` : "Terminé",
    body: `<div class="alert ${auto ? "info" : "warn"}">${auto
        ? `Envoi automatique via EmailJS à <b>${withMail.length}</b> ${kindLbl}.`
        : `L'envoi automatique n'est pas configuré (Administration › Paramètres › Envoi des e-mails). Cliquez sur « Ouvrir l'e-mail » pour chaque destinataire : le message s'ouvre prérempli dans votre messagerie. Pour une liste longue, téléchargez le fichier de publipostage.`}
        ${rows.length - withMail.length ? `<br><b>${rows.length - withMail.length}</b> compte(s) sans adresse e-mail : renseignez-la dans la liste, puis renvoyez les identifiants.` : ""}</div>
      <div class="toolbar" style="margin:12px 0"><button type="button" class="btn outline sm" id="ml-xls">⬇ Fichier de publipostage (Excel)</button>
        <button type="button" class="btn outline sm" id="ml-prev">Aperçu du message</button></div>
      <div class="table-scroll" style="max-height:340px;overflow-y:auto"><table class="data"><thead><tr><th>Destinataire</th><th>E-mail</th><th>Identifiant</th><th>État</th><th></th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td>${esc(r.m.toName)}</td><td>${esc(r.m.to || "—")}</td><td>${esc(r.it.account.login)}</td><td data-st="${i}"></td>
        <td class="actions">${r.m.to ? `<a class="btn outline sm" data-open="${i}" href="${esc(Mailer.mailto(r.m))}">Ouvrir l'e-mail</a>` : ""}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted">Le mot de passe provisoire n'est visible que maintenant : il est stocké chiffré sur la plateforme. Le destinataire devra le changer à sa première connexion.</p>`,
    onSubmit: async () => {
      if (!auto) { if (onClose) onClose(); return; }
      const btn = $(".modal-f .btn:not(.outline)", md); btn.disabled = true;
      let ok = 0, ko = 0;
      for (const [i, r] of rows.entries()) {
        if (r.status !== "pending") continue;
        r.status = "sending"; paint(i);
        try { await Mailer.sendOne(r.m); r.status = "sent"; Mailer.markSent(r.it); ok++; }
        catch (e) { r.status = "error"; r.err = (e && (e.text || e.message)) || "erreur"; ko++; }
        paint(i); await new Promise((res) => setTimeout(res, 1100)); // limite de débit EmailJS
      }
      UI.toast(`${ok} e-mail(s) envoyé(s)${ko ? `, ${ko} échec(s)` : ""}.`);
      btn.textContent = ko ? `Réessayer (${ko})` : "Terminé"; btn.disabled = false;
      rows.forEach((r) => { if (r.status === "error") r.status = "pending"; });
      if (!ko) { $(".modal-f .btn:not(.outline)", md).onclick = (e) => { e.preventDefault(); md.remove(); if (onClose) onClose(); }; }
      return false;
    }
  });
  const paint = (i) => {
    const r = rows[i]; const cell = $(`[data-st="${i}"]`, md);
    cell.innerHTML = { pending: '<span class="pill draft">À envoyer</span>', nomail: '<span class="pill off">Pas d\'e-mail</span>', sending: '<span class="pill t-cours">Envoi…</span>',
      sent: '<span class="pill pub">Envoyé</span>', opened: '<span class="pill pub">Ouvert dans la messagerie</span>', error: `<span class="pill off" title="${esc(r.err || "")}">Échec</span>` }[r.status];
  };
  rows.forEach((_, i) => paint(i));
  $$("[data-open]", md).forEach((a) => a.addEventListener("click", () => { const i = +a.dataset.open; rows[i].status = "opened"; Mailer.markSent(rows[i].it); paint(i); }));
  $("#ml-xls", md).onclick = () => Excel.download(`emails_identifiants_${todayISO()}.xlsx`, [{ name: "Publipostage", widths: [30, 24, 16, 16, 50, 100],
    rows: [["E-mail", "Nom", "Identifiant", "Mot de passe", "Objet", "Message"], ...rows.map((r) => [r.m.to, r.m.toName, r.it.account.login, r.it.password, r.m.subject, r.m.body])] }]);
  $("#ml-prev", md).onclick = () => { const r = withMail[0] || rows[0]; UI.modal({ title: r.m.subject, body: `<p class="muted">À : ${esc(r.m.to || "—")}</p><div style="white-space:pre-wrap;border:1px solid var(--line);padding:14px;border-radius:4px">${esc(r.m.body)}</div>` }); };
}

/* ---------- Paramètres (Administration) ---------- */
function MailSettingsCards() {
  const c = Mailer.cfg(); const s = Store.settings();
  return `<div class="card" style="grid-column:1/-1"><h3>Envoi des e-mails (création de compte)</h3>
    <p class="muted">Pour un envoi automatique, créez un compte gratuit sur <a href="https://www.emailjs.com" target="_blank" rel="noopener">emailjs.com</a> (200 e-mails/mois) :
      ajoutez un <i>Email Service</i> (votre Gmail ou Outlook), puis un <i>Email Template</i> dont les champs sont
      <b>To Email</b> = <code>{{to_email}}</code>, <b>Subject</b> = <code>{{subject}}</code>, <b>Content</b> = <code>{{message}}</code>,
      <b>From Name</b> = <code>{{from_name}}</code>, <b>Reply To</b> = <code>{{reply_to}}</code>. Recopiez ensuite les trois identifiants ci-dessous.
      Sans configuration, les e-mails s'ouvrent préremplis dans votre messagerie.</p>
    <form id="mailcfg" class="form-grid">
      <div><label>Service ID</label><input name="serviceId" value="${esc(c.serviceId)}" placeholder="service_xxxxxxx"></div>
      <div><label>Template ID</label><input name="templateId" value="${esc(c.templateId)}" placeholder="template_xxxxxxx"></div>
      <div><label>Public Key</label><input name="publicKey" value="${esc(c.publicKey)}" placeholder="xxxxxxxxxxxxxxx"></div>
      <div><label>Nom de l'expéditeur</label><input name="fromName" value="${esc(c.fromName || "Coordination Master S2I")}"></div>
      <div><label>Adresse de réponse</label><input name="replyTo" type="email" value="${esc(c.replyTo)}" placeholder="coordination@…"></div>
      <div><label>Adresse du site (dans les e-mails)</label><input name="siteUrl" type="url" value="${esc(Mailer.siteUrl())}"></div>
      <div class="full toolbar"><button class="btn">Enregistrer</button><button type="button" class="btn outline" id="mailtest">Envoyer un e-mail de test</button>
        <span class="muted" id="mailstate">${Mailer.configured() ? "✅ Envoi automatique configuré" : "Envoi automatique non configuré"}</span></div></form></div>
  <div class="card" style="grid-column:1/-1"><h3>Modèles des e-mails</h3>
    <p class="muted">Champs disponibles : <code>{prenom}</code> <code>{nom}</code> <code>{identifiant}</code> <code>{motdepasse}</code> <code>{lien}</code> <code>{site}</code> <code>{section}</code> <code>{promotion}</code> <code>{formation}</code> <code>{modules}</code></p>
    <form id="mailtpl" class="form-grid">
      ${["student", "prof"].map((k) => { const t = Mailer.template(k); return `<div><label>${k === "student" ? "Étudiant" : "Enseignant"} — objet</label><input name="${k}_subject" value="${esc(t.subject)}">
        <label style="margin-top:8px">${k === "student" ? "Étudiant" : "Enseignant"} — message</label><textarea name="${k}_body" style="min-height:300px">${esc(t.body)}</textarea></div>`; }).join("")}
      <div class="full toolbar"><button class="btn">Enregistrer les modèles</button><button type="button" class="btn outline" id="tplreset">Revenir aux modèles par défaut</button></div></form></div>`;
}
function bindMailSettings(el) {
  $("#mailcfg", el).onsubmit = (e) => {
    e.preventDefault(); const f = e.target; const st = Store.settings();
    st.email = { serviceId: f.serviceId.value.trim(), templateId: f.templateId.value.trim(), publicKey: f.publicKey.value.trim(), fromName: f.fromName.value.trim(), replyTo: f.replyTo.value.trim() };
    st.siteUrl = f.siteUrl.value.trim(); Store.saveSettings();
    $("#mailstate", el).textContent = Mailer.configured() ? "✅ Envoi automatique configuré" : "Envoi automatique non configuré"; UI.toast("Paramètres d'envoi enregistrés.");
  };
  $("#mailtest", el).onclick = async () => {
    if (!Mailer.configured()) return UI.toast("Renseignez et enregistrez d'abord Service ID, Template ID et Public Key.");
    const to = prompt("Adresse de test :", Mailer.cfg().replyTo || ""); if (!to) return;
    try { await Mailer.sendOne({ to, toName: "Test", subject: "Master S2I – e-mail de test", body: "L'envoi des e-mails depuis la plateforme du Master S2I fonctionne." }); UI.toast("E-mail de test envoyé à " + to + "."); }
    catch (err) { UI.toast("Échec : " + ((err && (err.text || err.message)) || "erreur")); }
  };
  $("#mailtpl", el).onsubmit = (e) => {
    e.preventDefault(); const f = e.target;
    Store.settings().mailTemplates = { student: { subject: f.student_subject.value, body: f.student_body.value }, prof: { subject: f.prof_subject.value, body: f.prof_body.value } };
    Store.saveSettings(); UI.toast("Modèles enregistrés.");
  };
  $("#tplreset", el).onclick = () => { if (UI.confirm("Revenir aux modèles par défaut ?")) { delete Store.settings().mailTemplates; Store.saveSettings(); location.reload(); } };
}

/* ==========================================================================
   Listes de diffusion par section (une adresse par formation et par année)
   Utilisées pour : contenu publié, nouvel emploi du temps, séance à distance, quiz publié.
   Envoi automatique via EmailJS si configuré ; sinon e-mail prérempli (mailto).
   ========================================================================== */
const DIFFUSION_DEFAULTS = { "TN-1A": "S2I_TN_1A_2627@um5.ac.ma", "TAM-1A": "S2I_TAM_1A_2627@um5.ac.ma", "TN-2A": "", "TAM-2A": "" };
const Diffusion = {
  lists() { const s = (Store.settings() || {}).diffusion || {}; const o = {}; S2I.sections.forEach((k) => (o[k] = (k in s ? s[k] : DIFFUSION_DEFAULTS[k] || "").trim())); return o; },
  enabled() { return (Store.settings() || {}).diffusionOff !== true; },
  targets(sections) { const l = this.lists(); return [...new Set((sections || []).map((s) => l[s]).filter(Boolean))]; },
  /* { sections, subject, body } */
  async send({ sections, subject, body }) {
    if (!this.enabled()) return;
    const to = this.targets(sections); if (!to.length) return;
    const full = `${body}\n\n—\nPlateforme du Master S2I : ${siteBase()}\nCe message est envoyé automatiquement par la plateforme.`;
    const subj = subject.startsWith("[Master S2I]") ? subject : `[Master S2I] ${subject}`;
    if (typeof Mailer !== "undefined" && Mailer.configured()) {
      const ko = [];
      for (const addr of to) {
        try { await Mailer.sendOne({ to: addr, toName: "Étudiants du Master S2I", subject: subj, body: full }); }
        catch (e) { ko.push(addr); console.error(e); }
      }
      const ok = to.filter((a) => !ko.includes(a));
      if (ok.length) Journal.log("E-mail de diffusion", `${subj} → ${ok.join(", ")}`, { objet: "Liste de diffusion" });
      UI.toast(ko.length ? `E-mail non envoyé à : ${ko.join(", ")}${ok.length ? ` (envoyé à ${ok.join(", ")})` : ""}.` : `📧 E-mail envoyé à ${ok.join(" et ")}.`);
      return;
    }
    /* Sans envoi automatique : message prérempli à ouvrir dans la messagerie */
    const href = `mailto:${to.join(",")}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(full)}`;
    const md = UI.modal({
      title: "Prévenir les étudiants par e-mail",
      body: `<p>Listes de diffusion : <b>${to.map(esc).join("</b>, <b>")}</b></p>
        <p class="muted">L'envoi automatique n'est pas configuré (Administration › Paramètres › Envoi des e-mails). Cliquez sur « Ouvrir l'e-mail » : le message s'ouvre prérempli dans votre messagerie.</p>
        <div style="white-space:pre-wrap;border:1px solid var(--line);border-radius:4px;padding:10px;max-height:260px;overflow:auto;font-size:13.5px"><b>${esc(subj)}</b>\n\n${esc(full)}</div>
        <p style="margin-top:12px"><a class="btn" id="dif-open" href="${esc(href)}">📧 Ouvrir l'e-mail</a></p>`
    });
    $("#dif-open", md).addEventListener("click", () => { Journal.log("E-mail de diffusion (messagerie)", `${subj} → ${to.join(", ")}`, { objet: "Liste de diffusion" }); setTimeout(() => md.remove(), 300); });
  }
};

function DiffusionSettingsCard() {
  const l = Diffusion.lists();
  return `<div class="card" style="grid-column:1/-1"><h3>Listes de diffusion des étudiants</h3>
    <p class="muted">Pour chaque section, l'adresse de la liste de diffusion de la promotion. Elle est utilisée pour prévenir les étudiants par e-mail quand un contenu ou un quiz est publié, quand une séance à distance est créée et quand l'emploi du temps est annoncé.
      Laissez vide pour ne rien envoyer à une section. La liste doit accepter les messages venant de l'adresse d'envoi (EmailJS ou votre messagerie).</p>
    <form id="difcfg" class="form-grid">
      ${S2I.sections.map((s) => `<div><label>${s} — ${esc(S2I.formations[s.split("-")[0]] || "")}, ${s.endsWith("1A") ? "1ère" : "2ème"} année</label><input name="d_${s}" type="email" value="${esc(l[s])}" placeholder="ex. S2I_${s.replace("-", "_")}_2627@um5.ac.ma"></div>`).join("")}
      <div class="full checks"><label><input type="checkbox" name="on" ${Diffusion.enabled() ? "checked" : ""}> Prévenir les listes de diffusion à chaque publication (contenu, quiz, séance à distance)</label></div>
      <div class="full toolbar"><button class="btn">Enregistrer</button></div></form></div>`;
}
function bindDiffusionSettings(el) {
  const f = $("#difcfg", el); if (!f) return;
  f.onsubmit = (e) => {
    e.preventDefault(); const st = Store.settings();
    st.diffusion = Object.fromEntries(S2I.sections.map((s) => [s, f["d_" + s].value.trim()])); st.diffusionOff = !f.on.checked;
    Store.saveSettings(); UI.toast("Listes de diffusion enregistrées.");
  };
}
