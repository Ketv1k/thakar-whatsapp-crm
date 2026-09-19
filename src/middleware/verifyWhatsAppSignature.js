// Verifies that an incoming webhook POST really came from Meta.
//
// Meta signs every webhook body with your App Secret and sends the result as
// the `X-Hub-Signature-256: sha256=<hmac>` header. Without this check, the
// POST /webhook endpoint would accept forged payloads from anyone on the
// internet - and since we reply to `message.from`, a forger could make us send
// WhatsApp messages to arbitrary numbers and spin up bogus tickets.
//
// Fail-closed when WHATSAPP_APP_SECRET is set; skip (with a loud warning) when
// it isn't, so existing/dev setups keep working while you finish configuring it.
// Find the App Secret at Meta for Developers > your app > Settings > Basic.
const crypto = require('crypto');

function verifyWhatsAppSignature(req, res, next) {
  // Only message POSTs are signed. The GET verification handshake carries no
  // body and is authenticated by WHATSAPP_VERIFY_TOKEN in the route handler.
  if (req.method !== 'POST') {
    return next();
  }

  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (!appSecret) {
    console.warn(
      '[webhook] WHATSAPP_APP_SECRET not set - skipping signature verification. ' +
        'Set it (Meta app > Settings > Basic) to reject forged webhook requests.'
    );
    return next();
  }

  // Needs the exact bytes Meta hashed. app.js captures these via the json
  // parser's `verify` hook; if they're missing, we can't verify, so reject.
  const rawBody = req.rawBody;
  if (!rawBody || rawBody.length === 0) {
    console.error('[webhook] raw body unavailable - cannot verify signature');
    return res.sendStatus(403);
  }

  const provided = req.get('x-hub-signature-256') || '';
  const expected =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    console.warn('[webhook] rejected request with invalid signature');
    return res.sendStatus(403);
  }

  return next();
}

module.exports = { verifyWhatsAppSignature };
