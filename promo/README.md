# Promo videos

## Full feature film (~62s, with sound)
`thakar-features-promo.mp4` (source `features.html`, thumbnail `features-poster.png`): one phone, and the
app navigates itself through every feature. Each feature plays slowly, then the camera zooms in on its key
moment and holds it for about 2 seconds so it can be read on a phone.

| Caption | On the phone (zoomed in on) |
|---|---|
| *Orders. Packing. Ads. Support. All on you.* | — |
| Wake up to it already handled. | Home (Answered for you 38 + Done for you today) |
| "Where's my order?" Answered in the chat. | Ankit's chat (order card with tracking + Auto-answered from Shopify) |
| Product questions? Answered by AI. | Priya's chat (Hinglish question + AI answer) |
| The angry one? Jev flags it. Ticket opens. | Riya's chat (Jev · Urgent · Angry), then Ticket #1042 + the phone notification |
| Order updates & COD. Automatic. | Kavya's chat (Confirm order → COD confirmed), then shipped / delivered |
| Abandoned carts? Brought back. | Rohan's chat (cart reminder → order #2318 placed, recovered) |
| Every customer, known by heart. | Customer stages + VIP list, then Kavya's profile |
| Campaigns that pay for themselves. | Campaign results (14 orders · ₹23,800, money in vs. out) |
| *Support that runs itself.* | The Thakar Kitchen logo and a row of every feature |

**Pacing.** The scene is drawn on a 35s timeline. `BEATS` in `features.html` stretches it into the video:
each row plays the scene up to a time over some seconds of video, and rows with `zoom` are the holds.
Change the pace there.

**Sound.** `sound.js` builds the soundtrack in code, so nothing needs licensing: a calm bed in D
(a tanpura-style drone with soft kalimba plucks) plus effects on the cues the page lists in `SOUND_CUES`.
Those are taps, message pops, automatic-reply swishes, screen whooshes, a success "ding" for answered and
confirmed chats, a bell when Jev flags Riya, a notification chime, coins for the recovered cart and the
campaign revenue, and a warm bloom on the logo. `record.js` mixes it in at -14 LUFS.

The numbers are realistic sample data, not real store figures.

Both videos use the Thakar Kitchen logo (`assets/thakar-logo.png`) on the end card and as the app icon
on the phone notification. It is the logo from thakarkitchen.com with the white background made transparent.

## Support cut (18s)
`thakar-support-promo.mp4`: an 18-second vertical (1080×1920) teaser with no sound, for Reels, Shorts,
LinkedIn and WhatsApp status. `poster.png` is the end card, for use as a thumbnail.

| Time | Beat |
|---|---|
| 0–3s | *Orders. Packing. Ads. Support.* → **All on you.** |
| 3–6s | Customer messages fill the inbox (English, Hinglish, Gujarati) |
| 6–9s | "Where's my order?" gets an automatic answer from Shopify tracking |
| 9–11s | Product questions are answered by AI from the shop's own information |
| 11–15s | An angry message gets flagged by Jev: Urgent, Ticket #1042, the founder is notified |
| 15–18s | The Thakar Kitchen logo, *Support that runs itself.* |

## Re-rendering
Each video is one HTML file: `window.render(t)` draws the frame at `t` seconds, and
`features.html?t=14` opens a single frame in a browser. Change the text or timing there, then run:

```
npm i --no-save playwright      # in a scratch folder, or set NODE_PATH to one
node promo/record.js            # 18s cut  (scene.html)
node promo/record.js features   # feature film with sound (features.html)
```
Both need ffmpeg and internet access (Google Fonts).

Set `CHROMIUM_PATH` to use an already installed Chromium. The 18s cut takes about 3 minutes and the feature film about 9.
