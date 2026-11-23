/* ==========================================================================
   Contenus pédagogiques
   Un contenu (module, titre, sections, statut) est organisé en 4 rubriques
   fixes : Cours, TP, TD, Mise à niveau. Chaque rubrique contient un ou
   plusieurs sous-dossiers (content.dossiers = [{ id, rubrique, nom }]),
   et chaque sous-dossier reçoit des documents (PDF, Word, PowerPoint…).

   Stockage des documents (sans Firebase Storage) :
   - « fichiers »      : fiche du document { id, contentId, dossierId, rubrique,
                         module, profId, statut, nom, taille, mime, parts, createdAt }
   - « fichiers_data » : contenu du fichier découpé en morceaux base64
                         { id: "<idFichier>_<n>", fileId, i, contentId, data }
   ========================================================================== */
const RUBRIQUES = { cours: "Cours", tp: "TP", td: "TD", man: "Mise à niveau" };
const RUB_ICO = { cours: "📘", tp: "🧪", td: "✏️", man: "🧭" };

const Docs = {
  MAX: 25 * 1024 * 1024,   // taille maximale d'un document
  PART: 900000,            // caractères base64 par morceau (< 1 Mo par document Firestore)
  ACCEPT: ".pdf,.doc,.docx,.odt,.rtf,.txt,.md,.ppt,.pptx,.odp,.xls,.xlsx,.ods,.csv,.zip,.rar,.7z,.ipynb,.py,.c,.h,.cpp,.java,.m,.png,.jpg,.jpeg,.gif,.svg",

  ofContent: (cid) => Store.all("fichiers").filter((f) => f.contentId === cid),
  ofFolder: (cid, did) => Store.all("fichiers").filter((f) => f.contentId === cid && f.dossierId === did).sort((a, b) => a.nom.localeCompare(b.nom, "fr", { numeric: true })),
  size(n) { n = +n || 0; return n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1).replace(".", ",")} Mo`; },
  ext: (name) => (String(name).split(".").pop() || "").toLowerCase(),
  icon(name) {
    const e = this.ext(name);
    if (e === "pdf") return "📕";
    if (["doc", "docx", "odt", "rtf", "txt", "md"].includes(e)) return "📝";
    if (["ppt", "pptx", "odp"].includes(e)) return "📽️";
    if (["xls", "xlsx", "ods", "csv"].includes(e)) return "📊";
    if (["zip", "rar", "7z"].includes(e)) return "🗜️";
    if (["png", "jpg", "jpeg", "gif", "svg"].includes(e)) return "🖼️";
    if (["ipynb", "py", "c", "h", "cpp", "java", "m"].includes(e)) return "💻";
    return "📄";
  },
  viewable(f) { return /^(application\/pdf|image\/|text\/plain)/.test(f.mime || "") || ["pdf", "png", "jpg", "jpeg", "gif", "svg", "txt"].includes(this.ext(f.nom)); },

  _b64(file) {
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] || ""); fr.onerror = () => rej(fr.error); fr.readAsDataURL(file); });
  },
  async _putPart(p) {
    if (Store.mode === "firebase") return Store.fs.collection("fichiers_data").doc(p.id).set(p);
    const arr = Store.data.fichiers_data || (Store.data.fichiers_data = []); arr.push(p); Store._persist();
  },
  async _getPart(id) {
    if (Store.mode === "firebase") { const s = await Store.fs.collection("fichiers_data").doc(id).get(); return s.exists ? s.data() : null; }
    return (Store.data.fichiers_data || []).find((p) => p.id === id) || null;
  },
  async _delPart(id) {
    if (Store.mode === "firebase") return Store.fs.collection("fichiers_data").doc(id).delete();
    Store.data.fichiers_data = (Store.data.fichiers_data || []).filter((p) => p.id !== id); Store._persist();
  },

  /* Envoie un document dans un sous-dossier. onStep(i, n) indique la progression. */
  async upload(file, content, dossier, onStep) {
    if (file.size > this.MAX) throw new Error(`« ${file.name} » dépasse ${this.size(this.MAX)}.`);
    const b64 = await this._b64(file);
    const id = uid(); const n = Math.max(1, Math.ceil(b64.length / this.PART));
    try {
      for (let i = 0; i < n; i++) {
        if (onStep) onStep(i, n);
        await this._putPart({ id: `${id}_${i}`, fileId: id, i, contentId: content.id, data: b64.slice(i * this.PART, (i + 1) * this.PART) });
      }
    } catch (e) { for (let i = 0; i < n; i++) this._delPart(`${id}_${i}`).catch(() => {}); throw e; }
    const meta = { id, contentId: content.id, dossierId: dossier.id, rubrique: dossier.rubrique, module: content.module, profId: content.profId || "",
      statut: content.statut, nom: file.name, taille: file.size, mime: file.type || "", parts: n, createdAt: new Date().toISOString() };
    await Store.putAwait("fichiers", meta);
    return meta;
  },
  async blob(f) {
    const parts = await Promise.all(Array.from({ length: f.parts || 1 }, (_, i) => this._getPart(`${f.id}_${i}`)));
    if (parts.some((p) => !p)) throw new Error("Document incomplet ou introuvable.");
    const bin = atob(parts.map((p) => p.data).join(""));
    const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: f.mime || "application/octet-stream" });
  },
  /* Ouvre le document dans un nouvel onglet (PDF, images) ou le télécharge */
  async open(f, download) {
    const view = !download && this.viewable(f);
    const w = view ? window.open("", "_blank") : null;
    if (w) w.document.write(`<p style="font-family:sans-serif;padding:20px">Chargement de « ${esc(f.nom)} »…</p>`);
    try {
      const url = URL.createObjectURL(await this.blob(f));
      if (w) w.location.href = url;
      else { const a = document.createElement("a"); a.href = url; a.download = f.nom; document.body.appendChild(a); a.click(); a.remove(); }
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      Journal.log(download ? "Téléchargement du document" : "Consultation du document", Journal.describe("fichiers", f), { objet: "Document", ref: `fichiers/${f.id}` });
    } catch (e) { if (w) w.close(); UI.toast("Ouverture impossible : " + (e.message || e)); }
  },
  async remove(f) {
    for (let i = 0; i < (f.parts || 1); i++) await this._delPart(`${f.id}_${i}`).catch(() => {});
    Store.del("fichiers", f.id);
  },
  async removeAll(list) { for (const f of list) await this.remove(f); },
  /* Le statut du contenu est recopié sur ses documents (règles de lecture des étudiants) */
  syncStatut(c) { this.ofContent(c.id).forEach((f) => { if (f.statut !== c.statut || f.module !== c.module) Store.put("fichiers", { ...f, statut: c.statut, module: c.module }); }); }
};

/* Résumé « Cours 3 · TP 1 » d'un contenu */
function docsSummary(c) {
  const fs = Docs.ofContent(c.id);
  const parts = Object.entries(RUBRIQUES).map(([k, v]) => { const n = fs.filter((f) => f.rubrique === k).length; const d = (c.dossiers || []).filter((x) => x.rubrique === k).length; return d || n ? `<span class="pill rub-${k}" title="${d} sous-dossier(s)">${v} · ${n}</span>` : ""; }).filter(Boolean);
  return parts.length ? parts.join(" ") : '<span class="muted">Aucun document</span>';
}

/* ---------- Espace enseignant / administrateur ----------
   ctx : { modules, profId (null = admin), user } */
function ContentsView(el, ctx) {
  const st = { module: "", open: null };
  const statutPill = (s) => ({ publie: '<span class="pill pub">Publié</span>', brouillon: '<span class="pill draft">Non publié</span>', desactive: '<span class="pill off">Désactivé</span>' }[s] || s);
  const mine = () => Store.all("contents").filter((c) => ctx.modules.includes(c.module) && (!ctx.profId || c.profId === ctx.profId))
    .filter((c) => !st.module || c.module === st.module)
    .sort((a, b) => a.module.localeCompare(b.module) || (b.createdAt || "").localeCompare(a.createdAt || ""));

  const setStatut = (c, s) => {
    const was = c.statut; c.statut = s; c.updatedAt = new Date().toISOString(); Store.put("contents", c); Docs.syncStatut(c);
    if (s === "publie" && was !== "publie") notify(c);
    UI.toast({ publie: "Contenu publié et étudiants notifiés.", brouillon: "Contenu retiré (non publié).", desactive: "Contenu désactivé." }[s]);
  };
  const delContent = async (c) => {
    const n = Docs.ofContent(c.id).length;
    if (!UI.confirm(`Supprimer définitivement « ${c.titre} »${n ? ` et ses ${n} document(s)` : ""} ?`)) return;
    await Docs.removeAll(Docs.ofContent(c.id)); Store.del("contents", c.id); st.open = null; draw();
  };

  const draw = () => (st.open && Store.get("contents", st.open) ? drawDetail(Store.get("contents", st.open)) : drawList());

  /* Liste des contenus */
  const drawList = () => {
    st.open = null;
    const list = mine();
    el.innerHTML = `<div class="page-head"><h1>Contenus pédagogiques</h1><div class="toolbar">
      <div class="f"><select id="c-mod"><option value="">Tous les modules</option>${UI.moduleOptions(ctx.modules, st.module)}</select></div>
      <button class="btn" id="c-add">+ Nouveau contenu</button></div></div>
      ${list.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Module</th><th>Titre</th><th>Documents</th><th>Sections</th><th>Statut</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr><td><b>${esc(c.module)}</b></td>
        <td><a href="#" data-open="${c.id}"><b>${esc(c.titre)}</b></a>${ctx.profId ? "" : `<div class="muted">${esc(UI.profName(c.profId))}</div>`}</td>
        <td>${docsSummary(c)}</td>
        <td>${(c.sections || []).map((s) => `<span class="pill sec">${s}</span>`).join(" ")}</td><td>${statutPill(c.statut)}</td>
        <td class="actions"><button class="btn sm" data-open="${c.id}">📂 Dossiers</button>
          ${c.statut === "publie" ? `<button class="btn outline sm" data-st="brouillon" data-id="${c.id}">Dépublier</button>` : `<button class="btn outline sm" data-st="publie" data-id="${c.id}">Publier</button>`}
          ${c.statut !== "desactive" ? `<button class="btn outline sm" data-st="desactive" data-id="${c.id}">Désactiver</button>` : ""}
          <button class="btn outline sm" data-edit="${c.id}">Modifier</button> <button class="btn danger sm" data-del="${c.id}">Supprimer</button></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="alert info">Aucun contenu. Cliquez sur « Nouveau contenu », puis ajoutez vos documents dans les rubriques Cours, TP, TD et Mise à niveau.</div>`}
      <p class="muted">Chaque contenu est organisé en 4 rubriques (Cours, TP, TD, Mise à niveau), découpées en sous-dossiers qui reçoivent les documents. Seuls les contenus <b>publiés</b> sont visibles par les étudiants des sections choisies.</p>`;
    $("#c-mod", el).onchange = (e) => { st.module = e.target.value; draw(); };
    $("#c-add", el).onclick = () => form(null);
    $$("[data-open]", el).forEach((b) => b.onclick = (e) => { e.preventDefault(); st.open = b.dataset.open; draw(); window.scrollTo(0, 0); });
    $$("[data-edit]", el).forEach((b) => b.onclick = () => form(Store.get("contents", b.dataset.edit)));
    $$("[data-del]", el).forEach((b) => b.onclick = () => delContent(Store.get("contents", b.dataset.del)));
    $$("[data-st]", el).forEach((b) => b.onclick = () => { setStatut(Store.get("contents", b.dataset.id), b.dataset.st); draw(); });
  };

  /* Rubriques, sous-dossiers et documents d'un contenu */
  const drawDetail = (c) => {
    const dossiers = c.dossiers || [];
    const fileRow = (f) => `<tr><td>${Docs.icon(f.nom)} <a href="#" data-view="${f.id}">${esc(f.nom)}</a></td><td class="muted">${Docs.size(f.taille)}</td><td class="muted">${fmtDate((f.createdAt || "").slice(0, 10))}</td>
      <td class="actions"><button type="button" class="btn outline sm" data-dl="${f.id}">Télécharger</button> <button type="button" class="btn danger sm" data-fdel="${f.id}">Supprimer</button></td></tr>`;
    const folder = (d) => { const fs = Docs.ofFolder(c.id, d.id); return `<div class="folder" data-folder="${d.id}">
      <div class="folder-h"><b>📁 ${esc(d.nom)}</b> <span class="muted">${fs.length} document(s)</span>
        <span class="folder-a"><label class="btn sm">⬆ Ajouter des documents<input type="file" multiple hidden accept="${Docs.ACCEPT}" data-up="${d.id}"></label>
        <button type="button" class="btn outline sm" data-ren="${d.id}">Renommer</button> <button type="button" class="btn danger sm" data-ddel="${d.id}">Supprimer</button></span></div>
      ${fs.length ? `<table class="data files"><tbody>${fs.map(fileRow).join("")}</tbody></table>` : `<div class="drop-hint">Glissez-déposez des fichiers ici, ou cliquez sur « Ajouter des documents » (PDF, Word, PowerPoint, Excel, ZIP… max. ${Docs.size(Docs.MAX)} par fichier).</div>`}
      <div class="up-status muted" id="up-${d.id}"></div></div>`; };
    el.innerHTML = `<div class="page-head"><h1><a href="#" id="c-back" class="back">←</a> ${esc(c.titre)}</h1><div class="toolbar">
        ${statutPill(c.statut)}
        ${c.statut === "publie" ? `<button class="btn sm" id="c-notif" title="Message aux étudiants et e-mail aux listes de diffusion">📣 Prévenir les étudiants</button><button class="btn outline sm" data-st="brouillon">Dépublier</button>` : `<button class="btn sm" data-st="publie">Publier</button>`}
        <button class="btn outline sm" id="c-edit">Modifier</button><button class="btn danger sm" id="c-del">Supprimer</button></div></div>
      <p class="muted" style="margin-top:-6px">${esc(UI.moduleLabel(c.module))} · ${(c.sections || []).map((s) => `<span class="pill sec">${s}</span>`).join(" ")}${ctx.profId ? "" : ` · ${esc(UI.profName(c.profId))}`}</p>
      ${c.description ? `<p style="white-space:pre-wrap">${esc(c.description)}</p>` : ""}
      ${c.lien || c.fichier ? `<p>${c.lien ? `<a class="btn outline sm" href="${esc(c.lien)}" target="_blank" rel="noopener">🔗 Lien du contenu</a> ` : ""}${c.fichier ? `<a class="btn outline sm" href="${c.fichier.data}" download="${esc(c.fichier.name)}">📎 ${esc(c.fichier.name)} (ancienne pièce jointe)</a>` : ""}</p>` : ""}
      ${c.statut !== "publie" ? `<div class="alert info">Ce contenu n'est pas publié : les étudiants ne voient pas encore ses documents.</div>` : ""}
      ${Object.entries(RUBRIQUES).map(([k, v]) => { const ds = dossiers.filter((d) => d.rubrique === k); const n = Docs.ofContent(c.id).filter((f) => f.rubrique === k).length;
        return `<div class="panel rubrique"><div class="panel-h">${RUB_ICO[k]} ${v} <span style="font-weight:400;opacity:.8">${ds.length} sous-dossier(s) · ${n} document(s)</span>
          <button type="button" class="btn sm light" data-newdir="${k}">+ Sous-dossier</button></div>
          <div class="panel-b">${ds.length ? ds.map(folder).join("") : `<p class="muted" style="margin:0">Aucun sous-dossier. Créez-en un (ex. « Chapitre 1 », « TP 2 – GPIO », « Série 1 ») pour y déposer des documents.</p>`}</div></div>`; }).join("")}`;

    $("#c-back", el).onclick = (e) => { e.preventDefault(); st.open = null; draw(); };
    $("#c-edit", el).onclick = () => form(c);
    if ($("#c-notif", el)) $("#c-notif", el).onclick = () => { if (!UI.confirm("Prévenir les étudiants (messagerie et listes de diffusion) des documents de ce contenu" + (c.notifiedAt ? " ajoutés depuis le dernier envoi" : "") + " ?")) return; notify(c, true); UI.toast("Étudiants prévenus."); };
    $("#c-del", el).onclick = () => delContent(c);
    $$("[data-st]", el).forEach((b) => b.onclick = () => { setStatut(c, b.dataset.st); draw(); });
    $$("[data-newdir]", el).forEach((b) => b.onclick = () => dirForm(c, b.dataset.newdir));
    $$("[data-ren]", el).forEach((b) => b.onclick = () => dirForm(c, null, dossiers.find((d) => d.id === b.dataset.ren)));
    $$("[data-ddel]", el).forEach((b) => b.onclick = async () => {
      const d = dossiers.find((x) => x.id === b.dataset.ddel); const fs = Docs.ofFolder(c.id, d.id);
      if (!UI.confirm(`Supprimer le sous-dossier « ${d.nom} »${fs.length ? ` et ses ${fs.length} document(s)` : ""} ?`)) return;
      await Docs.removeAll(fs); c.dossiers = dossiers.filter((x) => x.id !== d.id); c.updatedAt = new Date().toISOString(); Store.put("contents", c); draw();
    });
    const byId = (id) => Store.get("fichiers", id);
    $$("[data-view]", el).forEach((a) => a.onclick = (e) => { e.preventDefault(); Docs.open(byId(a.dataset.view)); });
    $$("[data-dl]", el).forEach((b) => b.onclick = () => Docs.open(byId(b.dataset.dl), true));
    $$("[data-fdel]", el).forEach((b) => b.onclick = async () => { const f = byId(b.dataset.fdel); if (!UI.confirm(`Supprimer « ${f.nom} » ?`)) return; await Docs.remove(f); UI.toast("Document supprimé."); draw(); });
    $$("[data-up]", el).forEach((inp) => inp.onchange = () => upload(c, dossiers.find((d) => d.id === inp.dataset.up), [...inp.files]));
    $$("[data-folder]", el).forEach((box) => {
      box.ondragover = (e) => { e.preventDefault(); box.classList.add("drag"); };
      box.ondragleave = () => box.classList.remove("drag");
      box.ondrop = (e) => { e.preventDefault(); box.classList.remove("drag"); upload(c, dossiers.find((d) => d.id === box.dataset.folder), [...e.dataTransfer.files]); };
    });
  };

  let busy = false;
  const upload = async (c, d, files) => {
    if (!files.length || !d) return;
    if (busy) { UI.toast("Un envoi est déjà en cours, patientez."); return; }
    const big = files.filter((f) => f.size > Docs.MAX);
    if (big.length) UI.toast(`Ignoré (plus de ${Docs.size(Docs.MAX)}) : ${big.map((f) => f.name).join(", ")}. Utilisez un lien pour les fichiers très lourds.`);
    const ok = files.filter((f) => f.size <= Docs.MAX); if (!ok.length) return;
    busy = true; const status = $(`#up-${d.id}`, el); let done = 0;
    try {
      for (const [k, f] of ok.entries()) {
        await Docs.upload(f, c, d, (i, n) => { if (status) status.textContent = `⏳ Envoi de « ${f.name} » (${k + 1}/${ok.length})${n > 1 ? ` — ${Math.round((i / n) * 100)} %` : ""}…`; });
        done++;
      }
      UI.toast(`${done} document(s) ajouté(s) dans « ${d.nom} ».`);
    } catch (e) {
      console.error(e); UI.toast(`Envoi interrompu${done ? ` après ${done} document(s)` : ""} : ${e.code === "permission-denied" ? "action non autorisée (règles Firestore à mettre à jour)" : e.message || e}`);
    } finally { busy = false; c.updatedAt = new Date().toISOString(); Store.put("contents", c); draw(); }
  };

  const dirForm = (c, rubrique, d) => {
    UI.modal({
      title: d ? "Renommer le sous-dossier" : `Nouveau sous-dossier — ${RUBRIQUES[rubrique]}`,
      body: `<label>Nom du sous-dossier</label><input name="nom" required maxlength="80" value="${esc(d ? d.nom : "")}" placeholder="ex. Chapitre 1 — Introduction">`,
      onSubmit: (f) => {
        const nom = f.nom.value.trim(); if (!nom) return false;
        if (d) d.nom = nom; else (c.dossiers = c.dossiers || []).push({ id: uid(), rubrique, nom });
        c.updatedAt = new Date().toISOString(); Store.put("contents", c); draw();
      }
    });
    setTimeout(() => { const i = document.querySelector('.modal input[name="nom"]'); if (i) i.focus(); }, 50);
  };

  /* Résumé des documents pour l'e-mail : « Cours / Chapitre 1 : cours.pdf, … » */
  const docsText = (c, since) => {
    const lines = [];
    Object.entries(RUBRIQUES).forEach(([k, v]) => (c.dossiers || []).filter((d) => d.rubrique === k).forEach((d) => {
      const fs = Docs.ofFolder(c.id, d.id).filter((f) => !since || (f.createdAt || "") > since);
      if (fs.length) lines.push(`• ${v} / ${d.nom} : ${fs.map((f) => f.nom).join(", ")}`);
    }));
    return lines.join("\n");
  };
  const notify = (c, update) => {
    const since = update ? c.notifiedAt : null; const list = docsText(c, since);
    const author = ctx.profId ? UI.profName(ctx.profId) : "Administration";
    (c.sections || []).forEach((sec) => Store.put("messages", {
      module: c.module, section: sec, authorRole: ctx.profId ? "prof" : "admin", authorId: ctx.user.id, authorName: author,
      text: update ? `📢 Nouveaux documents dans « ${c.titre} »${list ? "\n" + list : ""}` : `📢 Nouveau contenu publié : ${c.titre} (onglet « Contenus pédagogiques »)`, system: true, date: new Date().toISOString()
    }));
    Diffusion.send({ sections: c.sections, subject: `${update ? "Nouveaux documents" : "Nouveau contenu"} — ${c.module} : ${c.titre}`,
      body: `Bonjour,\n\n${update ? `De nouveaux documents ont été ajoutés au contenu « ${c.titre} »` : `Un nouveau contenu pédagogique a été publié : « ${c.titre} »`}\nModule : ${UI.moduleLabel(c.module)}\nEnseignant : ${author}\n${c.description ? "\n" + c.description + "\n" : ""}${list ? "\nDocuments :\n" + list + "\n" : ""}\nConsultez-les dans votre Espace Étudiant, onglet « Contenus pédagogiques » : ${siteBase()}etudiant.html\n\nCordialement,\n${author}` });
    c.notifiedAt = new Date().toISOString(); Store.put("contents", c);
  };

  const form = (c) => {
    const isNew = !c; c = c ? { ...c } : { module: st.module || ctx.modules[0], sections: sectionsOfYear(yearOfModule(st.module || ctx.modules[0])), statut: "brouillon", dossiers: [] };
    const m = UI.modal({
      title: isNew ? "Nouveau contenu pédagogique" : "Modifier le contenu",
      body: `<div class="form-grid">
        <div class="full"><label>Module</label><select name="module" required>${UI.moduleOptions(ctx.modules, c.module)}</select></div>
        <div class="full"><label>Titre</label><input name="titre" required value="${esc(c.titre)}" placeholder="ex. Systèmes embarqués — supports 2026-2027"></div>
        <div class="full"><label>Description (facultatif)</label><textarea name="description">${esc(c.description)}</textarea></div>
        <div class="full"><label>Lien complémentaire (facultatif : Drive, GitHub, vidéo…)</label><input name="lien" type="url" placeholder="https://" value="${esc(c.lien)}"></div>
        <div><label>Statut</label><select name="statut"><option value="brouillon" ${c.statut === "brouillon" ? "selected" : ""}>Non publié</option><option value="publie" ${c.statut === "publie" ? "selected" : ""}>Publié (visible)</option><option value="desactive" ${c.statut === "desactive" ? "selected" : ""}>Désactivé</option></select></div>
        <div><label>Sections concernées</label><div class="checks" id="secs"></div></div>
        <div class="full checks"><label><input type="checkbox" name="notif" checked> Notifier les étudiants par la messagerie lors de la publication</label></div>
        ${isNew ? `<div class="full"><div class="hint">Après l'enregistrement, vous accédez aux rubriques <b>Cours, TP, TD et Mise à niveau</b> pour créer les sous-dossiers et déposer les documents.</div></div>` : ""}</div>`,
      onSubmit: async (f) => {
        const was = c.statut;
        Object.assign(c, { module: f.module.value, titre: f.titre.value.trim(), description: f.description.value.trim(), lien: f.lien.value.trim(),
          statut: f.statut.value, sections: $$('input[name="sec"]:checked', f).map((i) => i.value) });
        if (!c.sections.length) { UI.toast("Choisissez au moins une section."); return false; }
        if (isNew) { c.profId = ctx.profId || ""; c.createdAt = new Date().toISOString(); }
        c.updatedAt = new Date().toISOString();
        Store.put("contents", c); Docs.syncStatut(c);
        if (c.statut === "publie" && was !== "publie" && f.notif.checked) notify(c);
        UI.toast("Contenu enregistré."); st.open = c.id; draw();
      }
    });
    const fillSecs = () => { const y = yearOfModule($('[name="module"]', m).value); $("#secs", m).innerHTML = sectionsOfYear(y).map((s) => `<label><input type="checkbox" name="sec" value="${s}" ${(c.sections || []).includes(s) ? "checked" : ""}> ${s}</label>`).join(""); };
    $('[name="module"]', m).onchange = () => { c.sections = sectionsOfYear(yearOfModule($('[name="module"]', m).value)); fillSecs(); };
    fillSecs();
  };
  draw();
}

/* ---------- Espace étudiant ----------
   ctx : { contents (publiés pour l'étudiant), modules } */
function StudentContentsView(el, ctx) {
  const st = { rub: "", q: "" };
  const draw = () => {
    const q = st.q.trim().toLowerCase();
    const list = ctx.contents();
    const fileLi = (f) => `<li>${Docs.icon(f.nom)} <a href="#" data-view="${f.id}">${esc(f.nom)}</a> <span class="muted">${Docs.size(f.taille)}</span>
      <button type="button" class="btn outline sm" data-dl="${f.id}">Télécharger</button></li>`;
    const block = (c) => {
      const rubs = Object.entries(RUBRIQUES).filter(([k]) => !st.rub || st.rub === k).map(([k, v]) => {
        const ds = (c.dossiers || []).filter((d) => d.rubrique === k).map((d) => ({ d, fs: Docs.ofFolder(c.id, d.id).filter((f) => !q || f.nom.toLowerCase().includes(q) || d.nom.toLowerCase().includes(q)) })).filter((x) => x.fs.length);
        return ds.length ? `<div class="s-rub"><div class="s-rub-h">${RUB_ICO[k]} ${v}</div>${ds.map(({ d, fs }) => `<details class="s-dir" open><summary>📁 ${esc(d.nom)} <span class="muted">(${fs.length})</span></summary><ul class="s-files">${fs.map(fileLi).join("")}</ul></details>`).join("")}</div>` : "";
      }).join("");
      const legacy = !st.rub && (c.lien || c.fichier);
      if (!rubs && !legacy && (q || st.rub)) return "";
      return `<div class="s-content"><div class="s-content-h"><b>${esc(c.titre)}</b> <span class="muted">· ${esc(UI.profName(c.profId))} · mis à jour le ${fmtDate((c.updatedAt || c.createdAt || "").slice(0, 10))}</span></div>
        ${c.description ? `<div style="white-space:pre-wrap;margin:4px 0 8px">${esc(c.description)}</div>` : ""}
        ${legacy ? `<div style="margin-bottom:8px">${c.lien ? `<a class="btn outline sm" href="${esc(c.lien)}" target="_blank" rel="noopener">🔗 Ouvrir le lien</a> ` : ""}${c.fichier ? `<a class="btn outline sm" href="${c.fichier.data}" download="${esc(c.fichier.name)}">📎 ${esc(c.fichier.name)}</a>` : ""}</div>` : ""}
        ${rubs || (legacy ? "" : '<p class="muted" style="margin:0">Aucun document pour le moment.</p>')}</div>`;
    };
    const mods = ctx.modules.filter((m) => list.some((c) => c.module === m));
    const html = mods.map((m) => { const b = list.filter((c) => c.module === m).sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "")).map(block).join("");
      return b ? `<div class="panel"><div class="panel-h">${esc(UI.moduleLabel(m))}</div><div class="panel-b">${b}</div></div>` : ""; }).join("");
    el.innerHTML = `<div class="page-head"><h1>Contenus pédagogiques</h1><div class="toolbar">
        <select id="fr"><option value="">Toutes les rubriques</option>${Object.entries(RUBRIQUES).map(([k, v]) => `<option value="${k}" ${st.rub === k ? "selected" : ""}>${v}</option>`).join("")}</select>
        <input id="fq" type="search" placeholder="Rechercher un document…" value="${esc(st.q)}"></div></div>
      ${html || `<div class="alert info">${list.length ? "Aucun document ne correspond à votre recherche." : "Aucun contenu publié pour le moment."}</div>`}`;
    $("#fr", el).onchange = (e) => { st.rub = e.target.value; draw(); };
    $("#fq", el).oninput = (e) => { st.q = e.target.value; const p = e.target.selectionStart; draw(); const i = $("#fq", el); i.focus(); i.setSelectionRange(p, p); };
    const byId = (id) => Store.get("fichiers", id);
    $$("[data-view]", el).forEach((a) => a.onclick = (e) => { e.preventDefault(); Docs.open(byId(a.dataset.view)); });
    $$("[data-dl]", el).forEach((b) => b.onclick = () => Docs.open(byId(b.dataset.dl), true));
  };
  draw();
}
