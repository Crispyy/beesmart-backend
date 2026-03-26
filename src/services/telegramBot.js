/**
 * Bot Telegram — BeeSmart
 *
 * Permet aux apiculteurs d'envoyer leurs observations terrain via Telegram :
 *   - Message texte   → parsing Claude → réponse formatée
 *   - Message vocal   → transcription Whisper + parsing Claude → réponse formatée
 *   - /start          → message de bienvenue
 *   - /resume         → 5 dernières observations enregistrées
 *   - /urgent         → liste des ruches avec urgence haute (7 derniers jours)
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const http = require('http');
const { transcribeAudio, parseObservation } = require('./nlpService');
const { saveAllEntities, getDernieresObservations, getObservationsUrgentes } = require('./supabaseService');

// --- Configuration ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

// Mapping des emojis par statut pour un affichage visuel clair
const EMOJI_STATUT = {
  bon: '\u2705',       // ✅
  moyen: '\u26A0\uFE0F',    // ⚠️
  mauvais: '\u274C',   // ❌
  critique: '\uD83D\uDEA8',  // 🚨
};

// Mapping des emojis par niveau d'urgence
const EMOJI_URGENCE = {
  haute: '\uD83D\uDD34',    // 🔴
  moyenne: '\uD83D\uDFE0',  // 🟠
  basse: '\uD83D\uDFE2',    // 🟢
  aucune: '\u2705',          // ✅
};

/**
 * Formate une observation parsée par Claude en message Telegram lisible.
 *
 * Exemple de sortie :
 *   🐝 Observation enregistrée
 *   📍 Rucher : Barsac
 *
 *   🔴 Ruche 46 : faible — Renforcer sous 3 jours
 *   🔴 Ruche 52 : famine — Nourrir immédiatement
 *   🔴 Ruche 60 : orpheline — Réintroduire une reine
 *
 *   📋 Résumé : ...
 *   ⏰ Rappel dans 3 jours
 *   🏷️ Tags : varroa, famine
 *
 * @param {object} observation - L'observation structurée retournée par Claude
 * @returns {string} Message formaté pour Telegram
 */
function formaterObservation(observation) {
  const lignes = [];

  // En-tête
  lignes.push('\uD83D\uDC1D *Observation enregistr\u00e9e*');

  // Rucher
  if (observation.rucher) {
    lignes.push(`\uD83D\uDCCD *Rucher :* ${echapper(observation.rucher)}`);
  }

  // Statut global avec emoji
  const emojiStatut = EMOJI_STATUT[observation.statut] || '\u2753';
  lignes.push(`${emojiStatut} *Statut :* ${echapper(observation.statut)}`);

  // Urgence avec emoji
  const emojiUrgence = EMOJI_URGENCE[observation.urgence] || '\u2753';
  lignes.push(`${emojiUrgence} *Urgence :* ${echapper(observation.urgence)}`);

  lignes.push(''); // Ligne vide pour la lisibilité

  // Détail par ruche (si des ruches sont identifiées)
  if (observation.ruches && observation.ruches.length > 0) {
    for (const ruche of observation.ruches) {
      lignes.push(`\uD83D\uDCE6 *Ruche ${echapper(ruche)}*`);
    }
    lignes.push('');
  }

  // Action recommandée
  if (observation.action) {
    lignes.push(`\uD83D\uDD27 *Action :* ${echapper(observation.action)}`);
  }

  // Résumé
  if (observation.resume) {
    lignes.push(`\uD83D\uDCCB *R\u00e9sum\u00e9 :* ${echapper(observation.resume)}`);
  }

  // Rappel
  if (observation.rappel_dans_jours > 0) {
    lignes.push(`\u23F0 *Rappel dans* ${observation.rappel_dans_jours} *jours*`);
  }

  // Tags
  if (observation.tags && observation.tags.length > 0) {
    const tagsFormates = observation.tags.map((t) => `#${t.replace(/[- ]/g, '_')}`).join(' ');
    lignes.push(`\uD83C\uDFF7\uFE0F ${echapper(tagsFormates)}`);
  }

  return lignes.join('\n');
}

/**
 * Échappe les caractères spéciaux pour le format MarkdownV2 de Telegram.
 * Telegram exige que certains caractères soient échappés sinon le message échoue.
 *
 * @param {string} texte - Texte brut à échapper
 * @returns {string} Texte échappé pour MarkdownV2
 */
function echapper(texte) {
  if (!texte) return '';
  // Caractères réservés MarkdownV2 (sauf * et _ qu'on utilise pour le formatage)
  return String(texte).replace(/([[\]()~`>+\-=|{}.!#])/g, '\\$1');
}

/**
 * Formate une date ISO en format français court (JJ/MM/YYYY à HH:MM).
 *
 * @param {string} dateISO - Date au format ISO 8601
 * @returns {string} Date formatée
 */
function formaterDate(dateISO) {
  if (!dateISO) return 'Date inconnue';
  const d = new Date(dateISO);
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Télécharge un fichier depuis les serveurs Telegram via l'API Bot.
 * Utilisé pour récupérer les notes vocales envoyées par l'apiculteur.
 *
 * @param {TelegramBot} bot - Instance du bot Telegram
 * @param {string} fileId - Identifiant du fichier sur les serveurs Telegram
 * @returns {Promise<Buffer>} Le fichier téléchargé sous forme de Buffer
 */
async function telechargerFichierTelegram(bot, fileId) {
  // Récupération du chemin du fichier sur les serveurs Telegram
  const fichierInfo = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fichierInfo.file_path}`;

  // Téléchargement du fichier en mémoire (Buffer)
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Initialise et démarre le bot Telegram BeeSmart.
 *
 * Deux modes de fonctionnement :
 *   - Webhook (production) : Telegram envoie les mises à jour via POST sur /telegram/webhook
 *     → Plus efficace, pas de polling, requis pour Railway/Heroku/Render
 *     → Nécessite WEBHOOK_URL dans les variables d'environnement
 *   - Polling (développement local) : Le bot interroge les serveurs Telegram périodiquement
 *     → Plus simple, fonctionne derrière un NAT/firewall
 *     → Activé automatiquement si WEBHOOK_URL n'est pas défini
 *
 * @param {express.Application} [app] - Instance Express pour monter la route webhook (mode webhook uniquement)
 * @returns {TelegramBot|null} L'instance du bot, ou null si le token n'est pas configuré
 */
function demarrerBot(app) {
  // Vérification du token
  if (!TELEGRAM_TOKEN) {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN non configuré — bot désactivé.');
    return null;
  }

  // Détermination du mode : webhook si WEBHOOK_URL est défini, sinon polling
  const WEBHOOK_URL = process.env.WEBHOOK_URL; // ex: https://web-production-c018.up.railway.app
  const estModeWebhook = !!WEBHOOK_URL && !!app;

  let bot;

  if (estModeWebhook) {
    // --- Mode Webhook (production) ---
    // Le bot ne fait PAS de polling — il attend les requêtes POST de Telegram
    bot = new TelegramBot(TELEGRAM_TOKEN, { webHook: false });

    // Chemin secret pour la route webhook (évite les requêtes non autorisées)
    const cheminWebhook = `/telegram/webhook/${TELEGRAM_TOKEN}`;

    // Montage de la route Express pour recevoir les updates Telegram
    app.post(cheminWebhook, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });

    // Enregistrement du webhook auprès de Telegram
    const urlWebhookComplete = `${WEBHOOK_URL}${cheminWebhook}`;
    bot.setWebHook(urlWebhookComplete)
      .then(() => {
        console.log(`[Telegram] Webhook configuré : ${WEBHOOK_URL}/telegram/webhook/***`);
      })
      .catch((erreur) => {
        console.error('[Telegram] Échec de la configuration du webhook :', erreur.message);
      });

    console.log('[Telegram] Bot BeeSmart démarré en mode webhook.');
  } else {
    // --- Mode Polling (développement local) ---
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

    // Suppression d'un éventuel webhook résiduel pour éviter les conflits
    bot.deleteWebHook()
      .then(() => console.log('[Telegram] Webhook supprimé — mode polling actif.'))
      .catch(() => {}); // Silencieux si pas de webhook à supprimer

    console.log('[Telegram] Bot BeeSmart démarré en mode polling.');
  }

  // -----------------------------------------------------------------------
  // Commande /start — Message de bienvenue
  // -----------------------------------------------------------------------
  bot.onText(/\/start/, (msg) => {
    const bienvenue = [
      '\uD83D\uDC1D *Bienvenue sur BeeSmart \\!*',
      '',
      'Je suis votre assistant apicole\\. Envoyez\\-moi vos observations terrain :',
      '',
      '\uD83C\uDFA4 *Note vocale* \\— Je transcris et analyse automatiquement',
      '\u270D\uFE0F *Message texte* \\— Je parse et structure votre observation',
      '',
      '*Commandes disponibles :*',
      '/resume \\— Voir les 5 derni\u00e8res observations',
      '/urgent \\— Lister les ruches en urgence haute',
      '/start \\— Revoir ce message',
    ].join('\n');

    bot.sendMessage(msg.chat.id, bienvenue, { parse_mode: 'MarkdownV2' });
  });

  // -----------------------------------------------------------------------
  // Commande /resume — 5 dernières observations
  // -----------------------------------------------------------------------
  bot.onText(/\/resume/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      bot.sendChatAction(chatId, 'typing');

      const observations = await getDernieresObservations(5);

      if (observations.length === 0) {
        return bot.sendMessage(chatId, '\uD83D\uDCED Aucune observation enregistr\u00e9e pour le moment\\.',
          { parse_mode: 'MarkdownV2' });
      }

      const lignes = ['\uD83D\uDCCB *5 derni\u00e8res observations :*', ''];

      for (const obs of observations) {
        const date = formaterDate(obs.parsed_at);
        const emojiStatut = EMOJI_STATUT[obs.statut] || '\u2753';
        const rucher = obs.rucher ? echapper(obs.rucher) : 'Non pr\u00e9cis\u00e9';
        const ruches = obs.ruches?.length > 0 ? obs.ruches.join(', ') : 'toutes';

        lignes.push(`${emojiStatut} *${echapper(date)}*`);
        lignes.push(`   \uD83D\uDCCD ${rucher} \\| Ruches : ${echapper(ruches)}`);
        lignes.push(`   ${echapper(obs.resume || obs.action || 'Pas de détail')}`);
        lignes.push('');
      }

      bot.sendMessage(chatId, lignes.join('\n'), { parse_mode: 'MarkdownV2' });
    } catch (erreur) {
      console.error('[Telegram /resume] Erreur :', erreur.message);
      bot.sendMessage(chatId, '\u274C Erreur lors de la r\u00e9cup\u00e9ration des observations\\.',
        { parse_mode: 'MarkdownV2' });
    }
  });

  // -----------------------------------------------------------------------
  // Commande /urgent — Ruches en urgence haute
  // -----------------------------------------------------------------------
  bot.onText(/\/urgent/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      bot.sendChatAction(chatId, 'typing');

      const urgentes = await getObservationsUrgentes();

      if (urgentes.length === 0) {
        return bot.sendMessage(chatId,
          '\u2705 *Aucune urgence en cours \\!*\n\nToutes vos ruches sont en ordre\\.',
          { parse_mode: 'MarkdownV2' });
      }

      const lignes = [
        `\uD83D\uDEA8 *${urgentes.length} alerte${urgentes.length > 1 ? 's' : ''} urgente${urgentes.length > 1 ? 's' : ''} :*`,
        '',
      ];

      for (const obs of urgentes) {
        const date = formaterDate(obs.parsed_at);
        const rucher = obs.rucher ? echapper(obs.rucher) : 'Rucher inconnu';
        const ruches = obs.ruches?.length > 0
          ? obs.ruches.map((r) => `ruche ${r}`).join(', ')
          : 'toutes les ruches';

        lignes.push(`\uD83D\uDD34 *${rucher}* \\| ${echapper(ruches)}`);
        lignes.push(`   ${echapper(obs.action || obs.resume || 'Action requise')}`);
        lignes.push(`   \u23F0 Rappel dans ${obs.rappel_dans_jours || '?'} jours \\| ${echapper(date)}`);
        lignes.push('');
      }

      bot.sendMessage(chatId, lignes.join('\n'), { parse_mode: 'MarkdownV2' });
    } catch (erreur) {
      console.error('[Telegram /urgent] Erreur :', erreur.message);
      bot.sendMessage(chatId, '\u274C Erreur lors de la r\u00e9cup\u00e9ration des urgences\\.',
        { parse_mode: 'MarkdownV2' });
    }
  });

  // -----------------------------------------------------------------------
  // Message texte — Observation textuelle
  // -----------------------------------------------------------------------
  bot.on('text', async (msg) => {
    // Ignorer les commandes (déjà gérées par onText)
    if (msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;

    try {
      // Indication que le bot traite le message
      bot.sendChatAction(chatId, 'typing');

      // Parsing de l'observation via Claude
      const observation = await parseObservation(msg.text);

      // Sauvegarde de toutes les entités dans Supabase (non bloquante)
      try {
        await saveAllEntities(null, observation, { source: 'telegram_text' });
      } catch (erreurSauvegarde) {
        console.warn('[Telegram texte] Sauvegarde Supabase ignorée :', erreurSauvegarde.message);
      }

      // Envoi de la réponse formatée
      const reponse = formaterObservation(observation);
      bot.sendMessage(chatId, reponse, { parse_mode: 'MarkdownV2' });
    } catch (erreur) {
      console.error('[Telegram texte] Erreur :', erreur.message);
      bot.sendMessage(chatId,
        '\u274C D\u00e9sol\u00e9, une erreur est survenue lors de l\'analyse de votre observation\\. R\u00e9essayez\\.',
        { parse_mode: 'MarkdownV2' });
    }
  });

  // -----------------------------------------------------------------------
  // Message vocal — Observation audio
  // -----------------------------------------------------------------------
  bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;

    try {
      // Indication de traitement en cours
      bot.sendChatAction(chatId, 'typing');
      bot.sendMessage(chatId, '\uD83C\uDFA4 Transcription de votre message vocal en cours\\.\\.\\.',
        { parse_mode: 'MarkdownV2' });

      // Étape 1 : Téléchargement du fichier audio depuis Telegram
      const audioBuffer = await telechargerFichierTelegram(bot, msg.voice.file_id);

      // Étape 2 : Transcription via Whisper
      const transcription = await transcribeAudio(audioBuffer, 'audio/ogg', 'observation.ogg');

      if (!transcription || transcription.trim().length === 0) {
        return bot.sendMessage(chatId,
          '\u26A0\uFE0F Impossible de transcrire le message vocal\\. V\u00e9rifiez la qualit\u00e9 de l\'enregistrement\\.',
          { parse_mode: 'MarkdownV2' });
      }

      // Confirmation de la transcription
      bot.sendMessage(chatId,
        `\uD83D\uDCDD *Transcription :*\n_${echapper(transcription)}_`,
        { parse_mode: 'MarkdownV2' });

      bot.sendChatAction(chatId, 'typing');

      // Étape 3 : Parsing via Claude
      const observation = await parseObservation(transcription);

      // Étape 4 : Sauvegarde de toutes les entités dans Supabase (non bloquante)
      try {
        await saveAllEntities(null, observation, { source: 'telegram_voice' });
      } catch (erreurSauvegarde) {
        console.warn('[Telegram vocal] Sauvegarde Supabase ignorée :', erreurSauvegarde.message);
      }

      // Étape 5 : Envoi du résumé formaté
      const reponse = formaterObservation(observation);
      bot.sendMessage(chatId, reponse, { parse_mode: 'MarkdownV2' });
    } catch (erreur) {
      console.error('[Telegram vocal] Erreur :', erreur.message);
      bot.sendMessage(chatId,
        '\u274C Erreur lors du traitement de votre message vocal\\. R\u00e9essayez\\.',
        { parse_mode: 'MarkdownV2' });
    }
  });

  // -----------------------------------------------------------------------
  // Gestion des erreurs (polling ou webhook)
  // -----------------------------------------------------------------------
  bot.on('polling_error', (erreur) => {
    console.error('[Telegram] Erreur de polling :', erreur.message);
  });

  bot.on('webhook_error', (erreur) => {
    console.error('[Telegram] Erreur de webhook :', erreur.message);
  });

  return bot;
}

module.exports = { demarrerBot };
