# Promo videos

## Full feature film (35s)
`thakar-features-promo.mp4` (source `features.html`, thumbnail `features-poster.png`): one phone, and the
app navigates itself through every feature.

| Time | Caption | On the phone |
|---|---|---|
| 0–3s | *Orders. Packing. Ads. Support. All on you.* | — |
| 3–6s | Wake up to it already handled. | Home: Answered for you 38, Chats waiting, Open tickets, COD to confirm, Done for you today |
| 6–9.5s | "Where's my order?" Answered in the chat. | Ankit's chat: an order card with tracking, Auto-answered from Shopify |
| 9.5–12.5s | Product questions? Answered by AI. | Priya's Hinglish question answered from the shop's info |
| 12.5–17s | The angry one? Jev flags it. Ticket opens. | Riya's damaged order: Jev Urgent · Angry, instant reply, photo, Ticket #1042 sheet, phone notification |
| 17–20.5s | Order updates & COD. Automatic. | COD confirmation with Confirm / Cancel, then shipped and delivered updates |
| 20.5–23.5s | Abandoned carts? Brought back. | Cart reminder → order #2318 placed, recovered cart |
| 23.5–28.5s | Every customer, known by heart. | Customer stages → VIP → Kavya's profile (orders, spend, history, tags, reorder reminder) |
| 28.5–31.5s | Campaigns that pay for themselves. | Campaign results (read 91%, 14 orders, ₹23,800) and the automatic reminders |
| 31.5–35s | *Support that runs itself.* | THAKAR KITCHEN and a row of every feature |

The numbers are realistic sample data, not real store figures.

## Support cut (18s)
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
Each video is one HTML file: `window.render(t)` draws the frame at `t` seconds, and
`features.html?t=14` opens a single frame in a browser. Change the text or timing there, then run:

```
npm i --no-save playwright      # in a scratch folder, or set NODE_PATH to one
node promo/record.js            # 18s cut  (scene.html)
node promo/record.js features   # 35s film (features.html)
```
Both need ffmpeg and internet access (Google Fonts).

Set `CHROMIUM_PATH` to use an already installed Chromium. The 18s cut takes about 3 minutes and the 35s film about 5.
