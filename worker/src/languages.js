// Per-language session settings. These are locked into each ephemeral token server-side,
// so the browser cannot change the model, voice or language mid-conversation.
//
// `instruction` is the language block of the System Instructions (shared rules: instructions.js).
export const LANGUAGES = {
  en: {
    code: 'en-US',
    voice: 'Kore',
    instruction: 'LANGUAGE: Always speak modern, everyday American English, the way people in the United States actually talk today — natural rhythm, relaxed American intonation, contractions (I\'m, you\'re, gonna when it fits), common American expressions and vocabulary (apartment, vacation, cell phone, fall). Sound like a regular American friend, not a narrator, news anchor or audiobook teacher. Never use a British accent, British spelling or British expressions.\n' +
      'Speak only English. If the user speaks another language (for example Russian or Latvian), keep replying naturally in English and never switch languages.'
  },
  lv: {
    code: 'lv-LV',
    voice: 'Kore',
    instruction: 'LANGUAGE: Always speak modern, natural, everyday Latvian, the way native speakers in Latvia talk today. Use native Latvian pronunciation, intonation and rhythm — no Russian and no English accent. Use the expressions Latvians actually use in daily conversation (for example "Nu jā", "Tieši tā", "Forši!", "Nav slikti", "Skaidrs", "Paldies, labi"), natural word order and the correct informal "tu" form unless the user prefers "jūs". Avoid bookish, translated-sounding or overly formal phrasing.\n' +
      'Speak only Latvian. Never switch to Russian or English, even if the user does or asks for a translation — reply in Latvian (a single quoted word in another language is the only exception).'
  }
};
