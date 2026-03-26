-- ============================================================================
-- BeeSmart — Schéma SQL complet
-- Base de données Supabase (PostgreSQL)
--
-- Ce fichier crée toutes les tables nécessaires au fonctionnement de
-- l'application apicole BeeSmart : ruchers, ruches, reines, interventions,
-- hausses, tâches, récoltes et observations.
--
-- À exécuter dans le SQL Editor de Supabase (https://supabase.com/dashboard)
-- ============================================================================

-- Activation de l'extension UUID si pas déjà active
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ============================================================================
-- 1. RUCHERS
-- Un rucher est un emplacement physique regroupant plusieurs ruches.
-- Peut aussi être un lieu de stockage (est_stockage = true).
-- ============================================================================

CREATE TABLE IF NOT EXISTS ruchers (
  id            uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nom           text NOT NULL,
  description   text,
  localisation  text,                         -- Adresse ou lieu-dit
  latitude      double precision,             -- Coordonnées GPS
  longitude     double precision,             -- Coordonnées GPS
  est_stockage  boolean DEFAULT false,        -- true = lieu de stockage, pas un rucher actif
  created_at    timestamptz DEFAULT now()
);

-- Index pour filtrer par utilisateur et trier par date
CREATE INDEX idx_ruchers_user_id ON ruchers(user_id);
CREATE INDEX idx_ruchers_created_at ON ruchers(created_at);

COMMENT ON TABLE ruchers IS 'Emplacements physiques regroupant des ruches (ou lieux de stockage)';
COMMENT ON COLUMN ruchers.est_stockage IS 'Si true, ce n''est pas un rucher actif mais un lieu de stockage de matériel';


-- ============================================================================
-- 2. RUCHES
-- Une ruche appartient à un rucher et à un utilisateur.
-- Chaque ruche a un numéro, un type, un statut et peut avoir un QR code.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ruches (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  rucher_id       uuid REFERENCES ruchers(id) ON DELETE SET NULL,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  numero          text NOT NULL,                -- Numéro ou nom de la ruche (ex: "R12", "La Bleue")
  type_ruche      text DEFAULT 'Dadant',        -- Dadant, Langstroth, Warré, Voirnot, Kenyane...
  statut          text DEFAULT 'active',        -- active, inactive, morte, vendue, en_hivernage
  reine_presente  boolean DEFAULT true,         -- La ruche a-t-elle une reine ?
  date_creation   date,                         -- Date de création ou d'acquisition de la ruche
  notes           text,                         -- Notes libres de l'apiculteur
  qr_code         text UNIQUE,                  -- Code QR unique pour identification terrain
  created_at      timestamptz DEFAULT now()
);

-- Index pour les requêtes fréquentes
CREATE INDEX idx_ruches_user_id ON ruches(user_id);
CREATE INDEX idx_ruches_rucher_id ON ruches(rucher_id);
CREATE INDEX idx_ruches_created_at ON ruches(created_at);
CREATE INDEX idx_ruches_statut ON ruches(statut);

COMMENT ON TABLE ruches IS 'Ruches individuelles, chacune rattachée à un rucher';
COMMENT ON COLUMN ruches.type_ruche IS 'Format de la ruche : Dadant, Langstroth, Warré, Voirnot, Kenyane, etc.';
COMMENT ON COLUMN ruches.qr_code IS 'Identifiant QR unique pour scanner la ruche sur le terrain';


-- ============================================================================
-- 3. REINES
-- Généalogie et suivi des reines. Chaque reine est liée à une ruche.
-- Les colonnes mere_id et pere_id permettent de tracer la lignée.
-- ============================================================================

CREATE TABLE IF NOT EXISTS reines (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  ruche_id        uuid REFERENCES ruches(id) ON DELETE SET NULL,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reference       text,                         -- Référence interne de la reine (ex: "R2024-07")
  race            text,                         -- Buckfast, Noire, Carnica, Ligustica, Caucasienne...
  date_naissance  date,                         -- Date de naissance ou d'introduction
  marquee         boolean DEFAULT false,        -- La reine est-elle marquée ?
  clippee         boolean DEFAULT false,        -- L'aile de la reine est-elle coupée ?
  couleur         text,                         -- Couleur du marquage (blanc, jaune, rouge, vert, bleu)
  mere_id         uuid REFERENCES reines(id) ON DELETE SET NULL,  -- Reine mère (lignée maternelle)
  pere_id         uuid REFERENCES reines(id) ON DELETE SET NULL,  -- Reine père / souche paternelle
  created_at      timestamptz DEFAULT now()
);

-- Index
CREATE INDEX idx_reines_user_id ON reines(user_id);
CREATE INDEX idx_reines_ruche_id ON reines(ruche_id);
CREATE INDEX idx_reines_created_at ON reines(created_at);

COMMENT ON TABLE reines IS 'Suivi des reines avec généalogie (mère/père) et caractéristiques physiques';
COMMENT ON COLUMN reines.couleur IS 'Couleur de marquage selon la convention internationale (cycle de 5 ans)';
COMMENT ON COLUMN reines.clippee IS 'Aile coupée pour limiter l''essaimage';


-- ============================================================================
-- 4. INTERVENTIONS
-- Toute action réalisée sur une ruche : traitement, nourrissement, division...
-- ============================================================================

CREATE TABLE IF NOT EXISTS interventions (
  id                  uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  ruche_id            uuid REFERENCES ruches(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type                text NOT NULL,            -- traitement, nourrissement, division, reunion,
                                                -- changement_reine, ajout_hausse, retrait_hausse,
                                                -- nettoyage, transhumance, autre
  description         text,                     -- Détails libres de l'intervention
  date_intervention   timestamptz DEFAULT now(), -- Date et heure de l'intervention
  materiel            text,                     -- Matériel utilisé (ex: "Apivar 2 lanières", "Sirop 50/50 2L")
  created_at          timestamptz DEFAULT now()
);

-- Index
CREATE INDEX idx_interventions_user_id ON interventions(user_id);
CREATE INDEX idx_interventions_ruche_id ON interventions(ruche_id);
CREATE INDEX idx_interventions_created_at ON interventions(created_at);
CREATE INDEX idx_interventions_type ON interventions(type);
CREATE INDEX idx_interventions_date ON interventions(date_intervention);

COMMENT ON TABLE interventions IS 'Journal de toutes les interventions réalisées sur les ruches';
COMMENT ON COLUMN interventions.type IS 'Type d''intervention : traitement, nourrissement, division, reunion, changement_reine, ajout_hausse, retrait_hausse, nettoyage, transhumance, autre';


-- ============================================================================
-- 5. HAUSSES
-- Suivi des hausses à miel : pose, retrait, pesée, type de miel.
-- Chaque hausse peut avoir un QR code pour le suivi terrain.
-- ============================================================================

CREATE TABLE IF NOT EXISTS hausses (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  ruche_id        uuid REFERENCES ruches(id) ON DELETE SET NULL,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reference       text,                         -- Référence interne (ex: "H-042")
  qr_code         text UNIQUE,                  -- QR code unique pour identification
  poids_vide      numeric(6,2),                 -- Poids à vide en kg
  poids_miel      numeric(6,2),                 -- Poids avec miel en kg (après retrait)
  type_miel       text,                         -- Acacia, toutes fleurs, lavande, châtaignier...
  date_pose       date,                         -- Date de pose sur la ruche
  date_retrait    date,                         -- Date de retrait (null = encore en place)
  created_at      timestamptz DEFAULT now()
);

-- Index
CREATE INDEX idx_hausses_user_id ON hausses(user_id);
CREATE INDEX idx_hausses_ruche_id ON hausses(ruche_id);
CREATE INDEX idx_hausses_created_at ON hausses(created_at);

COMMENT ON TABLE hausses IS 'Suivi des hausses à miel avec pesée et type de miel';
COMMENT ON COLUMN hausses.poids_miel IS 'Poids total après retrait — le poids net de miel = poids_miel - poids_vide';
COMMENT ON COLUMN hausses.date_retrait IS 'NULL si la hausse est encore sur la ruche';


-- ============================================================================
-- 6. TÂCHES
-- Planification des actions futures : rappels, traitements programmés, etc.
-- ============================================================================

CREATE TABLE IF NOT EXISTS taches (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  rucher_id       uuid REFERENCES ruchers(id) ON DELETE SET NULL,
  ruche_id        uuid REFERENCES ruches(id) ON DELETE SET NULL,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type            text NOT NULL,                -- inspection, traitement, nourrissement, recolte,
                                                -- transhumance, achat, entretien, autre
  description     text,                         -- Détail de la tâche à réaliser
  date_prevue     timestamptz NOT NULL,         -- Date/heure prévue pour la tâche
  materiel        text,                         -- Matériel nécessaire (préparation)
  statut          text DEFAULT 'a_faire',       -- a_faire, en_cours, terminee, annulee
  created_at      timestamptz DEFAULT now()
);

-- Index
CREATE INDEX idx_taches_user_id ON taches(user_id);
CREATE INDEX idx_taches_ruche_id ON taches(ruche_id);
CREATE INDEX idx_taches_rucher_id ON taches(rucher_id);
CREATE INDEX idx_taches_created_at ON taches(created_at);
CREATE INDEX idx_taches_date_prevue ON taches(date_prevue);
CREATE INDEX idx_taches_statut ON taches(statut);

COMMENT ON TABLE taches IS 'Planification des interventions futures et rappels';
COMMENT ON COLUMN taches.statut IS 'Cycle de vie : a_faire → en_cours → terminee ou annulee';


-- ============================================================================
-- 7. RÉCOLTES
-- Suivi de la production : miel, pollen, propolis, cire, gelée royale...
-- ============================================================================

CREATE TABLE IF NOT EXISTS recoltes (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  ruche_id        uuid REFERENCES ruches(id) ON DELETE SET NULL,
  rucher_id       uuid REFERENCES ruchers(id) ON DELETE SET NULL,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type            text NOT NULL DEFAULT 'miel', -- miel, pollen, propolis, cire, gelee_royale, essaim
  quantite        numeric(8,2) NOT NULL,        -- Quantité récoltée
  unite           text NOT NULL DEFAULT 'kg',   -- kg, g, L, unites
  date_recolte    date NOT NULL,                -- Date de la récolte
  notes           text,                         -- Remarques (qualité, couleur, goût...)
  created_at      timestamptz DEFAULT now()
);

-- Index
CREATE INDEX idx_recoltes_user_id ON recoltes(user_id);
CREATE INDEX idx_recoltes_ruche_id ON recoltes(ruche_id);
CREATE INDEX idx_recoltes_rucher_id ON recoltes(rucher_id);
CREATE INDEX idx_recoltes_created_at ON recoltes(created_at);
CREATE INDEX idx_recoltes_date_recolte ON recoltes(date_recolte);

COMMENT ON TABLE recoltes IS 'Production apicole : miel, pollen, propolis, cire, gelée royale, essaims';


-- ============================================================================
-- 8. OBSERVATIONS (enrichissement de la table existante)
-- Observations terrain parsées par l'IA (Claude) via le backend ou le bot Telegram.
-- Cette table existe déjà — on la recrée complète avec toutes les colonnes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS observations (
  id                uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  ruche_id          uuid REFERENCES ruches(id) ON DELETE SET NULL,
  rucher_id         uuid REFERENCES ruchers(id) ON DELETE SET NULL,
  user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  apiculteur_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL, -- Compatibilité backend existant
  source            text DEFAULT 'text',        -- text, voice, telegram_text, telegram_voice
  rucher            text,                       -- Nom du rucher (extrait par l'IA)
  ruches            text[],                     -- Numéros des ruches mentionnées
  statut            text DEFAULT 'moyen',       -- bon, moyen, mauvais, critique
  urgence           text DEFAULT 'basse',       -- haute, moyenne, basse, aucune
  action            text,                       -- Action recommandée par l'IA
  rappel_dans_jours integer DEFAULT 0,          -- Délai de rappel en jours
  resume            text,                       -- Résumé de l'observation par l'IA
  tags              text[],                     -- Tags apicoles détectés (varroa, essaimage...)
  texte_original    text,                       -- Message brut de l'apiculteur
  modele_utilise    text,                       -- Modèle IA utilisé (ex: claude-sonnet-4-20250514)
  parsed_at         timestamptz,                -- Date du parsing par l'IA
  created_at        timestamptz DEFAULT now()
);

-- Index
CREATE INDEX idx_observations_user_id ON observations(user_id);
CREATE INDEX idx_observations_ruche_id ON observations(ruche_id);
CREATE INDEX idx_observations_rucher_id ON observations(rucher_id);
CREATE INDEX idx_observations_created_at ON observations(created_at);
CREATE INDEX idx_observations_parsed_at ON observations(parsed_at);
CREATE INDEX idx_observations_statut ON observations(statut);
CREATE INDEX idx_observations_urgence ON observations(urgence);

COMMENT ON TABLE observations IS 'Observations terrain parsées par l''IA — source de données principale du NLP';
COMMENT ON COLUMN observations.tags IS 'Mots-clés apicoles extraits automatiquement : varroa, essaimage, famine, etc.';


-- ============================================================================
-- 9. ROW LEVEL SECURITY (RLS)
-- Chaque utilisateur ne voit que ses propres données.
-- Indispensable pour un SaaS multi-tenant sur Supabase.
-- ============================================================================

-- Activation du RLS sur toutes les tables
ALTER TABLE ruchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ruches ENABLE ROW LEVEL SECURITY;
ALTER TABLE reines ENABLE ROW LEVEL SECURITY;
ALTER TABLE interventions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hausses ENABLE ROW LEVEL SECURITY;
ALTER TABLE taches ENABLE ROW LEVEL SECURITY;
ALTER TABLE recoltes ENABLE ROW LEVEL SECURITY;
ALTER TABLE observations ENABLE ROW LEVEL SECURITY;

-- Politiques : chaque utilisateur accède uniquement à ses propres données

-- Ruchers
CREATE POLICY "ruchers_select_own" ON ruchers FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "ruchers_insert_own" ON ruchers FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ruchers_update_own" ON ruchers FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "ruchers_delete_own" ON ruchers FOR DELETE USING (auth.uid() = user_id);

-- Ruches
CREATE POLICY "ruches_select_own" ON ruches FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "ruches_insert_own" ON ruches FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ruches_update_own" ON ruches FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "ruches_delete_own" ON ruches FOR DELETE USING (auth.uid() = user_id);

-- Reines
CREATE POLICY "reines_select_own" ON reines FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "reines_insert_own" ON reines FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "reines_update_own" ON reines FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "reines_delete_own" ON reines FOR DELETE USING (auth.uid() = user_id);

-- Interventions
CREATE POLICY "interventions_select_own" ON interventions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "interventions_insert_own" ON interventions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "interventions_update_own" ON interventions FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "interventions_delete_own" ON interventions FOR DELETE USING (auth.uid() = user_id);

-- Hausses
CREATE POLICY "hausses_select_own" ON hausses FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "hausses_insert_own" ON hausses FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "hausses_update_own" ON hausses FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "hausses_delete_own" ON hausses FOR DELETE USING (auth.uid() = user_id);

-- Tâches
CREATE POLICY "taches_select_own" ON taches FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "taches_insert_own" ON taches FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "taches_update_own" ON taches FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "taches_delete_own" ON taches FOR DELETE USING (auth.uid() = user_id);

-- Récoltes
CREATE POLICY "recoltes_select_own" ON recoltes FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "recoltes_insert_own" ON recoltes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "recoltes_update_own" ON recoltes FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "recoltes_delete_own" ON recoltes FOR DELETE USING (auth.uid() = user_id);

-- Observations — accès ouvert en INSERT pour le backend (service role),
-- lecture restreinte par user_id pour le dashboard
CREATE POLICY "observations_select_own" ON observations FOR SELECT
  USING (auth.uid() = user_id OR user_id IS NULL);
CREATE POLICY "observations_insert_all" ON observations FOR INSERT
  WITH CHECK (true);  -- Le backend insère via la clé anon/service sans user_id obligatoire
CREATE POLICY "observations_update_own" ON observations FOR UPDATE
  USING (auth.uid() = user_id OR user_id IS NULL);
CREATE POLICY "observations_delete_own" ON observations FOR DELETE
  USING (auth.uid() = user_id);


-- ============================================================================
-- 10. DONNÉES DE DÉMONSTRATION (optionnel)
-- Décommentez ce bloc pour insérer des données de test.
-- Remplacez 'VOTRE_USER_ID' par un vrai UUID d'utilisateur Supabase Auth.
-- ============================================================================

/*
DO $$
DECLARE
  uid uuid := 'VOTRE_USER_ID';  -- Remplacer par auth.users.id
  rid1 uuid;
  rid2 uuid;
  rch1 uuid;
  rch2 uuid;
  rch3 uuid;
BEGIN
  -- Ruchers
  INSERT INTO ruchers (id, user_id, nom, localisation, latitude, longitude)
  VALUES
    (uuid_generate_v4(), uid, 'Rucher de Barsac', 'Barsac, Gironde', 44.6089, -0.3214)
  RETURNING id INTO rid1;

  INSERT INTO ruchers (id, user_id, nom, localisation, latitude, longitude)
  VALUES
    (uuid_generate_v4(), uid, 'Rucher du Château', 'Saint-Émilion, Gironde', 44.8942, -0.1556)
  RETURNING id INTO rid2;

  -- Ruches du rucher de Barsac
  INSERT INTO ruches (id, rucher_id, user_id, numero, type_ruche, statut)
  VALUES
    (uuid_generate_v4(), rid1, uid, '46', 'Dadant', 'active')
  RETURNING id INTO rch1;

  INSERT INTO ruches (id, rucher_id, user_id, numero, type_ruche, statut)
  VALUES
    (uuid_generate_v4(), rid1, uid, '52', 'Dadant', 'active')
  RETURNING id INTO rch2;

  INSERT INTO ruches (id, rucher_id, user_id, numero, type_ruche, statut)
  VALUES
    (uuid_generate_v4(), rid1, uid, '60', 'Dadant', 'active')
  RETURNING id INTO rch3;

  -- Observations
  INSERT INTO observations (user_id, ruche_id, rucher_id, source, rucher, ruches, statut, urgence, action, rappel_dans_jours, resume, tags, texte_original, modele_utilise, parsed_at)
  VALUES
    (uid, rch1, rid1, 'telegram_text', 'Rucher de Barsac', ARRAY['46'], 'mauvais', 'haute', 'Renforcer la colonie', 3, 'Ruche 46 faible, population en déclin.', ARRAY['faible', 'population'], 'Ruche 46 faible au rucher de Barsac', 'claude-sonnet-4-20250514', now()),
    (uid, rch2, rid1, 'telegram_text', 'Rucher de Barsac', ARRAY['52'], 'mauvais', 'haute', 'Nourrir immédiatement', 2, 'Ruche 52 en famine, réserves épuisées.', ARRAY['famine', 'nourrissement'], 'Ruche 52 manque de nourriture', 'claude-sonnet-4-20250514', now()),
    (uid, rch3, rid1, 'telegram_text', 'Rucher de Barsac', ARRAY['60'], 'critique', 'haute', 'Réintroduire une reine sous 48h', 2, 'Ruche 60 orpheline, pas de ponte observée.', ARRAY['reine', 'orpheline'], 'Ruche 60 orpheline', 'claude-sonnet-4-20250514', now());

  -- Interventions
  INSERT INTO interventions (ruche_id, user_id, type, description, materiel)
  VALUES
    (rch1, uid, 'traitement', 'Traitement anti-varroa Apivar', '2 lanières Apivar'),
    (rch2, uid, 'nourrissement', 'Nourrissement au sirop 50/50', 'Sirop 50/50 — 2 litres');

  -- Récolte
  INSERT INTO recoltes (ruche_id, rucher_id, user_id, type, quantite, unite, date_recolte, notes)
  VALUES
    (rch1, rid1, uid, 'miel', 12.5, 'kg', '2025-07-15', 'Miel toutes fleurs, bonne qualité');

  RAISE NOTICE 'Données de démonstration insérées avec succès.';
END $$;
*/


-- ============================================================================
-- FIN DU SCHÉMA
-- ============================================================================
-- Pour exécuter : copiez-collez ce fichier dans le SQL Editor de Supabase
-- Dashboard → SQL Editor → New Query → coller → Run
-- ============================================================================
