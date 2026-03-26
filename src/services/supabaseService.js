/**
 * Service Supabase — BeeSmart
 *
 * Gère la persistance de TOUTES les entités extraites par le NLP :
 *   - observations  : Observation globale parsée par Claude
 *   - interventions : Actions réalisées (traitement, nourrissement, division…)
 *   - reines        : État et infos sur les reines
 *   - hausses       : Pose/retrait de hausses à miel
 *   - taches        : Actions futures à planifier
 *   - recoltes      : Production récoltée
 *
 * Fonction principale : saveAllEntities() — ventile le JSON Claude
 * dans toutes les tables concernées en une seule opération.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// --- Initialisation du client Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// --- Noms des tables ---
const TABLE_OBSERVATIONS = 'observations';
const TABLE_RUCHES = 'ruches';
const TABLE_RUCHERS = 'ruchers';
const TABLE_INTERVENTIONS = 'interventions';
const TABLE_REINES = 'reines';
const TABLE_HAUSSES = 'hausses';
const TABLE_TACHES = 'taches';
const TABLE_RECOLTES = 'recoltes';
const TABLE_TELEGRAM_USERS = 'telegram_users';


// ============================================================================
// GESTION DES UTILISATEURS TELEGRAM
// ============================================================================

/**
 * Récupère ou crée un utilisateur à partir de son identifiant Telegram.
 *
 * Fonctionnement :
 *   1. Cherche dans la table telegram_users un enregistrement avec ce telegram_id
 *   2. Si trouvé → retourne le user_id associé
 *   3. Si non trouvé → crée un nouvel enregistrement et retourne le user_id généré
 *
 * Le user_id est un UUID généré côté Supabase, indépendant de auth.users.
 * Il sert de clé étrangère pour lier les données apicoles à l'utilisateur Telegram.
 *
 * @param {string|number} telegramId - Identifiant numérique unique de l'utilisateur Telegram
 * @param {string|null} telegramUsername - Nom d'utilisateur Telegram (@username), peut être null
 * @param {string|null} prenom - Prénom de l'utilisateur Telegram
 * @param {string|null} nom - Nom de famille de l'utilisateur Telegram
 * @returns {Promise<string>} UUID de l'utilisateur (user_id)
 */
async function getOrCreateUser(telegramId, telegramUsername = null, prenom = null, nom = null) {
  const telegramIdStr = String(telegramId);

  // Étape 1 : Recherche d'un utilisateur existant
  const { data: existant, error: erreurRecherche } = await supabase
    .from(TABLE_TELEGRAM_USERS)
    .select('user_id, username')
    .eq('telegram_id', telegramIdStr)
    .limit(1)
    .single();

  if (existant && !erreurRecherche) {
    // Mise à jour du username si changé (les utilisateurs Telegram peuvent le modifier)
    if (telegramUsername && existant.username !== telegramUsername) {
      await supabase
        .from(TABLE_TELEGRAM_USERS)
        .update({ username: telegramUsername, prenom, nom })
        .eq('telegram_id', telegramIdStr);
    }

    return existant.user_id;
  }

  // Étape 2 : Création d'un nouvel utilisateur
  const userId = crypto.randomUUID(); // UUID v4 généré côté Node.js

  const { error: erreurCreation } = await supabase
    .from(TABLE_TELEGRAM_USERS)
    .insert({
      telegram_id: telegramIdStr,
      user_id: userId,
      username: telegramUsername,
      prenom: prenom,
      nom: nom,
    });

  if (erreurCreation) {
    // En cas de conflit (race condition), réessayer la lecture
    const { data: retry } = await supabase
      .from(TABLE_TELEGRAM_USERS)
      .select('user_id')
      .eq('telegram_id', telegramIdStr)
      .limit(1)
      .single();

    if (retry) return retry.user_id;

    throw new Error(`Échec création utilisateur Telegram : ${erreurCreation.message}`);
  }

  console.log(`[getOrCreateUser] Nouvel utilisateur Telegram créé : @${telegramUsername || telegramIdStr} → ${userId}`);
  return userId;
}


// ============================================================================
// RÉSOLUTION D'IDENTIFIANTS
// ============================================================================

/**
 * Recherche l'UUID d'une ruche à partir de son numéro et de l'utilisateur.
 *
 * @param {string} userId - UUID de l'utilisateur
 * @param {string} numero - Numéro ou nom de la ruche (ex: "46", "La Bleue")
 * @returns {Promise<string|null>} UUID de la ruche, ou null si introuvable
 */
async function trouverRucheId(userId, numero) {
  if (!numero || !userId) return null;

  const { data } = await supabase
    .from(TABLE_RUCHES)
    .select('id')
    .eq('user_id', userId)
    .eq('numero', String(numero))
    .limit(1)
    .single();

  return data?.id || null;
}

/**
 * Recherche l'UUID d'un rucher à partir de son nom et de l'utilisateur.
 * La recherche est insensible à la casse (ilike).
 *
 * @param {string} userId - UUID de l'utilisateur
 * @param {string} nomRucher - Nom du rucher (ex: "Barsac", "rucher du bas")
 * @returns {Promise<string|null>} UUID du rucher, ou null si introuvable
 */
async function trouverRucherId(userId, nomRucher) {
  if (!nomRucher || !userId) return null;

  // Recherche insensible à la casse avec ilike et wildcard
  const { data } = await supabase
    .from(TABLE_RUCHERS)
    .select('id')
    .eq('user_id', userId)
    .ilike('nom', `%${nomRucher}%`)
    .limit(1)
    .single();

  return data?.id || null;
}

/**
 * Résout les identifiants rucher et ruches à partir des noms extraits par le NLP.
 * Retourne un objet avec le rucherId et un map numéro→UUID pour les ruches.
 *
 * @param {string} userId - UUID de l'utilisateur
 * @param {object} observation - Observation parsée par Claude
 * @returns {Promise<{rucherId: string|null, ruchesMap: Object}>}
 */
async function resoudreIdentifiants(userId, observation) {
  // Résolution du rucher
  const rucherId = await trouverRucherId(userId, observation.rucher);

  // Résolution de chaque ruche mentionnée → map numéro → UUID
  const ruchesMap = {};
  if (observation.ruches && observation.ruches.length > 0) {
    await Promise.all(
      observation.ruches.map(async (numero) => {
        const id = await trouverRucheId(userId, numero);
        if (id) ruchesMap[numero] = id;
      })
    );
  }

  return { rucherId, ruchesMap };
}


// ============================================================================
// SAUVEGARDE DES ENTITÉS INDIVIDUELLES
// ============================================================================

/**
 * Sauvegarde une observation parsée dans la table observations.
 *
 * @param {object} observation - Observation structurée retournée par parseObservation()
 * @returns {Promise<object>} Enregistrement créé (id + created_at)
 */
async function saveObservation(observation) {
  const payload = {
    ruche_id: observation.ruche_id || null,
    rucher_id: observation.rucher_id || null,
    user_id: observation.user_id || null,
    apiculteur_id: observation.apiculteur_id || null,
    source: observation.source || 'text',
    rucher: observation.rucher || null,
    ruches: observation.ruches || [],
    statut: observation.statut || 'moyen',
    urgence: observation.urgence || 'basse',
    action: observation.action || '',
    rappel_dans_jours: observation.rappel_dans_jours ?? 0,
    resume: observation.resume || '',
    tags: observation.tags || [],
    texte_original: observation.texte_original || '',
    modele_utilise: observation.modele_utilise || '',
    parsed_at: observation.parsed_at || new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from(TABLE_OBSERVATIONS)
    .insert(payload)
    .select('id, created_at')
    .single();

  if (error) {
    throw new Error(`Échec sauvegarde observation : ${error.message}`);
  }

  return data;
}

/**
 * Sauvegarde une intervention dans la table interventions.
 *
 * @param {string} userId - UUID de l'utilisateur
 * @param {string|null} rucheId - UUID de la ruche (ou null si toutes)
 * @param {object} intervention - Données d'intervention extraites par le NLP
 * @returns {Promise<object|null>} Enregistrement créé ou null en cas d'erreur
 */
async function saveIntervention(userId, rucheId, intervention) {
  const payload = {
    user_id: userId,
    ruche_id: rucheId,
    type: intervention.type || 'autre',
    description: intervention.description || '',
    materiel: intervention.materiel || null,
    date_intervention: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from(TABLE_INTERVENTIONS)
    .insert(payload)
    .select('id')
    .single();

  if (error) {
    console.warn(`[saveIntervention] Échec : ${error.message}`);
    return null;
  }

  return data;
}

/**
 * Sauvegarde ou met à jour les infos d'une reine dans la table reines.
 *
 * Si une reine existe déjà pour cette ruche et cet utilisateur,
 * on met à jour ses informations. Sinon, on en crée une nouvelle.
 *
 * @param {string} userId - UUID de l'utilisateur
 * @param {string|null} rucheId - UUID de la ruche
 * @param {object} reine - Données de la reine extraites par le NLP
 * @returns {Promise<object|null>} Enregistrement créé/mis à jour ou null
 */
async function saveReine(userId, rucheId, reine) {
  // On ne peut sauvegarder que si on a un rucheId
  if (!rucheId) {
    console.warn('[saveReine] Pas de rucheId — sauvegarde ignorée');
    return null;
  }

  // Vérifier si une reine existe déjà pour cette ruche
  const { data: reineExistante } = await supabase
    .from(TABLE_REINES)
    .select('id')
    .eq('user_id', userId)
    .eq('ruche_id', rucheId)
    .limit(1)
    .single();

  // Construction du payload — on ne met à jour que les champs fournis par le NLP
  const payload = {
    user_id: userId,
    ruche_id: rucheId,
  };

  // Marquée / clippée : seulement si le NLP a détecté l'info
  if (reine.marquee !== null && reine.marquee !== undefined) {
    payload.marquee = reine.marquee;
  }
  if (reine.clippee !== null && reine.clippee !== undefined) {
    payload.clippee = reine.clippee;
  }
  if (reine.race) {
    payload.race = reine.race;
  }
  if (reine.couleur) {
    payload.couleur = reine.couleur;
  }

  if (reineExistante) {
    // Mise à jour de la reine existante
    const { data, error } = await supabase
      .from(TABLE_REINES)
      .update(payload)
      .eq('id', reineExistante.id)
      .select('id')
      .single();

    if (error) {
      console.warn(`[saveReine] Échec mise à jour : ${error.message}`);
      return null;
    }
    return data;
  } else {
    // Création d'une nouvelle reine
    const { data, error } = await supabase
      .from(TABLE_REINES)
      .insert(payload)
      .select('id')
      .single();

    if (error) {
      console.warn(`[saveReine] Échec création : ${error.message}`);
      return null;
    }
    return data;
  }
}

/**
 * Sauvegarde une manipulation de hausse dans la table hausses.
 *
 * @param {string} userId - UUID de l'utilisateur
 * @param {string|null} rucheId - UUID de la ruche
 * @param {object} hausse - Données de hausse extraites par le NLP
 * @returns {Promise<object|null>} Enregistrement créé ou null
 */
async function saveHausse(userId, rucheId, hausse) {
  const maintenant = new Date().toISOString().split('T')[0]; // Format YYYY-MM-DD

  const payload = {
    user_id: userId,
    ruche_id: rucheId,
    type_miel: hausse.type_miel || null,
  };

  // Selon l'action détectée, on renseigne la date de pose ou de retrait
  if (hausse.action === 'pose') {
    payload.date_pose = maintenant;
  } else if (hausse.action === 'retrait') {
    payload.date_retrait = maintenant;
    // Poids enregistré au retrait
    if (hausse.poids_kg) {
      payload.poids_miel = hausse.poids_kg;
    }
  }

  const { data, error } = await supabase
    .from(TABLE_HAUSSES)
    .insert(payload)
    .select('id')
    .single();

  if (error) {
    console.warn(`[saveHausse] Échec : ${error.message}`);
    return null;
  }

  return data;
}

/**
 * Sauvegarde une tâche planifiée dans la table taches.
 *
 * @param {string} userId - UUID de l'utilisateur
 * @param {string|null} rucherId - UUID du rucher
 * @param {string|null} rucheId - UUID de la ruche
 * @param {object} tache - Données de tâche extraites par le NLP
 * @returns {Promise<object|null>} Enregistrement créé ou null
 */
async function saveTache(userId, rucherId, rucheId, tache) {
  // Calcul de la date prévue à partir du nombre de jours
  const datePrevue = new Date();
  datePrevue.setDate(datePrevue.getDate() + (tache.dans_jours || 7));

  const payload = {
    user_id: userId,
    rucher_id: rucherId,
    ruche_id: rucheId,
    type: tache.type || 'autre',
    description: tache.description || '',
    date_prevue: datePrevue.toISOString(),
    materiel: tache.materiel || null,
    statut: 'a_faire',
  };

  const { data, error } = await supabase
    .from(TABLE_TACHES)
    .insert(payload)
    .select('id')
    .single();

  if (error) {
    console.warn(`[saveTache] Échec : ${error.message}`);
    return null;
  }

  return data;
}

/**
 * Sauvegarde une récolte dans la table recoltes.
 *
 * @param {string} userId - UUID de l'utilisateur
 * @param {string|null} rucheId - UUID de la ruche
 * @param {string|null} rucherId - UUID du rucher
 * @param {object} recolte - Données de récolte extraites par le NLP
 * @returns {Promise<object|null>} Enregistrement créé ou null
 */
async function saveRecolte(userId, rucheId, rucherId, recolte) {
  const payload = {
    user_id: userId,
    ruche_id: rucheId,
    rucher_id: rucherId,
    type: recolte.type || 'miel',
    quantite: recolte.quantite || 0,
    unite: recolte.unite || 'kg',
    date_recolte: recolte.date || new Date().toISOString().split('T')[0],
    notes: recolte.type_miel ? `Miel de ${recolte.type_miel}` : null,
  };

  const { data, error } = await supabase
    .from(TABLE_RECOLTES)
    .insert(payload)
    .select('id')
    .single();

  if (error) {
    console.warn(`[saveRecolte] Échec : ${error.message}`);
    return null;
  }

  return data;
}


// ============================================================================
// FONCTION PRINCIPALE — SAUVEGARDE DE TOUTES LES ENTITÉS
// ============================================================================

/**
 * Sauvegarde toutes les entités extraites par le NLP en une seule opération.
 *
 * Pipeline :
 *   1. Résoudre les identifiants (numéro ruche → UUID, nom rucher → UUID)
 *   2. Sauvegarder l'observation principale
 *   3. Pour chaque section non vide du JSON Claude :
 *      - interventions → saveIntervention()
 *      - reines        → saveReine()
 *      - hausses       → saveHausse()
 *      - taches        → saveTache()
 *      - recoltes      → saveRecolte()
 *
 * Toutes les sauvegardes sont non bloquantes : si une entité échoue,
 * les autres sont quand même traitées. Les erreurs sont loguées mais
 * ne font pas planter le pipeline.
 *
 * @param {string|null} userId - UUID de l'utilisateur (null si non authentifié)
 * @param {object} observation - JSON complet retourné par parseObservation()
 * @param {object} options - Options supplémentaires (source, ruche_id, apiculteur_id)
 * @returns {Promise<object>} Résumé de ce qui a été sauvegardé
 */
async function saveAllEntities(userId, observation, options = {}) {
  const resultats = {
    observation_id: null,
    interventions: [],
    reines: [],
    hausses: [],
    taches: [],
    recoltes: [],
    erreurs: [],
  };

  // --- Étape 1 : Résolution des identifiants ---
  let rucherId = null;
  let ruchesMap = {};

  if (userId) {
    try {
      const ids = await resoudreIdentifiants(userId, observation);
      rucherId = ids.rucherId;
      ruchesMap = ids.ruchesMap;
    } catch (erreur) {
      console.warn('[saveAllEntities] Résolution des identifiants échouée :', erreur.message);
    }
  }

  // --- Étape 2 : Sauvegarde de l'observation principale ---
  try {
    const obsData = await saveObservation({
      ...observation,
      user_id: userId,
      rucher_id: rucherId,
      ruche_id: options.ruche_id || null,
      apiculteur_id: options.apiculteur_id || userId,
      source: options.source || 'text',
    });
    resultats.observation_id = obsData?.id || null;
  } catch (erreur) {
    console.warn('[saveAllEntities] Observation :', erreur.message);
    resultats.erreurs.push(`observation: ${erreur.message}`);
  }

  // Si pas de userId, on ne peut pas sauvegarder les entités liées (RLS)
  if (!userId) {
    return resultats;
  }

  // --- Étape 3 : Sauvegarde des interventions ---
  if (observation.interventions?.length > 0) {
    for (const intervention of observation.interventions) {
      try {
        const rucheId = intervention.ruche ? ruchesMap[intervention.ruche] || null : null;
        const result = await saveIntervention(userId, rucheId, intervention);
        if (result) resultats.interventions.push(result.id);
      } catch (erreur) {
        resultats.erreurs.push(`intervention: ${erreur.message}`);
      }
    }
  }

  // --- Étape 4 : Sauvegarde des reines ---
  if (observation.reines?.length > 0) {
    for (const reine of observation.reines) {
      try {
        const rucheId = reine.ruche ? ruchesMap[reine.ruche] || null : null;
        const result = await saveReine(userId, rucheId, reine);
        if (result) resultats.reines.push(result.id);
      } catch (erreur) {
        resultats.erreurs.push(`reine: ${erreur.message}`);
      }
    }
  }

  // --- Étape 5 : Sauvegarde des hausses ---
  if (observation.hausses?.length > 0) {
    for (const hausse of observation.hausses) {
      try {
        const rucheId = hausse.ruche ? ruchesMap[hausse.ruche] || null : null;
        const result = await saveHausse(userId, rucheId, hausse);
        if (result) resultats.hausses.push(result.id);
      } catch (erreur) {
        resultats.erreurs.push(`hausse: ${erreur.message}`);
      }
    }
  }

  // --- Étape 6 : Sauvegarde des tâches ---
  if (observation.taches?.length > 0) {
    for (const tache of observation.taches) {
      try {
        const rucheId = tache.ruche ? ruchesMap[tache.ruche] || null : null;
        const result = await saveTache(userId, rucherId, rucheId, tache);
        if (result) resultats.taches.push(result.id);
      } catch (erreur) {
        resultats.erreurs.push(`tache: ${erreur.message}`);
      }
    }
  }

  // --- Étape 7 : Sauvegarde des récoltes ---
  if (observation.recoltes?.length > 0) {
    for (const recolte of observation.recoltes) {
      try {
        const rucheId = recolte.ruche ? ruchesMap[recolte.ruche] || null : null;
        const result = await saveRecolte(userId, rucheId, rucherId, recolte);
        if (result) resultats.recoltes.push(result.id);
      } catch (erreur) {
        resultats.erreurs.push(`recolte: ${erreur.message}`);
      }
    }
  }

  // Log récapitulatif
  const nbEntites =
    resultats.interventions.length +
    resultats.reines.length +
    resultats.hausses.length +
    resultats.taches.length +
    resultats.recoltes.length;

  if (nbEntites > 0) {
    console.log(`[saveAllEntities] ${nbEntites} entité(s) sauvegardée(s) en plus de l'observation.`);
  }

  return resultats;
}


// ============================================================================
// FONCTIONS DE LECTURE (Telegram, Dashboard)
// ============================================================================

/**
 * Récupère le contexte historique d'une ruche pour enrichir l'analyse Claude.
 *
 * @param {string} rucheId - UUID de la ruche
 * @returns {Promise<object|null>} Contexte synthétique ou null
 */
async function getRucheContext(rucheId) {
  if (!rucheId) return null;

  try {
    const [{ data: ruche, error: erreurRuche }, { data: dernieres, error: erreurObs }] =
      await Promise.all([
        supabase
          .from(TABLE_RUCHES)
          .select('id, nom, rucher_id, date_creation, notes')
          .eq('id', rucheId)
          .single(),
        supabase
          .from(TABLE_OBSERVATIONS)
          .select('statut, urgence, resume, tags, parsed_at')
          .eq('ruche_id', rucheId)
          .order('parsed_at', { ascending: false })
          .limit(3),
      ]);

    if (erreurRuche || !ruche) {
      console.warn(`[getRucheContext] Ruche introuvable : ${rucheId}`);
      return null;
    }

    const contexte = {
      nom_ruche: ruche.nom || `Ruche ${rucheId}`,
      rucher: ruche.rucher_id || null,
    };

    if (!erreurObs && dernieres && dernieres.length > 0) {
      const plusRecente = dernieres[0];

      if (plusRecente.parsed_at) {
        const date = new Date(plusRecente.parsed_at);
        contexte.derniere_inspection = date.toLocaleDateString('fr-FR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
        });
      }

      contexte.dernier_statut = plusRecente.statut || 'inconnu';

      const tousLesTags = dernieres.flatMap((obs) => obs.tags || []);
      contexte.traitements_actifs = [...new Set(tousLesTags)].slice(0, 5);

      const resumes = dernieres
        .filter((obs) => obs.resume)
        .map((obs) => `• ${obs.resume}`)
        .join('\n');
      contexte.notes_recentes = resumes || null;
    }

    return contexte;
  } catch (erreur) {
    console.error(`[getRucheContext] Erreur :`, erreur.message);
    return null;
  }
}

/**
 * Récupère les N dernières observations (toutes ruches).
 * Utilisé par /resume du bot Telegram.
 *
 * @param {number} [limite=5] - Nombre d'observations
 * @returns {Promise<object[]>}
 */
async function getDernieresObservations(limite = 5) {
  const { data, error } = await supabase
    .from(TABLE_OBSERVATIONS)
    .select('rucher, ruches, statut, urgence, action, rappel_dans_jours, resume, tags, parsed_at')
    .order('parsed_at', { ascending: false })
    .limit(limite);

  if (error) throw new Error(`Échec récupération observations : ${error.message}`);
  return data || [];
}

/**
 * Récupère les observations avec urgence "haute" des 7 derniers jours.
 * Utilisé par /urgent du bot Telegram.
 *
 * @returns {Promise<object[]>}
 */
async function getObservationsUrgentes() {
  const ilYaSeptJours = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from(TABLE_OBSERVATIONS)
    .select('rucher, ruches, statut, urgence, action, rappel_dans_jours, resume, parsed_at')
    .eq('urgence', 'haute')
    .gte('parsed_at', ilYaSeptJours)
    .order('parsed_at', { ascending: false });

  if (error) throw new Error(`Échec récupération urgences : ${error.message}`);
  return data || [];
}


// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Utilisateurs Telegram
  getOrCreateUser,
  // Sauvegarde
  saveObservation,
  saveIntervention,
  saveReine,
  saveHausse,
  saveTache,
  saveRecolte,
  saveAllEntities,
  // Résolution
  trouverRucheId,
  trouverRucherId,
  // Lecture
  getRucheContext,
  getDernieresObservations,
  getObservationsUrgentes,
};
