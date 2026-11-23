/* ==========================================================================
   Espace Quiz
   - L'enseignant choisit une ou plusieurs parties d'un contenu pédagogique
     (rubriques, sous-dossiers, documents) ; le texte des documents est extrait
     dans le navigateur (PDF, Word, PowerPoint, texte, notebooks) puis envoyé à
     un modèle d'IA (Qwen ou autre, API compatible OpenAI) qui rédige le quiz.
   - Il relit, modifie, puis publie le quiz pour les sections choisies (TN / TAM).
   - L'étudiant répond en ligne ; la note est calculée tout de suite.

   Données :
   - quiz           : { id, profId, module, titre, consignes, sections[], source, questions[{ id, type, enonce, choix[], points, source }],
                        ouverture, fermeture, ouvertureMs, fermetureMs, duree (min, 0 = libre), tentatives (0 = illimité),
                        corrige ("immediat" | "fermeture"), melanger, statut ("brouillon" | "publie" | "ferme") }
   - quiz_corriges  : { id = idQuiz, quizId, profId, module, reponses: { idQuestion: { bonnes[], explication } } }
                      (séparé du quiz : l'étudiant n'y accède qu'après avoir rendu sa copie)
   - quiz_reponses  : { id = idQuiz_idÉtudiant_n, quizId, studentId, section, module, profId, tentative, debut, fin, reponses: { idQuestion: [indices] } }
   ========================================================================== */
const QZ_TYPES = { qcm: "QCM (une bonne réponse)", multi: "Choix multiples", vf: "Vrai / Faux" };
const QZ_STATUT = { brouillon: '<span class="pill draft">Brouillon</span>', publie: '<span class="pill pub">Publié</span>', ferme: '<span class="pill off">Fermé</span>' };

/* ---------- Service d'IA (API compatible OpenAI : OpenRouter, Alibaba Cloud Model Studio, …) ---------- */
const IA_PRESETS = {
  openrouter: { nom: "OpenRouter — modèles Qwen gratuits et autres", baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen3-30b-a3b:free",
    aide: "Créez un compte sur openrouter.ai, puis une clé dans « Keys ». Les modèles se terminant par « :free » sont gratuits (avec une limite de requêtes par jour)." },
  dashscope: { nom: "Alibaba Cloud Model Studio — Qwen officiel", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen-plus",
    aide: "Clé API Model Studio (DashScope), région internationale. Modèles : qwen-plus, qwen-max, qwen-turbo…" },
  custom: { nom: "Autre service compatible OpenAI", baseUrl: "", model: "", aide: "Adresse de base de l'API (se terminant en général par /v1), modèle et clé." }
};
const IA = {
  PERSO: "s2i_ia_perso",
  shared() { return (Store.mode === "firebase" ? Store.data.ia : (Store.settings() || {}).ia) || {}; },
  perso() { try { return JSON.parse(localStorage.getItem(this.PERSO)) || {}; } catch { return {}; } },
  cfg() { const p = this.perso(); return p.apiKey ? { ...p, perso: true } : this.shared(); },
  configured() { const c = this.cfg(); return !!(c.apiKey && c.baseUrl && c.model); },
  label() { const c = this.cfg(); return c.model ? `${c.model}${c.perso ? " (clé personnelle)" : ""}` : "non configuré"; },
  async saveShared(c) {
    if (Store.mode === "firebase") { await Store.fs.collection("config").doc("ia").set(c); Store.data.ia = c; }
    else { Store.settings().ia = c; Store.saveSettings(); }
  },
  savePerso(c) { if (c && c.apiKey) localStorage.setItem(this.PERSO, JSON.stringify(c)); else localStorage.removeItem(this.PERSO); },
  async chat(messages) {
    const c = this.cfg();
    const headers = { "Content-Type": "application/json", Authorization: "Bearer " + c.apiKey };
    if (/openrouter\.ai/.test(c.baseUrl)) { headers["HTTP-Referer"] = siteBase(); headers["X-Title"] = "Master S2I - Quiz"; }
    let res;
    try {
      res = await fetch(c.baseUrl.replace(/\/+$/, "") + "/chat/completions", { method: "POST", headers,
        body: JSON.stringify({ model: c.model, messages, temperature: 0.4, max_tokens: 12000 }) });
    } catch (e) { throw new Error("le service d'IA est injoignable depuis le navigateur (connexion ou blocage CORS). Essayez OpenRouter."); }
    if (!res.ok) {
      let m = `erreur ${res.status}`;
      try { const j = await res.json(); const er = j.error || j; m += " — " + (er.message || er.code || JSON.stringify(er)).toString().slice(0, 240); } catch { }
      if (res.status === 401 || res.status === 403) m += " (clé API refusée)";
      if (res.status === 404) m += " (modèle indisponible : changez de modèle dans les paramètres de l'IA)";
      if (res.status === 402) m += " (crédit insuffisant sur le compte du service d'IA)";
      if (res.status === 429) m += " (trop de requêtes : réessayez dans une minute ou changez de modèle)";
      throw new Error(m);
    }
    const j = await res.json();
    return (((j.choices || [])[0] || {}).message || {}).content || "";
  },
  parseJSON(txt) {
    let t = String(txt).replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("la réponse de l'IA ne contient pas de quiz au format attendu.");
    return JSON.parse(t.slice(a, b + 1));
  }
};

/* ---------- Extraction du texte des documents (dans le navigateur) ---------- */
const Extract = {
  _loaded: {},
  async lib(name) {
    if (this._loaded[name]) return;
    const src = { pdf: "assets/js/vendor/pdf.min.js", docx: "assets/js/vendor/mammoth.browser.min.js", zip: "assets/js/vendor/jszip.min.js" }[name];
    await loadScript(src);
    if (name === "pdf") window.pdfjsLib.GlobalWorkerOptions.workerSrc = "assets/js/vendor/pdf.worker.min.js";
    this._loaded[name] = true;
  },
  supported(f) { return ["pdf", "docx", "pptx", "txt", "md", "csv", "py", "c", "h", "cpp", "java", "m", "ipynb"].includes(Docs.ext(f.nom)); },
  async text(f) {
    const e = Docs.ext(f.nom); const blob = await Docs.blob(f);
    if (e === "pdf") {
      await this.lib("pdf");
      const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise; const out = [];
      for (let i = 1; i <= pdf.numPages; i++) { const tc = await (await pdf.getPage(i)).getTextContent(); out.push(tc.items.map((x) => x.str).join(" ")); }
      return out.join("\n");
    }
    if (e === "docx") { await this.lib("docx"); return (await window.mammoth.extractRawText({ arrayBuffer: await blob.arrayBuffer() })).value; }
    if (e === "pptx") {
      await this.lib("zip"); const zip = await window.JSZip.loadAsync(await blob.arrayBuffer());
      const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
      const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
      const out = [];
      for (const [i, n] of slides.entries()) { const x = await zip.file(n).async("string"); out.push(`[Diapositive ${i + 1}] ` + [...x.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => dec(m[1])).join(" ")); }
      return out.join("\n");
    }
    if (e === "ipynb") { const nb = JSON.parse(await blob.text()); return (nb.cells || []).map((c) => [].concat(c.source || []).join("")).join("\n\n"); }
    return blob.text();
  },
  clean: (s) => String(s || "").replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
};

/* ---------- Service quiz (données) ---------- */
const QuizSvc = {
  MAX_TEXT: 60000,
  all: () => Store.all("quiz"),
  corrige(qid) { return Store.get("quiz_corriges", qid) || null; },
  async fetchCorrige(qid) {
    const loc = this.corrige(qid); if (loc || Store.mode !== "firebase") return loc;
    try { const s = await Store.fs.collection("quiz_corriges").doc(qid).get(); if (!s.exists) return null; const d = s.data(); Store._local("quiz_corriges", d); return d; }
    catch (e) { return null; }
  },
  responses: (qid) => Store.all("quiz_reponses").filter((r) => r.quizId === qid),
  async refreshResponses(qid) {
    if (Store.mode !== "firebase") return;
    const docs = (await Store.fs.collection("quiz_reponses").where("quizId", "==", qid).get()).docs.map((d) => d.data());
    Store.data.quiz_reponses = [...Store.all("quiz_reponses").filter((r) => r.quizId !== qid), ...docs];
  },
  /* Note d'une copie : QCM et Vrai/Faux tout ou rien ; choix multiples avec points partiels (bonnes cochées − mauvaises cochées) */
  gradeQ(q, sel, cor) {
    const good = new Set((cor && cor.bonnes) || []); const s = new Set(sel || []); const pts = +q.points || 1;
    if (!good.size) return 0;
    if (q.type === "multi") { let ok = 0, ko = 0; s.forEach((i) => (good.has(i) ? ok++ : ko++)); return Math.max(0, (ok - ko) / good.size) * pts; }
    return s.size === 1 && good.has([...s][0]) ? pts : 0;
  },
  grade(quiz, r, corr) {
    const total = quiz.questions.reduce((a, q) => a + (+q.points || 1), 0);
    const score = quiz.questions.reduce((a, q) => a + this.gradeQ(q, r.reponses[q.id], corr.reponses[q.id]), 0);
    return { score, total, sur20: total ? (score / total) * 20 : 0 };
  },
  isOpen(q, now = Date.now()) { return q.statut === "publie" && (!q.ouvertureMs || now >= q.ouvertureMs) && (!q.fermetureMs || now <= q.fermetureMs); },
  isClosed(q, now = Date.now()) { return q.statut === "ferme" || (q.fermetureMs && now > q.fermetureMs); },
  when(q) { return q.ouverture || q.fermeture ? `${q.ouverture ? "du " + fmtDT(q.ouverture) : ""}${q.fermeture ? " au " + fmtDT(q.fermeture) : ""}`.trim() : "sans limite de date"; },
  n20: (x) => (Math.round(x * 100) / 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 })
};
function fmtDT(s) { if (!s) return ""; const [d, h] = s.split("T"); return `${fmtDate(d)}${h ? " à " + h.slice(0, 5) : ""}`; }
function shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* ---------- Paramètres de l'IA (Administration › Paramètres, ou clé personnelle de l'enseignant) ---------- */
function IASettingsForm(c, { perso } = {}) {
  const prov = c.provider || "openrouter";
  return `<div class="form-grid">
    <div class="full"><label>Service</label><select name="provider">${Object.entries(IA_PRESETS).map(([k, p]) => `<option value="${k}" ${k === prov ? "selected" : ""}>${esc(p.nom)}</option>`).join("")}</select><div class="hint" id="ia-aide">${esc(IA_PRESETS[prov].aide)}</div></div>
    <div><label>Adresse de l'API</label><input name="baseUrl" value="${esc(c.baseUrl || IA_PRESETS[prov].baseUrl)}" placeholder="https://…/v1"></div>
    <div><label>Modèle</label><input name="model" list="ia-models" value="${esc(c.model || IA_PRESETS[prov].model)}" placeholder="ex. qwen-plus">
      <datalist id="ia-models"><option value="qwen/qwen3-30b-a3b:free">Qwen3 30B — gratuit (OpenRouter)</option><option value="qwen/qwen3-next-80b-a3b-instruct">Qwen3 Next 80B — payant, très bon marché (OpenRouter)</option><option value="qwen-plus">qwen-plus (Model Studio)</option><option value="qwen-max">qwen-max (Model Studio)</option></datalist>
      <div class="hint">Les modèles gratuits « :free » changent souvent ; si l'un est retiré, choisissez-en un autre dans la liste.</div></div>
    <div class="full"><label>Clé API</label><input name="apiKey" type="password" autocomplete="off" value="${esc(c.apiKey)}" placeholder="sk-…"><div class="hint">${perso ? "Enregistrée uniquement dans ce navigateur." : "Visible par les enseignants et l'administration uniquement (jamais par les étudiants)."} Fixez une limite de dépense sur le compte du service.</div></div></div>`;
}
function bindIAForm(root) {
  const f = root.querySelector('[name="provider"]').form || root;
  root.querySelector('[name="provider"]').onchange = (e) => { const p = IA_PRESETS[e.target.value]; root.querySelector('[name="baseUrl"]').value = p.baseUrl; root.querySelector('[name="model"]').value = p.model; root.querySelector("#ia-aide").textContent = p.aide; };
  return f;
}
const readIAForm = (f) => ({ provider: f.provider.value, baseUrl: f.baseUrl.value.trim(), model: f.model.value.trim(), apiKey: f.apiKey.value.trim() });
async function testIA(btn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = "Test en cours…";
  try { const t = await IA.chat([{ role: "user", content: 'Réponds uniquement par le JSON {"ok": true}' }]); IA.parseJSON(t); UI.toast("✅ Le service d'IA répond correctement (" + IA.label() + ")."); }
  catch (e) { UI.toast("Échec du test : " + e.message); }
  finally { btn.disabled = false; btn.textContent = old; }
}
function IASettingsCard() {
  return `<div class="card" style="grid-column:1/-1"><h3>Intelligence artificielle (génération des quiz)</h3>
    <p class="muted">Le modèle d'IA rédige les quiz à partir des documents des contenus pédagogiques. Recommandé : <b>OpenRouter</b> avec un modèle <b>Qwen</b> gratuit, ou <b>Alibaba Cloud Model Studio</b> (Qwen officiel, payant à l'usage). Tout service compatible avec l'API OpenAI fonctionne.</p>
    <form id="iacfg">${IASettingsForm(IA.shared())}<div class="toolbar" style="margin-top:12px"><button class="btn">Enregistrer</button><button type="button" class="btn outline" id="iatest">Tester</button>
      <span class="muted">${IA.shared().apiKey ? "✅ Configuré : " + esc(IA.shared().model) : "Non configuré"}</span></div></form></div>`;
}
function bindIASettings(el) {
  const f = $("#iacfg", el); if (!f) return; bindIAForm(f);
  f.onsubmit = async (e) => { e.preventDefault(); try { await IA.saveShared(readIAForm(f)); UI.toast("Paramètres de l'IA enregistrés."); } catch (err) { UI.toast("Échec : " + err.message); } };
  $("#iatest", el).onclick = async (e) => { const keep = IA.shared(); const tmp = readIAForm(f);
    if (Store.mode === "firebase") Store.data.ia = tmp; else Store.settings().ia = tmp;
    const p = IA.perso(); localStorage.removeItem(IA.PERSO);
    await testIA(e.target);
    if (Store.mode === "firebase") Store.data.ia = keep; else Store.settings().ia = keep; if (p.apiKey) IA.savePerso(p); };
}
function iaPersoDialog(onDone) {
  const md = UI.modal({
    title: "Ma clé d'IA personnelle", submitLabel: "Enregistrer",
    body: `<p class="muted">Facultatif : utilisez votre propre clé à la place de celle de la plateforme. Elle reste dans ce navigateur.</p>${IASettingsForm(IA.perso(), { perso: true })}
      <div class="toolbar" style="margin-top:10px"><button type="button" class="btn outline sm" id="ia-rm">Supprimer ma clé</button></div>`,
    onSubmit: (f) => { IA.savePerso(readIAForm(f)); UI.toast("Clé personnelle enregistrée."); if (onDone) onDone(); }
  });
  bindIAForm(md); $("#ia-rm", md).onclick = () => { IA.savePerso(null); md.remove(); UI.toast("Clé personnelle supprimée."); if (onDone) onDone(); };
}

/* ======================================================================
   Espace enseignant / administrateur
   ctx : { modules, profId (null = admin), user }
   ====================================================================== */
function QuizView(el, ctx) {
  const st = { view: "list", id: null, module: "" };
  const mine = () => QuizSvc.all().filter((q) => ctx.modules.includes(q.module) && (!ctx.profId || q.profId === ctx.profId) && (!st.module || q.module === st.module))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const myContents = () => Store.all("contents").filter((c) => ctx.modules.includes(c.module) && (!ctx.profId || c.profId === ctx.profId));
  const expected = (q) => Store.all("students").filter((s) => !s.inactif && (q.sections || []).includes(sectionOf(s)));
  const go = (view, id) => { st.view = view; st.id = id || null; draw(); window.scrollTo(0, 0); };
  const draw = () => {
    const q = st.id && Store.get("quiz", st.id);
    if (st.view === "edit") return drawEdit(q);
    if (st.view === "results" && q) return drawResults(q);
    if (st.view === "preview" && q) return drawPreview(q);
    drawList();
  };

  /* ---- Liste ---- */
  const drawList = () => {
    st.view = "list";
    const list = mine();
    el.innerHTML = `<div class="page-head"><h1>Quiz</h1><div class="toolbar">
        <div class="f"><select id="q-mod"><option value="">Tous les modules</option>${UI.moduleOptions(ctx.modules, st.module)}</select></div>
        <button class="btn" id="q-add">✨ Nouveau quiz</button></div></div>
      <div class="alert ${IA.configured() ? "info" : "warn"}" style="margin-bottom:14px">${IA.configured()
        ? `Génération automatique par l'IA : <b>${esc(IA.label())}</b>. Choisissez une ou plusieurs parties d'un contenu pédagogique, l'IA propose les questions, vous les relisez puis publiez le quiz pour vos sections.`
        : `L'IA n'est pas encore configurée${ctx.profId ? " par l'administration" : " (onglet Paramètres)"}. Vous pouvez quand même créer des quiz à la main${ctx.profId ? ", ou utiliser votre propre clé" : ""}.`}
        ${ctx.profId ? ` <a href="#" id="q-key">${IA.perso().apiKey ? "Gérer ma clé personnelle" : "Utiliser ma propre clé"}</a>` : ""}</div>
      ${list.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Quiz</th><th>Sections</th><th>Questions</th><th>Période</th><th>Copies</th><th>Moyenne</th><th>Statut</th><th></th></tr></thead><tbody>
        ${list.map((q) => { const rs = QuizSvc.responses(q.id); const who = new Set(rs.map((r) => r.studentId)); const cor = QuizSvc.corrige(q.id);
          const best = cor ? [...who].map((sid) => Math.max(...rs.filter((r) => r.studentId === sid).map((r) => QuizSvc.grade(q, r, cor).sur20))) : [];
          const avg = best.length ? best.reduce((a, b) => a + b, 0) / best.length : null;
          return `<tr><td><a href="#" data-res="${q.id}"><b>${esc(q.titre)}</b></a><div class="muted">${esc(UI.moduleLabel(q.module))}${ctx.profId ? "" : " · " + esc(UI.profName(q.profId))}</div></td>
          <td>${(q.sections || []).map((s) => `<span class="pill sec">${s}</span>`).join(" ")}</td><td>${q.questions.length}</td>
          <td class="muted" style="font-size:13px">${esc(QuizSvc.when(q))}${q.duree ? `<br>${q.duree} min` : ""}</td>
          <td>${who.size} / ${expected(q).length}</td><td>${avg === null ? "—" : `<b>${QuizSvc.n20(avg)}</b>/20`}</td><td>${QZ_STATUT[q.statut] || q.statut}</td>
          <td class="actions"><button class="btn sm" data-res="${q.id}">Résultats</button> <button class="btn outline sm" data-prev="${q.id}">Aperçu</button>
            ${q.statut === "publie" ? `<button class="btn outline sm" data-st="ferme" data-id="${q.id}">Fermer</button>` : `<button class="btn outline sm" data-st="publie" data-id="${q.id}">${q.statut === "ferme" ? "Rouvrir" : "Publier"}</button>`}
            <button class="btn outline sm" data-edit="${q.id}">Modifier</button> <button class="btn outline sm" data-dup="${q.id}">Dupliquer</button> <button class="btn danger sm" data-del="${q.id}">Supprimer</button></td></tr>`; }).join("")}
        </tbody></table></div>` : `<div class="alert info">Aucun quiz pour le moment. Cliquez sur « Nouveau quiz ».</div>`}`;
    $("#q-mod", el).onchange = (e) => { st.module = e.target.value; draw(); };
    $("#q-add", el).onclick = () => go("edit");
    if ($("#q-key", el)) $("#q-key", el).onclick = (e) => { e.preventDefault(); iaPersoDialog(draw); };
    $$("[data-res]", el).forEach((b) => b.onclick = (e) => { e.preventDefault(); go("results", b.dataset.res); });
    $$("[data-prev]", el).forEach((b) => b.onclick = () => go("preview", b.dataset.prev));
    $$("[data-edit]", el).forEach((b) => b.onclick = () => go("edit", b.dataset.edit));
    $$("[data-st]", el).forEach((b) => b.onclick = () => { setStatut(Store.get("quiz", b.dataset.id), b.dataset.st); draw(); });
    $$("[data-dup]", el).forEach((b) => b.onclick = () => duplicate(Store.get("quiz", b.dataset.dup)));
    $$("[data-del]", el).forEach((b) => b.onclick = () => {
      const q = Store.get("quiz", b.dataset.del); const n = QuizSvc.responses(q.id).length;
      if (!UI.confirm(`Supprimer le quiz « ${q.titre} »${n ? ` et les ${n} copie(s) des étudiants` : ""} ?`)) return;
      QuizSvc.responses(q.id).forEach((r) => Store.del("quiz_reponses", r.id)); Store.del("quiz_corriges", q.id); Store.del("quiz", q.id); draw();
    });
  };

  const setStatut = (q, s) => {
    const was = q.statut; q.statut = s; q.updatedAt = new Date().toISOString(); Store.put("quiz", q);
    if (s === "publie" && was === "brouillon") announce(q);
    UI.toast({ publie: was === "ferme" ? "Quiz rouvert." : "Quiz publié.", ferme: "Quiz fermé : les étudiants ne peuvent plus répondre et voient le corrigé.", brouillon: "Quiz retiré." }[s]);
  };
  const announce = (q) => {
    const author = ctx.profId ? UI.profName(ctx.profId) : "Administration";
    const info = `${q.questions.length} questions${q.duree ? `, ${q.duree} min` : ""}, ${QuizSvc.when(q)}`;
    (q.sections || []).forEach((sec) => Store.put("messages", { module: q.module, section: sec, authorRole: ctx.profId ? "prof" : "admin", authorId: ctx.user.id, authorName: author,
      text: `📝 Nouveau quiz : ${q.titre} (${info}) — onglet « Quiz »`, system: true, date: new Date().toISOString() }));
    Diffusion.send({ sections: q.sections, subject: `Nouveau quiz — ${q.module} : ${q.titre}`,
      body: `Bonjour,\n\nUn nouveau quiz est disponible : « ${q.titre} »\nModule : ${UI.moduleLabel(q.module)}\n${info}\nNombre de tentatives : ${q.tentatives ? q.tentatives : "illimité"}${q.consignes ? `\n\nConsignes : ${q.consignes}` : ""}\n\nRépondez depuis votre Espace Étudiant, onglet « Quiz » : ${siteBase()}etudiant.html\n\nCordialement,\n${author}` });
  };
  const duplicate = (q) => {
    const id = uid(); const cor = QuizSvc.corrige(q.id);
    Store.put("quiz", { ...JSON.parse(JSON.stringify(q)), id, titre: q.titre + " (copie)", statut: "brouillon", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    if (cor) Store.put("quiz_corriges", { ...JSON.parse(JSON.stringify(cor)), id, quizId: id });
    UI.toast("Quiz dupliqué (brouillon)."); go("edit", id);
  };

  /* ---- Création / modification ---- */
  const drawEdit = (orig) => {
    const cor0 = orig ? QuizSvc.corrige(orig.id) : null;
    const contents = myContents();
    const c0 = orig && orig.source && contents.find((c) => c.id === orig.source.contentId) || contents.find((c) => c.module === st.module) || contents[0];
    const now = new Date(); const pad = (n) => String(n).padStart(2, "0");
    const dt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const S = orig ? { ...JSON.parse(JSON.stringify(orig)), questions: orig.questions.map((q) => ({ ...q, ...((cor0 && cor0.reponses[q.id]) || { bonnes: [], explication: "" }) })) }
      : { module: c0 ? c0.module : ctx.modules[0], titre: "", consignes: "", sections: c0 ? [...(c0.sections || [])] : sectionsOfYear(yearOfModule(ctx.modules[0])), questions: [],
          ouverture: dt(now), fermeture: dt(new Date(now.getTime() + 7 * 864e5)), duree: 20, tentatives: 1, corrige: "immediat", melanger: true, statut: "brouillon",
          source: { contentId: c0 ? c0.id : "", fichiers: [] } };
    const sel = new Set((S.source && S.source.fichiers) || []);

    el.innerHTML = `<div class="page-head"><h1><a href="#" class="back" id="q-back">←</a> ${orig ? "Modifier le quiz" : "Nouveau quiz"}</h1></div>
      <div class="panel"><div class="panel-h">1. Partie(s) du contenu pédagogique</div><div class="panel-b">
        ${contents.length ? `<div class="form-grid"><div class="full"><label>Contenu pédagogique</label><select id="q-content">${contents.map((c) => `<option value="${c.id}" ${S.source && S.source.contentId === c.id ? "selected" : ""}>${esc(c.module)} — ${esc(c.titre)}</option>`).join("")}</select></div></div>
          <div id="q-tree" class="qz-tree"></div>` : `<p class="muted">Aucun contenu pédagogique : ajoutez d'abord des documents dans l'onglet « Contenus pédagogiques », ou rédigez les questions à la main.</p>`}
        <label style="margin-top:10px">Texte complémentaire (facultatif : notes, plan du cours, passage à cibler…)</label><textarea id="q-extra" placeholder="Collez ici un texte que l'IA doit aussi utiliser."></textarea></div></div>
      <div class="panel"><div class="panel-h">2. Génération par l'IA <span style="font-weight:400;opacity:.85">${esc(IA.label())}</span></div><div class="panel-b">
        <div class="form-grid">
          <div><label>Nombre de questions</label><input type="number" id="g-n" min="1" max="40" value="10"></div>
          <div><label>Difficulté</label><select id="g-diff"><option value="mixte">Mélange facile / moyen / difficile</option><option value="facile">Facile (connaissances)</option><option value="moyenne">Moyenne (compréhension)</option><option value="difficile">Difficile (application, analyse)</option></select></div>
          <div class="full"><label>Types de questions</label><div class="checks">${Object.entries(QZ_TYPES).map(([k, v]) => `<label><input type="checkbox" name="g-type" value="${k}" checked> ${v}</label>`).join("")}</div></div>
          <div class="full"><label>Consigne pour l'IA (facultatif)</label><input id="g-hint" placeholder="ex. insister sur les interruptions et les timers ; inclure des questions de calcul simples"></div></div>
        <div class="toolbar" style="margin-top:12px"><button type="button" class="btn" id="g-go" ${IA.configured() ? "" : "disabled"}>✨ Générer les questions</button>
          <label style="font-weight:400"><input type="checkbox" id="g-add" style="width:auto"> Ajouter aux questions existantes (sinon : remplacer)</label>
          ${ctx.profId ? `<a href="#" id="g-key">${IA.configured() ? "Changer de clé" : "Utiliser ma propre clé"}</a>` : ""}</div>
        <div id="g-status" class="muted" style="margin-top:8px"></div></div></div>
      <div class="panel"><div class="panel-h">3. Questions <span id="q-count" style="font-weight:400;opacity:.85"></span><button type="button" class="btn sm light" id="q-addq">+ Ajouter une question</button></div><div class="panel-b" id="q-list"></div></div>
      <div class="panel"><div class="panel-h">4. Paramètres et partage</div><div class="panel-b"><form id="q-form" class="form-grid">
        <div class="full"><label>Titre du quiz</label><input name="titre" required value="${esc(S.titre)}" placeholder="ex. Quiz 1 — Architecture des microcontrôleurs"></div>
        <div class="full"><label>Module</label><select name="module">${UI.moduleOptions(ctx.modules, S.module)}</select></div>
        <div class="full"><label>Consignes pour les étudiants (facultatif)</label><textarea name="consignes">${esc(S.consignes)}</textarea></div>
        <div class="full"><label>Partagé avec</label><div class="checks" id="q-secs"></div><div class="hint">Formation initiale (TN) et/ou formation à temps aménagé (TAM).</div></div>
        <div><label>Ouverture</label><input type="datetime-local" name="ouverture" value="${esc(S.ouverture)}"></div>
        <div><label>Fermeture</label><input type="datetime-local" name="fermeture" value="${esc(S.fermeture)}"></div>
        <div><label>Durée (minutes, 0 = sans limite)</label><input type="number" name="duree" min="0" max="300" value="${+S.duree || 0}"></div>
        <div><label>Tentatives (0 = illimité)</label><input type="number" name="tentatives" min="0" max="20" value="${+S.tentatives || 0}"></div>
        <div class="full"><label>Correction</label><select name="corrige"><option value="immediat" ${S.corrige === "immediat" ? "selected" : ""}>Note et corrigé affichés dès la remise de la copie</option><option value="fermeture" ${S.corrige === "fermeture" ? "selected" : ""}>Note et corrigé affichés après la fermeture du quiz</option></select></div>
        <div class="full checks"><label><input type="checkbox" name="melanger" ${S.melanger ? "checked" : ""}> Mélanger l'ordre des questions et des propositions pour chaque étudiant</label></div>
        <div class="full toolbar"><button class="btn outline" name="draft" value="1">Enregistrer le brouillon</button><button class="btn" name="pub" value="1">${orig && orig.statut === "publie" ? "Enregistrer (publié)" : "Enregistrer et publier"}</button><button type="button" class="btn outline" id="q-cancel">Annuler</button></div>
      </form></div></div>`;

    const form = $("#q-form", el);
    const fillSecs = () => { const y = yearOfModule(form.module.value); $("#q-secs", el).innerHTML = sectionsOfYear(y).map((s) => `<label><input type="checkbox" name="sec" value="${s}" ${S.sections.includes(s) ? "checked" : ""}> ${s} — ${esc(S2I.formations[s.split("-")[0]])}</label>`).join("");
      $$('input[name="sec"]', el).forEach((i) => (i.onchange = () => { S.sections = $$('input[name="sec"]:checked', el).map((x) => x.value); })); };
    form.module.onchange = () => { S.module = form.module.value; S.sections = sectionsOfYear(yearOfModule(S.module)); fillSecs(); };
    fillSecs();

    /* Arborescence : rubrique > sous-dossier > document */
    const drawTree = () => {
      const box = $("#q-tree", el); if (!box) return;
      const c = Store.get("contents", $("#q-content", el).value); if (!c) { box.innerHTML = ""; return; }
      const rubs = Object.entries(RUBRIQUES).map(([k, v]) => {
        const ds = (c.dossiers || []).filter((d) => d.rubrique === k).map((d) => ({ d, fs: Docs.ofFolder(c.id, d.id) })).filter((x) => x.fs.length);
        if (!ds.length) return "";
        return `<div class="qz-rub"><label class="qz-l1"><input type="checkbox" data-grp="r:${k}"> ${RUB_ICO[k]} ${v}</label>
          ${ds.map(({ d, fs }) => `<div class="qz-dir"><label class="qz-l2"><input type="checkbox" data-grp="d:${d.id}" data-in="r:${k}"> 📁 ${esc(d.nom)}</label>
            ${fs.map((f) => `<label class="qz-l3 ${Extract.supported(f) ? "" : "muted"}"><input type="checkbox" data-f="${f.id}" data-in="r:${k} d:${d.id}" ${sel.has(f.id) ? "checked" : ""} ${Extract.supported(f) ? "" : "disabled"}> ${Docs.icon(f.nom)} ${esc(f.nom)} <span class="muted">${Docs.size(f.taille)}${Extract.supported(f) ? "" : " · format non lu par l'IA"}</span></label>`).join("")}</div>`).join("")}</div>`;
      }).join("");
      box.innerHTML = rubs ? `<p class="hint" style="margin:8px 0">Cochez une rubrique, un ou plusieurs sous-dossiers ou des documents précis. Formats lus : PDF, Word (.docx), PowerPoint (.pptx), texte, notebooks.</p>${rubs}<div class="hint" id="q-selinfo"></div>`
        : `<p class="muted" style="margin-top:8px">Ce contenu n'a pas encore de document.</p>`;
      const sync = () => {
        $$("[data-grp]", box).forEach((g) => { const fs = $$(`[data-f][data-in~="${g.dataset.grp}"]:not(:disabled)`, box); const n = fs.filter((x) => x.checked).length; g.checked = fs.length && n === fs.length; g.indeterminate = n > 0 && n < fs.length; });
        sel.clear(); $$("[data-f]:checked", box).forEach((x) => sel.add(x.dataset.f));
        const info = $("#q-selinfo", box); if (info) info.textContent = sel.size ? `${sel.size} document(s) sélectionné(s).` : "Aucun document sélectionné.";
      };
      $$("[data-grp]", box).forEach((g) => (g.onchange = () => { $$(`[data-f][data-in~="${g.dataset.grp}"]:not(:disabled)`, box).forEach((x) => (x.checked = g.checked)); sync(); }));
      $$("[data-f]", box).forEach((x) => (x.onchange = sync));
      sync();
    };
    if ($("#q-content", el)) { $("#q-content", el).onchange = () => { sel.clear(); const c = Store.get("contents", $("#q-content", el).value);
      if (c && !orig) { form.module.value = c.module; S.module = c.module; S.sections = [...(c.sections || [])]; fillSecs(); } drawTree(); }; drawTree(); }

    /* Éditeur des questions */
    const qList = $("#q-list", el);
    const blank = (type = "qcm") => ({ id: uid(), type, enonce: "", choix: type === "vf" ? ["Vrai", "Faux"] : ["", "", "", ""], bonnes: [], explication: "", points: 1 });
    const drawQs = () => {
      $("#q-count", el).textContent = S.questions.length ? `${S.questions.length} question(s) · ${S.questions.reduce((a, q) => a + (+q.points || 1), 0)} point(s)` : "";
      qList.innerHTML = S.questions.length ? S.questions.map((q, i) => `<div class="qz-q" data-i="${i}">
        <div class="qz-q-h"><b>Q${i + 1}</b><select data-k="type">${Object.entries(QZ_TYPES).map(([k, v]) => `<option value="${k}" ${q.type === k ? "selected" : ""}>${v}</option>`).join("")}</select>
          <label style="font-weight:400;display:flex;gap:4px;align-items:center;margin:0"><input type="number" data-k="points" min="0.25" step="0.25" value="${+q.points || 1}" style="width:72px"> pt</label>
          ${q.source ? `<span class="muted" title="Document source">📄 ${esc(q.source)}</span>` : ""}
          <span class="qz-q-a"><button type="button" class="btn outline sm" data-mv="-1" ${i ? "" : "disabled"}>↑</button><button type="button" class="btn outline sm" data-mv="1" ${i < S.questions.length - 1 ? "" : "disabled"}>↓</button><button type="button" class="btn danger sm" data-rm>Supprimer</button></span></div>
        <textarea data-k="enonce" placeholder="Énoncé de la question" rows="2">${esc(q.enonce)}</textarea>
        <div class="qz-choix">${q.choix.map((c, j) => `<div class="qz-c"><input type="${q.type === "multi" ? "checkbox" : "radio"}" name="ok${i}" data-ok="${j}" ${q.bonnes.includes(j) ? "checked" : ""} title="Bonne réponse">
          <input data-ch="${j}" value="${esc(c)}" placeholder="Proposition ${j + 1}" ${q.type === "vf" ? "readonly" : ""}>${q.type === "vf" ? "" : `<button type="button" class="btn outline sm" data-rmc="${j}" ${q.choix.length > 2 ? "" : "disabled"}>✕</button>`}</div>`).join("")}
          ${q.type === "vf" ? "" : `<button type="button" class="btn outline sm" data-addc ${q.choix.length < 8 ? "" : "disabled"}>+ Proposition</button>`}</div>
        <input data-k="explication" value="${esc(q.explication)}" placeholder="Explication affichée dans le corrigé (facultatif)">
        ${q.bonnes.length ? "" : `<div class="qz-warn">⚠ Cochez la ou les bonnes réponses.</div>`}</div>`).join("")
        : `<p class="muted" style="margin:0">Aucune question. Générez-les avec l'IA ou cliquez sur « Ajouter une question ».</p>`;
      $$(".qz-q", qList).forEach((box) => {
        const q = S.questions[+box.dataset.i];
        $$("[data-k]", box).forEach((inp) => (inp.oninput = inp.onchange = () => {
          const k = inp.dataset.k;
          if (k === "type") { const was = q.type; q.type = inp.value;
            if (q.type === "vf") { q.choix = ["Vrai", "Faux"]; q.bonnes = q.bonnes.filter((x) => x < 2).slice(0, 1); }
            else if (was === "vf") { q.choix = [...q.choix, "", ""]; }
            if (q.type === "qcm") q.bonnes = q.bonnes.slice(0, 1);
            drawQs(); return; }
          q[k] = k === "points" ? +inp.value || 1 : inp.value;
          if (k === "points") $("#q-count", el).textContent = `${S.questions.length} question(s) · ${S.questions.reduce((a, x) => a + (+x.points || 1), 0)} point(s)`;
        }));
        $$("[data-ch]", box).forEach((inp) => (inp.oninput = () => { q.choix[+inp.dataset.ch] = inp.value; }));
        $$("[data-ok]", box).forEach((inp) => (inp.onchange = () => { q.bonnes = $$("[data-ok]", box).filter((x) => x.checked).map((x) => +x.dataset.ok); drawQs(); }));
        $$("[data-rmc]", box).forEach((b) => (b.onclick = () => { const j = +b.dataset.rmc; q.choix.splice(j, 1); q.bonnes = q.bonnes.filter((x) => x !== j).map((x) => (x > j ? x - 1 : x)); drawQs(); }));
        if ($("[data-addc]", box)) $("[data-addc]", box).onclick = () => { q.choix.push(""); drawQs(); };
        $("[data-rm]", box).onclick = () => { if (q.enonce && !UI.confirm("Supprimer cette question ?")) return; S.questions.splice(+box.dataset.i, 1); drawQs(); };
        $$("[data-mv]", box).forEach((b) => (b.onclick = () => { const i = +box.dataset.i, j = i + +b.dataset.mv; [S.questions[i], S.questions[j]] = [S.questions[j], S.questions[i]]; drawQs(); }));
      });
    };
    drawQs();
    $("#q-addq", el).onclick = () => { S.questions.push(blank()); drawQs(); const l = $$(".qz-q", qList).pop(); if (l) { l.scrollIntoView({ behavior: "smooth", block: "center" }); $("textarea", l).focus(); } };

    /* Génération */
    const status = $("#g-status", el);
    if ($("#g-key", el)) $("#g-key", el).onclick = (e) => { e.preventDefault(); iaPersoDialog(() => { $("#g-go", el).disabled = !IA.configured(); }); };
    $("#g-go", el).onclick = async () => {
      const btn = $("#g-go", el);
      const c = $("#q-content", el) ? Store.get("contents", $("#q-content", el).value) : null;
      const files = [...sel].map((id) => Store.get("fichiers", id)).filter(Boolean);
      const extra = $("#q-extra", el).value.trim();
      if (!files.length && !extra) return UI.toast("Sélectionnez au moins un document (ou collez un texte).");
      const n = Math.max(1, Math.min(40, +$("#g-n", el).value || 10));
      const types = $$('input[name="g-type"]:checked', el).map((x) => x.value); if (!types.length) return UI.toast("Choisissez au moins un type de question.");
      btn.disabled = true;
      try {
        const parts = [];
        for (const [i, f] of files.entries()) {
          status.textContent = `⏳ Lecture des documents (${i + 1}/${files.length}) : ${f.nom}…`;
          const d = c && (c.dossiers || []).find((x) => x.id === f.dossierId);
          try { const t = Extract.clean(await Extract.text(f)); if (t) parts.push({ nom: f.nom, lieu: `${RUBRIQUES[f.rubrique] || ""}${d ? " / " + d.nom : ""}`, t }); else UI.toast(`« ${f.nom} » ne contient pas de texte lisible (document scanné ?).`); }
          catch (e) { console.error(e); UI.toast(`Lecture impossible de « ${f.nom} » : ${e.message || e}`); }
        }
        if (extra) parts.push({ nom: "Texte complémentaire de l'enseignant", lieu: "", t: extra });
        if (!parts.length) throw new Error("aucun texte n'a pu être extrait des documents choisis.");
        const per = Math.floor(QuizSvc.MAX_TEXT / parts.length); let cut = false;
        const corpus = parts.map((p) => { if (p.t.length > per) cut = true; return `### Document : ${p.nom}${p.lieu ? ` (${p.lieu})` : ""}\n${p.t.slice(0, per)}`; }).join("\n\n");
        status.textContent = `⏳ L'IA rédige ${n} question(s) à partir de ${parts.length} document(s)${cut ? " (textes longs : extraits)" : ""}… (jusqu'à une minute)`;
        const diff = { mixte: "un mélange équilibré de questions faciles, moyennes et difficiles", facile: "facile (connaissances, définitions)", moyenne: "moyenne (compréhension)", difficile: "difficile (application, raisonnement, analyse de cas)" }[$("#g-diff", el).value];
        const prompt = `Support de cours (texte extrait des documents) :
<<<
${corpus}
>>>

Rédige un quiz d'évaluation en français pour des étudiants de master en systèmes industriels intelligents, à partir de ce support uniquement.
Contraintes :
- Exactement ${n} questions, réparties entre ces types : ${types.map((t) => ({ qcm: '"qcm" (4 propositions, une seule bonne)', multi: '"multi" (4 ou 5 propositions, au moins deux bonnes)', vf: '"vf" (propositions ["Vrai","Faux"])' })[t]).join(", ")}.
- Difficulté : ${diff}.
- Chaque question vérifie une notion importante du support ; pas de question sur la mise en page, les auteurs ou la numérotation des diapositives.
- Propositions fausses plausibles, de longueur comparable aux bonnes ; pas de « toutes les réponses ci-dessus ».
- Couvre l'ensemble des documents fournis.
${$("#g-hint", el).value.trim() ? "- Consigne de l'enseignant : " + $("#g-hint", el).value.trim() + "\n" : ""}
Réponds uniquement avec un objet JSON valide, sans texte autour, de la forme :
{"questions":[{"type":"qcm","enonce":"…","choix":["…","…","…","…"],"bonnes":[0],"explication":"justification courte (1 ou 2 phrases)","source":"nom du document"}]}
"bonnes" contient les indices (à partir de 0) des bonnes propositions.`;
        const txt = await IA.chat([{ role: "system", content: "Tu es un enseignant universitaire expert qui rédige des quiz d'évaluation rigoureux en français. Tu réponds uniquement avec du JSON valide." }, { role: "user", content: prompt }]);
        const data = IA.parseJSON(txt);
        const qs = (data.questions || []).map((q) => {
          let type = ["qcm", "multi", "vf"].includes(q.type) ? q.type : "qcm";
          let choix = (q.choix || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8);
          let bonnes = [...new Set((q.bonnes || []).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x < choix.length))];
          if (type === "vf") { const good = choix[bonnes[0]] || ""; choix = ["Vrai", "Faux"]; bonnes = [/^f/i.test(good) ? 1 : 0]; }
          if (type === "qcm" && bonnes.length > 1) type = "multi";
          if (type === "multi" && bonnes.length === 1) type = "qcm";
          return { id: uid(), type, enonce: String(q.enonce || "").trim(), choix, bonnes, explication: String(q.explication || "").trim(), points: 1, source: String(q.source || "").slice(0, 120) };
        }).filter((q) => q.enonce && q.choix.length >= 2 && q.bonnes.length);
        if (!qs.length) throw new Error("l'IA n'a renvoyé aucune question exploitable. Réessayez ou changez de modèle.");
        S.questions = $("#g-add", el).checked ? [...S.questions, ...qs] : qs;
        if (!form.titre.value.trim()) form.titre.value = `Quiz — ${c ? c.titre : UI.moduleLabel(form.module.value)}`;
        S.source = { contentId: c ? c.id : "", fichiers: [...sel] };
        drawQs();
        status.innerHTML = `✅ ${qs.length} question(s) générée(s)${qs.length < n ? ` sur ${n} demandées` : ""}. <b>Relisez-les</b> et corrigez-les si besoin avant de publier.`;
        $("#q-list", el).scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) { console.error(e); status.textContent = "❌ Échec : " + (e.message || e); }
      finally { btn.disabled = !IA.configured(); }
    };

    /* Enregistrement */
    $("#q-back", el).onclick = $("#q-cancel", el).onclick = (e) => { e.preventDefault(); if (S.questions.length && !orig && !UI.confirm("Quitter sans enregistrer ?")) return; go("list"); };
    let publishClicked = false;
    form.pub.onclick = () => { publishClicked = true; }; form.draft.onclick = () => { publishClicked = false; };
    form.onsubmit = (e) => {
      e.preventDefault();
      const f = form; const sections = $$('input[name="sec"]:checked', el).map((x) => x.value);
      if (!sections.length) return UI.toast("Choisissez au moins une section (TN et/ou TAM).");
      if (!S.questions.length) return UI.toast("Le quiz ne contient aucune question.");
      const bad = S.questions.findIndex((q) => !q.enonce.trim() || q.choix.filter((x) => String(x).trim()).length < 2 || !q.bonnes.length || q.bonnes.some((b) => !String(q.choix[b] || "").trim()));
      if (bad >= 0) { UI.toast(`Question ${bad + 1} incomplète : énoncé, au moins deux propositions et la bonne réponse.`); $$(".qz-q", qList)[bad].scrollIntoView({ behavior: "smooth", block: "center" }); return; }
      if (f.ouverture.value && f.fermeture.value && f.fermeture.value <= f.ouverture.value) return UI.toast("La fermeture doit suivre l'ouverture.");
      const q = orig ? { ...orig } : { id: uid(), profId: ctx.profId || "", createdAt: new Date().toISOString(), statut: "brouillon" };
      const was = q.statut;
      Object.assign(q, { module: f.module.value, titre: f.titre.value.trim(), consignes: f.consignes.value.trim(), sections,
        ouverture: f.ouverture.value, fermeture: f.fermeture.value, ouvertureMs: f.ouverture.value ? new Date(f.ouverture.value).getTime() : 0, fermetureMs: f.fermeture.value ? new Date(f.fermeture.value).getTime() : 0,
        duree: Math.max(0, +f.duree.value || 0), tentatives: Math.max(0, +f.tentatives.value || 0), corrige: f.corrige.value, melanger: f.melanger.checked,
        source: S.source || null, updatedAt: new Date().toISOString(),
        questions: S.questions.map((x) => ({ id: x.id, type: x.type, enonce: x.enonce.trim(), choix: x.choix.map((c) => String(c).trim()), points: +x.points || 1, source: x.source || "" })) });
      if (publishClicked && q.statut !== "publie") q.statut = "publie";
      if (q.ouvertureMs) q.ouvertureMs = +q.ouvertureMs; if (q.fermetureMs) q.fermetureMs = +q.fermetureMs;
      Store.put("quiz", q);
      Store.put("quiz_corriges", { id: q.id, quizId: q.id, profId: q.profId, module: q.module, reponses: Object.fromEntries(S.questions.map((x) => [x.id, { bonnes: [...x.bonnes].sort((a, b) => a - b), explication: x.explication || "" }])) });
      if (q.statut === "publie" && was !== "publie") announce(q);
      UI.toast(q.statut === "publie" ? (was === "publie" ? "Quiz enregistré." : "Quiz publié et étudiants prévenus.") : "Brouillon enregistré.");
      go("list");
    };
  };

  /* ---- Aperçu (comme un étudiant, sans enregistrement) ---- */
  const drawPreview = (q) => {
    el.innerHTML = `<div class="page-head"><h1><a href="#" class="back" id="q-back">←</a> Aperçu : ${esc(q.titre)}</h1></div><div class="alert info">Aperçu tel que le voient les étudiants. Vos réponses ne sont pas enregistrées.</div><div id="qz-run"></div>`;
    $("#q-back", el).onclick = (e) => { e.preventDefault(); go("list"); };
    QuizRunner($("#qz-run", el), q, { preview: true, corrige: QuizSvc.corrige(q.id), onExit: () => go("list") });
  };

  /* ---- Résultats ---- */
  const drawResults = async (q) => {
    const cor = QuizSvc.corrige(q.id) || { reponses: {} };
    const rs = QuizSvc.responses(q.id);
    const studs = expected(q).sort((a, b) => sectionOf(a).localeCompare(sectionOf(b)) || a.nom.localeCompare(b.nom));
    const known = new Set(studs.map((s) => s.id)); rs.forEach((r) => { if (!known.has(r.studentId)) { const s = Store.get("students", r.studentId); if (s) { studs.push(s); known.add(s.id); } } });
    const rows = studs.map((s) => {
      const mineR = rs.filter((r) => r.studentId === s.id).sort((a, b) => a.tentative - b.tentative);
      const g = cor ? mineR.map((r) => ({ r, ...QuizSvc.grade(q, r, cor) })) : [];
      const best = g.length ? g.reduce((a, b) => (b.sur20 > a.sur20 ? b : a)) : null;
      return { s, mineR, g, best };
    });
    const done = rows.filter((x) => x.best); const notes = done.map((x) => x.best.sur20).sort((a, b) => a - b);
    const avg = notes.length ? notes.reduce((a, b) => a + b, 0) / notes.length : null;
    const med = notes.length ? (notes.length % 2 ? notes[(notes.length - 1) / 2] : (notes[notes.length / 2 - 1] + notes[notes.length / 2]) / 2) : null;
    const perQ = q.questions.map((qq) => { const pts = done.map((x) => QuizSvc.gradeQ(qq, x.best.r.reponses[qq.id], cor.reponses[qq.id]) / (+qq.points || 1)); return pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : null; });
    const dur = (r) => { const m = Math.round((new Date(r.fin) - new Date(r.debut)) / 60000); return isFinite(m) ? `${m} min` : "—"; };
    el.innerHTML = `<div class="page-head"><h1><a href="#" class="back" id="q-back">←</a> Résultats : ${esc(q.titre)}</h1><div class="toolbar">
        ${QZ_STATUT[q.statut]} ${Store.mode === "firebase" ? `<button class="btn outline sm" id="r-refresh">↻ Actualiser</button>` : ""}<button class="btn outline sm" id="r-xls">⬇ Excel</button>
        ${q.statut === "publie" ? `<button class="btn outline sm" id="r-close">Fermer le quiz</button>` : ""}</div></div>
      <p class="muted" style="margin-top:-6px">${esc(UI.moduleLabel(q.module))} · ${(q.sections || []).map((s) => `<span class="pill sec">${s}</span>`).join(" ")} · ${q.questions.length} questions · ${esc(QuizSvc.when(q))}</p>
      <div class="grid grid-3" style="margin-bottom:16px">
        <div class="stat"><b>${done.length} / ${studs.length}</b><span>Copies rendues</span></div>
        <div class="stat"><b>${avg === null ? "—" : QuizSvc.n20(avg)}</b><span>Moyenne /20 (meilleure tentative)</span></div>
        <div class="stat"><b>${med === null ? "—" : QuizSvc.n20(med)}</b><span>Médiane · min ${notes.length ? QuizSvc.n20(notes[0]) : "—"} · max ${notes.length ? QuizSvc.n20(notes[notes.length - 1]) : "—"}</span></div></div>
      <div class="panel"><div class="panel-h">Étudiants</div><div class="panel-b" style="padding:0"><div class="table-scroll"><table class="data"><thead><tr><th>Étudiant</th><th>Section</th><th>Tentative(s)</th><th>Note /20</th><th>Points</th><th>Remise</th><th>Durée</th><th></th></tr></thead><tbody>
        ${rows.map((x) => `<tr><td><b>${esc(UI.studentName(x.s))}</b></td><td><span class="pill sec">${sectionOf(x.s)}</span></td><td>${x.mineR.length || "—"}</td>
          <td>${x.best ? `<b class="${x.best.sur20 >= 10 ? "ok" : "ko"}">${QuizSvc.n20(x.best.sur20)}</b>` : '<span class="pill draft">Non rendu</span>'}</td>
          <td>${x.best ? `${QuizSvc.n20(x.best.score)} / ${x.best.total}` : ""}</td><td class="muted">${x.best ? fmtDT(x.best.r.fin.slice(0, 16)) : ""}</td><td class="muted">${x.best ? dur(x.best.r) : ""}</td>
          <td class="actions">${x.best ? `<button class="btn outline sm" data-copy="${x.best.r.id}">Voir la copie</button> <button class="btn outline sm" data-reset="${x.s.id}" title="Supprime ses copies : l'étudiant pourra repasser le quiz">Réinitialiser</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div></div></div>
      <div class="panel"><div class="panel-h">Réussite par question</div><div class="panel-b">
        ${q.questions.map((qq, i) => `<div class="qz-stat"><span class="qz-stat-l"><b>Q${i + 1}.</b> ${esc(qq.enonce.length > 110 ? qq.enonce.slice(0, 110) + "…" : qq.enonce)}</span>
          <span class="qz-bar"><i style="width:${perQ[i] === null ? 0 : Math.round(perQ[i] * 100)}%;background:${perQ[i] === null ? "#ccc" : perQ[i] >= .7 ? "var(--ok)" : perQ[i] >= .4 ? "#e0a100" : "var(--danger)"}"></i></span><b>${perQ[i] === null ? "—" : Math.round(perQ[i] * 100) + " %"}</b></div>`).join("")}</div></div>`;
    $("#q-back", el).onclick = (e) => { e.preventDefault(); go("list"); };
    if ($("#r-refresh", el)) $("#r-refresh", el).onclick = async () => { try { await QuizSvc.refreshResponses(q.id); draw(); UI.toast("Résultats actualisés."); } catch (e) { UI.toast("Échec : " + e.message); } };
    if ($("#r-close", el)) $("#r-close", el).onclick = () => { if (UI.confirm("Fermer le quiz ? Les étudiants ne pourront plus répondre et verront le corrigé.")) { setStatut(q, "ferme"); draw(); } };
    $$("[data-copy]", el).forEach((b) => b.onclick = () => { const r = Store.get("quiz_reponses", b.dataset.copy); const s = Store.get("students", r.studentId);
      UI.modal({ title: `Copie de ${s ? UI.studentName(s) : ""} — tentative ${r.tentative}`, wide: true, body: QuizCorrection(q, r, cor) }); });
    $$("[data-reset]", el).forEach((b) => b.onclick = () => { const s = Store.get("students", b.dataset.reset); if (!UI.confirm(`Supprimer les copies de ${UI.studentName(s)} ? Il pourra repasser le quiz.`)) return;
      rs.filter((r) => r.studentId === s.id).forEach((r) => Store.del("quiz_reponses", r.id)); draw(); });
    $("#r-xls", el).onclick = () => Excel.download(`quiz_${q.module}_${todayISO()}.xlsx`, [
      { name: "Notes", widths: [28, 10, 14, 10, 12, 20, 10], rows: [["Étudiant", "Section", "Identifiant", "Note /20", "Points", "Remise", "Tentatives"],
        ...rows.map((x) => [UI.studentName(x.s), sectionOf(x.s), x.s.login || "", x.best ? Math.round(x.best.sur20 * 100) / 100 : "", x.best ? `${Math.round(x.best.score * 100) / 100} / ${x.best.total}` : "Non rendu", x.best ? fmtDT(x.best.r.fin.slice(0, 16)) : "", x.mineR.length])] },
      { name: "Questions", widths: [6, 80, 14], rows: [["N°", "Question", "Réussite"], ...q.questions.map((qq, i) => [i + 1, qq.enonce, perQ[i] === null ? "" : Math.round(perQ[i] * 100) + " %"])] }]);
  };
  draw();
}

/* Corrigé détaillé d'une copie (HTML) */
function QuizCorrection(q, r, cor) {
  const g = QuizSvc.grade(q, r, cor);
  return `<p><b>Note : ${QuizSvc.n20(g.sur20)} / 20</b> <span class="muted">(${QuizSvc.n20(g.score)} point(s) sur ${g.total})</span></p>
    ${q.questions.map((qq, i) => { const c = cor.reponses[qq.id] || { bonnes: [] }; const s = new Set(r.reponses[qq.id] || []); const pts = QuizSvc.gradeQ(qq, [...s], c);
      return `<div class="qz-cor ${pts >= (+qq.points || 1) ? "good" : pts > 0 ? "part" : "bad"}"><div><b>Q${i + 1}.</b> ${esc(qq.enonce)} <span class="muted">(${QuizSvc.n20(pts)} / ${+qq.points || 1})</span></div>
        <ul>${qq.choix.map((ch, j) => `<li class="${c.bonnes.includes(j) ? "right" : s.has(j) ? "wrong" : ""}">${s.has(j) ? "☑" : "☐"} ${esc(ch)}${c.bonnes.includes(j) ? " ✔" : ""}</li>`).join("")}</ul>
        ${c.explication ? `<div class="muted">💡 ${esc(c.explication)}</div>` : ""}</div>`; }).join("")}`;
}

/* ======================================================================
   Passage d'un quiz (étudiant, ou aperçu enseignant)
   opts : { preview, student, tentative, corrige, onExit, onDone }
   ====================================================================== */
function QuizRunner(el, quiz, opts) {
  const KEY = opts.student ? `s2i_quiz_${quiz.id}_${opts.student.id}_${opts.tentative}` : null;
  let saved = null; try { saved = KEY ? JSON.parse(localStorage.getItem(KEY)) : null; } catch { }
  const debut = (saved && saved.debut) || new Date().toISOString();
  const order = (saved && saved.order) || (quiz.melanger ? shuffle(quiz.questions.map((q) => q.id)) : quiz.questions.map((q) => q.id));
  const corder = (saved && saved.corder) || Object.fromEntries(quiz.questions.map((q) => [q.id, quiz.melanger && q.type !== "vf" ? shuffle(q.choix.map((_, j) => j)) : q.choix.map((_, j) => j)]));
  const ans = (saved && saved.ans) || {};
  const persist = () => { if (KEY) localStorage.setItem(KEY, JSON.stringify({ debut, order, corder, ans })); };
  persist();
  const qs = order.map((id) => quiz.questions.find((q) => q.id === id)).filter(Boolean);
  const endAt = quiz.duree ? new Date(debut).getTime() + quiz.duree * 60000 : 0;
  const hardEnd = quiz.fermetureMs && !opts.preview ? quiz.fermetureMs : 0;
  const limit = [endAt, hardEnd].filter(Boolean).reduce((a, b) => Math.min(a, b), Infinity);
  let timer = null, sent = false;

  el.innerHTML = `<div class="qz-run">
    <div class="qz-top"><div><b>${esc(quiz.titre)}</b><div class="muted">${esc(UI.moduleLabel(quiz.module))} · ${qs.length} question(s)${opts.tentative ? ` · tentative ${opts.tentative}${quiz.tentatives ? "/" + quiz.tentatives : ""}` : ""}</div></div>
      <div class="qz-timer" id="qz-timer"></div></div>
    ${quiz.consignes ? `<div class="alert info" style="white-space:pre-wrap">${esc(quiz.consignes)}</div>` : ""}
    <form id="qz-f">${qs.map((q, i) => `<div class="qz-item" data-q="${q.id}"><div class="qz-en"><b>${i + 1}.</b> ${esc(q.enonce)} <span class="muted">(${+q.points || 1} pt${(+q.points || 1) > 1 ? "s" : ""}${q.type === "multi" ? " · plusieurs réponses possibles" : ""})</span></div>
      ${corder[q.id].map((j) => `<label class="qz-opt"><input type="${q.type === "multi" ? "checkbox" : "radio"}" name="q_${q.id}" value="${j}" ${(ans[q.id] || []).includes(j) ? "checked" : ""}> <span>${esc(q.choix[j])}</span></label>`).join("")}</div>`).join("")}
      <div class="qz-foot"><span class="muted" id="qz-prog"></span><button class="btn">${opts.preview ? "Voir la correction" : "Rendre ma copie"}</button>${opts.onExit ? `<button type="button" class="btn outline" id="qz-exit">${opts.preview ? "Fermer l'aperçu" : "Quitter (reprendre plus tard)"}</button>` : ""}</div></form></div>`;
  const f = $("#qz-f", el);
  const prog = () => { const n = qs.filter((q) => (ans[q.id] || []).length).length; $("#qz-prog", el).textContent = `${n} / ${qs.length} question(s) répondue(s)`; };
  f.onchange = (e) => { const name = e.target.name; if (!name) return; const qid = name.slice(2); ans[qid] = $$(`input[name="${name}"]:checked`, f).map((x) => +x.value); persist(); prog(); };
  prog();
  const finish = async (auto) => {
    if (sent) return; sent = true; clearInterval(timer);
    const r = { quizId: quiz.id, reponses: Object.fromEntries(quiz.questions.map((q) => [q.id, ans[q.id] || []])), debut, fin: new Date().toISOString(), tentative: opts.tentative || 1 };
    if (opts.preview) { el.innerHTML = `<div class="qz-run">${QuizCorrection(quiz, r, opts.corrige || { reponses: {} })}<p><button class="btn" id="qz-back">Retour</button></p></div>`; $("#qz-back", el).onclick = opts.onExit; return; }
    const s = opts.student;
    Object.assign(r, { id: `${quiz.id}_${s.id}_${r.tentative}`, studentId: s.id, section: sectionOf(s), module: quiz.module, profId: quiz.profId || "" });
    $$("button", el).forEach((b) => (b.disabled = true));
    try { await Store.putAwait("quiz_reponses", r); }
    catch (e) { console.error(e); sent = false; $$("button", el).forEach((b) => (b.disabled = false)); UI.toast("Envoi impossible : " + (e.code === "permission-denied" ? "le quiz est fermé ou la tentative a déjà été rendue." : e.message)); return; }
    localStorage.removeItem(KEY);
    if (auto) UI.toast("Temps écoulé : votre copie a été rendue automatiquement.");
    if (opts.onDone) opts.onDone(r);
  };
  f.onsubmit = (e) => { e.preventDefault(); const miss = qs.filter((q) => !(ans[q.id] || []).length).length;
    if (!opts.preview && !UI.confirm(miss ? `${miss} question(s) sans réponse. Rendre quand même votre copie ? Vous ne pourrez plus la modifier.` : "Rendre votre copie ? Vous ne pourrez plus la modifier.")) return; finish(false); };
  if ($("#qz-exit", el)) $("#qz-exit", el).onclick = () => { clearInterval(timer); opts.onExit(); };
  if (isFinite(limit)) {
    const tick = () => { const left = Math.max(0, limit - Date.now()); const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
      const t = $("#qz-timer", el); if (!t) return clearInterval(timer);
      t.textContent = `⏱ ${m}:${String(sec).padStart(2, "0")}`; t.classList.toggle("low", left < 60000);
      if (!left) finish(true); };
    tick(); timer = setInterval(tick, 1000);
  }
}

/* ======================================================================
   Espace étudiant
   ctx : { user, sec, modules }
   ====================================================================== */
function StudentQuizView(el, ctx) {
  const st = { run: null };
  const list = () => QuizSvc.all().filter((q) => q.statut !== "brouillon" && (q.sections || []).includes(ctx.sec) && ctx.modules.includes(q.module))
    .sort((a, b) => (a.fermetureMs || 9e15) - (b.fermetureMs || 9e15));
  const mineR = (q) => Store.all("quiz_reponses").filter((r) => r.quizId === q.id && r.studentId === ctx.user.id).sort((a, b) => a.tentative - b.tentative);
  const draw = async () => {
    const now = Date.now(); const all = list();
    const card = (q) => {
      const rs = mineR(q); const left = q.tentatives ? q.tentatives - rs.length : Infinity; const open = QuizSvc.isOpen(q, now); const closed = QuizSvc.isClosed(q, now);
      const soon = q.statut === "publie" && q.ouvertureMs && now < q.ouvertureMs;
      const inProg = open && left > 0 && localStorage.getItem(`s2i_quiz_${q.id}_${ctx.user.id}_${rs.length + 1}`);
      return `<div class="card qz-card"><div class="qz-card-h"><b>${esc(q.titre)}</b>${closed ? '<span class="pill off">Terminé</span>' : soon ? '<span class="pill draft">À venir</span>' : open ? '<span class="pill pub">Ouvert</span>' : ""}</div>
        <div class="muted">${esc(UI.moduleLabel(q.module))} · ${esc(UI.profName(q.profId))}</div>
        <div style="margin:6px 0">${q.questions.length} question(s)${q.duree ? ` · ${q.duree} min` : ""} · ${esc(QuizSvc.when(q))}<br>Tentatives : ${rs.length}${q.tentatives ? " / " + q.tentatives : " (illimité)"}</div>
        <div class="toolbar">${open && left > 0 ? `<button class="btn sm" data-go="${q.id}">${inProg ? "Reprendre" : rs.length ? "Nouvelle tentative" : "Commencer"}</button>` : ""}
          ${rs.length ? `<button class="btn outline sm" data-see="${q.id}">Mon résultat</button>` : ""}
          ${soon ? `<span class="muted">Ouverture le ${esc(fmtDT(q.ouverture))}</span>` : ""}${closed && !rs.length ? '<span class="muted">Non rendu</span>' : ""}</div></div>`;
    };
    const g = { open: all.filter((q) => QuizSvc.isOpen(q, now) || (q.statut === "publie" && q.ouvertureMs > now)), done: all.filter((q) => QuizSvc.isClosed(q, now)) };
    el.innerHTML = `<div class="page-head"><h1>Quiz</h1></div>
      ${g.open.length ? `<h3>À faire</h3><div class="grid grid-3">${g.open.map(card).join("")}</div>` : `<div class="alert info">Aucun quiz ouvert pour le moment.</div>`}
      ${g.done.length ? `<h3 style="margin-top:24px">Terminés</h3><div class="grid grid-3">${g.done.map(card).join("")}</div>` : ""}`;
    $$("[data-go]", el).forEach((b) => b.onclick = () => start(Store.get("quiz", b.dataset.go)));
    $$("[data-see]", el).forEach((b) => b.onclick = () => result(Store.get("quiz", b.dataset.see)));
  };
  const start = (q) => {
    const n = mineR(q).length + 1;
    el.innerHTML = `<div class="page-head"><h1><a href="#" class="back" id="q-back">←</a> Quiz</h1></div><div id="qz-run"></div>`;
    $("#q-back", el).onclick = (e) => { e.preventDefault(); draw(); };
    QuizRunner($("#qz-run", el), q, { student: ctx.user, tentative: n, onExit: draw, onDone: () => result(q, true) });
    Journal.log("Début de quiz", `${q.module} « ${q.titre} » — tentative ${n}`, { objet: "Quiz", ref: `quiz/${q.id}` });
  };
  const result = async (q, justDone) => {
    const rs = mineR(q); const last = rs[rs.length - 1];
    el.innerHTML = `<div class="page-head"><h1><a href="#" class="back" id="q-back">←</a> ${esc(q.titre)}</h1></div><div id="qz-res"><p class="muted">Chargement de la correction…</p></div>`;
    $("#q-back", el).onclick = (e) => { e.preventDefault(); draw(); };
    const can = QuizSvc.isClosed(q) || (q.corrige === "immediat" && rs.length >= (q.tentatives || 1));
    const cor = can ? await QuizSvc.fetchCorrige(q.id) : null; const box = $("#qz-res", el); if (!box) return;
    if (!cor) {
      box.innerHTML = `<div class="alert ${justDone ? "ok" : "info"}">${justDone ? "✅ Votre copie a bien été rendue. " : ""}La note et le corrigé seront disponibles ${q.corrige === "fermeture" ? `après la fermeture du quiz${q.fermeture ? " (" + esc(fmtDT(q.fermeture)) + ")" : ""}` : "après votre dernière tentative"}.</div>
        <p class="muted">Tentative(s) rendue(s) : ${rs.map((r) => `${r.tentative} (${fmtDT(r.fin.slice(0, 16))})`).join(", ")}</p>`;
      return;
    }
    const grades = rs.map((r) => ({ r, ...QuizSvc.grade(q, r, cor) })); const best = grades.reduce((a, b) => (b.sur20 > a.sur20 ? b : a));
    box.innerHTML = `${justDone ? `<div class="alert ok">✅ Copie rendue.</div>` : ""}
      <div class="grid grid-3" style="margin-bottom:14px"><div class="stat"><b>${QuizSvc.n20(grades[grades.length - 1].sur20)} / 20</b><span>Dernière tentative</span></div>
        ${grades.length > 1 ? `<div class="stat"><b>${QuizSvc.n20(best.sur20)} / 20</b><span>Meilleure note (${grades.length} tentatives)</span></div>` : ""}</div>
      <div class="panel"><div class="panel-h">Corrigé — tentative ${last.tentative}</div><div class="panel-b">${QuizCorrection(q, last, cor)}</div></div>`;
  };
  draw();
}
