/**
 * Service Supabase — BeeSmart
 *
 * Gère la persistance des observations apicoles et la récupération du contexte
 * historique des ruches depuis la base de données Supabase.
 *
 * Tables attendues dans Supabase :
 *   - observations : Stocke chaque observation parsée par Claude
 *   - ruches       : Données de référence des ruches (avec historique)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// --- Initialisation du client Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// Nom de la table des observations dans Supabase
const TABLE_OBSERVATIONS = 'observations';

// Nom de la table des ruches dans Supabase
const TABLE_RUCHES = 'ruches';

/**
 * Sauvegarde une observation parsée dans la table Supabase `observations`.
 *
 * Structure de la table `observations` attendue :
 *   id              uuid (clé primaire, généré automatiquement)
 *   ruche_id        uuid | null (clé étrangère vers la table ruches)
 *   apiculteur_id   uuid | null
 *   source          text ('voice' | 'text')
 *   rucher          text | null
 *   ruches          text[] (tableau de noms/numéros de ruches)
 *   statut          text ('bon' | 'moyen' | 'mauvais' | 'critique')
 *   urgence         text ('haute' | 'moyenne' | 'basse' | 'aucune')
 *   action          text
 *   rappel_dans_jours integer
 *   resume          text
 *   tags            text[]
 *   texte_original  text
 *   modele_utilise  text
 *   parsed_at       timestamptz
 *   created_at      timestamptz (généré automatiquement par Supabase)
 *
 * @param {object} observation - L'observation structurée retournée par parseObservation()
 * @returns {Promise<object>} L'enregistrement créé (avec son id Supabase)
 * @throws {Error} Si l'insertion échoue
 */
async function saveObservation(observation) {
  // Construction du payload à insérer — on ne garde que les colonnes connues
  const payload = {
    ruche_id: observation.ruche_id || null,
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
    .select('id, created_at') // On récupère uniquement l'id et la date de création
    .single();

  if (error) {
    throw new Error(`Échec de la sauvegarde Supabase : ${error.message}`);
  }

  return data;
}

/**
 * Récupère le contexte historique d'une ruche pour enrichir l'analyse Claude.
 *
 * Cette fonction retourne un objet synthétique basé sur :
 *   - Les métadonnées de la ruche (table `ruches`)
 *   - Les 3 dernières observations enregistrées pour cette ruche
 *
 * Le contexte est utilisé dans buildContexteRuche() du prompt apicole.
 *
 * @param {string} rucheId - L'identifiant UUID de la ruche dans Supabase
 * @returns {Promise<object|null>} Le contexte de la ruche, ou null si introuvable
 */
async function getRucheContext(rucheId) {
  if (!rucheId) return null;

  try {
    // Requête parallèle : infos de la ruche + 3 dernières observations
    const [{ data: ruche, error: erreurRuche }, { data: dernieres, error: erreurObs }] =
      await Promise.all([
        // Récupération des métadonnées de la ruche
        supabase
          .from(TABLE_RUCHES)
          .select('id, nom, rucher, date_installation, notes')
          .eq('id', rucheId)
          .single(),

        // Récupération des 3 dernières observations pour cette ruche
        supabase
          .from(TABLE_OBSERVATIONS)
          .select('statut, urgence, resume, tags, parsed_at')
          .eq('ruche_id', rucheId)
          .order('parsed_at', { ascending: false })
          .limit(3),
      ]);

    // Si la ruche n'existe pas, on retourne null sans planter
    if (erreurRuche || !ruche) {
      console.warn(`[getRucheContext] Ruche introuvable : ${rucheId}`);
      return null;
    }

    // Construction du contexte synthétique
    const contexte = {
      nom_ruche: ruche.nom || `Ruche ${rucheId}`,
      rucher: ruche.rucher || null,
    };

    // Ajout des données des observations précédentes si disponibles
    if (!erreurObs && dernieres && dernieres.length > 0) {
      const plusRecente = dernieres[0];

      // Formatage de la date de dernière inspection
      if (plusRecente.parsed_at) {
        const date = new Date(plusRecente.parsed_at);
        contexte.derniere_inspection = date.toLocaleDateString('fr-FR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
        });
      }

      contexte.dernier_statut = plusRecente.statut || 'inconnu';

      // Collecte des tags des observations récentes (sans doublons)
      const tousLesTags = dernieres.flatMap((obs) => obs.tags || []);
      contexte.traitements_actifs = [...new Set(tousLesTags)].slice(0, 5);

      // Résumés des dernières observations pour le contexte narratif
      const resumes = dernieres
        .filter((obs) => obs.resume)
        .map((obs) => `• ${obs.resume}`)
        .join('\n');
      contexte.notes_recentes = resumes || null;
    }

    return contexte;
  } catch (erreur) {
    // En cas d'erreur inattendue, on ne bloque pas le pipeline NLP
    console.error(`[getRucheContext] Erreur lors de la récupération du contexte :`, erreur.message);
    return null;
  }
}

/**
 * Récupère les N dernières observations enregistrées (toutes ruches confondues).
 * Utilisé par la commande /resume du bot Telegram.
 *
 * @param {number} [limite=5] - Nombre d'observations à récupérer
 * @returns {Promise<object[]>} Tableau des observations les plus récentes
 */
async function getDernieresObservations(limite = 5) {
  const { data, error } = await supabase
    .from(TABLE_OBSERVATIONS)
    .select('rucher, ruches, statut, urgence, action, rappel_dans_jours, resume, tags, parsed_at')
    .order('parsed_at', { ascending: false })
    .limit(limite);

  if (error) {
    throw new Error(`Échec de récupération des observations : ${error.message}`);
  }

  return data || [];
}

/**
 * Récupère toutes les observations avec urgence "haute" non résolues
 * (créées dans les 7 derniers jours).
 * Utilisé par la commande /urgent du bot Telegram.
 *
 * @returns {Promise<object[]>} Tableau des observations urgentes
 */
async function getObservationsUrgentes() {
  // On ne remonte que les alertes des 7 derniers jours
  const ilYaSeptJours = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from(TABLE_OBSERVATIONS)
    .select('rucher, ruches, statut, urgence, action, rappel_dans_jours, resume, parsed_at')
    .eq('urgence', 'haute')
    .gte('parsed_at', ilYaSeptJours)
    .order('parsed_at', { ascending: false });

  if (error) {
    throw new Error(`Échec de récupération des urgences : ${error.message}`);
  }

  return data || [];
}

module.exports = {
  saveObservation,
  getRucheContext,
  getDernieresObservations,
  getObservationsUrgentes,
};
