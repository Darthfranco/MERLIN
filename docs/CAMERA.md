# MERLIN's camera

Updated **November 2, 2026**. How MERLIN looks through the home device's own camera, how it tells that apart from home cameras, and what has actually been verified.

## Try it

Run `npm start`, open [MERLIN at home](http://127.0.0.1:3000/companion/), and ask “Does my outfit match?” MERLIN asks “Shall I turn on the camera and take a look?” Say or type yes, or press **Turn on camera**. The browser asks for camera permission the first time. MERLIN's face changes to its camera mode, and you have three seconds to get in frame. **Turn camera off** stops it at any point.

It needs the page on the device that has the camera, and works only at `/companion/`. The testing page at `/` has no camera and says so.

## Two different cameras

| | This device's own camera | Home cameras and doorbells |
| --- | --- | --- |
| **For** | What someone is deliberately showing MERLIN | Watching the home |
| **Examples** | “Does my outfit match?”, “What is this?”, “How many calories is this?”, “Help me with this homework” | “Who's at the door?”, “Show me the living room”, “Check the Ring” |
| **Today** | Works | **No live connection exists.** These open the connection screen, and MERLIN says it cannot see them. Ring has no public API for individuals, as [CONNECTORS.md](CONNECTORS.md) records |

`src/camera-intents.js` decides which one a request means, locally and with no model call. Asking to use a doorbell for something the person is showing (“Check my outfit with the Ring doorbell”) is refused in words, and MERLIN offers its own camera instead. Requests that do not need eyes, such as “does navy go with brown?” or “does my blue shirt match my brown pants?”, stay out of it.

The boundary is structural as well as a classifier. `camera_look` has no parameter that selects a camera. A frame reaches the server only from the page's own `getUserMedia`, and no code fetches a picture from any connector. A request classified as home is not offered the camera tools at all. In the browser, a camera whose label reads as a doorbell, network feed or virtual camera is refused, and if one is handed over as the default it is closed at once. **Any future home-camera connector must be a separate tool and must not feed this path.**

## What code enforces

These do not depend on the model:

- **Asking.** Calling `camera_look` only records the question. The wording is the code's own. Nothing the model does can open the camera.
- **Consent.** Only the person's own plain yes, in the very next message and within two minutes, opens the camera. “Yes but only my shirt” is not a yes. Any other message ends the question.
- **One frame per yes.** There is no standing permission. A saved routine still asks when it runs, and “use your camera” still asks, because the owner said always.
- **A saved instruction wins.** `tool_deny` with `camera_look` blocks it, including at the yes. If a saved word ban blocks the question, no question is pending, so a later yes opens nothing.
- **Pictures stay out of everything else.** The frame goes only to the SAM and vision requests, then is dropped. It is never in a prompt round, the conversation, memory, a trace, a response, or on disk.
- **Text in a picture is data.** The reply round after a look can read memory and search, but has no tool that changes anything.
- **Failures are stated.** Permission denied, no camera, camera in use, timeout, or a picture that could not be read each get a plain reply, and MERLIN never guesses at what it did not see.

The wording of the answer, and how good the judgement is, are up to the model.

## How a look works

1. The page tells the server whether a camera exists (`POST /api/companion/camera/status`), using `enumerateDevices`. This never opens the camera or prompts.
2. MERLIN asks. On yes, the server emits a `camera_capture` progress event with a one-time ID.
3. The page opens the camera, video only, shows it on the viewfinder, counts down, takes one JPEG (longest side 1280 pixels), and closes the camera. It posts the frame to `POST /api/companion/camera/frame`, which is accepted only for a capture the server is already waiting on.
4. **SAM 3.1** locates the things worth finding, one request per concept and in parallel.
5. **Muse Spark** reads the picture with those findings and writes a description. With nothing concrete to search for (“what is this?”), Muse Spark names what matters first and SAM 3.1 then finds it.
6. A normal reply round answers from the description, with household memory and rules applied.

SAM 3.1 cannot do this alone: [Meta's documentation](https://dev.meta.ai/docs/media-segmentation) says it returns geometry only and does not caption images or answer questions about a scene. Pairing it with Muse Spark is the handoff Meta documents. If SAM fails, the look continues from Muse Spark alone and the reply round is told that location data is unavailable. If Muse Spark fails, MERLIN says it could not read the picture.

## Camera mode

The look uses MERLIN's authored camera state: lens eyes and the programmable viewfinder (`screens.camera`), with no separate preview window. The viewfinder is a 2.88:1 band, so the picture is fitted whole with dark sides and is never cropped or stretched; what the person sees is what MERLIN gets. The authored synthetic picture never shows during a look.

| Moment | Viewfinder | Status line |
| --- | --- | --- |
| Starting | “Starting the camera…” | Get in frame… |
| Live | Feed, corner brackets, countdown | Get in frame… · **Camera on · 3** · Turn camera off |
| Reading | The still with a scan line (no scan line under reduced motion) | Taking a good look… · Camera off |
| Found | The still with SAM's boxes and labels, for 1.6 seconds | Here's what I found |
| Answer | Back to the speaking face, because camera mode hides the mouth. The picture is wiped | MERLIN |

## Remembering

The owner asked MERLIN to remember everything. What it keeps is **what it saw, in words**. The description is stored with the conversation turn, so “what color was my shirt?” is answered without reopening the camera, and it stays searchable in the archive. It also reaches background learning as a completed action, trimmed to 300 characters. Clearing memory removes it like any other conversation. The picture itself is not kept: this is an agent decision, see below.

## What leaves the home

Each look sends one JPEG to Meta, once per SAM concept and once to Muse Spark, over TLS, with `store:false`, on standard models. That is not zero retention: [Meta's commitments](https://dev.meta.ai/legal/commitments) say standard content is not used for training, while some retention can still apply. Contributor models are never used. By the catalog in [MODELS.md](MODELS.md), SAM 3.1 costs $2.50 per 1,000 images, so an outfit look with four concepts is about one cent, plus Muse Spark tokens for the vision and reply calls.

## Decisions

**The owner's, November 2, 2026:** give MERLIN camera controls; check whether a device camera is available; use the SAM 3.1 API; give the model the tool to look and see; for “does my outfit match?”, ask whether to turn on the camera; always ask before using it; remember everything; never use Ring or other home cameras for this, and tell the two kinds of request apart; use MERLIN's existing camera mode as the interface.

**Agent decisions, not owner-confirmed:**

- SAM 3.1 finds and Muse Spark interprets, because SAM 3.1 cannot judge an outfit by itself.
- “Remember everything” means the description in words, and pictures are never kept. Keeping pictures would be a privacy change for the owner to choose.
- “Always” is literal: one frame per yes, and even “use your camera” asks.
- The two-minute limit on a yes, the three-second countdown, the 1.6-second hold on what was found, and wiping the picture when the face returns.
- Refusing virtual cameras as well as named home cameras.
- Sending the frame at up to 1280 pixels on its longest side.
- Calling the tool `camera_look`, and offering only reading and search in the reply round after a look.

## Verification

**Automated:** 81 tests were added (1,162 now pass), covering the classifier, SAM parsing, consent, every failure, the real app page in its sandbox, and the viewfinder. A throwaway copy with the safety rules deliberately broken 29 ways failed tests all 29 times.

**Real browser:** `npm run check:camera` runs real Chrome, real `getUserMedia` and real clicks with a scripted model (no credits): 28 of 28 passed. `npm run check:camera -- --live` runs the same flow against the real Meta APIs (a cent or two) and passed 27 of 27 on each of four runs on November 2, 2026. Its feed is `test/fixtures/camera-outfit.jpg`, a synthetic picture of a blank-faced mannequin generated with standard Muse Image.

**Live observations, synthetic picture only:** SAM 3.1 accepted `store:false`, took about 1 to 3 seconds per concept, boxed the shirt, trousers and both shoes accurately, and correctly found no dress. The concept “object” found nothing, which is why vague questions go through Muse Spark first. From the frame to the answer took 4.7, 5.5 and 6.8 seconds in three runs; these are samples, not promises. MERLIN answered “Your navy shirt, tan khakis, and brown shoes match splendidly,” then “Dark navy, mister” from memory, with no second camera open.

## Limits

- **No real person, real camera, or physical device has been used.** Chrome's fake camera fed a still picture. Real lighting, real clothes, framing at a distance, Safari and iPad are all untried. Whether the outfit opinions are any good on real people is unknown.
- **The viewfinder is small.** It is authored as a wide band in the face, so a portrait feed is about 100 pixels wide in a 1280-pixel window. It may be hard to use from across a room; that is for the owner to judge.
- **A spoken yes depends on transcription.** A nearby voice saying “yes” during the follow-up window would count. The camera state and the Turn camera off button stay visible.
- **Home-camera refusal in the browser reads labels.** A doorbell bridge with a generic name such as “USB Camera” cannot be told apart. Browsers also hide labels until permission is granted, so availability can overcount before then.
- **The classifier is English pattern matching.** Phrasing it misses falls to the model's `camera_look` tool, whose use is model-dependent.
- **Masks are requested but not used.** Their encoding is undocumented, and the official `@meta-sam/parser` has an unreviewed custom license, so outlines are boxes. Reviewing that license is the way to get pixel outlines.
- **“Take a picture” is not supported,** because nothing is saved. MERLIN looks; it does not photograph.
- **If the character fails to load,** there is no viewfinder. The camera status line and off button still work.

## Next useful step

The owner restarts the server and tries it on a real camera with real clothes, then judges the viewfinder size, the answers, and whether pictures should ever be kept.
