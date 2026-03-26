/**
 * BeeSmart Backend — Serveur Express
 *
 * Point d'entrée de l'API. Configure Express et monte les routes.
 *
 * Routes disponibles :
 *   POST /observations/voice  → Traitement d'une observation vocale (audio → JSON)
 *   POST /observations/text   → Traitement d'une observation textuelle (texte → JSON)
 *   GET  /health              → Vérification de l'état du serveur
 */

require('dotenv').config();
const express = require('express');
const observationsRouter = require('./src/routes/observations');
const { demarrerBot } = require('./src/services/telegramBot');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middlewares globaux
// ---------------------------------------------------------------------------

// Parsing du corps des requêtes en JSON (pour POST /observations/text)
app.use(express.json({ limit: '1mb' }));

// Parsing des formulaires URL-encodés (utile pour les outils de test)
app.use(express.urlencoded({ extended: true }));

// En-têtes CORS simplifiés (à affiner en production selon vos besoins)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Journalisation des requêtes entrantes (format court)
app.use((req, res, next) => {
  const debut = Date.now();
  res.on('finish', () => {
    const duree = Date.now() - debut;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duree}ms)`);
  });
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Route de santé — vérification rapide que le serveur répond
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'BeeSmart API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// Routes des observations apicoles (transcription + parsing NLP)
app.use('/observations', observationsRouter);

// ---------------------------------------------------------------------------
// Gestion des routes inconnues (404)
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({
    success: false,
    erreur: `Route introuvable : ${req.method} ${req.originalUrl}`,
    routes_disponibles: [
      'GET  /health',
      'POST /observations/voice',
      'POST /observations/text',
    ],
  });
});

// ---------------------------------------------------------------------------
// Gestion globale des erreurs non catchées
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[Erreur globale]', err);
  res.status(500).json({
    success: false,
    erreur: 'Erreur interne du serveur.',
    detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ---------------------------------------------------------------------------
// Démarrage du serveur
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log('');
  console.log('🐝  BeeSmart API démarrée');
  console.log(`    → http://localhost:${PORT}`);
  console.log(`    → Environnement : ${process.env.NODE_ENV || 'development'}`);
  console.log('');
  console.log('    Routes disponibles :');
  console.log(`    GET  http://localhost:${PORT}/health`);
  console.log(`    POST http://localhost:${PORT}/observations/voice`);
  console.log(`    POST http://localhost:${PORT}/observations/text`);
  console.log('');

  // Vérification de la présence des clés API au démarrage
  const clesManquantes = [];
  if (!process.env.ANTHROPIC_API_KEY) clesManquantes.push('ANTHROPIC_API_KEY');
  if (!process.env.OPENAI_API_KEY) clesManquantes.push('OPENAI_API_KEY');
  if (!process.env.SUPABASE_URL) clesManquantes.push('SUPABASE_URL');
  if (!process.env.SUPABASE_ANON_KEY) clesManquantes.push('SUPABASE_ANON_KEY');

  if (clesManquantes.length > 0) {
    console.warn(`⚠️   Variables d'environnement manquantes : ${clesManquantes.join(', ')}`);
    console.warn('    Copiez .env.example en .env et renseignez vos clés API.');
    console.warn('');
  }

  // Démarrage du bot Telegram
  // En production (WEBHOOK_URL défini) : monte une route POST /telegram/webhook/...
  // En local (pas de WEBHOOK_URL) : utilise le polling
  demarrerBot(app);
});

module.exports = app;
