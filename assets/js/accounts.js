/* ==========================================================================
   Comptes Firebase (mode Firebase uniquement)
   L'administrateur crée le compte de connexion d'un étudiant ou d'un enseignant ;
   Firebase envoie alors à la personne un e-mail pour définir son mot de passe
   (modèle « Réinitialisation du mot de passe » de la console Firebase).
   ========================================================================== */
const Accounts = {
  _creator: null,
  /* Deuxième instance Firebase : crée les comptes sans déconnecter l'administrateur */
  creator() {
    if (!this._creator) {
      const app = firebase.apps.find((a) => a.name === "creator") || firebase.initializeApp(window.FIREBASE_CONFIG, "creator");
      this._creator = app.auth();
      if (this._creator.setPersistence) this._creator.setPersistence(firebase.auth.Auth.Persistence.NONE);
    }
    return this._creator;
  },
  loginUrl(kind) {
    return siteBase() + "connexion.html?role=" + (kind === "student" ? "etudiant" : "prof");
  },
  /* Crée le compte s'il n'existe pas, relie le profil (rôle) et :
     - mode "mail"       : Firebase envoie l'e-mail « définir votre mot de passe » (quota : 150 par jour sur l'offre gratuite) ;
                           si le quota est atteint pour un compte qui vient d'être créé, on garde son mot de passe provisoire ;
     - mode "provisoire" : le compte reçoit un mot de passe provisoire (sans quota), à transmettre à la personne
                           (EmailJS, Gmail via Apps Script, e-mail prérempli ou fichier Excel) ; changement obligatoire à la 1re connexion. */
  async activate(kind, account, mode = "mail") {
    const col = kind === "student" ? "students" : "profs";
    let acc = { ...(Store.get(col, account.id) || account) };
    const email = (acc.email || "").trim().toLowerCase();
    if (!email) throw Object.assign(new Error("Adresse e-mail manquante"), { code: "s2i/no-email" });
    let created = false; let tmp = null;
    if (!acc.uid) {
      tmp = provisionalPassword();
      const cred = await this.creator().createUserWithEmailAndPassword(email, tmp);
      acc.uid = cred.user.uid; created = true;
      await this.creator().signOut();
    }
    acc.email = email; delete acc.passHash;
    if (tmp && mode === "provisoire") {
      acc.mustChange = true; await Store.putAwait(col, acc);
      return { acc, created, password: tmp };
    }
    acc.mustChange = false;
    await Store.putAwait(col, acc); // écrit la fiche et le profil users/{uid}
    try { await Store.auth.sendPasswordResetEmail(email, { url: this.loginUrl(kind) }); }
    catch (e) {
      if (e.code === "auth/quota-exceeded" && tmp) { acc.mustChange = true; await Store.putAwait(col, acc); return { acc, created, password: tmp, fallback: true }; }
      throw e;
    }
    acc.credsSentAt = new Date().toISOString();
    await Store.putAwait(col, acc);
    return { acc, created };
  },
  errorText(e) {
    return {
      "s2i/no-email": "Pas d'adresse e-mail",
      "auth/email-already-in-use": "Un compte existe déjà pour cet e-mail (à supprimer dans la console Firebase › Authentication, puis réessayer)",
      "auth/invalid-email": "Adresse e-mail invalide",
      "auth/too-many-requests": "Trop de demandes : réessayez plus tard",
      "auth/quota-exceeded": "Quota quotidien d'e-mails Firebase atteint : compte prêt, e-mail à renvoyer demain",
      "permission-denied": "Action non autorisée (règles Firestore)"
    }[e.code] || (e.message || "Erreur");
  }
};

/* Mot de passe provisoire lisible (sans caractères ambigus), accepté par Firebase */
function provisionalPassword() { const r = randomPassword(); return `S2i-${r.slice(0, 4)}-${r.slice(4, 8)}`; }

/* items : [{ kind: "student" | "prof", account }] — crée les accès et transmet les identifiants */
function activateAccountsDialog(items, { title, onClose } = {}) {
  if (!items.length) return;
  const rows = items.map((it) => ({ it, status: "pending" }));
  const fresh = items.filter((it) => !it.account.uid).length;
  const md = UI.modal({
    title: title || "Accès à la plateforme", wide: true, submitLabel: "Lancer",
    body: `<div class="form-grid"><div class="full checks" style="display:grid;gap:8px">
        <label><input type="radio" name="mode" value="mail" checked> <span><b>E-mail Firebase</b> « Définissez votre mot de passe » — <span class="muted">150 e-mails par jour au maximum (offre gratuite). Si le quota est atteint, les nouveaux comptes passent automatiquement au mot de passe provisoire.</span></span></label>
        <label><input type="radio" name="mode" value="provisoire"> <span><b>Mot de passe provisoire</b> — <span class="muted">sans quota Firebase. Les identifiants sont ensuite envoyés par vos propres e-mails (Gmail, EmailJS, messagerie) ou exportés en Excel ; la personne choisit son mot de passe à la première connexion.</span></span></label>
      </div>${fresh < items.length ? `<div class="full hint">${items.length - fresh} compte(s) existent déjà : pour eux, seul l'e-mail Firebase permet de redéfinir le mot de passe.</div>` : ""}</div>
      <div class="table-scroll" style="max-height:340px;overflow-y:auto;margin-top:12px"><table class="data"><thead><tr><th>Nom</th><th>E-mail</th><th>État</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td>${esc(`${r.it.account.prenom || ""} ${r.it.account.nom || ""}`)}</td><td>${esc(r.it.account.email || "—")}</td><td data-st="${i}"></td></tr>`).join("")}</tbody></table></div>
      <p class="muted" id="act-sum"></p>`,
    onSubmit: (f) => { if (running || done) { if (done) { md.remove(); if (onClose) onClose(); } return false; } run(f.mode.value); return false; }
  });
  let running = false, done = false;
  const paint = (i) => {
    const r = rows[i];
    $(`[data-st="${i}"]`, md).innerHTML = {
      pending: '<span class="pill draft">En attente</span>', running: '<span class="pill t-cours">En cours…</span>',
      created: '<span class="pill pub">Compte créé, e-mail Firebase envoyé</span>', sent: '<span class="pill pub">E-mail Firebase envoyé</span>',
      provisoire: '<span class="pill pub">Compte créé, mot de passe provisoire</span>',
      error: `<span class="pill off">${esc(r.err)}</span>`, later: '<span class="pill draft">Reporté (quota Firebase atteint) : à relancer demain</span>'
    }[r.status];
  };
  rows.forEach((_, i) => paint(i));
  const btn = () => $(".modal-f .btn:not(.outline)", md);
  const run = async (mode) => {
    running = true; btn().disabled = true; $$('input[name="mode"]', md).forEach((x) => (x.disabled = true));
    let ok = 0, ko = 0, quota = false; const creds = [];
    for (const [i, r] of rows.entries()) {
      if (quota && (Store.get(r.it.kind === "student" ? "students" : "profs", r.it.account.id) || r.it.account).uid) { r.status = "later"; paint(i); continue; }
      r.status = "running"; paint(i);
      try {
        const res = await Accounts.activate(r.it.kind, r.it.account, quota ? "provisoire" : mode);
        if (res.password) { r.status = "provisoire"; creds.push({ kind: r.it.kind, account: res.acc, password: res.password }); if (res.fallback) quota = true; }
        else r.status = res.created ? "created" : "sent";
        ok++;
      } catch (e) { console.error(e); r.status = "error"; r.err = Accounts.errorText(e); ko++; if (e.code === "auth/quota-exceeded") { quota = true; r.status = "later"; ko--; } }
      paint(i);
    }
    const later = rows.filter((r) => r.status === "later").length;
    $("#act-sum", md).innerHTML = `${ok} accès traité(s)${ko ? `, ${ko} erreur(s)` : ""}.`
      + (quota ? `<br><b>Quota quotidien de Firebase atteint</b> (150 e-mails de réinitialisation par jour).${creds.length ? " Les nouveaux comptes ont reçu un mot de passe provisoire." : ""}${later ? ` ${later} compte(s) déjà existant(s) reporté(s) : relancez demain, ou choisissez le mot de passe provisoire après les avoir supprimés dans la console Firebase › Authentication.` : ""}` : "")
      + (creds.length ? `<br><b>${creds.length} mot(s) de passe provisoire(s)</b> à transmettre : cliquez sur « Envoyer les identifiants » (ils ne seront plus affichés ensuite).` : "");
    running = false; done = true;
    if (creds.length) {
      btn().disabled = false; btn().textContent = "Envoyer les identifiants";
      btn().onclick = (e) => { e.preventDefault(); md.remove(); sendCredentialsDialog(creds, { title: `Identifiants à transmettre (${creds.length})`, onClose }); };
    } else { btn().disabled = false; btn().textContent = "Fermer"; }
    UI.toast(`${ok} accès traité(s)${ko ? `, ${ko} erreur(s)` : ""}.`);
  };
}
