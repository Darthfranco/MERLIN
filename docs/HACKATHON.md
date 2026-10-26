# MERLIN — Hackathon requirements and submission plan

MERLIN is being developed for the **Meta Global AI Developer Hackathon**, hosted by Meta and Cerebral Valley, October–November 2026. This document records the supplied event guidance so future contributors can preserve eligibility and build toward a strong submission.

## Sources and authority

The owner supplied two pasted documents on **October 26, 2026**. Their exact text is preserved here:

- [Event overview](sources/event-overview.txt): event listing, themes, application criteria, eligibility exclusions, dates, and a statement that selected participants must accept the Official Rules.
- [Participant guide](sources/participant-guide.txt): building rules, schedule, resources, submission process, rubric, and prizes.

The original page URLs and the targets of embedded links were absent from the pasted text. These are user-supplied snapshots, not the full Official Rules or evidence that anyone has accepted those rules. The [live Cerebral Valley event overview](https://cerebralvalley.ai/e/meta-ai-developer-hackathon), checked October 26, 2026, independently confirms the October 26 kickoff, November 4 at 9:00 PM ET submission deadline, and overview's November 4–8 judging dates; it still says the Official Rules will be published. The complete rules have not been obtained.

The overview says dates may change at Meta's discretion. Prefer newer official organizer rules and announcements when obtained; record the update and its source here. Check those sources before relying on an unresolved detail.

**Unconfirmed:** acceptance/eligibility, acceptance of the Official Rules, competition track, team roster, team Representative, and the final submission URL. The owner has said this project is participating; do not turn that into a claim that these administrative steps have been verified.

## Project fit and required Meta integration

The guide requires the project to build toward at least one of:

- **Build for Your World:** bring Meta models into a familiar domain, solve a firsthand problem, and free up time and mental space. This is MERLIN's proposed primary fit: a useful, personal, voice-driven home assistant.
- **Push the Frontier:** give machines new capabilities or improve understanding and control of physical systems. MERLIN's household device coordination could support this theme if the implemented work demonstrates it; do not claim capabilities that are only planned.

The project **must incorporate Meta models**. Stage One specifically checks reasonable use of Meta Model API and/or Meta open-weight models in the project built during the event. Using a coding assistant alone is not a substitute for a meaningful Meta integration in MERLIN's product.

The supplied guide names Muse Spark, Muse Wonder, Muse Image, Muse Voice Transcribe, SAM 3.1, Muse Glimmer, and Muse Spark Open. Verify actual model IDs, capabilities, access, and provider terms before implementation. Kokoro TTS is a proposed speech-output component; it does not replace the required Meta integration. Demonstrate useful multimodal reasoning and device workflows beyond a basic chatbot or simple image analyzer.

## Rules that affect development

- **Public repository:** repositories must be publicly accessible. The guide labels this “Open source,” but the supplied text does not specify a repository license. Confirm licensing separately and ensure rights to all code, data, and assets.
- **Team:** solo participation is allowed; the maximum is **four participants**. Every project enters one track. Track selection remains open; the overview describes Indie Developer for individual builders/students and Startup for teams/founders building a real product. Do not infer the track solely from team size.
- **New work:** presented features, code, and functionality must have been built during the event. Startups may build on existing products/codebases, but must clearly distinguish the new work.
- **Demo boundaries:** highlight only the features, code, and functionality built during the hackathon. Judges must clearly identify original contributions; failing to do so can cause immediate disqualification at their discretion.
- **Rights and conduct:** projects violating legal, ethical, or platform policies, or using code, data, or assets without the necessary rights, are disqualified.
- **Anti-project examples:** the guide asks entrants to avoid AI medical advice (including mental-health advisors and skin-blemish detectors), basic RAG applications, simple image analyzers, simple education chatbots, job-application screeners, nutrition coaches, personality analyzers, sports analyzers/coaches, and anything political or involving war. The list is not exhaustive.

Keep dated Git history and a concise account of what MERLIN implemented during the event, including any baseline, reused libraries/assets, external services, and simulated device behavior. These are practical ways to make contributions reviewable, not additional organizer rules. Clearly label simulations and planned features so the demo represents working behavior accurately.

The overview also limits participation to selected applicants and lists geographic/sanctions restrictions plus exclusions for Meta/Cerebral Valley employees, contractors, interns, government-affiliated individuals, specified immediate family members, and household members. The exact supplied wording is in the [overview snapshot](sources/event-overview.txt). Eligibility has not been verified here; consult the complete Official Rules rather than treating this summary as an eligibility determination.

## Timeline and unresolved date details

All dates below are **2026**. The participant guide says session times are **Eastern Time (ET)**; use the `America/New_York` timezone for scheduling. The event header also uses “EST” for the whole event, which is ambiguous: October 26 falls in EDT (UTC−04:00), while November 4 falls in EST (UTC−05:00). Do not use a fixed EST offset for October sessions.

| Date | Event / deadline from supplied materials |
| --- | --- |
| October 13, 9:00 AM ET | Applications open; rolling review. |
| October 25, 11:59 PM ET | Application deadline, possibly earlier at the 20,000-acceptance cap. |
| October 26, 9:00 AM ET | Applicant approval notifications due by this time. |
| October 26, 12:00 PM ET | Kickoff livestream. Overview says the hackathon begins October 26. |
| October 27–November 4 | Participant guide's stated **building period**. |
| October 27, 12:00–1:00 PM ET | Agents 101: Build a Multimodal AI Agent — Suraj Subramanian. |
| October 28, 12:00–1:00 PM ET | Agents 102: Best Practices for Verifiable Agents — Yash Khare. |
| October 30, 12:00–1:00 PM ET | Building Specialized Intelligence on Fireworks — Sinan Ozdemir. |
| Weekdays during building period, 10:00–11:00 AM ET | Text office hours in Discord `#office-hours`; no livestream/video. |
| November 3 | Last full day for submission questions and technical troubleshooting. |
| **November 4, 9:00 PM ET / EST** | **Project submission and individual Meta-credit claim deadlines.** Guide also lists final Discord office hours at this time. Submission deadline corresponds to November 5, 02:00 UTC. |
| November 5–8 | Judging according to the participant guide; overview instead says November 4–8. |
| November 8, end of day | Most Viral Project engagement cutoff; supplied text does not specify the cutoff timezone. |
| November 9, 12:00 PM ET | Closing ceremony: top 10 teams (five per track), live final judging, winners, community vote opens. |
| November 16 | Community vote winner announced on Discord. |

**Resolve before counting October 26 implementation as eligible:** the overview says the event begins October 26, while the participant guide expressly calls October 27–November 4 the building period. Preserve accurate timestamps and ask organizers whether kickoff-day implementation counts; do not silently choose the more permissive interpretation. Planning/context documents are not proof that product code falls inside the approved window.

## Judging and what MERLIN must demonstrate

1. **Stage One — pass/fail:** reasonable fit to an event theme and reasonable use of Meta Model API and/or Meta open-weight models to build the project during the hackathon.
2. **Stage Two — scored:** eligible submissions receive 0–10 scores using the following rubric.
3. **Stage Three — finals:** the top five projects in each track advance; final judges watch the demo videos live and rank using the same rubric.

| Category | Weight | What to make visible in MERLIN |
| --- | ---: | --- |
| Impact | 30% | A specific household problem, who benefits, and why the assistant would be useful in daily life. |
| Use of Meta AI Tooling | 25% | Meaningful, creative Meta capabilities across a complete task; avoid an integration that merely adds a chat box. |
| Technical Depth & Execution | 20% | Sound engineering, reliable state and device actions, and thoughtful execution. |
| Demo | 25% | A working product that holds up live and a compelling three-minute demonstration. |

The MERLIN column is project guidance derived from the rubric, not organizer wording. Prioritize a coherent, working household workflow over a long list of unimplemented features. The video, repository, and live product are judging artifacts.

## Submission checklist

- [ ] Verify participant acceptance, eligibility, and Official Rules acceptance.
- [ ] Resolve the October 26 versus October 27 build-start ambiguity with organizers.
- [ ] Choose one track; confirm the full team roster contains no more than four participants.
- [ ] Appoint one **Representative** to act and submit on behalf of the team/startup.
- [ ] Obtain the actual CV submission URL from the event portal; the pasted guide's link target is missing.
- [ ] Ensure the public repository is accessible, reproducible enough to review, and free of secrets or private household data.
- [ ] Explain the Meta integrations and distinguish hackathon work from any pre-existing code, libraries, assets, or product baseline.
- [ ] Record an accessible **three-minute demo video** highlighting the specific features, code, and functionality built during the event.
- [ ] Verify the video link, public repository link, and any live-product link work for judges.
- [ ] List **everyone who worked on the project** on the submission page.
- [ ] Submit **one project per team/startup**, not one per person, through the CV platform **by November 4, 2026, 9:00 PM EST**. Late submissions are not considered.
- [ ] If pursuing the optional viral prize, publish the project demo on X and submit its post link through the platform before the relevant engagement cutoff. This checklist does not authorize an agent to post on the owner's behalf.

## Credits and optional prize context

The supplied guide offers **$150 in Meta Model API credits per accepted participant**. Each participant must claim their own credits by November 4 at 9:00 PM ET; credits cannot be claimed for someone else. A payment method is required to use the credits and make calls, and the guide describes a temporary preauthorization. Confirm credits on the Billing page. Its “Spend Limit” wording describes a **notification**; do not assume it is an enforced spending cap.

Partner credits are discretionary: Baseten offers selected participants $100 and a 2M TPM rate limit (up to 2,000 participants); Modal offers $100 to the first 1,000 participants; Fireworks offers $25 to selected teams. The guide specifically says to use **`meta-models/muse-spark-open-1026`** for the hackathon on Baseten instead of the generic model ID shown in its docs. Reverify provider availability before depending on it.

The announced prize pool is **$1 million**: $400,000 for Indie Developer, $550,000 for Startups, and $50,000 in bonuses. Potentially relevant bonuses are Best Agentic Use-Case ($5,000), Best Creative Build using Muse Image or Muse Wonder ($5,000), and Best Build on Meta Open Weight Models using Muse Glimmer or Muse Spark Open on participant hardware or partner inference ($10,000, with verification). Other bonuses are Most Viral Project ($20,000) and Community Vote ($10,000; one vote per verified account). These are optional opportunities, not reasons to add unrelated features or claims.

For organizer updates, use Discord `#announcements`; general questions go to `#questions` and Meta technical questions to `#office-hours`. The supplied snapshots contain labels for Discord, livestream, credit-claim, and documentation links, but not their destination URLs.
