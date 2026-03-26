-- ============================================================================
-- BeeSmart — Table telegram_users
-- Liaison entre les utilisateurs Telegram et les données apicoles.
--
-- Quand un apiculteur envoie un message au bot Telegram, on crée
-- automatiquement un enregistrement ici avec un user_id unique.
-- Ce user_id est ensuite utilisé comme clé étrangère dans toutes
-- les tables (observations, interventions, ruches…).
-- ============================================================================

CREATE TABLE IF NOT EXISTS telegram_users (
  id            uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  telegram_id   text NOT NULL UNIQUE,           -- Identifiant numérique Telegram (stocké en text pour éviter les limites bigint)
  user_id       text NOT NULL UNIQUE,            -- UUID interne BeeSmart liant cet utilisateur à ses données
  username      text,                            -- @username Telegram (peut changer, mis à jour à chaque message)
  prenom        text,                            -- Prénom Telegram
  nom           text,                            -- Nom de famille Telegram
  created_at    timestamptz DEFAULT now()
);

-- Index pour la recherche rapide par telegram_id (utilisé à chaque message)
CREATE INDEX idx_telegram_users_telegram_id ON telegram_users(telegram_id);
CREATE INDEX idx_telegram_users_user_id ON telegram_users(user_id);

COMMENT ON TABLE telegram_users IS 'Table de liaison entre les utilisateurs Telegram et leurs données BeeSmart';
COMMENT ON COLUMN telegram_users.telegram_id IS 'ID numérique unique attribué par Telegram à chaque utilisateur';
COMMENT ON COLUMN telegram_users.user_id IS 'UUID interne BeeSmart — sert de clé étrangère dans les autres tables';

-- RLS : la table est accessible en lecture/écriture par le backend (clé anon)
-- Pas de filtre par auth.uid() car les utilisateurs Telegram ne passent pas par Supabase Auth
ALTER TABLE telegram_users ENABLE ROW LEVEL SECURITY;

-- Le backend insère et lit via la clé anon — accès ouvert
CREATE POLICY "telegram_users_insert" ON telegram_users FOR INSERT WITH CHECK (true);
CREATE POLICY "telegram_users_select" ON telegram_users FOR SELECT USING (true);
CREATE POLICY "telegram_users_update" ON telegram_users FOR UPDATE USING (true);
