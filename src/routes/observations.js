/**
 * Routes des observations — BeeSmart
 *
 * POST /observations/voice  → Réception d'un fichier audio, transcription Whisper + parsing Claude
 * POST /observations/text   → Réception d'un texte brut, parsing Claude directement
 *
 * Les deux routes :
 *   1. Parsent l'observation en JSON structuré
 *   2. Sauvegardent le résultat dans Supabase
 *   3. Retournent l'observation enrichie au client
 */

const express = require('express');
const multer = require('multer');
const { transcribeAudio, parseObservation } = require('../services/nlpService');
const { saveAllEntities, getRucheContext } = require('../services/supabaseService');

const router = express.Router();

// --- Configuration Multer pour l'upload audio ---
// Stockage en mémoire (Buffer) pour éviter l'écriture disque temporaire
const stockageMemoire = multer.memoryStorage();

// Filtre : seuls les fichiers audio sont acceptés
const filtreAudio = (req, fichier, callback) => {
  const typesAcceptes = [
    'audio/webm', 'audio/mp4', 'audio/mpeg',
    'audio/wav', 'audio/ogg', 'audio/m4a',
    'audio/x-m4a', 'audio/mpga',
  ];

  if (typesAcceptes.includes(fichier.mimetype)) {
    callback(null, true);
  } else {
    callback(new Error(`Type de fichier non supporté : ${fichier.mimetype}. Formats acceptés : webm, mp4, mp3, wav, ogg, m4a`), false);
  }
};

// Taille max : 25 Mo (limite de l'API Whisper)
const upload = multer({
  storage: stockageMemoire,
  fileFilter: filtreAudio,
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// POST /observations/voice
// ---------------------------------------------------------------------------
/**
 * Reçoit un enregistrement vocal d'un apiculteur, le transcrit via Whisper,
 * puis analyse le texte via Claude pour produire une observation structurée.
 *
 * Body (multipart/form-data) :
 *   - audio       : Fichier audio (champ requis)
 *   - ruche_id    : Identifiant de la ruche (optionnel, pour enrichir avec le contexte)
 *   - apiculteur_id : Identifiant de l'apiculteur (optionnel)
 *
 * Réponse (200) :
 *   {
 *     success: true,
 *     transcription: string,
 *     observation: { rucher, ruches, statut, urgence, action, rappel_dans_jours, ... },
 *     id: string (identifiant Supabase de l'enregistrement créé)
 *   }
 */
router.post('/voice', upload.single('audio'), async (req, res) => {
  // Vérification que le fichier audio a bien été envoyé
  if (!req.file) {
    return res.status(400).json({
      success: false,
      erreur: 'Aucun fichier audio fourni. Utilisez le champ "audio" en multipart/form-data.',
    });
  }

  const { ruche_id, apiculteur_id } = req.body;

  try {
    // Étape 1 : Récupération du contexte historique de la ruche (si un ID est fourni)
    let contexteRuche = null;
    if (ruche_id) {
      contexteRuche = await getRucheContext(ruche_id);
    }

    // Étape 2 : Transcription audio → texte via Whisper
    const transcription = await transcribeAudio(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname || 'observation.webm',
    );

    if (!transcription || transcription.trim().length === 0) {
      return res.status(422).json({
        success: false,
        erreur: 'La transcription audio n\'a produit aucun texte. Vérifiez la qualité de l\'enregistrement.',
      });
    }

    // Étape 3 : Parsing sémantique via Claude
    const observation = await parseObservation(transcription, contexteRuche);

    // Étape 4 : Sauvegarde de TOUTES les entités dans Supabase
    // saveAllEntities ventile le JSON Claude dans les tables :
    // observations, interventions, reines, hausses, taches, recoltes
    let resultats = null;
    try {
      resultats = await saveAllEntities(
        apiculteur_id || null,  // userId (null si non authentifié)
        observation,
        { source: 'voice', ruche_id: ruche_id || null, apiculteur_id: apiculteur_id || null }
      );
    } catch (erreurSauvegarde) {
      console.warn('[POST /observations/voice] Sauvegarde Supabase ignorée :', erreurSauvegarde.message);
    }

    // Réponse au client
    return res.status(200).json({
      success: true,
      transcription,
      observation,
      id: resultats?.observation_id || null,
      entites_sauvegardees: resultats ? {
        interventions: resultats.interventions.length,
        reines: resultats.reines.length,
        hausses: resultats.hausses.length,
        taches: resultats.taches.length,
        recoltes: resultats.recoltes.length,
      } : null,
    });
  } catch (erreur) {
    console.error('[POST /observations/voice] Erreur :', erreur.message);
    return res.status(500).json({
      success: false,
      erreur: erreur.message || 'Erreur interne lors du traitement de l\'observation vocale.',
    });
  }
});

// ---------------------------------------------------------------------------
// POST /observations/text
// ---------------------------------------------------------------------------
/**
 * Reçoit une observation tapée à la main par l'apiculteur,
 * l'analyse via Claude et la sauvegarde dans Supabase.
 *
 * Body (application/json) :
 *   - texte         : string (requis) — L'observation en texte libre
 *   - ruche_id      : string (optionnel) — Identifiant de la ruche
 *   - apiculteur_id : string (optionnel) — Identifiant de l'apiculteur
 *
 * Réponse (200) :
 *   {
 *     success: true,
 *     observation: { rucher, ruches, statut, urgence, action, rappel_dans_jours, ... },
 *     id: string
 *   }
 */
router.post('/text', async (req, res) => {
  const { texte, ruche_id, apiculteur_id } = req.body;

  // Validation du champ texte
  if (!texte || typeof texte !== 'string' || texte.trim().length === 0) {
    return res.status(400).json({
      success: false,
      erreur: 'Le champ "texte" est requis et ne peut pas être vide.',
    });
  }

  // Limite de longueur pour éviter les abus (10 000 caractères max)
  if (texte.length > 10000) {
    return res.status(400).json({
      success: false,
      erreur: `Le texte est trop long (${texte.length} caractères). Maximum : 10 000 caractères.`,
    });
  }

  try {
    // Étape 1 : Récupération du contexte historique de la ruche
    let contexteRuche = null;
    if (ruche_id) {
      contexteRuche = await getRucheContext(ruche_id);
    }

    // Étape 2 : Parsing sémantique via Claude
    const observation = await parseObservation(texte.trim(), contexteRuche);

    // Étape 3 : Sauvegarde de TOUTES les entités dans Supabase
    let resultats = null;
    try {
      resultats = await saveAllEntities(
        apiculteur_id || null,
        observation,
        { source: 'text', ruche_id: ruche_id || null, apiculteur_id: apiculteur_id || null }
      );
    } catch (erreurSauvegarde) {
      console.warn('[POST /observations/text] Sauvegarde Supabase ignorée :', erreurSauvegarde.message);
    }

    // Réponse au client
    return res.status(200).json({
      success: true,
      observation,
      id: resultats?.observation_id || null,
      entites_sauvegardees: resultats ? {
        interventions: resultats.interventions.length,
        reines: resultats.reines.length,
        hausses: resultats.hausses.length,
        taches: resultats.taches.length,
        recoltes: resultats.recoltes.length,
      } : null,
    });
  } catch (erreur) {
    console.error('[POST /observations/text] Erreur :', erreur.message);
    return res.status(500).json({
      success: false,
      erreur: erreur.message || 'Erreur interne lors du traitement de l\'observation textuelle.',
    });
  }
});

// Gestion des erreurs Multer (fichier trop grand, mauvais type, etc.)
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        erreur: 'Fichier audio trop volumineux. Taille maximale : 25 Mo.',
      });
    }
    return res.status(400).json({ success: false, erreur: err.message });
  }
  if (err) {
    return res.status(400).json({ success: false, erreur: err.message });
  }
  next();
});

module.exports = router;
