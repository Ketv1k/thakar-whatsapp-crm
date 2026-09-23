// Turns a WhatsApp webhook message into what we store and show: a text body
// (the caption for photos), a one-line preview for the chat list, and the
// media reference needed to fetch a photo / voice note / file later.
// Pure functions, no database - easy to test.

const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'];

const PREVIEW_LABELS = {
  image: '📷 Photo',
  audio: '🎤 Voice message',
  voice: '🎤 Voice message',
  video: '🎥 Video',
  document: '📄 File',
  sticker: 'Sticker',
  location: '📍 Location',
  contacts: '👤 Contact',
  reaction: 'Reaction',
};

function describeInbound(waMessage) {
  const type = waMessage.type || 'text';

  if (type === 'text') {
    const body = waMessage.text?.body || '';
    return { type, body, caption: '', preview: body.slice(0, 140), media: null };
  }

  if (MEDIA_TYPES.includes(type)) {
    const m = waMessage[type] || {};
    const caption = String(m.caption || '').trim();
    const media = {
      id: m.id || null,
      mimeType: m.mime_type || '',
      filename: m.filename || '',
      voice: type === 'audio' && !!m.voice,
    };
    const label = PREVIEW_LABELS[media.voice ? 'voice' : type];
    return {
      type,
      body: caption || `[${type === 'image' ? 'photo' : type}]`,
      caption,
      preview: (caption ? `${label}: ${caption}` : label).slice(0, 140),
      media: media.id ? media : null,
    };
  }

  if (type === 'reaction') {
    const emoji = waMessage.reaction?.emoji || '';
    return { type, body: emoji || '[reaction]', caption: '', preview: `Reacted ${emoji}`.trim(), media: null };
  }

  if (type === 'button' || type === 'interactive') {
    // Taps on quick-reply buttons (e.g. "Confirm order" on a template).
    const body =
      waMessage.button?.text ||
      waMessage.interactive?.button_reply?.title ||
      waMessage.interactive?.list_reply?.title ||
      `[${type}]`;
    return { type, body, caption: '', preview: body.slice(0, 140), media: null };
  }

  const label = PREVIEW_LABELS[type] || `[${type}]`;
  return { type, body: `[${type}]`, caption: '', preview: label, media: null };
}

module.exports = { describeInbound, MEDIA_TYPES };
