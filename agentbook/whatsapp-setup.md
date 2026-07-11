# WhatsApp Business Cloud API — Admin Setup Guide

Internal, one-time setup to stand up AgentBook's shared WhatsApp number.
Unlike Telegram (each tenant self-serves their own bot via @BotFather),
WhatsApp is **one number owned by AgentBook**, shared by every tenant — this
is a platform-level setup, done once by an admin, not something individual
users configure.

Code side is already built: webhook at `/api/v1/agentbook/whatsapp/webhook`,
adapter, linking flow, Settings UI. This guide covers the Meta-side steps to
get the 5 credential values the app needs, plus how to wire up the webhook
once it's deployed.

## What you'll end up with

Five values to set as env vars in Vercel:

| Env var | What it is |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Permanent access token for sending messages via the Cloud API |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta's internal ID for the phone number (not the phone number itself) |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | The WhatsApp Business Account (WABA) ID |
| `WHATSAPP_APP_SECRET` | Used to verify incoming webhook payloads (HMAC signature) |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | A secret string **you make up** — entered both here and in Meta's webhook config, used only for the one-time verification handshake |

## Step 1 — Create a Meta for Developers app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and log in with (or create) a Meta/Facebook account for the business.
2. **Create App** → choose the **Business** app type → give it a name (e.g. "AgentBook") → **Create App**.
3. On the app dashboard, find **WhatsApp** in the product list and select **Set up**.

## Step 2 — Add the WhatsApp product & get a test number

Meta gives every new app a **free test phone number** you can use immediately without business verification — good enough to get end-to-end working before committing to a real number.

1. In the WhatsApp product's **API Setup** page, you'll see a test number already provisioned under **From**.
2. Note the **Phone number ID** shown right below it — that's `WHATSAPP_PHONE_NUMBER_ID`.
3. Note the **WhatsApp Business Account ID** shown on the same page — that's `WHATSAPP_BUSINESS_ACCOUNT_ID`.
4. The test number can only message phone numbers you've explicitly added as test recipients (see **To** field → **Manage phone number list**). Add your own phone for testing. This restriction lifts once the Meta Business account is verified and you request a production number — not required to get the integration working end-to-end first.

## Step 3 — Generate a permanent access token

The API Setup page shows a **temporary** token (expires in 24 hours) — fine for a first curl test, not for production.

1. Go to your Meta Business Settings → **Users → System Users**.
2. Create a System User (or use an existing one) with **Admin** access to the app.
3. **Generate New Token** for that system user → select the app → grant the `whatsapp_business_messaging` and `whatsapp_business_management` permissions → generate.
4. Copy this token immediately (Meta only shows it once) — this is `WHATSAPP_ACCESS_TOKEN`. It doesn't expire like the temporary one.

## Step 4 — Get the App Secret

1. In the app dashboard, go to **App Settings → Basic**.
2. Find **App Secret** → click **Show** (may require re-entering your password).
3. This is `WHATSAPP_APP_SECRET` — used to verify that incoming webhook calls really came from Meta (HMAC-SHA256 signature check).

## Step 5 — Choose a webhook verify token

Pick any random secret string yourself, e.g. generate one with:

```bash
openssl rand -hex 24
```

This becomes `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. It isn't issued by Meta — you choose it, set it as the env var, and enter the *same* value into Meta's webhook config in Step 7.

## Step 6 — Hand off credentials

Once you have all 5 values, provide them so they can be set in Vercel
(`vercel env add`, one at a time, for Production) and the app deployed. After
that, come back for Step 7.

## Step 7 — Configure the webhook in Meta (after deploy)

Once the app is deployed with the env vars set, the webhook URL is:

```
https://agentbook.brainliber.com/api/v1/agentbook/whatsapp/webhook
```

1. In the WhatsApp product's **Configuration** page, find **Webhook** → **Edit**.
2. **Callback URL**: paste the URL above.
3. **Verify token**: paste the same value you chose for `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
4. **Verify and Save** — Meta calls the URL with a challenge; the app must echo it back for this to succeed (it will, once the env var matches).
5. Under **Webhook fields**, subscribe to **messages**.

## Step 8 — Test end-to-end

1. In AgentBook, go to **Settings → Chatbots → WhatsApp** — it should now show a real link code instead of "isn't set up yet."
2. From a phone number you added as a test recipient (Step 2.4), message the test number shown in Meta's API Setup page with the link code.
3. You should get a "You're connected!" reply, and the Chatbots card should show the linked number.
4. Send a real message — e.g. *"log $12 parking"* — and confirm the agent responds and the expense shows up in AgentBook.

## Notes

- **Test-number limits**: until the Meta Business account is verified, only pre-approved test recipient numbers can message the bot — fine for internal testing, not for real customers. Business verification (a longer Meta process — business documents, phone/email confirmation) is required before opening this up broadly.
- **Text-only for now**: the current integration handles plain text messages only, matching Telegram's core "log an expense / ask a question" flow. Receipt photos and inline buttons are Telegram-only for now — flagged as follow-on work.
- **Rotating the App Secret or access token**: if either is regenerated in Meta, update the corresponding Vercel env var and redeploy — the webhook will reject all payloads with a stale `WHATSAPP_APP_SECRET` (by design, see `verifySignature` in the webhook route).
