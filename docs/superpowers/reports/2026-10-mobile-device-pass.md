# Mobile app — manual device pass

Spec §8.6 requires one real iOS Safari and one real Android Chrome install. Tick a box only after doing it
on the device, against https://agentbook.brainliber.com, signed in as a test persona. Note the device + OS
next to the heading. The scorecard (G13) reads the boxes; it is PENDING until every box is ticked.

**iOS Safari — device/OS: ________**

- [ ] Add to Home Screen from Safari's Share sheet; the icon appears and opens /app full-screen (no Safari chrome)
- [ ] Capture: tap Capture, take a real receipt photo with the camera, see the preview + prefilled amount, Save; the expense appears in Docs
- [ ] Chat: attach a photo from the camera; the receipt card appears and Open shows the viewer
- [ ] Keyboard: in Chat, focus the composer; the composer stays above the keyboard and the last message stays visible
- [ ] Offline: enable Airplane Mode, open the app from the home screen; Home shows the "as of HH:MM" snapshot; Capture queues a photo ("Queued · 1 waiting"); disable Airplane Mode and the queued receipt becomes exactly one expense
- [ ] Push: with notifications allowed, trigger a test push; tapping it opens /app (not /agentbook)

**Android Chrome — device/OS: ________**

- [ ] Install via the browser's Install app / Add to Home screen prompt; the app opens /app standalone
- [ ] Capture: camera capture → preview → Save; appears in Docs
- [ ] Chat: camera attach works; the composer stays above the keyboard
- [ ] Offline: Airplane Mode → snapshot on Home, capture queues, back online → exactly one expense
- [ ] Push: tapping a notification opens /app
