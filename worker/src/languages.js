// Per-language session settings. These are locked into each ephemeral token server-side,
// so the browser cannot change the model, voice or language mid-conversation.
//
// `instruction` is a minimal PLACEHOLDER. The final teacher instructions will be configured later.
export const LANGUAGES = {
  en: {
    code: 'en-US',
    voice: 'Kore',
    instruction: 'You are a friendly conversation partner. Speak only in English (US). Keep replies short and natural.'
  },
  lv: {
    code: 'lv-LV',
    voice: 'Kore',
    instruction: 'Tu esi draudzīgs sarunu biedrs. Runā tikai latviešu valodā. Atbildi īsi un dabiski. (You are a friendly conversation partner. Speak only in Latvian.)'
  }
};
