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
  /* Relais gratuit : script Google Apps Script qui envoie depuis votre Gmail (paramètres réservés aux enseignants et à l'administration) */
  prive() { return (Store.mode === "firebase" ? Store.data.prive : (Store.settings() || {}).prive) || {}; },
  gas() { const g = this.prive().gas || {}; return g.url && g.token ? g : null; },
  emailjsOk() { const c = this.cfg(); return !!(c.serviceId && c.templateId && c.publicKey); },
  configured() { return !!this.gas() || this.emailjsOk(); },
  async savePrive(p) {
    if (Store.mode === "firebase") { await Store.fs.collection("config").doc("prive").set(p); Store.data.prive = p; }
    else { Store.settings().prive = p; Store.saveSettings(); }
  },
  siteUrl() {
    return siteBase();
  },
  template(kind) { const t = (Store.settings().mailTemplates || {})[kind] || {}; return { subject: t.subject || MAIL_DEFAULTS[kind].subject, body: t.body || MAIL_DEFAULTS[kind].body }; },
  vars(item) {
    const a = item.account; const isS = item.kind === "student";
    return {
      prenom: a.prenom || "", nom: a.nom || "", identifiant: Store.mode === "firebase" ? a.email || a.login : a.login, motdepasse: item.password, email: a.email || "",
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
    const g = m.viaEmailjs ? null : this.gas();
    if (g) {
      const c = this.cfg(); let res;
      try { res = await fetch(g.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ token: g.token, to: m.to, subject: m.subject, body: m.body, fromName: c.fromName || "Coordination Master S2I", replyTo: c.replyTo || "" }) }); }
      catch (e) { throw new Error("script Gmail injoignable (adresse du script incorrecte ou déploiement non public)"); }
      let j = {}; try { j = await res.json(); } catch { throw new Error("réponse inattendue du script Gmail (vérifiez le déploiement « Application Web »)"); }
      if (!j.ok) throw new Error(j.error === "token" ? "jeton du script Gmail incorrect" : j.error || "échec de l'envoi Gmail");
      if (typeof j.reste === "number") this.lastQuota = j.reste;
      return j;
    }
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
        ? `Envoi automatique ${Mailer.gas() ? "par votre Gmail (Apps Script, 100 destinataires par jour)" : "via EmailJS"} à <b>${withMail.length}</b> ${kindLbl}.`
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
        paint(i); await new Promise((res) => setTimeout(res, Mailer.gas() ? 300 : 1100)); // limite de débit EmailJS
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
const GAS_CODE = (token) => { const fc = window.FIREBASE_CONFIG || {}; return `// Relais du Master S2I (Google Apps Script, gratuit)
// 1) envoie les e-mails depuis votre compte Gmail ;
// 2) supprime de Firebase Authentication les comptes retirés de la plateforme (réservé à l'administrateur).
const TOKEN = "${token}"; // même jeton que dans la plateforme
const PROJECT_ID = "${fc.projectId || "VOTRE_PROJET"}";
const API_KEY = "${fc.apiKey || "VOTRE_CLE_WEB"}";

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.token !== TOKEN) return out({ ok: false, error: "token" });
    if (d.action === "ping") return out({ ok: true, version: 2 });
    if (d.action === "deleteUsers" || d.action === "listUsers") {
      if (!isAdmin_(d.idToken)) return out({ ok: false, error: "réservé à l'administrateur" });
      if (d.action === "deleteUsers") {
        const ids = (d.uids || []).filter(String).slice(0, 500);
        if (!ids.length) return out({ ok: true, deleted: 0 });
        const r = idt_("/accounts:batchDelete", { localIds: ids, force: true });
        if (r.error) return out({ ok: false, error: r.error.message });
        return out({ ok: true, deleted: ids.length - (r.errors || []).length, errors: r.errors || [] });
      }
      const users = []; let offset = 0;
      while (true) {
        const r = idt_("/accounts:query", { returnUserInfo: true, limit: "500", offset: String(offset) });
        if (r.error) return out({ ok: false, error: r.error.message });
        const page = r.userInfo || [];
        page.forEach(function (u) { users.push({ uid: u.localId, email: u.email || "", created: u.createdAt || "", lastLogin: u.lastLoginAt || "" }); });
        if (page.length < 500) break; offset += 500;
      }
      return out({ ok: true, users: users });
    }
    const to = String(d.to || "").split(",").map(function (s) { return s.trim(); }).filter(String);
    if (!to.length || to.length > 50) return out({ ok: false, error: "destinataires invalides" });
    if (MailApp.getRemainingDailyQuota() < to.length) return out({ ok: false, error: "quota Gmail du jour atteint" });
    const opt = { name: String(d.fromName || "Coordination Master S2I").slice(0, 80) };
    if (d.replyTo) opt.replyTo = String(d.replyTo);
    MailApp.sendEmail(to.join(","), String(d.subject || "").slice(0, 250), String(d.body || ""), opt);
    return out({ ok: true, reste: MailApp.getRemainingDailyQuota() });
  } catch (err) { return out({ ok: false, error: String(err) }); }
}

// Vérifie que la demande vient d'un administrateur connecté à la plateforme
function isAdmin_(idToken) {
  if (!idToken) return false;
  const r = UrlFetchApp.fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + API_KEY,
    { method: "post", contentType: "application/json", payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true });
  const u = (JSON.parse(r.getContentText()).users || [])[0];
  if (!u) return false;
  const doc = UrlFetchApp.fetch("https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents/users/" + u.localId,
    { headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken(), "X-Goog-User-Project": PROJECT_ID }, muteHttpExceptions: true });
  const f = JSON.parse(doc.getContentText()).fields || {};
  return !!(f.role && f.role.stringValue === "admin");
}
function idt_(path, body) {
  const r = UrlFetchApp.fetch("https://identitytoolkit.googleapis.com/v1/projects/" + PROJECT_ID + path,
    { method: "post", contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true,
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken(), "X-Goog-User-Project": PROJECT_ID } });
  return JSON.parse(r.getContentText() || "{}");
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }`; };

const GAS_MANIFEST = `{
  "timeZone": "Africa/Casablanca",
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/script.send_mail",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/cloud-platform"
  ],
  "webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }
}`;

/* ---------- Suppression des comptes Firebase Authentication (via le relais Apps Script) ---------- */
const AuthAdmin = {
  ready() { return Store.mode === "firebase" && !!Mailer.gas() && Store.me && Store.me.role === "admin"; },
  async call(action, payload = {}) {
    const g = Mailer.gas(); if (!g) throw new Error("relais Google Apps Script non configuré");
    const idToken = await Store.auth.currentUser.getIdToken();
    let res; try { res = await fetch(g.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ token: g.token, action, idToken, ...payload }) }); }
    catch (e) { throw new Error("relais injoignable"); }
    let j = {}; try { j = await res.json(); } catch { throw new Error("réponse inattendue du relais"); }
    if (!j.ok) throw new Error(/destinataires/.test(j.error || "") ? "le script du relais est une ancienne version : copiez le nouveau code (Administration › Paramètres) et redéployez-le" : j.error || "échec");
    return j;
  },
  _queue: new Set(), _timer: null, _warned: false,
  /* Appelé à chaque suppression d'un étudiant ou d'un enseignant : regroupe les suppressions (import, suppression en masse) */
  queueDelete(uid) {
    if (!uid || Store.mode !== "firebase") return;
    if (!this.ready()) {
      if (!this._warned) { this._warned = true; setTimeout(() => UI.toast("Compte retiré de la plateforme. Pour le supprimer aussi de Firebase › Authentication, configurez le relais Google (Administration › Paramètres) puis « Nettoyer les comptes Firebase »."), 400); }
      return;
    }
    this._queue.add(uid); clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 800);
  },
  async flush() {
    const uids = [...this._queue]; this._queue.clear(); if (!uids.length) return;
    try { const r = await this.call("deleteUsers", { uids }); UI.toast(`${r.deleted} compte(s) supprimé(s) de Firebase Authentication.${(r.errors || []).length ? ` ${r.errors.length} échec(s).` : ""}`); }
    catch (e) { console.error(e); UI.toast("Suppression dans Firebase Authentication impossible : " + e.message + ". Utilisez ensuite « Nettoyer les comptes Firebase »."); }
  },
  /* Comptes Firebase qui ne correspondent plus à aucun étudiant, enseignant ou administrateur */
  async orphans() {
    const r = await this.call("listUsers");
    const keep = new Set([...Store.all("students"), ...Store.all("profs")].map((x) => x.uid).filter(Boolean));
    keep.add(Store.me.uid);
    const admins = await Store.fs.collection("users").where("role", "==", "admin").get().then((s) => s.docs.map((d) => d.id)).catch(() => []);
    admins.forEach((u) => keep.add(u));
    return { all: r.users, orphans: r.users.filter((u) => !keep.has(u.uid)) };
  }
};
function authCleanupDialog() {
  if (!AuthAdmin.ready()) return UI.toast(Store.mode !== "firebase" ? "Disponible uniquement avec Firebase." : "Configurez d'abord le relais Google Apps Script (ci-dessus) avec le nouveau code.");
  const md = UI.modal({ title: "Nettoyer les comptes Firebase Authentication", wide: true, submitLabel: "Supprimer les comptes cochés",
    body: `<p class="muted" id="ac-msg">Recherche des comptes Firebase sans étudiant ni enseignant correspondant…</p><div id="ac-list"></div>`,
    onSubmit: async (f) => {
      const uids = $$('input[name="ac"]:checked', f).map((x) => x.value); if (!uids.length) { UI.toast("Aucun compte coché."); return false; }
      if (!UI.confirm(`Supprimer définitivement ${uids.length} compte(s) de Firebase Authentication ?`)) return false;
      try { const r = await AuthAdmin.call("deleteUsers", { uids }); UI.toast(`${r.deleted} compte(s) supprimé(s) de Firebase Authentication.`); Journal.log("Nettoyage Firebase Authentication", `${r.deleted} compte(s) supprimé(s)`, { objet: "Comptes" }); }
      catch (e) { UI.toast("Échec : " + e.message); return false; }
    } });
  AuthAdmin.orphans().then(({ all, orphans }) => {
    $("#ac-msg", md).textContent = orphans.length ? `${orphans.length} compte(s) Firebase sur ${all.length} ne correspondent plus à aucun étudiant ni enseignant de la plateforme :` : `Aucun compte orphelin : les ${all.length} comptes Firebase correspondent tous à la plateforme.`;
    if (orphans.length) $("#ac-list", md).innerHTML = `<div class="toolbar" style="margin-bottom:6px"><label style="font-weight:400"><input type="checkbox" id="ac-all" checked style="width:auto"> Tout cocher</label></div>
      <div class="table-scroll" style="max-height:340px;overflow-y:auto"><table class="data"><thead><tr><th></th><th>E-mail</th><th>Créé le</th><th>Dernière connexion</th></tr></thead><tbody>
      ${orphans.map((u) => `<tr><td><input type="checkbox" name="ac" value="${esc(u.uid)}" checked style="width:auto"></td><td>${esc(u.email || u.uid)}</td><td class="muted">${u.created ? fmtDate(new Date(+u.created).toISOString().slice(0, 10)) : ""}</td><td class="muted">${u.lastLogin ? fmtDate(new Date(+u.lastLogin).toISOString().slice(0, 10)) : "jamais"}</td></tr>`).join("")}</tbody></table></div>`;
    if ($("#ac-all", md)) $("#ac-all", md).onchange = (e) => $$('input[name="ac"]', md).forEach((x) => (x.checked = e.target.checked));
  }).catch((e) => { $("#ac-msg", md).textContent = "Échec : " + e.message; });
}

function GmailRelayCard() {
  const g = Mailer.prive().gas || {}; const token = g.token || randomPassword() + randomPassword();
  return `<div class="card" style="grid-column:1/-1"><h3>Envoi gratuit par votre Gmail (Google Apps Script)</h3>
    <p class="muted">Gratuit et sans abonnement : les e-mails (identifiants, notifications, listes de diffusion) partent de votre compte Google.
      Limite : 100 destinataires par jour avec un compte gmail.com, 1 500 avec un compte Google Workspace. Prioritaire sur EmailJS s'il est configuré.</p>
    <ol class="muted" style="margin:0 0 10px 18px;line-height:1.7"><li>Ouvrez <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com › Nouveau projet</a> avec le compte Google d'envoi.</li>
      <li>Remplacez tout le code par celui ci-dessous (bouton « Copier le code »), puis enregistrez.</li>
      <li>Pour la suppression des comptes Firebase : ⚙ « Paramètres du projet » › cochez « Afficher le fichier manifeste appsscript.json », puis remplacez le contenu de <b>appsscript.json</b> par le manifeste (bouton « Copier le manifeste »). Utilisez le compte Google <b>propriétaire du projet Firebase</b>.</li>
      <li>« Déployer » › « Nouveau déploiement » › type <b>Application Web</b> ; Exécuter en tant que : <b>Moi</b> ; Qui a accès : <b>Tout le monde</b>. Autorisez les accès demandés (Gmail, services externes, Google Cloud). Après une mise à jour du code : « Gérer les déploiements » › modifier › <b>Nouvelle version</b>.</li>
      <li>Copiez l'« URL de l'application Web » (se termine par /exec) dans le champ ci-dessous, enregistrez, puis testez.</li></ol>
    <textarea id="gas-code" readonly style="font-family:monospace;font-size:12px;min-height:180px">${esc(GAS_CODE(token))}</textarea>
    <textarea id="gas-manifest" readonly style="font-family:monospace;font-size:12px;min-height:110px;margin-top:6px">${esc(GAS_MANIFEST)}</textarea>
    <form id="gascfg" class="form-grid" style="margin-top:10px">
      <div class="full"><label>URL de l'application Web</label><input name="url" type="url" value="${esc(g.url)}" placeholder="https://script.google.com/macros/s/…/exec"></div>
      <input type="hidden" name="token" value="${esc(token)}">
      <div class="full toolbar"><button type="button" class="btn outline" id="gas-copy">Copier le code</button><button type="button" class="btn outline" id="gas-copym">Copier le manifeste</button><button class="btn">Enregistrer</button><button type="button" class="btn outline" id="gas-test">Envoyer un e-mail de test</button>
        ${g.url ? `<button type="button" class="btn danger sm" id="gas-off">Désactiver</button>` : ""}<span class="muted">${g.url ? "✅ Relais Gmail configuré" : "Non configuré"}</span></div></form>
    ${Store.mode === "firebase" ? `<div class="toolbar" style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px"><b>Comptes Firebase Authentication</b>
      <button type="button" class="btn outline" id="gas-clean">🧹 Nettoyer les comptes Firebase</button><span class="muted">Supprime les comptes des étudiants et enseignants retirés de la plateforme. Les suppressions suivantes sont faites automatiquement.</span></div>` : ""}
    <p class="hint">Le jeton dans le code protège le script : seule la plateforme (enseignants et administration) le connaît. Si vous régénérez le code, redéployez le script.</p></div>`;
}
function bindGmailRelay(el) {
  const f = $("#gascfg", el); if (!f) return;
  $("#gas-copym", el).onclick = async () => { try { await navigator.clipboard.writeText(GAS_MANIFEST); UI.toast("Manifeste copié."); } catch { $("#gas-manifest", el).select(); document.execCommand("copy"); UI.toast("Manifeste copié."); } };
  if ($("#gas-clean", el)) $("#gas-clean", el).onclick = authCleanupDialog;
  $("#gas-copy", el).onclick = async () => { try { await navigator.clipboard.writeText($("#gas-code", el).value); UI.toast("Code copié."); } catch { $("#gas-code", el).select(); document.execCommand("copy"); UI.toast("Code copié."); } };
  f.onsubmit = async (e) => { e.preventDefault(); const url = f.url.value.trim();
    if (url && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) return UI.toast("L'adresse doit être l'URL de l'application Web (https://script.google.com/macros/s/…/exec).");
    try { await Mailer.savePrive({ ...Mailer.prive(), gas: url ? { url, token: f.token.value } : null }); UI.toast("Relais Gmail enregistré."); } catch (err) { UI.toast("Échec : " + err.message); } };
  $("#gas-test", el).onclick = async () => {
    if (!Mailer.gas()) return UI.toast("Enregistrez d'abord l'URL du script.");
    const to = prompt("Adresse de test :", Mailer.cfg().replyTo || ""); if (!to) return;
    try { await Mailer.sendOne({ to, toName: "Test", subject: "Master S2I – e-mail de test (Gmail)", body: "L'envoi des e-mails depuis la plateforme du Master S2I par Gmail fonctionne." });
      UI.toast(`E-mail de test envoyé à ${to}.${typeof Mailer.lastQuota === "number" ? ` Quota restant aujourd'hui : ${Mailer.lastQuota}.` : ""}`); }
    catch (err) { UI.toast("Échec : " + err.message); }
  };
  if ($("#gas-off", el)) $("#gas-off", el).onclick = async () => { if (!UI.confirm("Désactiver le relais Gmail ?")) return; await Mailer.savePrive({ ...Mailer.prive(), gas: null }); UI.toast("Relais Gmail désactivé."); };
}

function MailSettingsCards() {
  const c = Mailer.cfg(); const s = Store.settings();
  return `${GmailRelayCard()}<div class="card" style="grid-column:1/-1"><h3>Envoi des e-mails (création de compte)</h3>
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
        <span class="muted" id="mailstate">${Mailer.emailjsOk() ? "✅ Envoi automatique configuré" : "Envoi automatique non configuré"}</span></div></form></div>
  <div class="card" style="grid-column:1/-1"><h3>Modèles des e-mails</h3>
    <p class="muted">Champs disponibles : <code>{prenom}</code> <code>{nom}</code> <code>{identifiant}</code> <code>{motdepasse}</code> <code>{lien}</code> <code>{site}</code> <code>{section}</code> <code>{promotion}</code> <code>{formation}</code> <code>{modules}</code></p>
    <form id="mailtpl" class="form-grid">
      ${["student", "prof"].map((k) => { const t = Mailer.template(k); return `<div><label>${k === "student" ? "Étudiant" : "Enseignant"} — objet</label><input name="${k}_subject" value="${esc(t.subject)}">
        <label style="margin-top:8px">${k === "student" ? "Étudiant" : "Enseignant"} — message</label><textarea name="${k}_body" style="min-height:300px">${esc(t.body)}</textarea></div>`; }).join("")}
      <div class="full toolbar"><button class="btn">Enregistrer les modèles</button><button type="button" class="btn outline" id="tplreset">Revenir aux modèles par défaut</button></div></form></div>`;
}
function bindMailSettings(el) {
  bindGmailRelay(el);
  $("#mailcfg", el).onsubmit = (e) => {
    e.preventDefault(); const f = e.target; const st = Store.settings();
    st.email = { serviceId: f.serviceId.value.trim(), templateId: f.templateId.value.trim(), publicKey: f.publicKey.value.trim(), fromName: f.fromName.value.trim(), replyTo: f.replyTo.value.trim() };
    st.siteUrl = f.siteUrl.value.trim(); Store.saveSettings();
    $("#mailstate", el).textContent = Mailer.emailjsOk() ? "✅ Envoi automatique configuré" : "Envoi automatique non configuré"; UI.toast("Paramètres d'envoi enregistrés.");
  };
  $("#mailtest", el).onclick = async () => {
    if (!Mailer.emailjsOk()) return UI.toast("Renseignez et enregistrez d'abord Service ID, Template ID et Public Key.");
    const to = prompt("Adresse de test :", Mailer.cfg().replyTo || ""); if (!to) return;
    try { await Mailer.sendOne({ viaEmailjs: true, to, toName: "Test", subject: "Master S2I – e-mail de test", body: "L'envoi des e-mails depuis la plateforme du Master S2I fonctionne." }); UI.toast("E-mail de test envoyé à " + to + "."); }
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
