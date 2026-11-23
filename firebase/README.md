# Base de données Firestore — Master S2I

Projet Firebase : **master-s2i** (ID `master-s2i`, base `(default)` en `europe-west1`)

Ce dossier contient tout ce qu'il faut pour créer la base de données de la plateforme :

| Fichier | Rôle |
|---|---|
| `donnees-initiales.json` | Données de départ : paramètres, 22 modules de l'offre 2026-2027, promotions, 6 enseignants, 39 créneaux des emplois du temps TN-1A et TAM-1A (S1) |
| `firestore.rules` | Règles de sécurité par rôle (administrateur, enseignant, étudiant) |
| `import-firestore.mjs` | Script d'import vers Firestore, qui crée aussi le compte administrateur |
| `package.json` | Dépendance `firebase-admin` |

## Modèle de données

Chaque collection Firestore correspond à une fonction du site. L'identifiant du document est le champ `id`.

| Collection | Contenu | Champs principaux |
|---|---|---|
| `config/settings` | Paramètres généraux | `titre`, `annee`, `formations`, `sections`, `typesContenu`, `natures`, `siteUrl`, `mailTemplates` |
| `users/{uid}` | Profil de connexion, une entrée par compte Firebase Authentication | `role` (`admin`, `prof`, `student`), `refId` (id dans `profs` ou `students`), `section` (étudiant), `email` |
| `modules` | Modules de la formation (S1 à S4) | `code`, `titre`, `sem` (1 à 4), `cat` (`tech`, `lang`, `soft`, `pfe`) |
| `promotions` | Promotions par formation | `formation` (`TN`, `TAM`), `promotion` (ex. `2026-2028`), `annee` (1 ou 2) |
| `profs` | Enseignants | `login`, `nom`, `prenom`, `email`, `modules[]`, `inactif`, `uid`, `credsSentAt` |
| `students` | Étudiants | `login` (code CNE/Massar), `nom`, `prenom`, `email`, `formation`, `promotion`, `annee`, `inactif`, `uid`, `credsSentAt` |
| `timetable` | Créneaux de l'emploi du temps | `section`, `jour` (1 = lundi … 6 = samedi), `debut`, `fin`, `module`, `salle`, `profId` / `profNom`, `mode` (`presentiel`, `distance`), `lien`, `semaine` (vide = récurrent, sinon le lundi `AAAA-MM-JJ`), `exceptions[]` (semaines annulées) |
| `sessions` | Feuilles de présence | `module`, `section`, `date`, `debut`, `fin`, `type`, `nature`, `mode`, `profId`, `records` {idÉtudiant: `P`, `A`, `R` ou `J`}, `comments` |
| `contents` | Contenus pédagogiques, organisés en rubriques (Cours, TP, TD, Mise à niveau) et sous-dossiers | `module`, `titre`, `description`, `lien`, `dossiers[]` ({`id`, `rubrique`, `nom`}), `sections[]`, `statut` (`publie`, `brouillon`, `desactive`), `dateLimite`, `profId` |
| `fichiers` | Documents des contenus (fiches) | `contentId`, `dossierId`, `rubrique` (`cours`, `tp`, `td`, `man`), `module`, `profId`, `statut` (recopié du contenu), `nom`, `taille`, `mime`, `parts`, `createdAt` |
| `fichiers_data` | Contenu des documents, en morceaux base64 de moins de 1 Mo | `fileId`, `i`, `contentId`, `data` (identifiant du document : `<idFichier>_<n>`) |
| `messages` | Messagerie par module et section | `module` (`ALL` = annonces), `section`, `authorRole`, `authorId`, `authorUid`, `authorName`, `text`, `date` |
| `notifications` | Notifications ciblées (Planning) | `titre`, `categorie`, `message`, `lien`, `formation`, `promotions[]`, `annee`, `publishAt` |
| `exams` | Calendrier des examens | `section`, `module`, `type`, `date`, `debut`, `fin`, `salle` |
| `soutenances` | Soutenances des PFE | `date`, `heure`, `etudiant`, `sujet`, `encadrant`, `jury`, `salle` |

Une section correspond à la formation et à l'année : `TN-1A`, `TAM-1A`, `TN-2A`, `TAM-2A`.

## Méthode simple : la page d'import (sans clé ni Node.js)

La base Firestore `(default)` est déjà créée (europe-west1, mode production) et la connexion par e-mail/mot de passe est activée. Il reste :
1. Dans **Authentication › Méthode de connexion › Ajouter un fournisseur › Google**, cliquez sur *Activer*, choisissez votre e-mail d'assistance, puis *Enregistrer*.
2. Dans **Authentication › Paramètres › Domaines autorisés › Ajouter un domaine**, ajoutez `master-s2i.github.io`.
3. Dans **Firestore Database › Règles**, remplacez tout par le contenu de [`firestore.rules`](firestore.rules), puis cliquez sur *Publier*.
4. Ouvrez la page **https://master-s2i.github.io/firebase/import.html**, cliquez sur *Se connecter avec Google* (compte aissam.berrahou@gmail.com), puis sur *Importer les données*.

## Autre méthode : script Node.js avec clé de compte de service

1. **Console Firebase** : ouvrez https://console.firebase.google.com puis le projet **master-s2i**.
2. **Firestore Database** : cliquez sur *Créer une base de données*, choisissez une région en Europe (ex. `europe-west1`), puis le *mode production*.
3. **Authentication** : cliquez sur *Commencer*, puis dans *Sign-in method*, activez *Adresse e-mail/Mot de passe*. Dans *Paramètres* › *Domaines autorisés*, ajoutez `master-s2i.github.io`.
4. **Règles** : dans Firestore Database › onglet *Règles*, remplacez tout le contenu par celui de `firestore.rules`, puis cliquez sur *Publier*.
5. **Clé du compte de service** : allez dans ⚙ *Paramètres du projet* › *Comptes de service* et cliquez sur *Générer une nouvelle clé privée*. Un fichier `.json` est téléchargé.
   ⚠️ Cette clé donne un accès complet au projet. Ne la publiez jamais sur GitHub et ne l'envoyez à personne.
6. **Import** : il faut [Node.js](https://nodejs.org) version 18 ou plus. Copiez le dossier `firebase/` sur votre ordinateur, ouvrez un terminal dans ce dossier, puis lancez :

   ```bash
   npm install
   npm run verifier                       # contrôle du fichier, sans rien écrire
   node import-firestore.mjs chemin/vers/la-cle.json votre.email@exemple.ma
   ```

   Le script écrit les données, crée le compte administrateur et affiche un lien pour définir son mot de passe.
   Si vous le relancez, il ne remplace pas les documents déjà présents. Pour forcer le remplacement, ajoutez `--ecraser`.
7. **Vérification** : dans Firestore Database › onglet *Données*, vous devez voir les collections `modules`, `profs`, `timetable`, etc.

## Le site en mode Firebase

Le site est branché sur ce projet (`assets/js/firebase-config.js`) :
- **Connexion** : chacun se connecte avec son **adresse e-mail** et son mot de passe. Le lien « Mot de passe oublié ou premier accès ? » se trouve sur la page de connexion.
- **Création des accès** : à l'import Excel des étudiants, à l'ajout d'un enseignant ou avec le bouton « Identifiants », la plateforme crée le compte et Firebase envoie un **e-mail d'activation** pour définir le mot de passe. Il faut donc une adresse e-mail pour chaque étudiant et chaque enseignant.
- **Données partagées** en temps réel (messagerie en direct) et accès contrôlé par rôle grâce aux règles `firestore.rules`.

### Texte de l'e-mail d'activation (à coller une fois dans la console)
Dans **Authentication › Modèles › Réinitialisation du mot de passe**, cliquez sur le crayon. Choisissez la **langue du modèle : français**, puis collez :

**Objet :** `Master S2I – Accès à votre compte sur la plateforme`

**Message :**
```html
<p>Bonjour,</p>
<p>Pour activer votre compte (%EMAIL%) sur la plateforme du <b>Master Systèmes Industriels Intelligents (S2I)</b> de l'ENSIAS, ou pour en réinitialiser le mot de passe, cliquez sur le lien ci-dessous et choisissez votre mot de passe :</p>
<p><a href="%LINK%">Définir mon mot de passe</a></p>
<p>Connectez-vous ensuite avec votre adresse e-mail.</p>
<p><b>Espace Étudiant</b> : cours, TD, TP et devoirs publiés par vos enseignants ; suivi de vos absences ; emploi du temps de la semaine (présentiel ou à distance) ; notifications et planning de la coordination ; messagerie avec vos enseignants ; calendrier des examens et des soutenances.</p>
<p><b>Espace Professeur</b> : saisie des absences (formations TN et TAM) ; gestion de vos cours, TD, TP et devoirs (publier, désactiver…) ; notification de vos étudiants ; emploi du temps et calendrier des examens.</p>
<p>Si vous n'êtes pas concerné(e) par ce message, ignorez-le.</p>
<p>La coordination du Master S2I – ENSIAS, Université Mohammed V de Rabat</p>
```
Dans **⚙ Paramètres du projet › Général › Nom public**, indiquez `Master S2I – ENSIAS` : c'est le nom d'expéditeur affiché dans les e-mails.

## Et ensuite ?

Pour repasser en mode démonstration (données dans le navigateur), mettez `window.FIREBASE_CONFIG = null;` dans `assets/js/firebase-config.js`. Ce même fichier `donnees-initiales.json` peut être chargé dans le site en mode local : Administration › Paramètres › *Restaurer depuis un fichier*. Le mot de passe administrateur est conservé.
