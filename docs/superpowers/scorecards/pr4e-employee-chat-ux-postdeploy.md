# PR 4e — UX post-deploy pass

To tick on the deployed site (web chat / `/app` chat; en = alex, fr-CA = maya, zh-CN = switch locale; AU = sydney).

- [x] "What's <employee>'s pay frequency?" — reply shows Fortnightly (sydney) / Bi-weekly (alex, maya) in en.
- [x] Same question in French (maya) — reply in fr-CA with "Aux deux semaines" (CA) and correct money format.
- [x] Same question in Chinese — reply in zh-CN with 每两周 / 每两周（澳洲）. — prod: not exercised live (reply locale is server-side tenant config; switching a persona would mutate seeded data); covered by reply-catalog unit tests in zh-CN.
- [x] "Change <employee> to weekly" shows a plan card in the reply language; after Proceed the profile screen shows Weekly.
- [x] "Set <employee>'s rate to $60k" says it applies from the next draft pay run.
- [x] Typing an SSN/SIN/TFN-shaped value is refused, not echoed, and does not appear in chat history after reload. — prod 2026-11-19: reply did not echo; GET conversations shows a redaction marker, no digits.
- [x] No reply text is a humanised key.
