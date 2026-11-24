/* ==========================================================================
   Noyau : stockage, authentification, utilitaires d'interface
   ========================================================================== */
const COLS = ["profs", "students", "contents", "sessions", "messages", "timetable", "exams", "soutenances", "modules", "notifications", "visios", "rappels", "fichiers", "quiz", "quiz_reponses", "quiz_corriges"];
const DB_KEY = "s2i_db_v1";

/* ---------------- Utilitaires ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => isoDate(new Date());
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDate(d); };
const linkify = (t) => esc(t).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 60 ? u.slice(0, 57) + "…" : u}</a>`);
const fmtDate = (s) => { if (!s) return ""; const [y, m, d] = s.slice(0, 10).split("-"); return `${d}/${m}/${y}`; };
const fmtDateTime = (s) => { const d = new Date(s); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const yearOfModule = (code) => { const m = S2I.modules.find((x) => x.code === code); return m ? (m.sem <= 2 ? 1 : 2) : 1; };
const sectionOf = (st) => `${st.formation}-${st.annee}A`;
const sectionsOfYear = (y) => [`TN-${y}A`, `TAM-${y}A`];

/* Semaines (lundi = début de semaine) et mode d'enseignement */
const mondayOf = (iso) => { const d = iso ? new Date(iso + "T12:00:00") : new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoDate(d); };
const shiftISO = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoDate(d); };
const weekLabel = (mon) => `Semaine du ${fmtDate(mon)} au ${fmtDate(shiftISO(mon, 5))}`;
/* Début de l'emploi du temps : les semaines antérieures ne sont plus affichées */
const EDT_START = "2026-11-16";
const edtStart = () => ((typeof Store !== "undefined" && Store.data && Store.data.settings && Store.data.settings.edtDebut) || EDT_START);
const clampWeek = (w) => (w < edtStart() ? edtStart() : w);
const slotInWeek = (t, mon) => mon >= edtStart() && (t.semaine ? t.semaine === mon : !(t.exceptions || []).includes(mon));
const TTWeek = { _m: mondayOf(), get monday() { return clampWeek(this._m); }, set monday(v) { this._m = clampWeek(v); } };
function weekOptions(selected) {
  const base = mondayOf(); const set = new Set();
  for (let i = -8; i <= 30; i++) set.add(shiftISO(base, 7 * i));
  if (selected) set.add(selected);
  return [["", "Toutes les semaines (récurrent)"], ...[...set].filter((w) => w >= edtStart()).sort().map((w) => [w, weekLabel(w)])];
}
const MODES = { presentiel: "Présentiel", distance: "À distance" };
function modePill(mode, lien) {
  if (mode === "distance") return `<span class="pill mode-d">💻 À distance</span>${lien ? ` <a href="${esc(lien)}" target="_blank" rel="noopener">Rejoindre</a>` : ""}`;
  return `<span class="pill mode-p">🏫 Présentiel</span>`;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hashPwd = (pwd) => sha256("s2i-ensias::" + pwd);

/* ---------------- Stockage ----------------
   Mode local (par défaut) : localStorage du navigateur.
   Mode partagé : Firebase Firestore si assets/js/firebase-config.js est rempli. */
const Store = {
  data: null,
  mode: "local",
  fs: null,
  auth: null,
  me: null, // mode Firebase : { uid, email, role, refId, section }
  listeners: [],

  async init() {
    const cfg = window.FIREBASE_CONFIG;
    if (cfg && cfg.apiKey) {
      this.mode = "firebase";
      try { await this._initFirebase(cfg); }
      catch (e) { console.error(e); this.data = this.data || { settings: {} }; this._ensure(); setTimeout(() => UI.toast("Connexion à la base impossible : " + (e.message || e)), 300); }
      return;
    }
    const raw = localStorage.getItem(DB_KEY);
    if (raw) { this.data = JSON.parse(raw); this._ensure(); }
    else { this.data = await buildSeed(); this._persist(); }
  },

  _ensure() { (this.data.timetable || []).forEach((t) => { if (!t.mode) t.mode = "presentiel"; if (t.semaine === undefined) t.semaine = ""; }); COLS.forEach((c) => { if (!Array.isArray(this.data[c])) this.data[c] = []; }); if (!this.data.settings) this.data.settings = {}; },
  _persist() {
    if (this.mode !== "local") return;
    try { localStorage.setItem(DB_KEY, JSON.stringify(this.data)); }
    catch (e) { UI.toast("Stockage du navigateur plein : utilisez des liens plutôt que des fichiers joints."); throw e; }
  },
  onChange(fn) { this.listeners.push(fn); },
  _emit(col) { this.listeners.forEach((fn) => { try { fn(col); } catch (e) { console.error(e); } }); },

  all(col) { return this.data[col] || []; },
  get(col, id) { return this.all(col).find((x) => x.id === id); },
  _local(col, obj) {
    if (!obj.id) obj.id = uid();
    const arr = this.all(col); const i = arr.findIndex((x) => x.id === obj.id);
    if (i >= 0) arr[i] = obj; else arr.push(obj);
    this._persist();
  },
  /* Écriture en ligne (mode Firebase) : renvoie une promesse */
  _remote(col, obj) {
    if (col === "messages" && !obj.authorUid && this.auth && this.auth.currentUser) obj.authorUid = this.auth.currentUser.uid;
    const clean = JSON.parse(JSON.stringify(obj)); delete clean.passHash; delete clean.password;
    const jobs = [this.fs.collection(col).doc(String(obj.id)).set(clean)];
    if ((col === "students" || col === "profs") && obj.uid && this.me && this.me.role === "admin") jobs.push(this._syncProfile(col, obj));
    return Promise.all(jobs);
  },
  _syncProfile(col, obj) {
    const role = obj.inactif ? "disabled" : col === "students" ? "student" : "prof";
    return this.fs.collection("users").doc(obj.uid).set({ role, refId: obj.id, section: col === "students" ? sectionOf(obj) : "", email: (obj.email || "").toLowerCase() }, { merge: true });
  },
  put(col, obj) {
    Journal.track(col, obj, !(obj.id && this.get(col, obj.id)));
    this._local(col, obj);
    if (this.mode === "firebase") this._remote(col, obj).catch(Store._fbErr);
    return obj;
  },
  async putAwait(col, obj) {
    Journal.track(col, obj, !(obj.id && this.get(col, obj.id)));
    this._local(col, obj);
    if (this.mode === "firebase") await this._remote(col, obj);
    return obj;
  },
  del(col, id) {
    const old = this.get(col, id);
    Journal.track(col, old || { id }, false, true);
    this.data[col] = this.all(col).filter((x) => x.id !== id);
    this._persist();
    if (this.mode === "firebase") {
      this.fs.collection(col).doc(String(id)).delete().catch(Store._fbErr);
      if ((col === "students" || col === "profs") && old && old.uid) this.fs.collection("users").doc(old.uid).delete().catch(Store._fbErr);
    }
  },
  settings() { return this.data.settings; },
  saveSettings() {
    this._persist();
    if (this.mode === "firebase") this.fs.collection("config").doc("settings").set(JSON.parse(JSON.stringify(this.data.settings))).catch(Store._fbErr);
  },
  exportJSON() { return JSON.stringify(this.data, null, 2); },
  async importJSON(obj) {
    const keep = this.data && this.data.settings ? this.data.settings : {};
    delete obj._meta; obj.settings = obj.settings || {};
    // Ne pas perdre le mot de passe administrateur ni la configuration e-mail si le fichier ne les contient pas
    ["adminHash", "email", "mailTemplates"].forEach((k) => { if (obj.settings[k] === undefined && keep[k] !== undefined) obj.settings[k] = keep[k]; });
    if (this.mode === "firebase") { await this._upsertAll(obj); return; }
    this.data = obj; this._ensure(); this._persist();
  },
  async reset() {
    if (this.mode === "firebase") throw new Error("La réinitialisation est désactivée en mode Firebase.");
    this.data = await buildSeed(); this._persist();
  },

  _fbErr(e) { console.error(e); UI.toast("Erreur d'enregistrement en ligne : " + (e.code === "permission-denied" ? "action non autorisée" : e.message)); },
  async _initFirebase(cfg) {
    const v = "10.12.2";
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-auth-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore-compat.js`);
    if (!firebase.apps.find((a) => a.name === "[DEFAULT]")) firebase.initializeApp(cfg);
    this.auth = firebase.auth(); this.fs = firebase.firestore();
    this.auth.languageCode = "fr"; // e-mails Firebase (activation, mot de passe oublié) en français
    this.data = { settings: {} }; this._ensure();
    const user = await new Promise((res) => { const off = this.auth.onAuthStateChanged((u) => { off(); res(u); }); });
    if (!user) return;
    await this._loadProfile(user);
    if (this.me) await this.loadData();
  },
  async _loadProfile(user) {
    const snap = await this.fs.collection("users").doc(user.uid).get();
    this.me = snap.exists ? { uid: user.uid, email: user.email, ...snap.data() } : null;
    return this.me;
  },
  async loadData() {
    const docs = (snap) => snap.docs.map((d) => d.data());
    const col = (c) => this.fs.collection(c).get().then(docs);
    const r = this.me.role; const sec = this.me.section;
    const conf = await this.fs.collection("config").doc("settings").get();
    this.data = { settings: conf.exists ? conf.data() : {} };
    if (r === "admin" || r === "prof") {
      await Promise.all(COLS.map(async (c) => { this.data[c] = r === "prof" && c === "rappels" ? docs(await this.fs.collection(c).where("profId", "==", this.me.refId).get()) : await col(c).catch((e) => { console.error(c, e); return []; }); }));
      const ia = await this.fs.collection("config").doc("ia").get().catch(() => null); this.data.ia = ia && ia.exists ? ia.data() : {};
      const pv = await this.fs.collection("config").doc("prive").get().catch(() => null); this.data.prive = pv && pv.exists ? pv.data() : {};
    } else if (r === "student") {
      await Promise.all(["modules", "profs", "timetable", "exams", "soutenances", "notifications", "visios"].map(async (c) => { this.data[c] = await col(c); }));
      const own = await this.fs.collection("students").doc(this.me.refId).get();
      this.data.students = own.exists ? [own.data()] : [];
      this.data.sessions = docs(await this.fs.collection("sessions").where("section", "==", sec).get());
      this.data.contents = docs(await this.fs.collection("contents").where("statut", "==", "publie").get());
      this.data.fichiers = await this.fs.collection("fichiers").where("statut", "==", "publie").get().then(docs).catch(() => []);
      const qz = (s) => this.fs.collection("quiz").where("statut", "==", s).get().then(docs).catch(() => []);
      this.data.quiz = [...await qz("publie"), ...await qz("ferme")];
      this.data.quiz_reponses = await this.fs.collection("quiz_reponses").where("studentId", "==", this.me.refId).get().then(docs).catch(() => []);
      this.data.quiz_corriges = [];
      this.data.messages = docs(await this.fs.collection("messages").where("section", "in", [sec, "ALL"]).get());
    }
    this._ensure();
    this._watchMessages();
  },
  _watchMessages() {
    const r = this.me.role;
    const q = r === "student" ? this.fs.collection("messages").where("section", "in", [this.me.section, "ALL"]) : this.fs.collection("messages");
    q.onSnapshot((snap) => { this.data.messages = snap.docs.map((d) => d.data()); this._emit("messages"); }, (e) => console.error(e));
  },
  async _upsertAll(obj) {
    for (const c of COLS) {
      const list = obj[c] || [];
      for (let i = 0; i < list.length; i += 400) {
        const batch = this.fs.batch();
        list.slice(i, i + 400).forEach((d) => { const x = JSON.parse(JSON.stringify(d)); delete x.passHash; batch.set(this.fs.collection(c).doc(String(d.id)), x); });
        await batch.commit();
      }
    }
    const st = { ...obj.settings }; delete st.adminHash;
    await this.fs.collection("config").doc("settings").set(st, { merge: true });
  }
};

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}

async function buildSeed() {
  const ph = await hashPwd(DEMO.studentPassword);
  const pp = await hashPwd("prof2026");
  const d = { settings: { adminHash: await hashPwd(DEMO.adminPassword), createdAt: new Date().toISOString() } };
  d.modules = S2I.modules.map((m) => ({ id: m.code, ...m }));
  d.profs = DEMO.profs.map(({ password, ...p }) => ({ ...p, passHash: pp }));
  d.students = DEMO.students.map((s) => ({ ...s, passHash: ph }));
  d.timetable = [
    { id: uid(), section: "TN-1A", jour: 1, debut: "08:30", fin: "10:30", module: "M2.1", salle: "Salle B12", profId: "p1" },
    { id: uid(), section: "TN-1A", jour: 1, debut: "10:45", fin: "12:45", module: "M2.2", salle: "Amphi 2", profId: "p1" },
    { id: uid(), section: "TN-1A", jour: 3, debut: "14:00", fin: "16:00", module: "M2.5", salle: "Salle A04", profId: "" },
    { id: uid(), section: "TN-1A", jour: 5, debut: "16:15", fin: "18:15", module: "M2.2", salle: "", profId: "p1", mode: "distance", lien: "https://teams.microsoft.com/", semaine: mondayOf() },
    { id: uid(), section: "TAM-1A", jour: 6, debut: "09:00", fin: "12:00", module: "M2.1", salle: "Labo SE", profId: "p1" },
    { id: uid(), section: "TN-2A", jour: 2, debut: "08:30", fin: "10:30", module: "M3.3", salle: "Labo Vision", profId: "p1" },
    { id: uid(), section: "TN-2A", jour: 4, debut: "14:00", fin: "16:00", module: "M3.4", salle: "Salle C02", profId: "p2" }
  ];
  d.exams = [
    { id: uid(), section: "TN-1A", module: "M2.1", date: addDays(21), debut: "09:00", fin: "11:00", salle: "Amphi 1", type: "Examen final" },
    { id: uid(), section: "TN-2A", module: "M3.3", date: addDays(24), debut: "14:00", fin: "16:00", salle: "Amphi 2", type: "Examen final" }
  ];
  d.soutenances = [
    { id: uid(), date: addDays(40), heure: "10:00", etudiant: "Imane Fassi (TN-2A)", sujet: "Détection de défauts par vision embarquée", encadrant: "Pr. A. Berrahou", jury: "À définir", salle: "Salle des soutenances" }
  ];
  d.contents = [
    { id: uid(), module: "M2.1", titre: "Programmation des systèmes embarqués — supports", description: "Supports du module, organisés par rubrique.", lien: "", sections: ["TN-1A", "TAM-1A"], statut: "publie", profId: "p1",
      dossiers: [{ id: uid(), rubrique: "cours", nom: "Chapitre 1 — Architecture des microcontrôleurs" }, { id: uid(), rubrique: "tp", nom: "TP1 — GPIO et interruptions" }, { id: uid(), rubrique: "man", nom: "Rappels de langage C" }],
      createdAt: new Date().toISOString() }
  ];
  d.messages = [
    { id: uid(), module: "ALL", section: "ALL", authorRole: "admin", authorId: "admin", authorName: "Coordination S2I", text: "Bienvenue sur la plateforme du Master S2I, année " + S2I.annee + ".", system: false, date: new Date().toISOString() }
  ];
  d.timetable.forEach((t) => { t.mode = t.mode || "presentiel"; t.lien = t.lien || ""; t.semaine = t.semaine || ""; });
  d.notifications = [
    { id: uid(), titre: "Planning des examens du semestre", categorie: "Planning", message: "Le calendrier des examens est disponible dans l'onglet « Examens & soutenances ».", lien: "",
      formation: "", promotions: [], annee: "", publishAt: new Date().toISOString(), createdAt: new Date().toISOString() }
  ];
  d.sessions = [];
  return d;
}

/* ---------------- Authentification ---------------- */
const Auth = {
  KEY: "s2i_session",
  lastError: "",
  async login(role, ident, pwd) {
    this.lastError = "";
    if (Store.mode === "firebase") {
      try {
        const cred = await Store.auth.signInWithEmailAndPassword((ident || "").trim(), pwd);
        const me = await Store._loadProfile(cred.user);
        if (!me || me.role !== role) {
          await Store.auth.signOut(); Store.me = null;
          this.lastError = !me ? "Ce compte n'a pas encore d'accès à la plateforme. Contactez la coordination."
            : me.role === "disabled" ? "Ce compte est désactivé."
            : "Ce compte n'a pas accès à cet espace : choisissez le bon onglet.";
          return null;
        }
        return { id: me.refId, role };
      } catch (e) {
        this.lastError = ["auth/too-many-requests"].includes(e.code) ? "Trop de tentatives : réessayez dans quelques minutes." : "E-mail ou mot de passe incorrect.";
        return null;
      }
    }
    const h = await hashPwd(pwd);
    ident = (ident || "").trim().toLowerCase();
    if (role === "admin") return h === Store.settings().adminHash ? { id: "admin", nom: "Administrateur", prenom: "" } : null;
    const col = role === "prof" ? "profs" : "students";
    const u = Store.all(col).find((x) => (x.login || "").toLowerCase() === ident && !x.inactif);
    return u && u.passHash === h ? u : null;
  },
  async resetPassword(email) {
    const url = siteBase() + "connexion.html";
    await Store.auth.sendPasswordResetEmail(email.trim(), { url });
  },
  start(role, user) { if (Store.mode !== "firebase") sessionStorage.setItem(this.KEY, JSON.stringify({ role, id: user.id })); },
  current() {
    if (Store.mode === "firebase") return Store.me ? { role: Store.me.role, id: Store.me.refId } : null;
    try { return JSON.parse(sessionStorage.getItem(this.KEY)); } catch { return null; }
  },
  user() {
    const s = this.current(); if (!s) return null;
    if (s.role === "admin") return { id: "admin", nom: "Administrateur", prenom: "", role: "admin", email: Store.me ? Store.me.email : "" };
    if (s.role !== "prof" && s.role !== "student") return null;
    const u = Store.get(s.role === "prof" ? "profs" : "students", s.id);
    return u ? { ...u, role: s.role } : null;
  },
  require(role) {
    const u = this.user();
    if (!u || u.role !== role) { location.href = "connexion.html?role=" + (role === "student" ? "etudiant" : role); return null; }
    return u;
  },
  async logout() {
    await Journal.log("Déconnexion", "", { now: true });
    if (Store.mode === "firebase") { try { await Store.auth.signOut(); } catch (e) { console.error(e); } }
    sessionStorage.removeItem(this.KEY); location.href = "index.html";
  }
};

/* ---------------- Journal d'activité ----------------
   Chaque action (connexion, consultation, création, modification, suppression)
   est enregistrée dans la collection « logs » (lisible par l'administrateur seul). */
const LOG_LABELS = { contents: "Contenu pédagogique", sessions: "Feuille de présence", messages: "Message", visios: "Séance Teams", timetable: "Créneau d'emploi du temps",
  students: "Fiche étudiant", profs: "Fiche enseignant", modules: "Module", notifications: "Notification", exams: "Examen", soutenances: "Soutenance", rappels: "Rappel de saisie des absences", fichiers: "Document", quiz: "Quiz", quiz_reponses: "Copie de quiz" };
const Journal = {
  queue: [], timer: null, _lastView: "",
  who() {
    const u = (() => { try { return Auth.user(); } catch { return null; } })();
    const me = Store.me || {};
    const role = u ? u.role : me.role || "";
    return { uid: Store.mode === "firebase" && Store.auth && Store.auth.currentUser ? Store.auth.currentUser.uid : "", role,
      userId: u ? u.id : me.refId || "", nom: u ? (role === "admin" ? "Administrateur" : `${u.prenom || ""} ${u.nom || ""}`.trim()) : "",
      email: (u && u.email) || me.email || "" };
  },
  device() {
    const a = navigator.userAgent; const b = /Edg\//.test(a) ? "Edge" : /OPR\//.test(a) ? "Opera" : /Firefox\//.test(a) ? "Firefox" : /Chrome\//.test(a) ? "Chrome" : /Safari\//.test(a) ? "Safari" : "Navigateur";
    const o = /Android/.test(a) ? "Android" : /iPhone|iPad/.test(a) ? "iOS" : /Windows/.test(a) ? "Windows" : /Mac OS/.test(a) ? "macOS" : /Linux/.test(a) ? "Linux" : "";
    return `${b}${o ? " · " + o : ""}${/Mobi/.test(a) ? " (mobile)" : ""}`;
  },
  describe(col, o) {
    if (!o) return "";
    const s = (x) => String(x || "").replace(/\s+/g, " ").trim();
    switch (col) {
      case "messages": return `${s(o.module) === "ALL" ? "Annonces" : s(o.module)} · ${s(o.section)} : ${s(o.text).slice(0, 90)}`;
      case "quiz": return `${s(o.module)} « ${s(o.titre)} » · ${(o.sections || []).join(", ")} · ${(o.questions || []).length} question(s)${o.statut ? ` (${({ publie: "publié", brouillon: "brouillon", ferme: "fermé" })[o.statut] || o.statut})` : ""}`;
      case "quiz_reponses": { const q = Store.get("quiz", o.quizId); return `${s(o.module)} « ${q ? s(q.titre) : s(o.quizId)} » — tentative ${o.tentative || 1}`; }
      case "fichiers": { const c = Store.get("contents", o.contentId); const d = c && (c.dossiers || []).find((x) => x.id === o.dossierId);
        return `${s(o.module)} · ${(typeof RUBRIQUES !== "undefined" && RUBRIQUES[o.rubrique]) || ""}${d ? " / " + s(d.nom) : ""} « ${s(o.nom)} »${c ? ` (contenu « ${s(c.titre)} »)` : ""}`; }
      case "contents": return `${s(o.module)} · ${S2I.typesContenu[o.type] ? S2I.typesContenu[o.type] + " " : ""}« ${s(o.titre)} »${o.statut ? ` (${({ publie: "publié", brouillon: "non publié", desactive: "désactivé" })[o.statut] || o.statut})` : ""}`;
      case "sessions": { const r = Object.values(o.records || {}); return `${s(o.module)} · ${s(o.section)} · ${fmtDate(o.date)} ${s(o.debut)}${r.length ? ` — ${r.filter((x) => x === "A").length} absent(s) / ${r.length}` : ""}`; }
      case "visios": return `${s(o.module)} · ${(o.sections || []).join(", ")}${(o.etudiants || []).length ? ` (${o.etudiants.length} étudiant(s) choisi(s))` : ""} · ${fmtDate(o.date)} ${s(o.debut)} « ${s(o.titre)} »${o.statut === "annulee" ? " (annulée)" : ""}`;
      case "timetable": return `${s(o.section)} · ${S2I.jours[(o.jour || 1) - 1] || ""} ${s(o.debut)}–${s(o.fin)} · ${s(o.module)}`;
      case "students": case "profs": return `${s(o.prenom)} ${s(o.nom)}${o.email ? ` <${s(o.email)}>` : ""}`;
      case "notifications": return `« ${s(o.titre)} »`;
      case "exams": return `${s(o.module)} · ${s(o.section)} · ${fmtDate(o.date)}`;
      case "soutenances": return `${s(o.etudiant)} · ${fmtDate(o.date)}`;
      case "rappels": { const p = Store.get("profs", o.profId); return `${p ? `Pr. ${p.prenom} ${p.nom}` : ""} · ${(o.items || []).length} séance(s)${o.email ? " · avec e-mail" : ""}`; }
      default: return s(o.titre || o.code || o.id);
    }
  },
  track(col, obj, isNew, isDel) {
    if (!LOG_LABELS[col]) return;
    let action = isDel ? "Suppression" : isNew ? "Création" : "Modification";
    if (col === "messages" && isNew) action = obj.system ? "Annonce automatique" : "Message envoyé";
    if (col === "contents" && !isNew && !isDel) { const old = Store.get(col, obj.id); if (old && old.statut !== obj.statut && obj.statut === "publie") action = "Publication"; }
    if (col === "sessions" && !isDel) action = isNew ? "Feuille de présence créée" : "Appel enregistré";
    this.log(action, this.describe(col, obj), { objet: LOG_LABELS[col], ref: `${col}/${obj.id || ""}` });
  },
  log(action, detail = "", opt = {}) {
    try {
      const w = this.who(); if (!w.role || w.role === "disabled") return Promise.resolve();
      const e = { id: uid(), date: new Date().toISOString(), ...w, action, objet: opt.objet || "", detail: String(detail).slice(0, 300), ref: opt.ref || "",
        page: location.pathname.split("/").pop() || "index.html", appareil: this.device() };
      this.queue.push(e);
      if (opt.now) return this.flush();
      clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 1200);
    } catch (err) { console.error(err); }
    return Promise.resolve();
  },
  /* Regroupe les opérations en série (import Excel, passage de promotion…) */
  async flush() {
    clearTimeout(this.timer); let q = this.queue; this.queue = []; if (!q.length) return;
    const groups = {}; q.forEach((e) => { const k = e.action + "|" + e.objet; (groups[k] = groups[k] || []).push(e); });
    q = Object.values(groups).flatMap((g) => g.length > 5 && g[0].objet ? [{ ...g[0], action: g[0].action + " groupée", detail: `${g.length} élément(s) — ${g.slice(0, 3).map((x) => x.detail).join(" ; ")}…` }] : g);
    if (Store.mode === "firebase") {
      if (!Store.fs || !Store.auth || !Store.auth.currentUser) return;
      const b = Store.fs.batch(); q.forEach((e) => b.set(Store.fs.collection("logs").doc(e.id), e));
      try { await Promise.race([b.commit(), new Promise((r) => setTimeout(r, 2500))]); } catch (err) { console.warn("Journal :", err.code || err); }
    } else {
      const L = (Store.data.logs = Store.data.logs || []); L.push(...q); if (L.length > 3000) L.splice(0, L.length - 3000); Store._persist();
    }
  }
};
window.addEventListener("pagehide", () => { if (Journal.queue.length) Journal.flush(); });

/* ---------------- Interface ---------------- */
const UI = {
  toast(msg) {
    document.querySelectorAll(".toast").forEach((x) => x.remove());
    const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2800);
  },
  modal({ title, body, submitLabel = "Enregistrer", onSubmit, wide }) {
    const bg = document.createElement("div"); bg.className = "modal-bg";
    bg.innerHTML = `<form class="modal" ${wide ? 'style="max-width:980px"' : ""}>
      <div class="modal-h"><h3>${esc(title)}</h3><button type="button" class="x" aria-label="Fermer">×</button></div>
      <div class="modal-b">${body}</div>
      <div class="modal-f"><button type="button" class="btn outline cancel">Fermer</button>${onSubmit ? `<button class="btn">${esc(submitLabel)}</button>` : ""}</div></form>`;
    const close = () => bg.remove();
    bg.querySelector(".x").onclick = close; bg.querySelector(".cancel").onclick = close;
    bg.addEventListener("mousedown", (e) => { if (e.target === bg) close(); });
    bg.querySelector("form").onsubmit = async (e) => { e.preventDefault(); if (!onSubmit) return; const ok = await onSubmit(bg.querySelector("form")); if (ok !== false) close(); };
    document.body.appendChild(bg);
    return bg;
  },
  confirm(msg) { return window.confirm(msg); },
  moduleLabel(code) { const m = Store.get("modules", code) || S2I.modules.find((x) => x.code === code); return m ? `${m.code} – ${m.titre}` : code === "ALL" ? "Annonces générales" : code; },
  moduleOptions(codes, sel) { return codes.map((c) => `<option value="${esc(c)}" ${c === sel ? "selected" : ""}>${esc(UI.moduleLabel(c))}</option>`).join(""); },
  teacherOf(t) { return t.profId ? UI.profName(t.profId) : t.profNom || ""; },
  profName(id) { const p = Store.get("profs", id); return p ? `Pr. ${p.prenom} ${p.nom}` : "—"; },
  studentName(s) { return `${s.nom.toUpperCase()} ${s.prenom}`; }
};

/* Adresse publique du site (utilisée dans les e-mails et les liens d'activation) */
const SITE_URL = "https://master-s2i.github.io/";
function siteBase() {
  let u = (Store.settings() || {}).siteUrl || "";
  if (!u || /aissamberrahou\.github\.io\/master-s2i/.test(u)) u = /github\.io$/.test(location.hostname) ? SITE_URL : location.href.replace(/[^/]*([?#].*)?$/, "");
  return u.endsWith("/") ? u : u + "/";
}

/* En-tête commun (logos + bandeau de navigation) */
function renderHeader(active, user) {
  const logo = (src, alt, cls = "") => `<img class="${cls}" src="${src}" alt="${alt}" onerror="this.outerHTML='<span class=&quot;logo-txt&quot;>${alt}</span>'">`;
  const links = [["index.html", "Accueil"], ["index.html#programme", "Formation"], ["prof.html", "Espace Prof"], ["etudiant.html", "Espace Étudiant"], ["admin.html", "Administration"]];
  document.getElementById("header").innerHTML = `
  <div class="topbar"><div class="wrap">
    <a class="logos" href="index.html">
      ${logo("assets/img/logo-um5.png", "UM5")}<span class="sep"></span>
      ${logo("assets/img/logo-ensias.png", "ENSIAS")}<span class="sep"></span>
      <img class="logo-s2i" src="assets/img/logo-s2i.svg" alt="Master S2I">
    </a>
    <div class="right">${user ? `<span class="who-name">${esc((user.prenom ? user.prenom + " " : "") + user.nom)}</span><button class="btn outline sm" id="logout">Déconnexion</button>` : ""}</div>
  </div></div>
  <div class="navband"><nav>${links.map(([h, t]) => `<a href="${h}" class="${active === h ? "active" : ""}">${t}</a>`).join("")}</nav></div>`;
  const lo = document.getElementById("logout"); if (lo) lo.onclick = () => Auth.logout();
}

function renderFooter() {
  const el = document.getElementById("footer"); if (!el) return;
  el.innerHTML = `<footer class="site"><div class="wrap">
    <div>© ${new Date().getFullYear()} Master S2I — <a href="https://ensias.um5.ac.ma/" target="_blank" rel="noopener">ENSIAS</a>, Université Mohammed V de Rabat</div>
    <div>Coordination : <a href="https://aissamberrahou.github.io/" target="_blank" rel="noopener">Pr. Aissam Berrahou</a></div></div></footer>`;
}

/* ---------------- Application à barre latérale ---------------- */
function mountApp(user, roleLabel, views) {
  const app = document.getElementById("app");
  app.innerHTML = `<aside class="sidebar"><div class="who"><img class="side-ico" src="assets/img/logo-s2i-icon.svg" alt="Master S2I"><b>${esc((user.prenom ? user.prenom + " " : "") + user.nom)}</b><span>${esc(roleLabel)}</span></div>
    ${views.map((v) => `<a href="#${v.id}" data-v="${v.id}"><span>${v.label}</span><span class="badge" data-badge="${v.id}" hidden></span></a>`).join("")}</aside>
    <section class="main" id="main"></section>`;
  const show = () => {
    const id = location.hash.slice(1) || views[0].id;
    let v = views.find((x) => x.id === id) || views[0];
    const fresh = Auth.user();
    if (fresh && fresh.mustChange && views.some((x) => x.id === "profil")) v = views.find((x) => x.id === "profil");
    $$(".sidebar a").forEach((a) => a.classList.toggle("active", a.dataset.v === v.id));
    const main = $("#main"); main.innerHTML = "";
    if (Journal._lastView !== v.id) { Journal._lastView = v.id; Journal.log("Consultation", `${roleLabel} › ${v.label.replace(/<[^>]+>/g, "")}`); }
    v.render(main);
    refreshBadges(views);
  };
  window.addEventListener("hashchange", show);
  Store.onChange(() => refreshBadges(views));
  show();
}
function refreshBadges(views) {
  views.forEach((v) => {
    if (!v.badge) return; const n = v.badge(); const b = document.querySelector(`[data-badge="${v.id}"]`);
    if (b) { b.hidden = !n; b.textContent = n; }
  });
}

/* ---------------- Calendrier mensuel générique ---------------- */
function renderMonthCalendar(el, events, state = { y: new Date().getFullYear(), m: new Date().getMonth() }) {
  const draw = () => {
    const { y, m } = state;
    const first = new Date(y, m, 1); const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
    const mois = first.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    let cells = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map((d) => `<div class="dow">${d}</div>`).join("");
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i); const iso = isoDate(d);
      const evs = events.filter((e) => e.date === iso).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
      cells += `<div class="${d.getMonth() !== m ? "out" : ""} ${iso === todayISO() ? "today" : ""}"><span class="num">${d.getDate()}</span>
        ${evs.map((e) => `<span class="ev ${e.cls || ""}" title="${esc(e.title)}">${esc((e.time ? e.time + " " : "") + e.label)}</span>`).join("")}</div>`;
    }
    el.innerHTML = `<div class="cal-head"><button class="btn outline sm" data-n="-1">‹</button><h3>${mois}</h3><button class="btn outline sm" data-n="1">›</button>
      <button class="btn outline sm" data-n="0">Aujourd'hui</button></div><div class="cal">${cells}</div>`;
    $$("[data-n]", el).forEach((b) => b.onclick = () => {
      const n = +b.dataset.n;
      if (n === 0) { state.y = new Date().getFullYear(); state.m = new Date().getMonth(); }
      else { const d = new Date(state.y, state.m + n, 1); state.y = d.getFullYear(); state.m = d.getMonth(); }
      draw();
    });
  };
  draw();
}

/* ---------------- Formulaires et tableaux génériques (CRUD) ---------------- */
function fieldHtml(f, val) {
  if (f.type === "password" && Store.mode === "firebase") return "";
  const id = "f_" + f.key; const req = f.required ? "required" : "";
  const cls = f.full ? "full" : "";
  let input;
  switch (f.type) {
    case "select":
      if (typeof val === "boolean") val = val ? "1" : "0";
      input = `<select id="${id}" name="${f.key}" ${req}>${f.empty ? `<option value="">${esc(f.empty)}</option>` : ""}${f.options().map(([v, t]) => `<option value="${esc(v)}" ${String(val ?? "") === String(v) ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`; break;
    case "multi":
      input = `<div class="checks" id="${id}">${f.options().map(([v, t]) => `<label><input type="checkbox" name="${f.key}" value="${esc(v)}" ${(val || []).includes(v) ? "checked" : ""}> ${esc(t)}</label>`).join("")}</div>`; break;
    case "textarea": input = `<textarea id="${id}" name="${f.key}" ${req}>${esc(val)}</textarea>`; break;
    case "password": input = `<input id="${id}" name="${f.key}" type="password" autocomplete="new-password" placeholder="${f.placeholder || ""}" ${req}>`; break;
    default: input = `<input id="${id}" name="${f.key}" type="${f.type || "text"}" value="${esc(val)}" placeholder="${esc(f.placeholder || "")}" ${f.datalist ? `list="dl_${f.key}"` : ""} ${req}>`
      + (f.datalist ? `<datalist id="dl_${f.key}">${f.datalist().map((o) => `<option value="${esc(o)}">`).join("")}</datalist>` : "");
  }
  return `<div class="${cls}"><label for="${id}">${esc(f.label)}</label>${input}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ""}</div>`;
}
function readForm(form, fields) {
  const o = {};
  fields.forEach((f) => {
    if (f.type === "multi") o[f.key] = $$(`input[name="${f.key}"]:checked`, form).map((i) => i.value);
    else { const el = form.elements[f.key]; o[f.key] = el ? el.value.trim() : ""; }
    if (f.type === "number" && o[f.key] !== "") o[f.key] = Number(o[f.key]);
  });
  return o;
}

/* cfg : { col, title, fields, columns:[[label, fn(row)]], sort, beforeSave(obj, isNew), filter } */
function renderCrud(el, cfg) {
  const draw = () => {
    let rows = Store.all(cfg.col).slice();
    if (cfg.filter) rows = rows.filter(cfg.filter);
    if (cfg.sort) rows.sort(cfg.sort);
    el.innerHTML = `<div class="page-head"><h1>${esc(cfg.title)}</h1><div class="toolbar">${cfg.extraButtons || ""}<button class="btn" data-add>+ Ajouter</button></div></div>
      <div class="table-scroll"><table class="data"><thead><tr>${cfg.columns.map((c) => `<th>${esc(c[0])}</th>`).join("")}<th></th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr>${cfg.columns.map((c) => `<td>${c[1](r)}</td>`).join("")}
        <td class="actions">${cfg.rowActions ? cfg.rowActions(r) : ""}<button class="btn outline sm" data-edit="${r.id}">Modifier</button> <button class="btn danger sm" data-del="${r.id}">Supprimer</button></td></tr>`).join("")
        : `<tr><td colspan="${cfg.columns.length + 1}" class="empty">Aucun élément.</td></tr>`}</tbody></table></div>`;
    $("[data-add]", el).onclick = () => openForm(null);
    $$("[data-edit]", el).forEach((b) => b.onclick = () => openForm(Store.get(cfg.col, b.dataset.edit)));
    $$("[data-del]", el).forEach((b) => b.onclick = () => { if (UI.confirm("Supprimer cet élément ?")) { Store.del(cfg.col, b.dataset.del); UI.toast("Supprimé."); draw(); } });
    if (cfg.afterDraw) cfg.afterDraw(el, draw);
  };
  const openForm = (row) => {
    const isNew = !row; row = row ? { ...row } : { ...(cfg.defaults ? cfg.defaults() : {}) };
    UI.modal({
      title: (isNew ? "Ajouter — " : "Modifier — ") + cfg.title,
      body: `<div class="form-grid">${cfg.fields.map((f) => fieldHtml(f, row[f.key])).join("")}</div>`,
      onSubmit: async (form) => {
        const vals = readForm(form, cfg.fields);
        const obj = { ...row, ...vals };
        if (cfg.beforeSave) { const r = await cfg.beforeSave(obj, isNew); if (r === false) return false; }
        Store.put(cfg.col, obj); UI.toast("Enregistré."); draw();
        if (cfg.afterSave) cfg.afterSave(obj, isNew);
      }
    });
  };
  draw();
}

function downloadFile(name, text, type = "application/json") {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
