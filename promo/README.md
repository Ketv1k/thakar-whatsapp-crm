# Promo video

`thakar-support-promo.mp4`: an 18-second vertical (1080×1920) promo with no sound, for Reels, Shorts,
LinkedIn and WhatsApp status. `poster.png` is the end card, for use as a thumbnail.

| Time | Beat |
|---|---|
| 0–3s | *Orders. Packing. Ads. Support.* → **All on you.** |
| 3–6s | Customer messages fill the inbox (English, Hinglish, Gujarati) |
| 6–9s | "Where's my order?" gets an automatic answer from Shopify tracking |
| 9–11s | Product questions are answered by AI from the shop's own information |
| 11–15s | An angry message gets flagged by Jev: Urgent, Ticket #1042, the founder is notified |
| 15–18s | *Support that runs itself.* THAKAR KITCHEN |

## Re-rendering
The whole video is `scene.html`: `window.render(t)` draws the frame at `t` seconds, and
`scene.html?t=12` opens a single frame in a browser. Change the text or timing there, then run:

```
npm i --no-save playwright      # in a scratch folder, or set NODE_PATH to one
node promo/record.js            # needs ffmpeg and internet access (Google Fonts)
```

Set `CHROMIUM_PATH` to use an already installed Chromium. It takes about 3 minutes.
