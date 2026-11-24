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
  /* Crée le compte s'il n'existe pas, relie le profil (rôle) et envoie l'e-mail d'activation */
  async activate(kind, account) {
    const col = kind === "student" ? "students" : "profs";
    let acc = { ...(Store.get(col, account.id) || account) };
    const email = (acc.email || "").trim().toLowerCase();
    if (!email) throw Object.assign(new Error("Adresse e-mail manquante"), { code: "s2i/no-email" });
    let created = false;
    if (!acc.uid) {
      const tmp = randomPassword() + "#9Aa";
      const cred = await this.creator().createUserWithEmailAndPassword(email, tmp);
      acc.uid = cred.user.uid; created = true;
      await this.creator().signOut();
    }
    acc.email = email; acc.mustChange = false; delete acc.passHash;
    await Store.putAwait(col, acc); // écrit la fiche et le profil users/{uid}
    await Store.auth.sendPasswordResetEmail(email, { url: this.loginUrl(kind) });
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

/* items : [{ kind: "student" | "prof", account }] — crée les accès et envoie les e-mails */
function activateAccountsDialog(items, { title, onClose } = {}) {
  if (!items.length) return;
  const rows = items.map((it) => ({ it, status: "pending" }));
  const md = UI.modal({
    title: title || "Accès à la plateforme : envoi des e-mails d'activation", wide: true, submitLabel: "Fermer",
    body: `<div class="alert info">Pour chaque personne, la plateforme crée le compte de connexion (si besoin) et Firebase envoie un e-mail
        avec un lien pour <b>définir son mot de passe</b>. Elle se connecte ensuite avec son adresse e-mail.</div>
      <div class="table-scroll" style="max-height:360px;overflow-y:auto;margin-top:12px"><table class="data"><thead><tr><th>Nom</th><th>E-mail</th><th>État</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td>${esc(`${r.it.account.prenom || ""} ${r.it.account.nom || ""}`)}</td><td>${esc(r.it.account.email || "—")}</td><td data-st="${i}"></td></tr>`).join("")}</tbody></table></div>
      <p class="muted" id="act-sum"></p>`,
    onSubmit: () => { if (onClose) onClose(); }
  });
  $(".modal-f .cancel", md).style.display = "none";
  const paint = (i) => {
    const r = rows[i];
    $(`[data-st="${i}"]`, md).innerHTML = {
      pending: '<span class="pill draft">En attente</span>', running: '<span class="pill t-cours">Envoi…</span>',
      created: '<span class="pill pub">Compte créé, e-mail envoyé</span>', sent: '<span class="pill pub">E-mail envoyé</span>',
      error: `<span class="pill off">${esc(r.err)}</span>`, later: '<span class="pill draft">Reporté (quota atteint) : à renvoyer demain</span>'
    }[r.status];
  };
  rows.forEach((_, i) => paint(i));
  (async () => {
    let ok = 0, ko = 0, quota = false;
    for (const [i, r] of rows.entries()) {
      if (quota) { r.status = "later"; paint(i); continue; }
      r.status = "running"; paint(i);
      try { const res = await Accounts.activate(r.it.kind, r.it.account); r.status = res.created ? "created" : "sent"; ok++; }
      catch (e) { console.error(e); r.status = "error"; r.err = Accounts.errorText(e); ko++; if (e.code === "auth/quota-exceeded") quota = true; }
      paint(i);
    }
    const later = rows.filter((r) => r.status === "later").length;
    $("#act-sum", md).innerHTML = `${ok} e-mail(s) envoyé(s)${ko ? `, ${ko} erreur(s)` : ""}. Les personnes doivent cliquer sur le lien reçu (vérifier aussi les courriers indésirables).`
      + (quota ? `<br><b>Quota quotidien de Firebase atteint</b> (e-mails de réinitialisation du mot de passe) : ${later + 1} envoi(s) arrêté(s). Les comptes concernés restent « Non envoyés » ; relancez demain avec « Envoyer aux comptes non envoyés ».` : "");
    UI.toast(`${ok} e-mail(s) d'activation envoyé(s)${ko ? `, ${ko} erreur(s)` : ""}.`);
  })();
}
