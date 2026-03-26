/**
 * Service NLP — BeeSmart
 *
 * Deux fonctions principales :
 *   1. transcribeAudio  : Convertit un enregistrement vocal en texte via Whisper (OpenAI)
 *   2. parseObservation : Analyse un texte apicole et le structure en JSON via Claude (Anthropic)
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { OpenAI } = require('openai');
const { Readable } = require('stream');
const { PROMPT_PARSEUR_OBSERVATION, buildContexteRuche } = require('../prompts/apicole');

// --- Initialisation des clients API ---

// Client Anthropic pour Claude (parsing sémantique des observations)
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Client OpenAI pour Whisper (transcription audio → texte)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Modèle Claude utilisé pour le parsing des observations apicoles
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// Modèle Whisper pour la transcription audio
const WHISPER_MODEL = 'whisper-1';

// Langue des messages terrain (fr = français)
const LANGUE_OBSERVATION = process.env.OBSERVATION_LANGUAGE || 'fr';

/**
 * Transcrit un fichier audio en texte via l'API Whisper d'OpenAI.
 *
 * Whisper supporte les formats : mp3, mp4, mpeg, mpga, m4a, wav, webm
 * Taille maximale : 25 Mo (limite de l'API Whisper)
 *
 * @param {Buffer} audioBuffer - Le fichier audio sous forme de Buffer
 * @param {string} [mimeType='audio/webm'] - Le type MIME du fichier audio
 * @param {string} [nomFichier='observation.webm'] - Nom du fichier pour l'API
 * @returns {Promise<string>} Le texte transcrit
 * @throws {Error} Si la transcription échoue
 */
async function transcribeAudio(audioBuffer, mimeType = 'audio/webm', nomFichier = 'observation.webm') {
  // Vérification de la taille du fichier (limite Whisper : 25 Mo)
  const tailleMaxOctets = (parseInt(process.env.MAX_AUDIO_SIZE_MB) || 25) * 1024 * 1024;
  if (audioBuffer.length > tailleMaxOctets) {
    throw new Error(`Fichier audio trop volumineux (${Math.round(audioBuffer.length / 1024 / 1024)} Mo). Maximum : ${tailleMaxOctets / 1024 / 1024} Mo.`);
  }

  // Whisper attend un objet File-like — on crée un Readable stream à partir du Buffer
  // et on lui attache les métadonnées nécessaires
  const stream = Readable.from(audioBuffer);
  stream.name = nomFichier; // Whisper utilise l'extension pour détecter le format

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: stream,
      model: WHISPER_MODEL,
      language: LANGUE_OBSERVATION,
      response_format: 'text', // Retourne directement le texte brut
    });

    // Nettoyage basique : suppression des espaces superflus
    return transcription.trim();
  } catch (erreur) {
    // Enrichissement du message d'erreur pour faciliter le débogage
    throw new Error(`Échec de la transcription Whisper : ${erreur.message}`);
  }
}

/**
 * Analyse une observation apicole en texte et la convertit en JSON structuré via Claude.
 *
 * Claude utilise le prompt système défini dans src/prompts/apicole.js pour extraire :
 * rucher, ruches, statut, urgence, action, rappel_dans_jours, resume, tags
 *
 * @param {string} texteObservation - Le texte brut de l'observation (transcrit ou tapé)
 * @param {object|null} [contexteRuche=null] - Données historiques optionnelles de la ruche
 * @returns {Promise<object>} L'observation parsée sous forme d'objet JavaScript
 * @throws {Error} Si le parsing échoue ou si le JSON retourné est invalide
 */
async function parseObservation(texteObservation, contexteRuche = null) {
  // Validation de l'entrée
  if (!texteObservation || texteObservation.trim().length === 0) {
    throw new Error('Le texte d\'observation ne peut pas être vide.');
  }

  // Construction du message utilisateur :
  // On combine l'observation et le contexte historique si disponible
  const contexteBloc = buildContexteRuche(contexteRuche);
  const messageUtilisateur = contexteBloc
    ? `${contexteBloc}\n\n## Observation à analyser\n\n${texteObservation}`
    : texteObservation;

  try {
    // Appel à Claude avec le prompt système apicole
    const reponse = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: PROMPT_PARSEUR_OBSERVATION,
      messages: [
        {
          role: 'user',
          content: messageUtilisateur,
        },
      ],
    });

    // Extraction du bloc texte de la réponse Claude
    const blocTexte = reponse.content.find((bloc) => bloc.type === 'text');
    if (!blocTexte) {
      throw new Error('Claude n\'a retourné aucun bloc texte.');
    }

    const jsonBrut = blocTexte.text.trim();

    // Tentative de parsing JSON — Claude est instruit de ne retourner que du JSON
    let observationParsee;
    try {
      observationParsee = JSON.parse(jsonBrut);
    } catch {
      // Si le JSON est entouré de balises markdown (```json ... ```), on les nettoie
      const jsonNettoye = jsonBrut.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      observationParsee = JSON.parse(jsonNettoye);
    }

    // Enrichissement avec des métadonnées de traitement
    return {
      ...observationParsee,
      texte_original: texteObservation,
      modele_utilise: CLAUDE_MODEL,
      parsed_at: new Date().toISOString(),
    };
  } catch (erreur) {
    if (erreur instanceof SyntaxError) {
      throw new Error(`Réponse Claude non valide (JSON malformé) : ${erreur.message}`);
    }
    throw new Error(`Échec du parsing Claude : ${erreur.message}`);
  }
}

module.exports = {
  transcribeAudio,
  parseObservation,
};
